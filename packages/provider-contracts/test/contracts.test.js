import test from "node:test";
import assert from "node:assert/strict";
import { validateCardCandidate, validateMarketSignal } from "../src/index.js";

test("rejects a signal without traceable source fields", () => {
  assert.throws(() => validateMarketSignal({ sourceType: "website" }), /sourceUrl/);
});

test("does not allow a Card fact to cite unknown evidence", () => {
  const card = {
    opportunity: "Opportunity", audience: "Audience", claim: "Claim", creativeRoute: {}, testHypothesis: "Hypothesis",
    applicability: {}, facts: [{ statement: "Fact", evidenceIds: ["evidence_unknown"] }],
    inferences: [], assumptionsToTest: [], risksAndBoundaries: []
  };
  assert.throws(() => validateCardCandidate(card, new Set()), /unknown evidence/);
});
