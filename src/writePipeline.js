import { safeTerminalText, redactUrls } from './output.js';
// packages/hartii-cli/src/writePipeline.js
//
// The ONE path every write command (send, and later buy/sell/swap/airdrop/otc/claim/wall) goes
// through, per the product spec HARD RULES: build -> simulate -> access list -> summary -> confirm
// -> send (gasLimit = estimate*1.2) -> receipt (require status 1) -> quaiscan link. Modelled on
// packages/agent-mcp/src/execute.js's same build->simulate->send->wait shape, but deliberately NOT
// a copy: execute.js pins every call to one allowlisted AgentVault target and serializes sends
// behind a process-wide queue because an MCP server can receive overlapping tool calls against the
// SAME long-lived vault signer. This CLI is a single interactive/scripted process signing to
// arbitrary user-chosen destinations from the user's own EOA — one invocation, one send, no queue
// needed. What IS reused: the resilient-read helper for idempotent chain reads (see
// `resilientRead` import below) and the revert-reason classifier (`classifyError`), both pure and
// generic enough to serve both packages without coupling this one to agent-mcp's vault semantics.
import { accessListify } from 'quais';
import { createHash } from 'node:crypto';
import { resilientRead } from '../vendor/packages/agent-mcp/src/rpcClient.js';
import { readGasPrice } from './gasPrice.js';
import { classifyError } from '../vendor/packages/agent-mcp/src/errors.js';
import { checkSpend, withSpendLock, reserveSpend, markSpendHash, settleSpend, assertNoPendingSpend } from './spendingGuard.js';
import { NETWORKS } from './network.js';
import { quaiscanTxUrl } from './quaiscan.js';
import { confirm as defaultConfirm } from './prompt.js';
import { formatAmount } from './amount.js';
import { assertCyprus1QuaiAddress } from './address.js';
import { CliError } from './errors.js';

export class WriteError extends CliError {
  constructor(message, extra) { super(redactUrls(message), extra); }
}
const localPreBroadcastFailures = new WeakSet();
const localBroadcasts = new WeakMap();
/** Native-only phase evidence; JSON-RPC flags cannot manufacture this membership. */
export class PreBroadcastError extends WriteError {
  constructor(message) { super(message); localPreBroadcastFailures.add(this); }
}
/** A locally signed hash survives an ambiguous broadcast; RPC error fields cannot manufacture it. */
export class BroadcastError extends WriteError {
  constructor(error, signedHash, signedRaw) {
    super(classifyError(error, { stage: 'send' }));
    if (!validHash(signedHash)) throw new Error('Invalid locally signed transaction hash.');
    localBroadcasts.set(this, { signedHash, signedRaw, error });
  }
}

