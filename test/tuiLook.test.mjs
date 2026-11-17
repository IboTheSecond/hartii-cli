/* eslint-disable no-control-regex -- the assertions inspect raw terminal escape sequences */
import { describe, it, expect } from 'vitest';
import { renderFrame, defaultUi } from '../src/tui/render.js';
import { demoState } from '../src/tui/demoData.js';
import { Screen } from '../src/tui/screen.js';
import { colorDepth, sgr, S, PALETTE } from '../src/tui/theme.js';
import { detectAscii, asciiChar } from '../src/tui/glyphs.js';
import { shownWei, COUNT_UP_MS, PULSE_MS, tier } from '../src/tui/home.js';
import { motionEnabled } from '../src/tui/run.js';
import { createReceiveQr, renderReceiveQr, drawQr } from '../src/qr.js';
import { TuiApp } from '../src/tui/app.js';
import { allScreens, SETUP_STEPS, setupScreen, homeScreen, flowAt, TEST_PHRASE, NOW, ADDRESS } from './setupFixtures.mjs';
import { ansiToHtml } from '../tools/ansi-html.mjs';

const data = (extra = {}) => ({ ...demoState(NOW), now: NOW, ...extra });
const plain = (cols, rows, extra) => renderFrame(data(extra), cols, rows).toPlain();
const RED = /240;70;92/;

