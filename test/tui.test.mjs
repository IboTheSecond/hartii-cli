/* eslint-disable no-control-regex -- asserting that terminal control characters are stripped */
import { describe, it, expect, vi } from 'vitest';
import { renderFrame, MENU } from '../src/tui/render.js';
import { demoState } from '../src/tui/demoData.js';
import { TuiApp } from '../src/tui/app.js';
import { Screen } from '../src/tui/screen.js';
import { drawLed, ledWidth } from '../src/tui/mark.js';
import { validateAll, commandFor, fieldsFor, v } from '../src/tui/forms.js';
import { foldBlock, tradeFromFrame, createDataSource } from '../src/tui/data.js';
import { group, fmtPrice, fmtPct, shortAddr } from '../src/tui/format.js';
import { colorDepth } from '../src/tui/theme.js';
import { runTui } from '../src/tui/run.js';
import { main } from '../src/cli.js';

const NOW = Date.UTC(2026, 9, 5, 14, 2, 11);
const data = () => demoState(NOW);
const frame = (cols, rows, ui) => renderFrame({ ...data(), ui, now: NOW }, cols, rows);

describe('frame snapshots (demo fixture, ANSI stripped)', () => {
  it('80x24', () => { expect(frame(80, 24).toPlain()).toMatchSnapshot(); });
  it('120x40', () => { expect(frame(120, 40).toPlain()).toMatchSnapshot(); });
  it('help overlay at 80x24', () => { expect(frame(80, 24, { overlay: { type: 'help' } }).toPlain()).toMatchSnapshot(); });
  it('send form with an inline error at 120x40', () => {
    const app = new TuiApp({ data: data(), size: { cols: 120, rows: 40 }, deps: { now: () => NOW } });
    app.openAction('Send');
    app.ui.overlay.fields[0].value = 'not-an-address';
    app.syncValues(app.ui.overlay);
    app.submitForm(app.ui.overlay);
    expect(app.frame().toPlain()).toMatchSnapshot();
  });
});

describe('frame invariants', () => {
  for (const [c, r] of [[80, 24], [120, 40], [100, 30], [60, 18], [200, 60]]) {
    it(`${c}x${r}: exactly rows lines, none wider than cols, no raw escapes`, () => {
      const plain = frame(c, r).toPlain().split('\n');
      expect(plain.length).toBe(r);
      for (const line of plain) { expect(Array.from(line).length).toBeLessThanOrEqual(c); expect(line).not.toMatch(/\u001b/); }
    });
  }
  it('says so when the window is too small', () => {
    expect(frame(50, 15).toPlain()).toMatch(/needs at least 60x18/);
  });
  it('NO_COLOR frames carry no colour codes; truecolor frames do', () => {
    const none = frame(80, 24).toAnsiRows('none').join('');
    expect(none).not.toMatch(/38;|48;/);
    const tc = frame(80, 24).toAnsiRows('truecolor').join('');
    expect(tc).toMatch(/38;2;229;36;59/); // the Hartii red signal exists in the frame
    expect(colorDepth({ NO_COLOR: '1' })).toBe('none');
    expect(colorDepth({ COLORTERM: 'truecolor' })).toBe('truecolor');
  });
  it('untrusted token symbols cannot inject escape sequences', () => {
    const d = data();
    d.trades[0].symbol = '\u001b]52;c;Zm9v\u0007EVIL\u001b[31m';
    d.watch[0].symbol = '\u001b[2JX';
    const out = renderFrame({ ...d, now: NOW }, 120, 40);
    expect(out.toPlain()).not.toMatch(/\u001b/);
    expect(out.toAnsiRows('truecolor').join('')).not.toMatch(/\u001b\]/);
  });
  it('the focused pane and selected action are marked', () => {
    const f = frame(120, 40, { focus: 'trades', menu: 2 });
    expect(f.toPlain()).toContain('▌LIVE TRADES');
    const ansi = f.toAnsiRows('truecolor').join('\n');
    expect(ansi).toMatch(/48;2;229;36;59/); // actions bar is unfocused => no red bg
  });
});

describe('LED numerals', () => {
  it('draws the block height in three rows', () => {
    const s = new Screen(40, 3);
    const w = drawLed(s, 0, 0, '10,412,877', {});
    expect(w).toBe(ledWidth('10,412,877'));
    const rows = s.toPlain().split('\n');
    expect(rows.every((r) => r.trim().length > 0)).toBe(true);
    expect(rows[0]).toMatch(/[▀▄█]/);
  });
});

