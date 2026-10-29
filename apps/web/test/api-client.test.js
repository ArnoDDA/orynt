import test from 'node:test';
import assert from 'node:assert/strict';
import { mapApiState } from '../public/api-client.js';

test('API state maps lifecycle and Card versions to the existing UI model', () => {
  const mapped = mapApiState({
    campaigns: [{ id: 'c1', stage: 'cards_ready', status: 'active' }],
    discoveries: [{ id: 'd1', snapshotId: 's1' }],
    cardSets: [{ id: 'set1', discoveryId: 'd1', briefId: 'b1' }],
    cards: [{ id: 'card1', cardSetId: 'set1', currentVersionId: 'v1' }],
    cardVersions: [{ id: 'v1', version: 1 }],
    cardViews: [{ id: 'card1', cardSetId: 'set1', currentVersionId: 'v1', version: 1, title: 'Card', evidenceBasis: 'brand_context', quality: { evidenceStatus: 'brand_context_only' } }],
    packages: [{ id: 'p1', cardId: 'card1', cardVersionId: 'v1' }],
    assets: [{ id: 'a1', packageId: 'p1', sourceCardVersion: 1 }],
    plans: [{ id: 'plan1', assetIds: ['a1'] }]
  });
  assert.equal(mapped.campaigns[0].status, 'cards_ready');
  assert.equal(mapped.campaigns[0].archived, false);
  assert.equal(mapped.cards[0].snapshotId, 's1');
  assert.equal(mapped.cards[0].evidenceStrength, '仅品牌自述');
  assert.equal(mapApiState({ cardViews: [{ id: 'legacy', quality: { evidenceStatus: 'traceable_small_sample' } }] }).cards[0].evidenceStrength, '历史证据待复核');
  assert.equal(mapped.assets[0].cardId, 'card1');
  assert.equal(mapped.plans[0].cardId, 'card1');
  assert.equal(mapped.connections[0].status, 'disconnected');
});
