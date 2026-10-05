// packages/hartii-cli/src/demoFixtures.js
//
// `--demo` (the product spec : "needed for review without a wallet") — a bundled, static fixture:
// no network, no keystore, never signs. Every command that supports --demo must branch on it
// BEFORE touching the network/keystore, not catch a failure afterward — these values exist so the
// CLI and the TUI can be screenshotted/reviewed with zero setup.
export const DEMO_ADDRESS = '0x0000000000000000000000000000000000000d01'; // same shape as a real Cyprus-1 address (QuaiWallV2's own, public on quaiscan — not a secret)
export const DEMO_NETWORK = 'mainnet';

export const DEMO_BALANCE_WEI = 1234_560000000000000000n; // 1234.56 QUAI

export const DEMO_TOKEN_HOLDINGS = [
  { tokenAddress: '0x0000000000000000000000000000000000000d03', symbol: 'DEMO', balance: '50000000000000000000000', priceQuai: '0.0021', valueQuai: '105', priceSource: 'demo' },
  { tokenAddress: '0x0000000000000000000000000000000000000d02', symbol: 'HRTI', balance: '12000000000000000000000', priceQuai: '0.008', valueQuai: '96', priceSource: 'demo' },
];

// --- market/trading fixtures -------------------------------------------------------------
export const DEMO_CURVE_ADDRESS = '0x0000000000000000000000000000000000000d04'; // BondingCurveV4 impl address — public, not a secret
export const DEMO_TOKEN = {
  address: '0x0000000000000000000000000000000000000d02',
  symbol: 'DEMO',
  name: 'Demo Token',
  curveAddress: DEMO_CURVE_ADDRESS,
  status: 'active',
  holderCount: 42,
  volume24hWei: '1200000000000000000000',
  lastPriceWei: '18600000000000',
  trendingScore: 91,
};

export const DEMO_TOKENS_LIST = [
  DEMO_TOKEN,
  { address: '0x0000000000000000000000000000000000000d03', symbol: 'HRTI', name: 'Hartii', curveAddress: null, status: 'graduated', holderCount: 1337, volume24hWei: '45000000000000000000000', lastPriceWei: '91000000000000', trendingScore: 100 },
];

// Shape curveState.readCurveMeta() returns — enough for curveQuote.localQuote to price a buy/sell
// with no network at all.
export const DEMO_CURVE_META = {
  feeBps: 100n,
  graduated: false,
  tokensRemaining: 700_000_000_000000000000000000n,
  tokensSold: 84_000_000_000000000000000000n,
  isV3: true,
  virtualQuaiReserve: 17_000_000000000000000000n,
  virtualTokenReserve: 1_073_000_000_000000000000000000n,
  realQuaiReserve: 1_300_000000000000000000n,
  poolQuaiReserve: null,
  poolTokenReserve: null,
};

export const DEMO_TRADE_FRAMES = [
  { channel: 'global', type: 'trade', seq: 1, ts: Date.now(), data: { tokenAddress: DEMO_TOKEN.address, symbol: 'DEMO', side: 'buy', quaiAmount: '5000000000000000000', tokenAmount: '268000000000000000000000', trader: '0x0000000000000000000000000000000000000d12', txHash: '0xdemo1', confirmed: false } },
  { channel: 'global', type: 'trade', seq: 2, ts: Date.now() + 1000, data: { tokenAddress: DEMO_TOKEN.address, symbol: 'DEMO', side: 'sell', quaiAmount: '1200000000000000000', tokenAmount: '64000000000000000000000', trader: '0x0000000000000000000000000000000000000d11', txHash: '0xdemo2', confirmed: false } },
];

export function demoDoctorChecks() {
  return [
    { name: 'rpc', ok: true, detail: 'demo mode — no real RPC contacted' },
    { name: 'chainId', ok: true, detail: 'demo mode — assumed correct' },
    { name: 'keystorePerms', ok: true, detail: 'demo mode — no real keystore read' },
    { name: 'addressLedger', ok: true, detail: `demo wallet ${DEMO_ADDRESS} (Cyprus-1 Quai)` },
    { name: 'api', ok: true, detail: 'demo mode — no real API contacted' },
    { name: 'clockSkew', ok: true, detail: 'demo mode — not checked' },
  ];
}
