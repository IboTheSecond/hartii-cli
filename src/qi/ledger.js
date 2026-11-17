// packages/hartii-cli/src/qi/ledger.js
// A small PUBLIC local file (addresses and amounts, no keys) so a fresh CLI process never reuses a Qi
// address: the node only shows UNSPENT notes, so an address that was paid and then spent looks unused.
// Lives at <home>/qi/<network>-<wallet>.json, 0600.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { securePath, secureDirectory, atomicPrivateWrite } from '../secureFiles.js';
import { CliError } from '../errors.js';

export class QiLedgerError extends CliError {}

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const today = (now = new Date()) => now.toISOString().slice(0, 10);

export function openQiLedger(home, network, walletName, { now = () => new Date() } = {}) {
  const dir = join(home, 'qi');
  const path = join(dir, `${network}-${String(walletName).replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
  let data = { version: 1, used: [], sent: { date: today(now()), qit: '0' } };
  try {
    const f = securePath(path, { regularFile: true });
    if (f.stat) {
      const parsed = JSON.parse(readFileSync(f.path, 'utf8'));
      if (!parsed || !Array.isArray(parsed.used) || !parsed.used.every((a) => ADDR.test(a))) throw new Error('bad');
      data = { version: 1, used: parsed.used.map((a) => a.toLowerCase()), sent: parsed.sent && /^\d+$/.test(parsed.sent.qit) ? parsed.sent : data.sent };
    }
  } catch {
    throw new QiLedgerError('The local Qi address list is damaged. Move it aside (it is only a cache of used addresses) and try again; nothing was sent.');
  }
  const used = new Set(data.used);
  const save = () => {
    secureDirectory(dir);
    atomicPrivateWrite(path, JSON.stringify({ version: 1, used: [...used], sent: data.sent }, null, 2) + '\n', { replace: true });
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
