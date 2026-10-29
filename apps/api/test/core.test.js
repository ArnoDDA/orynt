import test from 'node:test';
import assert from 'node:assert/strict';
import { Core } from '../src/core.js';
import { Repository } from '../src/repository.js';

function harness() {
  const repository = new Repository(':memory:');
  const core = new Core(repository);
  let sequence = 0;
  const command = (action, resourceId, body = {}) => core.command(action, resourceId, body, `test-key-${++sequence}`);
  return { repository, core, command };
}

function completeJob(core, steps) {
  for (let index = 0; index < steps; index++) core.tick();
}

function createCampaignThroughCards(context) {
  const { core, command } = context;
  const created = command('campaign.create', null, {
    brandUrl: 'https://dayform.example',
    name: '完整关系测试',
    objective: '验证产品证明表达',
    product: '日常随行杯',
    audience: '城市通勤人群'
  });
  command('snapshot.confirm', created.campaignId, {
    product: '日常随行杯',
    claim: '让随行咖啡成为轻松的日常',
    audience: '城市通勤人群',
    competitors: '设计型随行杯',
    market: '北美英语市场',
    limitations: '不使用未经证明的效果承诺'
  });
  command('discovery.start', created.campaignId);
  completeJob(core, 3);
  command('cards.generate', created.campaignId);
  completeJob(core, 3);
  return created;
}

test('the local Core keeps the complete Card-to-Asset lineage', () => {
  const context = harness();
  const { repository, core, command } = context;
  try {
    const created = createCampaignThroughCards(context);
    let state = core.state();
    const campaign = state.campaigns.find(item => item.id === created.campaignId);
    assert.equal(campaign.stage, 'cards_ready');
    assert.equal(campaign.status, 'active');
    assert.equal(state.cardSets.length, 1);
    assert.equal(state.cardSets[0].status, 'partial_published');
    assert.equal(state.cards.length, 3);
    assert.equal(state.cardVersions.length, 3);
    assert.equal(state.cardViews.length, 3);

    const card = state.cards[0];
    const adopted = command('card.adopt', card.id, { cardVersionId: card.currentVersionId });
    assert.equal(adopted.angleIds.length, 3);
    assert.equal(command('card.adopt', card.id, { cardVersionId: card.currentVersionId }).packageId, adopted.packageId);

    const config = command('config.create', adopted.packageId, {
      angleId: adopted.angleIds[0],
      ratio: '9:16',
      duration: 15,
      language: 'English',
      brandAssetIds: []
    });
    const generation = command('generation.start', config.configId, { mode: 'storyboard' });
    completeJob(core, 3);

    state = core.state();
    const request = state.generationRequests.find(item => item.id === generation.generationRequestId);
    const asset = state.assets.find(item => item.generationRequestId === request.id);
    assert.equal(request.status, 'succeeded');
    assert.equal(asset.sourceCardVersionId, card.currentVersionId);
    assert.equal(asset.angleId, adopted.angleIds[0]);
    assert.equal(asset.configId, config.configId);
    const contextProjection = state.campaignContexts.find(item => item.campaignId === campaign.id);
    assert.equal(contextProjection.stage.current, 'creating');
    assert.equal(contextProjection.stage.locked.includes('cards'), false);
    assert.equal(contextProjection.stage.locked.includes('create'), false);
    assert.equal(contextProjection.stage.locked.includes('launch'), true);
    assert.throws(() => command('asset.launch-ready', asset.id, { reviewed: true }), error => error.code === 'VIDEO_REQUIRED');
  } finally {
    repository.close();
  }
});

