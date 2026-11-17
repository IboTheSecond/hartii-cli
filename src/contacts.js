// packages/hartii-cli/src/contacts.js
//
// Local contact book + the list of addresses this machine has paid. Both are private local files, sealed with the
// wallet password once the local data vault exists (localVault.js). Names never leave this machine.
//
//  - contacts.json  { v:1, contacts: { <lowercase name>: { name, address, addedAt } } }
//  - paid.json      { v:1, chains: { <chainId>: { <lowercase address>: { firstAt, lastAt, count } } } }
//
// The paid list is written ONLY after a confirmed receipt (status 1), so a failed or unclear send never makes a
// recipient look trusted. Look-alike detection (address poisoning): same first 4 and last 4 hex characters as a
// saved contact or a previously paid address, but a different address.
import { join } from 'node:path';
import { assertCyprus1QuaiAddress } from './address.js';
import { CliError } from './errors.js';
import { securePath, secureDirectory } from './secureFiles.js';
import { readPrivateText, writePrivateText, SEALED_PURPOSES, VaultError } from './localVault.js';

export class ContactError extends CliError {}

export const contactsPath = home => join(home, 'contacts.json');
export const paidPath = home => join(home, 'paid.json');
/** True when a contact book exists on disk (sealed or plain). Lets callers skip a password prompt when there is nothing to read. */
export const hasContactsFile = home => { try { return securePath(contactsPath(home), { regularFile: true }).stat !== null; } catch { return true; } };
const MAX_CONTACTS = 500;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,30}$/;
const RESERVED = new Set(['all', 'quai', 'wquai', 'self', 'me']);
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const wrapVault = fn => { try { return fn(); } catch (error) { if (error instanceof VaultError) throw new ContactError(error.message); throw error; } };

/** A contact name is a label, never something that could pass for an address or a token ticker. */
export function validateContactName(raw) {
  const name = String(raw ?? '').trim().replace(/\s+/g, ' ');
  if (!NAME_RE.test(name)) throw new ContactError('A contact name is 1 to 31 characters: letters, digits, spaces, dot, dash or underscore, starting with a letter or digit.');
  if (/^0x/i.test(name) || /^[0-9a-f]{8,}$/i.test(name)) throw new ContactError('A contact name must not look like an address.');
  if (/^[A-Z]{2,6}$/.test(name) || RESERVED.has(name.toLowerCase())) throw new ContactError('A contact name must not look like a token ticker (for example QUAI or USDC). Use a person or shop name.');
  return name;
}

function readJson(home, purpose, path, fallback) {
  return wrapVault(() => {
    const text = readPrivateText(home, purpose, path);
    if (text === null) return fallback();
    try { const doc = JSON.parse(text); if (doc?.v !== 1 || !object(doc)) throw new Error(); return doc; }
    catch { throw new ContactError(`${path} is damaged. It was not changed; restore it from a backup or move it aside.`); }
  });
}
function writeJson(home, purpose, path, doc) {
  wrapVault(() => { secureDirectory(home); writePrivateText(home, purpose, path, JSON.stringify(doc, null, 2) + '\n', { replace: true }); });
}

export function loadContacts(home) {
  const doc = readJson(home, SEALED_PURPOSES.contacts, contactsPath(home), () => ({ v: 1, contacts: {} }));
  if (!object(doc.contacts)) throw new ContactError(`${contactsPath(home)} is damaged. It was not changed.`);
  return Object.values(doc.contacts).map(c => ({ name: c.name, address: c.address, addedAt: c.addedAt })).sort((a, b) => a.name.localeCompare(b.name));
}
function saveContacts(home, list) {
  writeJson(home, SEALED_PURPOSES.contacts, contactsPath(home), { v: 1, contacts: Object.fromEntries(list.map(c => [c.name.toLowerCase(), c])) });
}

