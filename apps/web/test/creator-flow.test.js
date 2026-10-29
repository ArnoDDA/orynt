import test from 'node:test';
import assert from 'node:assert/strict';
import { createDraftStore, sceneFields, renderResults, renderCreativeChoices, renderStudio, productImage } from '../public/creator-flow.js';
import { creativePresentation, renderCreativeVisual } from '../public/creative-visuals.js';
import { saveGenerationConfig } from '../public/flow-actions.js';
import { sceneTiming } from '../../../packages/domain/src/scene-script.js';
import { Core } from '../../api/src/core.js';
import { Repository } from '../../api/src/repository.js';
import { LocalJobRunner } from '../../api/src/job-runner.js';
import { buildVideoPrompt } from '../../api/src/video-prompt.js';

async function context(mode = 'standard') {
  const repository = new Repository(':memory:'), core = new Core(repository);
  let sequence = 0;
  const command = async (action, id, fields = {}) => core.command(action, id, fields, `creator-flow-${++sequence}`);
  const created = await command('campaign.create', null, { brandUrl: 'https://example.com/products/coffee?size=250', product: '晨间咖啡', objective: '展示冲煮过程', mode });
  await command('snapshot.confirm', created.campaignId, { product: '晨间咖啡', claim: '适合每日饮用', audience: '咖啡饮用者' });
  const finish = async jobId => { for (let i = 0; i < 6; i++) core.tick({ jobId }); };
  const discovery = await command('discovery.start', created.campaignId);
  await finish(discovery.jobId);
  const cards = await command('cards.generate', created.campaignId);
  await finish(cards.jobId);
  const card = core.state().cardViews[0], adopted = await command('card.adopt', card.id);
  const angle = core.state().angles.find(a => a.id === adopted.angleIds[1]);
  return { repository, core, command, finish, card, angle, adopted, campaignId: created.campaignId };
}

test('edited scene descriptions persist, reach the storyboard and video prompt, and reuse only an unchanged config', async () => {
  const ctx = await context();
  try {
    const fields = { ratio: '9:16', duration: '30', language: '中文', notes: '', sceneOpening: '窗边咖啡袋近景，手把豆子倒入磨豆机', sceneProof: '慢镜头看水流经过滤杯，杯中咖啡渐渐升高', sceneClosing: '咖啡袋与杯子一起收尾' };
    const options = { command: ctx.command, packageId: ctx.adopted.packageId, angleId: ctx.angle.id, fields };
    const configId = await saveGenerationConfig(options), config = ctx.core.state().configs.find(c => c.id === configId);
    assert.equal(await saveGenerationConfig({ ...options, config }), configId);
    const request = await ctx.command('generation.start', configId, { mode: 'storyboard', angleId: ctx.angle.id });
    await ctx.finish(request.jobId);
    const story = ctx.core.state().assets.find(a => a.generationRequestId === request.generationRequestId);
    assert.deepEqual(story.scenes.map(s => s.text), [fields.sceneOpening, fields.sceneProof, fields.sceneClosing]);
    const prompt = buildVideoPrompt(ctx.core.state(), ctx.core.state().jobs.find(j => j.id === request.jobId));
    assert.match(prompt, /0-6 秒.*窗边咖啡袋/);
    assert.match(prompt, /6-22 秒.*慢镜头看水流/);
    const changed = await saveGenerationConfig({ ...options, config, fields: { ...fields, sceneOpening: '改为咖啡杯特写' } });
    assert.notEqual(changed, configId);
    assert.equal(ctx.core.state().configs.find(c => c.id === configId).scenePlan[0].text, fields.sceneOpening);
    assert.equal(ctx.core.state().assets.find(a => a.id === story.id).scenes[0].text, fields.sceneOpening);
  } finally { ctx.repository.close(); }
});

