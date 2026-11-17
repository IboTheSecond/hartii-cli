// packages/hartii-cli/src/qi/select.js
// Pure note selection. A Qi wallet holds "notes" (UTXOs) of fixed sizes; a send spends whole notes and
// gets the rest back as change. Picking the smallest notes that cover the send keeps change small,
// keeps big notes whole and keeps the fee down (every change output costs fee).
import { denominations } from 'quais';
import { CliError } from '../errors.js';
import { formatQi, QIT_PER_QI } from './units.js';

export class QiSelectError extends CliError {}

export const DENOMS = denominations.map(BigInt); // index -> qits: 1,5,10,50,100,500,1000,5000,...
export const MAX_INPUTS = 12;

/** Greedy split of a value into note indexes (largest first). Only real denominations exist. */
export function denominate(valueQit) {
  let rest = BigInt(valueQit);
  if (rest < 0n) throw new QiSelectError('Cannot split a negative amount.');
  const out = [];
  for (let i = DENOMS.length - 1; i >= 0 && rest > 0n; i -= 1) {
    while (rest >= DENOMS[i]) { out.push(i); rest -= DENOMS[i]; }
  }
  return out;
}

export const sumDenoms = (list) => list.reduce((s, i) => s + DENOMS[i], 0n);

function pruned(picked, target) {
  // Drop the smallest notes that are not needed.
  const keep = [...picked].sort((a, b) => (a.valueQit < b.valueQit ? -1 : 1));
  let total = keep.reduce((s, n) => s + n.valueQit, 0n);
  for (let i = 0; i < keep.length;) {
    if (total - keep[i].valueQit >= target) { total -= keep[i].valueQit; keep.splice(i, 1); } else i += 1;
  }
  return keep;
}

/**
 * @param {{notes: Array<{valueQit:bigint, locked?:boolean}>, amountQit:bigint, feeQit:bigint}} p
 * @returns {{inputs:Array, totalInQit:bigint, spendDenoms:number[], changeDenoms:number[], changeQit:bigint, breaksLargeNote:boolean}}
 */
export function selectNotes({ notes, amountQit, feeQit }) {
  const amount = BigInt(amountQit);
  const fee = BigInt(feeQit);
  const target = amount + fee;
  const open = notes.filter((n) => !n.locked);
  const lockedTotal = notes.filter((n) => n.locked).reduce((s, n) => s + n.valueQit, 0n);
  const openTotal = open.reduce((s, n) => s + n.valueQit, 0n);
  if (openTotal < target) {
    const lockedHint = lockedTotal > 0n ? ` ${formatQi(lockedTotal)} Qi more is still locked and unlocks after a few blocks.` : '';
    throw new QiSelectError(`Not enough spendable Qi: you need ${formatQi(target)} (amount plus fee) and have ${formatQi(openTotal)}.${lockedHint}`);
  }
  const asc = [...open].sort((a, b) => (a.valueQit < b.valueQit ? -1 : a.valueQit > b.valueQit ? 1 : 0));
  const candidates = [];
  const single = asc.find((n) => n.valueQit >= target);
  if (single) candidates.push([single]);
  // Smaller notes combined, largest of the small ones first, then trimmed.
  const below = asc.filter((n) => !single || n.valueQit < single.valueQit).reverse();
  const acc = [];
  let sum = 0n;
  for (const n of below) {
    if (sum >= target || acc.length >= MAX_INPUTS) break;
    acc.push(n); sum += n.valueQit;
  }
  if (sum >= target) candidates.push(pruned(acc, target));
  if (candidates.length === 0) {
    throw new QiSelectError(`That send would need more than ${MAX_INPUTS} notes at once. Send a smaller amount first, or consolidate your notes.`);
  }
  const total = (c) => c.reduce((s, n) => s + n.valueQit, 0n);
  const reasonable = (c) => total(c) - target <= target * 10n + QIT_PER_QI;
  const rank = (a, b) => (a.length - b.length) || (total(a) < total(b) ? -1 : total(a) > total(b) ? 1 : 0);
  const good = candidates.filter(reasonable).sort(rank);
  const best = good[0] || [...candidates].sort((a, b) => (total(a) < total(b) ? -1 : 1))[0];
  const totalInQit = total(best);
  const changeQit = totalInQit - target;
  const biggest = best.reduce((m, n) => (n.valueQit > m ? n.valueQit : m), 0n);
  return {
    inputs: best,
    totalInQit,
    spendDenoms: denominate(amount),
    changeDenoms: denominate(changeQit),
    changeQit,
    feeQit: fee,
    breaksLargeNote: biggest > target * 10n + QIT_PER_QI,
  };
}
