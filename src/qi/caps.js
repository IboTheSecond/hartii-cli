// packages/hartii-cli/src/qi/caps.js
// Caps exist only when the user set them. Qi reuses the same config limits, counted in Qi
// (perTxQuai / dailyQuai = the number of Qi). A limit that is missing/null means "not set".
import { CliError } from '../errors.js';
import { formatQi, QIT_PER_QI } from './units.js';

export class QiCapError extends CliError {}

const toQit = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v);
  // R3-F7: never treat a cap we cannot count as "no cap". Qi counts in thousandths.
  if (!/^\d+(\.\d{1,3})?$/.test(s)) throw new QiCapError(`Your spending limit "${s}" cannot be counted in Qi (Qi has at most 3 decimals). Set it with at most 3 decimals, for example \`hartii config set limits.perTxQuai 5\`. Nothing was sent.`);
  const [w, f = ''] = s.split('.');
  return BigInt(w) * QIT_PER_QI + BigInt(f.padEnd(3, '0'));
};

export function resolveQiCaps(cfg = {}) {
  const perTx = toQit(cfg.limits?.perTxQuai);
  const daily = toQit(cfg.limits?.dailyQuai);
  const set = cfg.capsSet === false ? false : perTx !== null || daily !== null;
  return { set, perTxQit: set ? perTx : null, dailyQit: set ? daily : null };
}

/** spendQit = what leaves the wallet (amount + fee). */
export function checkQiCaps(caps, { spendQit, spentTodayQit = 0n }) {
  if (!caps.set) return;
  if (caps.perTxQit !== null && spendQit > caps.perTxQit) {
    throw new QiCapError(`This send (${formatQi(spendQit)} Qi with fee) is over your per-transaction limit of ${formatQi(caps.perTxQit)} Qi. Change it with \`hartii config set limits.perTxQuai <n>\` if you really mean it.`);
  }
  if (caps.dailyQit !== null && spentTodayQit + spendQit > caps.dailyQit) {
    throw new QiCapError(`This send would take you over your daily limit of ${formatQi(caps.dailyQit)} Qi (${formatQi(spentTodayQit)} Qi already sent today).`);
  }
}
