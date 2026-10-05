export class SellAmountError extends Error {
  constructor(message, { transferable, balance, locked, curveLimited = false, unavailable = false } = {}) {
    super(message);
    this.name = 'SellAmountError';
    this.transferable = transferable;
    this.balance = balance;
    this.locked = locked;
    this.curveLimited = curveLimited;
    this.unavailable = unavailable;
  }
}

function errorMessages(err, seen = new Set()) {
  if (err == null || seen.has(err)) return [];
  if (typeof err === 'string') return [err];
  if (typeof err !== 'object') return [String(err)];
  seen.add(err);

  const messages = [];
  for (const key of ['reason', 'shortMessage', 'message']) {
    if (typeof err[key] === 'string') messages.push(err[key]);
  }
  for (const key of ['error', 'info', 'cause', 'data']) {
    messages.push(...errorMessages(err[key], seen));
  }
  return messages;
}

export function isMissingRevertData(err) {
  return errorMessages(err).some((message) => /missing revert data/i.test(message));
}

export function resolveSellableBalance(transferable, graduated, tokensSold) {
  if (typeof transferable !== 'bigint') return null;
  if (typeof graduated !== 'boolean') return null;
  if (graduated === false) {
    if (typeof tokensSold !== 'bigint') return null;
    return transferable < tokensSold ? transferable : tokensSold;
  }
  return transferable;
}

export function assertSellableAmount(amount, transferable, balance, { curveLimited = false } = {}) {
  if (typeof amount !== 'bigint' || amount <= 0n) return amount;
  if (typeof transferable !== 'bigint' || typeof balance !== 'bigint') {
    throw new SellAmountError('Live sell limits are still loading. Please try again in a moment.', {
      transferable,
      balance,
      locked: 0n,
      unavailable: true,
    });
  }
  if (amount <= transferable) return amount;

  if (curveLimited) {
    throw new SellAmountError(
      `Only ${transferable} tokens can currently be sold back to this pre-graduation curve.`,
      { transferable, balance, locked: 0n, curveLimited: true },
    );
  }

  const locked = balance > transferable ? balance - transferable : 0n;
  if (locked > 0n) {
    throw new SellAmountError(
      `Only ${transferable} tokens are transferable; ${locked} tokens are still vesting.`,
      { transferable, balance, locked },
    );
  }
  throw new SellAmountError(`You only hold ${balance} tokens.`, {
    transferable,
    balance,
    locked: 0n,
  });
}

export function computeBuyQuote(amount, quotedOut, feeBps, tokensRemaining = null) {
  if (
    typeof amount !== 'bigint' ||
    typeof quotedOut !== 'bigint' ||
    typeof feeBps !== 'bigint' ||
    amount < 0n ||
    quotedOut < 0n ||
    feeBps < 0n ||
    feeBps >= 10_000n
  ) {
    throw new Error('Live buy quote is invalid. Please refresh and try again.');
  }

  // Match BondingCurve.buy exactly: fee rounds down before net QUAI is priced.
  const fee = (amount * feeBps) / 10_000n;
  const netInput = amount - fee;
  const expectedOut = typeof tokensRemaining === 'bigint' && quotedOut > tokensRemaining
    ? tokensRemaining
    : quotedOut;
  return { netInput, expectedOut };
}

/**
 * Net-of-fee sell quote, mirroring BondingCurve.sell exactly.
 *
 * quoteSell() on the contract is documented "ignoring fees" and returns the GROSS QUAI out; sell()
 * then charges `fee = gross * feeBps / 10000` (rounding down) and checks `gross - fee >= minQuaiOut`.
 * Until 2026-09-17 the panel used the gross figure both as the displayed "You receive" and as the
 * basis for minQuaiOut, so every sell over-quoted by the fee and any sell whose slippage tolerance
 * was below the fee — the auto tier under 1 QUAI is 0.5% against a 1% fee — reverted every time.
 * This is the sell-side twin of computeBuyQuote and must stay byte-for-byte in step with the contract.
 */
