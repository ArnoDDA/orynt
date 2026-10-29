import { randomUUID, createHash } from 'node:crypto';
import { CampaignLifecycleStatus, CampaignStage, advanceCampaignStage, isCampaignWritable, productCollections } from '../../../packages/domain/src/product-model.js';
import { defaultScenePlan, sceneTitles } from '../../../packages/domain/src/scene-script.js';
import { isValidShotDirection, normalizeShotDirection, hasShotDirection } from '../../../packages/domain/src/shot-direction.js';
import { executeProduction } from './production-commands.js';
import { normalizeProductDetails, planningContext, buildAdvertisingPlans, validateModelPlans } from '../../../packages/domain/src/product-planning.js';
import { buildMarketBrief } from '../../../packages/domain/src/market-planning.js';
import { maxProductImages, imageMetadata, importMedia } from '../../../packages/domain/src/product-materials.js';

const id = prefix => `${prefix}_${randomUUID()}`;
const now = () => new Date().toISOString();
const stageOrder = Object.values(CampaignStage);

export class DomainError extends Error {
  constructor(code, message, status = 422) { super(message); this.code = code; this.status = status; }
}

function requireValue(condition, code, message, status) {
  if (!condition) throw new DomainError(code, message, status);
}

function string(value, max = 2000) {
  requireValue(typeof value === 'string' && value.trim().length > 0 && value.length <= max, 'INVALID_INPUT', '请填写有效内容。');
  return value.trim();
}

const MAX_BRAND_ASSET_BYTES = 5 * 1024 * 1024;
const MAX_LOCAL_VIDEO_BYTES = 20 * 1024 * 1024;

function decodeBrandAsset(body) {
  requireValue(typeof body.base64 === 'string' && body.base64.length > 0 && body.base64.length < 7_100_000, 'ASSET_TOO_LARGE', '品牌图片上限为 5 MB。');
  const buffer = Buffer.from(body.base64, 'base64');
  const requestedMime = String(body.mime || '').toLowerCase();
  const isPng = buffer.length > 8 && buffer.subarray(0, 8).toString('hex') === '89504e470d0a1a0a';
  const isJpeg = buffer.length > 3 && buffer.subarray(0, 3).toString('hex') === 'ffd8ff';
  const isWebp = buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
  const svg = buffer.toString('utf8').trim();
  const isSvg = /^<\?xml\b[^>]*>\s*<svg\b|^<svg\b/i.test(svg)
    && !/<(?:script|foreignObject|iframe|object|embed)\b|\son\w+\s*=|(?:href|src)\s*=\s*["']\s*(?:https?:|\/\/|javascript:)/i.test(svg);
  requireValue(buffer.length <= MAX_BRAND_ASSET_BYTES, 'ASSET_TOO_LARGE', '品牌图片上限为 5 MB。');
  requireValue(isPng || isJpeg || isWebp || isSvg, 'INVALID_ASSET', '请上传有效的 PNG、JPG、WebP 或安全 SVG 图片。');
  const mime = isPng ? 'image/png' : isJpeg ? 'image/jpeg' : isWebp ? 'image/webp' : 'image/svg+xml';
  requireValue(!requestedMime || requestedMime === mime || (mime === 'image/jpeg' && requestedMime === 'image/jpg'), 'INVALID_ASSET', '文件内容与图片格式不一致。');
  return { buffer, mime, format: mime === 'image/png' ? 'PNG' : mime === 'image/jpeg' ? 'JPG' : mime === 'image/webp' ? 'WebP' : 'SVG' };
}

function decodeLocalVideo(body) {
  requireValue(typeof body.base64 === 'string' && body.base64.length > 0 && body.base64.length < 28_000_000, 'ASSET_TOO_LARGE', '本地视频文件上限为 20 MB。');
  const buffer = Buffer.from(body.base64, 'base64');
  const isMp4 = buffer.length > 16 && buffer.toString('ascii', 4, 8) === 'ftyp';
  const isWebm = buffer.length > 16 && buffer.subarray(0, 4).toString('hex') === '1a45dfa3';
  requireValue(buffer.length <= MAX_LOCAL_VIDEO_BYTES && (isMp4 || isWebm), 'INVALID_VIDEO', '请上传有效的 MP4 或 WebM 视频。');
  return { buffer, mime: isMp4 ? 'video/mp4' : 'video/webm' };
}

function referenceAttributes(candidate) {
  const attributes = { ...(candidate.attributes || {}) };
  delete attributes.mediaCandidates;
  if (!Array.isArray(attributes.media)) return attributes;
  const real = !attributes.demo && candidate.sourceType === 'meta_ad_library' && /^https:\/\/www\.facebook\.com\/ads\/library\//.test(candidate.sourceUrl || '');
  attributes.media = real ? attributes.media.slice(0,2).flatMap(media => {
    const kind = media.kind === 'video_poster' ? 'video_poster' : 'image';
    let url; try { url = new URL(media.sourceUrl); } catch { return []; }
    if (url.protocol !== 'https:' || url.username || url.password) return [];
    const result = {kind, sourceUrl:url.href, status:'unavailable', reason:media.reason || 'DOWNLOAD_FAILED'};
    if (media.status !== 'available') return [result];
    try {
      const {buffer,mime} = decodeBrandAsset(media);
      if (mime === 'image/svg+xml' || buffer.length > 1_500_000) return [result];
      const sha256 = createHash('sha256').update(buffer).digest('hex');
      if (sha256 !== media.sha256) return [result];
      return [{kind,sourceUrl:url.href,status:'available',mime,sha256,bytes:buffer.length,base64:buffer.toString('base64')}];
    } catch { return [result]; }
  }) : [];
  attributes.mediaStatus = attributes.media.some(m => m.status === 'available') ? 'available' : attributes.media.length ? 'unavailable' : 'not_found';
  return attributes;
}

function get(s, collection, resourceId) {
  const item = s[collection].find(entry => entry.id === resourceId && entry.workspaceId === s.workspace.id);
  requireValue(item, 'NOT_FOUND', '对象不存在或不在当前工作空间。', 404);
  return item;
}

function object(s, prefix, data) {
  return { id: id(prefix), workspaceId: s.workspace.id, createdAt: now(), ...data };
}

function audit(s, action, resourceId, before = null, after = null) {
  s.audit.push(object(s, 'event', { actor: 'local_owner', action, resourceId, before, after }));
}

function requireWritableCampaign(campaign) {
  requireValue(isCampaignWritable(campaign), 'CAMPAIGN_CLOSED', '已归档 Campaign 只读。', 409);
}

function currentCardVersion(s, card) {
  return get(s, 'cardVersions', card.adoptedVersionId || card.currentVersionId);
}

const jobSteps = {
  reference_media: ['save_reference_images'],
  product_import: ['read_product_page', 'save_product_candidates'],
  production: ['prepare_shots', 'generate_first_shot', 'review_first_shot', 'generate_remaining_shots', 'assemble_video', 'publish_asset'],
  discovery: ['prepare_brand_context', 'check_source_coverage', 'publish_discovery'],
  cards: ['freeze_inputs', 'prepare_candidates', 'validate_and_publish'],
  template_analysis: ['validate_local_video', 'detect_scenes', 'publish_template'],
  storyboard: ['validate_card_and_config', 'prepare_storyboard', 'save_preview'],
  video: ['validate_card_and_config', 'submit_provider_job', 'wait_for_provider', 'download_result', 'publish_asset']
};

function queue(s, campaignId, type, input, resource = { type: 'campaign', id: campaignId }) {
  const createdAt = now();
  const job = object(s, 'job', {
    campaignId, type, resource, input: structuredClone(input), status: 'queued',
    steps: jobSteps[type].map((key, index) => ({ key, position: index + 1, status: 'queued', attempts: 0, maxAttempts: 3 })),
    attemptId: id('attempt'), createdAt, updatedAt: createdAt,
    resumePath: `/campaigns/${campaignId}/${type === 'reference_media' ? 'discover?view=opportunities' : type === 'product_import' ? 'discover?view=setup' : type === 'discovery' ? 'discover' : type === 'cards' ? 'cards' : 'create'}`
  });
  s.jobs.push(job);
  audit(s, 'job_created', job.id);
  return job;
}

function activeJob(s, campaignId, types) {
  return s.jobs.some(job => job.campaignId === campaignId && types.includes(job.type) && ['queued', 'running'].includes(job.status));
}

function campaignContext(s, campaign) {
  const activeJobs = s.jobs.filter(job => job.campaignId === campaign.id && ['queued', 'running'].includes(job.status));
  const blockers = [];
  const snapshot = s.snapshots.find(item => item.id === campaign.brandSnapshotId);
  const hasDiscovery = s.discoveries.some(item => item.campaignId === campaign.id && item.briefId === campaign.briefId && ['partial_ready', 'ready'].includes(item.status));
  const hasPackage = s.packages.some(item => item.campaignId === campaign.id);
  const hasLaunchAsset = s.assets.some(item => item.campaignId === campaign.id && item.type === 'video' && item.status === 'launch_ready');
  const hasPlan = s.plans.some(item => item.campaignId === campaign.id);
  const brandReady = snapshot?.confirmation !== 'pending';
  const access = { discover: true, cards: brandReady && hasDiscovery, create: hasPackage, launch: hasLaunchAsset, learn: hasPlan || campaign.stage === CampaignStage.LEARNING || campaign.stage === CampaignStage.CLOSED };
  if (campaign.status === CampaignLifecycleStatus.ARCHIVED) blockers.push({ code: 'CAMPAIGN_ARCHIVED' });
  else if (snapshot?.confirmation === 'pending') blockers.push({ code: 'BRAND_CONFIRMATION_REQUIRED' });
  else if (!hasDiscovery) blockers.push({ code: 'DISCOVERY_REQUIRED' });
  else if (!hasPackage) blockers.push({ code: 'CARD_ADOPTION_REQUIRED' });
  else if (!hasLaunchAsset) blockers.push({ code: 'LAUNCH_READY_ASSET_REQUIRED' });
  else if (!hasPlan) blockers.push({ code: 'LAUNCH_PLAN_REQUIRED' });
  const index = stageOrder.indexOf(campaign.stage);
  const nextAction = campaign.status === CampaignLifecycleStatus.ARCHIVED ? ['查看历史记录', `/campaigns/${campaign.id}/learn`]
    : snapshot?.confirmation === 'pending' ? ['确认品牌与本轮意图', `/campaigns/${campaign.id}/discover`]
      : !hasDiscovery ? ['开始 Discovery', `/campaigns/${campaign.id}/discover`]
        : !s.cards.some(item => item.campaignId === campaign.id) ? ['生成 Campaign Cards', `/campaigns/${campaign.id}/cards`]
          : !hasPackage ? ['采纳一张 Campaign Card', `/campaigns/${campaign.id}/cards`]
            : !hasLaunchAsset ? ['完成首批创意素材', `/campaigns/${campaign.id}/create`]
              : !hasPlan ? ['准备投放计划', `/campaigns/${campaign.id}/launch`]
                : ['查看学习边界', `/campaigns/${campaign.id}/learn`];
  return {
    campaignId: campaign.id,
    stage: {
      current: campaign.stage,
      completed: stageOrder.slice(0, Math.max(0, index)),
      locked: Object.entries(access).filter(([, allowed]) => !allowed).map(([name]) => name),
      blockers,
      nextAction: { label: nextAction[0], href: nextAction[1] }
    },
    activeJobs: activeJobs.map(job => ({ id: job.id, type: job.type, status: job.status, resumePath: job.resumePath }))
  };
}

function testDirections(product) {
  const common = { constant: '同一产品、受众、优惠、片长与行动引导。', successSignal: '优先看前 3 秒留存，其次看点击率。' };
  if (/咖啡|coffee|espresso/i.test(product)) return [
    { ...common, title: '冲煮场景开场 vs 产品静态开场', hypothesis: `先展示一杯咖啡的冲煮画面，是否比先展示${product}的静态包装，更能让用户代入饮用场景？`, control: 'A 基准版：以包装静态画面开场，再展示冲煮过程。', variant: 'B 测试版：以咖啡注入杯中的动态画面开场，再展示包装。', hook: '第一秒展示咖啡注入杯中的动态画面', proof: '从咖啡豆、冲煮到杯中咖啡，让产品与日常饮用场景连起来', style: '晨间场景实拍' },
    { ...common, title: '咖啡细节特写 vs 完整包装展示', hypothesis: `先看咖啡豆、研磨与冲煮细节，是否比先看包装，更容易引起用户对${product}的兴趣？`, control: 'A 基准版：先看完整包装，再补充产品细节。', variant: 'B 测试版：先看咖啡豆与研磨颗粒特写，再回到包装。', hook: '以咖啡豆与研磨颗粒的特写开场', proof: '用柔和光线拍摄豆子、冲煮细节与包装，不添加未经确认的产地或功效', style: '产品细节实拍' },
    { ...common, title: '完整冲煮过程 vs 商品信息介绍', hypothesis: `展示从准备到完成一杯咖啡的过程，是否比商品信息介绍更能让用户想尝试${product}？`, control: 'A 基准版：依次介绍包装与产品信息。', variant: 'B 测试版：把准备咖啡豆、冲煮、端起杯子的过程连起来。', hook: '从打开咖啡袋、准备冲煮的动作开始', proof: '连续展示准备、冲煮与端起咖啡杯的三个片段', style: '日常使用过程', successSignal: '优先看视频完播率，其次看点击率。' }
  ];
  if (!/无缝|运动服|健身|训练服|legging|seamless|gymshark|activewear/i.test(product)) return [
    { ...common, title: '实际使用开场 vs 产品静态开场', hypothesis: `先展示${product}被实际使用的画面，是否比静态展示更快让用户理解产品用途？`, control: 'A 基准版：产品静态画面开场，再介绍用途。', variant: 'B 测试版：先展示一个具体使用动作，再回到产品。', hook: `第一秒展示${product}的一个具体使用动作`, proof: '以中景展示使用过程，再用近景呈现关键细节', style: '使用场景演示' },
    { ...common, title: '产品细节特写 vs 通用产品介绍', hypothesis: `放大${product}的一个关键细节，是否比通用介绍更容易让人记住产品？`, control: 'A 基准版：先看完整产品，再补充细节。', variant: 'B 测试版：先看一个实际细节，再回到完整产品。', hook: '一个产品细节的近景特写开场', proof: '通过细节与整体镜头交替，把已确认的卖点展示清楚', style: '产品细节展示' },
    { ...common, title: '完整使用过程 vs 商品信息介绍', hypothesis: `让用户看到${product}从准备到使用的完整过程，是否比信息列表更能引起兴趣？`, control: 'A 基准版：产品信息逐条展示。', variant: 'B 测试版：连续展示准备、使用与收尾。', hook: '从用户准备使用产品的动作开始', proof: '展示一个有开头、有过程、有收尾的实际使用情境', style: '日常使用过程', successSignal: '优先看视频完播率，其次看点击率。' }
  ];
  return [
    {
      title: '训练场景开场 vs 产品静态开场',
      hypothesis: `先展示真实训练动作，是否比先展示${product}静态画面，更快让用户理解产品适合什么场景？`,
      control: 'A 基准版：产品静态画面开场，再介绍版型与颜色。',
      variant: `B 测试版：深蹲或拉伸动作开场，再展示${product}。`,
      constant: '同一产品、模特、优惠、片长和行动按钮。',
      successSignal: '优先看前 3 秒留存，其次看点击率。',
      hook: '第一秒展示深蹲或拉伸动作', proof: '连续展示不同训练动作下的实际穿着状态', style: '训练场景实拍'
    },
    {
      title: '无缝细节特写 vs 全身造型展示',
      hypothesis: `先看无缝结构和面料细节，是否比先看全身造型，更容易让用户理解${product}的具体差异？`,
      control: 'A 基准版：先展示模特全身造型，再补充产品信息。',
      variant: 'B 测试版：先展示腰头、面料纹理和无缝结构，再回到全身造型。',
      constant: '同一模特、动作、文案、优惠、片长和行动按钮。',
      successSignal: '优先看前 3 秒留存，其次看点击率。',
      hook: '第一秒展示腰头、纹理或无缝结构', proof: '用近景和动作镜头把产品细节呈现清楚', style: '产品细节实拍'
    },
    {
      title: '完整穿着过程 vs 商品列表',
      hypothesis: `展示从穿上到完成训练的连续过程，是否比商品列表式介绍更能让用户代入${product}的使用体验？`,
      control: 'A 基准版：商品组合、价格和购买信息依次出现。',
      variant: 'B 测试版：穿上产品、热身、训练和结束四个连续片段。',
      constant: '同一产品组合、优惠、片长、音乐和行动按钮。',
      successSignal: '优先看视频完播率，其次看点击率。',
      hook: '由穿上产品的动作开始', proof: '用热身、训练和结束组成完整使用过程', style: '真人体验实拍'
    }
  ];
}

function effectiveLimitations(discovery) {
  return (discovery.limitations || []).filter(text => !(discovery.coverage?.liveMetaAds > 0 && /仅覆盖品牌自有官网/.test(text)));
}

function opportunityCandidates(state, discovery) {
  const campaign = state.campaigns.find(item => item.id === discovery.campaignId);
  const brief = state.briefs.find(item => item.id === discovery.briefId);
  const snapshot = state.snapshots.find(item => item.id === discovery.snapshotId);
  const brand = state.brands.find(item => item.id === campaign?.brandId);
  if (!campaign || !brief || !snapshot || !brand) return [];
  const evidence = state.evidence.filter(item => item.discoveryId === discovery.id);
  const sources = new Map(state.discoverySources.filter(item => item.discoveryId === discovery.id).map(item => [item.id, item]));
  const available = item => sources.get(item.discoverySourceId)?.status === 'available';
  const keywords = [brief.product, snapshot.facts?.product, brand.name]
    .filter(value => typeof value === 'string' && value.trim().length >= 4)
    .map(value => value.trim().toLowerCase());
  const relevant = item => keywords.some(keyword =>
    [item.title, item.contentSummary, item.attributes?.advertiserName].some(value => String(value || '').toLowerCase().includes(keyword)));
  const productTerms = [...new Set([brief.product, snapshot.facts?.product]
    .flatMap(value => String(value || '').toLowerCase().match(/[a-z0-9]{4,}/g) || []))];
  const sampleScore = item => {
    const body = String(item.attributes?.bodyText || item.contentSummary || '').toLowerCase();
    const productMatches = productTerms.filter(term => body.includes(term)).length;
    const usefulCopy = body && !/\{\{[^}]+\}\}/.test(body) ? 1 : 0;
    return productMatches * 10 + usefulCopy;
  };
  const website = evidence.find(item => {
    if (item.sourceType !== 'brand_website' || !available(item)) return false;
    try {
      const url = new URL(item.sourceUrl);
      return url.origin === brand.websiteUrl && !url.pathname.endsWith('.xml');
    } catch { return false; }
  });
  const meta = evidence
    .filter(item => String(item.sourceType).startsWith('meta_') && available(item) && relevant(item))
    .toSorted((a, b) => sampleScore(b) - sampleScore(a));
  const selected = [website, meta[0], meta[1]];
  const product = brief.product || snapshot.facts?.product || '当前产品';
  const dossier = snapshot.productImport ? planningContext(state, snapshot, brief) : null;
  const marketBrief = dossier ? buildMarketBrief(state, discovery, dossier) : null;
  const directions = dossier ? buildAdvertisingPlans(dossier, marketBrief) : testDirections(product);
  return directions.map((direction, index) => {
    const citedIds = direction.marketBasis?.evidenceIds || [];
    const cited = citedIds.map(id => evidence.find(e => e.id === id)).filter(Boolean);
    const item = dossier ? cited[0] || (index === 0 ? website : null) : selected[index];
    const basis = !dossier && index === 0 ? 'brand_context' : item ? String(item.sourceType).startsWith('meta_') ? 'public_sample' : 'brand_context' : 'unverified';
    const adCopy = String(item?.attributes?.bodyText || item?.title || '').trim();
    const summary = dossier
      ? `本条广告围绕“${direction.focus.value}”，采用${direction.route.label}。这是基于产品资料的创意草案，公开样本不证明该方案有效。`
      : index === 0
      ? `为什么值得测：品牌已确认核心受众是“${brief.audience || snapshot.facts?.audience || '待确认受众'}”，但还不知道先展示实际使用场景，是否更容易理解产品用途。`
      : item
        ? `为什么值得测：真实 Meta 样本中，${item.attributes?.advertiserName || brand.name} 使用了“${adCopy.slice(0, 120)}”的表达；本轮只验证这种表达方式是否适合当前产品。`
        : '为什么值得测：当前没有直接匹配的公开样本，这是一项需要从零验证的创意假设。';
    return {
      id: `${discovery.id}:opportunity:${index + 1}`, title: direction.title, summary, hypothesis: direction.hypothesis,
      testQuestion: direction.hypothesis, control: direction.control, variant: direction.variant,
      constant: direction.constant, successSignal: direction.successSignal,
      hook: direction.hook, proof: direction.proof, style: direction.style,
      ...(dossier ? { advertisingPlan: direction, productDossier: dossier, marketBrief } : {}),
      audience: direction.audience || brief.audience || snapshot.facts?.audience || '待确认受众',
      basis, evidenceIds: cited.length ? cited.map(e => e.id) : item ? [item.id] : [],
      signalIds: item ? state.signals.filter(signal => signal.discoveryId === discovery.id && signal.evidenceIds?.some(id => (citedIds.length ? citedIds : [item.id]).includes(id))).map(signal => signal.id) : [],
      observedFormat: basis === 'public_sample' ? item.attributes?.displayFormat || null : null,
      evidenceSummary: item ? String(item.attributes?.bodyText && !/\{\{[^}]+\}\}/.test(item.attributes.bodyText) ? item.attributes.bodyText : item.contentSummary || item.title || '').slice(0, 600) : null,
      relevanceMethod: item ? (basis === 'brand_context' ? 'same_origin_brand_source' : 'available_source_and_keyword_match') : 'no_matching_evidence'
    };
  });
}