test('brand assets store real local image content but redact it from state responses', () => {
  const context = harness();
  const { repository, core, command } = context;
  try {
    const created = command('campaign.create', null, { brandUrl: 'https://visual.example' });
    const brandId = core.state().campaigns.find(item => item.id === created.campaignId).brandId;
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#163f36"/></svg>';
    const added = command('brandAsset.add', brandId, { name: 'Visual Logo.svg', mime: 'image/svg+xml', type: 'logo', promptHint: '深绿色极简标志', base64: Buffer.from(svg).toString('base64') });
    const stored = repository.read().brandAssets.find(item => item.id === added.assetId);
    assert.equal(Buffer.from(stored.base64, 'base64').toString(), svg);
    assert.equal(stored.status, 'ready');
    assert.equal(core.state().brandAssets.find(item => item.id === added.assetId).base64, undefined);
    assert.ok(repository.read().snapshots.find(item => item.id === created.brandSnapshotId).assetIds.includes(added.assetId));
    command('brandAsset.remove', added.assetId);
    assert.equal(repository.read().brandAssets.length, 0);
    assert.equal(repository.read().snapshots.find(item => item.id === created.brandSnapshotId).assetIds.includes(added.assetId), false);
  } finally { repository.close(); }
});

test('video import, Launch Plan versions and mappings stay on one Card version', () => {
  const context = harness();
  const { repository, core, command } = context;
  try {
    const created = createCampaignThroughCards(context);
    let state = core.state();
    const card = state.cards[0];
    const adopted = command('card.adopt', card.id, {});
    const config = command('config.create', adopted.packageId, {
      angleId: adopted.angleIds[0], ratio: '9:16', duration: 15, language: 'English'
    });
    const video = Buffer.alloc(20);
    video.write('ftyp', 4, 'ascii');
    const imported = command('asset.import', config.configId, { filename: 'local.mp4', base64: video.toString('base64') });
    command('asset.launch-ready', imported.assetId, { reviewed: true });
    const plan1 = command('plan.save', created.campaignId, {
      assetIds: [imported.assetId], channel: 'Meta', audience: '城市通勤人群', hypothesis: '场景开头提高理解', metric: 'CTR'
    });
    const plan2 = command('plan.save', created.campaignId, {
      assetIds: [imported.assetId], channel: 'Meta', audience: '城市通勤人群', hypothesis: '场景开头提高理解', metric: 'CTR'
    });
    command('mapping.save', plan2.planId, { assetId: imported.assetId, externalAdId: 'ad-001' });

    state = core.state();
    assert.equal(state.campaigns[0].stage, 'launch_ready');
    assert.equal(plan1.version, 1);
    assert.equal(plan2.version, 2);
    assert.equal(state.plans.find(item => item.id === plan1.planId).status, 'prepared');
    assert.equal(state.plans.find(item => item.id === plan2.planId).status, 'mapped');
    assert.equal(state.mappings[0].cardVersionId, card.currentVersionId);
    assert.equal(state.assets[0].base64, undefined);
  } finally {
    repository.close();
  }
});

