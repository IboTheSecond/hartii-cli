import { exactObject, identifier, invariant, timestamp, uint } from './validation.mjs';
import { qualifyCandidate } from './strategy.mjs';

const integers = ['lastCloseWei', 'fastEmaScaled', 'slowEmaScaled', 'emaSpreadBps', 'slowEmaRiseBps',
  'latest5mVolumeWei', 'volumeRatioBps', 'portfolioExposureBps'];
const bounded = { historyMinutes: [35, 10080], entryImpactBps: [0, 100], exitImpactBps: [0, 100],
  roundTripCostBps: [0, 500], entryQuoteAgeMs: [0, 30000], exitQuoteAgeMs: [0, 30000] };
export function validateModelFeatures(features) {
  const keys = ['closedAt', ...integers, ...Object.keys(bounded)];
  exactObject(features, keys, 'invalid-model-features');
  invariant(keys.every(key => Object.hasOwn(features, key)), 'invalid-model-features'); timestamp(features.closedAt);
  for (const key of integers) uint(features[key], 'model-feature');
  for (const [key, [lower, upper]] of Object.entries(bounded)) invariant(Number.isSafeInteger(features[key]) && features[key] >= lower && features[key] <= upper, 'invalid-model-features');
  return structuredClone(features);
}
/** Only public candle/quote metrics and an exposure ratio enter the model boundary. */
export function buildModelCandidate(candidate, { now, policy, finances }) {
  identifier(candidate.id);
  const qualified = qualifyCandidate(candidate, { now, policy }); invariant(qualified.qualified, 'candidate-no-longer-qualified');
  const equity = uint(finances.equityWei), exposure = uint(finances.exposureWei); invariant(equity > 0n, 'unknown-model-equity');
  return { id: candidate.id, evidence: ['verified-direct-spot', 'closed-candle-trend', 'qualified-volume', 'bounded-quote-cost'],
    features: validateModelFeatures({ ...qualified.metrics, portfolioExposureBps: (exposure * 10000n / equity).toString() }) };
}
