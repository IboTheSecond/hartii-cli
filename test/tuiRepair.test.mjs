import { it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { createDataSource, saveWatchlist, loadWatchlist } from '../src/tui/data.js';
import { TuiApp, flatten } from '../src/tui/app.js';
import { renderFrame, MENU } from '../src/tui/render.js';
import { demoState } from '../src/tui/demoData.js';
import { runTui } from '../src/tui/run.js';
import { saveConfig } from '../src/config.js';

const TOKEN = '0x0011111111111111111111111111111111111111';
const NOW = Date.UTC(2026, 9, 11, 12);
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
let home, active, sockets;
class Socket {
  constructor(url) { this.url = url; this.handlers = {}; sockets.push(this); }
  addEventListener(name, fn) { this.handlers[name] = fn; }
  send() {}
  close() { this.handlers.close?.(); }
  message(value) { this.handlers.message?.({ data: JSON.stringify(value) }); }
}
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'hartii-tui-repairs-')); active = []; sockets = [];
  saveConfig(home, { network: 'mainnet', currentWallet: null, limits: { perTxQuai: '100', dailyQuai: '500' } });
});
afterEach(() => { for (const source of active) source.stop(); });
function create(over = {}) {
  const source = createDataSource({ home, now: () => NOW, WebSocketImpl: Socket,
    fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ token: { address: TOKEN, symbol: 'DEMO', lastPriceWei: '123' }, holdings: [] }) }),
    providerFactory: () => ({ getBlockNumber: async () => 100, getBalance: async () => 1n, destroy() {} }), ...over });
  active.push(source);
  const app = new TuiApp({ data: source.initial, size: { cols: 80, rows: 24 }, deps: source.deps });
  source.start(app); return { source, app };
}
it('removes the persisted ticker identity and does not restore it from a late refresh', async () => {
  saveWatchlist(home, ['DEMO']); const { app } = create(); await tick(); await tick();
  expect(app.data.watch[0].address).toBe(TOKEN);
  await app.removeWatch();
  expect(loadWatchlist(home)).toEqual([]); expect(app.data.watch).toEqual([]);
});
it('does not connect a mainnet market socket while on Orchard', () => {
  const { app } = create({ network: 'orchard' });
  expect(sockets).toHaveLength(0); expect(app.data.trades).toEqual([]);
});
it('network switch invalidates old socket callbacks, trades and pending watch reads', async () => {
  const { source, app } = create(); const old = sockets[0]; old.handlers.open();
  old.message({ v: 1, type: 'trade', channel: 'global', ts: NOW, data: { symbol: 'MAINNET', side: 'buy', blockNumber: 99, quaiAmount: '1', tokenAmount: '1' } });
  expect(app.data.trades).toHaveLength(1);
  await source.deps.saveSettings({ network: 'orchard', perTxQuai: '100', dailyQuai: '500' });
  old.message({ v: 1, type: 'trade', channel: 'global', ts: NOW, data: { symbol: 'OBSOLETE', side: 'buy', blockNumber: 100, quaiAmount: '1', tokenAmount: '1' } });
  expect(app.data.network).toBe('orchard'); expect(app.data.trades).toEqual([]); expect(app.data.block.height).toBeNull();
  expect(sockets).toHaveLength(1);
});
it('late watch responses cannot replace a newer refresh', async () => {
  saveWatchlist(home, ['DEMO']); let release; let calls = 0;
  const { source, app } = create({ fetchFn: async () => {
    calls++; if (calls === 1) return new Promise(resolve => { release = () => resolve({ ok: true, status: 200, json: async () => ({ token: { address: TOKEN, symbol: 'OLD', lastPriceWei: '1' } }) }); });
    return { ok: true, status: 200, json: async () => ({ token: { address: TOKEN, symbol: 'NEW', lastPriceWei: '2' } }) };
  } });
  source.deps.refresh(); await tick(); await tick(); expect(app.data.watch[0].symbol).toBe('NEW');
  release(); await tick(); await tick(); expect(app.data.watch[0].symbol).toBe('NEW');
});
it('watch shortcuts use the resolved token address rather than an ambiguous ticker', () => {
  const state = demoState(NOW); state.watch = [{ symbol: 'DEMO', address: TOKEN }];
  const app = new TuiApp({ data: state, size: { cols: 80, rows: 24 } }); app.ui.focus = 'watch'; app.key({ name: 'return' });
  expect(app.ui.overlay.values.token).toBe(TOKEN);
});
it('keeps every result array entry reachable', () => {
  const rows = flatten({ offers: Array.from({ length: 12 }, (_, id) => ({ id })) });
  expect(rows.join('\n')).toContain('id: 11');
});
it('keeps selected watch and wallet rows visible after keyboard movement', () => {
  const state = demoState(NOW); state.watch = Array.from({ length: 30 }, (_, i) => ({ symbol: 'TOK' + i, address: TOKEN }));
  const app = new TuiApp({ data: state, size: { cols: 80, rows: 24 }, deps: { listWallets: () => Array.from({ length: 30 }, (_, i) => ({ name: 'wallet' + i, address: TOKEN, current: i === 20 })) } });
  app.ui.focus = 'watch'; for (let i = 0; i < 20; i++) app.key({ name: 'down' });
  expect(app.frame().toPlain()).toContain('TOK20');
  app.openWallets(); expect(app.frame().toPlain()).toContain('wallet20');
});
it('keeps an active late form field visible at the accepted compact size', () => {
  const app = new TuiApp({ data: demoState(NOW), size: { cols: 60, rows: 18 } });
  app.openAction('OTC'); app.key({ name: 'right' }); app.ui.overlay.index = 5;
  expect(app.frame().toPlain()).toContain('Expiry');
});
it('downgrades a connected but silent feed instead of claiming LIVE', () => {
  const state = { ...demoState(NOW), mode: 'live', now: NOW, live: { state: 'connected', receivedAt: NOW - 120000 }, block: { height: 1, at: NOW - 120000, history: [] } };
  const text = renderFrame(state, 80, 24).toPlain();
  expect(text).toMatch(/stale/i); expect(text).not.toContain('● LIVE');
});
it('restores raw mode and listeners before rejecting a startup write exception', async () => {
  const stdin = Object.assign(new EventEmitter(), { isTTY: true, setRawMode: vi.fn(), resume() {}, pause: vi.fn() });
  let first = true;
  const stdout = Object.assign(new EventEmitter(), { isTTY: true, columns: 80, rows: 24, write() { if (first) { first = false; throw Error('Synthetic stdout failure'); } } });
  const before = new Set(process.listeners('SIGTERM'));
  try {
    await expect(runTui({ stdin, stdout, demo: true, animate: false, env: {} })).rejects.toThrow('Synthetic stdout failure');
    expect(stdin.setRawMode).toHaveBeenLastCalledWith(false); expect(stdin.listenerCount('keypress')).toBe(0); expect(stdin.pause).toHaveBeenCalled();
  } finally { for (const listener of process.listeners('SIGTERM')) if (!before.has(listener)) listener(); }
});
