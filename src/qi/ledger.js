// packages/hartii-cli/src/qi/ledger.js
// A small local file (addresses and amounts, no keys) so a fresh CLI process never reuses a Qi address: the node
// only shows UNSPENT notes, so an address that was paid and then spent looks unused. It also holds the Qi daily total
// and (for payment-code sends) the recipient-side one-time addresses, so it is sealed with the same local data vault as
// the spend ledger, paid list and contacts (R3-F5). Without a vault (brand-new home) it stays plain, like they do.
// Lives at <home>/qi/<network>-<wallet>.json, 0600, written atomically, merged on save.
import { join } from 'node:path';
import { secureDirectory } from '../secureFiles.js';
import { readPrivateText, writePrivateText, vaultExists, isUnlocked, qiPurpose, VaultError } from '../localVault.js';
import { CliError } from '../errors.js';

export class QiLedgerError extends CliError {}

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const today = (now = new Date()) => now.toISOString().slice(0, 10);
const ledgerPath = (home, network, walletName) => join(home, 'qi', `${network}-${String(walletName).replace(/[^A-Za-z0-9_-]/g, '_')}.json`);

/** Read-only peek that never needs a password: `{ locked: true }` while a vault protects the file and it is not unlocked. */
export function peekQiLedger(home, network, walletName) {
  if (vaultExists(home) && !isUnlocked(home)) return { locked: true };
  const path = ledgerPath(home, network, walletName);
  try {
    const text = readPrivateText(home, qiPurpose(home, path), path);
    if (text === null) return { locked: false, used: 0, sentQit: '0' };
    const parsed = JSON.parse(text);
    return { locked: false, used: Array.isArray(parsed.used) ? parsed.used.length : 0, sentQit: String(parsed.sent?.qit ?? '0') };
  } catch { return { locked: false, damaged: true }; }
}

export function openQiLedger(home, network, walletName, { now = () => new Date() } = {}) {
  const dir = join(home, 'qi');
  const path = ledgerPath(home, network, walletName);
  const purpose = qiPurpose(home, path);
  let data = { version: 1, used: [], sent: { date: today(now()), qit: '0' } };
  const load = () => { const text = readPrivateText(home, purpose, path); return text === null ? null : JSON.parse(text); };
  try {
    const parsed = load();
    if (parsed) {
      if (!Array.isArray(parsed.used) || !parsed.used.every((a) => ADDR.test(a))) throw new Error('bad');
      data = { version: 1, used: parsed.used.map((a) => a.toLowerCase()), sent: parsed.sent && /^\d+$/.test(parsed.sent.qit) ? parsed.sent : data.sent };
    }
  } catch (error) {
    if (error instanceof VaultError) throw error; // locked or tampered: fail closed, never reset
    throw new QiLedgerError('The local Qi address list is damaged. Move it aside (it is only a cache of used addresses) and try again; nothing was sent.');
  }
  const used = new Set(data.used);
  const save = () => {
    secureDirectory(dir);
    // Merge on save: another process may have added addresses since we opened; never drop them.
    try {
      const disk = load();
      if (disk?.used) for (const a of disk.used) if (ADDR.test(a)) used.add(String(a).toLowerCase());
    } catch (error) { if (error instanceof VaultError) throw error; }
    writePrivateText(home, purpose, path, JSON.stringify({ version: 1, used: [...used], sent: data.sent }, null, 2) + '\n');
  };
  return {
    path,
    has: (a) => used.has(String(a).toLowerCase()),
    add(addresses) {
      let changed = false;
      for (const a of addresses) { const k = String(a).toLowerCase(); if (ADDR.test(k) && !used.has(k)) { used.add(k); changed = true; } }
      if (changed) save();
    },
    sentToday() {
      return data.sent.date === today(now()) ? BigInt(data.sent.qit) : 0n;
    },
    addSent(qit) {
      const d = today(now());
      data.sent = { date: d, qit: String((data.sent.date === d ? BigInt(data.sent.qit) : 0n) + BigInt(qit)) };
      save();
    },
  };
}