function fakeDeps(over = {}) {
  const calls = [];
  const deps = {
    now: () => NOW,
    runCommand: vi.fn(async (fn, opts, extra) => {
      calls.push({ fn, opts });
      extra.io.write('Buy DEMO\n  amount: 5');
      const ok = await extra.io.confirmFn('Proceed?');
      if (!ok) return { ok: false, aborted: true };
      const pw = await extra.passwordDeps.promptFn('Password for wallet "demo": ');
      return { ok: true, status: 'success', txHash: '0xabc', quaiscanUrl: 'https://quaiscan.io/tx/0xabc', summary: { action: 'Buy DEMO', amount: '5', pw: pw.length } };
    }),
    listWallets: () => [{ name: 'a', address: '0x0003b264Bc457BF2dc6F4De80c6C714079febB64', current: true }, { name: 'b', address: '0x00249722868732Ee678b88Db668EAf7cC75Ae12A', current: false }],
    useWallet: vi.fn(), refresh: vi.fn(), quit: vi.fn(), addWatch: vi.fn(async () => {}), removeWatch: vi.fn(async () => {}),
    loadSettings: () => ({ network: 'mainnet', perTxQuai: '100', dailyQuai: '500' }), saveSettings: vi.fn(async () => {}),
    ...over,
  };
  return { deps, calls };
}
const press = (app, ...keys) => { for (const k of keys) app.key(typeof k === 'string' ? (k.length === 1 ? { str: k } : { name: k }) : k); };
const type = (app, text) => { for (const ch of text) app.key({ str: ch }); };
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('keyboard navigation', () => {
  it('moves through the actions bar, wraps, switches panes with Tab, quits with q', () => {
    const { deps } = fakeDeps();
    const app = new TuiApp({ data: data(), size: { cols: 120, rows: 40 }, deps });
    press(app, 'right', 'right');
    expect(app.ui.menu).toBe(2);
    press(app, 'left', 'left', 'left');
    expect(app.ui.menu).toBe(MENU.length - 1);
    press(app, { name: 'tab' });
    expect(app.ui.focus).toBe('balances');
    press(app, { name: 'tab' }, { name: 'tab' }, { name: 'tab' });
    expect(app.ui.focus).toBe('actions');
    press(app, { name: 'tab', shift: true });
    expect(app.ui.focus).toBe('trades');
    press(app, 'down', 'down');
    expect(app.ui.tradeScroll).toBe(2);
    press(app, 'up', 'up', 'up');
    expect(app.ui.tradeScroll).toBe(0);
    press(app, '?');
    expect(app.ui.overlay.type).toBe('help');
    press(app, 'escape');
    expect(app.ui.overlay).toBe(null);
    press(app, 'q');
    expect(deps.quit).toHaveBeenCalled();
  });

  it('q does not quit while typing in a form; Ctrl-C always quits', () => {
    const { deps } = fakeDeps();
    const app = new TuiApp({ data: data(), size: { cols: 100, rows: 30 }, deps });
    app.openAction('Wall');
    app.ui.overlay.index = 1;
    type(app, 'qq hello');
    expect(app.ui.overlay.fields[1].value).toBe('qq hello');
    expect(deps.quit).not.toHaveBeenCalled();
    app.key({ ctrl: true, name: 'c' });
    expect(deps.quit).toHaveBeenCalled();
  });

  it('watchlist: select, open Buy prefilled, remove', async () => {
    const { deps } = fakeDeps();
    const app = new TuiApp({ data: data(), size: { cols: 120, rows: 40 }, deps });
    app.ui.focus = 'watch';
    press(app, 'down');
    expect(app.ui.watchSel).toBe(1);
    press(app, 'return');
    expect(app.ui.overlay.type).toBe('form');
    expect(app.ui.overlay.action).toBe('Buy');
    expect(app.ui.overlay.fields[0].value).toBe('HRTI');
    press(app, 'escape');
    app.ui.focus = 'watch';
    press(app, 'd');
    await flush();
    expect(deps.removeWatch).toHaveBeenCalledWith(data().watch[1].address);
  });

  it('watchlist add goes through a prompt', async () => {
    const { deps } = fakeDeps();
    const app = new TuiApp({ data: data(), size: { cols: 120, rows: 40 }, deps });
    app.ui.focus = 'watch';
    press(app, 'a');
    type(app, 'CAMEL');
    press(app, 'return');
    await flush();
    expect(deps.addWatch).toHaveBeenCalledWith('CAMEL');
  });

  it('wallets overlay switches the current wallet', () => {
    const { deps } = fakeDeps();
    const app = new TuiApp({ data: data(), size: { cols: 120, rows: 40 }, deps });
    app.ui.menu = MENU.indexOf('Wallets');
    press(app, 'return');
    expect(app.ui.overlay.type).toBe('list');
    press(app, 'down', 'return');
    expect(deps.useWallet).toHaveBeenCalledWith('b');
  });
});

