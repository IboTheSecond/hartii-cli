// packages/hartii-cli/src/gasPrice.js
//
// quais requires a zone even for a zone-pinned URL. Ask for Cyprus-1 explicitly; on a transport failure,
// fall back to the same configured RPC's raw quai_gasPrice read. Used by every write and `hartii gas`.
import { Zone } from 'quais';

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
  try { n = BigInt((await quietly(() => provider.getFeeData(Zone.Cyprus1))).gasPrice); } catch (err) { providerError = err; }
  if (n === null) {
    if (!rpcUrl) throw providerError;
    try { n = await rawGasPrice(rpcUrl); } catch { throw providerError; }
  }
  if (n <= 0n) throw new Error('RPC returned a non-positive gas price.');
  return n;
}
