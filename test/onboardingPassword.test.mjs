import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkNewPassword, passwordStrength, MIN_PASSWORD_LENGTH } from '../src/onboarding/password.js';
import { resolveNewPassword } from '../src/prompt.js';
import { walletNew, walletImport } from '../src/commands/walletCmd.js';
import { WalletError } from '../src/keystore.js';

const FAST = { N: 2, r: 1, p: 1 };
let home;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'hartii-onb-pw-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

describe('password floor', () => {
  it('is 12 characters', () => {
    expect(MIN_PASSWORD_LENGTH).toBe(12);
    expect(checkNewPassword('a'.repeat(11))).toMatch(/at least 12/);
    expect(checkNewPassword('a'.repeat(12))).toBe('');
    expect(checkNewPassword('')).toMatch(/at least 12/);
  });
  it('counts characters, not UTF-16 units', () => {
    expect(checkNewPassword('🔒'.repeat(11))).not.toBe('');
    expect(checkNewPassword('🔒'.repeat(12))).toBe('');
  });
  it('strength hint uses words and rises with length and variety', () => {
    expect(passwordStrength('').label).toBe('empty');
    expect(passwordStrength('short').label).toBe('too short');
    expect(passwordStrength('aaaaaaaaaaaaaaaa').label).toBe('weak');
    expect(passwordStrength('abcdefghijkl').level).toBe(2);
    expect(passwordStrength('Correct-Horse-Battery-9').label).toBe('strong');
  });
  it('rejects a short password for new and imported wallets, with and without HARTII_PASSWORD', async () => {
    await expect(resolveNewPassword({ env: {}, promptFn: vi.fn().mockResolvedValue('elevenchars') })).rejects.toThrow(WalletError);
    await expect(resolveNewPassword({ env: { HARTII_PASSWORD: 'elevenchars' }, writeErr: () => {} })).rejects.toThrow(/at least 12/);
    await expect(walletNew(home, 'a', { env: { HARTII_PASSWORD: 'short' }, scrypt: FAST, writeErr: () => {} })).rejects.toThrow(/at least 12/);
    await expect(walletImport(home, 'key', '0x' + '11'.repeat(32), 'b', { env: { HARTII_PASSWORD: 'short' }, scrypt: FAST, writeErr: () => {} })).rejects.toThrow();
    await expect(walletNew(home, 'ok', { env: { HARTII_PASSWORD: 'exactly-12-ch' }, scrypt: FAST, writeErr: () => {} })).resolves.toMatchObject({ name: 'ok' });
  });
  it('unlocking an existing wallet never applies the floor (resolvePassword is untouched)', async () => {
    const { resolvePassword } = await import('../src/prompt.js');
    expect(await resolvePassword({ env: { HARTII_PASSWORD: 'old8chars' }, writeErr: () => {} })).toBe('old8chars');
  });
});