export function computeSellQuote(tokensIn, quotedGrossOut, feeBps) {
  if (
    typeof tokensIn !== 'bigint' ||
    typeof quotedGrossOut !== 'bigint' ||
    typeof feeBps !== 'bigint' ||
    tokensIn < 0n ||
    quotedGrossOut < 0n ||
    feeBps < 0n ||
    feeBps >= 10_000n
  ) {
    throw new Error('Live sell quote is invalid. Please refresh and try again.');
  }
  const fee = (quotedGrossOut * feeBps) / 10_000n;
  return { grossOut: quotedGrossOut, fee, expectedOut: quotedGrossOut - fee };
}

/** Slippage floor/ceiling: 'min' reduces (minimum acceptable out), 'max' increases. */
export function applySlippage(amount, slippageBps, direction = 'min') {
  const bps = BigInt(Math.round(slippageBps));
  const factor = direction === 'min' ? 10_000n - bps : 10_000n + bps;
  return (amount * factor) / 10_000n;
}

/**
 * Stale-quote gate for /swap's re-polled quote (useHartiiSwapQuote's 10s background refresh).
 *
 * Deliberately does NOT ratchet the accepted baseline down on every in-tolerance dip. An earlier
 * version re-anchored the baseline to whatever the latest poll returned as long as THAT SINGLE
 * step stayed within slippage tolerance — which meant a slow bleed (many small drops, each one
 * individually "fine") could walk the display price down well past the user's actual tolerance
 * over a few minutes without the "price moved" banner ever firing, because each comparison was
 * only ever against the immediately-prior (already-decayed) baseline, not the quote the user
 * originally saw. This compares every new quote against the ORIGINAL accepted baseline instead:
 * an improvement (equal or better) is tracked silently (nothing to warn about), a drop within
 * tolerance of the ORIGINAL is absorbed without moving the baseline, and only a drop that breaches
 * tolerance of the original sets priceMoved — which the user then clears explicitly (Swap.jsx's
 * "Accept new price"), and that explicit accept is the only thing allowed to lower the baseline.
 *
 * Note this is a UX guard only — the actual amountOutMin sent on-chain is always derived from the
 * live route.amountOut at submit time (see Swap.jsx handleSwap), so a stale display never lets an
 * unsafe trade through; this just decides when to interrupt the user about it.
 *
 * @returns {{ priceMoved: boolean, nextBaseline: bigint }}
 */
export function evaluateQuoteAgainstBaseline(baselineAmountOut, currentAmountOut, slippageBps) {
  if (typeof currentAmountOut !== 'bigint') {
    return { priceMoved: false, nextBaseline: baselineAmountOut ?? null };
  }
  if (baselineAmountOut === null || baselineAmountOut === undefined) {
    return { priceMoved: false, nextBaseline: currentAmountOut };
  }
  if (currentAmountOut >= baselineAmountOut) {
    return { priceMoved: false, nextBaseline: currentAmountOut };
  }
  const floor = applySlippage(baselineAmountOut, slippageBps, 'min');
  if (currentAmountOut < floor) {
    return { priceMoved: true, nextBaseline: baselineAmountOut };
  }
  return { priceMoved: false, nextBaseline: baselineAmountOut };
}

/**
 * The floor and the value for a buy — with one special case: a buy that FINISHES the curve.
 *
 * When a buy asks for more tokens than the curve has left, BondingCurve.buy clamps it to the
 * remainder, charges exactly what those last tokens cost and refunds the rest in the same
 * transaction. The buyer cannot overpay, so a slippage floor protects nothing there — and it does
 * real harm: the floor is a share of the remainder AT QUOTE TIME, so any smaller buy landing first
 * shrinks the remainder below it and the finishing buy reverts with "Slippage". On 2026-09-18 the
 * $HRT curve sat 0.0000000002 tokens short of graduating for exactly this reason while a run of
 * ever-smaller buys kept beating every normal-sized one to the block.
 *
 * So a finishing buy uses a floor of 1 wei (the contract itself requires a non-zero output), and
 * sends only what the remainder can cost instead of the whole typed amount: the buyer's own quote
 * gives an average price that is at or above the price of the cheaper tokens that are left, so
 * `remaining × netInput / rawOut` is an upper bound on their cost; four times that, plus a wei
 * cushion, always reaches the clamp. If someone else finishes the curve first, only that dust —
 * not the typed amount — reaches the pool with the 1-wei floor.
 *
 * @param {{expectedOut: bigint, finishing?: boolean, netInput?: bigint, rawOut?: bigint}} quote
 */
