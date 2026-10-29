let sessionToken = null;

export class ApiError extends Error {
  constructor(message, code = 'API_ERROR', status = 500, requestId = null) {
    super(message); this.name = 'ApiError'; this.code = code; this.status = status; this.requestId = requestId;
  }
}

async function request(path, options = {}) {
  let response;
  try{response=await fetch(path, { cache: 'no-store', signal:AbortSignal.timeout(20_000), ...options });}
  catch(error){if(error.name==='TimeoutError'||error.name==='AbortError')throw new ApiError('连接超时，请刷新重试。','REQUEST_TIMEOUT',408);throw error;}
  if(response.status===401){location.assign('/login');throw new ApiError('登录已过期，请重新登录。','AUTH_REQUIRED',401);}
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(payload.error?.message || '本地服务暂时无法完成操作。', payload.error?.code, response.status, payload.requestId);
  return payload;
}

export function mapApiState(state) {
  const cardSets = new Map((state.cardSets || []).map(item => [item.id, item]));
  const versions = new Map((state.cardVersions || []).map(item => [item.id, item]));
  const packages = (state.packages || []).map(pack => ({ ...pack, cardVersion: versions.get(pack.cardVersionId)?.version || null }));
  const packageById = new Map(packages.map(item => [item.id, item]));
  const cards = (state.cardViews || []).map((card, index) => {
    const set = cardSets.get(card.cardSetId) || {};
    return {
      ...card,
      versionId: card.versionId || card.currentVersionId,
      snapshotId: state.discoveries?.find(item => item.id === set.discoveryId)?.snapshotId || null,
      briefId: set.briefId || null,
      discoveryId: set.discoveryId || null,
      priority: card.priority || (index % 3) + 1,
      evidenceStrength: !card.evidenceBasis ? '历史证据待复核' : card.quality?.evidenceStatus === 'traceable_small_sample' ? ('公开小样本' + (card.quality.supportingEvidenceCount == null ? '' : ' · ' + card.quality.supportingEvidenceCount + ' 条')) : card.quality?.evidenceStatus === 'brand_context_only' ? ('仅品牌自述' + (card.quality.supportingEvidenceCount == null ? '' : ' · ' + card.quality.supportingEvidenceCount + ' 条')) : '待验证假设'
    };
  });
  const campaigns = (state.campaigns || []).map(campaign => ({
    ...campaign, status: campaign.stage, archived: campaign.status === 'archived', lifecycleStatus: campaign.status
  }));
  const assets = (state.assets || []).map(asset => {
    const pack = packageById.get(asset.packageId) || {};
    return { ...asset, cardId: pack.cardId || null, cardVersion: asset.sourceCardVersion || pack.cardVersion || null };
  });
  const plans = (state.plans || []).map(plan => {
    const asset = assets.find(item => plan.assetIds?.includes(item.id));
    return { ...plan, cardId: packageById.get(asset?.packageId)?.cardId || null };
  });
  return {
    ...state,
    campaigns, cards, packages, assets, plans,
    metrics: state.metricSnapshots || [],
    connections: state.connections?.length ? state.connections : [{ id: 'meta-local', provider: 'Meta', status: 'disconnected', scopes: [], lastSyncedAt: null }],
    conclusions: state.conclusions || [], brandAssets: state.brandAssets || [], mappings: state.mappings || [],
    signals: state.signals || [], evidence: state.evidence || [], discoverySources: state.discoverySources || [],
    audit: state.audit || [], jobs: state.jobs || []
  };
}

export async function initializeApi() {
  const session = await request('/api/session');
  sessionToken = session.token;
  return { session, state: mapApiState(await request('/api/state')) };
}

export async function readApiState() {
  return mapApiState(await request('/api/state'));
}

export const readDemoCase = () => request('/api/demo/owala-commute');

export async function sendApiCommand(action, resourceId, data = {}) {
  if (!sessionToken) await initializeApi();
  const payload = await request('/api/commands', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Local-Session': sessionToken,
      'Idempotency-Key': crypto.randomUUID()
    },
    body: JSON.stringify({ action, resourceId, data })
  });
  return payload.result;
}

export async function waitForJob(jobId, { onState, timeoutMs = 90_000 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const state = await readApiState();
    onState?.(state);
    const job = state.jobs.find(item => item.id === jobId);
    if (!job) throw new ApiError('任务记录不存在。', 'JOB_NOT_FOUND', 404);
    if (job.status === 'succeeded') return { job, state };
    if (['failed', 'cancelled'].includes(job.status)) throw new ApiError(job.error?.message || (job.status === 'cancelled' ? '任务已取消。' : '任务未完成。'), job.error?.code || `JOB_${job.status.toUpperCase()}`, 409);
    await new Promise(resolve => setTimeout(resolve, 650));
  }
  throw new ApiError('任务仍在后台运行，可在任务中心查看进度。', 'JOB_WAIT_TIMEOUT', 408);
}
