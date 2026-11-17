// packages/hartii-cli/src/localVault.js
//
// Encryption at rest for the CLI's private local files: the spend ledger, the paid-recipient list, the contact
// book and the desk journal (the watchlist is deliberately NOT sealed, see tui/data.js).
//
// Design
//  - One random 32-byte DATA KEY per home (AES-256-GCM). Files are sealed with it, each bound to a PURPOSE
//    string as authenticated data, so a sealed file cannot be swapped into another role or another journal slot.
//  - The data key is stored only WRAPPED, in <home>/vault.json, one slot per wallet: each slot is the data key
//    encrypted (AES-256-GCM) under a key derived with scrypt from that wallet's password. Nothing in vault.json
//    reveals the key without a wallet password. A wrong password fails the GCM tag; a tampered slot or sealed
//    file fails closed with a plain error, never a silent reset.
//  - Unlocking happens ONCE per command, at the point the wallet password is already asked (see
//    commandContext.writeRuntime); read-only commands that need private data ask once (HARTII_PASSWORD honoured).
//    The unlocked key lives only in this process's memory.
//  - The vault only starts to exist the first time a keystore wallet password is entered for a command that
//    touches private data. Until then files stay plain (legacy) so a brand-new home needs no password to start.
//    When the vault is created, every existing plain file is sealed in the same step (atomic replace after a
//    decrypt round-trip check). No `.plain-backup` is kept: a plaintext copy next to the encrypted one would
//    defeat the encryption, and the replace is atomic and verified, so there is no half-written state to
//    recover from.
//  - Once vault.json exists, a PLAIN ledger/contacts/paid/journal file is refused ("downgrade"), so deleting the
//    encrypted ledger and planting a plain one cannot reset spend tracking.
//  - A second wallet is enrolled automatically when its password also opens an existing slot (same password);
//    otherwise it needs `enrollWallet` with both passwords. Known limit: replacing a sealed file with an OLDER
//    sealed copy is not detectable (no counter); local caps stop mistakes, not malware, and are documented so.
import { randomBytes, scrypt, createCipheriv, createDecipheriv } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve, relative, sep } from 'node:path';
import { CliError } from './errors.js';
import { securePath, atomicPrivateWrite, secureDirectory } from './secureFiles.js';

export class VaultError extends CliError {}

const VAULT_FORMAT = 'hartii-vault/v1';
const SEALED_FORMAT = 'hartii-sealed/v1';
const DEFAULT_N = 2 ** 15;
const MIN_N = 2 ** 14;
const MAX_N = 2 ** 20;
const KEYS = new Map(); // resolved home -> Buffer(32)

const homeKey = home => resolve(home);
export const vaultPath = home => join(home, 'vault.json');
export const SEALED_PURPOSES = Object.freeze({ spend: 'spend', paid: 'paid', contacts: 'contacts' });
export const deskPurpose = (home, file) => 'desk:' + relative(resolve(home), resolve(file)).split(sep).join('/');

const kdf = (password, salt, N) => new Promise((ok, fail) => scrypt(Buffer.from(String(password), 'utf8'), salt, 32, { N, r: 8, p: 1, maxmem: 256 * N * 8 + (1 << 20) }, (e, k) => (e ? fail(e) : ok(k))));
function gcmSeal(key, aad, plain) {
  const nonce = randomBytes(12), c = createCipheriv('aes-256-gcm', key, nonce);
  c.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  return { nonce: nonce.toString('base64'), ct: ct.toString('base64') };
}
function gcmOpen(key, aad, nonceB64, ctB64) {
  const nonce = Buffer.from(String(nonceB64), 'base64'), all = Buffer.from(String(ctB64), 'base64');
  if (nonce.length !== 12 || all.length < 16) throw new Error('shape');
  const d = createDecipheriv('aes-256-gcm', key, nonce);
  d.setAAD(Buffer.from(aad, 'utf8')); d.setAuthTag(all.subarray(all.length - 16));
  return Buffer.concat([d.update(all.subarray(0, all.length - 16)), d.final()]);
}

export function vaultExists(home) {
  try { return securePath(vaultPath(home), { regularFile: true }).stat !== null; }
  catch { throw new VaultError('The local data vault path is unsafe. Nothing was read.'); }
}
export const isUnlocked = home => KEYS.has(homeKey(home));
/** Forget the in-memory key (tests, or a long-running host that wants to re-lock). */
export function lockVault(home) { const k = KEYS.get(homeKey(home)); if (k) k.fill(0); KEYS.delete(homeKey(home)); }