export function finishingBuyTerms(quote, amountWei, slippageBps) {
  const { expectedOut, finishing, netInput, rawOut } = quote || {};
  if (!finishing) return { minTokensOut: applySlippage(expectedOut, slippageBps, 'min'), valueWei: amountWei, finishing: false };
  let valueWei = amountWei;
  if (typeof netInput === 'bigint' && typeof rawOut === 'bigint' && rawOut > 0n && typeof expectedOut === 'bigint') {
    const costCeiling = (expectedOut * netInput + rawOut - 1n) / rawOut;
    const padded = costCeiling * 4n + 1_000_000n;
    if (padded < amountWei) valueWei = padded;
  }
  return { minTokensOut: 1n, valueWei, finishing: true };
}

/** Adaptive slippage tiers (basis points) keyed on the trade's QUAI value. */
export function computeAutoSlippageBps(quaiAmount) {
  const q = Number(quaiAmount) || 0;
  if (q > 50) return 300; // > 50 QUAI → 3%
  if (q > 10) return 200; // 10–50 QUAI → 2%
  if (q >= 1) return 100; // 1–10 QUAI → 1%
  return 50; // < 1 QUAI → 0.5%
}

/**
 * The indexer/API serve addresses all-lowercase, but quais' validateAddress (run by wallets on the
 * tx `to` and by newer quais paths) REJECTS lowercase with "invalid address checksum". Every address
 * that reaches quais must be checksum-normalized first — this killed all sells on 2026-07-06.
 */
export function checksummed(quais, address) {
  try {
    return quais.getAddress(address);
  } catch (err) {
    // Fail LOUD, not quiet: a malformed/invalid-checksum address must never reach quais/a tx
    // as an unnormalized string — that's the exact class of bug that killed all sells on
    // 2026-07-06. Every call site here already runs inside a send*'s try/catch, so throwing
    // surfaces as a normal user-facing error instead of silently sending garbage.
    throw new Error(`Invalid address: ${address} (${err?.message || 'checksum failed'})`);
  }
}

/**
 * One approval per (wallet, token, curve), ever. LaunchToken.transferFrom skips the allowance
 * decrement only when the allowance is type(uint256).max; any smaller ceiling is consumed by the
 * next sell and re-prompts the wallet. Owner decision 2026-09-17: unlimited once is the default.
 * Kept as a local constant so this pure module never needs the dynamic quais import.
 */
export const UNLIMITED_ALLOWANCE = (1n << 256n) - 1n;

export function needsApproval(allowance, amountWei) {
  if (typeof amountWei !== 'bigint' || amountWei <= 0n) return false;
  if (typeof allowance !== 'bigint') return true; // unknown → approve, never assume
  return allowance < amountWei;
}

/**
 * The launch-window cap exactly as BondingCurve.buy computes it:
 *   active  iff block.number < launchBlock + SNIPE_WINDOW_BLOCKS (20)
 *   capWei  = curveSupply * PER_WALLET_CAP_BPS (100) / 10000
 *   remaining = capWei - boughtDuringSnipeWindow[wallet], floored at 0
 * Pure, so the panel's banner and the tests share one formula with the contract.
 */
export const SNIPE_WINDOW_BLOCKS = 20;
export const PER_WALLET_CAP_BPS = 100n;

export function snipeWindowState({ launchBlock, currentBlock, curveSupply, boughtWei = 0n }) {
  // Unknown inputs mean "not active", never "block 0". Number(null) is 0, which would otherwise
  // read as a token launched at genesis with the window still open.
  const lb = launchBlock == null ? NaN : Number(launchBlock);
  const cb = currentBlock == null ? NaN : Number(currentBlock);
  if (!Number.isFinite(lb) || !Number.isFinite(cb) || typeof curveSupply !== 'bigint') {
    return { active: false, blocksLeft: 0, capWei: 0n, remainingWei: 0n };
  }
  const end = lb + SNIPE_WINDOW_BLOCKS;
  const active = cb < end;
  const capWei = (curveSupply * PER_WALLET_CAP_BPS) / 10_000n;
  const bought = typeof boughtWei === 'bigint' ? boughtWei : 0n;
  const remainingWei = capWei > bought ? capWei - bought : 0n;
  return { active, blocksLeft: active ? end - cb : 0, capWei, remainingWei };
}

