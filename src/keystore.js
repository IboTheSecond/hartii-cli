// packages/hartii-cli/src/keystore.js
//
// Keys only ever live in an encrypted keystore (quais keystore v3, scrypt KDF) under
// `<HARTII_HOME>/keystore/<name>.json`, 0600 (best-effort on Windows — see config.js's identical
// note). `encryptKeystoreJson`/`decryptKeystoreJson` are the exact functions `Wallet.encrypt`/
// `Wallet.fromEncryptedJson` call internally (see node_modules/quais/lib/commonjs/wallet/
// wallet.js) — called directly here (not through the Wallet class) only so a mnemonic-derived
// wallet's recovery phrase can be embedded in the SAME v3 file via quais' own `x-quais` extension
// block (account.mnemonic = {path, locale, entropy}), rather than kept in a second, unencrypted
// place. A raw-private-key import has no mnemonic to embed — same file format, that field absent.
//
// This module never prints a private key or mnemonic phrase — every function here returns them to
// its caller (the `wallet` command layer), which is responsible for the loud, explicit `export`
// confirmation gate (see commands/walletCmd.js). Nothing in this file logs.
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync, readdirSync, unlinkSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { encryptKeystoreJson, decryptKeystoreJson, Mnemonic, QuaiHDWallet, Zone, randomBytes, computeAddress, getAddress } from 'quais';
import { assertCyprus1QuaiAddress } from './address.js';
import { CliError } from './errors.js';

export class WalletError extends CliError {}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Rejects anything that isn't a safe, simple filename component — defense against path traversal via a wallet name. */
export function assertValidWalletName(name) {
  if (!NAME_RE.test(String(name || ''))) {
    throw new WalletError(`"${name}" is not a valid wallet name (letters, digits, "-", "_", starting with a letter/digit, max 64 chars).`);
  }
  return name;
}

export function keystoreDir(home) {
  return join(home, 'keystore');
}

export function keystorePath(home, name) {
  assertValidWalletName(name);
  return join(keystoreDir(home), `${name}.json`);
}

/** @returns {string[]} wallet names, sorted — the ".json" extension stripped. */
export function listWallets(home) {
  const dir = keystoreDir(home);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length))
    .filter((n) => NAME_RE.test(n))
    .sort();
}

export function walletExists(home, name) {
  return existsSync(keystorePath(home, name));
}

/** BIP44 external-chain path for the given account/index — informational only (see header note: decrypt never re-derives from this). */
function bip44Path(account, index) {
  return `m/44'/994'/${account}'/0/${index}`;
}

/**
 * Generates a fresh 12-word BIP-39 mnemonic, derives the Quai HD path, and grinds to the first
 * address that lands in the Cyprus-1 zone (see address.js's isCyprus1QuaiAddress — the only zone
 * Hartii operates in). Pure/local — never touches the network or the filesystem.
 * @returns {{ address: string, privateKey: string, mnemonicPhrase: string, path: string, entropy: string }}
 */
export function generateMnemonicAccount() {
  const mnemonic = Mnemonic.fromEntropy(randomBytes(16)); // 16 bytes -> 12 words
  const hd = QuaiHDWallet.fromMnemonic(mnemonic);
  const info = hd.getNextAddressSync(0, Zone.Cyprus1);
  const privateKey = hd.getPrivateKey(info.address);
  return {
    address: getAddress(info.address),
    privateKey,
    mnemonicPhrase: mnemonic.phrase,
    path: bip44Path(info.account, info.index),
    entropy: mnemonic.entropy,
  };
}

/**
 * Derives the same first-Cyprus-1-address account from an EXISTING mnemonic phrase (import flow).
 * @param {string} phrase a 12/15/18/21/24-word BIP-39 phrase
 * @throws {WalletError} if the phrase fails BIP-39 checksum/wordlist validation
 */
export function accountFromMnemonic(phrase) {
  try {
    const mnemonic = Mnemonic.fromPhrase(String(phrase || '').trim());
    const hd = QuaiHDWallet.fromMnemonic(mnemonic);
    const info = hd.getNextAddressSync(0, Zone.Cyprus1);
    const privateKey = hd.getPrivateKey(info.address);
    return {
      address: getAddress(info.address),
      privateKey,
      mnemonicPhrase: mnemonic.phrase,
      path: bip44Path(info.account, info.index),
      entropy: mnemonic.entropy,
    };
  } catch {
    // SDK errors can include their input arguments. Never forward a recovery phrase,
    // derived key, or the original error as a cause to CLI/MCP output.
    throw new WalletError('Invalid BIP-39 recovery phrase. Check the words, order, and word count.');
  }
}

/**
 * Validates a raw private key import: well-formed 32-byte hex, and its derived address must be a
 * Cyprus-1 Quai-ledger address (see address.js) — a key for any other zone/ledger is refused
 * outright rather than silently accepted and unusable everywhere else in this CLI.
 * @param {string} privateKey 0x-prefixed 32-byte hex
 */