function evidenceKey(candidate) {
  return candidate.contentHash ? `hash:${candidate.contentHash}` : `source:${candidate.sourceType || 'unknown'}:${candidate.sourceUrl || ''}`;
}

function signalType(evidence) {
  if (String(evidence.sourceType).startsWith('meta_')) return '竞品动作';
  if (evidence.attributes?.displayFormat) return '热门创意';
  return '品牌事实';
}

function evidenceLabel(evidence) {
  const format = evidence.attributes?.displayFormat;
  return format ? `${evidence.title || '公开广告素材'} · ${format}` : evidence.title || '公开来源观察';
}

export class Core {
  constructor(repository, { walkthrough } = {}) { this.repo = repository; this.walkthrough = walkthrough; }

  state() {
    const state = this.repo.read();
    delete state.commands;
    for (const asset of state.assets) delete asset.base64;
    for (const asset of state.brandAssets) delete asset.base64;
    for (const evidence of state.evidence) for (const media of evidence.attributes?.media || []) delete media.base64;
    for (const snapshot of state.snapshots) for (const image of snapshot.productImport?.images || []) delete image.base64;
    for (const snapshot of state.snapshots) if (snapshot.productImport) {
      const brief = state.briefs.find(b => b.campaignId === snapshot.campaignId && b.status === 'current') || state.briefs.find(b => state.campaigns.some(c => c.brandSnapshotId === snapshot.id && c.briefId === b.id));
      snapshot.productDossier = planningContext(state, snapshot, brief || {});
    }
    for (const request of state.generationRequests) if (request.production) {
      if (request.production.productImage) delete request.production.productImage.base64;
      for (const shot of request.production.shots) for (const take of [shot, ...(shot.history || [])]) {
        delete take.base64; delete take.thumbnailBase64; delete take.backgroundBase64;
        if(take.keyframe)for(const frame of [take.keyframe,...(take.keyframe.history||[])]){delete frame.base64;if(frame.productPreview)delete frame.productPreview.base64;}
      }
    }
    for (const template of state.videoTemplates) {
      delete template.base64;
      for (const scene of template.scenes || []) delete scene.keyframeBase64;
    }
    state.discoveries = state.discoveries.map(discovery => ({
      ...discovery, limitations: effectiveLimitations(discovery),
      opportunities: opportunityCandidates(state, discovery)
    }));
    state.cardViews = state.cards.map(card => {
      const version = state.cardVersions.find(item => item.id === (card.adoptedVersionId || card.currentVersionId));
      return version ? { ...card, ...version.content, versionId: version.id, version: version.version, quality: version.quality } : card;
    });
    state.campaignContexts = state.campaigns.map(campaign => campaignContext(state, campaign));
    state.providers = { discovery: 'local_crawler', strategy: 'local_preview', video: process.env.YOUMIND_API_KEY ? 'youmind' : 'not_connected', meta: 'local_sample' };
    for (const job of state.jobs) if (job.providerResult) {
      if (job.providerResult.base64) delete job.providerResult.base64;
      for (const scene of job.providerResult.scenes || []) delete scene.keyframeBase64;
      for (const image of job.providerResult.images || []) delete image.base64;
      for (const evidence of job.providerResult.evidence || []) for (const media of evidence.media || evidence.attributes?.media || []) delete media.base64;
    }
    return state;
  }

  command(action, resourceId, body, key) {
    requireValue(typeof key === 'string' && key.length >= 8 && key.length <= 160, 'IDEMPOTENCY_REQUIRED', '写操作必须包含有效请求标识。');
    const hash = createHash('sha256').update(JSON.stringify({ action, resourceId, body })).digest('hex');
    return this.repo.transact(s => {
      const old = s.commands[key];
      if (old) {
        requireValue(old.hash === hash, 'IDEMPOTENCY_KEY_REUSED', '请求标识已用于其他内容。', 409);
        return old.result;
      }
      const result = this.execute(s, action, resourceId, body || {});
      s.commands[key] = { hash, result, createdAt: now() };
      return result;
    });
  }

