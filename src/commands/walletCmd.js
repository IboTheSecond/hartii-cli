// packages/hartii-cli/src/commands/walletCmd.js
//
// `hartii wallet <subcommand>` — new, import mnemonic|key, list, use, address, export, rename,
// remove, lock-check. HARD RULE (the product spec ): "keys and mnemonics are NEVER printed except by
// `hartii wallet export` behind a typed confirmation" — so `wallet new`/`wallet import` deliberately
// do NOT echo the mnemonic/key they just created/imported, only the address, with a reminder to
// run `export` to back it up. `export` itself requires the caller to type the wallet's own name
// back (not just a y/N) — a plain `--yes` can never skip it; this is the one gate in the whole CLI
// that is intentionally NOT governed by the global --yes flag.
import { existsSync } from 'node:fs';
import { getAddress, Mnemonic } from 'quais';
import {createReceiveQr} from '../qr.js';
import {
  WalletError,
  assertValidWalletName,
  keystorePath,
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
} from '../keystore.js';
import { loadConfig, saveConfig } from '../config.js';
import { resolvePassword, readHiddenInput, readVisibleInput } from '../prompt.js';

function nextDefaultName(home) {
  const existing = new Set(listWallets(home));
  if (!existing.has('default')) return 'default';
  for (let i = 2; ; i += 1) {
    const candidate = `wallet${i}`;
    if (!existing.has(candidate)) return candidate;
  }
}

async function promptNewPassword(deps) {
  const env = deps.env || process.env;
  if (typeof env.HARTII_PASSWORD === 'string' && env.HARTII_PASSWORD !== '') {
    if (env.HARTII_PASSWORD.length < 8) throw new WalletError('New wallet password must be at least 8 characters.');
    return resolvePassword(deps);
  }
  const promptFn = deps.promptFn || readHiddenInput;
  const pw1 = await promptFn('New password: ', deps);
  if (pw1.length < 8) throw new WalletError('Password must be at least 8 characters.');
  const pw2 = await promptFn('Confirm password: ', deps);
  if (pw1 !== pw2) throw new WalletError('Passwords do not match.');
  return pw1;
}

/** Persists `account` under `name`, switching the config's currentWallet to it (see header: every new/imported wallet becomes the active one — a CLI with no other signal should pick the wallet you just made). */
async function persistAccount(home, name, account, deps) {
  assertValidWalletName(name);
  loadConfig(home); // refuse corrupted policy before encrypting/writing any wallet
  const password = await promptNewPassword(deps);
  // `deps.scrypt` is a TEST-ONLY override (see keystore.js's encryptAccount) — real usage never
  // sets it, so production wallets are always encrypted at the real cost.
  const json = await encryptAccount(account, password, { scrypt: deps.scrypt });
  loadConfig(home); // policy may have changed while encryption was running
  writeKeystoreFile(home, name, json);
  const cfg = loadConfig(home);
  saveConfig(home, { ...cfg, currentWallet: name });
  return { name, address: account.address };
}

/**
 * `wallet new [name]` — generates a fresh 12-word mnemonic, Quai HD path, first Cyprus-1 address.
 * @returns {Promise<{ name: string, address: string, reminder: string }>}
 */
export async function walletNew(home, name, deps = {}) {
  const resolvedName = name || nextDefaultName(home);
  if (walletExists(home, resolvedName)) throw new WalletError(`Wallet "${resolvedName}" already exists.`);
  const account = generateMnemonicAccount();
  const result = await persistAccount(home, resolvedName, account, deps);
  return { ...result, reminder: `Back up the recovery phrase now: run \`hartii wallet export ${result.name}\`. It is never shown automatically. Hartii CLI is BETA (not independently audited): start with small amounts.` };
}

/**
 * `wallet import mnemonic <phrase>` or `wallet import key <privateKey>`, optional trailing name.
 * @param {'mnemonic'|'key'} kind
 * @param {string} value
 * @param {string|undefined} name
 */
export async function walletImport(home, kind, value, name, deps = {}) {
  if (kind !== 'mnemonic' && kind !== 'key') throw new WalletError('Usage: hartii wallet import mnemonic "<phrase>" [name] | hartii wallet import key <privateKey> [name]');
  if (!value) throw new WalletError(`Usage: hartii wallet import ${kind} <${kind === 'mnemonic' ? 'phrase' : 'privateKey'}> [name]`);
  const resolvedName = name || nextDefaultName(home);
  if (walletExists(home, resolvedName)) throw new WalletError(`Wallet "${resolvedName}" already exists.`);
  const account = kind === 'mnemonic' ? accountFromMnemonic(value) : accountFromPrivateKey(value);
  const result = await persistAccount(home, resolvedName, account, deps);
  return { ...result, reminder: kind === 'mnemonic' ? `Back up the recovery phrase now: run \`hartii wallet export ${result.name}\`. It is never shown automatically. Hartii CLI is BETA (not independently audited): start with small amounts.` : undefined };
}

/** `wallet list` */
export function walletList(home) {
  const cfg = loadConfig(home);
  return listWallets(home).map((name) => {
    let address = null;
    try {
      address = publicKeystore(home, name).address;
    } catch {
      address = null;
    }
    return { name, address, current: name === cfg.currentWallet };
  });
}

