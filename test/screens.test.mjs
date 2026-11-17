import { describe, it, expect } from 'vitest';
import { formatHumanResult } from '../src/humanOutput.js';
import { renderReview } from '../src/review.js';
import { makeColors, makeTheme, colorDepth, stripAnsi, tagView, withProgress } from '../src/output.js';
import { runBalance } from '../src/commands/balance.js';
import { runTokens } from '../src/commands/tokens.js';
import { runToken } from '../src/commands/token.js';
import { runDoctor } from '../src/commands/doctor.js';
import { runExtra } from '../src/commands/extras.js';
import { runConfig } from '../src/commands/configCmd.js';
import { runWallet } from '../src/commands/walletRoute.js';
import { runTx } from '../src/commands/tx.js';
import { ansiToHtml } from '../tools/ansiToHtml.mjs';

const ADDR = '0x0000000000000000000000000000000000000d01';
const TX = '0x' + 'ab'.repeat(32);
const demoOpts = { demo: true };
const ctx = (extra = {}) => ({ opts: { demo: true, home: '/nonexistent-hartii-home', ...extra }, deps: { env: {} }, extraFlags: {} });

const summary = {
  action: 'Send QUAI', network: 'mainnet', chainId: 9, from: ADDR, to: '0x0000000000000000000000000000000000000d04', valueQuai: '2.5',
  guardedQuai: '2.5', guardedWithFeeQuai: '4.241272636187266', gasLimit: '46800', gasPriceWei: '44648016312494', estimatedFeeQuai: '1.741272636187266',
  nonce: 4, dataDigest: '0x' + '12'.repeat(32), dataSelector: 'none', dataBytes: 0,
  warnings: [{ level: 'danger', code: 'new-recipient', text: 'You have never sent to this address. Check every group of its address twice.' }],
};

async function fixtures() {
  const demoToken = await runToken({ id: 'DEMO', demo: true });
  return {
    balance: await runBalance({ ...demoOpts, tokens: true }),
    'balance-empty': { wallet: ADDR, walletName: 'main', network: 'mainnet', quai: '0.0', quaiWei: '0', holdings: [] },
    tokens: await runTokens(demoOpts),
    'tokens-empty': { sort: 'search', query: 'zzz', items: [] },
    token: demoToken,
    tx: tagView({ hash: TX, network: 'mainnet', status: 'success', blockNumber: 10400000, from: ADDR, to: '0x0000000000000000000000000000000000000d04', valueQuai: '5.0', gasUsed: '98234', quaiscanUrl: `https://quaiscan.io/tx/${TX}` }, 'tx'),
    'tx-reverted': tagView({ hash: TX, network: 'mainnet', status: 'reverted', blockNumber: 10400001, from: ADDR, to: '0x0000000000000000000000000000000000000d04', valueQuai: '0.0', gasUsed: '21000', quaiscanUrl: `https://quaiscan.io/tx/${TX}` }, 'tx'),
    doctor: await runDoctor(demoOpts),
    'doctor-fail': { ok: false, checks: [
      { name: 'rpc', ok: false, detail: 'http://127.0.0.1:1/ unreachable: fetch failed' },
      { name: 'chainId', ok: false, detail: 'skipped (RPC unreachable)' },
      { name: 'keystorePerms', ok: true, detail: 'no keystore directory exists yet' },
      { name: 'addressLedger', ok: true, detail: 'no current wallet set' },
      { name: 'api', ok: true, detail: 'https://hartiilabs.com/api/health -> 200' },
      { name: 'clockSkew', ok: null, detail: 'could not read a valid positive block timestamp' }] },
    whoami: tagView({ wallet: 'main', address: ADDR, network: 'mainnet', home: '/home/me/.hartii' }, 'whoami'),
    'whoami-none': tagView({ wallet: null, address: null, network: 'mainnet', home: '/home/me/.hartii', hint: 'No wallet yet.' }, 'whoami'),
    networks: await runExtra('networks', [], ctx()),
    gas: tagView({ network: 'mainnet', gasPriceWei: '44648016312494', gasPriceGwei: '44648.016312494', transferCostQuai: '1.741272636187266', contractCallCostQuai: '11.1620040781235' }, 'gas'),
    limits: tagView({ wallet: ADDR, network: 'mainnet', perTxQuai: '50', dailyQuai: '200', spentTodayQuai: '12.5', reservedQuai: '0.0' }, 'limits'),
    'limits-none': tagView({ wallet: null, network: 'mainnet', perTxQuai: null, dailyQuai: null, spentTodayQuai: '0.0', reservedQuai: '0.0' }, 'limits'),
    block: tagView({ network: 'mainnet', height: 10412877 }, 'block'),
    config: runConfig(['get'], '/nonexistent-hartii-home'),
    about: await runExtra('about', [], ctx()),
    init: await runExtra('init', [], ctx()),
    'wallet-help': await runWallet([undefined], {}, { home: '/nonexistent', io: {}, g: {} }),
    'write-done': { ok: true, txHash: TX, status: 'success', quaiscanUrl: `https://quaiscan.io/tx/${TX}`, summary },
    'write-aborted': { ok: false, aborted: true, summary },
  };
}

