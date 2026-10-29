// SPDX-License-Identifier: AGPL-3.0-only
// Adapted from calesthio/OpenMontage, e01dbf433f46eeb91d39bf905e194162921019a3:
// lib/slideshow_risk.py and lib/delivery_promise.py.
// See third_party/openmontage/{NOTICE,LICENSE} for attribution and license.
// JavaScript port: return structured diagnostics and weight delivery by time.
const clamp = n => Math.min(5, n);
const dominantRatio = values => {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  return Math.max(...counts.values()) / values.length;
};

// These are plan heuristics, not a visual-model judgment of rendered footage.
export function scoreSlideshowRisk(scenes, rendererFamily = '') {
  if (!scenes.length) return { average: 5, verdict: 'fail', dimensions: {} };
  const count = scenes.length;
  const typeRatio = dominantRatio(scenes.map(s => s.type || 'unknown'));
  const descriptions = scenes.map(s => (s.description || '').toLowerCase().slice(0, 50));
  const uniqueRatio = new Set(descriptions).size / count;
  const sizeRatio = dominantRatio(scenes.map(s => s.shot_language?.shot_size || 'none'));
  const repetition = count < 3 ? 0 : clamp((typeRatio > .7 ? 2 : 0) + (uniqueRatio < .6 ? 1.5 : 0) + (sizeRatio > .6 ? 1.5 : 0));
  const decorative = scenes.filter(s => !s.information_role && !s.narrative_role && !s.shot_intent).length / count;
  const moving = scenes.filter(s => !['static', 'unspecified', null, undefined].includes(s.shot_language?.camera_movement));
  const weakMotion = moving.length ? clamp(moving.filter(s => !s.shot_intent).length / moving.length * 4) : 1.5;
  const weakIntent = clamp((1 - scenes.filter(s => s.shot_intent).length / count) * 5);
  const textRatio = scenes.filter(s => ['text_card', 'stat_card', 'kpi_grid'].includes(s.type)).length / count;
  const typography = textRatio > .6 ? 4 : textRatio > .4 ? 2.5 : textRatio > .2 ? 1 : 0;
  const cinematicIssues = !rendererFamily.toLowerCase().includes('cinematic') ? 0 :
    Number(!scenes.some(s => s.hero_moment)) + Number(moving.length < count * .3) +
    Number(scenes.filter(s => s.shot_language?.lighting_key).length < count * .3);
  const dimensions = {
    repetition, decorative_visuals: Math.round(decorative * 50) / 10,
    weak_motion: Math.round(weakMotion * 10) / 10, weak_shot_intent: Math.round(weakIntent * 10) / 10,
    typography_overreliance: typography, unsupported_cinematic_claims: clamp(cinematicIssues * 1.8)
  };
  const average = Object.values(dimensions).reduce((a, b) => a + b, 0) / 6;
  return { average: Math.round(average * 100) / 100, verdict: average < 2 ? 'strong' : average < 3 ? 'acceptable' : average < 4 ? 'revise' : 'fail', dimensions };
}

// Upstream motion_led policy: >=70% motion, no silent still-led substitution.
// The caller must establish media evidence; an extension/type label is not proof.
// Measure the edited timeline rather than cut count (a short tail card is valid).
export function validateMotionDelivery(cuts, { minMotionRatio = .7, stillFallbackAllowed = false } = {}) {
  const total = cuts.reduce((sum, cut) => sum + cut.duration, 0);
  if (!cuts.length || cuts.some(c => !Number.isFinite(c.duration) || c.duration <= 0) || !Number.isFinite(total) || total <= 0) {
    return { valid: false, violations: ['invalid_timeline'], motionRatio: 0, motionSeconds: 0, totalSeconds: 0 };
  }
  const motionSeconds = cuts.filter(c => c.motion === true).reduce((sum, c) => sum + c.duration, 0);
  const motionRatio = motionSeconds / total;
  const violations = [];
  if (motionRatio + 1e-9 < minMotionRatio) violations.push('insufficient_motion');
  if (!stillFallbackAllowed && motionSeconds < total / 2) violations.push('still_led_fallback');
  return { valid: !violations.length, violations, motionRatio, motionSeconds, totalSeconds: total };
}
