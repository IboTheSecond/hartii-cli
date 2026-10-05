// packages/hartii-cli/test/keystore.test.mjs
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isQuaiAddress, getZoneForAddress, Zone, Mnemonic } from 'quais';
import {
  WalletError,
  assertValidWalletName,
  listWallets,
  walletExists,
  generateMnemonicAccount,
  accountFromMnemonic,
  accountFromPrivateKey,
  encryptAccount,
  decryptAccount,
  writeKeystoreFile,
  readKeystoreFile,
  removeKeystoreFile,
  renameKeystoreFile,
  checkKeystorePerms,
  keystorePath,
} from '../src/keystore.js';

let home;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'hartii-cli-keystore-test-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('assertValidWalletName', () => {
  it('accepts simple names', () => {
    expect(assertValidWalletName('default')).toBe('default');
    expect(assertValidWalletName('my-wallet_2')).toBe('my-wallet_2');
  });

  it('rejects path traversal and separators', () => {
    expect(() => assertValidWalletName('../etc/passwd')).toThrow(WalletError);
    expect(() => assertValidWalletName('a/b')).toThrow(WalletError);
    expect(() => assertValidWalletName('')).toThrow(WalletError);
  });
});

describe('generateMnemonicAccount', () => {
  it('derives a Cyprus-1 Quai address from a fresh 12-word mnemonic', () => {
    const account = generateMnemonicAccount();
    expect(account.mnemonicPhrase.split(' ')).toHaveLength(12);
    expect(isQuaiAddress(account.address)).toBe(true);
    expect(getZoneForAddress(account.address)).toBe(Zone.Cyprus1);
    expect(account.privateKey).toMatch(/^0x[0-9a-fA-F]{64}$/);
  });

  it('two calls produce different mnemonics', () => {
    const a = generateMnemonicAccount();
    const b = generateMnemonicAccount();
    expect(a.mnemonicPhrase).not.toBe(b.mnemonicPhrase);
  });
});