describe('forms', () => {
  it('validates inline: bad address / amount block submit and show the error in the frame', async () => {
    const { deps } = fakeDeps();
    const app = new TuiApp({ data: data(), size: { cols: 120, rows: 40 }, deps });
    app.ui.menu = MENU.indexOf('Send');
    press(app, 'return');
    type(app, '0x0080000000000000000000000000000000000001'); // Qi ledger
    press(app, 'return');
    type(app, 'abc');
    press(app, 'return', 'return');
    await flush();
    expect(deps.runCommand).not.toHaveBeenCalled();
    const text = app.frame().toPlain();
    expect(text).toMatch(/✕/);
    expect(text).toMatch(/Qi/i);
    expect(text).toMatch(/Use a plain decimal/);
  });

  it('a valid Buy form runs the CLI command, shows the summary, requires y, asks the password masked, shows the receipt', async () => {
    const { deps, calls } = fakeDeps();
    const app = new TuiApp({ data: data(), size: { cols: 120, rows: 40 }, deps });
    app.ui.menu = MENU.indexOf('Buy');
    press(app, 'return');
    type(app, 'DEMO');
    press(app, 'return');
    type(app, '5');
    press(app, 'return'); // slippage keeps 3
    press(app, 'return');
    await flush();
    expect(calls).toEqual([{ fn: 'buy', opts: { token: 'DEMO', quai: '5', slippage: '3' } }]);
    expect(app.ui.overlay.type).toBe('confirm');
    expect(app.frame().toPlain()).toMatch(/Buy DEMO/);
    expect(app.frame().toPlain()).toMatch(/y\s+confirm and sign/);
    press(app, 'y');
    await flush();
    expect(app.ui.overlay.type).toBe('prompt');
    type(app, 'hunter2');
    const masked = app.frame().toPlain();
    expect(masked).not.toMatch(/hunter2/);
    expect(masked).toMatch(/•{7}/);
    press(app, 'return');
    await flush();
    expect(app.ui.overlay.type).toBe('result');
    const done = app.frame().toPlain();
    expect(done).toMatch(/Confirmed on-chain/);
    expect(done).toMatch(/quaiscan\.io\/tx\/0xabc/);
    expect(deps.refresh).toHaveBeenCalled();
  });

  it('n declines: nothing is signed and the result says cancelled', async () => {
    const { deps } = fakeDeps();
    const app = new TuiApp({ data: data(), size: { cols: 120, rows: 40 }, deps });
    app.openAction('Buy', { token: 'DEMO', quai: '1' });
    app.ui.overlay.index = 2;
    press(app, 'return');
    await flush();
    press(app, 'n');
    await flush();
    expect(app.frame().toPlain()).toMatch(/Cancelled — nothing was sent/);
  });

  it('Esc at the password prompt aborts the command with an error result', async () => {
    const { deps } = fakeDeps();
    const app = new TuiApp({ data: data(), size: { cols: 120, rows: 40 }, deps });
    app.openAction('Buy', { token: 'DEMO', quai: '1' });
    app.ui.overlay.index = 2;
    press(app, 'return');
    await flush();
    press(app, 'y');
    await flush();
    press(app, 'escape');
    await flush();
    expect(app.frame().toPlain()).toMatch(/failed/i);
    expect(app.frame().toPlain()).toMatch(/Aborted/);
  });

  it('select fields reshape the form (OTC list -> create)', () => {
    const { deps } = fakeDeps();
    const app = new TuiApp({ data: data(), size: { cols: 120, rows: 40 }, deps });
    app.openAction('OTC');
    expect(app.ui.overlay.fields.map((f) => f.key)).toEqual(['sub']);
    press(app, 'right');
    expect(app.ui.overlay.values.sub).toBe('create');
    expect(app.ui.overlay.fields.map((f) => f.key)).toEqual(['sub', 'token', 'amount', 'quai', 'taker', 'expiry']);
  });

  it('Settings saves the limits through deps', async () => {
    const { deps } = fakeDeps();
    const app = new TuiApp({ data: data(), size: { cols: 120, rows: 40 }, deps });
    app.openAction('Settings');
    app.ui.overlay.index = 1;
    for (let i = 0; i < 3; i += 1) press(app, 'backspace');
    type(app, '50');
    app.syncValues(app.ui.overlay);
    await app.submitForm(app.ui.overlay);
    expect(deps.saveSettings).toHaveBeenCalledWith({ network: 'mainnet', perTxQuai: '50', dailyQuai: '500' });
  });
});