export function addContact(home, rawName, rawAddress, { now = new Date() } = {}) {
  const name = validateContactName(rawName);
  let address;
  try { address = assertCyprus1QuaiAddress(rawAddress); }
  catch (error) { throw new ContactError(`Cannot save this contact: ${error.message}`); }
  const list = loadContacts(home);
  if (list.length >= MAX_CONTACTS) throw new ContactError(`The contact book holds at most ${MAX_CONTACTS} contacts.`);
  if (list.some(c => c.name.toLowerCase() === name.toLowerCase())) throw new ContactError(`A contact named "${name}" already exists. Pick another name or remove it first.`);
  const same = list.find(c => c.address.toLowerCase() === address.toLowerCase());
  if (same) throw new ContactError(`That address is already saved as "${same.name}".`);
  const lookalike = lookalikeOf(address, knownAddresses(home, null, list));
  list.push({ name, address, addedAt: now.toISOString() });
  saveContacts(home, list);
  return { name, address, lookalike };
}
export function removeContact(home, rawName) {
  const list = loadContacts(home), key = String(rawName ?? '').trim().toLowerCase();
  const found = list.find(c => c.name.toLowerCase() === key);
  if (!found) throw new ContactError(`No contact named "${rawName}".`);
  saveContacts(home, list.filter(c => c !== found));
  return found;
}
export function renameContact(home, rawOld, rawNew) {
  const list = loadContacts(home), key = String(rawOld ?? '').trim().toLowerCase();
  const found = list.find(c => c.name.toLowerCase() === key);
  if (!found) throw new ContactError(`No contact named "${rawOld}".`);
  const name = validateContactName(rawNew);
  if (list.some(c => c !== found && c.name.toLowerCase() === name.toLowerCase())) throw new ContactError(`A contact named "${name}" already exists.`);
  found.name = name;
  saveContacts(home, list);
  return found;
}
/** Returns the saved contact for a name (case-insensitive), or null. Never matches an address string. */
export function findContactByName(home, raw) {
  const key = String(raw ?? '').trim().toLowerCase();
  if (!key || /^0x/.test(key)) return null;
  return loadContacts(home).find(c => c.name.toLowerCase() === key) || null;
}
export function findContactByAddress(home, address) {
  const key = String(address ?? '').toLowerCase();
  return loadContacts(home).find(c => c.address.toLowerCase() === key) || null;
}

// ---- paid list ---------------------------------------------------------------------------------------------
function loadPaidDoc(home) {
  const doc = readJson(home, SEALED_PURPOSES.paid, paidPath(home), () => ({ v: 1, chains: {} }));
  if (!object(doc.chains)) throw new ContactError(`${paidPath(home)} is damaged. It was not changed.`);
  return doc;
}
export function paidAddresses(home, chainId) {
  const chain = loadPaidDoc(home).chains[String(chainId)];
  return object(chain) ? Object.keys(chain) : [];
}
export function hasPaid(home, chainId, address) {
  return paidAddresses(home, chainId).includes(String(address).toLowerCase());
}
/** Call only after a confirmed receipt with status 1. */
export function recordPaid(home, chainId, address, { now = new Date() } = {}) {
  const doc = loadPaidDoc(home), key = String(chainId), a = assertCyprus1QuaiAddress(address).toLowerCase();
  const chain = doc.chains[key] = object(doc.chains[key]) ? doc.chains[key] : {};
  const old = chain[a];
  chain[a] = { firstAt: old?.firstAt ?? now.toISOString(), lastAt: now.toISOString(), count: (old?.count ?? 0) + 1 };
  writeJson(home, SEALED_PURPOSES.paid, paidPath(home), doc);
}

// ---- look-alike (address poisoning) ----------------------------------------------------------------------
/** [{ address, label }] of every address the user already trusts on this chain. */
export function knownAddresses(home, chainId, contacts = loadContacts(home)) {
  const out = contacts.map(c => ({ address: c.address, label: `your contact "${c.name}"` }));
  if (chainId !== null) for (const a of paidAddresses(home, chainId)) out.push({ address: a, label: 'an address you paid before' });
  return out;
}
const hex = a => String(a).toLowerCase().replace(/^0x/, '');
/** First 4 and last 4 hex characters match a known address but the address differs. */
export function lookalikeOf(address, known) {
  const h = hex(address);
  if (h.length !== 40) return null;
  return known.find(k => hex(k.address) !== h && hex(k.address).slice(0, 4) === h.slice(0, 4) && hex(k.address).slice(-4) === h.slice(-4)) || null;
}
export const lastFour = address => String(address).slice(-4).toLowerCase();

