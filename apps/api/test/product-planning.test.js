import test from 'node:test';
import assert from 'node:assert/strict';
import { Repository } from '../src/repository.js';
import { Core } from '../src/core.js';
import { LocalJobRunner } from '../src/job-runner.js';
import { ProductStrategyPlanner } from '../src/product-strategy-planner.js';
import { mapApiState } from '../../web/public/api-client.js';
import { renderProductReview, renderCreativeChoices, sceneFields } from '../../web/public/creator-flow.js';
import { renderProductDossier, renderAdvertisingPlan } from '../../web/public/product-plan-view.js';
import { buildProductDossier, buildAdvertisingPlans, validateModelPlans } from '../../../packages/domain/src/product-planning.js';
import { productionPlan } from '../../../packages/domain/src/production-plan.js';
import { buildKeyframePrompt } from '../../../packages/domain/src/production-plan.js';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jMZkAAAAASUVORK5CYII=';
const samples = [
  { product: 'Daily Coffee', claim: 'Chocolate notes', category: 'food', route: 'usage_context', action: /咖啡/ },
  { product: 'Cotton Shirt', claim: 'Soft cotton', category: 'apparel', route: 'original_material_first', action: /更衣/ },
  { product: 'Daily Serum', claim: 'A simple daily routine', category: 'beauty', route: 'original_material_first', action: /护理|洗漱/ },
  { product: 'Wireless Headphones', claim: 'Compact for everyday carry', category: 'electronics', route: 'original_material_first', action: /工作|桌面/ }
];

async function imported(sample, { planner, details } = {}) {
  const repository = new Repository(':memory:'), core = new Core(repository); let seq = 0;
  const command = (action, id, data = {}) => core.command(action, id, data, `product-plan-${++seq}`);
  const created = command('campaign.create', null, { brandUrl: 'https://example.com/products/one', importFromUrl: true });
  const runner = new LocalJobRunner({ repository, core, metaCrawler: null, ...(planner ? { strategyPlanner: planner } : {}), productImporter: { collect: async () => ({ sourceUrl: 'https://example.com/products/one', pageKind: 'product', fields: { product: { value: sample.product, sourceType: 'schema_product' }, claim: { value: sample.claim, sourceType: 'schema_description' } }, details: details || { category: sample.category, attributes: [{ name: '材质', value: 'From the page' }] }, images: [{ name: 'Original.png', sourceUrl: 'https://example.com/photo.png', mime: 'image/png', base64: png }] }) } });
  await runner.tick(); await runner.tick();
  return { repository, core, command, created, runner };
}