test('simulated metrics flow back through confirmed mappings without becoming real learning', () => {
  const context = harness();
  const { repository, core, command } = context;
  try {
    const created = createCampaignThroughCards(context);
    let state = core.state();
    const card = state.cards[0];
    const adopted = command('card.adopt', card.id);
    const config = command('config.create', adopted.packageId, {
      angleId: adopted.angleIds[0], ratio: '9:16', duration: 15, language: 'English'
    });
    const video = Buffer.alloc(20); video.write('ftyp', 4, 'ascii');
    const imported = command('asset.import', config.configId, { filename: 'simulation.mp4', base64: video.toString('base64') });
    command('asset.launch-ready', imported.assetId, { reviewed: true });
    const plan = command('plan.save', created.campaignId, {
      assetIds: [imported.assetId], channel: 'Meta', audience: 'Test audience', hypothesis: 'Test hypothesis', metric: 'CTR'
    });
    assert.throws(() => command('metrics.simulate', plan.planId, { confirmSimulation: true }), error => error.code === 'MAPPING_INCOMPLETE');
    const launched = command('plan.simulate-launch', plan.planId, {});
    assert.equal(launched.simulation, true);
    assert.equal(launched.mappingIds.length, 1);
    const simulated = command('metrics.simulate', plan.planId, { confirmSimulation: true });
    assert.equal(simulated.metricCount, 4);
    state = core.state();
    const metrics = state.metricSnapshots.filter(item => item.planId === plan.planId);
    assert.equal(metrics.length, 4);
    assert.ok(metrics.every(item => item.simulation && item.source === 'local_simulation' && item.quality === 'simulated_complete'));
    assert.ok(metrics.every(item => item.mappingId === state.mappings[0].id && item.assetId === imported.assetId));
    assert.equal(state.mappings[0].simulation, true);
    assert.equal(state.mappings[0].matchMethod, 'local_simulation');
    assert.equal(state.plans.find(item => item.id === plan.planId).simulatedLaunchAt != null, true);
    const conclusion = state.conclusions.find(item => item.id === simulated.conclusionId);
    assert.equal(conclusion.simulation, true);
    assert.equal(conclusion.cardId, card.id);
    assert.equal(conclusion.confidence, 'simulation_only');
    assert.equal(state.campaigns[0].stage, 'learning');
    assert.equal(state.plans.find(item => item.id === plan.planId).dataMode, 'simulation');
    assert.throws(() => command('conclusion.adopt', conclusion.id, { status: 'adopted' }), error => error.code === 'SIMULATED_CONCLUSION_READ_ONLY');
    assert.throws(() => command('metrics.simulate', plan.planId, { confirmSimulation: true }), error => error.code === 'SIMULATION_EXISTS');
    const replaced = command('metrics.simulate', plan.planId, { confirmSimulation: true, replace: true });
    state = core.state();
    assert.equal(state.metricSnapshots.filter(item => item.planId === plan.planId).length, 4);
    assert.equal(state.conclusions.filter(item => item.planId === plan.planId).length, 1);
    assert.notEqual(replaced.batchId, simulated.batchId);
  } finally { repository.close(); }
});

test('simulated launch keeps its mappings separate from existing manual mappings', () => {
  const context = harness();
  const { repository, core, command } = context;
  try {
    const created = createCampaignThroughCards(context);
    const card = core.state().cards[0];
    const adopted = command('card.adopt', card.id);
    const config = command('config.create', adopted.packageId, {
      angleId: adopted.angleIds[0], ratio: '9:16', duration: 15, language: 'English'
    });
    const video = Buffer.alloc(20); video.write('ftyp', 4, 'ascii');
    const imported = command('asset.import', config.configId, { filename: 'simulation.mp4', base64: video.toString('base64') });
    command('asset.launch-ready', imported.assetId, { reviewed: true });
    const plan = command('plan.save', created.campaignId, {
      assetIds: [imported.assetId], channel: 'Meta', audience: 'Test audience', hypothesis: 'Test hypothesis', metric: 'CTR'
    });
    command('mapping.save', plan.planId, { assetId: imported.assetId, externalAdId: 'manual-ad-001' });
    const launched = command('plan.simulate-launch', plan.planId, {});
    const state = core.state();
    const mappings = state.mappings.filter(item => item.planId === plan.planId);
    assert.equal(mappings.length, 2);
    assert.equal(mappings.find(item => item.id === launched.mappingIds[0]).simulation, true);
    const simulated = command('metrics.simulate', plan.planId, { confirmSimulation: true });
    const updated = core.state();
    assert.ok(updated.metricSnapshots.filter(item => item.batchId === simulated.batchId).every(item => item.mappingId === launched.mappingIds[0]));
  } finally { repository.close(); }
});

