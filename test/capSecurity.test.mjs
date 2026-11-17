// Security-run 2026-11-17 (R3-F2): loosening a spending cap needs a human at a terminal.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { main } from '../src/cli.js';
import { loadConfig, saveConfig } from '../src/config.js';

const TTY = { stdin: { isTTY: true }, stdout: { isTTY: true, write() {} } };
let home;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'hartii-capsec-'));
  saveConfig(home, { network: 'mainnet', currentWallet: null, limits: { perTxQuai: '10', dailyQuai: '50' } });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));
async function run(args, extra = {}) {
  const out = [], err = [];
  const exit = await main([...args, '--json'], { env: { HARTII_HOME: home, HARTII_PASSWORD: 'x'.repeat(14) }, write: t => out.push(t), writeErr: t => err.push(t), ...extra });
  return { exit, out, err };
}

describe('R3-F2 cap loosening', () => {
  it('raising a cap non-interactively is refused and changes nothing', async () => {
    const r = await run(['config', 'set', 'limits.perTxQuai', '100000']);
    expect(r.exit).toBe(1);
    expect(r.err.join('')).toMatch(/interactive terminal/);
    expect(loadConfig(home).limits.perTxQuai).toBe('10');
  });
  it('clearing a cap non-interactively is refused', async () => {
    const r = await run(['config', 'set', 'limits.dailyQuai', 'none']);
    expect(r.exit).toBe(1);
    expect(loadConfig(home).limits.dailyQuai).toBe('50');
  });
  it('tightening and first-time setting stay allowed without a terminal', async () => {
    expect((await run(['config', 'set', 'limits.perTxQuai', '5'])).exit).toBe(0);
    saveConfig(home, { network: 'mainnet', currentWallet: null, limits: {} });
    expect((await run(['config', 'set', 'limits.dailyQuai', '20'])).exit).toBe(0);
    expect(loadConfig(home).limits.dailyQuai).toBe('20');
  });
  it('on a terminal the loosening needs a yes', async () => {
    const no = await run(['config', 'set', 'limits.perTxQuai', '500'], { ...TTY, confirmFn: async () => false });
    expect(no.exit).toBe(1);
    expect(loadConfig(home).limits.perTxQuai).toBe('10');
    const yes = await run(['config', 'set', 'limits.perTxQuai', '500'], { ...TTY, confirmFn: async () => true });
    expect(yes.exit).toBe(0);
    expect(loadConfig(home).limits.perTxQuai).toBe('500');
  });
});
