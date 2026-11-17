/* eslint-disable no-control-regex -- the assertions inspect raw terminal escape sequences */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runTui } from '../src/tui/run.js';
import { loadConfig } from '../src/config.js';
import { readBackupPending } from '../src/onboarding/state.js';

const FAST = { N: 2, r: 1, p: 1 };
const PW = 'correct horse battery';
let home;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'hartii-onb-tui-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); vi.restoreAllMocks(); });

const strip = (s) => s.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
const wait = (ms = 5) => new Promise((r) => setTimeout(r, ms));

function harness({ balanceRef }) {
  const stdin = Object.assign(new EventEmitter(), { isTTY: true, setRawMode: vi.fn(), resume: vi.fn(), pause: vi.fn() });
  const writes = [];
  const stdout = Object.assign(new EventEmitter(), { isTTY: true, columns: 100, rows: 30, write(s) { writes.push(String(s)); } });
  const provider = { getBalance: async () => balanceRef.wei, destroy() {} };
  const done = runTui({
    stdin, stdout, home, network: 'orchard', scrypt: FAST,
    env: { COLORTERM: 'truecolor', HARTII_REDUCED_MOTION: '1', HARTII_HOME: home, LANG: 'en_US.UTF-8' },
    fetchFn: async () => { throw new Error('offline'); }, providerFactory: () => provider,
  });
  const press = (str, name) => stdin.emit('keypress', str, { name: name || (str && str.length === 1 && /[a-z]/.test(str) ? str : undefined) });
  const type = (t) => { for (const ch of t) press(ch); };
  const last = () => { for (let i = writes.length - 1; i >= 0; i -= 1) if (writes[i].includes('\u001b[H')) return strip(writes[i]); return ''; };
  const until = async (re, ms = 4000) => { const t = Date.now(); while (!re.test(last())) { if (Date.now() - t > ms) throw new Error(`timed out waiting for ${re}; screen:\n${last()}`); await wait(10); } };
  return { stdin, stdout, writes, press, type, last, until, done };
}

describe('TUI first run (no wallet): the guided setup replaces the empty dashboard', () => {
  it('create -> password -> phrase page -> 3 words -> caps -> receive -> Waiting -> Received 5 QUAI -> home', async () => {
    const bal = { wei: 0n };
    const h = harness({ balanceRef: bal });
    await h.until(/Welcome to Hartii/);
    expect(h.last()).not.toMatch(/hartii wallet new/);
    h.press(undefined, 'return'); // create
    await h.until(/Choose a password/);
    h.type('short'); h.press(undefined, 'return');
    await h.until(/at least 12/);
    for (let i = 0; i < 5; i += 1) h.press(undefined, 'backspace');
    h.type(PW); h.press(undefined, 'return');
    await h.until(/Type the password again/);
    h.type(PW); h.press(undefined, 'return');
    await h.until(/Your recovery phrase/);
    // read the 12 words off the screen like a person would
    const screen = h.last();
    const words = [...screen.matchAll(/(\d+)\s+([a-z]{3,8})/g)].map((m) => [Number(m[1]), m[2]]).filter(([n]) => n >= 1 && n <= 12);
    const phrase = [];
    for (const [n, w] of words) phrase[n - 1] = w;
    expect(phrase.filter(Boolean)).toHaveLength(12);
    const phraseWrites = h.writes.length;
    h.press(undefined, 'return');
    await h.until(/Check your backup/);
    // the phrase page is gone and the terminal was cleared on the way out
    const after = h.writes.slice(phraseWrites).join('');
    expect(after).toContain('\u001b[2J');
    expect(strip(h.last())).not.toContain(phrase[0] + ' ' + phrase[1]);
    for (const n of (h.last().match(/Word #(\d+)/g) || []).map((t) => Number(t.slice(6)))) { h.type(phrase[n - 1]); h.press(undefined, 'return'); }
    h.press(undefined, 'return'); // "Check my words"
    await h.until(/safety limit/);
    h.press('1'); // conservative
    await h.until(/Waiting for funds/);
    expect(h.last()).toMatch(/0x [0-9a-fA-F]{4}/); // the address in readable groups
    expect(loadConfig(home).limits).toEqual({ perTxQuai: '10', dailyQuai: '50' });
    expect(readBackupPending(home)).toEqual([]);
    bal.wei = 5n * 10n ** 18n; // funds arrive; the data source's next refresh sees them
    await h.until(/Received 5 QUAI/, 12000);
    h.press(undefined, 'return');
    await h.until(/BALANCE/);
    expect(h.last()).toMatch(/Receive/);
    // not one write contained the phrase outside the phrase page's frame
    const phraseText = phrase.join(' ');
    expect(h.writes.filter((w) => strip(w).includes(phraseText.slice(0, 20))).length).toBe(0);
    h.press('q');
    expect(await h.done).toBe(0);
    expect(h.stdout.listenerCount('resize')).toBe(0);
  }, 30000);

  it('"back up later" shows the persistent reminder banner on the home screen', async () => {
    const h = harness({ balanceRef: { wei: 0n } });
    await h.until(/Welcome to Hartii/);
    h.press(undefined, 'return');
    await h.until(/Choose a password/);
    h.type(PW); h.press(undefined, 'return');
    await h.until(/again/); h.type(PW); h.press(undefined, 'return');
    await h.until(/Your recovery phrase/);
    h.press(undefined, 'return');
    await h.until(/Check your backup/);
    h.press(undefined, 'down'); h.press(undefined, 'down'); h.press(undefined, 'down'); h.press(undefined, 'down'); h.press(undefined, 'down'); // "Back up later"
    h.press(undefined, 'return');
    await h.until(/Without your phrase/);
    h.press(undefined, 'return');
    await h.until(/safety limit/);
    h.press(undefined, 'escape'); // skip caps
    await h.until(/Waiting for funds/);
    h.press(undefined, 'return'); // skip funds
    await h.until(/Back up your recovery phrase/);
    expect(readBackupPending(home)).toHaveLength(1);
    expect(loadConfig(home).limits).toEqual({}); // skipped: no caps (owner 2026-11-16)
    h.press('q');
    await h.done;
  }, 30000);

  it('quitting on the phrase page wipes the terminal and leaves the reminder', async () => {
    const h = harness({ balanceRef: { wei: 0n } });
    await h.until(/Welcome to Hartii/);
    h.press(undefined, 'return');
    await h.until(/Choose a password/);
    h.type(PW); h.press(undefined, 'return');
    await h.until(/again/); h.type(PW); h.press(undefined, 'return');
    await h.until(/Your recovery phrase/);
    const n = h.writes.length;
    h.stdin.emit('keypress', undefined, { ctrl: true, name: 'c' });
    expect(await h.done).toBe(0);
    const tail = h.writes.slice(n).join('');
    expect(tail.indexOf('\u001b[2J')).toBeGreaterThanOrEqual(0);
    expect(tail.indexOf('\u001b[2J')).toBeLessThan(tail.indexOf('\u001b[?1049l'));
    expect(readBackupPending(home)).toHaveLength(1);
    expect(existsSync(join(home, 'keystore'))).toBe(true);
  }, 30000);
});
