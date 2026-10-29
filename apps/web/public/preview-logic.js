const now = () => new Date().toISOString();

function find(data, collection, id, message) {
  const item = data[collection]?.find(entry => entry.id === id);
  if (!item) throw new Error(message);
  return item;
}

export function createBriefVersion(data, campaignId, fields) {
  const campaign = find(data, 'campaigns', campaignId, 'Campaign 不存在。');
  if (campaign.archived) throw new Error('已归档 Campaign 不能修改本轮意图。');
  const previous = find(data, 'briefs', campaign.briefId, '本轮意图不存在。');
  const version = Math.max(0, ...data.briefs.filter(item => item.campaignId === campaignId).map(item => item.version || 0)) + 1;
  const next = {
    ...previous,
    id: `${campaignId}-brief-${version}`,
    version,
    createdAt: now()
  };
  for (const key of ['objective', 'product', 'audience', 'channel', 'style', 'limitations', 'focusSignals']) {
    if (fields[key] !== undefined) next[key] = fields[key];
  }
  data.briefs.push(next);
  campaign.briefId = next.id;
  campaign.updatedAt = next.createdAt;
  return next;
}

export function createBrandVersion(data, brandId, fields) {
  const brand = find(data, 'brands', brandId, '品牌不存在。');
  const facts = { ...brand.facts };
  for (const key of ['product', 'claim', 'audience', 'competitors', 'market', 'limitations']) {
    if (fields[key] !== undefined) facts[key] = fields[key];
  }
  brand.name = fields.name ?? brand.name;
  brand.facts = facts;
  brand.version = (brand.version || 0) + 1;
  brand.updatedAt = now();
  return brand;
}

export function createPlanVersion(data, campaignId, fields) {
  const campaign = find(data, 'campaigns', campaignId, 'Campaign 不存在。');
  if (campaign.archived) throw new Error('已归档 Campaign 不能保存新的投放计划。');
  const assetIds = fields.assetIds?.length ? [...new Set(fields.assetIds)] : fields.assetId ? [fields.assetId] : [];
  if (!assetIds.length) throw new Error('请至少选择一份准备投放的视频。');
  const assets = assetIds.map(id => find(data, 'assets', id, '所选视频不存在。'));
  if (assets.some(asset => asset.campaignId !== campaignId || asset.type !== 'video' || asset.status !== 'launch_ready')) {
    throw new Error('投放计划只能使用当前 Campaign 中已审核的视频。');
  }
  const baseline = assets[0];
  if (assets.some(asset => asset.cardId !== baseline.cardId || asset.cardVersion !== baseline.cardVersion)) {
    throw new Error('同一投放计划中的素材必须来自同一个 Card 版本。');
  }
  const version = Math.max(0, ...data.plans.filter(item => item.campaignId === campaignId).map(item => item.version || 0)) + 1;
  const plan = {
    id: `${campaignId}-plan-${version}`,
    campaignId,
    cardId: baseline.cardId,
    cardVersion: baseline.cardVersion,
    assetIds,
    version,
    status: 'prepared',
    createdAt: now()
  };
  for (const key of ['channel', 'goal', 'audience', 'hypothesis', 'budget', 'period', 'metric']) {
    if (fields[key] !== undefined) plan[key] = fields[key];
  }
  data.plans.push(plan);
  return plan;
}

export function requireGenerationContext(data, configId, angleId, mode) {
  if (!['storyboard', 'video'].includes(mode)) throw new Error('不支持的生成任务类型。');
  const config = find(data, 'configs', configId, '生成配置不存在，请先保存配置。');
  const pack = find(data, 'packages', config.packageId, '创意测试包不存在。');
  const campaign = find(data, 'campaigns', pack.campaignId, 'Campaign 不存在。');
  if (campaign.archived) throw new Error('已归档 Campaign 不能创建新素材。');
  const card = find(data, 'cards', pack.cardId, '来源 Campaign Card 不存在。');
  if (card.status !== 'adopted') throw new Error('只有已采纳的 Campaign Card 可以进入创作。');
  const angle = angleId
    ? find(data, 'angles', angleId, '创意角度不存在。')
    : data.angles.find(item => item.packageId === pack.id);
  if (!angle || angle.packageId !== pack.id) throw new Error('创意角度与当前测试包不匹配。');
  return { config, pack, campaign, card, angle };
}

export function isBrandRelevantMetaSample(signal, brand) {
  if (signal?.sourceType !== 'meta_ad_library') return false;
  const normalize = value => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const brandName = normalize(brand?.name);
  const advertiser = normalize(signal.attributes?.advertiserName);
  const advertiserMatches = Boolean(brandName && (advertiser === brandName || advertiser.startsWith(`${brandName} `)));
  let brandHost = '';
  try { brandHost = new URL(brand?.websiteUrl).hostname.toLowerCase().replace(/^www\./, ''); } catch { /* Invalid brand URLs cannot qualify a landing domain. */ }
  const landingHost = String(signal.attributes?.landingDomain || '').toLowerCase().replace(/^www\./, '').split(':')[0];
  const landingMatches = Boolean(brandHost && (landingHost === brandHost || landingHost.endsWith(`.${brandHost}`)));
  return advertiserMatches || landingMatches;
}

export function markAssetLaunchReady(data, assetId) {
  const asset = find(data, 'assets', assetId, '素材不存在。');
  const campaign = find(data, 'campaigns', asset.campaignId, 'Campaign 不存在。');
  if (campaign.archived) throw new Error('已归档 Campaign 不能修改素材状态。');
  if (asset.type !== 'video') throw new Error('分镜预览不能标记为可投放视频。');
  if (asset.status !== 'ready') throw new Error('只有生成完成并可预览的视频才能标记为准备投放。');
  asset.status = 'launch_ready';
  campaign.status = 'launch_ready';
  campaign.updatedAt = now();
  return asset;
}

export function cancelPreviewJob(data, jobId) {
  const job = find(data, 'jobs', jobId, '任务不存在。');
  if (!['queued', 'running'].includes(job.status)) throw new Error('当前任务不能取消。');
  job.status = 'cancelled';
  for (const step of job.steps) if (step.status !== 'succeeded') step.status = 'cancelled';
  const asset = job.assetId && data.assets.find(item => item.id === job.assetId);
  if (asset?.status === 'generating') asset.status = 'cancelled';
  return job;
}

export function completePreviewVideo(data, jobId, assetId) {
  const job = data.jobs.find(item => item.id === jobId);
  const asset = data.assets.find(item => item.id === assetId);
  if (!job || !asset || !['queued', 'running'].includes(job.status) || asset.status !== 'generating') return false;
  asset.status = 'ready';
  job.status = 'succeeded';
  for (const step of job.steps) step.status = 'succeeded';
  return true;
}

export function distinctValues(values) {
  return [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

export function recoverCampaignRoute(route, campaigns) {
  const match = /^\/campaigns\/([^/]+)\/(discover|cards|create|launch|learn)(?:\/[^/?]+)?(?:\?.*)?$/.exec(route);
  if (!match || campaigns.some(campaign => campaign.id === match[1])) return { route, recovered: false };
  const active = campaigns.filter(campaign => !campaign.archived)
    .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0));
  if (active.length !== 1) return { route: '/home', recovered: true, target: null };
  const campaign = active[0];
  const stage = ({ draft: 'discover', discovering: 'discover', cards_ready: 'cards', creating: 'create', launch_ready: 'launch', learning: 'learn', closed: 'learn' })[campaign.status] || 'discover';
  return { route: `/campaigns/${campaign.id}/${stage}`, recovered: true, target: campaign };
}
