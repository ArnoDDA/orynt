import test from "node:test";
import assert from "node:assert/strict";
import { AssetStatus, CampaignStatus, canTransition, createCampaign, requireTransition } from "../src/index.js";

test("allows the P0-A campaign path", () => {
  assert.equal(canTransition("campaign", CampaignStatus.DRAFT, CampaignStatus.DISCOVERING), true);
  assert.equal(canTransition("campaign", CampaignStatus.DISCOVERING, CampaignStatus.CARDS_READY), true);
  assert.equal(canTransition("campaign", CampaignStatus.CARDS_READY, CampaignStatus.CREATING), true);
});

test("rejects a campaign shortcut", () => {
  assert.throws(() => requireTransition("campaign", CampaignStatus.DRAFT, CampaignStatus.CREATING));
});

test("does not allow an asset to launch before it is ready", () => {
  assert.equal(canTransition("asset", AssetStatus.GENERATING, AssetStatus.LAUNCH_READY), false);
});

test("creates a campaign with an immutable snapshot reference", () => {
  const campaign = createCampaign({ workspaceId: "workspace_local", brandUrl: "https://example.com" });
  assert.match(campaign.id, /^campaign_/);
  assert.match(campaign.brandSnapshotId, /^brand_snapshot_/);
  assert.equal(campaign.status, CampaignStatus.DRAFT);
});
