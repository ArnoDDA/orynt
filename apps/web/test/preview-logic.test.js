import test from 'node:test';
import assert from 'node:assert/strict';
import { addDiscoveryExample, createExamples, refreshCardExamples } from '../public/preview-data.js';
import { isBrandRelevantMetaSample } from '../public/preview-logic.js';
import { cancelPreviewJob, completePreviewVideo, createBriefVersion, createPlanVersion, distinctValues, markAssetLaunchReady, recoverCampaignRoute, requireGenerationContext } from '../public/preview-logic.js';

test('re-analysis creates a new Discovery version linked to the latest Brief', () => {
  const data = createExamples();
  const campaign = data.campaigns.find(item => item.id === 'morning');
  const brief = createBriefVersion(data, campaign.id, { objective: '验证新的目标' });
  const discovery = addDiscoveryExample(data, campaign, { forceNew: true });

  assert.equal(discovery.version, 2);
  assert.equal(discovery.briefId, brief.id);
  assert.equal(data.discoveries.filter(item => item.campaignId === campaign.id).length, 2);

  const cards = refreshCardExamples(data, campaign);
  assert.ok(cards.every(card => card.discoveryId === discovery.id && card.briefId === brief.id));
});

test('Brief changes append a version and keep the prior record immutable', () => {
  const data = createExamples();
  const campaign = data.campaigns.find(item => item.id === 'morning');
  const previous = data.briefs.find(item => item.id === campaign.briefId);
  const originalObjective = previous.objective;
  const next = createBriefVersion(data, campaign.id, { objective: '新的测试目标' });

  assert.equal(previous.objective, originalObjective);
  assert.equal(next.version, previous.version + 1);
  assert.equal(campaign.briefId, next.id);
});

test('saving a Launch Plan appends a version and preserves its history', () => {
  const data = createExamples();
  const campaign = data.campaigns.find(item => item.id === 'weekend');
  const previous = data.plans.find(item => item.campaignId === campaign.id);
  const originalBudget = previous.budget;
  const next = createPlanVersion(data, campaign.id, { ...previous, budget: 'USD 600–800' });

  assert.equal(previous.budget, originalBudget);
  assert.notEqual(next.id, previous.id);
  assert.equal(next.version, previous.version + 1);
  assert.equal(next.budget, 'USD 600–800');
  assert.equal(data.plans.filter(item => item.campaignId === campaign.id).length, 2);
});

test('a cancelled video job cannot later complete through its timer', () => {
  const data = createExamples();
  const asset = { id: 'video-race', campaignId: 'details', type: 'video', status: 'generating' };
  const job = { id: 'job-race', campaignId: 'details', type: 'video', assetId: asset.id, status: 'running', steps: [{ status: 'succeeded' }, { status: 'running' }, { status: 'queued' }] };
  data.assets.push(asset);
  data.jobs.push(job);

  cancelPreviewJob(data, job.id);

  assert.equal(completePreviewVideo(data, job.id, asset.id), false);
  assert.equal(job.status, 'cancelled');
  assert.equal(asset.status, 'cancelled');
});

test('launch readiness requires a completed video', () => {
  const data = createExamples();
  const campaign = data.campaigns.find(item => item.id === 'details');
  const asset = { id: 'video-guard', campaignId: campaign.id, type: 'video', status: 'generating' };
  data.assets.push(asset);

  assert.throws(() => markAssetLaunchReady(data, asset.id), /生成完成/);
  asset.status = 'ready';
  markAssetLaunchReady(data, asset.id);
  assert.equal(asset.status, 'launch_ready');
  assert.equal(campaign.status, 'launch_ready');
});

test('generation rejects an angle from another Creative Package', () => {
  const data = createExamples();
  const detailsPackage = data.packages.find(item => item.campaignId === 'details');
  const weekendPackage = data.packages.find(item => item.campaignId === 'weekend');
  const config = data.configs.find(item => item.packageId === detailsPackage.id);
  const wrongAngle = data.angles.find(item => item.packageId === weekendPackage.id);

  assert.throws(() => requireGenerationContext(data, config.id, wrongAngle.id, 'video'), /不匹配/);
});

test('stale Campaign links recover only when there is one active Campaign', () => {
  const campaign = { id: 'current', name: 'Current', status: 'creating', archived: false, updatedAt: '2026-09-20' };
  assert.deepEqual(recoverCampaignRoute('/campaigns/deleted/create?cardId=old', [campaign]), {
    route: '/campaigns/current/create', recovered: true, target: campaign
  });
  assert.equal(recoverCampaignRoute('/campaigns/deleted/create', [campaign, { ...campaign, id: 'second' }]).route, '/home');
  assert.equal(recoverCampaignRoute('/campaigns/current/create', [campaign]).recovered, false);
});

test('library filter values are derived from current data and deduplicated', () => {
  assert.deepEqual(distinctValues(['Trail Blend', '', 'Trail Blend', 'Cold Brew']), ['Cold Brew', 'Trail Blend']);
});

test('brand sample filtering excludes ads that only mention the brand in their copy', () => {
  const brand = { name: 'Gymshark', websiteUrl: 'https://www.gymshark.com' };
  const sample = (advertiserName, landingDomain) => ({ sourceType: 'meta_ad_library', attributes: { advertiserName, landingDomain } });
  assert.equal(isBrandRelevantMetaSample(sample('Gymshark Women', 'www.gymshark.com'), brand), true);
  assert.equal(isBrandRelevantMetaSample(sample('Gymshark', 'ca.gymshark.com'), brand), true);
  assert.equal(isBrandRelevantMetaSample(sample('Shopify1Percent', 'instagram.com'), brand), false);
  assert.equal(isBrandRelevantMetaSample({ sourceType: 'brand_website', attributes: {} }, brand), false);
});