test('Discovery deduplicates Evidence and Cards keep traceable Evidence relations', () => {
  const context = harness();
  const { repository, core, command } = context;
  try {
    const created = command('campaign.create', null, { brandUrl: 'https://example.com', objective: '验证公开证据驱动的表达' });
    command('snapshot.confirm', created.campaignId, { product: 'Example product', claim: 'A confirmed claim', audience: 'Test audience' });
    command('discovery.start', created.campaignId);
    core.tick(); core.tick({ discovery: null });
    const evidence = { sourceType: 'brand_website', sourceUrl: 'https://example.com/', observedAt: '2026-09-17T00:00:00Z', ingestedAt: '2026-09-17T00:00:01Z', title: 'Example proof', contentSummary: 'A public product statement.', rawEvidenceRef: 'local://raw/example', contentHash: 'same-hash' };
    core.tick({ discovery: {
      provider: 'test', coverage: { fetchedPages: 1 }, limitations: ['小样本'],
      sources: [{ sourceType: 'brand_website', sourceUrl: evidence.sourceUrl, status: 'available', observedAt: evidence.observedAt }],
      evidence: [evidence, { ...evidence, title: 'Duplicate' }]
    } });
    command('cards.generate', created.campaignId);
    completeJob(core, 3);
    const state = core.state();
    assert.equal(state.evidence.length, 1);
    assert.equal(state.signals.length, 1);
    assert.equal(state.collectionBatches.length, 1);
    assert.equal(state.cardEvidence.length, 1);
    assert.equal(state.cardViews[0].facts[0].evidenceIds[0], state.evidence[0].id);
    assert.equal(state.cardViews[0].quality.evidenceStatus, 'brand_context_only');
    assert.equal(state.cardViews[0].quality.supportingEvidenceCount, 1);
    assert.equal(state.cardViews[0].relevanceMethod, 'same_origin_brand_source');
    assert.equal(state.cardViews[1].quality.evidenceStatus, 'insufficient');
    assert.equal(state.cardViews[1].quality.supportingEvidenceCount, 0);
    assert.equal(state.cardViews[0].claim, 'A confirmed claim');
    assert.equal(state.discoveries[0].opportunities[0].id, state.cardViews[0].opportunityId);
    assert.deepEqual(state.discoveries[0].opportunities[0].evidenceIds, state.cardViews[0].facts[0].evidenceIds);
    assert.equal(state.discoveries[0].opportunities[1].basis, 'unverified');
  } finally { repository.close(); }
});

test('each creative angle uses its own configuration and rejects mismatched generation', () => {
  const context = harness();
  const { core, command, repository } = context;
  try {
    createCampaignThroughCards(context);
    const card = core.state().cards[0];
    const adopted = command('card.adopt', card.id);
    const first = command('config.create', adopted.packageId, { angleId: adopted.angleIds[0], ratio: '9:16', duration: 15 });
    const second = command('config.create', adopted.packageId, { angleId: adopted.angleIds[1], ratio: '1:1', duration: 30 });
    assert.throws(() => command('generation.start', first.configId, { angleId: adopted.angleIds[1], mode: 'storyboard' }), error => error.code === 'ANGLE_CONFIG_MISMATCH');
    const job = command('generation.start', second.configId, { angleId: adopted.angleIds[1], mode: 'storyboard' });
    completeJob(core, 3);
    assert.equal(core.state().assets.find(asset => asset.generationRequestId === job.generationRequestId).angleId, adopted.angleIds[1]);
  } finally { repository.close(); }
});