function readVault(home) {
  let doc;
  try { doc = JSON.parse(readFileSync(securePath(vaultPath(home), { regularFile: true }).path, 'utf8')); }
  catch { throw new VaultError('The local data vault is unreadable or damaged. Nothing was decrypted and nothing was reset.'); }
  const slotOk = s => s && typeof s.wallet === 'string' && ['salt', 'nonce', 'wrapped'].every(k => typeof s[k] === 'string');
  if (doc?.format !== VAULT_FORMAT || doc.kdf?.name !== 'scrypt' || !Number.isInteger(doc.kdf.N) || doc.kdf.N < MIN_N || doc.kdf.N > MAX_N
    || !Array.isArray(doc.slots) || doc.slots.length === 0 || !doc.slots.every(slotOk)) throw new VaultError('The local data vault has an unsupported or tampered format. Nothing was decrypted and nothing was reset.');
  return doc;
}
const writeVault = (home, doc, replace) => atomicPrivateWrite(vaultPath(home), JSON.stringify(doc, null, 2) + '\n', { replace });

async function makeSlot(wallet, password, dataKey, N) {
  const salt = randomBytes(16), kek = await kdf(password, salt, N);
  try { return { wallet, salt: salt.toString('base64'), ...(({ nonce, ct }) => ({ nonce, wrapped: ct }))(gcmSeal(kek, `hartii-vault-slot:${wallet}`, dataKey)) }; }
  finally { kek.fill(0); }
}
async function openSlot(slot, password, N) {
  const kek = await kdf(password, Buffer.from(slot.salt, 'base64'), N);
  try { return gcmOpen(kek, `hartii-vault-slot:${slot.wallet}`, slot.nonce, slot.wrapped); } catch { return null; } finally { kek.fill(0); }
}

/** Create the vault for a home (first keystore password use), then seal every existing plain private file. */
export async function createVault(home, { wallet, password, kdfN = DEFAULT_N } = {}) {
  if (typeof wallet !== 'string' || !wallet || typeof password !== 'string' || !password) throw new VaultError('A wallet name and password are required to create the local data vault.');
  if (vaultExists(home)) throw new VaultError('A local data vault already exists for this home.');
  secureDirectory(home);
  const dataKey = randomBytes(32);
  const slot = await makeSlot(wallet, password, dataKey, kdfN);
  writeVault(home, { format: VAULT_FORMAT, kdf: { name: 'scrypt', N: kdfN, r: 8, p: 1 }, slots: [slot] }, false);
  KEYS.set(homeKey(home), dataKey);
  migratePlainFiles(home);
  return { created: true };
}

/** Unlock with a wallet's password. A wallet with no slot is enrolled when its password opens any existing slot. */
export async function unlockVault(home, { wallet, password } = {}) {
  if (isUnlocked(home)) return { unlocked: true };
  const doc = readVault(home), N = doc.kdf.N;
  const own = doc.slots.find(s => s.wallet === wallet);
  let dataKey = own ? await openSlot(own, password, N) : null;
  if (!dataKey && !own) {
    for (const slot of doc.slots) { dataKey = await openSlot(slot, password, N); if (dataKey) break; }
    if (dataKey) { doc.slots.push(await makeSlot(wallet, password, dataKey, N)); writeVault(home, doc, true); }
  }
  if (!dataKey) throw new VaultError(own
    ? 'Wrong password for the local data vault.'
    : `Wallet "${wallet}" is not enrolled in the local data vault and its password opens no existing entry. Run: hartii vault enroll ${wallet}`);
  KEYS.set(homeKey(home), dataKey);
  return { unlocked: true };
}

/** Add `wallet` to the vault using a password that already opens an enrolled wallet. */
export async function enrollWallet(home, { existingPassword, wallet, password } = {}) {
  const doc = readVault(home), N = doc.kdf.N;
  let dataKey = null;
  for (const slot of doc.slots) { dataKey = await openSlot(slot, existingPassword, N); if (dataKey) break; }
  if (!dataKey) throw new VaultError('That password does not open the local data vault.');
  doc.slots = doc.slots.filter(s => s.wallet !== wallet);
  doc.slots.push(await makeSlot(wallet, password, dataKey, N)); writeVault(home, doc, true);
  KEYS.set(homeKey(home), dataKey);
  return { enrolled: true };
}