// Live Cyprus-1 gas is ~58,000 gwei (2026-10-05): a transfer costs ~2 QUAI and a curve trade ~8-15 QUAI, so the
// ceiling's floor must sit well above that or every ordinary write is refused. 25 QUAI still catches a gas
// spike or a lying RPC; a human can raise it with --max-fee.
const FEE_FLOOR = 25n * 10n ** 18n;
const GAS_LIMIT_BUFFER_NUM = 1200n; // *1.2 — same headroom/rationale as packages/agent-mcp/src/execute.js
const GAS_LIMIT_BUFFER_DEN = 1000n;
const RECEIPT_TIMEOUT_MS = 90_000;
const RECEIPT_CONFIRMATIONS = 1;
// RPC error codes/flags alone cannot prove a send was never broadcast.
// The one exception: an SDK admission rejection bound to the exact locally signed raw transaction.
// broadcastTransaction also runs chain/head reads in parallel; their errors cannot prove send rejection.
const NODE_REJECTION_CODES = new Set(['INSUFFICIENT_FUNDS', 'NONCE_EXPIRED', 'REPLACEMENT_UNDERPRICED']);
const NODE_REJECTION_TEXT = /insufficient funds|nonce too low|replacement transaction underpriced|transaction underpriced|invalid sender/i;
function isNodeRejection(err, signedRaw) {
  if (typeof signedRaw !== 'string') return false;
  const body = err?.info?.error;
  if (body && typeof body.message === 'string' && NODE_REJECTION_CODES.has(err.code) && err.transaction === signedRaw) return true;
  // Unclassified node admission errors carry the SDK's local RPC payload instead.
  const payload = err?.payload;
  return payload?.method === 'quai_sendRawTransaction' && payload.params?.[0] === signedRaw
    && typeof err?.error?.message === 'string' && NODE_REJECTION_TEXT.test(err.error.message);
}
const validHash = value => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
const dataDigest = data => '0x' + createHash('sha256').update(data.toLowerCase()).digest('hex');
const clone = value => structuredClone(value);
function freeze(value) { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }
export function transactionIntentDigest(tx) {
  const fields = ['from','to','data','value','gasLimit','gasPrice','nonce','chainId','accessList'];
  return '0x' + createHash('sha256').update(JSON.stringify(jsonSafe(Object.fromEntries(fields.map(field => [field,tx[field] ?? null]))))).digest('hex');
}
async function assertProviderChain(provider, chainId) {
  if (typeof provider.getNetwork !== 'function') throw new WriteError('Cannot verify provider chain authority.');
  const actual = (await provider.getNetwork())?.chainId;
  if (!['bigint','number','string'].includes(typeof actual) || actual === '' || BigInt(actual) !== BigInt(chainId)) throw new WriteError('Provider chain authority changed or disagrees with the reviewed network.');
}
function receiptIdentityMatches(receipt, hash, tx) {
  const hashes = [receipt?.hash, receipt?.transactionHash].filter(value => value !== undefined && value !== null);
  if (!validHash(hash) || !hashes.length || hashes.some(value => !validHash(value) || value.toLowerCase() !== hash.toLowerCase())) return false;
  if (receipt.from !== undefined && String(receipt.from).toLowerCase() !== tx.from.toLowerCase()) return false;
  if (receipt.to !== undefined && String(receipt.to).toLowerCase() !== tx.to.toLowerCase()) return false;
  try { for (const field of ['nonce','chainId']) if (receipt[field] !== undefined && !uintMatches(receipt[field], tx[field])) return false; } catch { return false; }
  return true;
}
function validateBeforeSubmit(validator, summary, transaction) {
  if (validator === undefined) return;
  try {
    if (typeof validator !== 'function') throw new Error('Submit validation must be a local synchronous function.');
    const result = validator({ summary: freeze(clone(jsonSafe(summary))), transaction });
    if (result && typeof result.then === 'function') throw new Error('Submit validation must be synchronous.');
  } catch (error) { throw new PreBroadcastError(error?.message || 'Local submit validation rejected this transaction.'); }
}
function uintMatches(value, expected) {
  const valid = typeof value === 'bigint' ? value >= 0n : typeof value === 'number' ? Number.isSafeInteger(value) && value >= 0 : typeof value === 'string' && /^(?:\d+|0x[0-9a-fA-F]+)$/.test(value);
  return valid && BigInt(value) === BigInt(expected);
}
function responseIdentityMatches(response, tx) {
  for (const field of ['from','to','data']) if (response[field] !== undefined && (typeof response[field] !== 'string' || response[field].toLowerCase() !== String(tx[field]).toLowerCase())) return false;
  try { for (const field of ['value','chainId','nonce','gasLimit','gasPrice']) if (response[field] !== undefined && !uintMatches(response[field], tx[field])) return false; } catch { return false; }
  if (response.transactionHash !== undefined && (!validHash(response.transactionHash) || response.transactionHash.toLowerCase() !== response.hash?.toLowerCase())) return false;
  return true;
}

// Only SDK/RPC canonical status representations establish a final mined outcome.
// Numeric coercion would turn empty strings/booleans into receipts and release reservations.
function finalReceiptStatus(receipt) {
  if ([0, 0n, '0', '0x0'].includes(receipt?.status)) return 0;
  if ([1, 1n, '1', '0x1'].includes(receipt?.status)) return 1;
  return null;
}

/** A CALL_EXCEPTION may carry a final mined receipt; the error code alone proves nothing. */
function minedReceiptOf(err) {
  const receipt = err?.receipt;
  return err?.code === 'CALL_EXCEPTION' && finalReceiptStatus(receipt) !== null ? receipt : null;
}

