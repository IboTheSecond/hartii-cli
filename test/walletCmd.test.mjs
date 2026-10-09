// packages/hartii-cli/test/walletCmd.test.mjs
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isQuaiAddress, getZoneForAddress, Zone } from 'quais';
import * as walletCmd from '../src/commands/walletCmd.js';
import { WalletError } from '../src/keystore.js';
import { loadConfig } from '../src/config.js';

const SCRYPT_FAST = { N: 2, r: 1, p: 1 };
const PASSWORD = 'correct-horse-battery-staple';

function deps(extra = {}) {
  return { env: {}, promptFn: vi.fn().mockResolvedValueOnce(PASSWORD).mockResolvedValueOnce(PASSWORD), scrypt: SCRYPT_FAST, ...extra };
}

let home;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'hartii-cli-walletcmd-test-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('walletNew', () => {
  it('creates a Cyprus-1 wallet, never returning the mnemonic/key', async () => {
    const result = await walletCmd.walletNew(home, 'alice', deps());
    expect(result.name).toBe('alice');
    expect(isQuaiAddress(result.address)).toBe(true);
    expect(getZoneForAddress(result.address)).toBe(Zone.Cyprus1);
    expect(Object.keys(result).sort()).toEqual(['address', 'name', 'reminder']);
    expect(result.reminder).toMatch(/wallet export/);
  });

  it('becomes the current wallet', async () => {
    await walletCmd.walletNew(home, 'alice', deps());
    expect(loadConfig(home).currentWallet).toBe('alice');
  });

  it('auto-names when no name is given', async () => {
    const result = await walletCmd.walletNew(home, undefined, deps());
    expect(result.name).toBe('default');
  });

  it('refuses to collide with an existing wallet', async () => {
    await walletCmd.walletNew(home, 'alice', deps());
    await expect(walletCmd.walletNew(home, 'alice', deps())).rejects.toThrow(WalletError);
  });

  it('enforces a minimum password length and a matching confirmation', async () => {
    await expect(walletCmd.walletNew(home, 'short', deps({ promptFn: vi.fn().mockResolvedValue('abc') }))).rejects.toThrow(/at least 8/);
    await expect(
      walletCmd.walletNew(home, 'mismatch', deps({ promptFn: vi.fn().mockResolvedValueOnce('longenough1').mockResolvedValueOnce('longenough2') })),
    ).rejects.toThrow(/do not match/);
  });

  it('skips the confirm-password prompt when HARTII_PASSWORD is set', async () => {
    const promptFn = vi.fn();
    const result = await walletCmd.walletNew(home, 'ci', { env: { HARTII_PASSWORD: PASSWORD }, promptFn, scrypt: SCRYPT_FAST, writeErr: () => {} });
    expect(result.name).toBe('ci');
    expect(promptFn).not.toHaveBeenCalled();
  });
});

describe('walletImport', () => {
  it('imports from a raw private key', async () => {
    const generated = await walletCmd.walletNew(home, 'source', deps());
    const exported = await walletCmd.walletExport(home, 'source', { ...deps(), confirmTypedFn: vi.fn().mockResolvedValue('source') });
    const imported = await walletCmd.walletImport(home, 'key', exported.privateKey, 'imported', deps());
    expect(imported.address).toBe(generated.address);
  });

  it('imports from a mnemonic phrase, re-deriving the same address', async () => {
    const generated = await walletCmd.walletNew(home, 'source2', deps());
    const exported = await walletCmd.walletExport(home, 'source2', { ...deps(), confirmTypedFn: vi.fn().mockResolvedValue('source2') });
    const imported = await walletCmd.walletImport(home, 'mnemonic', exported.mnemonic, 'imported2', deps());
    expect(imported.address).toBe(generated.address);
  }, 60000); // Real key grinding and scrypt can exceed 20s on a busy development host.

  it('rejects an invalid mnemonic', async () => {
    await expect(walletCmd.walletImport(home, 'mnemonic', 'totally not a phrase', 'x', deps())).rejects.toThrow(WalletError);
  });

  it('rejects an invalid private key', async () => {
    await expect(walletCmd.walletImport(home, 'key', '0xdeadbeef', 'x', deps())).rejects.toThrow(WalletError);
  });

  it('rejects an unknown kind', async () => {
    await expect(walletCmd.walletImport(home, 'carrier-pigeon', 'x', 'y', deps())).rejects.toThrow(WalletError);
  });
});

