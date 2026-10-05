// packages/agent-mcp/src/errors.js
//
// Turns a raw quais/RPC/network error into a short, typed, actionable message — the model driving
// this MCP server (and whoever reads its output) should never have to parse
// `CALL_EXCEPTION: execution reverted (reason="0x...", data="0x08c379...")`-style quais internals
// to understand what happened. Pure and dependency-light: takes any error-shaped value, returns a
// plain string. Never throws.
//
// The revert-reason dictionary below is generated from this repo's own Solidity `require(...,
// "reason")` strings — AgentVault.sol (the vault's own on-chain allowlist/caps), BondingCurve*.sol
// (buy/sell), and HartiiSwapRouter.sol/HartiiSwapLibrary.sol (swap/liquidity) — see
// contracts/contracts/agent/AgentVault.sol, contracts/contracts/BondingCurveV3.sol and
// contracts/contracts/swap/HartiiSwapRouter.sol. Keep this in sync if those revert strings change.

/** Exact-match revert reasons this codebase's own contracts throw, mapped to a plain-English cause. */
const EXACT_REASONS = {
  // AgentVault.sol — the vault's own on-chain allowlist/caps/ownership checks.
  'not agent': 'This key is not the vault\'s configured agent — check that the vault\'s agent address matches this key.',
  'not owner': 'This key is not the vault\'s owner.',
  paused: 'The vault is paused by its owner.',
  reentrant: 'The vault refused a reentrant call.',
  'per-tx cap': 'This trade\'s value exceeds the vault\'s per-transaction cap.',
  'daily cap': 'This trade would exceed the vault\'s remaining rolling-24h cap — try a smaller size or wait for it to free up.',
  target: 'The vault\'s on-chain allowlist rejected this call\'s target contract.',
  selector: 'The vault\'s on-chain allowlist rejected this call\'s function.',
  spender: 'The vault\'s on-chain allowlist rejected this approval\'s spender.',
  recipient: 'The vault\'s on-chain allowlist rejected this call — the output must come back to the vault itself.',
  hop: 'The vault\'s on-chain allowlist rejected this swap path — no real pool for one of its hops.',
  path: 'This swap path is invalid (must be 2-3 hops).',
  value: 'This call is not allowed to send QUAI.',
  caps: 'Invalid cap values (per-tx cap cannot exceed the daily cap).',
  // BondingCurve/BondingCurveV2/BondingCurveV3 — buy/sell/addLiquidity/removeLiquidity.
  Slippage: 'Price moved beyond your slippage tolerance — the expected minimum output was not met.',
  expired: 'The transaction\'s deadline passed before it was mined — try again.',
  'Insufficient pool liquidity': 'Not enough pool liquidity for this trade size.',
  'Insufficient shares': 'Not enough LP shares held for this removal.',
};

/** Substring heuristics for prefixed/varied reasons (e.g. HartiiSwapRouter's "HartiiSwapRouter: EXPIRED"). */
const SUBSTRING_RULES = [
  [/insufficient_output_amount|excessive_input_amount/i, 'Price moved beyond your slippage tolerance — the expected minimum output was not met.'],
  [/insufficient.*liquidity/i, 'Not enough pool liquidity for this trade size.'],
  [/expired/i, 'The transaction\'s deadline passed before it was mined — try again.'],
  [/invalid_path|invalid path/i, 'This swap path is invalid.'],
  [/identical_addresses|zero_address/i, 'Invalid token pair.'],
  [/pair_not_found/i, 'No liquidity pool exists for this pair yet.'],
  [/transferhelper/i, 'A token transfer/approve failed (the token may be non-standard or paused).'],
];

/** Pulls the Solidity revert reason string out of whatever shape quais/the RPC handed back. */
function extractRevertReason(err) {
  if (!err) return null;
  if (typeof err.reason === 'string' && err.reason) return err.reason;
  if (typeof err.shortMessage === 'string' && err.shortMessage) {
    const m = err.shortMessage.match(/execution reverted:?\s*"?([^"]+)"?/i);
    if (m) return m[1].trim();
  }
  const msg = typeof err.message === 'string' ? err.message : '';
  const m = msg.match(/(?:execution reverted|revert(?:ed)?):?\s*"?([^"(]+)"?/i);
  if (m && m[1].trim()) return m[1].trim();
  return null;
}

function classifyReason(reason) {
  if (!reason) return null;
  if (Object.prototype.hasOwnProperty.call(EXACT_REASONS, reason)) return EXACT_REASONS[reason];
  for (const [pattern, message] of SUBSTRING_RULES) {
    if (pattern.test(reason)) return message;
  }
  return null;
}

/** Non-revert (network/provider/wallet-level) error classification, checked when no revert reason decodes. */
const TRANSPORT_RULES = [
  [/insufficient funds/i, 'Insufficient QUAI in the vault to cover this transaction\'s gas and value.'],
  [/nonce.*(too low|already used|expired)|already known/i, 'Nonce conflict — another transaction from this key may already be in flight. Try again shortly.'],
  [/underpriced|replacement transaction/i, 'Gas price too low to replace a pending transaction from this key.'],
  [/gas required exceeds allowance|out of gas|intrinsic gas too low/i, 'This transaction needs more gas than allotted.'],
  [/rate limit|429|too many requests/i, 'The RPC is rate-limiting requests — try again shortly.'],
  [/timeout|timed out/i, 'The Quai RPC did not respond in time.'],
  [/econnrefused|enotfound|network|fetch failed|abort/i, 'Could not reach the Quai RPC — check your connection and try again.'],
  [/(?:^|\s)(50\d)(?:\s|$)|server error|bad gateway|service unavailable/i, 'The Quai RPC returned a server error — try again shortly.'],
];

/**
 * @param {any} err whatever was thrown/rejected — a quais error, a raw JSON-RPC error, a plain
 *   network Error, or anything else.
 * @param {{ stage?: string }} [opts] optional stage label ('simulate'|'send'|'wait'|'read') folded
 *   into the fallback message when nothing more specific is known.
 * @returns {string} a short, actionable message — never throws, never returns empty.
 */
export function classifyError(err, opts = {}) {
  if (err === null || err === undefined) return 'Unknown error.';
  const reason = extractRevertReason(err);
  const byReason = classifyReason(reason);
  if (byReason) return byReason;

  const raw = (typeof err === 'string' ? err : err?.message) || String(err);
  for (const [pattern, message] of TRANSPORT_RULES) {
    if (pattern.test(raw)) return message;
  }

  // Nothing matched a known pattern — surface the raw message rather than hide it (still better
  // than an unhandled exception), but keep it short and prefixed so it reads as "unclassified"
  // rather than implying this server understood exactly what happened.
  const stage = opts.stage ? `${opts.stage}: ` : '';
  const short = raw.length > 220 ? `${raw.slice(0, 217)}...` : raw;
  return reason ? `${stage}on-chain revert "${reason}".` : `${stage}${short || 'unknown error'}`;
}
