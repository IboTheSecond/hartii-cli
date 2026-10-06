// packages/hartii-cli/src/tui/data.js
//
// Data layer behind the TUI: wires a TuiApp to the real world (or to the --demo fixture).
//  - runCommand(fn, opts, extra): the SAME run* functions the CLI dispatches to (so a TUI write goes
//    through the shared write pipeline: simulate -> summary -> confirm -> send -> receipt, spending guard);
//  - balances + watchlist: portfolio / token APIs, refreshed every 30 s and after every write;
//  - the live feed: wss://hartiilabs.com/api/live/ws global channel ('head' frames drive the block height
//    and ribbon, 'trade' frames fill the per-block feed), reconnecting with the protocol's own backoff,
//    with an RPC block-number poll as the fallback when the socket is silent.
// Nothing here ever prints a key; the password prompt goes through the TUI's masked overlay.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { formatUnits } from 'quais';
import { getHartiiHome, loadConfig, saveConfig, configSet } from '../config.js';
import { resolveRuntimeNetwork } from '../network.js';
import { createProvider } from '../signer.js';
import { runBalance } from '../commands/balance.js';
import { runSend } from '../commands/send.js';
import {runReceive} from '../commands/receive.js';
import { runBuy } from '../commands/buy.js';
import { runSell } from '../commands/sell.js';
import { runSwap } from '../commands/swap.js';
import { runAirdrop } from '../commands/airdrop.js';
import { runOtc } from '../commands/otc.js';
import { runClaim } from '../commands/claim.js';
import { runWall } from '../commands/wall.js';
import { walletList, walletUse } from '../commands/walletCmd.js';
import { fetchToken } from '../marketApi.js';
import { getWebSocketImpl } from '../commands/watch.js';
import { decodeMessage, encodeMessage, GLOBAL_CHANNEL, nextBackoffMs } from '../../vendor/src/utils/liveProtocol.js';
import { demoState } from './demoData.js';

const RUNNERS = { receive:runReceive, send: runSend, buy: runBuy, sell: runSell, swap: runSwap, airdrop: runAirdrop, otc: runOtc, claim: runClaim, wall: runWall };
const HISTORY = 32;
const MAX_TRADES = 200;
const REFRESH_MS = 30_000;
const POLL_MS = 6_000;

export const watchlistPath = (home) => join(home, 'watchlist.json');

export function loadWatchlist(home) {
  try {
    const j = JSON.parse(readFileSync(watchlistPath(home), 'utf8'));
    return Array.isArray(j.tokens) ? j.tokens.filter((t) => typeof t === 'string').slice(0, 30) : [];
  } catch { return []; }
}

export function saveWatchlist(home, tokens) {
  if (!existsSync(home)) mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(watchlistPath(home), JSON.stringify({ tokens }, null, 2) + '\n', { mode: 0o600 });
}

/** Folds a head / trade frame into the block history (kept contiguous, newest last). */
export function foldBlock(block, height, trade) {
  const history = block?.history ? [...block.history] : [];
  const last = history.at(-1)?.height;
  let h = height ?? last;
  if (h == null) return block;
  if (last != null && h > last) {
    // Only the last HISTORY blocks can ever be shown: never loop (or shift) over a huge gap a bad
    // or hostile feed frame could report (e.g. blockNumber 1e9), which would freeze the TUI.
    for (let x = Math.max(last + 1, h - HISTORY + 1); x <= h; x += 1) history.push({ height: x, count: 0, quai: 0, net: 0 });
  } else if (last == null) history.push({ height: h, count: 0, quai: 0, net: 0 });
  while (history.length > HISTORY) history.shift();
  if (trade) {
    const cell = history.find((c) => c.height === (trade.blockNumber ?? h)) || history.at(-1);
    const q = Number(trade.quai);
    cell.count += 1;
    cell.quai += Number.isFinite(q) ? q : 0;
    cell.net += trade.side === 'buy' ? 1 : trade.side === 'sell' ? -1 : 0;
    cell.net = Math.sign(cell.net);
  }
  const newHeight = Math.max(h, block?.height ?? 0);
  return { height: newHeight, at: height != null && newHeight !== block?.height ? Date.now() : (block?.at ?? Date.now()), history };
}

const wei = (v) => { try { return formatUnits(BigInt(v), 18); } catch { return null; } };

export function tradeFromFrame(msg) {
  const d = msg.data || {};
  return {
    ts: Number(msg.ts) || Date.now(), blockNumber: d.blockNumber ?? null, side: d.side || 'buy', symbol: d.symbol || null,
    quai: d.quaiAmount != null ? wei(d.quaiAmount) : null, token: d.tokenAmount != null ? wei(d.tokenAmount) : null,
    trader: d.trader || '', hash: d.txHash || '',
  };
}