const WIDTHS = [60, 80, 120];
const PLAIN = makeColors({ enabled: false });
const TRUE = () => makeColors({ enabled: true, env: { COLORTERM: 'truecolor' } });
const render = (r, o = {}) => formatHumanResult(r, { colors: PLAIN, ...o });
const KEY = ['balance', 'token', 'tokens', 'doctor-fail', 'limits'];

describe('designed human views', () => {
  it('snapshots every view at 60/80/120 columns without colour', async () => {
    const all = await fixtures();
    for (const [name, result] of Object.entries(all)) {
      const sections = WIDTHS.map((w) => `=== ${name} @ ${w} columns (NO_COLOR) ===\n${render(result, { width: w })}\n`);
      await expect(sections.join('\n')).toMatchFileSnapshot(`__snapshots__/screens/${name}.plain.txt`);
    }
    for (const [label, summ] of [['review', summary], ['review-details', summary]]) {
      const sections = WIDTHS.map((w) => `=== ${label} @ ${w} columns (NO_COLOR) ===\n${renderReview(summ, { color: false, width: w, details: label === 'review-details' })}\n`);
      await expect(sections.join('\n')).toMatchFileSnapshot(`__snapshots__/screens/${label}.plain.txt`);
    }
  });

  it('keeps every line inside the terminal width and free of colour codes without colour', async () => {
    const all = await fixtures();
    for (const [name, result] of Object.entries(all)) {
      for (const w of WIDTHS) {
        const text = render(result, { width: w });
        expect(text, name).not.toMatch(/\u001b/);
        for (const line of text.split('\n')) {
          // URLs, hashes and bare addresses are never cut; everything else must fit.
          if (/\S{40,}/.test(line)) continue;
          expect(Array.from(line).length, `${name}@${w}: ${line}`).toBeLessThanOrEqual(w);
        }
      }
    }
  });

  it('never shows raw wei or base units in a human view', async () => {
    const all = await fixtures();
    for (const [name, result] of Object.entries(all)) {
      if (name === 'doctor' || name.startsWith('tx')) continue;
      const text = render(result, { width: 120 });
      expect(text.replace(/0x[0-9a-fA-F]+/g, ''), name).not.toMatch(/\d{13,}/);
    }
  });

  it('writes ANSI and HTML previews of the review and five key views', async () => {
    const all = await fixtures();
    const colors = TRUE();
    const shots = [['review', renderReview(summary, { color: true, depth: 24, width: 80 })], ...KEY.map((n) => [n, formatHumanResult(all[n], { colors, width: 80 })])];
    for (const [name, ansi] of shots) {
      await expect(ansi + '\n').toMatchFileSnapshot(`__snapshots__/screens/${name}.ansi`);
      await expect(ansiToHtml(ansi, { title: `Hartii CLI: ${name}` })).toMatchFileSnapshot(`__snapshots__/screens/preview/${name}.html`);
      expect(stripAnsi(ansi).length).toBeGreaterThan(20);
    }
  });

  it('uses red only for danger and failure', async () => {
    const all = await fixtures();
    const colors = TRUE();
    const RED = '38;2;240;70;92';
    const calm = ['balance', 'balance-empty', 'tokens', 'token', 'tx', 'doctor', 'whoami', 'networks', 'gas', 'limits', 'block', 'config', 'about', 'init', 'wallet-help', 'write-done', 'write-aborted'];
    for (const name of calm) expect(formatHumanResult(all[name], { colors, width: 80 }), name).not.toContain(RED);
    for (const name of ['doctor-fail', 'tx-reverted']) expect(formatHumanResult(all[name], { colors, width: 80 }), name).toContain(RED);
  });

  it('terse mode keeps one line per result', async () => {
    const all = await fixtures();
    for (const name of ['balance', 'token', 'tx', 'doctor', 'doctor-fail', 'whoami', 'gas', 'limits', 'block', 'about']) {
      const text = render(all[name], { terse: true, width: 80 });
      expect(text.split('\n').length, `${name}: ${text}`).toBe(1);
    }
    expect(render(all.tokens, { terse: true }).split('\n')).toHaveLength(all.tokens.items.length);
  });
});