test('reference templates stay local, publish a redacted timeline, and remain optional per angle', () => {
  const context = harness();
  const { core, command, repository } = context;
  try {
    createCampaignThroughCards(context);
    const card = core.state().cards[0];
    const adopted = command('card.adopt', card.id);
    const bytes = Buffer.alloc(24); bytes.write('ftyp', 4, 'ascii');
    assert.throws(() => command('template.import', adopted.packageId, {
      angleId: adopted.angleIds[0], filename: 'invalid.mp4', base64: Buffer.from('not-video').toString('base64')
    }), error => error.code === 'INVALID_VIDEO');
    const imported = command('template.import', adopted.packageId, {
      angleId: adopted.angleIds[0], filename: 'reference.mp4', mime: 'video/mp4', base64: bytes.toString('base64')
    });
    let publicState = core.state();
    assert.equal(publicState.videoTemplates[0].base64, undefined);
    assert.equal(repository.read().videoTemplates[0].base64, bytes.toString('base64'));
    core.tick({ jobId: imported.jobId });
    core.tick({ jobId: imported.jobId, providerResult: {
      duration: 8, width: 1080, height: 1920, fps: 30, aspectRatio: '1080:1920', detector: 'AdaptiveDetector', analysisEngine: 'pyscenedetect-0.7.1',
      scenes: [
        { start: 0, end: 3, duration: 3, keyframeTime: 1.5, keyframeBase64: Buffer.from('frame-1').toString('base64') },
        { start: 3, end: 8, duration: 5, keyframeTime: 5.5, keyframeBase64: Buffer.from('frame-2').toString('base64') }
      ]
    } });
    core.tick({ jobId: imported.jobId });
    publicState = core.state();
    const template = publicState.videoTemplates[0];
    assert.equal(template.status, 'ready');
    assert.equal(template.sceneCount, 2);
    assert.equal(template.scenes[0].keyframeBase64, undefined);
    assert.equal(repository.read().videoTemplates[0].scenes[0].keyframeBase64, Buffer.from('frame-1').toString('base64'));
    const withTemplate = command('config.create', adopted.packageId, {
      angleId: adopted.angleIds[0], ratio: '9:16', duration: 30, templateId: template.id
    });
    const withoutTemplate = command('config.create', adopted.packageId, {
      angleId: adopted.angleIds[1], ratio: '1:1', duration: 15, templateId: ''
    });
    assert.equal(core.state().configs.find(item => item.id === withTemplate.configId).templateId, template.id);
    assert.equal(core.state().configs.find(item => item.id === withoutTemplate.configId).templateId, null);
    assert.throws(() => command('config.create', adopted.packageId, {
      angleId: adopted.angleIds[1], ratio: '9:16', duration: 15, templateId: template.id
    }), error => error.code === 'INVALID_VIDEO_TEMPLATE');
  } finally { repository.close(); }
});

test('unrelated and demo Meta evidence cannot be cited as support for Cards', () => {
  const context = harness();
  const { core, command, repository } = context;
  try {
    const created = command('campaign.create', null, { brandUrl: 'https://example.com', product: 'Travel Mug' });
    command('snapshot.confirm', created.campaignId, { product: 'Travel Mug' });
    command('discovery.start', created.campaignId);
    core.tick(); core.tick();
    const sourceUrl = 'https://www.facebook.com/ads/library/?id=123';
    const evidence = (title, suffix) => ({ sourceType: 'meta_public_ad', sourceUrl: sourceUrl + suffix, title, contentSummary: title, observedAt: '2026-09-17T00:00:00Z', contentHash: suffix });
    core.tick({ discovery: { provider: 'test', coverage: { sources: 2 }, sources: [
      { sourceType: 'meta_public_ad', sourceUrl: sourceUrl + '1', status: 'available' },
      { sourceType: 'meta_public_ad', sourceUrl: sourceUrl + '2', status: 'demo' }
    ], evidence: [evidence('Unrelated fitness shoes', '1'), evidence('Travel Mug demo', '2')] } });
    command('cards.generate', created.campaignId); completeJob(core, 3);
    const state = core.state();
    assert.equal(state.evidence.length, 2);
    assert.equal(state.cardEvidence.length, 0);
    assert.equal(state.cardViews[0].quality.evidenceStatus, 'brand_context_only');
    assert.ok(state.cardViews.slice(1).every(card => card.quality.evidenceStatus === 'insufficient'));
    assert.ok(state.cardViews.every(card => card.claim === '待品牌确认核心主张'));
  } finally { repository.close(); }
});

