// packages/hartii-cli/src/gasPrice.js
//
// quais' provider.getFeeData() FAILS against the zone-pinned Cyprus-1 URL ("Invalid shard" / "could not determine
// gasPrice"; verified live 2026-10-05) and logs a stack trace to stderr while doing so. So: ask the provider once
// (quiet), and on failure fall back to a raw quai_gasPrice JSON-RPC read against the SAME configured RPC URL (an
// idempotent read; packages/agent-mcp/src/execute.js relies on the same fallback). Used by every write and `hartii gas`.

async function rawGasPrice(rpcUrl, timeoutMs = 8000) {
  const res = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'quai_gasPrice', params: [] }), signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
  const body = await res.json();
  if (!body || body.error || typeof body.result !== 'string' || !/^0x[0-9a-fA-F]+$/.test(body.result)) throw new Error('quai_gasPrice returned no usable result');
  return BigInt(body.result);
}

async function quietly(fn) {
  const names = ['error', 'warn', 'log', 'info', 'debug'];
  const saved = names.map((n) => console[n]);
  for (const n of names) console[n] = () => {};
  try { return await fn(); } finally { names.forEach((n, i) => { console[n] = saved[i]; }); }
}

/**
 * @param {{ getFeeData: () => Promise<{ gasPrice: bigint }> }} provider
 * @param {string} [rpcUrl] the configured RPC (the raw fallback target)
 * @returns {Promise<bigint>} wei
 */
export async function readGasPrice(provider, rpcUrl) {
  let n = null;
  let providerError;
  try { n = BigInt((await quietly(() => provider.getFeeData())).gasPrice); } catch (err) { providerError = err; }
  if (n === null) {
    if (!rpcUrl) throw providerError;
    try { n = await rawGasPrice(rpcUrl); } catch { throw providerError; }
  }
  if (n <= 0n) throw new Error('RPC returned a non-positive gas price.');
  return n;
}
