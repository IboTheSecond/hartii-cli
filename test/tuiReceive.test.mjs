import { describe, it, expect, vi } from 'vitest';
import { TuiApp } from '../src/tui/app.js';
import * as rendering from '../src/tui/render.js';
import { demoState } from '../src/tui/demoData.js';
import { createReceiveQr } from '../src/qr.js';
import { buildReceiveLink } from '../src/paylinks.js';

const NOW = Date.UTC(2026, 9, 10, 0, 0);
const ADDRESS = '0x0011111111111111111111111111111111111111';
const OTHER = '0x0022222222222222222222222222222222222222';
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function setup({ copy = async () => ({ ok: true }), result = {}, demo = false, wallet = { name: 'selected', address: ADDRESS }, size = { cols: 80, rows: 24 } } = {}) {
  const data = { ...demoState(NOW), wallet, network: 'mainnet' };
  const receive = {
    readOnly: true, demo: false, wallet: 'selected', address: ADDRESS,
    network: 'mainnet', chainId: 9, qr: createReceiveQr(ADDRESS),
    paylink: buildReceiveLink({ address: ADDRESS }), ...result,
  };
  const deps = {
    now: () => NOW,
    runCommand: vi.fn(async () => receive),
    copyText: vi.fn(copy),
    refresh: vi.fn(),
  };
  return { app: new TuiApp({ data, size, deps, demo }), deps, receive };
}