/**
 * quais wraps any JSON-RPC failure it cannot classify as
 * `makeError('could not coalesce error', 'UNKNOWN_ERROR', { error, payload, shard })`
 * (node_modules/quais/lib/esm/providers/provider-jsonrpc.js `getRpcError`) — `payload.method` is the
 * exact RPC call that failed, straight from the request quais sent. That method name is the one
 * reliable signal for "this failed on a read, before the wallet ever signed anything" versus "the
 * wallet's own send call itself failed," which can mean the transaction WAS broadcast and only the
 * response back to us was lost.
 */
function failedRpcMethod(err, seen = new Set()) {
  if (err == null || typeof err !== 'object' || seen.has(err)) return null;
  seen.add(err);
  if (err.payload && typeof err.payload.method === 'string') return err.payload.method;
  for (const key of ['error', 'info', 'cause']) {
    const found = failedRpcMethod(err[key], seen);
    if (found) return found;
  }
  return null;
}

/**
 * quais's own JsonRpcSigner.sendTransaction polls for the transaction right after
 * `quai_sendTransaction` returns a hash, and if THAT poll fails it stamps
 * `error.info.sendTransactionHash = <hash>` before rejecting (provider-jsonrpc.js) — its own way of
 * saying "this transaction was sent; only the follow-up lookup failed." Any error carrying this
 * marker anywhere in its chain is broadcast-ambiguous, full stop — resending here could double-buy
 * or double-sell no matter what RPC method or message the error otherwise reports.
 */
function hasBroadcastMarker(err, seen = new Set()) {
  if (err == null || typeof err !== 'object' || seen.has(err)) return false;
  seen.add(err);
  if (err.info && typeof err.info === 'object' && err.info.sendTransactionHash) return true;
  if (err.sendTransactionHash) return true;
  return ['error', 'info', 'cause'].some((key) => hasBroadcastMarker(err[key], seen));
}

// The one call that actually puts a transaction on the wire (quais's JsonRpcSigner uses
// quai_sendTransaction exclusively — see sendUncheckedTransaction — but quai_sendRawTransaction is
// listed too since getRpcError itself treats both as the same broadcast case).
const BROADCAST_RPC_METHODS = new Set(['quai_sendTransaction', 'quai_sendRawTransaction']);

// Read-only RPC calls that can happen on the way to a send — a nonce/balance/gas probe, a chain-id
// check — none of which puts anything on the wire, so all of them are safe to repeat. Anything NOT
// on this allowlist, including "we couldn't tell which RPC call failed," is treated as unsafe: see
// isSafeToRetryBeforeBroadcast below.
const SAFE_PRE_BROADCAST_METHODS = new Set([
  'quai_blockNumber',
  'quai_getTransactionCount',
  'quai_chainId',
  'eth_chainId',
  'quai_getBalance',
  'quai_estimateGas',
  'quai_call',
  'quai_gasPrice',
]);

/**
 * True only when the evidence PROVES a failure happened before anything reached the mempool: either
 * quais already decoded it as a call/estimateGas failure (isMissingRevertData — always a read), or
 * the failing RPC call is on the read-only allowlist above AND nothing marks the transaction as
 * already sent. False whenever that can't be proven — including "unknown RPC method" or "the
 * failing call IS quai_sendTransaction" — because guessing wrong here risks a double-send. This is
 * the one gate sendWithGasDiagnostics uses to decide whether a raw, unclassified RPC error (quais's
 * "could not coalesce error" among them — see rapid-trading fix 2026-09-29) is safe to retry.
 */
export function isSafeToRetryBeforeBroadcast(err) {
  if (hasBroadcastMarker(err)) return false;
  if (isMissingRevertData(err)) return true;
  const method = failedRpcMethod(err);
  if (method == null || BROADCAST_RPC_METHODS.has(method)) return false;
  return SAFE_PRE_BROADCAST_METHODS.has(method);
}

