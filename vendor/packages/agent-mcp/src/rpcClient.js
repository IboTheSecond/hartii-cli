// packages/agent-mcp/src/rpcClient.js
//
// RPC failover for IDEMPOTENT READS ONLY — never wire this up behind a transaction broadcast
// (quai_sendRawTransaction), which must go through the wallet exactly once (see execute.js's
// header note on pre-broadcast-only retries). Two independent paths to the same chain
// (Quai mainnet, Cyprus-1):
//   1. `primary()` — typically a call through the already-configured quais Provider (respects a
//      user's HARTII_RPC override, keeps quais' own request/response typing for that path).
//   2. a raw JSON-RPC POST to DEFAULT_PROXY_RPC_URL, Hartii's own same-origin RPC relay
//      (functions/_lib/chain.js's server-side counterpart; workers/rpc-proxy in the main repo) —
//      independent infra, always Cyprus-1 mainnet.
// Safe to fail over to (2) specifically because config.js's assertChainId already gates the
// PRIMARY rpcUrl to chain id 9 (Quai mainnet) at boot — by the time any read reaches here, both
// paths are known-good members of the same chain, just different infrastructure.
//
// Deliberately NOT used by config.js's assertChainId itself: that check's entire job is to catch a
// MISCONFIGURED rpcUrl (e.g. pointed at Orchard by mistake), so it must only ever evaluate the
// exact URL it was given — substituting a known-good fallback there would silently defeat the
// check it exists to perform.
export const DEFAULT_PROXY_RPC_URL = 'https://hartiilabs.com/rpc/';

function jitterMs(attempt) {
  return 60 + Math.floor(Math.random() * 120) + attempt * 50;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One raw JSON-RPC POST, bounded by `timeoutMs`. Throws on transport failure, HTTP non-2xx, or a JSON-RPC `error`. */
async function rawRpcPost(url, method, params, timeoutMs) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`rpc http ${res.status}`);
  const body = await res.json();
  if (!body || body.error) throw new Error(body?.error?.message || `${method} returned an error`);
  if (body.result === undefined) throw new Error(`${method} returned no result`);
  return body.result;
}

/**
 * Resilient wrapper for ONE idempotent JSON-RPC read. Tries `primary()` up to `primaryAttempts`
 * times (jittered delay between attempts, tolerating a transient blip on the user's own configured
 * RPC), then falls back to a raw POST against `proxyUrl`. Bounded total work: at most
 * `primaryAttempts + 1` network attempts. Never call this for a method that broadcasts a
 * transaction.
 *
 * @param {() => Promise<any>} primary reads through the already-configured provider/connection
 * @param {{ method: string, params?: any[], proxyUrl?: string, timeoutMs?: number, primaryAttempts?: number }} opts
 *   `method`/`params` describe the SAME read for the raw JSON-RPC fallback call.
 * @returns {Promise<any>}
 */
export async function resilientRead(primary, opts) {
  const { method, params = [], proxyUrl = DEFAULT_PROXY_RPC_URL, timeoutMs = 8000, primaryAttempts = 2 } = opts || {};
  let lastErr;
  for (let attempt = 0; attempt < primaryAttempts; attempt += 1) {
    try {
      return await primary();
    } catch (err) {
      lastErr = err;
      if (attempt < primaryAttempts - 1) await wait(jitterMs(attempt));
    }
  }
  if (!proxyUrl || !method) throw lastErr || new Error('resilientRead: all primary attempts failed');
  try {
    return await rawRpcPost(proxyUrl, method, params, timeoutMs);
  } catch (err) {
    // Prefer the proxy's own failure (freshest signal), but never lose the primary's error entirely.
    err.cause = err.cause || lastErr;
    throw err;
  }
}