test('Discovery directions and Cards share distinct, qualified Meta sources', () => {
  const context = harness();
  const { core, command, repository } = context;
  try {
    const created = command('campaign.create', null, { brandUrl: 'https://mug.example', product: 'Travel Mug' });
    command('snapshot.confirm', created.campaignId, { product: 'Travel Mug', claim: 'User confirmed claim' });
    command('discovery.start', created.campaignId);
    core.tick(); core.tick();
    const sources = [1, 2, 3].map(n => ({ sourceType: 'meta_ad_library', sourceUrl: `https://www.facebook.com/ads/library/?id=${n}`, status: n === 3 ? 'demo' : 'available' }));
    const evidence = sources.map((source, index) => ({ sourceType: 'meta_ad_library', sourceUrl: source.sourceUrl, observedAt: '2026-09-17T00:00:00Z', title: `Travel Mug sample ${index + 1}`, contentSummary: `Travel Mug shown in ad ${index + 1}`, contentHash: `meta-${index}` }));
    core.tick({ discovery: { provider: 'test', coverage: { liveMetaAds: 2 }, limitations: ['当前仅覆盖品牌自有官网，尚未加入外部市场、社区和广告数据。'], sources, evidence } });
    let state = core.state();
    const opportunities = state.discoveries[0].opportunities;
    assert.deepEqual(opportunities.map(item => item.basis), ['brand_context', 'public_sample', 'public_sample']);
    assert.equal(new Set(opportunities.flatMap(item => item.evidenceIds)).size, 2);
    assert.equal(state.discoveries[0].limitations.length, 0);
    command('cards.generate', created.campaignId); completeJob(core, 3);
    state = core.state();
    for (let index = 0; index < 3; index++) {
      assert.equal(state.cardViews[index].opportunityId, opportunities[index].id);
      assert.deepEqual(state.cardEvidence.filter(link => link.cardId === state.cardViews[index].id).map(link => link.evidenceId), opportunities[index].evidenceIds);
    }
    assert.equal(state.cardViews[1].quality.evidenceStatus, 'traceable_small_sample');
    assert.equal(state.cardViews[1].quality.supportingEvidenceCount, 1);
    assert.equal(state.cardViews[1].relevanceMethod, 'available_source_and_keyword_match');
    assert.match(state.cardViews[1].evidenceSummary, /Travel Mug/);
    assert.equal(state.cardViews[0].quality.evidenceStatus, 'brand_context_only');
    assert.match(state.cardViews[0].testHypothesis, /是否比/);
    assert.match(state.cardViews[0].testPlan.control, /A 基准版/);
    assert.match(state.cardViews[0].testPlan.variant, /B 测试版/);
    assert.match(state.cardViews[0].testPlan.successSignal, /留存|点击率|完播率/);
    assert.ok(state.cardViews[1].facts[0].statement.startsWith('Meta 公开广告页面展示'));
  } finally { repository.close(); }
});

test('product-specific Meta copy is ranked ahead of generic brand placeholders', () => {
  const context = harness();
  const { core, command, repository } = context;
  try {
    const created = command('campaign.create', null, { brandUrl: 'https://gymshark.example', product: 'Everyday Seamless 女士训练服' });
    const campaign = core.state().campaigns.find(item => item.id === created.campaignId);
    command('brand.update', campaign.brandId, { name: 'Gymshark' });
    command('snapshot.confirm', created.campaignId, { product: 'Everyday Seamless 女士训练服' });
    command('discovery.start', created.campaignId); core.tick(); core.tick();
    const sources = ['generic', 'specific'].map(id => ({ sourceType: 'meta_ad_library', sourceUrl: `https://www.facebook.com/ads/library/?id=${id}`, status: 'available' }));
    const evidence = [
      { sourceType: 'meta_ad_library', sourceUrl: sources[0].sourceUrl, title: 'Gymshark dynamic ad', contentSummary: 'Gymshark dynamic product ad', observedAt: '2026-09-17T00:00:00Z', contentHash: 'generic', attributes: { advertiserName: 'Gymshark', bodyText: '{{product.brand}}' } },
      { sourceType: 'meta_ad_library', sourceUrl: sources[1].sourceUrl, title: 'Gymshark Women', contentSummary: 'Everyday Seamless has restocked', observedAt: '2026-09-17T00:00:00Z', contentHash: 'specific', attributes: { advertiserName: 'Gymshark Women', bodyText: 'Everyday Seamless has restocked' } }
    ];
    core.tick({ discovery: { provider: 'test', coverage: { liveMetaAds: 2 }, sources, evidence } });
    const opportunities = core.state().discoveries[0].opportunities;
    assert.match(opportunities[1].evidenceSummary, /Everyday Seamless has restocked/);
    assert.match(opportunities[2].evidenceSummary, /dynamic product ad/);
  } finally { repository.close(); }
});

