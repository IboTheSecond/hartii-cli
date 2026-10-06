// Gas reserve for "spend my whole balance" amounts (send all, buy all/100%, QUAI-in swap all).
// The fee is estimated against the REAL shape of the transaction, never a value:0 stand-in: a transfer
// of value to a never-seen account costs roughly twice a zero-value call. Take the highest estimate,
// apply the pipeline's 1.2x gas buffer, then a further 10% margin for gas-price drift, so the reserved
// amount still covers the pipeline's own estimate. runWrite's balance check is the backstop.
import { resilientRead } from '../vendor/packages/agent-mcp/src/rpcClient.js';
import { readGasPrice } from './gasPrice.js';

const BUFFER_NUM = 1200n, BUFFER_DEN = 1000n; // same 1.2x as writePipeline's gas limit
const MARGIN_NUM = 110n, MARGIN_DEN = 100n;

/**
 * @param {object} provider
 * @param {string} rpcUrl
 * @param {object[]} txs candidate transactions; the highest successful estimate wins
 * @param {{ fallbackGas?: bigint }} [opts] used only when every estimate fails
 * @returns {Promise<bigint>} wei to hold back
 */
export async function reserveFeeWei(provider, rpcUrl, txs, opts = {}) {
  const estimates = [];
  let lastError;
  for (const tx of txs) {
    try { estimates.push(BigInt(await resilientRead(() => provider.estimateGas(tx), { primaryAttempts: 2 }))); }
    catch (err) { lastError = err; }
  }
  let gas = estimates.length ? estimates.reduce((a, b) => (a > b ? a : b)) : opts.fallbackGas;
  if (gas === undefined) throw lastError || new Error('Gas could not be estimated.');
  if (gas <= 0n) throw new Error('Invalid gas estimate.');
  const price = BigInt(await readGasPrice(provider, rpcUrl));
  return (((gas * BUFFER_NUM) / BUFFER_DEN) * price * MARGIN_NUM) / MARGIN_DEN;
}
