// packages/hartii-cli/src/trade.js
//
// Shared buy/sell quote+build logic (bonding curve only — see buy.js/sell.js for why this CLI
// never routes a curve-launched token's buy/sell to an external HartiiSwap pair: AGENTS.md is
// explicit that graduation moves a curve to an INTERNAL pool, never an external DEX, and
// src/utils/tradeEngine.js — the main repo's own, single, grep-fenced call site for curve
// buy/sell — only ever targets the curve contract, pre- or post-graduation, picking the plain or
// deadline-carrying ABI on `isV3`. "Curve vs pair routing" in this CLI is therefore the bonding-
// math vs pool-math QUOTE the curve itself answers with, gated on `graduated`+`isV3` — never a
// different contract address).
//
// Quote authority: the curve's OWN on-chain quoteBuy/quoteSell (curveState.js) is what prices the
// real send — it is, literally, "the repo's curve math", since it is the deployed contract
// evaluating its own formula. curveQuote.js's ported rawBuyOut/rawSellOut (mirroring
// src/utils/curveQuoteMath.js) is computed from the SAME freshly-read state purely as a
// divergence/sanity cross-check (mirrors tradeEngine.js's quoteDivergenceBps/verifyQuoteInBackground
// pattern) — never the number minTokensOut/minQuaiOut is built from.
import { applySlippage, computeBuyQuote, computeSellQuote, finishingBuyTerms } from '../vendor/src/utils/tradeTx.js';
import { deadlineTimestamp } from '../vendor/src/utils/deadline.js';
import { readCurveMeta, quoteBuyOnChain, quoteSellOnChain, encodeBuy, encodeSell, assertVerifiedCurve } from './curveState.js';
import { rawBuyOut, rawSellOut, quoteDivergenceBps } from './curveQuote.js';
import { CliError, rethrowAs } from './errors.js';
import { resolveToken, MarketError } from './marketApi.js';
import { assertCyprus1QuaiAddress } from './address.js';

const DIVERGENCE_WARN_BPS = 50; // 0.5% — purely informational; the on-chain figure always wins

export class TradeError extends CliError {}

/**
 * Resolves a buy/sell <token> to its verified bonding curve. Market and trade failures are rethrown
 * as `ErrorClass` (BuyError / SellError) so the caller's own error type reaches the user.
 */
export async function resolveCurveToken(input, { provider, network, deps, ErrorClass }) {
  const tokenInfo = await rethrowAs(MarketError, ErrorClass, () => resolveToken(input, deps));
  if (!tokenInfo.curveAddress) {
    throw new ErrorClass(`"${input}" has no bonding curve this CLI can trade (venue: ${tokenInfo.venue}). Trade it on hartiilabs.com instead.`);
  }
  const curveAddress = assertCyprus1QuaiAddress(tokenInfo.curveAddress);
  const tokenAddress = assertCyprus1QuaiAddress(tokenInfo.address);
  await assertVerifiedCurve(provider, curveAddress, tokenAddress, network);
  return { tokenInfo, curveAddress, tokenAddress };
}

/** Informational summary row when the local cross-check disagrees with the on-chain quote. */
export const divergenceSummary = (quote) => (quote.divergenceWarning
  ? { quoteDivergenceWarning: `local cross-check diverged ${quote.divergenceBps} bps from the on-chain quote — proceeding on the on-chain figure` }
  : {});

/** Runs a quote builder; TradeError passes its message through, anything else becomes "Could not quote this <side>". */
export async function quoteAs(ErrorClass, side, build) {
  try {
    return await build();
  } catch (err) {
    if (err instanceof TradeError) throw new ErrorClass(err.message);
    throw new ErrorClass(`Could not quote this ${side}: ${err?.message || err}`);
  }
}

/**
 * Prices a buy of `quaiInWei` QUAI into a curve. Returns everything buy.js needs to build the tx
 * AND show a confirmation summary: the authoritative on-chain quote, the local cross-check, slip-
 * page-adjusted minTokensOut, and the exact calldata (ABI/deadline picked from live `isV3`).
 * @param {import('quais').JsonRpcProvider} provider
 * @param {string} curveAddress
 * @param {bigint} quaiInWei gross QUAI the user is spending (fee is netted inside, same as the contract)
 * @param {number} slippageBps
 */
export async function quoteAndBuildBuy(provider, curveAddress, quaiInWei, slippageBps) {
  const meta = await readCurveMeta(provider, curveAddress);
  const tokensRemaining = meta.graduated ? null : meta.tokensRemaining;
  const { netInput } = computeBuyQuote(quaiInWei, 0n, meta.feeBps, tokensRemaining);

  const rawOnChain = await quoteBuyOnChain(provider, curveAddress, netInput);
  const { expectedOut } = computeBuyQuote(quaiInWei, rawOnChain, meta.feeBps, tokensRemaining);
  const finishing = typeof tokensRemaining === 'bigint' && tokensRemaining > 0n && rawOnChain > tokensRemaining;

  const localRaw = rawBuyOut(meta, netInput);
  const divergenceBps = localRaw === null ? null : quoteDivergenceBps(localRaw, rawOnChain);

  // A finishing buy uses a 1-wei floor and sends only what the remainder costs (tradeTx.js's rule).
  const { minTokensOut, valueWei } = finishingBuyTerms({ expectedOut, finishing, netInput, rawOut: rawOnChain }, quaiInWei, slippageBps);
  const deadline = meta.isV3 ? deadlineTimestamp() : undefined;
  const data = encodeBuy(minTokensOut, { isV3: meta.isV3, deadline });

  return { valueWei, meta, netInput, rawOnChain, expectedOut, finishing, minTokensOut, deadline, data, divergenceBps, divergenceWarning: divergenceBps !== null && Math.abs(divergenceBps) > DIVERGENCE_WARN_BPS };
}

/**
 * Prices a sell of `tokensInWei` tokens. Same authority/cross-check split as quoteAndBuildBuy.
 */
export async function quoteAndBuildSell(provider, curveAddress, tokensInWei, slippageBps) {
  const meta = await readCurveMeta(provider, curveAddress);

  const grossOnChain = await quoteSellOnChain(provider, curveAddress, tokensInWei);
  const { expectedOut } = computeSellQuote(tokensInWei, grossOnChain, meta.feeBps);

  const localGross = rawSellOut(meta, tokensInWei);
  const divergenceBps = localGross === null ? null : quoteDivergenceBps(localGross, grossOnChain);

  const minQuaiOut = applySlippage(expectedOut, slippageBps, 'min');
  const deadline = meta.isV3 ? deadlineTimestamp() : undefined;
  const data = encodeSell(tokensInWei, minQuaiOut, { isV3: meta.isV3, deadline });

  return { meta, grossOnChain, expectedOut, minQuaiOut, deadline, data, divergenceBps, divergenceWarning: divergenceBps !== null && Math.abs(divergenceBps) > DIVERGENCE_WARN_BPS };
}

/** Parses "3" / "3%" style slippage flags into whole basis points, defaulting to 300 (3%). */
export function parseSlippageBps(input, fallbackPct = 3) {
  if (input === undefined || input === null || input === '') return Math.round(fallbackPct * 100);
  const raw = String(input).replace(/%$/, '');
  const pct = Number(raw);
  if (!/^\d+(\.\d{1,2})?$/.test(raw) || pct < 0 || pct >= 100) {
    throw new TradeError('Slippage must be a decimal percentage from 0 to 99.99, with at most two decimal places.');
  }
  return Math.round(pct * 100);
}