// Receipt fee is authoritative. Older SDK shapes expose gasUsed + gasPrice instead;
// incomplete/malformed receipt fields fall back to the conservative signed gas ceiling.
function minedFee(receipt, gasLimit, gasPrice) {
  const uint = value => {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'boolean' || (typeof value === 'number' && !Number.isSafeInteger(value))) return null;
    try { const n = BigInt(value); return n >= 0n ? n : null; } catch { return null; }
  };
  const fee = uint(receipt.fee);
  if (fee !== null) return fee;
  const used = uint(receipt.gasUsed);
  const price = uint(receipt.gasPrice) ?? uint(receipt.effectiveGasPrice) ?? gasPrice;
  return (used ?? gasLimit) * price;
}

function bumpGasLimit(estimate) {
  return (BigInt(estimate) * GAS_LIMIT_BUFFER_NUM) / GAS_LIMIT_BUFFER_DEN;
}

/** Deep-converts every bigint in `obj` to a decimal string — JSON.stringify throws on a bare bigint. */
function jsonSafe(obj) {
  if (typeof obj === 'bigint') return obj.toString();
  if (Array.isArray(obj)) return obj.map(jsonSafe);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = jsonSafe(v);
    return out;
  }
  return obj;
}

/**
 * Runs the full build -> simulate -> access-list -> summary -> confirm -> send -> receipt
 * pipeline for one transaction. Prints the confirmation summary itself (human-coloured or
 * `--json`, per `json`) so every write command gets byte-identical summary formatting.
 *
 * @param {object} ctx
 * @param {import('quais').Wallet} ctx.wallet connected to `ctx.provider`
 * @param {import('quais').JsonRpcProvider} ctx.provider
 * @param {{name:string, chainId:number}} ctx.network
 * @param {string} ctx.home HARTII_HOME, for the spending guard's ledger
 * @param {{perTxQuai:string, dailyQuai:string}} ctx.limits
 * @param {string} ctx.to destination address (any case — checksummed here)
 * @param {string} [ctx.data] '0x' for a plain QUAI transfer
 * @param {bigint} [ctx.value] wei of native QUAI moved by this tx (0n for a token transfer's call)
 * @param {string} ctx.action short label for the summary, e.g. "Send QUAI", "Send USDC"
 * @param {Record<string, string>} [ctx.extraSummary] extra already-formatted lines merged into the printed/returned summary (e.g. {Token: 'USDC', Amount: '12.5 USDC'})
 * @param {boolean} [ctx.json]
 * @param {boolean} [ctx.yes] skip the y/N prompt
 * @param {boolean} [ctx.dryRun] simulate + print summary, never sign
 * @param {{ write?: (s:string)=>void, writeErr?: (s:string)=>void, confirmFn?: typeof defaultConfirm, colors?: any, now?: Date }} [ctx.io]
 * @returns {Promise<{ ok: boolean, dryRun?: boolean, aborted?: boolean, summary: object, txHash?: string, status?: string, quaiscanUrl?: string, error?: string }>}
 */
export async function runWrite(ctx) {
  const snapshot = { ...ctx, network: freeze({ ...ctx.network }), limits: freeze({ ...ctx.limits }), extraSummary: clone(ctx.extraSummary || {}) };
  const from = assertCyprus1QuaiAddress(await snapshot.wallet.getAddress());
  return withSpendLock(snapshot.home, from, () => runWriteLocked(snapshot, from));
}

