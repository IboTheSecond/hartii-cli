// packages/hartii-cli/src/tui/demoData.js
//
// `hartii ui --demo` fixture: fake balances / watchlist / trades / blocks, no network, never signs.
// Deterministic for a given `now` so the snapshot tests are stable. Addresses are public, non-secret
// (the demo wallet is a fake placeholder address, same as the other --demo fixtures).
import { DEMO_ADDRESS, DEMO_NETWORK, DEMO_BALANCE_WEI, DEMO_TOKEN_HOLDINGS } from '../demoFixtures.js';

export const DEMO_HEIGHT = 10_412_877;

const SYMS = ['DEMO', 'HRTI', 'CAMEL', 'QUAXE', 'BLOCK'];
const TRADERS = [
  '0x0000000000000000000000000000000000000d11',
  '0x0000000000000000000000000000000000000d12',
  '0x0000000000000000000000000000000000000d13',
];

/** Deterministic pseudo-random in [0,1) from an integer seed. */
function rnd(seed) {
  let x = (seed * 2654435761) >>> 0;
  x ^= x >>> 15; x = Math.imul(x, 2246822519) >>> 0; x ^= x >>> 13;
  return (x >>> 0) / 4294967296;
}

export function demoState(nowMs = Date.UTC(2026, 9, 5, 14, 2, 11)) {
  const history = [];
  for (let i = 31; i >= 0; i -= 1) {
    const h = DEMO_HEIGHT - i;
    const r = rnd(h);
    const count = r < 0.35 ? 0 : r < 0.7 ? 1 : r < 0.9 ? 2 : 4;
    const quai = count ? Math.round(rnd(h + 7) * 90 * count) / 10 : 0;
    const net = count === 0 ? 0 : rnd(h + 3) > 0.45 ? 1 : -1;
    history.push({ height: h, count, quai, net });
  }
  const trades = [];
  let t = nowMs;
  for (let i = 0; i < 36; i += 1) {
    const h = DEMO_HEIGHT - Math.floor(i / 2);
    const buy = rnd(i + 11) > 0.4;
    const quai = (Math.round(rnd(i + 5) * 480) / 10 + 0.5).toFixed(1);
    trades.push({
      ts: t, blockNumber: h, side: buy ? 'buy' : 'sell', symbol: SYMS[Math.floor(rnd(i + 2) * SYMS.length)],
      quai, token: String(Math.round(Number(quai) * (3000 + rnd(i) * 9000))), trader: TRADERS[i % TRADERS.length], hash: `0xdemo${i}`,
    });
    t -= 1500 + Math.floor(rnd(i + 21) * 3500);
  }
  return {
    mode: 'demo',
    network: DEMO_NETWORK,
    wallet: { name: 'demo', address: DEMO_ADDRESS },
    quaiWei: DEMO_BALANCE_WEI.toString(),
    holdings: DEMO_TOKEN_HOLDINGS.map((h) => ({ ...h, valueQuai: (BigInt(Math.round(Number(h.valueQuai) * 100)) * 10n ** 16n).toString() })),
    watch: [
      { symbol: 'DEMO', address: DEMO_TOKEN_HOLDINGS[0].tokenAddress, priceWei: '18600000000000', change24h: 12.4 },
      { symbol: 'HRTI', address: DEMO_TOKEN_HOLDINGS[1].tokenAddress, priceWei: '91000000000000', change24h: -3.2 },
      { symbol: 'CAMEL', address: '0x0000000000000000000000000000000000000d05', priceWei: '4300000000', change24h: 41.8 },
    ],
    trades,
    block: { height: DEMO_HEIGHT, at: nowMs - 1800, history },
    live: { state: 'demo', refreshedAt: nowMs },
    now: nowMs,
  };
}