export async function sendWithGasDiagnostics({ send, estimateGas }) {
  try {
    return await send({});
  } catch (err) {
    if (isMissingRevertData(err)) {
      let estimate;
      try {
        estimate = BigInt(await estimateGas());
      } catch (diagnosticError) {
        const reason = errorMessages(diagnosticError).find(
          (message) => message && !/missing revert data/i.test(message),
        );
        if (reason) throw new Error(`Transaction rejected on-chain: ${reason}`);
        throw err;
      }
      return send({ gasLimit: (estimate * 130n) / 100n });
    }

    // SAFETY (rapid-trading "could not coalesce" fix, 2026-09-29): a raw, unclassified RPC failure
    // may be a transient hiccup on a READ the wallet made before signing anything (its own
    // pending-nonce probe, a rate-limited public RPC node lagging behind a trade sent moments ago) —
    // safe to retry once, nothing was ever broadcast. It may equally be the wallet's own send call
    // failing AFTER actually broadcasting, which is ambiguous and must NEVER be retried
    // automatically — that's exactly the class of bug that could double-buy/double-sell.
    // isSafeToRetryBeforeBroadcast only returns true when the failing RPC call is provably a
    // pre-broadcast read; everything else (including "can't tell") falls through and rethrows.
    if (isSafeToRetryBeforeBroadcast(err)) {
      return await send({});
    }
    throw err;
  }
}

/**
 * WALLET = SIGNING ONLY (2026-09-30 hotfix, "could not coalesce error" / "sell limits still
 * loading" / failed launches).
 *
 * Root cause: quais's JsonRpcSigner.sendTransaction (the path every `contract.method(...)` call
 * uses, node_modules/quais/lib/esm/providers/provider-jsonrpc.js) does provider.getBlockNumber()
 * BEFORE sending, sendUncheckedTransaction does provider.estimateGas() whenever gasLimit is
 * missing, and it then polls provider.getTransaction(hash) — every one of those against the
 * WALLET's own BrowserProvider (Pelagus/Blip in-app), not our RPC. Any hiccup or unsupported read
 * on that side surfaced as quais's generic "could not coalesce error" even when the trade would
 * have gone through fine.
 *
 * This is the ONE place a real trade/approve/launch transaction reaches the wallet from here on:
 * gas is estimated on OUR read provider (`rpc`, proxy->direct failover already built in — see
 * curveReads.js) against the EXACT from/to/data/value about to be sent, then the wallet is asked
 * for a signature + broadcast via sendUncheckedTransaction with an explicit gasLimit — so quais
 * never queues an internal estimateGas() against the wallet either, and because this bypasses
 * sendTransaction() entirely, the wallet is never asked for getBlockNumber() or a post-send
 * getTransaction() poll. The wallet's provider sees exactly ONE RPC call: quai_sendTransaction.
 *
 * An estimate-time revert is diagnosed and thrown BEFORE anything is sent — nothing reaches the
 * wallet at all on a genuine revert. "missing revert data" (masked, no more info to extract) is
 * rethrown as-is for classifyTradeError's dedicated mapping; quais's own "could not coalesce"
 * catch-all is likewise rethrown as-is so its honest copy applies, rather than being misreported
 * as an on-chain rejection. A transient, provably pre-broadcast estimate failure
 * (isSafeToRetryBeforeBroadcast) is retried once — nothing has broadcast yet, so this can never
 * double-send. Everything else is a decoded contract reason and is surfaced plainly. The final
 * sendUncheckedTransaction call is never retried on failure: its only possible failing RPC method
 * is quai_sendTransaction itself, which isSafeToRetryBeforeBroadcast always refuses — a failure
 * there is broadcast-ambiguous by construction (rapid-trading double-send guard, 2026-09-29).
 *
 * `gasEstimate` (PR1 latency programme, optional): a bigint OR a Promise<bigint> the caller may
 * already have started — tradeEngine.js's submitTrade fires a speculative `rpc.estimateGas` call
 * in parallel with the forced-fresh quote, on the SAME tx shape this function would otherwise
 * estimate itself, so the two round trips that used to run back-to-back land together instead.
 * When it resolves, its value is used and the live `estimateOnce()` below is skipped entirely;
 * when it rejects (stale, superseded, or just failed), this falls straight through to the normal
 * live-estimate path below, UNCHANGED — the diagnostics, retry and error-mapping behavior a caller
 * that never passes `gasEstimate` sees is identical to before this parameter existed.
 *
 * @returns {Promise<string>} the transaction hash returned by quai_sendTransaction
 */
