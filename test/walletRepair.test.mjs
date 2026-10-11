import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.js';
import { parseArgv } from '../src/args.js';
import { runDoctor } from '../src/commands/doctor.js';
import { saveConfig } from '../src/config.js';

const FIRST = '0x0010000000000000000000000000000000000001';
const SECOND = '0x0010000000000000000000000000000000000002';
let home;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'hartii-wallet-repairs-'));
  mkdirSync(join(home, 'keystore'));
  for (const [name, address] of [['first', FIRST], ['second', SECOND]]) {
    writeFileSync(join(home, 'keystore', name + '.json'), JSON.stringify({ version: 3, address: address.slice(2) }));
  }
  saveConfig(home, { network: 'mainnet', currentWallet: 'first', limits: { perTxQuai: '100', dailyQuai: '500' } });
});
async function command(args, extra = {}) {
  const out = [], errors = [];
  const exit = await main(args, { env: { HARTII_HOME: home }, write: text => out.push(text), writeErr: text => errors.push(text),
    fetchFn: () => { throw Error('Network forbidden'); }, providerFactory: () => { throw Error('Provider forbidden'); }, ...extra });
  return { exit, result: out.length ? JSON.parse(out.join('\n')) : null, errors };
}
describe('audited wallet command repairs', () => {
  it.each([['address'], ['wallet', 'address'], ['wallet', 'lock-check']])('honors global wallet for %s', async (...args) => {
    const result = await command([...args, '--wallet', 'second', '--json']);
    expect(result.exit).toBe(0);
    expect(result.result.address.toLowerCase()).toBe(SECOND.toLowerCase());
  });
  it('keeps an explicit positional wallet ahead of the global fallback', async () => {
    const result = await command(['wallet', 'address', 'first', '--wallet', 'second', '--json']);
    expect(result.result.name).toBe('first');
  });
  it('reviews the selected export identity before any secret prompt', async () => {
    const promptFn = vi.fn(() => { throw Error('Must not unlock'); });
    let label;
    const result = await command(['wallet', 'export', '--wallet', 'second', '--json'], { promptFn, confirmTypedFn: async text => { label = text; return 'CANCEL'; } });
    expect(result.exit).toBe(1); expect(label).toContain('"second"'); expect(promptFn).not.toHaveBeenCalled();
  });
  it.each(['browser', 'address-qr'])('treats %s as a boolean without consuming following positional data', flag => {
    const result = parseArgv(['open', '--' + flag, SECOND]);
    expect(result.extraFlags[flag]).toBe(true); expect(result.commandArgs).toEqual([SECOND]);
  });
});

describe('doctor evidence is not fabricated', () => {
  it.each([undefined, null, '0x0', '0', 0, false, true, '-1', 'garbage'])('does not verify clock without a valid positive timestamp %s', async timestamp => {
    const empty = mkdtempSync(join(tmpdir(), 'hartii-doctor-repairs-'));
    const result = await runDoctor({ home: empty }, { fetchFn: async (_url, opts) => {
      if (opts.method === 'POST') return { json: async () => ({ result: JSON.parse(opts.body).method === 'quai_chainId' ? '0x9' : { woHeader: { timestamp } } }) };
      return { ok: true, status: 200 };
    } });
    expect(result.verified).toBe(false);
    expect(result.checks.find(check => check.name === 'clockSkew').ok).not.toBe(true);
  });
  it('bounds diagnostic fetches with an abort signal', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'hartii-doctor-timeout-'));
    const signals = [];
    await runDoctor({ home: empty }, { fetchFn: async (_url, opts) => {
      signals.push(opts.signal);
      if (opts.method === 'POST') return { json: async () => ({ result: JSON.parse(opts.body).method === 'quai_chainId' ? '0x9' : { woHeader: { timestamp: String(Math.floor(Date.now() / 1000)) } } }) };
      return { ok: true, status: 200 };
    } });
    expect(signals).toHaveLength(3); expect(signals.every(signal => signal && typeof signal.aborted === 'boolean')).toBe(true);
  });
});
