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
import { getAddress } from 'quais';
import { resilientRead } from '../vendor/packages/agent-mcp/src/rpcClient.js';
import { readGasPrice } from './gasPrice.js';
import { classifyError } from '../vendor/packages/agent-mcp/src/errors.js';
import { checkSpend, withSpendLock, reserveSpend, markSpendHash, settleSpend } from './spendingGuard.js';
import { quaiscanTxUrl } from './quaiscan.js';
import { confirm as defaultConfirm } from './prompt.js';
import { formatAmount } from './amount.js';
import { assertCyprus1QuaiAddress } from './address.js';
import { CliError } from './errors.js';

export class WriteError extends CliError {
  constructor(message, extra) { super(redactUrls(message), extra); }
}

// Live Cyprus-1 gas is ~58,000 gwei (2026-10-05): a transfer costs ~2 QUAI and a curve trade ~8-15 QUAI, so the
// ceiling's floor must sit well above that or every ordinary write is refused. 25 QUAI still catches a gas
// spike or a lying RPC; a human can raise it with --max-fee.
const FEE_FLOOR = 25n * 10n ** 18n;
const GAS_LIMIT_BUFFER_NUM = 1200n; // *1.2 — same headroom/rationale as packages/agent-mcp/src/execute.js
const GAS_LIMIT_BUFFER_DEN = 1000n;
const RECEIPT_TIMEOUT_MS = 90_000;
const RECEIPT_CONFIRMATIONS = 1;
// quais error codes a node returns when it REJECTS a transaction at submission (never pooled, never
// broadcast): the spending reservation can be released. Anything else at the send stage (timeout,
// unknown server error) is ambiguous and stays reserved.
const REJECTED_BEFORE_BROADCAST = new Set(['INSUFFICIENT_FUNDS', 'NONCE_EXPIRED', 'REPLACEMENT_UNDERPRICED', 'INVALID_ARGUMENT']);

/** quais' TransactionResponse.wait() THROWS a CALL_EXCEPTION carrying the receipt when the mined tx reverted. */
function revertedReceiptOf(err) {
  const receipt = err?.receipt;
  return err?.code === 'CALL_EXCEPTION' && receipt && Number(receipt.status) === 0 ? receipt : null;
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
  const from = getAddress(await ctx.wallet.getAddress());
  return withSpendLock(ctx.home, from, () => runWriteLocked(ctx));
}

async function runWriteLocked(ctx) {
  const { wallet, provider, network, home, limits, action, extraSummary = {}, json = false, yes = false, dryRun = false } = ctx;
  const io = ctx.io || {};
  const write = io.write || ((s) => console.log(s));
  const confirmFn = io.confirmFn || defaultConfirm;
  const now = io.now;

  const from = getAddress(await wallet.getAddress());
  // Defense in depth: every command that reaches this pipeline SHOULD already have validated `to`
  // itself (send.js does), but this is the one gate every future write command shares, so the
  // checksum/Cyprus-1/Qi-rejection check lives here too, not only at each call site.
  const to = assertCyprus1QuaiAddress(ctx.to);
  const value = BigInt(ctx.value || 0n);
  const spendWei = BigInt(ctx.spendWei ?? value);
  if (spendWei < value || spendWei < 0n) throw new WriteError('Invalid spend valuation.');
  if (/^0x0{40}$/i.test(to)) throw new WriteError('Zero-address destination is not allowed.');
  const data = ctx.data || '0x';
  const tx = { from, to, data, value };

  // Spending guard — checked (never recorded) before anything touches the network, so a transaction
  // that would blow the cap never even gets simulated.
  checkSpend(home, from, spendWei, limits, { now });

  // Simulate.
  try {
    const simulation = await provider.call(tx);
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
      accessList = await resilientRead(() => provider.createAccessList(tx), { primaryAttempts: 2 });
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
    nonce = Number(n);
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
  const summary = {
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
    ...extraSummary,
  };

  printSummary(summary, { write: json ? (io.writeErr || console.error) : write, json, colors: io.colors });

  if (dryRun) {
    return { ok: true, dryRun: true, summary: jsonSafe(summary) };
  }

  if (!yes) {
    const proceed = await confirmFn('Proceed?', io);
    if (!proceed) {
      return { ok: false, aborted: true, summary: jsonSafe(summary) };
    }
  }

  const chainId = BigInt(network.chainId);
  const sendTx = accessList ? { from, to, data, value, gasLimit, gasPrice, nonce, chainId, accessList } : { from, to, data, value, gasLimit, gasPrice, nonce, chainId };
  const reservation = reserveSpend(home, from, guardWei, limits, {now});
  let sent;
  try {
    sent = await wallet.sendTransaction(sendTx);
  } catch (err) {
    const rejected = Boolean(err?.notSubmitted || err?.code === 4001 || err?.code === 'ACTION_REJECTED' || REJECTED_BEFORE_BROADCAST.has(err?.code));
    if (rejected) settleSpend(home, from, reservation, {confirmed:false,now});
    throw new WriteError(`Send failed (${rejected ? 'rejected before broadcast; nothing was sent and the spending allowance was released' : 'outcome unknown: the spending allowance stays reserved until you have checked quaiscan'}): ${classifyError(err, { stage: 'send' })}`);
  }
  if (!sent || !sent.hash) {
    throw new WriteError('Send returned no transaction hash — treat as UNCONFIRMED, not failed: check on-chain before retrying.');
  }

  markSpendHash(home, from, reservation, sent.hash);
  let receipt;
  try {
    receipt = await sent.wait(RECEIPT_CONFIRMATIONS, RECEIPT_TIMEOUT_MS);
  } catch (err) {
    // A mined-but-reverted tx is FINAL (quais surfaces it as a thrown CALL_EXCEPTION with the receipt,
    // never as a status-0 receipt): release the reservation and say "reverted", not "unconfirmed".
    if (revertedReceiptOf(err)) {
      settleSpend(home, from, reservation, {confirmed:false,now});
      throw new WriteError(`Transaction reverted on-chain (tx ${sent.hash}).`, { txHash: sent.hash, status: 'reverted' });
    }
    throw new WriteError(`Sent (tx ${sent.hash}) but its receipt did not confirm within ${RECEIPT_TIMEOUT_MS / 1000}s: ${classifyError(err, { stage: 'wait' })}. Check the hash on-chain before doing anything else — do not resend.`, {
      txHash: sent.hash,
    });
  }
  if (!receipt || receipt.status == null || ![0, 1].includes(Number(receipt.status))) {
    throw new WriteError(`Transaction is UNCONFIRMED (tx ${sent.hash}); spending allowance remains reserved. Check its receipt before retrying.`, {txHash:sent.hash,status:'unconfirmed'});
  }
  if (Number(receipt.status) === 0) {
    settleSpend(home, from, reservation, {confirmed:false,now});
    throw new WriteError(`Transaction reverted on-chain (tx ${sent.hash}).`, { txHash: sent.hash, status: 'reverted' });
  }

  // Only now — a confirmed, successful send — does the guard's running total actually move.
  settleSpend(home, from, reservation, {confirmed:true,now});

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
