import { address, invariant, timestamp, uint } from './validation.mjs';
import { HBOME_TOKEN, VENUES } from './policy.mjs';
const SCALE = 1000000000000000000n;
export function closedCandles(candles, now, minimum = 35) {
  timestamp(now); invariant(Array.isArray(candles) && candles.length <= 10080, 'invalid-candles');
  for (const c of candles) { timestamp(c.openTime); timestamp(c.closeTime); invariant(c.closeTime - c.openTime === 60000 && c.openTime % 60000 === 0, 'invalid-candle-window'); uint(c.volumeWei); invariant(uint(c.closeWei) > 0n, 'invalid-candle-price'); }
  const closed = candles.filter(c => c.closeTime <= now);
  invariant(closed.length >= minimum, 'insufficient-history');
  invariant(now - closed.at(-1).closeTime < 60000, 'stale-candles');
  for (let i = 1; i < closed.length; i++) invariant(closed[i].openTime === closed[i - 1].closeTime, 'gapped-candles');
  return closed;
}
export function emaSeries(candles, period) {
  invariant(Number.isInteger(period) && period >= 1, 'invalid-ema-period');
  let value = uint(candles[0].closeWei) * SCALE;
  return candles.map((c, index) => { if (index) value += (uint(c.closeWei) * SCALE - value) * 2n / BigInt(period + 1); return value; });
}
export function validateQuote(quote, { now, policy }) {
  invariant(quote && Number.isSafeInteger(quote.at) && quote.at <= now && now - quote.at <= 30000, 'stale-or-missing-quote');
  invariant(Number.isSafeInteger(quote.impactBps) && quote.impactBps >= 0 && quote.impactBps <= policy.maxImpactBps, 'excess-or-unknown-impact');
  invariant(Number.isSafeInteger(quote.roundTripCostBps) && quote.roundTripCostBps >= 0 && quote.roundTripCostBps <= policy.maxRoundTripCostBps, 'excess-or-unknown-cost');
  return quote;
}
export function qualifyCandidate(candidate, { now = Date.now(), policy }) {
  try {
    address(candidate.token);
    invariant(candidate.token.toLowerCase() !== HBOME_TOKEN.toLowerCase(), 'hbome-excluded');
    invariant(candidate.chainId === 9 && candidate.verified === true && candidate.direct === true && VENUES.includes(candidate.venue) && policy.allowedVenues.includes(candidate.venue), 'unverified-route');
    invariant(Number.isSafeInteger(candidate.snipeEndsAt) && candidate.snipeEndsAt <= now, 'snipe-window');
    const closed = closedCandles(candidate.candles, now);
    const fast = emaSeries(closed, 5), slow = emaSeries(closed, 20);
    invariant(fast.at(-1) > slow.at(-1) && slow.at(-1) > slow.at(-2), 'trend-not-qualified');
    const volumes = Array.from({ length: 7 }, (_, i) => closed.slice(-35 + i * 5, i === 6 ? undefined : -30 + i * 5).reduce((n, c) => n + uint(c.volumeWei), 0n));
    const prior = volumes.slice(0, 6).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
    invariant(prior[2] + prior[3] > 0n && volumes[6] * 4n >= (prior[2] + prior[3]) * 3n, 'volume-not-qualified');
    validateQuote(candidate.entryQuote, { now, policy }); validateQuote(candidate.exitQuote, { now, policy });
    const metrics = { closedAt: closed.at(-1).closeTime, historyMinutes: closed.length, lastCloseWei: closed.at(-1).closeWei,
      fastEmaScaled: fast.at(-1).toString(), slowEmaScaled: slow.at(-1).toString(),
      emaSpreadBps: ((fast.at(-1) - slow.at(-1)) * 10000n / slow.at(-1)).toString(),
      slowEmaRiseBps: ((slow.at(-1) - slow.at(-2)) * 10000n / slow.at(-2)).toString(),
      latest5mVolumeWei: volumes[6].toString(), volumeRatioBps: (volumes[6] * 20000n / (prior[2] + prior[3])).toString(),
      entryImpactBps: candidate.entryQuote.impactBps, exitImpactBps: candidate.exitQuote.impactBps,
      roundTripCostBps: Math.max(candidate.entryQuote.roundTripCostBps, candidate.exitQuote.roundTripCostBps),
      entryQuoteAgeMs: now - candidate.entryQuote.at, exitQuoteAgeMs: now - candidate.exitQuote.at };
    return { qualified: true, reasons: [], fastEmaScaled: metrics.fastEmaScaled, slowEmaScaled: metrics.slowEmaScaled, metrics };
  } catch (error) { return { qualified: false, reasons: [error.code ?? 'invalid-candidate'] }; }
}
export function exitSignal(position, candles = [], { now = candles.at(-1)?.closeTime } = {}) {
  if (position.exitValueWei == null) return { action: 'hold', reason: 'unknown-exit-value' };
  const basis = uint(position.costBasisWei), value = uint(position.exitValueWei), peak = uint(position.peakExitValueWei ?? position.costBasisWei);
  if (value * 10000n <= basis * 9200n) return { action: 'sell', reason: 'stop-loss' };
  if (peak * 10000n >= basis * 11200n && value * 10000n <= peak * 9200n) return { action: 'sell', reason: 'trailing-stop' };
  try {
    const closed = closedCandles(candles, now, 21), fast = emaSeries(closed, 5), slow = emaSeries(closed, 20);
    if (fast.at(-2) >= slow.at(-2) && fast.at(-1) < slow.at(-1)) return { action: 'sell', reason: 'ema-crossover' };
  } catch { return { action: 'hold', reason: 'unusable-exit-candles' }; }
  return { action: 'hold', reason: 'no-exit-trigger' };
}