test('legacy configs without a scene plan preview the selected angle, rather than the original Card opening', async () => {
  const ctx = await context();
  try {
    const config = await ctx.command('config.create', ctx.adopted.packageId, { angleId: ctx.angle.id, ratio: '9:16', duration: 15, language: '中文' });
    const request = await ctx.command('generation.start', config.configId, { mode: 'storyboard' });
    await ctx.finish(request.jobId);
    const story = ctx.core.state().assets.find(a => a.generationRequestId === request.generationRequestId);
    assert.equal(story.scenes[0].text, ctx.angle.hook);
    assert.equal(story.scenes[1].text, ctx.angle.proof);
    assert.notEqual(ctx.angle.hook, ctx.card.creativeRoute.hook);
  } finally { ctx.repository.close(); }
});

test('incomplete or oversized scene plans fail before publishing a config', async () => {
  const ctx = await context();
  try {
    for (const scenePlan of [[{ text: '开场' }], [{ text: '开场' }, { text: '' }, { text: '收尾' }], [{ text: 'x'.repeat(601) }, { text: '证明' }, { text: '收尾' }]]) {
      await assert.rejects(ctx.command('config.create', ctx.adopted.packageId, { angleId: ctx.angle.id, ratio: '9:16', duration: 15, scenePlan }), { code: 'INVALID_SCENE_PLAN' });
    }
    assert.equal(ctx.core.state().configs.length, 0);
  } finally { ctx.repository.close(); }
});

test('browser drafts survive recreating the store and remain isolated by workspace and angle', () => {
  const entries = new Map(), storage = { getItem: key => entries.get(key), setItem: (key, value) => entries.set(key, value), removeItem: key => entries.delete(key) };
  const first = createDraftStore(storage, 'one');
  first.write('script:a', { sceneOpening: '用户改写的开场', ratio: '1:1', brandAssetIds: ['local-image'], apiKey: 'should-never-persist', base64: 'should-never-persist' });
  first.write('creative:campaign-a', { selectedCardId: 'second-card' });
  const restored = createDraftStore(storage, 'one');
  assert.deepEqual(restored.read('script:a'), { sceneOpening: '用户改写的开场', ratio: '1:1', brandAssetIds: ['local-image'] });
  assert.deepEqual(restored.read('script:b'), {});
  assert.equal(restored.read('creative:campaign-a').selectedCardId, 'second-card');
  assert.deepEqual(createDraftStore(storage, 'two').read('script:a'), {});
  restored.remove('script:a');
  assert.deepEqual(restored.read('script:a'), {});
});

test('disabled browser storage preserves in-memory edits and does not claim durable saving', () => {
  const store = createDraftStore({ getItem() { throw new Error('Disabled'); }, setItem() { throw new Error('Disabled'); }, removeItem() { throw new Error('Disabled'); } }, 'one');
  assert.equal(store.write('script:a', { notes: '保留修改' }), false);
  assert.equal(store.read('script:a').notes, '保留修改');
});

test('creative proposals follow actual Card content without presenting illustrations as results', async () => {
  const ctx = await context();
  try {
    const data = ctx.core.state(), c = data.campaigns[0], cards = data.cardViews;
    data.cards = cards; data.brandAssets = [];
    const selected = cards[2], plan = creativePresentation(selected, data.briefs[0].product);
    const html = renderCreativeChoices(data, c, selected.id);
    assert.equal(plan.kind, 'process');
    assert.match(plan.scenes[0], /打开咖啡袋/);
    assert.equal(plan.scenes[1], selected.creativeRoute.proof);
    assert.match(html, /这是脚本提案，尚未生成画面/);
    assert.match(html, new RegExp(`data-action="adopt" data-id="${selected.id}"`));
    assert.doesNotMatch(html, /data-action="play-direction"|class="direction-art"/);
    assert.doesNotMatch(html, /还没有产品图/);
    assert.match(html, /参考视频可选/);
    const illustrations = cards.map(card => { const item = creativePresentation(card, '晨间咖啡'); return renderCreativeVisual(item.category, item.kind); });
    assert.equal(new Set(illustrations).size, 3);
    assert.match(html, /准备.*手冲咖啡|打开咖啡袋/);
    const studio = renderStudio({ data, c, card: ctx.card, pack: data.packages[0], angle: ctx.angle, angles: data.angles, draft: {}, selectedAssets: new Set(), selectedTemplateId: '', templates: [] });
    assert.match(studio, /生成前需补充/);
    assert.match(studio, /这个镜头还没有生成画面/);
    assert.doesNotMatch(studio, /class="direction-art"/);
    selected.creativeRoute.hook = '<script>untrusted()</script>';
    const safe = renderCreativeChoices(data, c, selected.id);
    assert.doesNotMatch(safe, /<script>untrusted/);
    assert.match(safe, /&lt;script&gt;untrusted/);
  } finally { ctx.repository.close(); }
});

