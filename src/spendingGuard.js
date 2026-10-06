// Local accident-prevention caps. Every write holds the home-wide lock through its receipt.
// Unknown submissions retain durable reservations; every mined outcome charges its gas.
import { readFileSync, writeFileSync, unlinkSync, openSync, closeSync, fsyncSync, fstatSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseQuai } from 'quais';
import { CliError } from './errors.js';
import { securePath, secureDirectory, atomicPrivateWrite } from './secureFiles.js';
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
  try {
    const directory = securePath(home);
    if (directory.stat && !directory.stat.isDirectory()) throw new Error();
    const file = securePath(path, { regularFile: true });
    if (!file.stat) return {};
    const ledger = JSON.parse(readFileSync(file.path, 'utf8'));
    if (!object(ledger)) throw new Error();
    for (const [address, entry] of Object.entries(ledger)) {
      if (!/^0x[0-9a-f]{40}$/.test(address) || !object(entry) || !/^\d{4}-\d{2}-\d{2}$/.test(entry.date) || !uintText(entry.spentWei)) throw new Error();
      if (entry.reservations !== undefined) {
        if (!object(entry.reservations)) throw new Error();
        for (const r of Object.values(entry.reservations)) {
          if (!object(r) || !uintText(r.amountWei) || typeof r.date !== 'string' || (r.txHash !== null && !/^0x[0-9a-fA-F]+$/.test(r.txHash))) throw new Error();
          if (r.chainId !== undefined) {
            if (!['9','15000'].includes(r.chainId) || !Number.isSafeInteger(r.nonce) || r.nonce < 0
              || !/^0x[0-9a-f]{40}$/.test(r.to) || !uintText(r.valueWei) || !uintText(r.spendWei) || !uintText(r.maxFeeWei)
              || !/^0x[0-9a-f]{64}$/.test(r.dataDigest) || !/^0x[0-9a-f]{64}$/.test(r.intentDigest) || typeof r.createdAt !== 'string') throw new Error();
          }
        }
      }
    }
    return ledger;
  } catch {
    throw new SpendGuardError('Spending ledger is unreadable or damaged. Reconcile it against transaction receipts before repairing it; limits have not been reset.');
  }
}
function saveLedger(home, ledger) {
  try { secureDirectory(home); atomicPrivateWrite(ledgerPath(home), JSON.stringify(ledger, null, 2) + '\n', { replace: true }); }
  catch { throw new SpendGuardError('Spending ledger could not be safely committed. Pending authority has not been reset; reconcile before further writes.'); }
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
/** Public pending metadata only. Never loads config, providers, keys or passwords. */
export function listSpendReservations(home, address) {
  const wanted = address === undefined ? null : String(address).toLowerCase();
  if (wanted !== null && !/^0x[0-9a-f]{40}$/.test(wanted)) throw new SpendGuardError('Invalid ledger wallet address.');
  const rows = [];
  for (const [account, entry] of Object.entries(loadLedger(home))) {
    if (wanted !== null && account !== wanted) continue;
    for (const [id, r] of Object.entries(entry.reservations || {})) {
      rows.push({ id, address: account, date: r.date, createdAt: r.createdAt ?? null,
        chainId: r.chainId ?? null, txHash: r.txHash, nonce: r.nonce ?? null,
        to: r.to ?? null, valueWei: r.valueWei ?? null, dataDigest: r.dataDigest ?? null,
        intentDigest: r.intentDigest ?? null, guardedValueWei: r.spendWei ?? null,
        gasTotalWei: r.maxFeeWei ?? null, amountWei: r.amountWei,
        status: 'unconfirmed', legacy: !r.chainId || !r.intentDigest,
      });
    }
  }
  return rows;
}

/** Unknown authority blocks the signer, even when its amount fits remaining caps. */
export function assertNoPendingSpend(home, address, chainId) {
  const chain = String(chainId);
  const pending = listSpendReservations(home, address).filter((r) => r.legacy || r.chainId === chain);
  if (pending.length) throw new SpendGuardError('Unconfirmed spending authority exists for this signer and chain. Reconcile pending transaction receipts before another write; remaining daily headroom does not permit a retry.');
}

/** A lock record is a fact on disk, never proof that its PID is currently active. */
export function inspectSpendLock(home) {
  try {
    const file = securePath(join(home, 'spend.lock'), { regularFile: true });
    if (!file.stat) return { exists: false, pid: null, startedAt: null, unverified: false, unreadable: false };
    const record = JSON.parse(readFileSync(file.path, 'utf8'));
    if (!Number.isSafeInteger(record?.pid) || record.pid <= 0 || typeof record.startedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(record.startedAt) || !Number.isFinite(Date.parse(record.startedAt))) throw new Error();
    return { exists: true, pid: record.pid, startedAt: record.startedAt, unverified: true, unreadable: false };
  } catch { return { exists: true, pid: null, startedAt: null, unverified: true, unreadable: true }; }
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
  if (opts.authority) assertNoPendingSpend(home, address, opts.authority.chainId);
  checkSpend(home, address, amountWei, limits, opts);
  const ledger = loadLedger(home), entry = currentEntry(ledger, address, opts.now), id = randomUUID();
  entry.reservations[id] = { amountWei: amount(amountWei).toString(), date: todayUtc(opts.now), txHash: null, ...(opts.authority || {}) };
  saveLedger(home, ledger); return id;
}
export function markSpendHash(home, address, id, txHash) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new SpendGuardError('Invalid transaction hash for spending reservation.');
  const ledger = loadLedger(home), entry = ledger[String(address).toLowerCase()];
  if (!entry?.reservations?.[id]) throw new SpendGuardError('Spending reservation does not exist.');
  const current = entry.reservations[id].txHash;
  if (current && current.toLowerCase() !== txHash.toLowerCase()) throw new SpendGuardError('Spending reservation hash identity changed.');
  entry.reservations[id].txHash = txHash.toLowerCase(); saveLedger(home, ledger);
}
export function settleSpend(home, address, id, { confirmed, chargedWei, now } = {}) {
  if (typeof confirmed !== 'boolean') throw new SpendGuardError('A confirmed receipt status is required to settle a reservation.');
  const ledger = loadLedger(home), entry = currentEntry(ledger, address, now), reservation = entry.reservations[id];
  if (!reservation) throw new SpendGuardError('Spending reservation does not exist or is already settled.');
  const charge = chargedWei === undefined ? (confirmed ? BigInt(reservation.amountWei) : 0n) : amount(chargedWei);
  entry.spentWei = (BigInt(entry.spentWei) + charge).toString();
  delete entry.reservations[id]; saveLedger(home, ledger);
}
// Lock the entire shared file, including different wallets. Never automatically reclaim a
// stale lock: the stopped process might have broadcast. Review receipts first.
export async function withSpendLock(home, _address, operation) {
  let path;
  try { secureDirectory(home); path = securePath(join(home, 'spend.lock'), { regularFile: true }).path; }
  catch { throw new SpendGuardError('Wallet spending storage path is unsafe or unreadable.'); }
  let fd, identity;
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
  let outcome, failure, failed = false;
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    fsyncSync(fd);
    identity = fstatSync(fd);
    outcome = await operation();
  } catch (error) { failed = true; failure = error; }
  // Lock cleanup must never mask what the operation actually did (a successful send's tx hash, or its real
  // error). On drift the lock file is left in place - the NEXT write still fails closed on it - and the
  // operator is told on stderr.
  try {
    closeSync(fd);
    const current = securePath(path, { regularFile: true }).stat;
    if (!current || !identity || current.dev !== identity.dev || current.ino !== identity.ino || current.size !== identity.size || current.mtimeMs !== identity.mtimeMs || current.ctimeMs !== identity.ctimeMs) throw new SpendGuardError('Write lock changed unexpectedly and was not removed. A write may have occurred; reconcile receipts before retrying.');
    unlinkSync(path);
  } catch (error) {
    try { process.stderr.write(`WARNING: ${error?.message || 'Could not release the write lock.'} The operation's own result is reported unchanged; further writes stay blocked until you reconcile and remove ${path}.\n`); } catch { /* stderr closed */ }
  }
  if (failed) throw failure;
  return outcome;
}
