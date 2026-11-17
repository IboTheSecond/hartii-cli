// Main-loop integration (2026-11-16): read commands that touch sealed local data must ask once on a terminal,
// and must never crash or leak when the data is locked and nobody can be asked (scripts, CI, agents).
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVault, lockVault } from '../src/localVault.js';
import { generateMnemonicAccount, encryptAccount, writeKeystoreFile } from '../src/keystore.js';
import { loadConfig, saveConfig } from '../src/config.js';
import { main } from '../src/cli.js';
import { runDoctor } from '../src/commands/doctor.js';

let home;
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'hartii-locked-'));
  const account = generateMnemonicAccount();
  writeKeystoreFile(home, 'default', await encryptAccount({ address: account.address, privateKey: account.privateKey }, 'pw-locked-test', { scrypt: { N: 2, r: 1, p: 1 } }));
  saveConfig(home, { ...loadConfig(home), currentWallet: 'default' });
  await createVault(home, { wallet: 'default', password: 'pw-locked-test', kdfN: 2 ** 14 });
  lockVault(home);
});
const run = async (argv) => {
  const out = []; const err = [];
  const code = await main(argv, { env: { HARTII_HOME: home }, write: (s) => out.push(s), writeErr: (s) => err.push(s), interactive: false, passwordDeps: { promptFn: async () => { throw new Error('no terminal'); } } });
  return { code, out: out.join('\n'), err: err.join('\n') };
};

describe('locked local data', () => {
  it('limits still answers, with spending shown as locked', async () => {
    const r = await run(['limits', '--json']);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out);
    expect(j.locked).toBe(true);
    expect(j.spentTodayQuai).toBeNull();
  });

  it('tx pending still answers, with reservations shown as locked', async () => {
    const r = await run(['tx', 'pending', '--json']);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out);
    expect(j.locked).toBe(true);
    expect(j.pending).toEqual([]);
  });

  it('doctor warns when the CLI home sits outside the user profile', async () => {
    const res = await runDoctor({ home, network: 'orchard' }, { fetchFn: async () => { throw new Error('offline'); }, now: new Date() });
    const check = res.checks.find((c) => c.name === 'homeLocation');
    expect(check).toBeTruthy();
  });
});

import { v as formRules } from '../src/tui/forms.js';
describe('dashboard settings: caps are optional (owner 2026-11-16)', () => {
  it('a blank limit is accepted and means "no cap"; a bad one is still refused', () => {
    expect(formRules.limit('')).toBe('');
    expect(formRules.limit('  ')).toBe('');
    expect(formRules.limit('25')).toBe('');
    expect(formRules.limit('-1')).not.toBe('');
    expect(formRules.limit('abc')).not.toBe('');
  });
});

describe('desk journal with locked local data', () => {
  it('asks to unlock first and gives a plain message when nobody can answer', async () => {
    const r = await run(['desk', 'journal', '--json']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/password|locked|terminal/i);
    expect(r.err).not.toMatch(/stack|at .*\.js/);
  });
});