test('product photos stay labeled source materials rather than invented scene previews', async () => {
  const ctx = await context();
  try {
    const data = ctx.core.state(), c = data.campaigns[0]; data.cards = data.cardViews;
    data.brandAssets = [{ id: 'local-product-image', brandId: c.brandId, status: 'ready', type: 'product', name: '真实产品.png' }];
    const html = renderCreativeChoices(data, c, ctx.card.id);
    assert.equal((html.match(/src="\/api\/brand-assets\/local-product-image\/preview"/g) || []).length, 1);
    assert.match(html, /你的产品素材/);
    assert.match(html, /原图合成.*官网公开产品图参考生成/);
    assert.match(html, /cardVersion=1/);
    assert.doesNotMatch(html, /class="direction-art"/);
  } finally { ctx.repository.close(); }
});

test('current script results do not show an older video as the new version, and concurrent directions stay guarded', async () => {
  const ctx = await context();
  try {
    const config = await ctx.command('config.create', ctx.adopted.packageId, { angleId: ctx.angle.id, ratio: '9:16', duration: 15 });
    const request = await ctx.command('generation.start', config.configId, { mode: 'storyboard' });
    await ctx.finish(request.jobId);
    const data = ctx.core.state(), options = { data, c: data.campaigns[0], card: ctx.card, pack: data.packages[0], angle: ctx.angle, config: data.configs[0], assets: [{ id: 'old-video', type: 'video', configId: 'old-config', version: 1 }, ...data.assets], jobs: [], jobRow: () => '' };
    const html = renderResults({ ...options, blockedJob: { id: 'another-task' } });
    assert.match(html, /脚本已就绪，开始制作画面/);
    assert.doesNotMatch(html, /<video controls/);
    assert.match(html, /data-action="video"[^>]*disabled/);
    assert.match(html, /待制作 · 产品原图 \+ AI 背景/);
    assert.doesNotMatch(html, /data-action="play-storyboard"/);
    assert.doesNotMatch(html, /图片是本地产品素材/);
    const empty = renderResults({ ...options, assets: [] });
    assert.match(empty, /还没有已保存的脚本/);
    assert.doesNotMatch(empty, /正在整理你的分镜/);
  } finally { ctx.repository.close(); }
});

