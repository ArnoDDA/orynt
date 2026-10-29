/**
 * Provider adapters are deliberately limited to translating external capability.
 * They never mutate core objects; the Core API validates and persists their output.
 */
export function providerSuccess(data, metadata = {}) {
  return { ok: true, data, externalId: metadata.externalId, rawRef: metadata.rawRef };
}

export function providerFailure({ retryable, code, safeMessage, rawRef }) {
  return { ok: false, retryable, errorCode: code, safeMessage, rawRef };
}

export function validateMarketSignal(signal) {
  const required = ["sourceType", "sourceUrl", "ingestedAt", "contentSummary", "relevanceBasis", "coverage", "rawEvidenceRef"];
  const missing = required.filter((key) => signal[key] === undefined || signal[key] === null || signal[key] === "");
  if (missing.length) throw new Error(`Market signal misses: ${missing.join(", ")}`);
  return signal;
}

export function validateCardCandidate(card, knownEvidenceIds) {
  const required = ["opportunity", "audience", "claim", "creativeRoute", "testHypothesis", "applicability", "facts", "inferences", "assumptionsToTest", "risksAndBoundaries"];
  const missing = required.filter((key) => card[key] === undefined || card[key] === null);
  if (missing.length) throw new Error(`Card candidate misses: ${missing.join(", ")}`);
  for (const fact of card.facts) {
    for (const evidenceId of fact.evidenceIds || []) {
      if (!knownEvidenceIds.has(evidenceId)) throw new Error(`Card references unknown evidence: ${evidenceId}`);
    }
  }
  return card;
}
