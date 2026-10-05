// Local accident-prevention caps. Every write holds the home-wide lock through its receipt.
// Unknown submissions retain durable reservations; only status 1 records confirmed spend.
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, unlinkSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseQuai } from 'quais';
import { CliError } from './errors.js';
export class SpendGuardError extends CliError {}
export const ledgerPath = home => join(home, 'spend.json');
const todayUtc = (now = new Date()) => now.toISOString().slice(0, 10);
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const uintText = x => typeof x === 'string' && /^\d+$/.test(x);
function amount(value) {
  try { const result = BigInt(value); if (result >= 0n) return result; } catch {}
  throw new SpendGuardError('Spend amount must be a nonnegative integer in wei.');
}
function loadLedger(home) {
  const path = ledgerPath(home);
  if (!existsSync(path)) return {};
  try {
    const ledger = JSON.parse(readFileSync(path, 'utf8'));
    if (!object(ledger)) throw new Error();
    for (const [address, entry] of Object.entries(ledger)) {
      if (!/^0x[0-9a-f]{40}$/.test(address) || !object(entry) || !/^\d{4}-\d{2}-\d{2}$/.test(entry.date) || !uintText(entry.spentWei)) throw new Error();
      if (entry.reservations !== undefined) {
        if (!object(entry.reservations)) throw new Error();
        for (const r of Object.values(entry.reservations)) {
          if (!object(r) || !uintText(r.amountWei) || typeof r.date !== 'string' || (r.txHash !== null && !/^0x[0-9a-fA-F]+$/.test(r.txHash))) throw new Error();
        }
      }
    }
    return ledger;
  } catch {
    throw new SpendGuardError('Spending ledger is unreadable or damaged. Reconcile it against transaction receipts before repairing it; limits have not been reset.');
  }
}
function saveLedger(home, ledger) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const temporary = join(home, `spend.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, JSON.stringify(ledger, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(temporary, ledgerPath(home));
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}
function currentEntry(ledger, address, now) {
  const key = String(address).toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(key)) throw new SpendGuardError('Invalid ledger wallet address.');
  const old = ledger[key];
  return ledger[key] = { date: todayUtc(now), spentWei: old?.date === todayUtc(now) ? old.spentWei : '0', reservations: old?.reservations || {} };
}
function totals(entry) {
  return { spentWei: BigInt(entry.spentWei), reservedWei: Object.values(entry.reservations).reduce((sum, r) => sum + BigInt(r.amountWei), 0n), date: entry.date };
}
export function checkSpend(home, address, amountWei, limits, opts = {}) {
  const value = amount(amountWei);
  let perTx, daily;
  try {
    if (![limits.perTxQuai, limits.dailyQuai].every(x => /^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(String(x)))) throw new Error();
    perTx = parseQuai(String(limits.perTxQuai)); daily = parseQuai(String(limits.dailyQuai));
  } catch { throw new SpendGuardError('Spending limits must be nonnegative decimal QUAI amounts with at most 18 decimals.'); }
  if (value > perTx) throw new SpendGuardError(`This transaction exceeds the per-transaction limit of ${limits.perTxQuai} QUAI (config limits.perTxQuai).`);
  const { spentWei, reservedWei } = getSpentToday(home, address, opts);
  if (spentWei + reservedWei + value > daily) throw new SpendGuardError(`This transaction would exceed the daily limit of ${limits.dailyQuai} QUAI, including unconfirmed reservations. Reconcile pending transactions before retrying.`);
}
export function recordSpend(home, address, amountWei, opts = {}) {
  const ledger = loadLedger(home), entry = currentEntry(ledger, address, opts.now);
  entry.spentWei = (BigInt(entry.spentWei) + amount(amountWei)).toString();
  saveLedger(home, ledger);
}
export function getSpentToday(home, address, opts = {}) {
  return totals(currentEntry(loadLedger(home), address, opts.now));
}
// Call under withSpendLock BEFORE invoking the signer. A crash or an ambiguous send error
// cannot make the same daily allowance spendable again.
export function reserveSpend(home, address, amountWei, limits, opts = {}) {
  checkSpend(home, address, amountWei, limits, opts);
  const ledger = loadLedger(home), entry = currentEntry(ledger, address, opts.now), id = randomUUID();
  entry.reservations[id] = { amountWei: amount(amountWei).toString(), date: todayUtc(opts.now), txHash: null };
  saveLedger(home, ledger); return id;
}
export function markSpendHash(home, address, id, txHash) {
  if (!/^0x[0-9a-fA-F]+$/.test(txHash)) throw new SpendGuardError('Invalid transaction hash for spending reservation.');
  const ledger = loadLedger(home), entry = ledger[String(address).toLowerCase()];
  if (!entry?.reservations?.[id]) throw new SpendGuardError('Spending reservation does not exist.');
  entry.reservations[id].txHash = txHash; saveLedger(home, ledger);
}
export function settleSpend(home, address, id, { confirmed, now } = {}) {
  if (typeof confirmed !== 'boolean') throw new SpendGuardError('A confirmed receipt status is required to settle a reservation.');
  const ledger = loadLedger(home), entry = currentEntry(ledger, address, now), reservation = entry.reservations[id];
  if (!reservation) throw new SpendGuardError('Spending reservation does not exist or is already settled.');
  if (confirmed) entry.spentWei = (BigInt(entry.spentWei) + BigInt(reservation.amountWei)).toString();
  delete entry.reservations[id]; saveLedger(home, ledger);
}
// Lock the entire shared file, including different wallets. Never automatically reclaim a
// stale lock: the stopped process might have broadcast. Review receipts first.
export async function withSpendLock(home, _address, operation) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const path = join(home, 'spend.lock'); let fd;
  try { fd = openSync(path, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let info = '';
    try {
      const l = JSON.parse(readFileSync(path, 'utf8'));
      const ageMin = Math.round((Date.now() - Date.parse(l.startedAt)) / 60000);
      info = Number.isFinite(ageMin) ? ` Lock written by pid ${l.pid} ${ageMin} min ago${ageMin >= 10 ? ' — it looks STALE' : ''}.` : '';
    } catch { /* unreadable lock: still report the path */ }
    throw new SpendGuardError(`Another write is in progress (lock file: ${path}).${info} If no hartii process is running, a previous one stopped mid-write: check your recent transactions on quaiscan first (it may have broadcast), then delete that file to continue. The CLI never removes it automatically.`);
  }
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    return await operation();
  } finally { closeSync(fd); unlinkSync(path); }
}
