import { address, canonicalJson, exactObject, identifier, invariant, timestamp, uint } from './validation.mjs';
export const HBOME_TOKEN = '0x001fA4fdb848BB8C98B0d6Cd85257EfcCAe3b425';
export const VENUES = Object.freeze(['curve-v1', 'curve-v2', 'curve-v3', 'curve-v4', 'hartii-swap']);
const caps = { maxEntryBps: 1000, maxExposureBps: 3000, maxDailyLossBps: 500, maxPositions: 3,
  maxSlippageBps: 100, maxImpactBps: 100, maxRoundTripCostBps: 500 };
const keys = ['schemaVersion', 'owner', 'tradingWallet', 'runnerId', 'chainId', 'nonce', 'issuedAt', 'expiresAt',
  'capitalWei', 'maxPerTxWei', 'maxPerDayWei', 'maxFeeWei', ...Object.keys(caps), 'slippageBps',
  'modelCycleMicrousd', 'modelDailyMicrousd', 'allowedVenues', 'allowedActions'];
export function validatePolicy(policy, { now = Date.now(), owner, tradingWallet, runnerId } = {}) {
  exactObject(policy, keys, 'invalid-policy-fields');
  invariant(keys.every(key => Object.hasOwn(policy, key)), 'missing-policy-field');
  invariant(policy.schemaVersion === 1 && policy.chainId === 9, 'invalid-policy-network-version');
  address(policy.owner); address(policy.tradingWallet); identifier(policy.runnerId); uint(policy.nonce, 'nonce');
  invariant(policy.owner.toLowerCase() !== policy.tradingWallet.toLowerCase(), 'separate-wallet-required');
  for (const [key, expected] of Object.entries({ owner, tradingWallet, runnerId })) {
    if (expected !== undefined) invariant(key === 'runnerId' ? expected === policy[key] : expected.toLowerCase() === policy[key].toLowerCase(), 'policy-identity-mismatch');
  }
  timestamp(now); timestamp(policy.issuedAt); timestamp(policy.expiresAt);
  invariant(policy.issuedAt <= now && policy.expiresAt > now && policy.expiresAt - policy.issuedAt <= 86400000, 'policy-expired-or-invalid-window');
  for (const key of ['capitalWei', 'maxPerTxWei', 'maxPerDayWei', 'maxFeeWei']) invariant(uint(policy[key], key) > 0n, 'positive-budget-required');
  invariant(uint(policy.maxPerTxWei) <= uint(policy.capitalWei) && uint(policy.maxPerTxWei) <= uint(policy.maxPerDayWei), 'inconsistent-budget');
  for (const [key, cap] of Object.entries(caps)) invariant(Number.isSafeInteger(policy[key]) && policy[key] > 0 && policy[key] <= cap, `invalid-${key}`);
  invariant(Number.isSafeInteger(policy.slippageBps) && policy.slippageBps >= 0 && policy.slippageBps <= policy.maxSlippageBps, 'invalid-slippage');
  invariant(uint(policy.modelCycleMicrousd) <= 100000n && uint(policy.modelDailyMicrousd) <= 1000000n && uint(policy.modelCycleMicrousd) <= uint(policy.modelDailyMicrousd), 'invalid-model-budget');
  for (const [key, allowed] of [['allowedVenues', VENUES], ['allowedActions', ['buy', 'sell']]]) {
    invariant(Array.isArray(policy[key]) && policy[key].length > 0 && new Set(policy[key]).size === policy[key].length && policy[key].every(v => allowed.includes(v)), `invalid-${key}`);
  }
  return structuredClone(policy);
}
export function createPolicy(explicit) {
  const now = explicit?.issuedAt ?? Date.now();
  const policy = { schemaVersion: 1, chainId: 9, ...caps, slippageBps: 50, modelCycleMicrousd: '100000',
    modelDailyMicrousd: '1000000', allowedVenues: [...VENUES], allowedActions: ['buy', 'sell'], ...explicit };
  return validatePolicy(policy, { now });
}
export function canonicalPolicyMessage(policy) {
  validatePolicy(policy, { now: policy?.issuedAt });
  return `hartii-trader-policy:v1\n${canonicalJson(policy)}`;
}
