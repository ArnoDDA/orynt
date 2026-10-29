export const PRODUCT_SCHEMA_VERSION = 4;

export const CampaignStage = Object.freeze({
  DRAFT: 'draft',
  DISCOVERING: 'discovering',
  CARDS_READY: 'cards_ready',
  CREATING: 'creating',
  LAUNCH_READY: 'launch_ready',
  LEARNING: 'learning',
  CLOSED: 'closed'
});

export const CampaignLifecycleStatus = Object.freeze({
  ACTIVE: 'active',
  BLOCKED: 'blocked',
  ARCHIVED: 'archived',
  DELETED: 'deleted'
});

export const productCollections = Object.freeze([
  'brands', 'brandFacts', 'brandAssets', 'snapshots', 'campaigns', 'briefs',
  'discoveries', 'discoverySources', 'signals', 'evidence', 'signalFeedback',
  'collectionBatches', 'cardSets', 'cards', 'cardVersions', 'cardEvidence', 'packages', 'angles', 'videoTemplates', 'configs',
  'generationRequests', 'assets', 'jobs', 'plans', 'connections', 'mappings',
  'metricSnapshots', 'conclusions', 'feedback', 'audit'
]);

export function createEmptyProductState() {
  const state = {
    schemaVersion: PRODUCT_SCHEMA_VERSION,
    workspace: {
      id: 'local', name: '我的工作空间', role: 'owner', mode: 'local_guest',
      localOnly: true, retention: 'until_manual_clear', createdAt: new Date().toISOString()
    },
    commands: {}
  };
  for (const collection of productCollections) state[collection] = [];
  return state;
}

export function normalizeProductState(input = {}) {
  const state = { ...createEmptyProductState(), ...input };
  state.workspace ||= { id: 'local', name: '我的工作空间', role: 'owner', mode: 'local_guest' };
  state.workspace.localOnly = true;
  state.workspace.retention ||= 'until_manual_clear';
  state.workspace.createdAt ||= new Date().toISOString();
  for (const collection of productCollections) {
    if (!Array.isArray(state[collection])) state[collection] = [];
  }
  if (!state.commands || typeof state.commands !== 'object' || Array.isArray(state.commands)) state.commands = {};
  for (const campaign of state.campaigns) {
    if (!campaign.stage) {
      campaign.stage = ['draft', 'discovering', 'cards_ready', 'creating', 'launch_ready', 'learning', 'closed'].includes(campaign.status)
        ? campaign.status
        : CampaignStage.DRAFT;
      campaign.status = campaign.archived || campaign.stage === CampaignStage.CLOSED
        ? CampaignLifecycleStatus.ARCHIVED
        : CampaignLifecycleStatus.ACTIVE;
    }
    delete campaign.archived;
  }
  if (!state.cardVersions.length && state.cards.some(card => card.versionId)) {
    const legacyCards = state.cards;
    state.cards = [];
    for (const legacy of legacyCards) {
      const content = {};
      for (const key of ['title', 'opportunity', 'audience', 'claim', 'creativeRoute', 'testHypothesis', 'applicability', 'facts', 'inferences', 'assumptionsToTest', 'risksAndBoundaries']) {
        if (legacy[key] !== undefined) content[key] = legacy[key];
      }
      const versionId = legacy.versionId;
      state.cardVersions.push({
        id: versionId,
        workspaceId: legacy.workspaceId || state.workspace.id,
        cardId: legacy.id,
        version: legacy.version || 1,
        status: 'published',
        content,
        quality: { status: legacy.evidenceStatus === 'insufficient' ? 'partial' : 'passed', evidenceStatus: legacy.evidenceStatus || 'unknown', source: legacy.source || 'legacy' },
        createdAt: legacy.createdAt,
        publishedAt: legacy.createdAt
      });
      state.cards.push({
        id: legacy.id,
        workspaceId: legacy.workspaceId || state.workspace.id,
        campaignId: legacy.campaignId,
        cardSetId: legacy.cardSetId || null,
        status: legacy.status,
        saved: Boolean(legacy.saved),
        currentVersionId: versionId,
        adoptedVersionId: legacy.status === 'adopted' ? versionId : null,
        createdAt: legacy.createdAt
      });
    }
  }
  for (const pack of state.packages) {
    pack.status ||= 'active';
    if (!state.angles.some(angle => angle.packageId === pack.id) && pack.angle) {
      state.angles.push({
        id: `angle_legacy_${pack.id}`,
        workspaceId: pack.workspaceId || state.workspace.id,
        packageId: pack.id,
        position: 1,
        name: '原始创意角度',
        hook: pack.angle.hook || '',
        proof: pack.angle.proof || '',
        visualLanguage: pack.angle.style || '',
        status: 'active',
        createdAt: pack.createdAt
      });
      delete pack.angle;
    }
  }
  for (const config of state.configs) {
    config.angleId ||= state.angles.find(angle => angle.packageId === config.packageId)?.id || null;
    config.status ||= 'frozen';
  }
  for (const asset of state.assets) {
    asset.angleId ||= state.angles.find(angle => angle.packageId === asset.packageId)?.id || null;
    asset.sourceCardVersionId ||= asset.cardVersionId || state.packages.find(pack => pack.id === asset.packageId)?.cardVersionId || null;
    asset.sourceCardVersion ||= asset.cardVersion || state.cardVersions.find(version => version.id === asset.sourceCardVersionId)?.version || null;
    if (!asset.generationRequestId) {
      const request = {
        id: `generation_request_legacy_${asset.id}`,
        workspaceId: asset.workspaceId || state.workspace.id,
        campaignId: asset.campaignId,
        packageId: asset.packageId,
        angleId: asset.angleId,
        configId: asset.configId,
        cardVersionId: asset.sourceCardVersionId,
        mode: asset.type,
        provider: asset.source || 'legacy',
        status: 'succeeded',
        safetyStatus: asset.safety || 'unknown',
        assetId: asset.id,
        createdAt: asset.createdAt,
        completedAt: asset.createdAt
      };
      state.generationRequests.push(request);
      asset.generationRequestId = request.id;
    }
  }
  for (const campaign of state.campaigns) {
    campaign.selectedCardVersionId ||= state.cards.find(card => card.campaignId === campaign.id && card.status === 'adopted')?.adoptedVersionId || null;
  }
  state.schemaVersion = PRODUCT_SCHEMA_VERSION;
  return state;
}

export function isCampaignWritable(campaign) {
  return campaign.status === CampaignLifecycleStatus.ACTIVE && campaign.stage !== CampaignStage.CLOSED;
}

const stageOrder = Object.values(CampaignStage);
export function advanceCampaignStage(campaign, nextStage) {
  if (!stageOrder.includes(nextStage)) throw new Error(`Unknown Campaign stage: ${nextStage}`);
  if (stageOrder.indexOf(nextStage) > stageOrder.indexOf(campaign.stage)) campaign.stage = nextStage;
  return campaign.stage;
}