describe('forms.js', () => {
  it('maps every action onto the CLI command options', () => {
    expect(commandFor('Send', { to: '0xa', amount: '1', token: '' })).toEqual({ fn: 'send', opts: { to: '0xa', amount: '1', token: undefined } });
    expect(commandFor('Swap', { tokenIn: 'QUAI', tokenOut: 'DEMO', amount: '2', slippage: '1' }).opts).toEqual({ tokenIn: 'QUAI', tokenOut: 'DEMO', amount: '2', slippage: '1' });
    expect(commandFor('OTC', { sub: 'fill', id: '7' })).toEqual({ fn: 'otc', opts: { sub: 'fill', id: '7' } });
    expect(commandFor('Claim', { sub: 'check', id: '12' }).opts).toEqual({ sub: 'claim', id: '12', check: true });
    expect(commandFor('Claim', { sub: 'claim', id: '12' }).opts.check).toBe(false);
    expect(commandFor('Wall', { sub: 'engrave', message: 'gm', color: '#fff000', token: '' }).opts.message).toBe('gm');
    expect(commandFor('Airdrop', { csv: 'a.csv', token: '', amount: '' }).fn).toBe('airdrop');
  });
  it('validators', () => {
    expect(v.amount('all')).toBe('');
    expect(v.amount('50%')).toBe('');
    expect(v.amount('0')).not.toBe('');
    expect(v.amount('101%')).not.toBe('');
    expect(v.slippage('3')).toBe('');
    expect(v.slippage('100')).not.toBe('');
    expect(v.message('x'.repeat(281))).toMatch(/280/);
    expect(v.color('red')).not.toBe('');
    expect(v.id('0xabc')).toBe('');
    expect(v.tokenRef('DEMO')).toBe('');
    expect(v.tokenRef('0x0080000000000000000000000000000000000001')).toMatch(/Qi/i);
    expect(validateAll('Buy', { token: '', quai: '', slippage: '3' }).ok).toBe(false);
    expect(fieldsFor('Claim', { sub: 'list' })).toEqual([]);
  });
});