describe('one-action wallet receiving', () => {
  it('is reachable from the visible action menu', () => {
    expect(rendering.MENU).toContain('Receive');
  });
  it('shows the QR while the automatic address copy is still pending', async () => {
    const pending = deferred();
    const { app, deps } = setup({ copy: () => pending.promise });
    await app.openAction('Receive');
    expect(app.ui.overlay?.type).toBe('receive');
    expect(app.ui.overlay?.status).toBe('ready');
    expect(app.ui.overlay?.details.qr.payload).toBe(ADDRESS);
    expect(deps.runCommand).toHaveBeenCalledWith('receive', { wallet: 'selected', network: 'mainnet', addressQr: true }, expect.any(Object));
    expect(deps.copyText).toHaveBeenCalledWith(ADDRESS, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(app.frame().toPlain()).not.toContain('Address copied to clipboard');
    pending.resolve({ ok: true }); await tick();
    expect(app.frame().toPlain()).toContain('Address copied to clipboard');
  });
  it('reports blocked clipboard access honestly and supports retry', async () => {
    const { app, deps } = setup({ copy: vi.fn().mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce({ ok: true }) });
    await app.openAction('Receive'); await tick();
    expect(app.frame().toPlain()).toContain('Could not copy address');
    expect(app.frame().toPlain()).not.toContain('Address copied to clipboard');
    app.key({ str: 'a' }); await tick();
    expect(deps.copyText).toHaveBeenCalledTimes(2);
    expect(app.frame().toPlain()).toContain('Address copied to clipboard');
  });
  it('copies the exact HartiiBiome paylink with a separate action', async () => {
    const { app, deps, receive } = setup();
    await app.openAction('Receive'); await tick();
    app.key({ str: 'l' }); await tick();
    expect(deps.copyText.mock.calls.map(c => c[0])).toEqual([ADDRESS, receive.paylink]);
    const link = new URL(receive.paylink);
    expect(link.origin).toBe('https://hartiibiome.com');
    expect(link.searchParams.get('to')).toBe(ADDRESS);
    expect(app.frame().toPlain()).toContain('Paylink copied to clipboard');
  });
  it('does not unlock or dispatch any command when no wallet is selected', async () => {
    const { app, deps } = setup({ wallet: null });
    await app.openAction('Receive');
    expect(app.frame().toPlain()).toContain('No wallet selected');
    expect(deps.runCommand).not.toHaveBeenCalled();
    expect(deps.copyText).not.toHaveBeenCalled();
  });
  it('refuses a command result for a different wallet address', async () => {
    const { app, deps } = setup({ result: { address: OTHER, qr: createReceiveQr(OTHER) } });
    await app.openAction('Receive');
    expect(app.frame().toPlain()).toContain('Wallet changed');
    expect(deps.copyText).not.toHaveBeenCalled();
  });
  it('does not pretend demo receiving is a real address to fund', async () => {
    const { app, deps } = setup({ demo: true, result: { demo: true } });
    await app.openAction('Receive'); await tick();
    expect(app.frame().toPlain()).toContain('DEMO');
    expect(app.frame().toPlain()).toContain('Do not send funds');
    expect(deps.copyText).not.toHaveBeenCalled();
  });
  it('aborts a pending clipboard operation when the receive pane closes', async () => {
    const pending = deferred(); const { app, deps } = setup({ copy: () => pending.promise });
    await app.openAction('Receive');
    const signal = deps.copyText.mock.calls[0]?.[1]?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    app.key({ name: 'escape' });
    expect(signal.aborted).toBe(true);
    pending.resolve({ ok: true }); await tick();
    expect(app.ui.overlay).toBeNull();
    expect(app.ui.status?.text || '').not.toContain('copied');
  });
  it('drops receive details if the selected wallet changes during copying', async () => {
    const pending = deferred(); const { app, deps } = setup({ copy: () => pending.promise });
    await app.openAction('Receive');
    const signal = deps.copyText.mock.calls[0]?.[1]?.signal;
    app.setData({ wallet: { name: 'other', address: OTHER } });
    expect(app.ui.overlay).toBeNull();
    expect(signal?.aborted).toBe(true);
    pending.resolve({ ok: true }); await tick();
    expect(app.ui.overlay).toBeNull();
  });
  it('cancels a pending address copy when Ctrl-C quits the application', async () => {
    const pending = deferred(); const { app, deps } = setup({ copy: () => pending.promise });
    await app.openAction('Receive');
    const signal = deps.copyText.mock.calls[0][1].signal;
    app.key({ ctrl: true, name: 'c' });
    expect(signal.aborted).toBe(true);
    expect(app.ui.overlay).toBeNull();
    pending.resolve({ ok: true }); await tick();
    expect(app.ui.overlay).toBeNull();
  });
  it('keeps Orchard receiving address-only rather than making a mainnet link', async () => {
    const { app, deps } = setup({ result: { network: 'orchard', chainId: 15000, paylink: null } });
    app.data.network = 'orchard';
    await app.openAction('Receive'); await tick();
    app.key({ str: 'l' }); await tick();
    expect(deps.copyText).toHaveBeenCalledTimes(1);
    expect(app.frame().toPlain()).toContain('Paylinks require mainnet');
  });
});

describe('QR geometry and all-action reachability', () => {
  it.each(['truecolor', '256', 'none'])('serializes the actual Receive frame at %s depth', async depth => {
    const { app } = setup(); await app.openAction('Receive'); await tick();
    let rows;
    expect(() => { rows = app.frame().toAnsiRows(depth); }).not.toThrow();
    expect(rows.join('\n')).not.toContain('NaN');
    if (depth === 'truecolor') expect(rows.join('\n')).toContain('38;2;0;0;0');
  });
  it.each([[80, 24], [120, 40], [60, 24]])('draws every QR cell and quiet-zone column at %sx%s', async (cols, rows) => {
    const { app, receive } = setup({ size: { cols, rows } });
    await app.openAction('Receive'); await tick();
    // A missing renderer is a behavior failure, not an import exception.
    const layout = rendering.receiveLayout?.(app.ui.overlay, cols, rows) || { qrFits: false };
    expect(layout.qrFits).toBe(true);
    const screen = app.frame(); const matrix = receive.qr.matrix; const quiet = 4;
    const dark = (r, c) => r >= 0 && c >= 0 && r < matrix.length && c < matrix.length && matrix[r][c];
    for (let r = -quiet, y = 0; r < matrix.length + quiet; r += 2, y++) {
      for (let c = -quiet, x = 0; c < matrix.length + quiet; c++, x++) {
        const top = dark(r, c), bottom = dark(r + 1, c);
        const ch = top ? (bottom ? '\u2588' : '\u2580') : (bottom ? '\u2584' : ' ');
        const cell = screen.cells[layout.qr.y + y][layout.qr.x + x];
        expect(cell.ch).toBe(ch);
        expect(cell.st).toMatchObject({ fg: [0, 0, 0], bg: [255, 255, 255] });
      }
    }
  });
  it('never crops a QR into an unscannable partial image in a short terminal', async () => {
    const { app } = setup({ size: { cols: 60, rows: 18 } });
    await app.openAction('Receive'); await tick();
    expect(app.frame().toPlain()).toContain('Resize');
    expect(app.frame().cells.flat().some(c => JSON.stringify(c.st?.bg) === '[255,255,255]')).toBe(false);
  });
  it.each([60, 80, 120])('shows the selected action instead of an invisible button at %s columns', cols => {
    for (let i = 0; i < rendering.MENU.length; i++) {
      const data = { ...demoState(NOW), ui: { focus: 'actions', menu: i }, now: NOW };
      expect(rendering.renderFrame(data, cols, 24).toPlain().split('\n')[22]).toContain(rendering.MENU[i]);
    }
  });
});