export async function sendUncheckedWithGasDiagnostics({ signer, rpc, from, to, data, value = 0n, gasEstimate, gasHeadroomPercent = 130 }) {
  if (!Number.isInteger(gasHeadroomPercent) || gasHeadroomPercent < 110 || gasHeadroomPercent > 200) throw new Error('Gas headroom must be 110–200%.');
  const tx = { from, to, data, value };
  const estimateOnce = () => rpc.estimateGas(tx);

  let estimate;
  if (gasEstimate !== undefined) {
    try {
      estimate = BigInt(await gasEstimate);
    } catch {
      estimate = undefined; // fall through to the live estimate below, exactly as if none was passed
    }
  }

  if (estimate === undefined) {
    try {
      estimate = BigInt(await estimateOnce());
    } catch (err) {
      if (isMissingRevertData(err)) throw err; // masked — nothing more to learn, nothing was sent
      if (err?.code === 'UNKNOWN_ERROR' && !isSafeToRetryBeforeBroadcast(err)) throw err; // honest "could not confirm" copy, not a fabricated on-chain reason
      if (isSafeToRetryBeforeBroadcast(err)) {
        // Nothing has broadcast yet: a coalesced/transient hiccup on OUR OWN read provider (its own
        // proxy->direct failover already had one attempt) is always safe to retry once more.
        estimate = BigInt(await estimateOnce());
      } else {
        const reason = errorMessages(err).find((message) => message && !/missing revert data/i.test(message));
        throw reason ? new Error(`Transaction rejected on-chain: ${reason}`) : err;
      }
    }
  }

  const gasLimit = (estimate * BigInt(gasHeadroomPercent)) / 100n;
  return signer.sendUncheckedTransaction({ from, to, data, value, gasLimit });
}

// PR1 latency programme (2026-10-02): halved both ends of the backoff — a confirmed trade now
// shows up client-side up to 2x sooner on fast blocks, same shape (doubling, capped) otherwise.
export const RECEIPT_POLL_START_MS = 500;
export const RECEIPT_POLL_MAX_MS = 2_000;
export const RECEIPT_TIMEOUT_MS = 180_000; // 3 minutes

/**
 * A mined receipt with status 0: the transaction was broadcast AND definitively reverted on-chain,
 * so nothing it was meant to do happened. quais's own `tx.wait()` threw in this case; waitForReceipt
 * must too, or every caller that only awaits it would report a reverted swap/stake/launch as a
 * success (44 call sites after the 2026-09-30 wallet-signing-only migration — only three of them
 * inspected `receipt.status`). Carries the hash so the UI can still link the explorer.
 */
export class TransactionRevertedError extends Error {
  constructor(hash, { explorerUrl = null } = {}) {
    const where = explorerUrl && hash ? ` (${explorerUrl.replace(/\/$/, '')}/tx/${hash})` : '';
    super(`Transaction reverted on-chain${where}. Nothing was changed — check the amount, slippage or limits and try again.`);
    this.name = 'TransactionRevertedError';
    this.code = 'TX_REVERTED';
    this.hash = hash;
  }
}

export class ReceiptTimeoutError extends Error {
  constructor(hash, { explorerUrl = null, timeoutMs = RECEIPT_TIMEOUT_MS } = {}) {
    const where = explorerUrl && hash ? `${explorerUrl.replace(/\/$/, '')}/tx/${hash}` : 'the explorer';
    super(`Still waiting on the network after ${Math.round(timeoutMs / 1000)}s. The trade may still confirm — check ${where} or your wallet before trying again.`);
    this.name = 'ReceiptTimeoutError';
    this.code = 'RECEIPT_TIMEOUT';
    this.hash = hash;
  }
}