/**
 * @param {{ env?: object, home?: string, network?: string|null, rpc?: string|null, wallet?: string|null, demo?: boolean, fetchFn?: Function, providerFactory?: Function, WebSocketImpl?: any, walletFactory?: Function, now?: ()=>number }} o
 * @returns {{ initial: object, deps: object, start(app): void, stop(): void }}
 */
export function createDataSource(o = {}) {
  const env = o.env || process.env;
  const home = o.home || getHartiiHome(env);
  const fetchFn = o.fetchFn;
  const providerFactory = o.providerFactory || createProvider;

  if (o.demo) {
    const initial = demoState(o.now ? o.now() : Date.now());
    const baseDemo = { demo: true };
    const deps = {
      runCommand: async (fn, opts) => RUNNERS[fn]({ ...baseDemo, ...opts }, {}),
      listWallets: () => [{ name: 'demo', address: initial.wallet.address, current: true }],
      useWallet: () => {},
      loadSettings: () => ({ network: 'mainnet', perTxQuai: '100', dailyQuai: '500' }),
      saveSettings: async () => {},
      addWatch: async () => {},
      removeWatch: async () => {},
      refresh: () => {},
      now: o.now,
    };
    // Light animation so a reviewer can watch the ribbon pulse: a new block every ~5 s, 0-3 fixture trades in it.
    let timer = null;
    return {
      initial, deps,
      start(app) {
        if (o.animate === false) return;
        timer = setInterval(() => {
          const height = (app.data.block.height || 0) + 1;
          let block = foldBlock(app.data.block, height);
          let trades = app.data.trades;
          const n = Math.floor(Math.random() * 4);
          for (let i = 0; i < n; i += 1) {
            const syms = ['DEMO', 'HRTI', 'CAMEL'];
            const t = { ts: Date.now(), blockNumber: height, side: Math.random() > 0.45 ? 'buy' : 'sell', symbol: syms[Math.floor(Math.random() * 3)], quai: (Math.random() * 60 + 0.5).toFixed(1), token: String(Math.round(Math.random() * 90000)), trader: initial.trades[i % initial.trades.length].trader, hash: '0xdemo' };
            block = foldBlock(block, undefined, t);
            trades = [t, ...trades].slice(0, MAX_TRADES);
          }
          app.setData({ block: { ...block, at: Date.now() }, trades });
        }, 5000);
      },
      stop() { clearInterval(timer); },
    };
  }

  const net = () => resolveRuntimeNetwork({ network: o.network || loadConfig(home).network, rpc: o.rpc });
  let current = null; // wallet { name, address } or null
  const resolveWallet = () => {
    try {
      const list = walletList(home);
      const pick = (o.wallet && list.find((w) => w.name === o.wallet)) || list.find((w) => w.current) || list[0] || null;
      current = pick && pick.address ? { name: pick.name, address: pick.address } : null;
    } catch { current = null; }
    return current;
  };
  resolveWallet();
  const n0 = net();
  const initial = {
    mode: 'live', network: n0.name, wallet: current, quaiWei: null, holdings: [], watch: loadWatchlist(home).map((ref) => ({ symbol: ref.length > 12 ? `${ref.slice(0, 6)}…` : ref, address: ref, priceWei: null, change24h: null })),
    trades: [], block: { height: null, at: 0, history: [] }, live: { state: 'connecting', refreshedAt: 0 },
  };

  let app = null;
  let ws = null;
  let attempt = 0;
  let timers = [];
  let stopped = false;
  let lastHead = 0;

  const baseOpts = () => ({ home, network: o.network || undefined, rpc: o.rpc || undefined, wallet: o.wallet || undefined });
  const deps = {
    now: o.now,
    runCommand: async (fn, opts, extra = {}) => {
      const run = RUNNERS[fn];
      if (!run) throw new Error(`Unknown action "${fn}".`);
      return run({ ...baseOpts(), ...opts, json: false, yes: false, dryRun: false }, { fetchFn, providerFactory, walletFactory: o.walletFactory, io: { ...extra.io, env }, passwordDeps: extra.passwordDeps });
    },
    listWallets: () => { try { return walletList(home); } catch { return []; } },
    useWallet: (name) => { walletUse(home, name); resolveWallet(); app?.setData({ wallet: current }); },
    loadSettings: () => { const c = loadConfig(home); return { network: c.network, perTxQuai: c.limits.perTxQuai, dailyQuai: c.limits.dailyQuai }; },
    saveSettings: async (v) => {
      let c = loadConfig(home);
      c = configSet(c, 'network', v.network);
      c = configSet(c, 'limits.perTxQuai', v.perTxQuai);
      c = configSet(c, 'limits.dailyQuai', v.dailyQuai);
      saveConfig(home, c);
      app?.setData({ network: c.network });
    },
    addWatch: async (ref) => {
      const list = loadWatchlist(home);
      if (list.some((t) => t.toLowerCase() === ref.toLowerCase())) return;
      await fetchToken(ref, { network: net().name, fetchFn }); // refuses unknown tokens up front
      saveWatchlist(home, [...list, ref]);
      await refreshWatch();
    },
    removeWatch: async (ref) => {
      const list = loadWatchlist(home).filter((t) => t.toLowerCase() !== String(ref).toLowerCase());
      saveWatchlist(home, list);
      await refreshWatch();
    },
    refresh: () => { refreshBalances(); refreshWatch(); },
  };

  async function refreshBalances() {
    if (!resolveWallet()) { app?.setData({ wallet: null, quaiWei: null, holdings: [] }); return; }
    try {
      const r = await runBalance({ ...baseOpts(), tokens: true }, { fetchFn, providerFactory });
      app?.setData({ wallet: current, network: r.network, quaiWei: r.quaiWei, holdings: Array.isArray(r.holdings) ? r.holdings : [], holdingsError: r.holdingsError || null, live: { ...(app?.data.live || {}), refreshedAt: Date.now() } });
    } catch (e) {
      app?.status(`Balance refresh failed: ${String(e.message || e).slice(0, 80)}`, 'error');
    }
  }

  async function refreshWatch() {
    const refs = loadWatchlist(home);
    const out = [];
    for (const ref of refs) {
      try {
        const { token } = await fetchToken(ref, { network: net().name, fetchFn });
        out.push({ symbol: token.symbol || ref, address: token.address, priceWei: token.lastPriceWei ?? null, change24h: token.change24h ?? null });
      } catch {
        out.push({ symbol: ref.length > 12 ? `${ref.slice(0, 6)}…` : ref, address: ref, priceWei: null, change24h: null });
      }
    }
    app?.setData({ watch: out });
  }

  function onFrame(msg) {
    if (msg.type === 'head') {
      const h = msg.data?.blockNumber;
      if (Number.isFinite(h)) { lastHead = Date.now(); app.setData({ block: foldBlock(app.data.block, h) }); }
    } else if (msg.type === 'trade' || msg.type === 'burn') {
      const t = tradeFromFrame(msg);
      const trades = [t, ...(app.data.trades || [])].slice(0, MAX_TRADES);
      const patch = { trades };
      if (msg.type === 'trade') patch.block = foldBlock(app.data.block, t.blockNumber && t.blockNumber > (app.data.block?.height || 0) ? t.blockNumber : undefined, t);
      app.setData(patch);
    }
  }

  function connect() {
    if (stopped) return;
    let WS;
    try { WS = o.WebSocketImpl || getWebSocketImpl(); } catch { app?.setData({ live: { ...app.data.live, state: 'polling' } }); return; }
    try {
      ws = new WS('wss://hartiilabs.com/api/live/ws?channel=global', { headers: { Origin: 'https://hartiilabs.com' } });
    } catch { schedule(); return; }
    ws.addEventListener('open', () => { attempt = 0; ws.send(encodeMessage({ type: 'subscribe', channel: GLOBAL_CHANNEL })); app?.setData({ live: { ...app.data.live, state: 'connected' } }); });
    ws.addEventListener('message', (ev) => { const m = decodeMessage(ev.data); if (m) onFrame(m); });
    ws.addEventListener('error', () => {});
    ws.addEventListener('close', () => { app?.setData({ live: { ...app.data.live, state: 'polling' } }); schedule(); });
  }
  function schedule() {
    if (stopped) return;
    attempt += 1;
    timers.push(setTimeout(connect, nextBackoffMs(attempt)));
  }
  async function poll() {
    if (stopped || Date.now() - lastHead < POLL_MS * 2) return;
    try {
      const provider = providerFactory(net().rpcUrl);
      const h = Number(await provider.getBlockNumber());
      provider.destroy?.();
      if (Number.isFinite(h) && h > 0) app.setData({ block: foldBlock(app.data.block, h) });
    } catch { /* feed stays as is */ }
  }

  return {
    initial,
    deps,
    start(a) {
      app = a;
      refreshBalances();
      refreshWatch();
      connect();
      timers.push(setInterval(poll, POLL_MS));
      timers.push(setInterval(() => { refreshBalances(); refreshWatch(); }, REFRESH_MS));
    },
    stop() {
      stopped = true;
      for (const t of timers) { clearTimeout(t); clearInterval(t); }
      timers = [];
      try { ws?.close(); } catch { /* already closed */ }
    },
  };
}
