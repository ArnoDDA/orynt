export const CampaignStatus = Object.freeze({
  DRAFT: "draft",
  DISCOVERING: "discovering",
  CARDS_READY: "cards_ready",
  CREATING: "creating",
  LAUNCH_READY: "launch_ready",
  LEARNING: "learning",
  CLOSED: "closed"
});

export const CardStatus = Object.freeze({
  CANDIDATE: "candidate",
  REVIEWED: "reviewed",
  ADOPTED: "adopted",
  DISMISSED: "dismissed",
  SUPERSEDED: "superseded"
});

export const AssetStatus = Object.freeze({
  DRAFT: "draft",
  GENERATING: "generating",
  READY: "ready",
  PARTIAL_FAILED: "partial_failed",
  FAILED: "failed",
  LAUNCH_READY: "launch_ready",
  ARCHIVED: "archived"
});

const transitions = {
  campaign: {
    [CampaignStatus.DRAFT]: [CampaignStatus.DISCOVERING],
    [CampaignStatus.DISCOVERING]: [CampaignStatus.CARDS_READY],
    [CampaignStatus.CARDS_READY]: [CampaignStatus.CREATING],
    [CampaignStatus.CREATING]: [CampaignStatus.LAUNCH_READY],
    [CampaignStatus.LAUNCH_READY]: [CampaignStatus.LEARNING],
    [CampaignStatus.LEARNING]: [CampaignStatus.CLOSED]
  },
  card: {
    [CardStatus.CANDIDATE]: [CardStatus.REVIEWED, CardStatus.ADOPTED, CardStatus.DISMISSED],
    [CardStatus.REVIEWED]: [CardStatus.ADOPTED, CardStatus.DISMISSED],
    [CardStatus.ADOPTED]: [CardStatus.SUPERSEDED],
    [CardStatus.DISMISSED]: [CardStatus.SUPERSEDED]
  },
  asset: {
    [AssetStatus.DRAFT]: [AssetStatus.GENERATING],
    [AssetStatus.GENERATING]: [AssetStatus.READY, AssetStatus.PARTIAL_FAILED, AssetStatus.FAILED],
    [AssetStatus.READY]: [AssetStatus.LAUNCH_READY, AssetStatus.ARCHIVED],
    [AssetStatus.PARTIAL_FAILED]: [AssetStatus.GENERATING, AssetStatus.ARCHIVED],
    [AssetStatus.FAILED]: [AssetStatus.GENERATING, AssetStatus.ARCHIVED],
    [AssetStatus.LAUNCH_READY]: [AssetStatus.ARCHIVED]
  }
};

export function canTransition(entity, from, to) {
  return transitions[entity]?.[from]?.includes(to) ?? false;
}

export function requireTransition(entity, from, to) {
  if (!canTransition(entity, from, to)) {
    throw new Error(`Invalid ${entity} transition: ${from} → ${to}`);
  }
}

export function createId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function now() {
  return new Date().toISOString();
}

export * from './product-model.js';

export function createCampaign({ workspaceId, brandUrl, objective }) {
  if (!workspaceId || !brandUrl) throw new Error("workspaceId and brandUrl are required");
  const brandId = createId("brand");
  return {
    id: createId("campaign"),
    workspaceId,
    brandId,
    brandSnapshotId: createId("brand_snapshot"),
    brandUrl,
    objective: objective?.trim() || "Explore the next campaign opportunity",
    status: CampaignStatus.DRAFT,
    createdAt: now(),
    updatedAt: now()
  };
}