/**
 * Confirmation through OUR read provider, never the wallet's — replaces `tx.wait()`, which quais
 * resolves by polling `getTransactionReceipt` against whatever provider produced the
 * TransactionResponse (the wallet's BrowserProvider, for every trade/approve/launch here).
 *
 * Polls `provider.getTransactionReceipt(hash)` with backoff (1s -> 4s, capped). A transient read
 * error (network blip, a proxy hiccup the provider's own failover didn't already absorb) is
 * swallowed and retried — this never rejects on a mere read hiccup. Only running past `timeoutMs`
 * rejects, with a RECEIPT_TIMEOUT error whose message never claims the trade failed (it may still
 * confirm) and points at the explorer.
 *
 * A mined receipt with `status === 0` rejects with TransactionRevertedError (code TX_REVERTED) —
 * the same contract quais's `tx.wait()` had — unless `throwOnRevert: false`, for callers that
 * inspect `receipt.status` themselves.
 *
 * `subscribeBlocks` (PR2 latency programme, optional): `(cb) => unsubscribe`. When given, every
 * `cb()` call (TradeQueueContext wires this to the live hub's GLOBAL-channel 'head' frames — a new
 * block) triggers an IMMEDIATE receipt check, on top of the 0.5s→2s poll loop below, which keeps
 * running unchanged as the fallback (hub down, upstream subscription off, or the push frame simply
 * loses the race to the next poll tick). A single in-flight guard is shared by both triggers, so a
 * block tick landing mid-poll just no-ops rather than firing a second concurrent read.
 * `unsubscribe` is called exactly once, whenever this settles (resolve, reject or timeout).
 */
export async function waitForReceipt(hash, { provider, timeoutMs = RECEIPT_TIMEOUT_MS, pollMs = RECEIPT_POLL_START_MS, explorerUrl = null, throwOnRevert = true, subscribeBlocks = null } = {}) {
  if (!provider) throw new Error('waitForReceipt requires a provider.');
  if (!hash) throw new Error('waitForReceipt requires a transaction hash.');
  const deadline = Date.now() + timeoutMs;
  let delay = pollMs;
  let settled = false;
  let settleResolve;
  let settleReject;
  const result = new Promise((resolve, reject) => { settleResolve = resolve; settleReject = reject; });

  let checking = false; // single in-flight guard shared by the poll loop and any block-triggered check
  async function checkOnce() {
    if (settled || checking) return;
    checking = true;
    try {
      const receipt = await provider.getTransactionReceipt(hash);
      if (receipt && !settled) {
        settled = true;
        if (throwOnRevert && receipt.status != null && Number(receipt.status) === 0) {
          settleReject(new TransactionRevertedError(hash, { explorerUrl }));
        } else {
          settleResolve(receipt);
        }
      }
    } catch {
      // Transient read failure — never reject on this alone; the poll loop (or the next block tick)
      // keeps trying until the deadline.
    } finally {
      checking = false;
    }
  }

  let unsubscribe = null;
  if (typeof subscribeBlocks === 'function') {
    try {
      unsubscribe = subscribeBlocks(() => { checkOnce(); });
    } catch {
      unsubscribe = null; // a broken subscriber must never break the fallback poll below
    }
  }

  (async () => {
    for (;;) {
      if (settled) return;
      await checkOnce();
      if (settled) return;
      if (Date.now() >= deadline) {
        settled = true;
        settleReject(new ReceiptTimeoutError(hash, { explorerUrl, timeoutMs }));
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, RECEIPT_POLL_MAX_MS);
    }
  })();

  try {
    return await result;
  } finally {
    settled = true;
    if (typeof unsubscribe === 'function') {
      try { unsubscribe(); } catch { /* ignore */ }
    }
  }
}