describe('walletList / walletUse / walletAddress', () => {
  it('lists wallets sorted, flagging the current one', async () => {
    await walletCmd.walletNew(home, 'bob', deps());
    await walletCmd.walletNew(home, 'alice', deps());
    const list = walletCmd.walletList(home);
    expect(list.map((w) => w.name)).toEqual(['alice', 'bob']);
    expect(list.find((w) => w.name === 'alice').current).toBe(true);
    expect(list.find((w) => w.name === 'bob').current).toBe(false);
  });

  it('walletUse switches the current wallet', async () => {
    await walletCmd.walletNew(home, 'bob', deps());
    await walletCmd.walletNew(home, 'alice', deps());
    walletCmd.walletUse(home, 'bob');
    expect(loadConfig(home).currentWallet).toBe('bob');
  });

  it('walletUse throws for an unknown wallet', () => {
    expect(() => walletCmd.walletUse(home, 'ghost')).toThrow(WalletError);
  });

  it('walletAddress resolves the current wallet with no name given, needing no password', async () => {
    const created = await walletCmd.walletNew(home, 'bob', deps());
    const result = walletCmd.walletAddress(home);
    expect(result.address).toBe(created.address);
  });

  it('walletAddress --qr encodes the selected public address without an unlock', async () => {
    await walletCmd.walletNew(home, 'bob', deps());
    const result = walletCmd.walletAddress(home, 'bob', { qr: true });
    expect(result.qr.payload).toBe(result.address);
    expect(result.qr.matrix.length).toBeGreaterThan(20);
    expect(result.note).toMatch(/public address only/i);
  });

  it('walletAddress throws when nothing is selected', () => {
    expect(() => walletCmd.walletAddress(home)).toThrow(WalletError);
  });
});

describe('walletExport', () => {
  it('requires the exact typed wallet name, not just the password', async () => {
    await walletCmd.walletNew(home, 'alice', deps());
    await expect(walletCmd.walletExport(home, 'alice', { ...deps(), confirmTypedFn: vi.fn().mockResolvedValue('WRONG') })).rejects.toThrow(/did not match/);
  });

  it('returns the private key and reconstructed mnemonic once confirmed', async () => {
    const created = await walletCmd.walletNew(home, 'alice', deps());
    const exported = await walletCmd.walletExport(home, 'alice', { ...deps(), confirmTypedFn: vi.fn().mockResolvedValue('alice') });
    expect(exported.address).toBe(created.address);
    expect(exported.privateKey).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(exported.mnemonic.split(' ')).toHaveLength(12);
  });

  it('a raw-key-imported wallet has no mnemonic to export', async () => {
    await walletCmd.walletNew(home, 'source', deps());
    const exported1 = await walletCmd.walletExport(home, 'source', { ...deps(), confirmTypedFn: vi.fn().mockResolvedValue('source') });
    await walletCmd.walletImport(home, 'key', exported1.privateKey, 'rawimport', deps());
    const exported2 = await walletCmd.walletExport(home, 'rawimport', { ...deps(), confirmTypedFn: vi.fn().mockResolvedValue('rawimport') });
    expect(exported2.mnemonic).toBeUndefined();
  });

  it('is never short-circuited by the password alone — wrong password still fails even with the right typed name', async () => {
    await walletCmd.walletNew(home, 'alice', deps());
    await expect(
      walletCmd.walletExport(home, 'alice', { env: {}, promptFn: vi.fn().mockResolvedValue('wrong-password'), confirmTypedFn: vi.fn().mockResolvedValue('alice') }),
    ).rejects.toThrow(/wrong password/i);
  });
});

describe('walletRename', () => {
  it('renames and updates currentWallet if it was the active one', async () => {
    await walletCmd.walletNew(home, 'alice', deps());
    const renamed = walletCmd.walletRename(home, 'alice', 'alicia');
    expect(renamed).toEqual({ oldName: 'alice', newName: 'alicia' });
    expect(loadConfig(home).currentWallet).toBe('alicia');
    expect(walletCmd.walletList(home).map((w) => w.name)).toEqual(['alicia']);
  });

  it('refuses a colliding destination name', async () => {
    await walletCmd.walletNew(home, 'alice', deps());
    await walletCmd.walletNew(home, 'bob', deps());
    expect(() => walletCmd.walletRename(home, 'alice', 'bob')).toThrow(WalletError);
  });
});

describe('walletRemove', () => {
  it('requires the exact typed name, not --yes', async () => {
    await walletCmd.walletNew(home, 'alice', deps());
    await expect(walletCmd.walletRemove(home, 'alice', { confirmTypedFn: vi.fn().mockResolvedValue('nope') })).rejects.toThrow(/did not match/);
    expect(walletCmd.walletList(home)).toHaveLength(1);
  });

  it('removes the wallet and clears currentWallet if it was active', async () => {
    await walletCmd.walletNew(home, 'alice', deps());
    await walletCmd.walletRemove(home, 'alice', { confirmTypedFn: vi.fn().mockResolvedValue('alice') });
    expect(walletCmd.walletList(home)).toHaveLength(0);
    expect(loadConfig(home).currentWallet).toBeNull();
  });
});

describe('walletLockCheck', () => {
  it('reports encrypted + permsOk for a freshly created wallet, no password needed', async () => {
    const created = await walletCmd.walletNew(home, 'alice', deps());
    const result = walletCmd.walletLockCheck(home, 'alice');
    expect(result.address).toBe(created.address);
    expect(result.encrypted).toBe(true);
    expect(result.permsOk).toBe(process.platform === 'win32' ? null : true);
  });

  it('throws for an unknown wallet', () => {
    expect(() => walletCmd.walletLockCheck(home, 'ghost')).toThrow(WalletError);
  });
});
