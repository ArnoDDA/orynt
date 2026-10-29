import test from 'node:test';
import assert from 'node:assert/strict';
import { Core } from '../../api/src/core.js';
import { Repository } from '../../api/src/repository.js';
import { mapApiState } from '../public/api-client.js';
import { prepareCreativeOptions, saveGenerationConfig, simulatePlan } from '../public/flow-actions.js';

function context() {
  const repository = new Repository();
  const core = new Core(repository);
  const actions = [];
  let sequence = 0;
  const command = async (action, id, fields) => {
    actions.push(action);
    return core.command(action, id, fields, `flow-check-key-${++sequence}`);
  };
  const state = () => mapApiState(core.state());
  const wait = async jobId => {
    for (let i = 0; i < 10; i++) {
      core.tick({ jobId });
      const job = state().jobs.find(j => j.id === jobId);
      if (job.status === 'succeeded') return;
      if (job.status === 'failed') throw new Error(job.error.message);
    }
    throw new Error('Job did not complete');
  };
  return { repository, core, command, actions, state, wait };
}
async function product(ctx) {
  const result = await ctx.command('campaign.create', null, { brandUrl: 'https://example.com', product: 'Test coffee', objective: 'Compare openings' });
  await ctx.command('snapshot.confirm', result.campaignId, { product: 'Test coffee', audience: 'Coffee drinkers', claim: 'A simple morning' });
  return result.campaignId;
}

test('the guided preparation finishes both jobs and reopening it reuses the completed result', async () => {
  const ctx = context();
  try {
    const campaignId = await product(ctx);
    await prepareCreativeOptions({ ...ctx, campaignId });
    assert.equal(ctx.state().cards.length, 3);
    const before = ctx.state().jobs.length;
    await prepareCreativeOptions({ ...ctx, campaignId });
    assert.equal(ctx.state().jobs.length, before);
    assert.equal(ctx.actions.filter(a => a === 'discovery.start').length, 1);
  } finally { ctx.repository.close(); }
});

test('the guided preparation resumes an already queued discovery without submitting it twice', async () => {
  const ctx = context();
  try {
    const campaignId = await product(ctx);
    await ctx.command('discovery.start', campaignId);
    await prepareCreativeOptions({ ...ctx, campaignId });
    assert.equal(ctx.actions.filter(a => a === 'discovery.start').length, 1);
    assert.equal(ctx.state().campaigns[0].status, 'cards_ready');
  } finally { ctx.repository.close(); }
});

test('preparation does not submit Cards when discovery has failed', async () => {
  const ctx = context();
  try {
    const campaignId = await product(ctx);
    await assert.rejects(prepareCreativeOptions({ ...ctx, campaignId, wait: async () => { throw new Error('Source failed'); } }), /Source failed/);
    assert.equal(ctx.actions.includes('cards.generate'), false);
    assert.equal(ctx.state().cards.length, 0);
  } finally { ctx.repository.close(); }
});

test('changing the brief requires a new discovery and preserves the old creative versions', async () => {
  const ctx = context();
  try {
    const campaignId = await product(ctx);
    await prepareCreativeOptions({ ...ctx, campaignId });
    const previousIds = ctx.state().cardVersions.map(v => v.id);
    await ctx.command('brief.update', campaignId, { objective: 'Compare a different product detail', product: 'New coffee', audience: 'Coffee drinkers', channel: 'Meta' });
    await prepareCreativeOptions({ ...ctx, campaignId });
    assert.equal(ctx.state().discoveries.length, 2);
    assert.ok(previousIds.every(id => ctx.state().cardVersions.some(v => v.id === id)));
  } finally { ctx.repository.close(); }
});

test('automatic config saving reuses unchanged settings and versions an actual change', async () => {
  const ctx = context();
  try {
    const campaignId = await product(ctx);
    await prepareCreativeOptions({ ...ctx, campaignId });
    const adopted = await ctx.command('card.adopt', ctx.state().cards[0].id);
    const fields = { ratio: '9:16', duration: '15', language: 'English', notes: 'Show product detail', templateId: '' };
    const options = { command: ctx.command, packageId: adopted.packageId, angleId: adopted.angleIds[0], fields };
    const first = await saveGenerationConfig(options);
    const config = ctx.state().configs.find(c => c.id === first);
    assert.equal(await saveGenerationConfig({ ...options, config }), first);
    assert.equal(ctx.state().configs.length, 1);
    const next = await saveGenerationConfig({ ...options, config, fields: { ...fields, notes: 'Change opening' } });
    assert.notEqual(first, next);
    assert.equal(ctx.state().configs.find(c => c.id === first).notes, 'Show product detail');
    const copyVersion = await saveGenerationConfig({ ...options, config, fields: { ...fields, copyOpening:'Morning starts here', copyDetail:'Brew your way', copyCta:'Discover', music:'none' } });
    const withCopy = ctx.state().configs.find(c => c.id === copyVersion);
    assert.deepEqual(withCopy.productionCopy, {opening:'Morning starts here',detail:'Brew your way',cta:'Discover'});
    assert.equal(withCopy.music,'none');
    assert.equal(await saveGenerationConfig({...options, config:withCopy, fields:{...fields,copyOpening:'Morning starts here',copyDetail:'Brew your way',copyCta:'Discover',music:'none'}}),copyVersion);
  } finally { ctx.repository.close(); }
});

test('one explicit simulation action creates the plan, mappings and labeled results on the same asset', async () => {
  const ctx = context();
  try {
    const campaignId = await product(ctx);
    await prepareCreativeOptions({ ...ctx, campaignId });
    const adopted = await ctx.command('card.adopt', ctx.state().cards[0].id);
    const configId = await saveGenerationConfig({ command: ctx.command, packageId: adopted.packageId, angleId: adopted.angleIds[0], fields: { ratio: '9:16', duration: 15, language: 'English' } });
    const bytes = Buffer.alloc(20); bytes.write('ftyp', 4, 'ascii');
    const asset = await ctx.command('asset.import', configId, { filename: 'test.mp4', base64: bytes.toString('base64') });
    await ctx.command('asset.launch-ready', asset.assetId, { reviewed: true });
    const planId = await simulatePlan({ command: ctx.command, campaignId, fields: { assetIds: [asset.assetId], audience: 'Coffee drinkers', channel: 'Meta', hypothesis: 'The opening changes CTR', metric: 'CTR' } });
    assert.equal(ctx.state().campaigns[0].status, 'learning');
    assert.equal(ctx.state().metrics.filter(m => m.planId === planId).length, 4);
    assert.ok(ctx.state().metrics.every(m => m.simulation && m.assetId === asset.assetId));
    assert.equal(ctx.state().conclusions[0].simulation, true);
  } finally { ctx.repository.close(); }
});