export function accountFromPrivateKey(privateKey) {
  const key = String(privateKey || '').trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new WalletError('Private key must be a 0x-prefixed 32-byte (64 hex char) value.');
  }
  let address;
  try {
    address = computeAddress(key);
  } catch {
    throw new WalletError('That is not a valid private key.');
  }
  assertCyprus1QuaiAddress(address); // throws WalletError-compatible AddressError with a specific reason
  return { address: getAddress(address), privateKey: key };
}

/**
 * Encrypts `account` (`{address, privateKey, mnemonicPhrase?, path?, entropy?}`) into a keystore v3
 * JSON string. Scrypt params default to quais' own (N=2^17) — the same cost `Wallet.encrypt`
 * uses — and are only ever overridden by `opts.scrypt` in tests (a real wallet must never be
 * encrypted at a weaker cost than the default).
 * @param {{address:string, privateKey:string, mnemonicPhrase?:string, path?:string, entropy?:string}} account
 * @param {string} password
 * @param {{ scrypt?: { N?: number, r?: number, p?: number } }} [opts] test-only KDF override
 * @returns {Promise<string>}
 */
export async function encryptAccount(account, password, opts = {}) {
  if (!password) throw new WalletError('A password is required to encrypt a wallet.');
  const keystoreAccount = { address: account.address, privateKey: account.privateKey };
  if (account.mnemonicPhrase) {
    keystoreAccount.mnemonic = { path: account.path, locale: 'en', entropy: account.entropy };
  }
  return encryptKeystoreJson(keystoreAccount, password, opts.scrypt ? { scrypt: opts.scrypt } : undefined);
}

/**
 * Decrypts a keystore v3 JSON string. Throws WalletError (never a raw quais AssertionError) on a
 * wrong password so command layers can print one consistent "wrong password" message.
 * @param {string} json
 * @param {string} password
 * @returns {Promise<{address:string, privateKey:string, mnemonic?:{path:string,locale:string,entropy:string}}>}
 */
export async function decryptAccount(json, password) {
  try {
    return await decryptKeystoreJson(json, password);
  } catch (err) {
    if (/incorrect password/i.test(err?.message || '')) {
      throw new WalletError('Wrong password.');
    }
    // Malformed JSON/KDF errors may echo the file contents or sensitive SDK arguments.
    throw new WalletError('Could not decrypt keystore. Check that the file is a valid supported keystore and try again.');
  }
}

/**
 * Writes an encrypted keystore JSON string to `<home>/keystore/<name>.json`, 0600, creating the
 * keystore directory (0700) if needed. Refuses to overwrite an existing wallet unless `force`.
 * @param {string} home
 * @param {string} name
 * @param {string} json
 * @param {{ force?: boolean }} [opts]
 */
export function writeKeystoreFile(home, name, json, opts = {}) {
  const dir = keystoreDir(home);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const p = keystorePath(home, name);
  if (!opts.force && existsSync(p)) {
    throw new WalletError(`Wallet "${name}" already exists. Use a different name, or \`wallet remove ${name}\` first.`);
  }
  writeFileSync(p, json, { mode: 0o600 });
  try {
    chmodSync(p, 0o600);
  } catch {
    // best-effort (Windows) — see config.js's identical note
  }
}

/** @returns {string} the raw keystore JSON text. @throws {WalletError} if the wallet does not exist. */
export function readKeystoreFile(home, name) {
  const p = keystorePath(home, name);
  if (!existsSync(p)) throw new WalletError(`No wallet named "${name}". Run \`wallet list\` to see what's available.`);
  return readFileSync(p, 'utf8');
}

export function removeKeystoreFile(home, name) {
  const p = keystorePath(home, name);
  if (!existsSync(p)) throw new WalletError(`No wallet named "${name}".`);
  unlinkSync(p);
}

export function renameKeystoreFile(home, oldName, newName) {
  const oldPath = keystorePath(home, oldName);
  const newPath = keystorePath(home, newName);
  if (!existsSync(oldPath)) throw new WalletError(`No wallet named "${oldName}".`);
  if (existsSync(newPath)) throw new WalletError(`A wallet named "${newName}" already exists.`);
  renameSync(oldPath, newPath);
}

/**
 * Best-effort permission check for `doctor` — on POSIX, flags a keystore file/dir that is
 * group/world-readable; on Windows (which ignores POSIX modes) always reports `null` (not
 * applicable) rather than a false alarm.
 * @param {string} home
 * @returns {{ applicable: boolean, issues: string[] }}
 */
export function checkKeystorePerms(home) {
  if (process.platform === 'win32') return { applicable: false, issues: [] };
  const dir = keystoreDir(home);
  const issues = [];
  if (existsSync(dir)) {
    const dirMode = statSync(dir).mode & 0o777;
    if (dirMode & 0o077) issues.push(`${dir} is readable by group/other (mode ${dirMode.toString(8)}).`);
    for (const name of listWallets(home)) {
      const p = keystorePath(home, name);
      const fileMode = statSync(p).mode & 0o777;
      if (fileMode & 0o077) issues.push(`${p} is readable by group/other (mode ${fileMode.toString(8)}).`);
    }
  }
  return { applicable: true, issues };
}