async function runWriteLocked(ctx, from) {
  const { wallet, provider, network, home, limits, action, extraSummary = {}, json = false, yes = false, dryRun = false } = ctx;
  const io = ctx.io || {};
  const write = io.write || ((s) => process.stdout.write(s + '\n'));
  const confirmFn = io.confirmFn || defaultConfirm;
  const now = io.now;

  if (!Object.hasOwn(NETWORKS, network.name) || BigInt(network.chainId) !== BigInt(NETWORKS[network.name].chainId)) throw new WriteError('Invalid selected network authority.');
  // Dry runs enforce the same pending-authority and chain checks as a real run, so a dry run never reports success a real run would refuse.
  assertNoPendingSpend(home, from, network.chainId);
  // Defense in depth: every command that reaches this pipeline SHOULD already have validated `to`
  // itself (send.js does), but this is the one gate every future write command shares, so the
  // checksum/Cyprus-1/Qi-rejection check lives here too, not only at each call site.
  const to = assertCyprus1QuaiAddress(ctx.to);
  if (ctx.value !== undefined && !['bigint','string'].includes(typeof ctx.value)) throw new WriteError('Transaction value must be exact nonnegative wei.');
  const value = BigInt(ctx.value ?? 0n);
  if (ctx.spendWei !== undefined && !['bigint','string'].includes(typeof ctx.spendWei)) throw new WriteError('Spend valuation must be exact nonnegative wei.');
  const spendWei = BigInt(ctx.spendWei ?? value);
  if (value < 0n || spendWei < value || spendWei < 0n) throw new WriteError('Invalid spend valuation.');
  if (/^0x0{40}$/i.test(to)) throw new WriteError('Zero-address destination is not allowed.');
  const data = ctx.data || '0x';
  if (typeof data !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(data)) throw new WriteError('Invalid transaction calldata.');
  const tx = { from, to, data, value };

  // Spending guard — checked (never recorded) before anything touches the network, so a transaction
  // that would blow the cap never even gets simulated.
  checkSpend(home, from, spendWei, limits, { now });
  await assertProviderChain(provider, network.chainId);

  // Simulate.
  try {
    const simulation = await provider.call(clone(tx));
    ctx.validateSimulation?.(simulation);
  } catch (err) {
    throw new WriteError(`Simulation failed: ${classifyError(err, { stage: 'simulate' })}`);
  }

  // Quai access list — only meaningful (and only ever populated by quais itself) for a call that
  // carries data; a plain value transfer has none. See memory note "Quai pre-signed tx needs
  // access list": a raw-signed CONTRACT call without one can burn all its gas.
  //
  // Same-provider retry only, deliberately NO raw-proxy fallback — identical reasoning to
  // packages/agent-mcp/src/execute.js's readGasEstimate: a correct raw `quai_createAccessList`
  // fallback would need to hex-encode the full tx (this `tx.value` is a BigInt; JSON.stringify
  // would throw on it as-is), and a subtly wrong encoding here would feed a wrong access list
  // into a REAL signed transaction — not worth it for a call whose `provider.call` simulation
  // just succeeded on this exact same connection moments earlier.
  let accessList;
  if (data && data !== '0x') {
    try {
      const list = await resilientRead(() => provider.createAccessList(clone(tx)), { primaryAttempts: 2 });
      if (!Array.isArray(list)) throw new Error('RPC returned an invalid access list.');
      accessList = accessListify(list);
    } catch (err) {
      throw new WriteError(`Could not build the access list: ${classifyError(err, { stage: 'read' })}`);
    }
  }

  // Gas terms — explicit, never left to a node default (see header + memory note "plain transfers
  // to a never-seen account need ~39k, never hardcode 21k").
  let gasLimit;
  let gasPrice;
  let nonce;
  try {
    const simTx = accessList ? { ...tx, accessList } : tx;
    const [estimate, price, n] = await Promise.all([
      resilientRead(() => provider.estimateGas(simTx), { primaryAttempts: 2 }),
      readGasPrice(provider, network.rpcUrl),
      resilientRead(() => provider.getTransactionCount(from, 'pending'), { primaryAttempts: 2 }),
    ]);
    gasLimit = bumpGasLimit(estimate);
    gasPrice = BigInt(price);
    if (typeof n !== 'number') throw new Error('Invalid nonce representation.');
    nonce = n;
    if (gasLimit <= 0n || gasPrice <= 0n || !Number.isSafeInteger(nonce) || nonce < 0) throw new Error('Invalid gas estimate, gas price or nonce.');
  } catch (err) {
    throw new WriteError(`Could not prepare gas terms: ${classifyError(err, { stage: 'read' })}`);
  }

  const feeWei = gasLimit * gasPrice;
  // Fee ceiling: max(25 QUAI, 5% of the guarded value), unless the HUMAN CLI raised it with --max-fee
  // (io.maxFeeWei is only ever set by cli.js; the MCP layer cannot set it).
  const defaultCeiling = (() => { const pct = (spendWei * 5n) / 100n; return pct > FEE_FLOOR ? pct : FEE_FLOOR; })();
  const feeCeiling = io.maxFeeWei !== undefined && io.maxFeeWei !== null ? BigInt(io.maxFeeWei) : defaultCeiling;
  if (feeWei > feeCeiling) {
    throw new WriteError(`Estimated network fee ${formatAmount(feeWei)} QUAI exceeds the fee ceiling of ${formatAmount(feeCeiling)} QUAI (max of 25 QUAI and 5% of the value moved). Refusing. A human can raise it with --max-fee <quai>.`);
  }
  // The fee is real spend: count it toward the per-tx / daily guard.
  const guardWei = spendWei + feeWei;
  checkSpend(home, from, guardWei, limits, { now });
  const assertFunds = async () => {
    // A send the node will refuse for insufficient funds must never reach the reservation step.
    if (typeof provider.getBalance !== 'function') return;
    let balance;
    try { balance = BigInt(await resilientRead(() => provider.getBalance(from), { primaryAttempts: 2 })); }
    catch (err) { throw new WriteError(`Could not read the wallet balance: ${classifyError(err, { stage: 'read' })}`); }
    if (balance < value + feeWei) throw new WriteError(`Insufficient QUAI for value plus gas: have ${formatAmount(balance)}, need ${formatAmount(value + feeWei)} (${formatAmount(value)} value + up to ${formatAmount(feeWei)} network fee). Nothing was sent and nothing was reserved.`);
  };
  await assertFunds();
  const summary = {
    ...extraSummary,
    action,
    network: network.name,
    chainId: network.chainId,
    from,
    to,
    valueQuai: formatAmount(value),
    guardedQuai: formatAmount(spendWei),
    guardedWithFeeQuai: formatAmount(guardWei),
    gasLimit: gasLimit.toString(),
    gasPriceWei: gasPrice.toString(),
    estimatedFeeQuai: formatAmount(feeWei),
    nonce,
    dataDigest: dataDigest(data),
    dataSelector: data.length >= 10 ? data.slice(0, 10).toLowerCase() : 'none',
    dataBytes: (data.length - 2) / 2,
  };

  printSummary(summary, { write: json ? (io.writeErr || ((s) => process.stderr.write(s + '\n'))) : write, json, colors: io.colors });

  if (dryRun) {
    return { ok: true, dryRun: true, summary: jsonSafe(summary) };
  }

  if (!yes) {
    const proceed = await confirmFn('Proceed?', io);
    if (!proceed) {
      return { ok: false, aborted: true, summary: jsonSafe(summary) };
    }
  }

  // Caller-supplied local pre-submit checks: the command's own (e.g. payment-link expiry) and the host's (the MCP
  // review-token binding). All must pass, synchronously, before anything is reserved or signed.
  const validators = [ctx.validateBeforeSubmit, io.validateBeforeSubmit].filter((v) => v !== undefined);
  const submitValidator = validators.length ? (arg) => { for (const v of validators) { const r = v(arg); if (r && typeof r.then === 'function') throw new Error('Submit validation must be synchronous.'); } } : undefined;
  const chainId = BigInt(network.chainId);
  const sendTx = freeze(accessList ? { from, to, data, value, gasLimit, gasPrice, nonce, chainId, accessList } : { from, to, data, value, gasLimit, gasPrice, nonce, chainId });
  const actualSigner = typeof wallet.prepareSigner === 'function' ? await wallet.prepareSigner() : await wallet.getAddress();
  if (assertCyprus1QuaiAddress(actualSigner).toLowerCase() !== from.toLowerCase()) throw new WriteError('Signing wallet authority changed from the reviewed sender.');
  await assertProviderChain(provider, chainId);
  const finalNonce = await provider.getTransactionCount(from, 'pending');
  if (typeof finalNonce !== 'number' || !Number.isSafeInteger(finalNonce) || finalNonce !== nonce) throw new WriteError('Wallet nonce changed after review; no transaction was sent. Review fresh terms before retrying.');
  assertNoPendingSpend(home, from, chainId);
  validateBeforeSubmit(submitValidator, summary, sendTx);
  const intentDigest = transactionIntentDigest(sendTx);
  await assertFunds();
  const reservation = reserveSpend(home, from, guardWei, limits, {now, authority: { chainId: String(chainId), nonce,
    to: to.toLowerCase(), valueWei: value.toString(), dataDigest: dataDigest(data), intentDigest,
    spendWei: spendWei.toString(), maxFeeWei: feeWei.toString(), createdAt: (now || new Date()).toISOString(),
  }});
  let sent;
  try {
    validateBeforeSubmit(submitValidator, summary, sendTx);
    sent = await wallet.sendTransaction(sendTx, { validateBeforeSubmit: () => validateBeforeSubmit(submitValidator, summary, sendTx),
      onSignedTransaction: ({txHash}) => markSpendHash(home,from,reservation,txHash) });
  } catch (err) {
    // No successful SDK response means no locally returned signed hash. RPC
    // receipt/transaction fields in a submission error cannot establish it.
    const broadcast = localBroadcasts.get(err);
    const failure = broadcast?.error || err;
    const rejected = localPreBroadcastFailures.has(err) || isNodeRejection(failure, broadcast?.signedRaw);
    if (broadcast && !rejected) markSpendHash(home, from, reservation, broadcast.signedHash);
    if (rejected) settleSpend(home, from, reservation, {confirmed:false,now});
    throw new WriteError(`Send failed (${rejected ? 'rejected before broadcast; nothing was sent and the spending allowance was released' : `outcome unknown: the spending allowance stays reserved until you have checked quaiscan${broadcast ? ` (tx ${broadcast.signedHash})` : ''}`}): ${classifyError(failure, { stage: 'send' })}`,
      broadcast && !rejected ? { txHash: broadcast.signedHash, status: 'unconfirmed' } : undefined);
  }
  if (!sent || !validHash(sent.hash)) {
    throw new WriteError('Send returned no transaction hash — treat as UNCONFIRMED, not failed: check on-chain before retrying.');
  }

  markSpendHash(home, from, reservation, sent.hash);
  if (!responseIdentityMatches(sent, sendTx)) throw new WriteError('Submitted transaction identity disagrees with reviewed authority; outcome is UNCONFIRMED.', { txHash: sent.hash, status: 'unconfirmed' });
  let receipt;
  try {
    receipt = await sent.wait(RECEIPT_CONFIRMATIONS, RECEIPT_TIMEOUT_MS);
  } catch (err) {
    receipt = minedReceiptOf(err);
    if (!receipt) {
      throw new WriteError(`Sent (tx ${sent.hash}) but its receipt did not confirm within ${RECEIPT_TIMEOUT_MS / 1000}s: ${classifyError(err, { stage: 'wait' })}. Check the hash on-chain before doing anything else — do not resend.`, {
        txHash: sent.hash,
      });
    }
  }
  const status = finalReceiptStatus(receipt);
  if (status === null || !receiptIdentityMatches(receipt, sent.hash, sendTx)) {
    throw new WriteError(`Transaction is UNCONFIRMED (tx ${sent.hash}); spending allowance remains reserved. Check its receipt before retrying.`, {txHash:sent.hash,status:'unconfirmed'});
  }
  if (status === 0) {
    settleSpend(home, from, reservation, {confirmed:false,chargedWei:minedFee(receipt,gasLimit,gasPrice),now});
    throw new WriteError(`Transaction reverted on-chain (tx ${sent.hash}).`, { txHash: sent.hash, status: 'reverted' });
  }

  // Successful writes charge guarded value plus gas; reverts above charge gas only.
  settleSpend(home, from, reservation, {confirmed:true,chargedWei:spendWei+minedFee(receipt,gasLimit,gasPrice),now});

  const quaiscanUrl = quaiscanTxUrl(network.name, sent.hash);
  return { ok: true, txHash: sent.hash, status: 'success', quaiscanUrl, summary: jsonSafe(summary), receipt: {status:1,blockNumber:receipt.blockNumber ?? null,transactionHash:receipt.hash || receipt.transactionHash || sent.hash,gasUsed:receipt.gasUsed == null ? null : String(receipt.gasUsed)} };
}

function printSummary(summary, { write, json, colors }) {
  if (json) {
    write(JSON.stringify({ summary: jsonSafe(summary) }, null, 2));
    return;
  }
  const c = colors || { bold: (s) => s, dim: (s) => s, purple: (s) => s };
  const lines = [c.bold(safeTerminalText(summary.action)), ...Object.entries(summary).filter(([k]) => k !== 'action').map(([k, v]) => `  ${c.dim(k)}: ${safeTerminalText(v)}`)];
  write(lines.join('\n'));
}