export function classifyTradeError(err) {
  const messages = errorMessages(err);
  const message = messages.join(' | ');

  if (err?.code === 4001 || /user rejected/i.test(message)) {
    return 'Transaction rejected in wallet. Nothing was submitted.';
  }
  // waitForReceipt's own timeout (2026-09-30 hotfix): the trade was already broadcast — this is
  // never "the trade failed," only "we stopped waiting." Its own message already says so and
  // names the explorer; never let a later, less specific branch below overwrite that.
  if (err?.code === 'RECEIPT_TIMEOUT') {
    return err.message || 'Still waiting on the network. The trade may still confirm — check your wallet or the explorer before trying again.';
  }
  // A mined-but-reverted receipt (waitForReceipt's TX_REVERTED): definite, nothing changed.
  if (err?.code === 'TX_REVERTED') {
    return err.message || 'Transaction reverted on-chain. Nothing was changed — check the amount, slippage or limits and try again.';
  }
  // A wallet extension that doesn't support sendUncheckedTransaction/quai_sendTransaction the way
  // this app now calls it (2026-09-30 hotfix: wallet = signing only) — distinct from a genuine
  // on-chain rejection, so it gets its own actionable copy instead of the generic fallback.
  if (err?.code === 'UNSUPPORTED_OPERATION' || /unsupported method|method not (found|supported)/i.test(message)) {
    return "Your wallet doesn't support sending this transaction. Try updating your wallet extension, then reconnect and try again.";
  }
  if (/creator allocation still locked|still vesting/i.test(message)) {
    return 'Part of your creator allocation is still vesting. Sell only the available amount shown.';
  }
  if (/insufficient allowance/i.test(message)) {
    return 'Token approval is missing or stale. Refresh and approve the sell again.';
  }
  if (/insufficient balance|insufficient funds/i.test(message)) {
    return 'Insufficient balance to cover this trade + gas.';
  }
  if (/slippage/i.test(message)) {
    return 'Price moved beyond your slippage tolerance. Try again or increase slippage.';
  }
  // Anti-snipe caps enforced on-chain (BondingCurve.sol): invisible in the UI until now, so a rapid
  // buy on a fresh launch failed with raw revert text or a generic "could not verify" message.
  if (/per-wallet snipe-window cap/i.test(message)) {
    return 'Launch protection: for the first 20 blocks each wallet can buy at most 1% of the curve supply. Try a smaller amount or wait a minute.';
  }
  if (/creator launch-block cap/i.test(message)) {
    return 'Creators can buy at most 2% of the curve supply in the launch block. Try again next block.';
  }
  if (/zero out|pool reserve floor|insufficient pool liquidity/i.test(message)) {
    return 'This amount is more than the pool can fill right now. Try a smaller amount.';
  }
  if (isMissingRevertData(err)) {
    return 'The wallet could not verify this trade. Refresh balances and try again.';
  }
  // Rapid back-to-back trades (rapid-trading fix, 2026-09-29): quais classifies these four shapes
  // from quai_sendTransaction/quai_sendRawTransaction into clean codes/messages when the wallet's
  // own RPC node returns the standard text (node_modules/quais/.../provider-jsonrpc.js
  // getRpcError) — but that classification alone still surfaces a bare, unfriendly string, so map
  // it here to what the trader should actually do next.
  if (err?.code === 'NONCE_EXPIRED' || (/nonce/i.test(message) && /(too low|already (been )?used|expired)/i.test(message))) {
    return "Your previous trade is still catching up on the network. Wait a few seconds for it to confirm, then try again.";
  }
  if (err?.code === 'REPLACEMENT_UNDERPRICED' || (/replacement transaction/i.test(message) && /underpriced/i.test(message))) {
    return 'Another trade from your wallet is still pending at the same nonce. Wait for it to confirm (or speed it up in your wallet), then try again.';
  }
  if (err?.code === 'TRANSACTION_ALREADY_KNOWN' || /already known/i.test(message)) {
    return 'This trade is already submitted and pending — check your wallet or the explorer. No need to send it again.';
  }
  if (/429|too many requests|rate.?limit/i.test(message)) {
    return 'The network is busy right now. Wait a moment and try again.';
  }
  // The catch-all for quais's own "could not coalesce error" (UNKNOWN_ERROR) — and anything else
  // that reached this point without being decoded. Never show that raw internal string: whether the
  // trade actually reached the network is genuinely unknown from here, so the copy says so instead
  // of guessing either way.
  if (err?.code === 'UNKNOWN_ERROR' || /could not coalesce/i.test(message)) {
    return 'Could not confirm this trade with your wallet or the network just now. Check your wallet (or the explorer) before trying again.';
  }
  return messages[0] || 'Trade failed. Please try again.';
}
