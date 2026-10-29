import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProductState } from '../src/product-model.js';

test('upgrades the previous local state without losing Card and Asset lineage', () => {
  const state = normalizeProductState({
    schemaVersion: 1,
    workspace: { id: 'local' },
    campaigns: [{ id: 'campaign-1', workspaceId: 'local', status: 'creating', archived: false }],
    cards: [{
      id: 'card-1', workspaceId: 'local', campaignId: 'campaign-1', versionId: 'card-version-1', version: 1,
      status: 'adopted', title: '旧 Card', creativeRoute: { hook: 'Hook', proof: 'Proof', style: '产品演示' }, createdAt: '2026-09-14T00:00:00Z'
    }],
    packages: [{ id: 'package-1', workspaceId: 'local', campaignId: 'campaign-1', cardId: 'card-1', cardVersionId: 'card-version-1', angle: { hook: 'Hook', proof: 'Proof', style: '产品演示' }, createdAt: '2026-09-14T00:00:00Z' }],
    assets: [{ id: 'asset-1', workspaceId: 'local', campaignId: 'campaign-1', packageId: 'package-1', cardVersionId: 'card-version-1', cardVersion: 1, type: 'storyboard', status: 'ready', source: 'legacy', createdAt: '2026-09-14T00:00:00Z' }]
  });

  assert.equal(state.schemaVersion, 4);
  assert.deepEqual(state.collectionBatches, []);
  assert.deepEqual(state.cardEvidence, []);
  assert.equal(state.campaigns[0].stage, 'creating');
  assert.equal(state.campaigns[0].status, 'active');
  assert.equal(state.cardVersions[0].cardId, 'card-1');
  assert.equal(state.angles[0].packageId, 'package-1');
  assert.equal(state.assets[0].sourceCardVersionId, 'card-version-1');
  assert.equal(state.generationRequests[0].assetId, 'asset-1');
});
