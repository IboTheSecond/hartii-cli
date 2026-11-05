import { profilePaths, readPrivateJson, writePrivateJson } from './storage.js';

export const DEFAULT_SLIPPAGE_BPS = 100; // conservative; legacy profiles without a stored value
const KEEP = 50;
/** Effective slippage: the profile's value, never above the owner-signed policy ceiling (maxSlippageBps). */
export function traderSlippageBps(profile, policy) {
  const own = Number.isSafeInteger(profile?.slippageBps) && profile.slippageBps > 0 ? profile.slippageBps : DEFAULT_SLIPPAGE_BPS;
  return Math.min(own, policy.maxSlippageBps);
}
const fields = ['type', 'at', 'token', 'side', 'quoted', 'minOut', 'attempted'];
export function readSlippageSkips(opts = {}, deps = {}) {
  const list = readPrivateJson(profilePaths(opts, deps).slippageSkips, { optional: true });
  return (Array.isArray(list) ? list : []).map(e => Object.fromEntries(fields.map(k => [k, e?.[k] ?? null])));
}
export function recordSlippageSkip(opts, event, deps = {}) {
  const paths = profilePaths(opts, deps);
  const next = [...readSlippageSkips(opts, deps), { ...event, type: 'slippage_skip' }].slice(-KEEP);
  writePrivateJson(paths.slippageSkips, next.map(e => Object.fromEntries(fields.map(k => [k, e[k] ?? null]))));
}
