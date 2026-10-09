export const NOW = Date.UTC(2026, 9, 9, 12);
export const OWNER = '0x0011111111111111111111111111111111111111';
export const WALLET = '0x0022222222222222222222222222222222222222';
export const TOKEN = '0x0033333333333333333333333333333333333333';
export const HASH = `0x${'ab'.repeat(32)}`;
export function policy(overrides = {}) {
  return { schemaVersion: 1, owner: OWNER, tradingWallet: WALLET, runnerId: 'fixture-runner', chainId: 9,
    nonce: '0', issuedAt: NOW - 1000, expiresAt: NOW + 3600000,
    capitalWei: '100000', maxPerTxWei: '10000', maxPerDayWei: '30000', maxFeeWei: '100',
    maxEntryBps: 1000, maxExposureBps: 3000, maxDailyLossBps: 500, maxPositions: 3,
    slippageBps: 50, maxSlippageBps: 100, maxImpactBps: 100, maxRoundTripCostBps: 500,
    modelCycleMicrousd: '100000', modelDailyMicrousd: '1000000',
    allowedVenues: ['curve-v1', 'curve-v2', 'curve-v3', 'curve-v4', 'hartii-swap'], allowedActions: ['buy', 'sell'], ...overrides };
}
export function candles(now = NOW) {
  return Array.from({ length: 35 }, (_, i) => ({ openTime: now - (35 - i) * 60000,
    closeTime: now - (34 - i) * 60000, closeWei: String(100000 + i * 1000), volumeWei: i < 30 ? '100' : '300' }));
}
export function candidate(overrides = {}) {
  return { id: 'fixture-token', token: TOKEN, symbol: 'TEST', chainId: 9, venue: 'curve-v4', verified: true,
    direct: true, snipeEndsAt: NOW - 3600000, candles: candles(),
    entryQuote: { at: NOW, impactBps: 25, roundTripCostBps: 200 },
    exitQuote: { at: NOW, impactBps: 25, roundTripCostBps: 200 }, ...overrides };
}
export function modelFeatures(overrides = {}) {
  return { closedAt: NOW, historyMinutes: 35, lastCloseWei: '134000', fastEmaScaled: '132000000000000000000000',
    slowEmaScaled: '125000000000000000000000', emaSpreadBps: '560', slowEmaRiseBps: '80',
    latest5mVolumeWei: '1500', volumeRatioBps: '30000', entryImpactBps: 25, exitImpactBps: 25,
    roundTripCostBps: 200, entryQuoteAgeMs: 0, exitQuoteAgeMs: 0, portfolioExposureBps: '0', ...overrides };
}