/**
 * The single entry point commands use. No vault + create:false -> nothing (plain mode). Vault present -> unlock
 * with the wallet password. No vault + create:true -> verify the password against the keystore, then create.
 * @param {string} home
 * @param {{ wallet?: string, getPassword: ()=>Promise<string>, verifyPassword?: (pw:string)=>Promise<void>, create?: boolean, kdfN?: number }} o
 */
export async function ensureUnlocked(home, { wallet, getPassword, verifyPassword, create = false, kdfN } = {}) {
  if (isUnlocked(home)) return { unlocked: true };
  const exists = vaultExists(home);
  if (!exists && !create) return { unlocked: false, plain: true };
  if (!wallet) throw new VaultError(exists ? 'Pick the wallet whose password unlocks your local data (--wallet <name>).' : 'Create a wallet first: its password protects your local data.');
  const password = await getPassword();
  if (exists) { await unlockVault(home, { wallet, password }); return { unlocked: true }; }
  if (verifyPassword) await verifyPassword(password);
  await createVault(home, { wallet, password, kdfN });
  return { unlocked: true, created: true };
}

const isEnvelope = text => { try { const j = JSON.parse(text); return j && j.format === SEALED_FORMAT ? j : null; } catch { return null; } };

/** Seal text for `purpose`. With no vault the text is returned unchanged (legacy plain mode). */
export function seal(home, purpose, text) {
  if (!vaultExists(home)) return text;
  const key = KEYS.get(homeKey(home));
  if (!key) throw new VaultError('Local data is locked. Run the command again and enter the wallet password.');
  return JSON.stringify({ format: SEALED_FORMAT, ...gcmSeal(key, `hartii-sealed:${purpose}`, Buffer.from(text, 'utf8')) }) + '\n';
}
/** Open text for `purpose`. A plain file is only accepted while no vault exists. */
export function unseal(home, purpose, text, { allowPlain = false } = {}) {
  const env = isEnvelope(text);
  if (!env) {
    if (vaultExists(home) && !allowPlain) throw new VaultError('A private file is plain text although the local data vault exists. It was refused as a possible downgrade; nothing was reset.');
    return text;
  }
  const key = KEYS.get(homeKey(home));
  if (!key) throw new VaultError('Local data is locked. Run the command again and enter the wallet password.');
  try { return gcmOpen(key, `hartii-sealed:${purpose}`, env.nonce, env.ct).toString('utf8'); }
  catch { throw new VaultError('A private local file failed its integrity check (damaged or tampered). It was not used and nothing was reset.'); }
}

function privateFiles(home) {
  const out = [{ path: join(home, 'spend.json'), purpose: SEALED_PURPOSES.spend }, { path: join(home, 'paid.json'), purpose: SEALED_PURPOSES.paid }, { path: join(home, 'contacts.json'), purpose: SEALED_PURPOSES.contacts }];
  const root = join(home, 'desk', 'mainnet');
  try {
    for (const day of readdirSync(root)) {
      if (!/^\d{8}$/.test(day)) continue;
      for (const name of readdirSync(join(root, day))) if (/^\d{8}-[a-f0-9]{64}\.json$/.test(name)) { const path = join(root, day, name); out.push({ path, purpose: deskPurpose(home, path) }); }
    }
  } catch { /* no journal yet */ }
  return out;
}
/** Seal every plain private file once. Parse-free: the text is wrapped as-is, verified, then atomically replaced. */
export function migratePlainFiles(home) {
  let migrated = 0;
  for (const { path, purpose } of privateFiles(home)) {
    const checked = securePath(path, { regularFile: true });
    if (!checked.stat) continue;
    const text = readFileSync(checked.path, 'utf8');
    if (isEnvelope(text)) continue;
    const sealed = seal(home, purpose, text);
    if (unseal(home, purpose, sealed) !== text) throw new VaultError('Sealing a private file did not round-trip; the original was left untouched.');
    atomicPrivateWrite(checked.path, sealed, { replace: true }); migrated++;
  }
  return migrated;
}

/** Read a private file as text (sealed or legacy plain). Returns null when it does not exist. */
export function readPrivateText(home, purpose, path) {
  const checked = securePath(path, { regularFile: true });
  if (!checked.stat) return null;
  return unseal(home, purpose, readFileSync(checked.path, 'utf8'));
}
export function writePrivateText(home, purpose, path, text, { replace = true } = {}) {
  atomicPrivateWrite(path, seal(home, purpose, text), { replace });
}