  execute(s, action, resourceId, b) {
    const replayResult = this.walkthrough?.execute({ s, action, resourceId, b, get, requireValue, requireWritableCampaign, object, queue, audit });
    if (replayResult !== undefined) return replayResult;
    if (action === 'campaign.create' && b.mode === 'demo_replay') requireValue(this.walkthrough, 'DEMO_UNAVAILABLE', '演示适配器尚未就绪。', 409);
    if (action.startsWith('production.')) return executeProduction({ s, action, resourceId, b, get, requireValue, requireWritableCampaign, object, queue, audit });
    if (action === 'workspace.clear') {
      requireValue(b.confirm === 'CLEAR_LOCAL_WORKSPACE', 'CONFIRM_REQUIRED', '请输入本地工作空间清理确认值。', 409);
      for (const collection of productCollections) s[collection] = [];
      s.commands = {};
      s.workspace = { ...s.workspace, mode: 'local_guest', localOnly: true, retention: 'until_manual_clear', clearedAt: now() };
      audit(s, 'workspace_cleared', s.workspace.id);
      return { workspaceId: s.workspace.id, cleared: true };
    }

    if (action === 'campaign.create') {
      let url;
      try { url = new URL(b.brandUrl); } catch { throw new DomainError('INVALID_URL', '请输入完整的网站网址。'); }
      requireValue(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password, 'INVALID_URL', '仅支持不含登录信息的 HTTP 或 HTTPS 网址。');
      const websiteUrl = url.origin;
      if (b.brandId) {
        const selected = get(s, 'brands', b.brandId);
        requireValue(selected.websiteUrl === websiteUrl, 'BRAND_URL_MISMATCH', '所选品牌与官网地址不一致。', 409);
      }
      let brand = b.mode === 'demo_replay' ? null : s.brands.find(entry => entry.websiteUrl === websiteUrl && !entry.replayOnly);
      const existing = Boolean(brand);
      if (!brand) {
        brand = object(s, 'brand', { websiteUrl, name: b.mode === 'demo_replay' ? 'Owala' : url.hostname.replace(/^www\./, ''), facts: {}, memory: [], version: 1, status: 'active', ...(b.mode === 'demo_replay' ? { replayOnly: true } : {}) });
        s.brands.push(brand);
      }
      const snapshot = object(s, 'snapshot', {
        brandId: brand.id,
        version: Math.max(0, ...s.snapshots.filter(item => item.brandId === brand.id).map(item => item.version || 0)) + 1,
        facts: structuredClone(brand.facts), factMeta: {},
        assetIds: s.brandAssets.filter(asset => asset.brandId === brand.id).map(asset => asset.id),
        confirmation: 'pending', frozenAt: null
      });
      s.snapshots.push(snapshot);
      const campaign = object(s, 'campaign', {
        name: b.name ? string(b.name, 120) : `${brand.name} · 新一轮测试`,
        brandId: brand.id, brandSnapshotId: snapshot.id,
        productUrl: url.href,
        mode: ['guided_demo','demo_replay'].includes(b.mode) ? b.mode : 'standard',
        stage: CampaignStage.DRAFT, status: CampaignLifecycleStatus.ACTIVE,
        selectedCardVersionId: null, inheritedLearningId: b.inheritedLearningId || null, updatedAt: now()
      });
      s.campaigns.push(campaign);
      const brief = object(s, 'brief', {
        campaignId: campaign.id, version: 1,
        objective: b.objective ? string(b.objective) : '验证新的产品表达',
        product: String(b.product || '').slice(0, 2000), audience: String(b.audience || '').slice(0, 2000),
        channel: ['Meta', 'TikTok'].includes(b.channel) ? b.channel : 'Meta',
        focusSignals: Array.isArray(b.focusSignals) ? b.focusSignals.slice(0, 10) : [],
        style: String(b.style || '产品演示').slice(0, 100), limitations: String(b.limitations || '').slice(0, 2000), status: 'current'
      });
      s.briefs.push(brief);
      campaign.briefId = brief.id;
      if (campaign.mode === 'demo_replay') this.walkthrough.attach(campaign, snapshot, brief, requireValue);
      audit(s, 'campaign_created', campaign.id);
      if (b.importFromUrl === true && campaign.mode !== 'guided_demo') {
        const job = queue(s, campaign.id, 'product_import', { snapshotId: snapshot.id, url: campaign.productUrl });
        snapshot.productImport = { status: 'reading', jobId: job.id, sourceUrl: campaign.productUrl, fields: {}, images: [] };
        return { campaignId: campaign.id, briefId: brief.id, brandSnapshotId: snapshot.id, reusedBrand: existing, jobId: job.id };
      }
      return { campaignId: campaign.id, briefId: brief.id, brandSnapshotId: snapshot.id, reusedBrand: existing };
    }

    if (action === 'productImport.start' || action === 'productImport.skip') {
      const campaign = get(s, 'campaigns', resourceId);
      requireWritableCampaign(campaign);
      const snapshot = get(s, 'snapshots', campaign.brandSnapshotId);
      requireValue(!snapshot.frozenAt && snapshot.confirmation === 'pending', 'SNAPSHOT_FROZEN', '本轮产品资料已确认，不能重新导入。', 409);
      if (action === 'productImport.skip') {
        const job = s.jobs.find(item => item.id === snapshot.productImport?.jobId);
        if (job && ['queued', 'running'].includes(job.status)) { job.status = 'cancelled'; job.cancelledAt = now(); job.updatedAt = now(); for (const step of job.steps) if (step.status !== 'succeeded') step.status = 'cancelled'; }
        snapshot.productImport = { ...(snapshot.productImport || {}), status: 'skipped' };
        audit(s, 'product_import_skipped', campaign.id);
        return { campaignId: campaign.id };
      }
      const active = s.jobs.find(item => item.campaignId === campaign.id && item.type === 'product_import' && ['queued', 'running'].includes(item.status));
      if (active) return { jobId: active.id };
      if (b.productUrl) {
        const candidate = snapshot.productImport?.details?.candidates?.find(c => c.url === b.productUrl);
        let variant = false;
        try {
          const next = new URL(b.productUrl), previous = new URL(snapshot.productImport.sourceUrl);
          const expected = new URL(previous); expected.searchParams.set('variant', next.searchParams.get('variant'));
          variant = next.href === expected.href && snapshot.productImport.variants?.some(v => v.id === next.searchParams.get('variant'));
        } catch { /* Only an exact known variant URL is allowed. */ }
        requireValue((candidate && new URL(candidate.url).origin === new URL(campaign.productUrl).origin) || variant, 'INVALID_PRODUCT_CANDIDATE', '请选择本次网页提供的具体商品链接。');
        campaign.productUrl = variant ? b.productUrl : candidate.url;
      }
      const job = queue(s, campaign.id, 'product_import', { snapshotId: snapshot.id, url: campaign.productUrl });
      snapshot.productImport = { status: 'reading', jobId: job.id, sourceUrl: campaign.productUrl, fields: {}, images: [] };
      return { jobId: job.id };
    }

    if (action === 'brand.update') {
      const brand = get(s, 'brands', resourceId);
      const before = { name: brand.name, facts: structuredClone(brand.facts), version: brand.version };
      brand.name = string(b.name, 120);
      brand.facts = {
        ...brand.facts,
        product: String(b.product || '').slice(0, 2000), claim: String(b.claim || '').slice(0, 2000),
        audience: String(b.audience || '').slice(0, 2000), competitors: String(b.competitors || '').slice(0, 2000),
        market: String(b.market || '').slice(0, 2000), limitations: String(b.limitations || '').slice(0, 2000)
      };
      brand.version++;
      brand.updatedAt = now();
      for (const [fieldKey, value] of Object.entries(brand.facts)) {
        s.brandFacts.push(object(s, 'brand_fact', { brandId: brand.id, brandVersion: brand.version, fieldKey, value, sourceType: 'user_confirmed', confidence: 1, confirmedAt: now(), status: 'active' }));
      }
      audit(s, 'brand_updated', brand.id, before, { name: brand.name, facts: brand.facts, version: brand.version });
      return { brandId: brand.id, version: brand.version };
    }

    if (action === 'brand.reset') {
      requireValue(b.confirm === true, 'CONFIRM_REQUIRED', '请确认重置品牌记忆。');
      const brand = get(s, 'brands', resourceId);
      brand.memory = []; brand.facts = {}; brand.version++; brand.updatedAt = now();
      for (const fact of s.brandFacts.filter(item => item.brandId === brand.id && item.status === 'active')) fact.status = 'deleted';
      audit(s, 'brand_memory_reset', brand.id);
      return { brandId: brand.id, version: brand.version };
    }

    if (action === 'brand.remove-data') {
      const brand = get(s, 'brands', resourceId);
      requireValue(b.confirm === 'DELETE_BRAND_DATA', 'CONFIRM_REQUIRED', '请输入品牌数据删除确认值。', 409);
      const campaignIds = new Set(s.campaigns.filter(item => item.brandId === brand.id).map(item => item.id));
      const snapshotIds = new Set(s.snapshots.filter(item => item.brandId === brand.id).map(item => item.id));
      const briefIds = new Set(s.briefs.filter(item => campaignIds.has(item.campaignId)).map(item => item.id));
      const discoveryIds = new Set(s.discoveries.filter(item => campaignIds.has(item.campaignId)).map(item => item.id));
      const sourceIds = new Set(s.discoverySources.filter(item => discoveryIds.has(item.discoveryId)).map(item => item.id));
      const evidenceIds = new Set(s.evidence.filter(item => discoveryIds.has(item.discoveryId)).map(item => item.id));
      const batchIds = new Set(s.collectionBatches.filter(item => campaignIds.has(item.campaignId)).map(item => item.id));
      const cardSetIds = new Set(s.cardSets.filter(item => campaignIds.has(item.campaignId)).map(item => item.id));
      const cardIds = new Set(s.cards.filter(item => campaignIds.has(item.campaignId)).map(item => item.id));
      const cardVersionIds = new Set(s.cardVersions.filter(item => cardIds.has(item.cardId)).map(item => item.id));
      const packageIds = new Set(s.packages.filter(item => campaignIds.has(item.campaignId)).map(item => item.id));
      const angleIds = new Set(s.angles.filter(item => packageIds.has(item.packageId)).map(item => item.id));
      const configIds = new Set(s.configs.filter(item => packageIds.has(item.packageId) || campaignIds.has(item.campaignId)).map(item => item.id));
      const requestIds = new Set(s.generationRequests.filter(item => campaignIds.has(item.campaignId)).map(item => item.id));
      const assetIds = new Set(s.assets.filter(item => campaignIds.has(item.campaignId)).map(item => item.id));
      const jobIds = new Set(s.jobs.filter(item => campaignIds.has(item.campaignId)).map(item => item.id));
      const planIds = new Set(s.plans.filter(item => campaignIds.has(item.campaignId)).map(item => item.id));
      const ids = new Set([...campaignIds, ...snapshotIds, ...briefIds, ...discoveryIds, ...sourceIds, ...evidenceIds, ...batchIds, ...cardSetIds, ...cardIds, ...cardVersionIds, ...packageIds, ...angleIds, ...configIds, ...requestIds, ...assetIds, ...jobIds, ...planIds, brand.id]);
      const belongs = {
        brands: item => item.id === brand.id,
        brandFacts: item => item.brandId === brand.id,
        brandAssets: item => item.brandId === brand.id,
        snapshots: item => snapshotIds.has(item.id), campaigns: item => campaignIds.has(item.id), briefs: item => briefIds.has(item.id),
        discoveries: item => discoveryIds.has(item.id), discoverySources: item => sourceIds.has(item.id), signals: item => discoveryIds.has(item.discoveryId) || campaignIds.has(item.campaignId),
        evidence: item => evidenceIds.has(item.id), signalFeedback: item => item.signalId && s.signals.filter(signal => discoveryIds.has(signal.discoveryId)).some(signal => signal.id === item.signalId),
        collectionBatches: item => batchIds.has(item.id), cardSets: item => cardSetIds.has(item.id), cards: item => cardIds.has(item.id), cardVersions: item => cardVersionIds.has(item.id),
        cardEvidence: item => cardIds.has(item.cardId) || evidenceIds.has(item.evidenceId), packages: item => packageIds.has(item.id), angles: item => angleIds.has(item.id),
        videoTemplates: item => campaignIds.has(item.campaignId), configs: item => configIds.has(item.id),
        generationRequests: item => requestIds.has(item.id), assets: item => assetIds.has(item.id), jobs: item => jobIds.has(item.id), plans: item => planIds.has(item.id),
        mappings: item => planIds.has(item.planId) || assetIds.has(item.assetId), metricSnapshots: item => planIds.has(item.planId) || assetIds.has(item.assetId),
        conclusions: item => campaignIds.has(item.campaignId) || planIds.has(item.planId), feedback: item => cardIds.has(item.cardId), audit: item => ids.has(item.resourceId)
      };
      const deleted = {};
      for (const collection of productCollections) if (belongs[collection]) { const before = s[collection].length; s[collection] = s[collection].filter(item => !belongs[collection](item)); deleted[collection] = before - s[collection].length; }
      audit(s, 'brand_data_removed', brand.id, { brandId: brand.id, campaignCount: campaignIds.size }, deleted);
      return { brandId: brand.id, campaignCount: campaignIds.size, deleted };
    }

    if (action === 'brandAsset.add') {
      const brand = get(s, 'brands', resourceId);
      const name = string(b.name, 150);
      const { buffer, mime, format } = decodeBrandAsset(b);
      const type = b.type === 'logo' || /logo|标志/i.test(name) ? 'logo' : 'image';
      const promptHint = String(b.promptHint || (type === 'logo' ? `${brand.name} 的品牌标志` : `${brand.name} 的产品与包装视觉参考`)).trim().slice(0, 500);
      const asset = object(s, 'brand_asset', {
        brandId: brand.id, name, format, mime, type, promptHint,
        source: 'local_upload', status: 'ready', size: buffer.length,
        base64: buffer.toString('base64'), updatedAt: now()
      });
      s.brandAssets.push(asset);
      for (const snapshot of s.snapshots.filter(item => item.brandId === brand.id && !item.frozenAt)) {
        snapshot.assetIds ||= [];
        if (!snapshot.assetIds.includes(asset.id)) snapshot.assetIds.push(asset.id);
      }
      audit(s, 'brand_asset_added', asset.id);
      return { assetId: asset.id };
    }

    if (action === 'brandAsset.remove') {
      const asset = get(s, 'brandAssets', resourceId);
      requireValue(!s.snapshots.some(snapshot => snapshot.frozenAt && snapshot.assetIds?.includes(asset.id)) && !s.configs.some(config => config.brandAssetIds?.includes(asset.id)), 'ASSET_IN_USE', '素材已被历史快照或配置引用，不能删除记录。', 409);
      for (const snapshot of s.snapshots.filter(item => !item.frozenAt && item.assetIds?.includes(asset.id))) snapshot.assetIds = snapshot.assetIds.filter(id => id !== asset.id);
      s.brandAssets = s.brandAssets.filter(item => item.id !== asset.id);
      audit(s, 'brand_asset_record_removed', asset.id);
      return { assetId: asset.id };
    }

    if (action === 'brandMemory.remove') {
      const brand = get(s, 'brands', resourceId);
      requireValue(brand.memory.some(item => item.id === b.memoryId), 'NOT_FOUND', '品牌记忆不存在。', 404);
      brand.memory = brand.memory.filter(item => item.id !== b.memoryId);
      brand.version++; brand.updatedAt = now();
      audit(s, 'brand_memory_removed', b.memoryId);
      return { brandId: brand.id, version: brand.version };
    }

    if (action === 'snapshot.confirm') {
      const campaign = get(s, 'campaigns', resourceId);
      requireWritableCampaign(campaign);
      const snapshot = get(s, 'snapshots', campaign.brandSnapshotId);
      requireValue(!snapshot.frozenAt, 'SNAPSHOT_FROZEN', '该品牌快照已固定。长期品牌修改会在新 Campaign 中生效。', 409);
      const fields = ['product', 'claim', 'audience', 'competitors', 'market', 'limitations'];
      const imported = snapshot.productImport;
      requireValue(b.skip || imported?.status === 'skipped' || imported?.pageKind === 'product' || !(imported?.details?.candidates?.length > 1) || (b.product && b.product !== imported.fields?.product?.value), 'PRODUCT_SELECTION_REQUIRED', '这个页面包含多个商品，请选择具体商品链接，或手动明确填写本次要推广的产品。');
      const selectedImages = Array.isArray(b.importImageIds) ? [...new Set(b.importImageIds)] : [];
      requireValue(selectedImages.length <= maxProductImages && selectedImages.every(imageId => imported?.images?.some(image => image.id === imageId)), 'INVALID_IMPORT_IMAGE', '所选产品图不属于本次网址导入，请重新选择。');
      const selectedVariants = new Set((imported?.images || []).filter(im => selectedImages.includes(im.id) && im.variantId).map(im => im.variantId));
      requireValue(selectedVariants.size <= 1 && (!imported?.selectedVariantId || !selectedVariants.size || selectedVariants.has(imported.selectedVariantId)), 'PRODUCT_VARIANT_MISMATCH', '请选同一款式的图片。切换颜色或型号时，请导入对应款式的商品链接。');
      snapshot.facts = Object.fromEntries(fields.map(key => [key, String(b[key] || '').slice(0, 2000)]));
      snapshot.factMeta = Object.fromEntries(fields.map(key => [key, {
        ...(imported?.fields?.[key]?.value === snapshot.facts[key] ? imported.fields[key] : { sourceType: 'user', confidence: null }),
        confirmation: b.skip ? 'skipped' : snapshot.facts[key] ? 'confirmed' : 'missing'
      }]));
      snapshot.confirmation = b.skip ? 'skipped' : 'confirmed';
      if (!b.skip && b.brandName) {
        snapshot.brandName = string(b.brandName, 120);
        snapshot.factMeta.brandName = { ...(imported?.fields?.brandName?.value === snapshot.brandName ? imported.fields.brandName : { sourceType: 'user', confidence: null }), confirmation: 'confirmed' };
      }
      const importJob = s.jobs.find(item => item.id === imported?.jobId);
      if (importJob && ['queued', 'running'].includes(importJob.status)) { importJob.status = 'cancelled'; importJob.cancelledAt = now(); importJob.updatedAt = now(); for (const step of importJob.steps) if (step.status !== 'succeeded') step.status = 'cancelled'; imported.status = 'skipped'; }
      if (!b.skip) {
        const brand = get(s, 'brands', campaign.brandId);
        if (typeof b.brandName === 'string' && b.brandName.trim()) brand.name = string(b.brandName, 120);
        brand.facts = structuredClone(snapshot.facts); brand.version++; brand.updatedAt = now();
        for (const image of imported?.images || []) if (selectedImages.includes(image.id)) {
          let asset = s.brandAssets.find(item => item.brandId === brand.id && item.sourceUrl === image.sourceUrl && item.base64 === image.base64 && item.status === 'ready');
          if (!asset) {
            const decoded = decodeBrandAsset(image);
            asset = object(s, 'brand_asset', { brandId: brand.id, type: 'image', status: 'ready', name: image.name, mime: decoded.mime, format: decoded.format, base64: image.base64, source: 'confirmed_website_import', sourceUrl: image.sourceUrl, importedFrom: imported.sourceUrl, ...imageMetadata(image), updatedAt: now() });
            s.brandAssets.push(asset);
          }
          if (!snapshot.assetIds.includes(asset.id)) snapshot.assetIds.push(asset.id);
        }
        if (imported) imported.selectedImageIds = selectedImages;
      }
      audit(s, b.skip ? 'brand_confirmation_skipped' : 'brand_confirmed', campaign.id);
      return { campaignId: campaign.id, brandSnapshotId: snapshot.id };
    }

    if (action === 'brief.update') {
      const campaign = get(s, 'campaigns', resourceId);
      requireWritableCampaign(campaign);
      const previous = get(s, 'briefs', campaign.briefId);
      previous.status = 'superseded';
      const next = object(s, 'brief', {
        campaignId: campaign.id,
        version: Math.max(0, ...s.briefs.filter(item => item.campaignId === campaign.id).map(item => item.version || 0)) + 1,
        objective: string(b.objective), product: String(b.product || previous.product || '').slice(0, 2000),
        audience: String(b.audience || '').slice(0, 2000), channel: ['Meta', 'TikTok'].includes(b.channel) ? b.channel : 'Meta',
        focusSignals: Array.isArray(b.focusSignals) ? b.focusSignals.slice(0, 10) : previous.focusSignals || [],
        style: String(b.style || '产品演示').slice(0, 100), limitations: String(b.limitations || '').slice(0, 2000), status: 'current'
      });
      s.briefs.push(next); campaign.briefId = next.id; campaign.updatedAt = now();
      audit(s, 'brief_version_created', next.id);
      return { briefId: next.id, version: next.version };
    }

    if (action === 'references.collectImages') {
      const campaign = get(s, 'campaigns', resourceId);
      requireWritableCampaign(campaign);
      const active = s.jobs.find(j => j.campaignId === campaign.id && j.type === 'reference_media' && ['queued','running'].includes(j.status));
      if (active) return {jobId:active.id};
      const discovery = s.discoveries.filter(d => d.campaignId === campaign.id && d.briefId === campaign.briefId).at(-1);
      requireValue(discovery,'DISCOVERY_REQUIRED','请先完成参考资料采集。',409);
      const evidenceIds = s.evidence.filter(e => e.discoveryId === discovery.id && e.sourceType === 'meta_ad_library' && !e.attributes?.demo && s.discoverySources.some(source => source.id === e.discoverySourceId && source.status === 'available')).map(e => e.id).slice(0,30);
      requireValue(evidenceIds.length,'NO_PUBLIC_REFERENCES','本轮还没有可补齐图片的公开广告来源。',409);
      const directAdIds = Array.isArray(b.directAdIds) ? [...new Set(b.directAdIds)] : [];
      requireValue(directAdIds.length <= 2 && directAdIds.every(adId => typeof adId === 'string' && /^\d{5,30}$/.test(adId) && s.evidence.some(e => evidenceIds.includes(e.id) && e.sourceUrl === `https://www.facebook.com/ads/library/?id=${adId}`)), 'INVALID_MEDIA_AUTHORIZATION','直接读取仅支持本轮已保存广告中的至多两张公开封面。');
      const job = queue(s,campaign.id,'reference_media',{discoveryId:discovery.id,evidenceIds,directAdIds});
      if (directAdIds.length) audit(s,'reference_images_direct_authorized',campaign.id,null,{adIds:directAdIds,jobId:job.id,scope:'one_attempt'});
      return {jobId:job.id};
    }

    if (action === 'discovery.start') {
      const campaign = get(s, 'campaigns', resourceId);
      requireWritableCampaign(campaign);
      requireValue(!activeJob(s, campaign.id, ['discovery', 'cards']), 'JOB_CONFLICT', '分析任务正在进行。', 409);
      const job = queue(s, campaign.id, 'discovery', { snapshotId: campaign.brandSnapshotId, briefId: campaign.briefId });
      if (campaign.stage === CampaignStage.DRAFT) campaign.stage = CampaignStage.DISCOVERING;
      campaign.updatedAt = now();
      return { jobId: job.id };
    }

    if (action === 'cards.generate' || action === 'cards.refresh') {
      const campaign = get(s, 'campaigns', resourceId);
      requireWritableCampaign(campaign);
      const snapshot = get(s, 'snapshots', campaign.brandSnapshotId);
      requireValue(snapshot.confirmation !== 'pending', 'BRAND_CONFIRMATION_REQUIRED', '请先确认或跳过品牌信息。', 409);
      requireValue(!activeJob(s, campaign.id, ['discovery', 'cards']), 'JOB_CONFLICT', '请等待当前分析任务完成。', 409);
      const discovery = s.discoveries.filter(item => item.campaignId === campaign.id && item.briefId === campaign.briefId).at(-1);
      requireValue(discovery, 'DISCOVERY_REQUIRED', '请先按当前意图运行分析。', 409);
      if (action === 'cards.refresh') requireValue(s.cards.some(item => item.campaignId === campaign.id), 'CARDS_REQUIRED', '当前还没有可刷新的 Card。', 409);
      snapshot.frozenAt ||= now();
      const job = queue(s, campaign.id, 'cards', { snapshotId: snapshot.id, briefId: campaign.briefId, discoveryId: discovery.id, refresh: action === 'cards.refresh' });
      return { jobId: job.id };
    }

    if (action === 'card.adopt') {
      const card = get(s, 'cards', resourceId);
      const campaign = get(s, 'campaigns', card.campaignId);
      requireWritableCampaign(campaign);
      const version = b.cardVersionId ? get(s, 'cardVersions', b.cardVersionId) : currentCardVersion(s, card);
      requireValue(version.cardId === card.id, 'CARD_VERSION_MISMATCH', 'Card 版本不属于当前 Card。', 409);
      const existing = s.packages.find(item => item.cardVersionId === version.id);
      if (existing) return { packageId: existing.id, angleIds: s.angles.filter(angle => angle.packageId === existing.id).map(angle => angle.id) };
      requireValue(['candidate', 'reviewed'].includes(card.status), 'CARD_NOT_AVAILABLE', '当前卡片版本不可采纳。', 409);
      card.status = 'adopted'; card.adoptedVersionId = version.id; campaign.selectedCardVersionId = version.id;
      const pack = object(s, 'package', { campaignId: campaign.id, cardId: card.id, cardVersionId: version.id, status: 'active' });
      s.packages.push(pack);
      const base = version.content.creativeRoute;
      const product = get(s, 'briefs', campaign.briefId).product || get(s, 'snapshots', campaign.brandSnapshotId).facts.product;
      const detail = testDirections(product)[1];
      const person = /咖啡|coffee|espresso/i.test(product)
        ? ['晨光下，一位使用者在厨房打开咖啡袋，准备冲煮咖啡', '连续展示使用者磨豆、注水冲煮、端起咖啡杯的动作']
        : /无缝|运动服|健身|训练服|legging|seamless|gymshark|activewear/i.test(product)
          ? ['一位穿着产品的使用者在健身房整理衣服，准备开始训练', '跟随使用者完成拉伸与训练动作，切到实际穿着细节']
          : [`一位使用者拿起${product}，准备在日常场景中使用`, `中景展示使用者操作${product}，再用近景拍摄实际使用细节`];
      const specs = version.content.advertisingPlan ? [[version.content.advertisingPlan.name, base.hook, base.proof, base.style]] : [
        ['场景先行', base.hook, base.proof, base.style],
        ['证明先行', detail.hook, detail.proof, '产品实拍'],
        ['人物先行', ...person, '真人 UGC']
      ];
      const angles = specs.map(([name, hook, proof, visualLanguage], index) => object(s, 'angle', { packageId: pack.id, position: index + 1, name, hook, proof, visualLanguage, status: 'active', ...(version.content.advertisingPlan ? { advertisingPlan: structuredClone(version.content.advertisingPlan), scenePlan: version.content.advertisingPlan.shots.map(shot => ({ title: shot.title || sceneTitles[shot.index], text: shot.description, ...(shot.direction ? { direction: structuredClone(shot.direction) } : {}) })) } : {}) }));
      s.angles.push(...angles);
      advanceCampaignStage(campaign, CampaignStage.CREATING); campaign.updatedAt = now();
      s.feedback.push(object(s, 'feedback', { cardId: card.id, cardVersionId: version.id, type: 'adopt' }));
      audit(s, 'card_adopted', version.id);
      return { packageId: pack.id, cardVersionId: version.id, angleIds: angles.map(angle => angle.id) };
    }

    if (action === 'card.feedback') {
      const card = get(s, 'cards', resourceId);
      requireValue(['dismiss', 'save', 'restore'].includes(b.type), 'INVALID_FEEDBACK', '反馈类型无效。');
      if (b.type === 'dismiss') {
        requireValue(card.status !== 'adopted', 'CARD_LOCKED', '已采纳卡片保留为历史来源。', 409);
        card.status = 'dismissed';
      } else if (b.type === 'restore') {
        requireValue(card.status === 'dismissed', 'CARD_NOT_DISMISSED', '只有已略过卡片可以恢复。', 409);
        card.status = 'candidate';
      } else card.saved = !card.saved;
      s.feedback.push(object(s, 'feedback', { cardId: card.id, cardVersionId: card.currentVersionId, type: b.type }));
      audit(s, 'card_feedback', card.id);
      return { cardId: card.id };
    }

    if (action === 'template.import') {
      const pack = get(s, 'packages', resourceId);
      const campaign = get(s, 'campaigns', pack.campaignId);
      requireWritableCampaign(campaign);
      const angle = get(s, 'angles', b.angleId);
      requireValue(angle.packageId === pack.id, 'ANGLE_PACKAGE_MISMATCH', '创意角度不属于当前 Package。');
      requireValue(!activeJob(s, campaign.id, ['template_analysis']), 'JOB_CONFLICT', '已有参考模板正在分析。', 409);
      const { buffer, mime } = decodeLocalVideo(b);
      const template = object(s, 'video_template', {
        campaignId: campaign.id, packageId: pack.id, angleId: angle.id,
        filename: string(b.filename || 'reference-video', 150), mime, size: buffer.length,
        status: 'analyzing', source: 'local_upload', localOnly: true,
        base64: buffer.toString('base64'), scenes: [], updatedAt: now()
      });
      s.videoTemplates.push(template);
      const job = queue(s, campaign.id, 'template_analysis', { templateId: template.id }, { type: 'video_template', id: template.id });
      template.jobId = job.id;
      audit(s, 'video_template_imported', template.id);
      return { templateId: template.id, jobId: job.id };
    }

    if (action === 'config.create') {
      const pack = get(s, 'packages', resourceId);
      const campaign = get(s, 'campaigns', pack.campaignId);
      requireWritableCampaign(campaign);
      const angle = b.angleId ? get(s, 'angles', b.angleId) : s.angles.find(item => item.packageId === pack.id);
      requireValue(angle?.packageId === pack.id, 'ANGLE_PACKAGE_MISMATCH', '创意角度不属于当前 Package。');
      requireValue(['9:16', '1:1', '16:9'].includes(b.ratio), 'INVALID_CONFIG', '请选择支持的比例。');
      requireValue([15, 30].includes(Number(b.duration)), 'INVALID_CONFIG', '请选择 15 或 30 秒。');
      const selectedBrandAssetIds = Array.isArray(b.brandAssetIds) ? [...new Set(b.brandAssetIds)] : [];
      const campaignBrandId = campaign.brandId;
      requireValue(selectedBrandAssetIds.every(assetId => s.brandAssets.some(asset => asset.id === assetId && asset.brandId === campaignBrandId && asset.status === 'ready')), 'INVALID_BRAND_ASSET', '所选品牌素材不存在、尚未就绪或不属于当前品牌。');
      const variantIds = new Set(selectedBrandAssetIds.map(id => get(s, 'brandAssets', id)).filter(a => a.type !== 'logo' && a.variantId).map(a => a.variantId));
      requireValue(variantIds.size <= 1, 'PRODUCT_VARIANT_MISMATCH', '同一条广告请使用同一款式的产品图。');
      const productTreatment = b.productTreatment || 'local_product_overlay';
      requireValue(['local_product_overlay','product_reference'].includes(productTreatment), 'INVALID_CONFIG', '请选择支持的商品呈现方式。');
      requireValue(productTreatment !== 'product_reference' || b.publicReferenceConsent === true, 'PRODUCT_REFERENCE_CONSENT_REQUIRED', '使用商品参考生成前，请允许将选中的官网公开图片及必要场景描述发送给 YouMind。');
      const referenceAsset = selectedBrandAssetIds.map(id => get(s, 'brandAssets', id)).find(a => a.type !== 'logo');
      requireValue(productTreatment !== 'product_reference' || (referenceAsset?.source === 'confirmed_website_import' && /^https:\/\//.test(referenceAsset.sourceUrl)), 'PUBLIC_PRODUCT_IMAGE_REQUIRED', '商品参考生成需要一张已确认的官网公开产品图；本地上传素材仍留在本机。');
      const templateId = String(b.templateId || '').trim() || null;
      const template = templateId ? get(s, 'videoTemplates', templateId) : null;
      requireValue(!template || (template.status === 'ready' && template.campaignId === campaign.id && template.packageId === pack.id && template.angleId === angle.id), 'INVALID_VIDEO_TEMPLATE', '参考模板尚未就绪或不属于当前创意角度。');
      const scenePlan = b.scenePlan == null ? angle.scenePlan || null : b.scenePlan;
      const productionCopy = b.productionCopy || {};
      requireValue(['opening','detail','cta'].every(key => productionCopy[key] === undefined || (typeof productionCopy[key] === 'string' && productionCopy[key].length <= (key === 'cta' ? 24 : 70))), 'INVALID_COPY', '标题最多 70 字，行动引导最多 24 字。');
      requireValue(b.music === undefined || ['ambient','none'].includes(b.music), 'INVALID_CONFIG', '请选择轻配乐或无声。');
      requireValue(scenePlan === null || (Array.isArray(scenePlan) && scenePlan.length === 3 && scenePlan.every(scene => typeof scene?.text === 'string' && scene.text.trim().length > 0 && scene.text.length <= 600)), 'INVALID_SCENE_PLAN', '请为三个镜头各填写一段画面描述，每段不超过 600 字。');
      requireValue(scenePlan === null || scenePlan.every((scene, index) => isValidShotDirection(scene.direction) && (index < 2 || !hasShotDirection(scene.direction))), 'INVALID_SHOT_DIRECTION', '镜头设计每项最多 400 字；产品原图收尾不使用生成镜头设计。');
      const config = object(s, 'config', {
        packageId: pack.id, campaignId: pack.campaignId, angleId: angle.id, cardVersionId: pack.cardVersionId,
        version: Math.max(0, ...s.configs.filter(item => item.angleId === angle.id).map(item => item.version || 0)) + 1,
        ratio: b.ratio, duration: Number(b.duration), language: ['English', '中文'].includes(b.language) ? b.language : 'English',
        brandAssetIds: selectedBrandAssetIds, templateId, notes: String(b.notes || '').slice(0, 2000),
        productTreatment, ...(productTreatment === 'product_reference' ? { publicReferenceConsent: { granted: true, assetId: referenceAsset.id, sourceUrl: referenceAsset.sourceUrl, grantedAt: now() } } : {}),
        scenePlan: scenePlan?.map((scene, index) => ({ title: angle.scenePlan?.[index]?.title || sceneTitles[index], text: scene.text.trim(), ...(hasShotDirection(scene.direction) ? { direction: normalizeShotDirection(scene.direction) } : {}) })) || null,
        productionCopy: Object.fromEntries(['opening','detail','cta'].map(key => [key, String(productionCopy[key] || '').trim()])), music: b.music || 'ambient', status: 'frozen'
      });
      if (angle.advertisingPlan) {
        config.advertisingPlan = structuredClone(angle.advertisingPlan);
        config.productDossier = structuredClone(get(s, 'cardVersions', pack.cardVersionId).content.productDossier);
        config.marketBrief = structuredClone(get(s, 'cardVersions', pack.cardVersionId).content.marketBrief || null);
        config.productDossier.materials = selectedBrandAssetIds.map(id => get(s, 'brandAssets', id)).filter(a => a.type !== 'logo').map(a => ({ id: a.id, name: a.name, mime: a.mime, role: 'product_original', visualVerification: 'not_performed', usableForEndcard: ['image/png', 'image/jpeg', 'image/webp'].includes(a.mime) }));
        config.advertisingPlan.shots = config.advertisingPlan.shots.map((shot, index) => ({ ...shot, description: config.scenePlan[index].text, ...(config.scenePlan[index].direction ? { direction: structuredClone(config.scenePlan[index].direction) } : {}), ...(index === 2 && shot.source === 'local_product_image' ? { materialIds: config.productDossier.materials.filter(a => a.usableForEndcard).map(a => a.id) } : {}) }));
        config.advertisingPlan.editedFromProposal = JSON.stringify(config.scenePlan.map(s => s.text)) !== JSON.stringify(angle.scenePlan.map(s => s.text));
      }
      s.configs.push(config);
      audit(s, 'generation_config_created', config.id);
      return { configId: config.id, version: config.version };
    }

    if (action === 'generation.start') {
      const config = get(s, 'configs', resourceId);
      requireValue(!b.angleId || b.angleId === config.angleId, 'ANGLE_CONFIG_MISMATCH', '请先保存当前角度的生成配置。', 409);
      const campaign = get(s, 'campaigns', config.campaignId);
      requireWritableCampaign(campaign);
      requireValue(['storyboard', 'video'].includes(b.mode), 'INVALID_GENERATION_MODE', '请选择支持的生成任务类型。');
      const mode = b.mode;
      requireValue(!activeJob(s, campaign.id, ['storyboard', 'video', 'production']), 'JOB_CONFLICT', '创作任务正在进行。', 409);
      const request = object(s, 'generation_request', { campaignId: campaign.id, packageId: config.packageId, angleId: config.angleId, configId: config.id, cardVersionId: config.cardVersionId, mode, provider: mode === 'storyboard' ? 'local_preview' : 'youmind', status: 'queued', safetyStatus: 'pending' });
      s.generationRequests.push(request);
      const job = queue(s, campaign.id, mode, { generationRequestId: request.id, configId: config.id }, { type: 'generation_request', id: request.id });
      request.jobId = job.id;
      return { jobId: job.id, generationRequestId: request.id };
    }

    if (action === 'asset.import') {
      const config = get(s, 'configs', resourceId);
      requireValue(!b.angleId || b.angleId === config.angleId, 'ANGLE_CONFIG_MISMATCH', '请先保存当前角度的生成配置。', 409);
      const pack = get(s, 'packages', config.packageId);
      const campaign = get(s, 'campaigns', pack.campaignId);
      requireWritableCampaign(campaign);
      const { buffer, mime } = decodeLocalVideo(b);
      const request = object(s, 'generation_request', { campaignId: campaign.id, packageId: pack.id, angleId: config.angleId, configId: config.id, cardVersionId: pack.cardVersionId, mode: 'video', provider: 'local_import', status: 'succeeded', safetyStatus: 'user_review_required', completedAt: now() });
      s.generationRequests.push(request);
      const sourceVersion = get(s, 'cardVersions', pack.cardVersionId);
      const asset = object(s, 'asset', {
        campaignId: campaign.id, packageId: pack.id, angleId: config.angleId,
        sourceCardVersionId: pack.cardVersionId, sourceCardVersion: sourceVersion.version, generationRequestId: request.id, configId: config.id, configVersion: config.version,
        version: Math.max(0, ...s.assets.filter(item => item.angleId === config.angleId && item.type === 'video').map(item => item.version || 0)) + 1,
        type: 'video', status: 'ready', source: 'user_import', mime,
        filename: String(b.filename || 'video').slice(0, 150), base64: buffer.toString('base64'), safety: 'user_review_required'
      });
      s.assets.push(asset); request.assetId = asset.id;
      audit(s, 'asset_imported', asset.id);
      return { assetId: asset.id, generationRequestId: request.id };
    }

    if (action === 'asset.launch-ready') {
      const asset = get(s, 'assets', resourceId);
      const campaign = get(s, 'campaigns', asset.campaignId);
      requireWritableCampaign(campaign);
      requireValue(asset.type === 'video' && asset.status === 'ready', 'VIDEO_REQUIRED', '只有已完成的视频可以标记为准备投放。');
      requireValue(b.reviewed === true, 'REVIEW_REQUIRED', '请确认已审核视频内容及品牌表达。');
      if (asset.source === 'orynt_composed') requireValue(asset.qualityReview?.status === 'accepted' && !asset.technical?.issues?.length, 'REVIEW_REQUIRED', '请先完成成片的产品、镜头、文案和声音检查。');
      asset.status = 'launch_ready'; asset.launchReadyAt = now();
      advanceCampaignStage(campaign, CampaignStage.LAUNCH_READY); campaign.updatedAt = now();
      audit(s, 'asset_marked_launch_ready', asset.id);
      return { assetId: asset.id };
    }

    if (action === 'plan.save') {
      const campaign = get(s, 'campaigns', resourceId);
      requireWritableCampaign(campaign);
      const assetIds = b.assetIds?.length ? [...new Set(b.assetIds)] : b.assetId ? [b.assetId] : [];
      requireValue(assetIds.length > 0, 'ASSET_REQUIRED', '请至少选择一个准备投放的视频。');
      const assets = assetIds.map(assetId => get(s, 'assets', assetId));
      requireValue(assets.every(asset => asset.campaignId === campaign.id && asset.type === 'video' && asset.status === 'launch_ready'), 'ASSET_NOT_READY', '请选择当前 Campaign 中已准备投放的视频。');
      requireValue(assets.every(asset => asset.sourceCardVersionId === assets[0].sourceCardVersionId), 'MIXED_CARD_VERSIONS', '同一计划只能使用同一个 Card 版本的素材。');
      const plan = object(s, 'plan', {
        campaignId: campaign.id, cardVersionId: assets[0].sourceCardVersionId, assetIds,
        channel: ['Meta', 'TikTok'].includes(b.channel) ? b.channel : 'Meta', audience: string(b.audience), hypothesis: string(b.hypothesis),
        goal: String(b.goal || '').slice(0, 2000), budget: String(b.budget || '').slice(0, 200), period: String(b.period || '').slice(0, 100),
        metric: String(b.metric || 'CTR').slice(0, 100), status: 'prepared',
        version: Math.max(0, ...s.plans.filter(item => item.campaignId === campaign.id).map(item => item.version || 0)) + 1
      });
      s.plans.push(plan);
      audit(s, 'launch_plan_prepared', plan.id);
      return { planId: plan.id, version: plan.version };
    }

    if (action === 'mapping.save') {
      const plan = get(s, 'plans', resourceId);
      const campaign = get(s, 'campaigns', plan.campaignId);
      requireWritableCampaign(campaign);
      const assetId = b.assetId || plan.assetIds[0];
      requireValue(plan.assetIds.includes(assetId), 'ASSET_PLAN_MISMATCH', '素材不属于当前投放计划。');
      const mapping = object(s, 'mapping', {
        campaignId: plan.campaignId, planId: plan.id, cardVersionId: plan.cardVersionId, assetId,
        externalCampaign: String(b.externalCampaign || '').slice(0, 150), externalAdSet: String(b.externalAdSet || '').slice(0, 150),
        externalAdId: string(b.externalAdId, 150), matchMethod: 'user_confirmed', confidence: b.confidence || 'manual',
        status: 'confirmed', dataStatus: 'not_synced'
      });
      s.mappings.push(mapping);
      if (plan.assetIds.every(id => s.mappings.some(item => item.planId === plan.id && item.assetId === id && item.status === 'confirmed'))) plan.status = 'mapped';
      audit(s, 'ad_mapping_confirmed', mapping.id);
      return { mappingId: mapping.id };
    }

    if (action === 'plan.simulate-launch') {
      const plan = get(s, 'plans', resourceId);
      const campaign = get(s, 'campaigns', plan.campaignId);
      requireWritableCampaign(campaign);
      requireValue(plan.assetIds.length > 0, 'ASSET_REQUIRED', '模拟投放需要至少一份视频素材。');
      requireValue(!plan.simulatedLaunchAt, 'SIMULATED_LAUNCH_EXISTS', '当前计划已经开始模拟投放。', 409);
      const mappings = plan.assetIds.map((assetId, index) => {
        const existing = s.mappings.find(item => item.planId === plan.id && item.assetId === assetId && item.status === 'confirmed' && item.simulation === true);
        if (existing) return existing;
        const mapping = object(s, 'mapping', {
          campaignId: plan.campaignId, planId: plan.id, cardVersionId: plan.cardVersionId, assetId,
          externalCampaign: `模拟 Campaign · v${plan.version}`,
          externalAdSet: `${plan.channel} · 模拟受众组`,
          externalAdId: `sim-${plan.id.slice(-8)}-${index + 1}`,
          matchMethod: 'local_simulation', confidence: 'simulation', status: 'confirmed',
          dataStatus: 'not_synced', simulation: true
        });
        s.mappings.push(mapping);
        return mapping;
      });
      plan.status = 'observing';
      plan.dataMode = 'simulation';
      plan.simulatedLaunchAt = now();
      plan.updatedAt = plan.simulatedLaunchAt;
      advanceCampaignStage(campaign, CampaignStage.LEARNING);
      campaign.updatedAt = plan.simulatedLaunchAt;
      audit(s, 'simulated_launch_started', plan.id);
      return { planId: plan.id, mappingIds: mappings.map(item => item.id), simulation: true };
    }

    if (action === 'plan.manual') {
      const plan = get(s, 'plans', resourceId);
      const campaign = get(s, 'campaigns', plan.campaignId);
      requireWritableCampaign(campaign);
      plan.status = 'observing'; plan.updatedAt = now();
      advanceCampaignStage(campaign, CampaignStage.LEARNING); campaign.updatedAt = now();
      audit(s, 'plan_marked_observing', plan.id);
      return { planId: plan.id };
    }

    if (action === 'metrics.simulate') {
      const plan = get(s, 'plans', resourceId);
      const campaign = get(s, 'campaigns', plan.campaignId);
      requireWritableCampaign(campaign);
      const mappings = plan.assetIds.map(assetId => s.mappings.filter(item => item.planId === plan.id && item.assetId === assetId && item.status === 'confirmed' && (plan.dataMode !== 'simulation' || item.simulation === true)).at(-1)).filter(Boolean);
      requireValue(mappings.length === plan.assetIds.length && plan.assetIds.every(assetId => mappings.some(item => item.assetId === assetId)), 'MAPPING_INCOMPLETE', '请先为计划中的每份素材确认广告映射。', 409);
      requireValue(b.confirmSimulation === true, 'SIMULATION_CONFIRM_REQUIRED', '请确认生成的是模拟数据。');
      const previous = s.metricSnapshots.filter(item => item.planId === plan.id && item.source === 'local_simulation');
      requireValue(!previous.length || b.replace === true, 'SIMULATION_EXISTS', '当前计划已有模拟数据；重新生成前请确认替换。', 409);
      if (previous.length) {
        const oldIds = new Set(previous.map(item => item.id));
        s.metricSnapshots = s.metricSnapshots.filter(item => !oldIds.has(item.id));
        s.conclusions = s.conclusions.filter(item => !(item.planId === plan.id && item.source === 'local_simulation'));
      }
      const batchId = id('simulation_batch');
      const observedTo = now();
      const observedFrom = new Date(Date.parse(observedTo) - 7 * 86400000).toISOString();
      const metrics = [];
      for (const mapping of mappings) {
        const seed = Number.parseInt(createHash('sha256').update(mapping.id).digest('hex').slice(0, 8), 16);
        const impressions = 8000 + seed % 9000;
        const ctr = Number((1.4 + (seed % 150) / 100).toFixed(2));
        const clicks = Math.round(impressions * ctr / 100);
        const cpc = Number((0.55 + (seed % 70) / 100).toFixed(2));
        const completion = Number((22 + (seed % 1800) / 100).toFixed(1));
        const definitions = [
          ['曝光', impressions.toLocaleString('en-US'), impressions, 'count'],
          ['CTR', `${ctr.toFixed(2)}%`, ctr, 'percent'],
          ['CPC', `$${cpc.toFixed(2)}`, cpc, 'USD'],
          ['视频完播率', `${completion.toFixed(1)}%`, completion, 'percent']
        ];
        for (const [metric, value, numericValue, unit] of definitions) {
          const snapshot = object(s, 'metric_snapshot', {
            campaignId: plan.campaignId, planId: plan.id, mappingId: mapping.id, assetId: mapping.assetId,
            cardVersionId: plan.cardVersionId, batchId, metric, value, numericValue, unit,
            source: 'local_simulation', simulation: true, quality: 'simulated_complete',
            observedFrom, observedTo
          });
          s.metricSnapshots.push(snapshot); metrics.push(snapshot);
        }
        mapping.dataStatus = 'simulated'; mapping.updatedAt = observedTo;
      }
      const cardVersion = get(s, 'cardVersions', plan.cardVersionId);
      const conclusion = object(s, 'conclusion', {
        campaignId: plan.campaignId, planId: plan.id, cardId: cardVersion.cardId, cardVersion: cardVersion.version,
        metricSnapshotIds: metrics.map(item => item.id), source: 'local_simulation', simulation: true,
        state: 'adjust', confidence: 'simulation_only', status: 'candidate',
        title: '模拟回收链路已完成',
        body: '模拟指标已从广告映射回流至素材、创意角度和 Campaign Card；这些数值不代表真实投放表现。',
        basis: `基于 ${mappings.length} 条已确认映射和 ${metrics.length} 条本地模拟指标，仅验证追踪与归因关系。`,
        applicability: '仅用于内部链路测试；接入真实平台数据后必须重新生成学习结论。'
      });
      s.conclusions.push(conclusion);
      plan.status = 'observing'; plan.dataMode = 'simulation'; plan.updatedAt = observedTo;
      advanceCampaignStage(campaign, CampaignStage.LEARNING); campaign.updatedAt = observedTo;
      audit(s, previous.length ? 'simulated_metrics_replaced' : 'simulated_metrics_generated', plan.id);
      return { planId: plan.id, batchId, metricCount: metrics.length, conclusionId: conclusion.id };
    }

    if (action === 'connection.toggle') {
      let connection = s.connections.find(item => item.id === resourceId);
      if (!connection && resourceId === 'meta-local') {
        connection = object(s, 'connection', { provider: 'Meta', status: 'disconnected', scopes: [], lastSyncedAt: null });
        connection.id = resourceId; s.connections.push(connection);
      }
      requireValue(connection, 'NOT_FOUND', '连接不存在。', 404);
      requireValue(['connected', 'disconnected'].includes(b.status), 'INVALID_CONNECTION_STATUS', '连接状态无效。');
      connection.status = b.status; connection.updatedAt = now();
      // Simulated connection never reads account data or establishes a sync timestamp.
      audit(s, 'connection_status_changed', connection.id);
      return { connectionId: connection.id, status: connection.status };
    }

    if (action === 'conclusion.adopt') {
      const conclusion = get(s, 'conclusions', resourceId);
      requireValue(!conclusion.simulation, 'SIMULATED_CONCLUSION_READ_ONLY', '模拟学习建议不能写入 Brand Memory。', 409);
      requireValue(['adopted', 'dismissed'].includes(b.status), 'INVALID_CONCLUSION_STATUS', '学习结论状态无效。');
      conclusion.status = b.status; conclusion.updatedAt = now();
      if (b.status === 'adopted') {
        const campaign = get(s, 'campaigns', conclusion.campaignId);
        const brand = get(s, 'brands', campaign.brandId);
        if (!brand.memory.some(item => item.conclusionId === conclusion.id)) brand.memory.push({ id: id('memory'), conclusionId: conclusion.id, title: conclusion.title, applicability: conclusion.applicability, createdAt: now() });
      }
      audit(s, 'conclusion_status_changed', conclusion.id);
      return { conclusionId: conclusion.id, status: conclusion.status };
    }

    if (action === 'job.cancel' || action === 'job.retry') {
      const job = get(s, 'jobs', resourceId);
      const productionRequest = job.type === 'production' && get(s, 'generationRequests', job.input.generationRequestId);
      if (productionRequest) requireWritableCampaign(get(s, 'campaigns', job.campaignId));
      const importSnapshot = job.type === 'product_import' && get(s, 'snapshots', job.input.snapshotId);
      if (importSnapshot) {
        requireWritableCampaign(get(s, 'campaigns', job.campaignId));
        requireValue(!importSnapshot.frozenAt && importSnapshot.confirmation === 'pending' && importSnapshot.productImport?.jobId === job.id, 'SNAPSHOT_FROZEN', '本轮产品资料已确认或已重新读取，不能恢复旧任务。', 409);
      }
      if (action === 'job.cancel') {
        requireValue(['queued', 'running'].includes(job.status), 'JOB_NOT_CANCELLABLE', '当前任务不能取消。', 409);
        job.status = 'cancelled'; job.cancelledAt = now(); job.updatedAt = job.cancelledAt;
        for (const step of job.steps) if (step.status !== 'succeeded') step.status = 'cancelled';
        if (importSnapshot) importSnapshot.productImport.status = 'skipped';
        const request = job.input.generationRequestId && s.generationRequests.find(item => item.id === job.input.generationRequestId);
        if (request && ['queued', 'running'].includes(request.status)) request.status = 'cancelled';
        if (productionRequest) productionRequest.production.phase = 'cancelled';
        const template = job.input.templateId && s.videoTemplates.find(item => item.id === job.input.templateId);
        if (template) { template.status = 'failed'; template.error = { code: 'CANCELLED', message: '模板分析已取消。' }; template.updatedAt = now(); }
      } else {
        requireValue(['failed', 'cancelled'].includes(job.status), 'JOB_NOT_RETRYABLE', '当前任务无需重试。', 409);
        requireValue(!activeJob(s, job.campaignId, ['production','video','storyboard'].includes(job.type) ? ['production','video','storyboard'] : [job.type]), 'JOB_CONFLICT', '同类任务已在进行。', 409);
        if (productionRequest) requireValue(!productionRequest.production.shots.some(shot => shot.submissionStartedAt && !shot.providerState?.chatId), 'VIDEO_SUBMISSION_UNCERTAIN', '上次提交结果不确定，请核查任务，已阻止重复付费提交。', 409);
        if (productionRequest) requireValue(!productionRequest.production.shots.some(shot => shot.keyframe?.submissionStartedAt && !shot.keyframe.providerState?.chatId), 'KEYFRAME_SUBMISSION_UNCERTAIN', '上次关键帧提交结果不确定，请核查任务，已阻止重复付费提交。', 409);
        const firstIncomplete = job.steps.findIndex(step => step.status !== 'succeeded');
        requireValue(firstIncomplete >= 0, 'JOB_ALREADY_COMPLETE', '任务已经完成。', 409);
        requireValue(job.steps.slice(firstIncomplete).every(step => step.attempts < step.maxAttempts), 'JOB_ATTEMPTS_EXHAUSTED', '任务已达到最大重试次数，请检查来源或重新发起分析。', 409);
        for (const step of job.steps.slice(firstIncomplete)) { step.status = 'queued'; delete step.error; delete step.startedAt; delete step.finishedAt; }
        job.status = 'queued'; job.retriedAt = now(); job.updatedAt = job.retriedAt; job.attemptId = id('attempt'); delete job.error; delete job.completedAt;
        if (importSnapshot) { importSnapshot.productImport.status = 'reading'; delete importSnapshot.productImport.error; }
        const request = job.input.generationRequestId && s.generationRequests.find(item => item.id === job.input.generationRequestId);
        if (request) { request.status = 'queued'; delete request.error; }
        if (productionRequest) {
          productionRequest.production.phase = 'resuming';
          for(const shot of productionRequest.production.shots) {
            if(shot.status==='failed'&&shot.keyframe?.providerState?.url&&!shot.keyframe.sha256)shot.status='planning';
          }
        }
        const template = job.input.templateId && s.videoTemplates.find(item => item.id === job.input.templateId);
        if (template) { template.status = 'analyzing'; delete template.error; template.updatedAt = now(); }
      }
      audit(s, action, job.id);
      return { jobId: job.id };
    }

    if (action === 'campaign.archive') {
      const campaign = get(s, 'campaigns', resourceId);
      requireValue(!activeJob(s, campaign.id, Object.keys(jobSteps)), 'ACTIVE_JOBS', '请先完成或取消进行中的任务。', 409);
      campaign.stage = CampaignStage.CLOSED; campaign.status = CampaignLifecycleStatus.ARCHIVED; campaign.updatedAt = now();
      audit(s, 'campaign_archived', campaign.id);
      return { campaignId: campaign.id };
    }

    throw new DomainError('UNKNOWN_COMMAND', '未支持的操作。', 404);
  }

  tick(completion = {}) {
    const pending = completion.jobId
      ? this.repo.read().jobs.find(job => job.id === completion.jobId && ['queued', 'running'].includes(job.status))
      : this.repo.read().jobs.find(job => ['queued', 'running'].includes(job.status));
    if (!pending) return;
    this.repo.transact(s => {
      const job = get(s, 'jobs', pending.id);
      if (job.resultId) return;
      job.status = 'running'; job.startedAt ||= now(); job.updatedAt = now();
      const step = job.steps.find(item => item.status !== 'succeeded');
      if (!step) return;
      step.status = 'running'; step.attempts++; step.startedAt = now();
      try {
        if (completion.error) throw new DomainError(completion.error.code || 'JOB_FAILED', completion.error.message || '任务未完成。', 503);
        if (completion.providerResult) job.providerResult = { ...(job.providerResult || {}), ...completion.providerResult };
        if (step === job.steps.at(-1)) this.complete(s, job, completion.discovery);
        step.status = 'succeeded'; step.finishedAt = now();
        if (job.steps.every(item => item.status === 'succeeded')) {
          job.status = 'succeeded'; job.completedAt = now(); job.updatedAt = job.completedAt; delete job.providerResult; audit(s, 'job_completed', job.id);
        }
      } catch (error) {
        step.status = 'failed'; step.error = { code: error.code || 'JOB_FAILED', message: error.message };
        job.status = 'failed'; job.error = step.error; job.failedAt = now(); job.updatedAt = job.failedAt;
        const request = job.input.generationRequestId && s.generationRequests.find(item => item.id === job.input.generationRequestId);
        if (request) { request.status = 'failed'; request.error = step.error; }
        const template = job.input.templateId && s.videoTemplates.find(item => item.id === job.input.templateId);
        if (template) { template.status = 'failed'; template.error = step.error; template.updatedAt = now(); }
        if (job.type === 'product_import') {
          const snapshot = s.snapshots.find(item => item.id === job.input.snapshotId);
          if (snapshot?.productImport?.jobId === job.id && snapshot.confirmation === 'pending') Object.assign(snapshot.productImport, { status: 'failed', error: step.error });
        }
        audit(s, 'job_failed', job.id);
      }
    });
  }

  complete(s, job, discoveryBundle = null) {
    const campaign = get(s, 'campaigns', job.campaignId);
    if (job.resultId) return;
    if (job.type === 'reference_media') {
      const entries = job.providerResult?.evidence;
      requireValue(Array.isArray(entries),'INVALID_MEDIA_RESULT','参考图片未能整理完成。');
      let saved = 0;
      for (const entry of entries) {
        const evidence = s.evidence.find(e => e.id === entry.id && e.discoveryId === job.input.discoveryId && job.input.evidenceIds.includes(e.id));
        if (!evidence) continue;
        const normalized = referenceAttributes({...evidence,attributes:{...evidence.attributes,media:entry.media || []}});
        // A failed refresh must not discard a previously saved original.
        const previous = evidence.attributes?.media?.filter(m => m.status === 'available') || [];
        evidence.attributes = {...normalized,mediaCheckedAt:now(),mediaMissingReason:entry.mediaMissingReason || null};
        if (previous.length && !normalized.media.some(m => m.status === 'available')) Object.assign(evidence.attributes,{media:previous,mediaStatus:'available'});
        saved += evidence.attributes.media.filter(m => m.status === 'available').length;
      }
      job.resultId = job.input.discoveryId;
      job.summary = {savedImages:saved,checkedReferences:entries.length};
      audit(s,'reference_images_collected',campaign.id,null,job.summary);
      return;
    }
    if (job.type === 'product_import') {
      const snapshot = get(s, 'snapshots', job.input.snapshotId);
      const result = job.providerResult;
      requireValue(result?.fields && Array.isArray(result.images), 'INVALID_IMPORT_RESULT', '产品页读取结果不完整。');
      if (snapshot.productImport?.jobId !== job.id || snapshot.confirmation !== 'pending') return;
      const fields = {};
      for (const key of ['brandName', 'product', 'claim']) {
        const field = result.fields[key];
        if (typeof field?.value === 'string' && field.value.trim()) fields[key] = { value: field.value.slice(0, key === 'brandName' ? 120 : 2000), sourceType: String(field.sourceType || 'website'), sourceUrl: String(result.sourceUrl || job.input.url), confidence: Math.max(0, Math.min(1, Number(field.confidence) || 0)), confirmation: 'pending' };
      }
      const images = result.images.slice(0, maxProductImages).map((image, index) => {
        const decoded = decodeBrandAsset(image);
        return { id: `${job.id}_image_${index}`, name: String(image.name || `产品图 ${index + 1}`).slice(0, 120), mime: decoded.mime, base64: decoded.buffer.toString('base64'), sourceUrl: String(image.sourceUrl || ''), ...imageMetadata(image) };
      });
      snapshot.productImport = { status: Object.keys(fields).length ? 'ready' : 'partial', jobId: job.id, sourceUrl: String(result.sourceUrl || job.input.url), observedAt: result.observedAt || now(), pageKind: result.pageKind === 'product' ? 'product' : 'website', fields, images, ...importMedia(result), details: normalizeProductDetails(result.details, String(result.sourceUrl || job.input.url)), limitations: (result.limitations || []).filter(value => typeof value === 'string').slice(0, 8).map(value => value.slice(0, 500)) };
      job.resultId = snapshot.id;
      audit(s, 'product_import_completed', campaign.id);
      return;
    }
    if (job.type === 'discovery') {
      const batch = object(s, 'collection_batch', {
        campaignId: campaign.id, jobId: job.id, attemptId: job.attemptId,
        provider: discoveryBundle?.provider || 'local_preview', status: 'published', completedAt: now()
      });
      s.collectionBatches.push(batch);
      const run = object(s, 'discovery', {
        campaignId: campaign.id, snapshotId: job.input.snapshotId, briefId: job.input.briefId,
        collectionBatchId: batch.id,
        version: Math.max(0, ...s.discoveries.filter(item => item.campaignId === campaign.id).map(item => item.version || 0)) + 1,
        sourceIds: [], status: 'partial_ready',
        coverage: discoveryBundle?.coverage || { sources: 0, externalSignals: 0 },
        limitations: discoveryBundle?.limitations?.length
          ? discoveryBundle.limitations
          : ['未连接外部市场来源；当前仅使用用户确认的品牌信息。'],
        completedAt: now()
      });
      if (discoveryBundle) {
        const sourceByUrl = new Map();
        for (const candidate of discoveryBundle.sources || []) {
          const source = object(s, 'discovery_source', {
            campaignId: campaign.id, discoveryId: run.id,
            sourceType: candidate.sourceType || 'brand_website', sourceUrl: candidate.sourceUrl,
            provider: candidate.provider || discoveryBundle.provider || 'orynt_local_website',
            status: ['available', 'failed', 'demo'].includes(candidate.status) ? candidate.status : 'coverage_insufficient',
            observedAt: candidate.observedAt, rawEvidenceRef: candidate.rawEvidenceRef || null,
            attributes: candidate.attributes || {}, collectionBatchId: batch.id,
            errorCode: candidate.errorCode || null
          });
          s.discoverySources.push(source); run.sourceIds.push(source.id); sourceByUrl.set(candidate.sourceUrl, source.id);
        }
        const uniqueEvidence = new Map();
        for (const candidate of discoveryBundle.evidence || []) if (!uniqueEvidence.has(evidenceKey(candidate))) uniqueEvidence.set(evidenceKey(candidate), candidate);
        for (const candidate of uniqueEvidence.values()) {
          const evidence = object(s, 'evidence', {
            discoveryId: run.id, discoverySourceId: sourceByUrl.get(candidate.sourceUrl) || null,
            collectionBatchId: batch.id,
            sourceType: candidate.sourceType || 'brand_website', sourceUrl: candidate.sourceUrl,
            observedAt: candidate.observedAt, ingestedAt: candidate.ingestedAt,
            title: candidate.title || '', contentSummary: candidate.contentSummary,
            rawEvidenceRef: candidate.rawEvidenceRef, contentHash: candidate.contentHash,
            attributes: referenceAttributes(candidate)
          });
          s.evidence.push(evidence);
          s.signals.push(object(s, 'signal', {
            campaignId: campaign.id, discoveryId: run.id, evidenceIds: [evidence.id],
            type: signalType(evidence), title: evidenceLabel(evidence),
            contentSummary: evidence.contentSummary,
            relevanceBasis: `候选观察；与本轮“${get(s, 'briefs', job.input.briefId).objective}”的相关性尚需验证。`,
            coverage: evidence.sourceType.startsWith('meta_') ? 'Meta 公开广告小样本' : '品牌自有官网',
            observedAt: evidence.observedAt, rawEvidenceRef: evidence.rawEvidenceRef, status: 'candidate'
          }));
        }
        run.coverage = {
          ...discoveryBundle.coverage,
          sources: run.sourceIds.length,
          evidence: uniqueEvidence.size,
          externalSignals: Number(discoveryBundle.coverage?.externalSignals || 0)
        };
      } else {
        const source = object(s, 'discovery_source', { campaignId: campaign.id, discoveryId: run.id, collectionBatchId: batch.id, sourceType: 'local_preview', status: 'coverage_insufficient', coverage: { sources: 0 }, errorCode: null });
        s.discoverySources.push(source); run.sourceIds.push(source.id);
      }
      s.discoveries.push(run); job.resultId = run.id;
      return;
    }

    if (job.type === 'cards') {
      const snapshot = get(s, 'snapshots', job.input.snapshotId);
      const brief = get(s, 'briefs', job.input.briefId);
      const discovery = get(s, 'discoveries', job.input.discoveryId);
      let opportunities = opportunityCandidates(s, discovery);
      if (snapshot.productImport && job.providerResult?.strategy) {
        const dossier = planningContext(s, snapshot, brief);
        const marketBrief = buildMarketBrief(s, discovery, dossier);
        const plans = validateModelPlans(job.providerResult.strategy, dossier, marketBrief);
        opportunities = opportunities.map((op, index) => {
          const evidenceIds = plans[index].marketBasis.evidenceIds;
          return { ...op, ...Object.fromEntries(['hook', 'proof', 'style', 'hypothesis', 'title'].map(k => [k, plans[index][k]])), evidenceIds, signalIds: s.signals.filter(signal => signal.discoveryId === discovery.id && signal.evidenceIds?.some(id => evidenceIds.includes(id))).map(signal => signal.id), basis: evidenceIds.length ? 'public_sample' : 'unverified', advertisingPlan: plans[index] };
        });
      }
      const evidenceById = new Map(s.evidence.filter(item => item.discoveryId === discovery.id).map(item => [item.id, item]));
      if (job.input.refresh) for (const old of s.cards.filter(item => item.campaignId === campaign.id && item.status !== 'adopted')) old.status = 'superseded';
      const cardVersion = Math.max(0, ...s.cards.filter(item => item.campaignId === campaign.id).map(item => get(s, 'cardVersions', item.currentVersionId).version || 0)) + 1;
      const cardSet = object(s, 'card_set', { campaignId: campaign.id, discoveryId: job.input.discoveryId, briefId: brief.id, generationJobId: job.id, status: 'partial_published' });
      s.cardSets.push(cardSet);
      const cardIds = [];
      for (const opportunity of opportunities) {
        const supporting = opportunity.evidenceIds.map(evidenceId => evidenceById.get(evidenceId)).filter(Boolean);
        const basisLabel = opportunity.basis === 'brand_context' ? '品牌信息' : opportunity.basis === 'public_sample' ? '公开样本' : '待验证假设';
        const style = opportunity.observedFormat ? `${opportunity.style}（样本格式：${opportunity.observedFormat}）` : opportunity.style;
        const card = object(s, 'card', { campaignId: campaign.id, cardSetId: cardSet.id, status: 'candidate', adoptedVersionId: null, currentVersionId: null, saved: false });
        const version = object(s, 'card_version', {
          cardId: card.id, version: cardVersion, status: 'published',
          content: {
            title: `${basisLabel}｜${opportunity.title}`, opportunity: opportunity.summary,
            opportunityId: opportunity.id, evidenceBasis: opportunity.basis, signalIds: opportunity.signalIds,
            evidenceSummary: opportunity.evidenceSummary, relevanceMethod: opportunity.relevanceMethod,
            supportingEvidenceCount: supporting.length,
            ...(opportunity.advertisingPlan ? { advertisingPlan: opportunity.advertisingPlan, productDossier: opportunity.productDossier, marketBrief: opportunity.marketBrief, planningNotice: job.providerResult?.planningNotice || '基础方案使用本地规则整理，尚未经过视觉质量审核。' } : {}),
            audience: opportunity.audience,
            claim: snapshot.facts.claim || '待品牌确认核心主张', creativeRoute: { hook: opportunity.hook, proof: opportunity.proof, style },
            testHypothesis: opportunity.hypothesis,
            testPlan: { control: opportunity.control, variant: opportunity.variant, constant: opportunity.constant, successSignal: opportunity.successSignal },
            applicability: { channel: brief.channel, market: snapshot.facts.market || 'English-speaking market', notFor: [] },
            facts: supporting.map(item => ({ statement: `${opportunity.basis === 'brand_context' ? '品牌官网写有' : 'Meta 公开广告页面展示'}：“${String(item.contentSummary || item.title).slice(0, 250)}”`, evidenceIds: [item.id], observedAt: item.observedAt, sourceUrl: item.sourceUrl })),
            inferences: [{ statement: '这一创意表达可能帮助受众理解产品，但效果尚未验证。', basis: supporting.length ? `仅引用本 Card 对应的 ${supporting.length} 条观察及 ${opportunity.signalIds.length} 条候选信号；不能推断广告效果。` : '本轮没有匹配证据，仅为待验证的创意假设。' }],
            assumptionsToTest: ['问题是否与目标受众有关', '产品证明是否清晰可信'],
            risksAndBoundaries: [opportunity.basis === 'brand_context' ? '官网信息仅代表品牌自述，不能作为市场或投放效果证据。' : opportunity.basis === 'public_sample' ? '公开广告仅证明样本中存在该表达；关键词相关性是初筛，不证明效果。' : '本 Card 无匹配的公开证据，仅为待验证策略草案。', ...effectiveLimitations(discovery).slice(0, 2), snapshot.facts.limitations || '投放前需确认品牌主张和素材权利。']
          },
          quality: { status: 'partial', evidenceStatus: opportunity.basis === 'brand_context' ? 'brand_context_only' : opportunity.basis === 'public_sample' ? 'traceable_small_sample' : 'insufficient', source: 'local_evidence_draft', supportingEvidenceCount: supporting.length, relevanceMethod: opportunity.relevanceMethod }, publishedAt: now()
        });
        card.currentVersionId = version.id;
        s.cards.push(card); s.cardVersions.push(version); cardIds.push(card.id);
        for (const item of supporting) s.cardEvidence.push(object(s, 'card_evidence', { cardId: card.id, cardVersionId: version.id, evidenceId: item.id, discoveryId: discovery.id, relation: 'supports' }));
      }
      cardSet.cardIds = cardIds;
      advanceCampaignStage(campaign, CampaignStage.CARDS_READY); campaign.updatedAt = now(); job.resultId = cardSet.id;
      return;
    }

    if (job.type === 'template_analysis') {
      const template = get(s, 'videoTemplates', job.input.templateId);
      const result = job.providerResult;
      requireValue(result && Number.isFinite(result.duration) && result.duration > 0 && result.duration <= 90, 'INVALID_TEMPLATE_RESULT', '无法确认参考模板时长。');
      requireValue(Number.isInteger(result.width) && result.width > 0 && Number.isInteger(result.height) && result.height > 0, 'INVALID_TEMPLATE_RESULT', '无法确认参考模板尺寸。');
      requireValue(Array.isArray(result.scenes) && result.scenes.length > 0 && result.scenes.length <= 12, 'INVALID_TEMPLATE_RESULT', '参考模板镜头结构无效。');
      requireValue(result.scenes.every(scene => Number.isFinite(scene.start) && Number.isFinite(scene.end) && scene.end >= scene.start && typeof scene.keyframeBase64 === 'string' && scene.keyframeBase64.length > 0), 'INVALID_TEMPLATE_RESULT', '参考模板关键帧不完整。');
      Object.assign(template, {
        status: 'ready', duration: result.duration, width: result.width, height: result.height,
        fps: result.fps, aspectRatio: result.aspectRatio, sceneCount: result.scenes.length,
        detector: result.detector || 'AdaptiveDetector', analysisEngine: result.analysisEngine || 'pyscenedetect-0.7.1',
        scenes: result.scenes.map((scene, index) => ({
          index, start: scene.start, end: scene.end, duration: scene.duration,
          keyframeTime: scene.keyframeTime, keyframeMime: 'image/jpeg', keyframeBase64: scene.keyframeBase64
        })),
        analyzedAt: now(), updatedAt: now()
      });
      delete template.error;
      job.resultId = template.id;
      audit(s, 'video_template_analyzed', template.id);
      return;
    }

    if (job.type === 'storyboard') {
      const request = get(s, 'generationRequests', job.input.generationRequestId);
      const config = get(s, 'configs', request.configId);
      const version = get(s, 'cardVersions', request.cardVersionId);
      const angle = get(s, 'angles', request.angleId);
      const asset = object(s, 'asset', {
        campaignId: campaign.id, packageId: request.packageId, angleId: request.angleId,
        sourceCardVersionId: version.id, sourceCardVersion: version.version, generationRequestId: request.id, configId: config.id, configVersion: config.version,
        version: Math.max(0, ...s.assets.filter(item => item.angleId === request.angleId && item.type === 'storyboard').map(item => item.version || 0)) + 1,
        type: 'storyboard', status: 'ready', source: 'local_draft', filename: 'storyboard.svg', mime: 'image/svg+xml',
        scenes: config.scenePlan || defaultScenePlan({ hook: angle.hook, proof: angle.proof }, version.content.claim)
      });
      s.assets.push(asset);
      request.status = 'succeeded'; request.safetyStatus = 'passed'; request.assetId = asset.id; request.completedAt = now();
      job.resultId = asset.id;
      audit(s, 'storyboard_created', asset.id);
    }

    if (job.type === 'video' || job.type === 'production') {
      const request = get(s, 'generationRequests', job.input.generationRequestId);
      const config = get(s, 'configs', request.configId);
      const version = get(s, 'cardVersions', request.cardVersionId);
      const result = job.providerResult;
      requireValue(result?.base64, 'VIDEO_RESULT_MISSING', '视频结果尚未下载完成。', 409);
      const asset = object(s, 'asset', {
        campaignId: campaign.id, packageId: request.packageId, angleId: request.angleId,
        sourceCardVersionId: version.id, sourceCardVersion: version.version, generationRequestId: request.id, configId: config.id, configVersion: config.version,
        version: Math.max(0, ...s.assets.filter(item => item.angleId === request.angleId && item.type === 'video').map(item => item.version || 0)) + 1,
        type: 'video', status: 'ready', source: job.type === 'production' ? 'orynt_composed' : 'youmind_seedance', mime: 'video/mp4',
        filename: result.filename || `youmind-${result.mediaId || 'video'}.mp4`, base64: result.base64, safety: 'user_review_required',
        provider: 'youmind', providerChatId: result.chatId, providerMediaId: result.mediaId,
        providerTitle: result.title || null, providerDuration: result.duration || null, providerQuality: result.quality || null, providerRatio: result.ratio || null
      });
      if (job.type === 'production') {
        requireValue(result.technical && !result.technical.issues.length, 'VIDEO_TECHNICAL_ISSUES', '剪辑结果未通过文件检查。');
        asset.technical = result.technical; asset.productionManifest = result.manifest;
        asset.qualityReview = { status: 'pending' }; asset.provider = request.localEdit ? 'local_editorial' : 'youmind_local_edit';
        request.production.phase = 'completed';
        request.production.shots[2].status = 'ready';
      }
      s.assets.push(asset);
      request.provider = job.type === 'production' ? (request.localEdit ? 'local_editorial' : 'youmind_local_edit') : 'youmind'; request.providerChatId = result.chatId; request.providerMediaId = result.mediaId;
      request.status = 'succeeded'; request.safetyStatus = 'user_review_required'; request.assetId = asset.id; request.completedAt = now();
      job.resultId = asset.id;
      audit(s, 'video_asset_created', asset.id);
    }
  }

  download(assetId) {
    return this.repo.transact(s => {
      const asset = get(s, 'assets', assetId);
      audit(s, 'asset_downloaded', asset.id);
      return asset;
    });
  }
}
