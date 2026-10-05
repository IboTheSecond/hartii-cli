// Node-safe port of src/utils/curveQuoteMath.js; m2Reads.test.mjs checks parity against it.
// The original imports browser/Vite code. On-chain quotes remain authoritative for writes.
import { computeBuyQuote, computeSellQuote } from '../vendor/src/utils/tradeTx.js';

// Copied from src/utils/curveReads.js's REFERENCE_WEI (0.01 QUAI) — a price-impact reference
// amount only, never itself a traded value. See that file for the empirical justification.
export const REFERENCE_WEI = 10n ** 16n;

const isBigInt = (x) => typeof x === 'bigint';

/** Round-UP division, exactly as BondingCurveV3/V4's `_ceilDiv`. */
function ceilDiv(a, b) {
  return a === 0n ? 0n : (a - 1n) / b + 1n;
}

/**
 * Tokens out for `quaiInNet` (already fee-netted), ignoring fees. Null (never a guess) when a
 * field the current phase needs is missing, or on a degenerate input. See
 * src/utils/curveQuoteMath.js's rawBuyOut for the full derivation/comments.
 */
export function rawBuyOut(state, quaiInNet) {
  if (!isBigInt(quaiInNet) || quaiInNet < 0n) return null;
  const { graduated, isV3, virtualQuaiReserve, virtualTokenReserve, realQuaiReserve, tokensSold, poolQuaiReserve, poolTokenReserve } = state || {};
  try {
    if (graduated) {
      if (!isV3) return null;
      if (!isBigInt(poolQuaiReserve) || !isBigInt(poolTokenReserve)) return null;
      return poolTokenReserve - ceilDiv(poolQuaiReserve * poolTokenReserve, poolQuaiReserve + quaiInNet);
    }
    if (!isBigInt(virtualQuaiReserve) || !isBigInt(virtualTokenReserve) || !isBigInt(realQuaiReserve) || !isBigInt(tokensSold)) return null;
    const qr2 = virtualQuaiReserve + realQuaiReserve;
    const tr2 = virtualTokenReserve - tokensSold;
    return tr2 - (qr2 * tr2) / (qr2 + quaiInNet);
  } catch {
    return null;
  }
}

/** QUAI out (gross, ignoring fees) for `tokensIn`. Same null-on-missing-field contract as rawBuyOut. */
export function rawSellOut(state, tokensIn) {
  if (!isBigInt(tokensIn) || tokensIn < 0n) return null;
  const { graduated, isV3, virtualQuaiReserve, virtualTokenReserve, realQuaiReserve, tokensSold, poolQuaiReserve, poolTokenReserve } = state || {};
  try {
    if (graduated) {
      if (!isV3) return null;
      if (!isBigInt(poolQuaiReserve) || !isBigInt(poolTokenReserve)) return null;
      return poolQuaiReserve - ceilDiv(poolQuaiReserve * poolTokenReserve, poolTokenReserve + tokensIn);
    }
    if (!isBigInt(virtualQuaiReserve) || !isBigInt(virtualTokenReserve) || !isBigInt(realQuaiReserve) || !isBigInt(tokensSold)) return null;
    const qr2 = virtualQuaiReserve + realQuaiReserve;
    const tr2 = virtualTokenReserve - tokensSold;
    return qr2 - (qr2 * tr2) / (tr2 + tokensIn);
  } catch {
    return null;
  }
}

/**
 * Same shape as the real curveReads.js's quoteOnChain, computed entirely from an already-fetched
 * `meta` — zero RPC. Returns null whenever rawBuyOut/rawSellOut can't (missing fields, invalid
 * amount); callers in this CLI (buy.js/sell.js) always have the authoritative on-chain
 * quoteBuy/quoteSell too (curveState.js) and use THIS only as a local cross-check/divergence
 * signal, never as the number that sets minTokensOut/minQuaiOut on a real send.
 */
export function localQuote({ meta, side, amountWei }) {
  if (!meta || typeof amountWei !== 'bigint' || amountWei <= 0n) return null;
  if (side === 'buy') {
    const tokensRemaining = meta.graduated ? null : meta.tokensRemaining;
    let netInput;
    try {
      ({ netInput } = computeBuyQuote(amountWei, 0n, meta.feeBps, tokensRemaining));
    } catch {
      return null;
    }
    const raw = rawBuyOut(meta, netInput);
    if (raw === null) return null;
    const refRaw = rawBuyOut(meta, REFERENCE_WEI);
    if (refRaw === null) return null;
    let expectedOut;
    try {
      ({ expectedOut } = computeBuyQuote(amountWei, raw, meta.feeBps, tokensRemaining));
    } catch {
      return null;
    }
    const finishing = typeof tokensRemaining === 'bigint' && tokensRemaining > 0n && raw > tokensRemaining;
    return { expectedOut, meta, finishing, netInput, rawOut: raw, referenceWei: REFERENCE_WEI, referenceOut: refRaw };
  }
  if (side === 'sell') {
    const gross = rawSellOut(meta, amountWei);
    if (gross === null) return null;
    const refRaw = rawBuyOut(meta, REFERENCE_WEI);
    if (refRaw === null) return null;
    let expectedOut;
    try {
      ({ expectedOut } = computeSellQuote(amountWei, gross, meta.feeBps));
    } catch {
      return null;
    }
    return { expectedOut, meta, referenceWei: REFERENCE_WEI, referenceOut: refRaw };
  }
  return null;
}

/**
 * Divergence between a local quote and the real on-chain quote, in basis points of the on-chain
 * figure. Ported verbatim from src/utils/tradeEngine.js's quoteDivergenceBps (that file is itself
 * pure *for this function* — no imports it needs — but living inside tradeEngine.js, which does
 * import the browser-only chain, so it's copied here rather than imported). Debug/sanity signal
 * only; never used to decide what gets sent.
 */
export function quoteDivergenceBps(localOut, onChainOut) {
  const local = Number(localOut ?? 0n);
  const onChain = Number(onChainOut ?? 0n);
  if (!Number.isFinite(local) || !Number.isFinite(onChain)) return 0;
  if (onChain === 0) return local === 0 ? 0 : local > 0 ? 10_000 : -10_000;
  return Math.round(((local - onChain) / onChain) * 10_000);
}