describe('data layer', () => {
  it('folds head and trade frames into a contiguous 32-block ribbon', () => {
    let b = { height: 100, at: 0, history: [{ height: 100, count: 0, quai: 0, net: 0 }] };
    b = foldBlock(b, 103);
    expect(b.history.map((c) => c.height)).toEqual([100, 101, 102, 103]);
    b = foldBlock(b, undefined, { blockNumber: 103, side: 'buy', quai: '5' });
    b = foldBlock(b, undefined, { blockNumber: 103, side: 'sell', quai: '1' });
    b = foldBlock(b, undefined, { blockNumber: 103, side: 'buy', quai: '2' });
    expect(b.history.at(-1)).toMatchObject({ count: 3, quai: 8, net: 1 });
    b = foldBlock(b, 200);
    expect(b.history.length).toBe(32);
    expect(b.height).toBe(200);
    expect(b.history.map((c) => c.height)).toEqual(Array.from({ length: 32 }, (_, i) => 169 + i));
  });
  it('a hostile or buggy head frame with a huge block jump never fills (or shifts) more than the ribbon width', () => {
    const b0 = { height: 100, at: 0, history: [{ height: 100, count: 0, quai: 0, net: 0 }] };
    const started = Date.now();
    const b = foldBlock(b0, 1_000_000_000);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(b.history.length).toBe(32);
    expect(b.history.at(-1).height).toBe(1_000_000_000);
    expect(b.height).toBe(1_000_000_000);
  });
  it('decodes a live trade frame (wei -> decimal)', () => {
    const t = tradeFromFrame({ ts: 5, type: 'trade', data: { symbol: 'DEMO', side: 'sell', quaiAmount: '1500000000000000000', tokenAmount: '2000000000000000000000', trader: '0xabc', txHash: '0xdef', blockNumber: 9 } });
    expect(t).toMatchObject({ side: 'sell', quai: '1.5', token: '2000.0', blockNumber: 9, symbol: 'DEMO' });
  });
  it('the demo data source signs nothing: commands run with demo:true', async () => {
    const src = createDataSource({ demo: true, now: () => NOW });
    const r = await src.deps.runCommand('buy', { token: 'DEMO', quai: '5', slippage: '3' });
    expect(r.demo).toBe(true);
    expect(r.dryRun).toBe(true);
    const w = await src.deps.runCommand('wall', { sub: 'engrave', message: 'gm' });
    expect(w.demo).toBe(true);
  });
  it('formatters', () => {
    expect(group('1234567.8900')).toBe('1,234,567.89');
    expect(fmtPrice('18600000000000')).toBe('0.0000186');
    expect(fmtPct(12.34)).toBe('+12.3%');
    expect(fmtPct(null)).toBe('—');
    expect(shortAddr('0x0003b264Bc457BF2dc6F4De80c6C714079febB64', 6, 4)).toBe('0x0003…bB64');
  });
});

describe('entry points', () => {
  it('hartii ui --demo routes to the TUI with demo set; no-args on a TTY too; piped no-args prints help', async () => {
    const runUi = vi.fn(async () => 0);
    expect(await main(['ui', '--demo'], { runUi, write: vi.fn(), env: {} })).toBe(0);
    expect(runUi.mock.calls[0][0].demo).toBe(true);
    runUi.mockClear();
    expect(await main([], { runUi, interactive: true, write: vi.fn(), env: {} })).toBe(0);
    expect(runUi).toHaveBeenCalled();
    runUi.mockClear();
    const write = vi.fn();
    expect(await main([], { runUi, interactive: false, write, env: {} })).toBe(0);
    expect(runUi).not.toHaveBeenCalled();
    expect(write.mock.calls[0][0]).toMatch(/Usage: hartii/);
    expect(await main(['ui', '--help'], { runUi, write: vi.fn(), env: {} })).toBe(0);
    expect(runUi).not.toHaveBeenCalled();
  });
  it('runTui without a TTY prints one plain frame and does not touch raw mode', async () => {
    const out = [];
    const stdin = { isTTY: false, setRawMode: vi.fn() };
    const stdout = { isTTY: false, write: (s) => out.push(s) };
    expect(await runTui({ stdin, stdout, demo: true, env: {} })).toBe(0);
    expect(stdin.setRawMode).not.toHaveBeenCalled();
    expect(out.join('')).toMatch(/BALANCES/);
    expect(out.join('')).not.toMatch(/\u001b/);
  });
  it('runTui on a TTY enters the alternate screen, restores it on q, and re-renders on resize', async () => {
    const { EventEmitter } = await import('node:events');
    const stdin = Object.assign(new EventEmitter(), { isTTY: true, setRawMode: vi.fn(), resume: vi.fn(), pause: vi.fn() });
    const stdout = Object.assign(new EventEmitter(), { isTTY: true, columns: 100, rows: 30, writes: [], write(s) { this.writes.push(s); } });
    const done = runTui({ stdin, stdout, demo: true, env: { COLORTERM: 'truecolor' }, animate: false });
    await flush();
    expect(stdout.writes[0]).toContain('\u001b[?1049h');
    expect(stdin.setRawMode).toHaveBeenCalledWith(true);
    stdout.columns = 80; stdout.rows = 24;
    stdout.emit('resize');
    await flush();
    stdin.emit('keypress', 'q', { name: 'q' });
    expect(await done).toBe(0);
    expect(stdout.writes.join('')).toContain('\u001b[?1049l');
    expect(stdin.setRawMode).toHaveBeenLastCalledWith(false);
    expect(stdout.writes.join('')).toContain('\u001b[?25h');
  });
});