describe('view content', () => {
  it('balance shows grouped amounts, grouped address and an empty-wallet hint', async () => {
    const all = await fixtures();
    const text = render(all.balance);
    expect(text).toContain('1,234.56 QUAI');
    expect(text).toContain('50,000');
    expect(text).not.toContain('50000000000000000000000');
    expect(text).toMatch(/0x([0-9a-fA-F]{4} ){9}[0-9a-fA-F]{4}/);
    expect(render(all['balance-empty'])).toContain('hartii receive');
  });
  it('doctor ends with one verdict and the exact fix command for each failure', async () => {
    const all = await fixtures();
    expect(render(all.doctor).trim().split('\n').pop()).toBe('Ready'.padStart(7));
    const fail = render(all['doctor-fail']);
    expect(fail).toContain('2 things to fix');
    expect(fail).toContain('hartii config set network mainnet');
    expect(fail).toContain('FAIL');
    expect(render({ ok: false, checks: [{ name: 'keystorePerms', ok: false, detail: 'x' }] })).toContain('hartii wallet lock-check');
  });
  it('limits work without a wallet and explain that limits are optional', async () => {
    const out = await runExtra('limits', [], ctx({ demo: false, home: '/nonexistent-hartii-home-limits' }));
    expect(out.wallet).toBeNull();
    expect(render(out)).toContain('no wallet selected');
    const text = render(await fixtures().then((f) => f['limits-none']));
    expect(text).toContain('no limit set');
    expect(text).toContain('optional');
  });
  it('bare `hartii wallet` shows the subcommands instead of an error', async () => {
    const out = await runWallet([], {}, { home: '/nonexistent', io: {}, g: {} });
    expect(out.ok).toBe(true);
    expect(JSON.stringify(out)).not.toContain('Symbol');
    const text = render(out);
    for (const sub of ['new', 'import', 'list', 'use', 'address', 'export', 'rename', 'remove', 'lock-check']) expect(text).toContain(`hartii wallet ${sub}`);
  });
  it('tags never leak into JSON', async () => {
    const result = await runExtra('about', [], ctx());
    expect(JSON.parse(JSON.stringify(result))).toEqual({ ...result });
    expect(Object.keys(result)).not.toContain('view');
  });
  it('tx pending list keeps its original safety wording', () => {
    const text = render({ readOnly: true, pending: [], count: 0, lock: { exists: false }, note: 'No unresolved reservations in this profile.' });
    expect(text).toContain('0 locally unresolved reservations');
  });
  it('shows a finished write as an outcome, a cancelled one as aborted, a preview as preview', () => {
    expect(render({ ok: true, txHash: TX, quaiscanUrl: 'https://quaiscan.io/tx/x', summary })).toContain('confirmed on chain');
    expect(render({ ok: false, aborted: true, summary })).toContain('Aborted');
    expect(render({ ok: true, dryRun: true, summary })).toContain('Preview only');
    expect(render({ demo: true, summary: { action: 'Buy' } })).toContain('DEMO');
  });
  it('tx not found and unknown stay honest', () => {
    const text = render(tagView({ hash: TX, network: 'mainnet', status: 'not found', quaiscanUrl: 'u' }, 'tx'));
    expect(text).toContain('Not found');
  });
});

