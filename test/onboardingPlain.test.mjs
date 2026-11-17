import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runPlainSetup } from '../src/onboarding/plain.js';
import { walletNew } from '../src/commands/walletCmd.js';
import { loadConfig } from '../src/config.js';
import { readBackupPending } from '../src/onboarding/state.js';
import { walletExport } from '../src/commands/walletCmd.js';

const FAST = { N: 2, r: 1, p: 1 };
const PW = 'correct horse battery';
const ALT_ON = '\u001b[?1049h';
const ALT_OFF = '\u001b[?1049l';
let home;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'hartii-onb-plain-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); vi.restoreAllMocks(); });

/** Runs the guided plain flow with a scripted "user" that reads the phrase off the alternate-screen page like a person. */
async function run({ verify = 'ok', caps = '1', extra = {} } = {}) {
  const chunks = [];
  const out = (s) => { chunks.push(String(s)); };
  let phrase = [];
  let askedShow = 0;
  const visibleFn = vi.fn(async (label) => {
    if (label.startsWith('Press Enter')) {
      const page = chunks.join('');
      phrase = [...page.slice(page.lastIndexOf(ALT_ON)).matchAll(/^\s*(\d+)\. ([a-z]+)$/gm)].map((m) => m[2]);
      return '';
    }
    const m = label.match(/^Word #(\d+)/);
    if (m) {
      if (verify === 'show-once' && askedShow === 0) { askedShow += 1; return 'show'; }
      if (verify === 'later') return 'later';
      if (verify === 'wrong-then-ok' && askedShow === 0) { askedShow += 1; return 'zzz'; }
      return phrase[Number(m[1]) - 1];
    }
    if (label.startsWith('Back up later anyway')) return 'y';
    if (label.startsWith('Choose 1-5')) return caps;
    if (label.startsWith('Most QUAI per send')) return '5';
    if (label.startsWith('Most QUAI per day')) return '20';
    return '';
  });
  const pw = vi.fn().mockResolvedValueOnce('short').mockResolvedValueOnce(PW).mockResolvedValueOnce('different password!').mockResolvedValueOnce(PW).mockResolvedValueOnce(PW);
  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  const result = await runPlainSetup(home, { out, interactive: true, env: { TERM: 'xterm-256color' }, promptFn: pw, visibleFn, scrypt: FAST, ascii: true, rng: (() => { let i = 0; return () => [0, 5, 11][i++ % 3]; })(),...extra });
  return { result, chunks, phrase, stdoutSpy, stderrSpy, logSpy };
}

describe('plain-terminal guided setup (hartii wallet new / init)', () => {
  it('creates the wallet, retries a short password and a mismatch, verifies 3 words, sets a preset cap', async () => {
    const { result, chunks } = await run({ caps: '1' });
    expect(result).toMatchObject({ backedUp: true, backupPending: false, caps: 'conservative' });
    expect(existsSync(join(home, 'keystore', `${result.name}.json`))).toBe(true);
    expect(loadConfig(home).limits).toEqual({ perTxQuai: '10', dailyQuai: '50' });
    expect(chunks.join('')).toMatch(/at least 12/);
    expect(chunks.join('')).toMatch(/do not match/);
    expect(readBackupPending(home)).toEqual([]);
  });

  it('the recovery phrase is only ever written inside one alternate-screen page, followed by a clear', async () => {
    const { chunks, phrase, stdoutSpy, stderrSpy, logSpy } = await run();
    expect(phrase).toHaveLength(12);
    const text = chunks.join('');
    const on = text.indexOf(ALT_ON), off = text.indexOf(ALT_OFF);
    expect(on).toBeGreaterThanOrEqual(0);
    expect(off).toBeGreaterThan(on);
    const outside = text.slice(0, on) + text.slice(off);
    // no word of the phrase appears as a numbered list entry anywhere outside the page
    for (const [i, w] of phrase.entries()) expect(outside).not.toMatch(new RegExp(`^\\s*${i + 1}\\. ${w}$`, 'm'));
    expect(outside).not.toContain(phrase.join(' '));
    expect(text.slice(off - 8, off)).toContain('\u001b[2J'); // cleared before leaving the alternate screen
    for (const spy of [stdoutSpy, stderrSpy, logSpy]) expect(spy.mock.calls.flat().join('')).not.toContain(phrase[0] + ' ' + phrase[1]);
  });

  it('a wrong word is refused and a retry works', async () => {
    const { result, chunks } = await run({ verify: 'wrong-then-ok' });
    expect(result.backedUp).toBe(true);
    expect(chunks.join('')).toMatch(/of 3 words do not match|None of the words match/);
  });

  it('"show" re-draws the page', async () => {
    const { result, chunks } = await run({ verify: 'show-once' });
    expect(result.backedUp).toBe(true);
    expect(chunks.join('').split(ALT_ON).length - 1).toBe(2);
  });

  it('"later" needs a confirmation, leaves the persistent reminder and never claims a verified backup', async () => {
    const { result } = await run({ verify: 'later', caps: '5' });
    expect(result).toMatchObject({ backedUp: false, backupPending: true, caps: 'skip' });
    expect(readBackupPending(home)).toEqual([result.name]);
    expect(loadConfig(home).limits).toEqual({}); // skipped: no caps (owner 2026-11-16: caps only when the user sets them)
  });

  it('custom caps are written through the config API', async () => {
    await run({ caps: '4' });
    expect(loadConfig(home).limits).toEqual({ perTxQuai: '5', dailyQuai: '20' });
  });

  it('a completed `wallet export` clears the reminder', async () => {
    const { result } = await run({ verify: 'later', caps: '5' });
    expect(readBackupPending(home)).toEqual([result.name]);
    await walletExport(home, result.name, { stdin: { isTTY: true }, stdout: { isTTY: true, write() {} }, confirmTypedFn: async () => result.name, promptFn: async () => PW, env: {}, writeErr: () => {} });
    expect(readBackupPending(home)).toEqual([]);
  });

  it('refuses without an interactive terminal and never prints a phrase', async () => {
    const out = vi.fn();
    await expect(runPlainSetup(home, { out, interactive: false, env: {} })).rejects.toThrow(/interactive terminal/);
    expect(out).not.toHaveBeenCalled();
    expect(readdirSync(home)).toEqual([]);
  });

  it('Ctrl-C on the phrase page still wipes it', async () => {
    const chunks = [];
    const visibleFn = vi.fn(async (label) => { if (label.startsWith('Press Enter')) throw new Error('Aborted.'); return ''; });
    await expect(runPlainSetup(home, { out: (s) => chunks.push(s), interactive: true, env: {}, promptFn: vi.fn().mockResolvedValue(PW), visibleFn, scrypt: FAST, ascii: true })).rejects.toThrow('Aborted.');
    const text = chunks.join('');
    expect(text.lastIndexOf(ALT_OFF)).toBeGreaterThan(text.lastIndexOf(ALT_ON));
    expect(readBackupPending(home)).toHaveLength(1); // quit mid-backup leaves the reminder
  });
});

describe('scriptable paths never show a phrase', () => {
  it('walletNew with HARTII_PASSWORD keeps today\'s result and prints nothing', async () => {
    const out = vi.fn();
    const r = await walletNew(home, 'ci', { env: { HARTII_PASSWORD: PW }, scrypt: FAST, writeErr: out });
    expect(Object.keys(r).sort()).toEqual(['address', 'name', 'reminder']);
    expect(JSON.stringify(r)).not.toMatch(/(?:[a-z]{3,8} ){11}[a-z]{3,8}/);
  });
  it('walletNew with --json (deps.json) is never guided, even on a TTY', async () => {
    const r = await walletNew(home, 'j', { json: true, env: {}, promptFn: vi.fn().mockResolvedValueOnce(PW).mockResolvedValueOnce(PW), scrypt: FAST, stdin: { isTTY: true } });
    expect(r.name).toBe('j');
  });
});