/** `wallet use <name>` */
export function walletUse(home, name) {
  if (!walletExists(home, name)) throw new WalletError(`No wallet named "${name}". Run \`hartii wallet list\`.`);
  const cfg = loadConfig(home);
  saveConfig(home, { ...cfg, currentWallet: name });
  return { name };
}

/** `wallet address [--qr]` — resolves to the current wallet unless `name` is given. Never needs a password. */
export function walletAddress(home, name, opts = {}) {
  const cfg = loadConfig(home);
  const resolvedName = name || cfg.currentWallet;
  if (!resolvedName) throw new WalletError('No wallet selected. Run `hartii wallet new` or `hartii wallet use <name>`.');
  if (!walletExists(home, resolvedName)) throw new WalletError(`No wallet named "${resolvedName}".`);
  const { address } = publicKeystore(home, resolvedName);
  const result = { name: resolvedName, address };
  if (opts.qr) {
    result.qr=createReceiveQr(address);
    result.network=cfg.network;
    result.note='This QR contains the public address only. Verify the payer selects the intended network.';
  }
  return result;
}

/**
 * `wallet export <name>` — the ONLY place a private key or mnemonic is ever printed, and only
 * after the caller types the wallet's own name back (never short-circuited by --yes/--json).
 * @returns {Promise<{ name: string, address: string, privateKey: string, mnemonic?: string }>}
 */
export async function walletExport(home, name, deps = {}) {
  const cfg = loadConfig(home);
  const resolvedName = name || cfg.currentWallet;
  if (!resolvedName) throw new WalletError('No wallet selected. Pass a name: `hartii wallet export <name>`.');
  if (!walletExists(home, resolvedName)) throw new WalletError(`No wallet named "${resolvedName}".`);

  const confirmFn = deps.confirmTypedFn || readVisibleInput;
  const typed = await confirmFn(`Type "${resolvedName}" to confirm exporting its private key/mnemonic: `, deps);
  if (String(typed).trim() !== resolvedName) {
    throw new WalletError('Export cancelled — typed confirmation did not match the wallet name.');
  }

  const json = readKeystoreFile(home, resolvedName);
  const password = await resolvePassword({ ...deps, label: `Password for wallet "${resolvedName}": ` });
  const account = await decryptAccount(json, password);
  const result = { name: resolvedName, address: account.address, privateKey: account.privateKey };
  if (account.mnemonic) {
    // decryptKeystoreJson only ever returns the mnemonic's entropy, not its phrase (see
    // keystore.js's header note on the x-quais extension block) — rebuild the phrase from it.
    result.mnemonic = Mnemonic.fromEntropy(account.mnemonic.entropy).phrase;
  }
  return result;
}

/** `wallet rename <old> <new>` */
export function walletRename(home, oldName, newName) {
  if (!oldName || !newName) throw new WalletError('Usage: hartii wallet rename <old> <new>');
  assertValidWalletName(newName);
  const cfg = loadConfig(home);
  renameKeystoreFile(home, oldName, newName);
  if (cfg.currentWallet === oldName) saveConfig(home, { ...cfg, currentWallet: newName });
  return { oldName, newName };
}

/** `wallet remove <name>` — typed-name confirmation, same gate shape as export (destructive, not governed by --yes). */
export async function walletRemove(home, name, deps = {}) {
  if (!name) throw new WalletError('Usage: hartii wallet remove <name>');
  if (!walletExists(home, name)) throw new WalletError(`No wallet named "${name}".`);
  loadConfig(home); // refuse corrupted policy before destructive confirmation
  const confirmFn = deps.confirmTypedFn || readVisibleInput;
  const typed = await confirmFn(`Type "${name}" to confirm PERMANENTLY removing this wallet's local keystore file: `, deps);
  if (String(typed).trim() !== name) {
    throw new WalletError('Remove cancelled — typed confirmation did not match the wallet name.');
  }
  const cfg = loadConfig(home);
  removeKeystoreFile(home, name);
  if (cfg.currentWallet === name) saveConfig(home, { ...cfg, currentWallet: null });
  return { name, removed: true };
}

/** `wallet lock-check <name>` — confirms the keystore file is present, well-formed, and owner-only permissioned. Never needs a password. */
export function walletLockCheck(home, name) {
  const cfg = loadConfig(home);
  const resolvedName = name || cfg.currentWallet;
  if (!resolvedName) throw new WalletError('No wallet selected.');
  const p = keystorePath(home, resolvedName);
  if (!existsSync(p)) throw new WalletError(`No wallet named "${resolvedName}".`);
  const { data, address } = publicKeystore(home, resolvedName);
  const version3 = Number(data.version) === 3;
  const hasCrypto = Boolean(data.Crypto || data.crypto);
  const perms = checkKeystorePerms(home);
  return {
    name: resolvedName,
    address,
    encrypted: version3 && hasCrypto,
    permsOk: perms.applicable ? perms.issues.length === 0 : null,
    permissions: perms.applicable ? 'checked-posix-modes' : 'unverified-windows-acl',
  };
}

function publicKeystore(home, name) {
  try {
    const data = JSON.parse(readKeystoreFile(home, name));
    if (!data || typeof data !== 'object' || Array.isArray(data) || !/^(0x)?[0-9a-fA-F]{40}$/.test(data.address || '')) throw new Error('Invalid public address');
    return { data, address: getAddress('0x' + data.address.replace(/^0x/, '')) };
  } catch {
    throw new WalletError('Could not read a valid public keystore header. No secret was printed.');
  }
}