test('refresh publishes evidence-aware Cards without rewriting an adopted historical version', () => {
  const context = harness();
  const { core, command, repository } = context;
  try {
    const created = createCampaignThroughCards(context);
    const original = core.state().cardViews.filter(card => card.campaignId === created.campaignId);
    repository.transact(state => {
      const version = state.cardVersions.find(item => item.id === original[0].versionId);
      delete version.content.opportunityId;
      delete version.content.evidenceBasis;
    });
    command('card.adopt', original[0].id);
    command('cards.refresh', created.campaignId); completeJob(core, 3);
    const state = core.state();
    const adopted = state.cardViews.find(card => card.id === original[0].id);
    assert.equal(adopted.status, 'adopted');
    assert.equal(adopted.versionId, original[0].versionId);
    assert.equal(adopted.opportunityId, undefined);
    assert.equal(state.cards.filter(card => card.status === 'superseded').length, 2);
    const newCards = state.cardViews.filter(card => card.version === 2);
    assert.equal(newCards.length, 3);
    assert.ok(newCards.every(card => card.opportunityId?.startsWith(state.discoveries[0].id)));
    assert.equal(state.cardEvidence.filter(link => link.cardId === adopted.id).length, 0);
  } finally { repository.close(); }
});

test('job retry stops at max attempts and cancelled work cannot publish', () => {
  const context = harness();
  const { repository, core, command } = context;
  try {
    const first = command('campaign.create', null, { brandUrl: 'https://retry.example' });
    const queued = command('discovery.start', first.campaignId);
    for (let attempt = 0; attempt < 3; attempt++) {
      core.tick({ jobId: queued.jobId, error: { code: 'SOURCE_DOWN', message: 'source down' } });
      if (attempt < 2) command('job.retry', queued.jobId);
    }
    assert.throws(() => command('job.retry', queued.jobId), error => error.code === 'JOB_ATTEMPTS_EXHAUSTED');

    const second = command('campaign.create', null, { brandUrl: 'https://cancel.example' });
    const cancelled = command('discovery.start', second.campaignId);
    command('job.cancel', cancelled.jobId);
    core.tick({ jobId: cancelled.jobId, discovery: { sources: [], evidence: [] } });
    const state = core.state();
    assert.equal(state.jobs.find(item => item.id === cancelled.jobId).status, 'cancelled');
    assert.equal(state.discoveries.some(item => item.campaignId === second.campaignId), false);
  } finally { repository.close(); }
});

test('local guest workspace only clears with an explicit confirmation value', () => {
  const context = harness();
  const { repository, core, command } = context;
  try {
    command('campaign.create', null, { brandUrl: 'https://clear.example' });
    assert.throws(() => command('workspace.clear', null, { confirm: true }), error => error.code === 'CONFIRM_REQUIRED');
    const result = command('workspace.clear', null, { confirm: 'CLEAR_LOCAL_WORKSPACE' });
    assert.equal(result.cleared, true);
    const state = core.state();
    assert.equal(state.campaigns.length, 0);
    assert.equal(state.workspace.localOnly, true);
    assert.equal(state.audit.at(-1).action, 'workspace_cleared');
  } finally { repository.close(); }
});
