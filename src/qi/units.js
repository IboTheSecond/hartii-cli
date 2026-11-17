// packages/hartii-cli/src/qi/units.js
// Qi amounts are whole "qits": 1 Qi = 1000 qit, so a Qi amount has at most 3 decimals.
import { CliError } from '../errors.js';

export class QiAmountError extends CliError {}
export const QIT_PER_QI = 1000n;

/** "1.5" -> 1500n. Positive only, at most 3 decimals, plain decimal text. */
export function parseQi(text) {
  const s = String(text ?? '').trim();
  if (!/^\d+(\.\d{1,3})?$/.test(s)) throw new QiAmountError('Enter a Qi amount like 1 or 0.5 (at most 3 decimals).');
  const [whole, frac = ''] = s.split('.');
  const qit = BigInt(whole) * QIT_PER_QI + BigInt(frac.padEnd(3, '0'));
  if (qit <= 0n) throw new QiAmountError('The amount must be more than zero.');
  return qit;
}

/** 1500n -> "1.5" (no trailing zeros). */
export function formatQi(qit) {
  const v = BigInt(qit);
  const neg = v < 0n;
  const a = neg ? -v : v;
  const whole = a / QIT_PER_QI;
  const frac = (a % QIT_PER_QI).toString().padStart(3, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? '.' + frac : ''}`;
}