describe('home layout at 60, 80, 100 and 120+ columns', () => {
  for (const [cols, rows] of [[60, 18], [60, 24], [80, 24], [100, 30], [120, 40], [200, 60]]) {
    it(`${cols}x${rows}: exact size, nothing wider than the window, wallet-first order`, () => {
      const lines = plain(cols, rows).split('\n');
      expect(lines).toHaveLength(rows);
      for (const l of lines) expect(Array.from(l).length).toBeLessThanOrEqual(cols);
      const text = lines.join('\n');
      expect(text).toContain('BALANCE');
      expect(text.indexOf('Receive')).toBeLessThan(text.indexOf('Send'));
      expect(text.indexOf('Send')).toBeLessThan(text.indexOf('Buy'));
      for (const name of ['Receive', 'Send', 'Buy', 'Sell', 'Swap', 'Airdrop', 'OTC', 'Claim', 'Wall', 'Wallets', 'Settings']) expect(text).toContain(name);
      if (rows >= 24) expect(text.indexOf('Buy')).toBeLessThan(text.indexOf('WATCHLIST'));
    });
  }
  it('60 columns: the header keeps brand, BETA, network, wallet and block without colliding', () => {
    const head = plain(60, 24).split('\n').slice(0, 3).join('\n');
    expect(head).toMatch(/HARTII BETA\s+mainnet · cyprus-1/);
    expect(head).toMatch(/demo\s+0x/);
    expect(head).toMatch(/#10,412,877/);
    expect(head).not.toMatch(/[A-Za-z0-9]{2}mainnet|BETAmainnet/);
  });
  it('a symbol column is reserved so long symbols are never cut at 60 columns', () => {
    const d = data();
    d.watch[0].symbol = 'QUAXEKING1'; d.holdings[0].symbol = 'LONGSYMBOL';
    const text = renderFrame(d, 60, 24).toPlain();
    expect(text).toContain('QUAXEKING1');
    expect(text).toContain('LONGSYMBOL');
    expect(text).toMatch(/QUAXEKING1\s+(?:[▲▼■])/);
  });
  it('tiers', () => { expect([tier(60), tier(79), tier(80), tier(99), tier(100), tier(140)]).toEqual(['narrow', 'narrow', 'medium', 'medium', 'wide', 'wide']); });
  it('the live trades feed is still there, below the actions', () => {
    const text = plain(120, 40);
    expect(text.indexOf('LIVE TRADES')).toBeGreaterThan(text.indexOf('Receive'));
    expect(text).toContain('SELL');
  });
  it('the selected action is marked without colour (marker on the big buttons, [brackets] on the chips)', () => {
    expect(plain(80, 24, { ui: { menu: 1 } })).toMatch(/›\s*↑\s+Send/);
    expect(plain(80, 24, { ui: { menu: 4 } })).toContain('[Swap]');
  });
  it('shows the backup reminder banner while a backup is pending', () => {
    expect(plain(80, 24, { backupPending: true })).toMatch(/Back up your recovery phrase. Press B/);
    expect(plain(80, 24)).not.toMatch(/Back up your recovery phrase/);
  });
});

describe('colour: Labs black-and-white base, violet accent, red only for danger', () => {
  const rows = (fr, depth = 'truecolor') => fr.toAnsiRows(depth).join('\n');
  it('a healthy home frame has violet but no red anywhere', () => {
    const out = rows(renderFrame(data(), 120, 40));
    expect(out).toMatch(/38;2;167;139;250/);
    expect(out).toMatch(/38;2;124;58;237/);
    expect(out).not.toMatch(RED);
  });
  it('danger uses the danger token: a failed command result and a setup error', async () => {
    const app = new TuiApp({ data: data(), size: { cols: 100, rows: 30 }, deps: { runCommand: async () => { throw new Error('boom'); } } });
    await app.execute('Buy', { fn: 'buy', opts: {} });
    expect(rows(app.frame())).toMatch(RED);
    expect(rows(await setupScreen('error', 80, 24))).toMatch(RED);
    expect(S.danger.fg).toEqual(PALETTE.danger);
  });
  it('NO_COLOR: no colour codes at all, and meaning survives (words, glyphs, brackets)', () => {
    const out = rows(renderFrame(data({ ui: { menu: 3 } }), 80, 24), 'none');
    expect(out).not.toMatch(/\u001b\[[0-9;]*(?:38|48);/);
    expect(plain(80, 24, { ui: { menu: 3 } })).toContain('[Sell]');
  });
  it('maps to 256 and to 16 colours', () => {
    const fr = renderFrame(data(), 80, 24);
    expect(rows(fr, '256')).toMatch(/38;5;\d+/);
    expect(rows(fr, '256')).not.toMatch(/38;2;/);
    const sixteen = rows(fr, '16');
    expect(sixteen).not.toMatch(/38;[25];/);
    expect(sixteen).toMatch(/\u001b\[0;(?:1;)?(?:3[0-7]|9[0-7])m/);
    expect(sgr({ fg: PALETTE.danger }, '16')).toMatch(/^(31|91)$/);
  });
  it('colour depth detection', () => {
    expect(colorDepth({ NO_COLOR: '1' })).toBe('none');
    expect(colorDepth({ TERM: 'dumb' })).toBe('none');
    expect(colorDepth({ COLORTERM: 'truecolor' }, 'linux')).toBe('truecolor');
    expect(colorDepth({ TERM: 'xterm-256color' }, 'linux')).toBe('256');
    expect(colorDepth({ TERM: 'linux' }, 'linux')).toBe('16');
  });
});

describe('ASCII fallback', () => {
  it('detects a legacy console, a non-UTF-8 locale and HARTII_ASCII', () => {
    expect(detectAscii({}, 'win32')).toBe(true);
    expect(detectAscii({ WT_SESSION: 'x' }, 'win32')).toBe(false);
    expect(detectAscii({ TERM_PROGRAM: 'vscode' }, 'win32')).toBe(false);
    expect(detectAscii({ LANG: 'en_US.ISO-8859-1' }, 'linux')).toBe(true);
    expect(detectAscii({ LANG: 'C' }, 'linux')).toBe(true);
    expect(detectAscii({ LANG: 'en_US.UTF-8' }, 'linux')).toBe(false);
    expect(detectAscii({}, 'linux')).toBe(false);
    expect(detectAscii({ HARTII_ASCII: '1', WT_SESSION: 'x', LANG: 'en_US.UTF-8' }, 'win32')).toBe(true);
    expect(detectAscii({ HARTII_ASCII: '0' }, 'win32')).toBe(false);
  });
  it('every glyph maps to exactly one printable ASCII column', () => {
    for (const ch of '─│╭╮╰╯▌▏▀▄█·…•▸◂▲▼■✕✓●○◌∩—≈←→↑↓▁▂▃▅▆▇') expect(asciiChar(ch)).toMatch(/^[\x20-\x7e]$/);
  });
  it('home and every setup screen contain only printable ASCII in ASCII mode, at the same size', async () => {
    const check = (screen) => { for (const line of screen.toPlain().split('\n')) expect(line).toMatch(/^[\x20-\x7e]*$/); const ansi = screen.toAnsiRows('truecolor').join(''); expect(ansi.replace(/\u001b\[[0-9;]*m/g, '')).toMatch(/^[\x20-\x7e]*$/); };
    for (const [c, r] of [[60, 24], [80, 24], [120, 40]]) {
      check(homeScreen(c, r, { ascii: true }));
      expect(homeScreen(c, r, { ascii: true }).toPlain().split('\n')).toHaveLength(r);
      for (const step of SETUP_STEPS) check(await setupScreen(step, c, r, { ascii: true }));
    }
  });
  it('the ASCII QR is two columns per module and only shown when the window is tall enough', async () => {
    const { matrix } = createReceiveQr(ADDRESS);
    const q = renderReceiveQr(matrix, { ascii: true });
    expect(q.text).toMatch(/^[ #\n]+$/);
    expect(q.width).toBe((matrix.length + 4) * 2);
    const s = new Screen(100, 50, { ascii: true });
    drawQr(s, 0, 0, matrix, { ascii: true });
    expect(s.toPlain()).toContain('##');
    const small = (await setupScreen('receive', 80, 24, { ascii: true })).toPlain();
    expect(small).toMatch(/taller window/);
    expect(small).toContain('0x 0012 3456');
  });
  it('the QR keeps its polarity without colour (inverse) so it still scans on a dark terminal', () => {
    const { matrix } = createReceiveQr(ADDRESS);
    const s = new Screen(60, 30);
    drawQr(s, 0, 0, matrix);
    const none = s.toAnsiRows('none').join('');
    expect(none).toMatch(/\u001b\[0;7m/);
    expect(none).not.toMatch(/38;|48;/);
  });
});

describe('motion', () => {
  it('motion is off with HARTII_REDUCED_MOTION=1 and without a TTY', () => {
    expect(motionEnabled({}, true)).toBe(true);
    expect(motionEnabled({ HARTII_REDUCED_MOTION: '1' }, true)).toBe(false);
    expect(motionEnabled({ HARTII_REDUCED_MOTION: 'true' }, true)).toBe(false);
    expect(motionEnabled({}, false)).toBe(false);
  });
  it('the newest block pulses brighter for a moment, and not at all with motion off', () => {
    const pulsing = renderFrame(data({ motion: true }), 100, 30).toAnsiRows('truecolor').join('');
    const still = renderFrame(data({ motion: false }), 100, 30).toAnsiRows('truecolor').join('');
    const calm = renderFrame({ ...data({ motion: true }), now: NOW + PULSE_MS + 1 }, 100, 30).toAnsiRows('truecolor').join('');
    expect(pulsing).toMatch(/1;38;2;167;139;250m▁/);
    expect(still).not.toMatch(/1;38;2;167;139;250m▁/);
    expect(calm).not.toMatch(/1;38;2;167;139;250m▁/);
  });
  it('the balance counts up from the old value to the new one, then settles; instant when motion is off', () => {
    const to = 5n * 10n ** 18n;
    const st = { quaiWei: to.toString(), now: 1000 };
    const ui = { countUp: { fromWei: '0', at: 1000 } };
    expect(shownWei(st, ui, true)).toBe(0n);
    const mid = shownWei({ ...st, now: 1000 + COUNT_UP_MS / 2 }, ui, true);
    expect(mid > 0n && mid < to).toBe(true);
    expect(shownWei({ ...st, now: 1000 + COUNT_UP_MS }, ui, true)).toBe(to);
    expect(shownWei(st, ui, false)).toBe(to);
  });
  it('TuiApp starts a count-up only when funds arrive and motion is on, and tick() ends it', () => {
    let t = 1000;
    const mk = (motion) => new TuiApp({ data: { ...demoState(NOW) }, size: { cols: 80, rows: 24 }, deps: { now: () => t }, motion });
    const a = mk(true);
    a.setData({ quaiWei: '1000' });
    expect(a.ui.countUp).toBeNull();
    a.setData({ quaiWei: '5000' });
    expect(a.ui.countUp).toMatchObject({ fromWei: '1000', at: 1000 });
    expect(a.animating()).toBe(true);
    t += COUNT_UP_MS + 200; a.tick();
    expect(a.ui.countUp).toBeNull();
    expect(a.animating()).toBe(false);
    const b = mk(false);
    b.setData({ quaiWei: '1000' }); b.setData({ quaiWei: '5000' });
    expect(b.ui.countUp).toBeNull();
    expect(b.animating()).toBe(false);
  });
});

describe('the recovery phrase is drawn by the phrase step only', () => {
  it('no other setup step, and no home frame, ever contains a phrase word list', async () => {
    const words = TEST_PHRASE.split(' ');
    for (const step of SETUP_STEPS.filter((s) => s !== 'phrase')) {
      const text = (await setupScreen(step, 120, 40)).toPlain();
      expect(text, step).not.toMatch(/^\s*\d{1,2}\s+abandon\b/m);
      expect(text, step).not.toContain('abandon abandon');
    }
    expect((await setupScreen('phrase', 120, 40)).toPlain()).toContain(`12  ${words[11]}`);
    const flow = await flowAt('caps');
    expect(JSON.stringify(flow.snapshot())).not.toContain('abandon');
    expect(plain(120, 40)).not.toContain('abandon');
  });
});

describe('setup screens at 60 / 80 / 120 columns and NO_COLOR', () => {
  for (const step of SETUP_STEPS) {
    for (const [cols, rows] of [[60, 18], [80, 24], [120, 40]]) {
      it(`${step} ${cols}x${rows}`, async () => {
        const s = await setupScreen(step, cols, rows);
        const lines = s.toPlain().split('\n');
        expect(lines).toHaveLength(rows);
        for (const l of lines) expect(Array.from(l).length).toBeLessThanOrEqual(cols);
        expect(s.toPlain()).toMatchSnapshot();
      });
    }
  }
  it('NO_COLOR setup frame carries no colour codes', async () => {
    const out = (await setupScreen('caps', 80, 24)).toAnsiRows('none').join('');
    expect(out).not.toMatch(/\u001b\[[0-9;]*(?:38|48);/);
  });
  it('too-small windows say so', async () => { expect((await setupScreen('welcome', 50, 15)).toPlain()).toMatch(/needs at least 60x18/); });
});

describe('snapshot files for the screenshot gate (test/__snapshots__/setup)', () => {
  it('stay in sync with the renderer', async () => {
    for (const { name, screen } of await allScreens()) {
      await expect(screen.toAnsiRows('truecolor').join('\n') + '\n').toMatchFileSnapshot(`__snapshots__/setup/${name}.ansi`);
    }
  });
  it('ansi-html turns truecolor SGR into spans and escapes markup', () => {
    const html = ansiToHtml('\u001b[0;1;38;2;124;58;237mA<b>\u001b[0m x');
    expect(html).toContain('color:rgb(124,58,237)');
    expect(html).toContain('font-weight:700');
    expect(html).toContain('A&lt;b&gt;');
    expect(ansiToHtml('\u001b[0;7;38;2;1;2;3mZ\u001b[0m')).toContain('background:rgb(1,2,3)');
  });
});

describe('defaults', () => {
  it('defaultUi has a count-up slot', () => { expect(defaultUi()).toHaveProperty('countUp', null); });
});