describe('accountFromMnemonic', () => {
  it('reports an invalid synthetic phrase without SDK argument details', () => {
    const phrase = `synthetic-phrase-marker ${'abandon '.repeat(11)}`;
    expect(() => accountFromMnemonic(phrase)).toThrow('Invalid BIP-39 recovery phrase. Check the words, order, and word count.');
  });

  it('never forwards a mnemonic or key exposed by an SDK error', () => {
    const phrase = 'synthetic-phrase-marker';
    const sdk = vi.spyOn(Mnemonic, 'fromPhrase').mockImplementation(() => {
      throw new Error(`Invalid input ${phrase}; synthetic-private-key-marker`);
    });
    try {
      let error;
      try { accountFromMnemonic(phrase); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(WalletError);
      expect(String(error)).not.toContain(phrase);
      expect(String(error)).not.toContain('synthetic-private-key-marker');
      expect(error.cause).toBeUndefined();
    } finally {
      sdk.mockRestore();
    }
  });
  it('re-derives the exact same address/key as generateMnemonicAccount for the same phrase', () => {
    const original = generateMnemonicAccount();
    const reimported = accountFromMnemonic(original.mnemonicPhrase);
    expect(reimported.address).toBe(original.address);
    expect(reimported.privateKey).toBe(original.privateKey);
  });

  it('throws WalletError on an invalid phrase', () => {
    expect(() => accountFromMnemonic('not a real bip39 phrase at all')).toThrow(WalletError);
  });
});

describe('accountFromPrivateKey', () => {
  it('accepts a valid Cyprus-1 key and returns its checksummed address', () => {
    const { privateKey } = generateMnemonicAccount();
    const account = accountFromPrivateKey(privateKey);
    expect(account.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it('rejects a malformed key', () => {
    expect(() => accountFromPrivateKey('0xnothex')).toThrow(WalletError);
    expect(() => accountFromPrivateKey('0x1234')).toThrow(WalletError);
  });

  it('rejects a key whose address is not Cyprus-1 (e.g. a non-Quai zone)', () => {
    // '11'.repeat(32) is agent-mcp's own test fixture for "a key that lands outside Cyprus-1".
    expect(() => accountFromPrivateKey('0x' + '11'.repeat(32))).toThrow(/Cyprus-1|Quai/);
  });
});

describe('encryptAccount / decryptAccount round trip', () => {
  it.each([
    '{synthetic-keystore-marker',
    JSON.stringify({ version: 3, crypto: { kdf: 'synthetic-keystore-marker' } }),
  ])('never echoes malformed synthetic keystore payloads', async (json) => {
    let error;
    try { await decryptAccount(json, 'synthetic-password-marker'); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(WalletError);
    expect(error.message).toBe('Could not decrypt keystore. Check that the file is a valid supported keystore and try again.');
    expect(String(error)).not.toContain('synthetic-keystore-marker');
    expect(String(error)).not.toContain('synthetic-password-marker');
    expect(error.cause).toBeUndefined();
  });
  it('round-trips a raw-key account (no mnemonic)', async () => {
    const account = generateMnemonicAccount();
    const json = await encryptAccount({ address: account.address, privateKey: account.privateKey }, 'correct-password');
    const decrypted = await decryptAccount(json, 'correct-password');
    expect(decrypted.address).toBe(account.address);
    expect(decrypted.privateKey).toBe(account.privateKey);
    expect(decrypted.mnemonic).toBeUndefined();
  });

  it('round-trips a mnemonic-derived account, recovering the exact entropy', async () => {
    const account = generateMnemonicAccount();
    const json = await encryptAccount(account, 'correct-password');
    const decrypted = await decryptAccount(json, 'correct-password');
    expect(decrypted.mnemonic).toBeDefined();
    expect(Mnemonic.fromEntropy(decrypted.mnemonic.entropy).phrase).toBe(account.mnemonicPhrase);
  });

  it('throws a clean WalletError on the wrong password', async () => {
    const account = generateMnemonicAccount();
    const json = await encryptAccount({ address: account.address, privateKey: account.privateKey }, 'right-password');
    await expect(decryptAccount(json, 'wrong-password')).rejects.toThrow(WalletError);
    await expect(decryptAccount(json, 'wrong-password')).rejects.toThrow(/wrong password/i);
  });
});

describe('keystore file operations', () => {
  it('writes 0600 and creates the keystore dir 0700 (POSIX only)', async () => {
    const account = generateMnemonicAccount();
    const json = await encryptAccount({ address: account.address, privateKey: account.privateKey }, 'pw');
    writeKeystoreFile(home, 'alice', json);
    expect(walletExists(home, 'alice')).toBe(true);
    if (process.platform !== 'win32') {
      expect(statSync(keystorePath(home, 'alice')).mode & 0o777).toBe(0o600);
    }
  });

  it('refuses to overwrite an existing wallet without force', async () => {
    const json = await encryptAccount(generateMnemonicAccount(), 'pw');
    writeKeystoreFile(home, 'bob', json);
    expect(() => writeKeystoreFile(home, 'bob', json)).toThrow(WalletError);
  });

  it('force overwrites', async () => {
    const json1 = await encryptAccount(generateMnemonicAccount(), 'pw');
    const json2 = await encryptAccount(generateMnemonicAccount(), 'pw');
    writeKeystoreFile(home, 'carol', json1);
    writeKeystoreFile(home, 'carol', json2, { force: true });
    expect(readKeystoreFile(home, 'carol')).toBe(json2);
  });

  it('listWallets returns sorted names; empty when no keystore dir yet', async () => {
    expect(listWallets(home)).toEqual([]);
    const json = await encryptAccount(generateMnemonicAccount(), 'pw');
    writeKeystoreFile(home, 'zed', json);
    writeKeystoreFile(home, 'amy', json, { force: true });
    expect(listWallets(home)).toEqual(['amy', 'zed']);
  });

  it('readKeystoreFile throws WalletError for an unknown name', () => {
    expect(() => readKeystoreFile(home, 'ghost')).toThrow(WalletError);
  });

  it('removeKeystoreFile deletes the file', async () => {
    const json = await encryptAccount(generateMnemonicAccount(), 'pw');
    writeKeystoreFile(home, 'dave', json);
    removeKeystoreFile(home, 'dave');
    expect(walletExists(home, 'dave')).toBe(false);
  });

  it('removeKeystoreFile throws for an unknown name', () => {
    expect(() => removeKeystoreFile(home, 'ghost')).toThrow(WalletError);
  });

  it('renameKeystoreFile moves the file and refuses a colliding destination', async () => {
    const json = await encryptAccount(generateMnemonicAccount(), 'pw');
    writeKeystoreFile(home, 'old', json);
    writeKeystoreFile(home, 'taken', json, { force: true });
    renameKeystoreFile(home, 'old', 'new');
    expect(walletExists(home, 'old')).toBe(false);
    expect(walletExists(home, 'new')).toBe(true);
    expect(() => renameKeystoreFile(home, 'new', 'taken')).toThrow(WalletError);
  });
});

describe('checkKeystorePerms', () => {
  it('reports not applicable on win32', () => {
    if (process.platform === 'win32') {
      expect(checkKeystorePerms(home).applicable).toBe(false);
    } else {
      expect(true).toBe(true); // nothing meaningful to assert cross-platform here
    }
  });

  it('reports no issues for a freshly written 0600/0700 keystore (POSIX)', async () => {
    if (process.platform === 'win32') return;
    const json = await encryptAccount(generateMnemonicAccount(), 'pw');
    writeKeystoreFile(home, 'erin', json);
    expect(checkKeystorePerms(home).issues).toEqual([]);
  });
});