for (const sample of samples) test(`URL import to a frozen executable plan for ${sample.category}`, async () => {
  const h = await imported(sample);
  try {
    const pending = h.core.state().snapshots[0];
    assert.equal(pending.productDossier.product, sample.product);
    assert.equal(pending.productDossier.facts.find(f => f.id === 'claim').confirmation, 'pending');
    assert.match(renderProductReview(mapApiState(h.core.state()), mapApiState(h.core.state()).campaigns[0]), /我们会怎样呈现这个产品/);
    h.command('snapshot.confirm', h.created.campaignId, { product: sample.product, claim: sample.claim, importImageIds: [pending.productImport.images[0].id] });
    h.command('discovery.start', h.created.campaignId); for (let i = 0; i < 3; i++) h.core.tick();
    const job = h.command('cards.generate', h.created.campaignId);
    for (let i = 0; i < 4; i++) await h.runner.tick();
    assert.equal(h.core.state().jobs.find(j => j.id === job.jobId).status, 'succeeded');
    const data = mapApiState(h.core.state()), card = data.cards[0], dossier = card.productDossier;
    assert.equal(dossier.category.id, sample.category);
    assert.equal(card.advertisingPlan.route.id, sample.route);
    assert.equal(card.advertisingPlan.focus.value, sample.claim);
    assert.match(card.advertisingPlan.hook, sample.action);
    assert.equal(dossier.facts.find(f => f.id === 'attribute_0').confirmation, 'pending');
    assert.equal(card.advertisingPlan.execution.exactProductInGeneratedScenes, false);
    assert.deepEqual(card.advertisingPlan.shots.map(s => s.source), ['generated_context', 'generated_context', 'local_product_image']);
    assert.equal(dossier.materials[0].usableForEndcard, true);
    assert.doesNotMatch(JSON.stringify(dossier), new RegExp(png.slice(0, 25)));
    const html = renderCreativeChoices(data, data.campaigns[0]);
    assert.match(html, /本条广告制作方案|本条广告/); assert.match(html, /真实产品图 · 在本机合成/);
    const unsafeData = structuredClone(data);
    unsafeData.cards[0].advertisingPlan.name = '<script>bad()</script>" onclick="bad()';
    assert.doesNotMatch(renderCreativeChoices(unsafeData, unsafeData.campaigns[0]), /<script>bad|aria-label="[^\n>]*" onclick="bad/);
    const adopted = h.command('card.adopt', card.id), angle = h.core.state().angles.find(a => a.id === adopted.angleIds[0]);
    const fields = sceneFields(card, angle);
    assert.equal(fields.sceneOpening, card.advertisingPlan.shots[0].description);
    assert.equal(fields.copyDetail, sample.claim);
    const saved = h.command('config.create', adopted.packageId, { angleId: angle.id, ratio: '9:16', duration: 15, brandAssetIds: [dossier.materials[0].id] });
    const config = h.repository.read().configs.find(c => c.id === saved.configId);
    assert.equal(config.scenePlan[1].text, card.advertisingPlan.shots[1].description);
    const production = productionPlan({ config, product: sample.product });
    assert.equal(production.advertisingPlan.focus.value, sample.claim);
    const edited = h.command('config.create', adopted.packageId, { angleId: angle.id, ratio: '9:16', duration: 15, scenePlan: config.scenePlan.map((s, i) => ({ ...s, text: i === 0 ? 'A newly edited context scene' : s.text })) });
    const changedConfig = h.repository.read().configs.find(c => c.id === edited.configId);
    assert.equal(changedConfig.advertisingPlan.shots[0].description, 'A newly edited context scene');
    assert.equal(changedConfig.advertisingPlan.editedFromProposal, true);
    assert.equal(config.advertisingPlan.editedFromProposal, false);
    const productionJob = h.command('production.start', config.id, { keyframes: true });
    assert.ok(productionJob.jobId);
    const request = h.repository.read().generationRequests[0];
    assert.equal(request.production.productDossier.provenance.snapshotId, pending.id);
    const old = JSON.stringify(card.advertisingPlan);
    h.command('brief.update', h.created.campaignId, { objective: 'A new brief', product: 'Another product' });
    assert.equal(JSON.stringify(h.core.state().cardViews[0].advertisingPlan), old);
  } finally { h.repository.close(); }
});

test('new product names invalidate old page specifications and edited claims do not cite the old web description', async () => {
  const h = await imported(samples[0]);
  try {
    h.command('snapshot.confirm', h.created.campaignId, { product: 'Another product', claim: 'User-authored focus' });
    const dossier = h.core.state().snapshots[0].productDossier;
    assert.equal(dossier.facts.some(f => f.id.startsWith('attribute_')), false);
    assert.equal(dossier.facts.find(f => f.id === 'claim').source, 'user');
    assert.equal(dossier.facts.find(f => f.id === 'claim').sourceUrl, '');
  } finally { h.repository.close(); }
});

test('multi-product pages require a deliberate product choice; candidate reads cannot jump to an unrelated URL', async () => {
  const h = await imported(samples[0], { details: { candidates: [{ name: 'One', url: 'https://example.com/products/one' }, { name: 'Two', url: 'https://example.com/products/two' }] } });
  try {
    h.repository.transact(s => { s.snapshots[0].productImport.pageKind = 'website'; });
    assert.throws(() => h.command('snapshot.confirm', h.created.campaignId, { product: samples[0].product, claim: 'Claim' }), { code: 'PRODUCT_SELECTION_REQUIRED' });
    assert.throws(() => h.command('productImport.start', h.created.campaignId, { productUrl: 'https://unrelated.example/secret' }), { code: 'INVALID_PRODUCT_CANDIDATE' });
    const result = h.command('productImport.start', h.created.campaignId, { productUrl: 'https://example.com/products/two' });
    const state = h.repository.read();
    assert.equal(state.jobs.find(j => j.id === result.jobId).input.url, 'https://example.com/products/two');
    assert.equal(state.snapshots[0].productImport.images.length, 0);
  } finally { h.repository.close(); }
});

test('optional model planning sends minimal confirmed text, validates citations, and actually reaches the adopted script', async () => {
  let calls = 0, sent;
  const strategy = { plans: [1, 2, 3].map(n => ({ name: `方案${n}`, hook: `工作台旁，一只手整理第${n}个收纳位置。`, proof: `同一环境，镜头缓慢靠近第${n}个位置，不展示具体商品性能。`, hypothesis: `情境${n}能否帮助理解产品？`, factIds: ['claim'] })) };
  const planner = new ProductStrategyPlanner({ enabled: true, textProvider: { available: true, generate: async input => { calls++; sent = input; return { text: JSON.stringify(strategy) }; } } });
  const h = await imported(samples[3], { planner });
  try {
    const snap = h.core.state().snapshots[0];
    h.command('snapshot.confirm', h.created.campaignId, { product: samples[3].product, claim: samples[3].claim, importImageIds: [snap.productImport.images[0].id] });
    h.command('discovery.start', h.created.campaignId); for (let i = 0; i < 3; i++) h.core.tick();
    h.command('cards.generate', h.created.campaignId); for (let i = 0; i < 5; i++) await h.runner.tick();
    assert.equal(calls, 1);
    assert.doesNotMatch(sent.prompt, /From the page|base64|example\.com|iVBOR/);
    const card = h.core.state().cardViews[0];
    assert.equal(card.advertisingPlan.source, 'model_product_plan');
    assert.equal(card.creativeRoute.hook, strategy.plans[0].hook);
    const adopted = h.command('card.adopt', card.id);
    assert.equal(h.core.state().angles.find(a => a.id === adopted.angleIds[0]).scenePlan[0].text, strategy.plans[0].hook);
    strategy.plans[0].factIds = ['invented_fact'];
    const fallback = await planner.plan(card.productDossier);
    assert.equal(fallback.planningSource, 'local_product_plan');
    assert.equal(fallback.strategy, undefined);
  } finally { h.repository.close(); }
});

test('a connected credential alone never enables model transmission; malformed and repeated proposals are rejected', async () => {
  let calls = 0;
  const planner = new ProductStrategyPlanner({ enabled: false, textProvider: { available: true, generate: async () => { calls++; } } });
  const dossier = buildProductDossier({ snapshot: { facts: { product: 'Serum', claim: 'Daily care' }, confirmation: 'confirmed' } });
  assert.equal((await planner.plan(dossier)).planningSource, 'local_product_plan'); assert.equal(calls, 0);
  assert.throws(() => validateModelPlans({ plans: [null, {}, []] }, dossier));
  assert.throws(() => validateModelPlans({ plans: [1, 2, 3].map(n => ({ name: String(n), hook: 'Repeated', proof: 'Proof', hypothesis: 'Question', factIds: ['claim'] })) }, dossier));
  const changed = buildProductDossier({ snapshot: { facts: { product: 'Serum', claim: 'Another focus' }, confirmation: 'confirmed' } });
  assert.notEqual(buildAdvertisingPlans(dossier)[0].focus.value, buildAdvertisingPlans(changed)[0].focus.value);
});

test('page attributes and model plan names are escaped in the actual product views', () => {
  const dossier = buildProductDossier({ snapshot: { brandId: 'brand', facts: { product: 'Serum', claim: '<img src=x onerror=bad()>' }, confirmation: 'confirmed', productImport: { sourceUrl: 'https://example.com/p', details: { attributes: [{ name: '<script>bad()</script>', value: '<svg onload=bad()>' }] } } } });
  const plan = buildAdvertisingPlans(dossier)[0];
  plan.route.label = '<script>bad()</script>';
  const html = renderProductDossier(dossier) + renderAdvertisingPlan({ advertisingPlan: plan, productDossier: dossier });
  assert.doesNotMatch(html, /<script>|<img src=x|<svg onload/);
  assert.match(html, /&lt;script&gt;/);
});

test('an old model response cannot publish into a cancelled and retried Card job', async () => {
  let release;
  const h = await imported(samples[0], { planner: { plan: () => new Promise(resolve => { release = resolve; }) } });
  try {
    h.command('snapshot.confirm', h.created.campaignId, { product: samples[0].product, claim: samples[0].claim });
    h.command('discovery.start', h.created.campaignId); for (let i = 0; i < 3; i++) h.core.tick();
    const { jobId } = h.command('cards.generate', h.created.campaignId);
    await h.runner.tick();
    const pending = h.runner.tick();
    h.command('job.cancel', jobId); h.command('job.retry', jobId);
    release({ planningNotice: 'Old response' }); await pending;
    const state = h.repository.read();
    assert.equal(state.jobs.find(j => j.id === jobId).providerResult, undefined);
    assert.equal(state.cards.length, 0);
  } finally { h.repository.close(); }
});

test('market evidence follows a real imported product through Card adoption, config and generation prompt',async()=>{
  const h=await imported({product:'Owala FreeSip Twist Water Bottle',claim:'Our confirmed product focus',category:'hydration'});
  try{
    const snapshot=h.core.state().snapshots[0];
    h.command('snapshot.confirm',h.created.campaignId,{product:'Owala FreeSip Twist Water Bottle',claim:'Our confirmed product focus',importImageIds:[snapshot.productImport.images[0].id]});
    h.command('discovery.start',h.created.campaignId);h.core.tick();h.core.tick();
    const sourceUrl='https://www.facebook.com/ads/library/?id=100';
    h.core.tick({discovery:{provider:'test',coverage:{liveMetaAds:1},sources:[{sourceUrl,sourceType:'meta_ad_library',status:'available'}],evidence:[{sourceUrl,sourceType:'meta_ad_library',attributes:{bodyText:'Owala water bottle to carry on your commute.',adId:'100',advertiserName:'Owala'}}]}});
    h.command('cards.generate',h.created.campaignId);for(let i=0;i<5;i++)await h.runner.tick();
    const card=h.core.state().cardViews[0];assert.equal(card.advertisingPlan.name,'随身与出行');
    assert.deepEqual(h.core.state().cardEvidence.filter(e=>e.cardId===card.id).map(e=>e.evidenceId),card.advertisingPlan.marketBasis.evidenceIds);
    const adopted=h.command('card.adopt',card.id),configResult=h.command('config.create',adopted.packageId,{angleId:adopted.angleIds[0],ratio:'9:16',duration:15,brandAssetIds:card.productDossier.materials.map(m=>m.id)});
    const config=h.repository.read().configs.find(c=>c.id===configResult.configId);
    const p=productionPlan({config,product:'Owala'});p.productTreatment='local_product_overlay';
    assert.match(buildKeyframePrompt({production:p},config,p.shots[0]),/玄关/);
    assert.equal(config.marketBrief.samples[0].sourceUrl,sourceUrl);
    const old=JSON.stringify(h.core.state().cardViews.find(c=>c.id===card.id).advertisingPlan);
    h.command('brief.update',h.created.campaignId,{product:'Another product',objective:'Another test'});
    assert.equal(JSON.stringify(h.core.state().cardViews.find(c=>c.id===card.id).advertisingPlan),old);
  }finally{h.repository.close();}
});