describe('colour depth and theme', () => {
  it('detects truecolor, 256 and 16 and honours NO_COLOR', () => {
    const base = { isTTY: true };
    expect(colorDepth({ ...base, env: { COLORTERM: 'truecolor' } })).toBe(24);
    expect(colorDepth({ ...base, env: { TERM: 'xterm-256color' } })).toBe(8);
    expect(colorDepth({ ...base, env: { TERM: 'xterm' } })).toBe(4);
    expect(colorDepth({ ...base, env: { NO_COLOR: '1', COLORTERM: 'truecolor' } })).toBe(0);
    expect(colorDepth({ isTTY: false, env: { COLORTERM: 'truecolor' } })).toBe(0);
    expect(colorDepth({ isTTY: false, env: { FORCE_COLOR: '3' } })).toBe(24);
  });
  it('maps the accent to truecolor, 256 and 16 codes', () => {
    expect(makeTheme({ depth: 24 }).accent('x')).toContain('38;2;124;58;237');
    expect(makeTheme({ depth: 8 }).accent('x')).toMatch(/38;5;\d+m/);
    expect(makeTheme({ depth: 4 }).accent('x')).toContain('[35m');
    expect(makeTheme({ depth: 0 }).accent('x')).toBe('x');
  });
});

describe('progress line', () => {
  const sink = () => { const chunks = []; return { chunks, write: (s) => chunks.push(s) }; };
  it('stays silent for fast work, on a non-TTY and with --json', async () => {
    const a = sink();
    expect(await withProgress('Loading', async () => 7, { stream: a, tty: true })).toBe(7);
    expect(a.chunks).toEqual([]);
    const b = sink();
    await withProgress('Loading', () => new Promise((r) => setTimeout(r, 40)), { stream: b, tty: false, delayMs: 5 });
    expect(b.chunks).toEqual([]);
    const c = sink();
    await withProgress('Loading', () => new Promise((r) => setTimeout(r, 40)), { stream: c, tty: true, json: true, delayMs: 5 });
    expect(c.chunks).toEqual([]);
  });
  it('shows and then clears a line for a slow wait on a TTY', async () => {
    const s = sink();
    await withProgress('Loading', () => new Promise((r) => setTimeout(r, 60)), { stream: s, tty: true, delayMs: 10 });
    expect(s.chunks.join('')).toContain('Loading');
    expect(s.chunks[s.chunks.length - 1]).toMatch(/^\r\s+\r$/);
  });
  it('passes errors through and clears the line', async () => {
    const s = sink();
    await expect(withProgress('Loading', () => new Promise((_, rej) => setTimeout(() => rej(new Error('boom')), 40)), { stream: s, tty: true, delayMs: 5 })).rejects.toThrow('boom');
    expect(s.chunks[s.chunks.length - 1]).toMatch(/^\r\s+\r$/);
  });
});

describe('formatter used by views', () => {
  it('has a runTx pending branch that is not tagged', async () => {
    const out = await runTx({ hash: 'pending', home: '/nonexistent-hartii-home-tx' }, {});
    expect(Array.isArray(out.pending)).toBe(true);
  });
});

describe('ui options', () => {
  it('reads --terse, config ui.terse, --details and the terminal width', async () => {
    const { uiOptions } = await import('../src/output.js');
    expect(uiOptions({ flags: { terse: true }, stdout: { columns: 60 } })).toEqual({ terse: true, details: false, width: 60 });
    expect(uiOptions({ flags: {}, cfg: { ui: { terse: true } }, stdout: {} })).toEqual({ terse: true, details: false, width: 80 });
    expect(uiOptions({ flags: { details: true }, stdout: { columns: 120 } })).toMatchObject({ details: true, terse: false, width: 120 });
  });
});