test('reference mode survives config saving and shows its actual process instead of local overlay instructions',async()=>{
  const ctx=await context();
  try{
    const c=ctx.core.state().campaigns[0];
    const added=await ctx.command('brandAsset.add',c.brandId,{name:'Public.png',type:'product',mime:'image/png',base64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jMZkAAAAASUVORK5CYII='});
    ctx.repository.transact(s=>Object.assign(s.brandAssets.find(a=>a.id===added.assetId),{source:'confirmed_website_import',sourceUrl:'https://example.com/product.png'}));
    const fields={ratio:'9:16',duration:'15',language:'中文',productTreatment:'product_reference',publicReferenceConsent:'on'};
    const id=await saveGenerationConfig({command:ctx.command,packageId:ctx.adopted.packageId,angleId:ctx.angle.id,fields,brandAssetIds:[added.assetId]});
    const request=await ctx.command('generation.start',id,{mode:'storyboard'});await ctx.finish(request.jobId);
    const data=ctx.core.state(),config=data.configs.find(v=>v.id===id);
    assert.equal(config.publicReferenceConsent.assetId,added.assetId);
    const html=renderResults({data,c,card:ctx.card,pack:data.packages[0],angle:ctx.angle,config,assets:data.assets,jobs:[],jobRow:()=>''});
    assert.match(html,/先确认商品在场景中的第一张画面/);
    assert.match(html,/待制作 · 商品参考场景/);
    assert.doesNotMatch(html,/AI 先生成背景，本机加入真实产品原图/);
    const picks=[{id:'first',brandId:c.brandId,status:'ready',type:'product'},{id:'second',brandId:c.brandId,status:'ready',type:'product'}];
    assert.equal(productImage({brandAssets:picks},c.brandId,['second','first']).id,'second');
    const store=createDraftStore(undefined,'scope');store.write('script',{productTreatment:'product_reference',publicReferenceConsent:'on'});
    assert.equal(store.read('script').publicReferenceConsent,undefined);
  }finally{ctx.repository.close();}
});

test('drafts override a saved config per field without discarding the unedited script or valid timing', () => {
  const fields = sceneFields({ claim: '产品主张', creativeRoute: { proof: '产品证明' } }, { hook: '指定角度开场', proof: '指定角度证明' }, null, { sceneOpening: '已编辑的开场', duration: '30' });
  assert.equal(fields.sceneOpening, '已编辑的开场');
  assert.equal(fields.sceneProof, '指定角度证明');
  assert.deepEqual(sceneTiming(fields.duration), [{ start: 0, end: 6 }, { start: 6, end: 22 }, { start: 22, end: 30 }]);
});

test('guided demo analysis never calls crawlers or invents external evidence', async () => {
  const ctx = await context('guided_demo');
  try {
    const job = await ctx.command('discovery.start', ctx.campaignId);
    let calls = 0;
    const crawler = { async collect() { calls++; throw new Error('Should not crawl in demo'); } };
    const runner = new LocalJobRunner({ core: ctx.core, repository: ctx.repository, crawler, metaCrawler: crawler, videoProvider: { available: false } });
    for (let i = 0; i < 5; i++) await runner.tick();
    const state = ctx.core.state(), run = state.discoveries.find(d => d.jobId === job.jobId) || state.discoveries.at(-1);
    assert.equal(calls, 0);
    assert.equal(state.jobs.find(j => j.id === job.jobId).status, 'succeeded');
    assert.equal(run.sourceIds.length, 0);
    assert.match(run.limitations.join(' '), /没有采集真实市场广告/);
  } finally { ctx.repository.close(); }
});

test('standard analysis keeps the complete product URL when calling the website crawler', async () => {
  const ctx = await context();
  try {
    const job = await ctx.command('discovery.start', ctx.campaignId);
    let requested;
    const runner = new LocalJobRunner({ core: ctx.core, repository: ctx.repository, metaCrawler: null, crawler: { async collect({ url }) { requested = url; return { sources: [], evidence: [], coverage: {} }; } }, videoProvider: { available: false } });
    for (let i = 0; i < 5; i++) await runner.tick();
    assert.equal(requested, 'https://example.com/products/coffee?size=250');
    assert.equal(ctx.core.state().jobs.find(j => j.id === job.jobId).status, 'succeeded');
  } finally { ctx.repository.close(); }
});

test('coffee creative options stay about coffee rather than inheriting the sportswear demo', async () => {
  const ctx = await context();
  try {
    const cards = ctx.core.state().cardViews;
    assert.match(cards[0].creativeRoute.hook, /咖啡/);
    assert.match(cards[1].creativeRoute.hook, /咖啡豆/);
    assert.match(cards[2].creativeRoute.proof, /冲煮/);
    assert.doesNotMatch(JSON.stringify(cards), /深蹲|无缝|热身|训练动作/);
    const angles = ctx.core.state().angles;
    assert.match(angles.find(a => a.name === '证明先行').hook, /咖啡豆/);
    assert.match(angles.find(a => a.name === '人物先行').hook, /厨房.*咖啡/);
    assert.match(angles.find(a => a.name === '人物先行').proof, /磨豆.*冲煮/);
  } finally { ctx.repository.close(); }
});
test('shot design survives drafts, config versions, storyboard rendering and generation prompts', async () => {
  const ctx = await context();
  try {
    const fields = sceneFields(ctx.card, ctx.angle, null, {
      sceneOpening: '磨豆机静态特写', sceneProof: '按钮近景', sceneClosing: '真实产品收尾',
      sceneOpening_firstFrame: '磨豆机靠右，左侧留白', sceneOpening_lastFrame: '磨豆机留在原位',
      sceneOpening_subjectMotion: '主体静止', sceneOpening_cameraMotion: '固定机位', sceneOpening_lighting: '柔和侧光', sceneOpening_continuity: '保持同一主体形状'
    });
    const entries = new Map(), storage = { getItem: key => entries.get(key), setItem: (key, value) => entries.set(key, value) };
    createDraftStore(storage, 'shot-test').write('script:a', fields);
    assert.equal(createDraftStore(storage, 'shot-test').read('script:a').sceneOpening_firstFrame, fields.sceneOpening_firstFrame);
    const options = { command: ctx.command, packageId: ctx.adopted.packageId, angleId: ctx.angle.id, fields };
    const configId = await saveGenerationConfig(options), config = ctx.core.state().configs.find(c => c.id === configId);
    assert.equal(config.scenePlan[0].direction.cameraMotion, '固定机位');
    assert.equal(await saveGenerationConfig({ ...options, config }), configId);
    assert.equal(sceneFields(ctx.card, ctx.angle, config).sceneOpening_firstFrame, fields.sceneOpening_firstFrame);
    const changed = await saveGenerationConfig({ ...options, config, fields: { ...fields, sceneOpening_cameraMotion: '缓慢靠近' } });
    assert.notEqual(changed, configId);
    assert.equal(ctx.core.state().configs.find(c => c.id === configId).scenePlan[0].direction.cameraMotion, '固定机位');
    const result = await ctx.command('generation.start', configId, { mode: 'storyboard' }); await ctx.finish(result.jobId);
    const data = ctx.core.state(), story = data.assets.find(a => a.generationRequestId === result.generationRequestId);
    assert.equal(story.scenes[0].direction.firstFrame, fields.sceneOpening_firstFrame);
    assert.match(buildVideoPrompt(data, data.jobs.find(j => j.id === result.jobId)), /Camera movement: 固定机位/);
    const c = data.campaigns.find(c => c.id === ctx.campaignId), pack = data.packages.find(p => p.id === ctx.adopted.packageId);
    const html = renderResults({ data, c, card: ctx.card, pack, angle: ctx.angle, config, assets: [story], jobs: [], jobRow: () => '' });
    assert.match(html, /磨豆机靠右，左侧留白/);
    assert.match(html, /镜头怎么移动/);
    const studio = renderStudio({ data, c, card: ctx.card, pack, angle: ctx.angle, angles: data.angles, config, draft: {}, selectedAssets: new Set(), selectedTemplateId: '', templates: [] });
    assert.match(studio, /name="sceneOpening_firstFrame"/);
    assert.doesNotMatch(studio, /name="sceneClosing_firstFrame"/);
  } finally { ctx.repository.close(); }
});

test('invalid structured direction fails without creating a config or allowing image uploads through the text contract', async () => {
  const ctx = await context();
  try {
    for (const direction of [{ firstFrame: 'x'.repeat(401) }, { referenceImage: 'file-bytes' }, [], 'invalid']) {
      await assert.rejects(ctx.command('config.create', ctx.adopted.packageId, { angleId: ctx.angle.id, ratio: '9:16', duration: 15, scenePlan: [{ text: '开场', direction }, { text: '展示' }, { text: '收尾' }] }), { code: 'INVALID_SHOT_DIRECTION' });
    }
    assert.equal(ctx.core.state().configs.length, 0);
  } finally { ctx.repository.close(); }
});
