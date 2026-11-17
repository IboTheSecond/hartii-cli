// Security-run 2026-11-17 (R3-F1, F13, F14): export/remove need a real terminal and a typed password; the
// vault slot follows the wallet lifecycle; vault KDF cost is raised and capped on read.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import * as walletCmd from '../src/commands/walletCmd.js';
import { createVault, unlockVault, lockVault, enrollWallet, vaultPath, VAULT_DEFAULT_N, writePrivateText, readPrivateText, SEALED_PURPOSES } from '../src/localVault.js';

const FAST = { N: 2, r: 1, p: 1 };
const PW = 'correct-horse-battery-staple';
const TTY = { stdin: { isTTY: true }, stdout: { isTTY: true, write() {} } };
const piped = () => ({ stdin: Object.assign(Readable.from(['default\n']), { isTTY: false }), stdout: { isTTY: false, write() {} } });

let home;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'hartii-walletsec-')); });
afterEach(() => { lockVault(home); rmSync(home, { recursive: true, force: true }); });
const mk = (name = 'default') => walletCmd.walletNew(home, name, { env: {}, scrypt: FAST, promptFn: vi.fn().mockResolvedValue(PW) });

describe('R3-F1 export and remove need a real terminal', () => {
  it('export refuses a piped stdin even with HARTII_PASSWORD set', async () => {
    await mk();
    await expect(walletCmd.walletExport(home, 'default', { ...piped(), env: { HARTII_PASSWORD: PW }, writeErr() {} })).rejects.toThrow(/interactive terminal/);
  });
  it('export ignores HARTII_PASSWORD: it always asks on the terminal', async () => {
    await mk();
    const promptFn = vi.fn().mockResolvedValue(PW);
    const out = await walletCmd.walletExport(home, 'default', { ...TTY, env: { HARTII_PASSWORD: 'not-the-password' }, promptFn, confirmTypedFn: async () => 'default', writeErr() {} });
    expect(promptFn).toHaveBeenCalledTimes(1);
    expect(out.mnemonic).toBeTruthy();
  });
  it('remove refuses without a terminal and leaves the keystore', async () => {
    await mk();
    await expect(walletCmd.walletRemove(home, 'default', { ...piped(), confirmTypedFn: async () => 'default' })).rejects.toThrow(/interactive terminal/);
    expect(walletCmd.walletList(home)).toHaveLength(1);
  });
});

describe('R3-F13 wallet remove drops its vault slot', () => {
  it('a wallet re-created under the same name is not stuck behind its old slot', async () => {
    await mk('a'); await mk('b');
    await createVault(home, { wallet: 'a', password: 'pw-a-pw-a-pw-a', kdfN: 2 ** 14 });
    await enrollWallet(home, { existingPassword: 'pw-a-pw-a-pw-a', wallet: 'b', password: 'pw-b-pw-b-pw-b', kdfN: 2 ** 14 });
    lockVault(home);
    const r = await walletCmd.walletRemove(home, 'a', { ...TTY, confirmTypedFn: async () => 'a' });
    expect(r.vaultSlot).toBe('removed');
    expect(JSON.parse(readFileSync(vaultPath(home), 'utf8')).slots.map(s => s.wallet)).toEqual(['b']);
    // New wallet "a" with b's password enrols on its own (the stale slot would have said "Wrong password").
    await expect(unlockVault(home, { wallet: 'a', password: 'pw-b-pw-b-pw-b', kdfN: 2 ** 14 })).resolves.toEqual({ unlocked: true });
  });
  it('the last slot is retired, never deleted: the data key stays reachable and enrolment is guided', async () => {
    await mk('main');
    await createVault(home, { wallet: 'main', password: 'old-old-old-old', kdfN: 2 ** 14 });
    writePrivateText(home, SEALED_PURPOSES.paid, join(home, 'paid.json'), '{"x":1}');
    lockVault(home);
    const r = await walletCmd.walletRemove(home, 'main', { ...TTY, confirmTypedFn: async () => 'main' });
    expect(r.vaultSlot).toBe('retired');
    await expect(unlockVault(home, { wallet: 'main', password: 'new-new-new-new', kdfN: 2 ** 14 })).rejects.toThrow(/vault enroll/);
    await enrollWallet(home, { existingPassword: 'old-old-old-old', wallet: 'main', password: 'new-new-new-new', kdfN: 2 ** 14 });
    lockVault(home);
    await unlockVault(home, { wallet: 'main', password: 'new-new-new-new', kdfN: 2 ** 14 });
    expect(readPrivateText(home, SEALED_PURPOSES.paid, join(home, 'paid.json'))).toBe('{"x":1}');
  });
});

describe('R3-F14 vault KDF cost', () => {
  it('new vaults default to N=2^17 and refuse N above 2^18 when reading', async () => {
    expect(VAULT_DEFAULT_N).toBe(2 ** 17);
    await createVault(home, { wallet: 'w', password: 'pw-pw-pw-pw-pw', kdfN: 2 ** 14 });
    lockVault(home);
    const doc = JSON.parse(readFileSync(vaultPath(home), 'utf8'));
    doc.kdf.N = 2 ** 20;
    writeFileSync(vaultPath(home), JSON.stringify(doc));
    await expect(unlockVault(home, { wallet: 'w', password: 'pw-pw-pw-pw-pw' })).rejects.toThrow(/unsupported or tampered/);
    doc.kdf.N = 2 ** 14; doc.slots[0].N = 2 ** 19;
    writeFileSync(vaultPath(home), JSON.stringify(doc));
    await expect(unlockVault(home, { wallet: 'w', password: 'pw-pw-pw-pw-pw' })).rejects.toThrow(/unsupported or tampered/);
  });
  it('an old cheaper slot still opens and is re-wrapped at the target cost', async () => {
    await createVault(home, { wallet: 'w', password: 'pw-pw-pw-pw-pw', kdfN: 2 ** 14 });
    lockVault(home);
    await unlockVault(home, { wallet: 'w', password: 'pw-pw-pw-pw-pw', kdfN: 2 ** 15 });
    expect(JSON.parse(readFileSync(vaultPath(home), 'utf8')).slots[0].N).toBe(2 ** 15);
    lockVault(home);
    await expect(unlockVault(home, { wallet: 'w', password: 'pw-pw-pw-pw-pw' })).resolves.toEqual({ unlocked: true });
  });
});
