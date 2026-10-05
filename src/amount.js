// packages/hartii-cli/src/amount.js
//
// Parses the three amount shapes every spending command accepts (see the product spec: `sell
// <token> <amount|all|50%>`): a plain decimal ("1.5"), a percentage of the caller-supplied balance
// ("50%", "33.33%"), or the literal "all". Always returns a BigInt in the token's own base units
// (wei for 18-decimal QUAI/most ERC-20s) — callers never do their own float math on money.
import { parseUnits, formatUnits } from 'quais';
import { CliError } from './errors.js';

export class AmountError extends CliError {}

const PERCENT_RE = /^(\d+(?:\.\d+)?)\s*%$/;

/**
 * @param {string} input "1.5" | "50%" | "all"
 * @param {{ balanceWei?: bigint, decimals?: number }} [opts] `balanceWei` is required for "all"/"%"
 * @returns {{ amountWei: bigint, isAll: boolean, isPercent: boolean, percent: number|null }}
 */
export function parseAmount(input, opts = {}) {
  const decimals = opts.decimals ?? 18;
  const raw = String(input ?? '').trim();
  if (!raw) throw new AmountError('Amount is required.');

  if (raw.toLowerCase() === 'all') {
    if (opts.balanceWei === undefined) throw new AmountError('"all" needs a known balance to resolve against.');
    return { amountWei: BigInt(opts.balanceWei), isAll: true, isPercent: false, percent: null };
  }

  const pctMatch = raw.match(PERCENT_RE);
  if (pctMatch) {
    if (opts.balanceWei === undefined) throw new AmountError('A percentage needs a known balance to resolve against.');
    const pct = Number(pctMatch[1]);
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
      throw new AmountError(`"${raw}" is not a valid percentage (must be > 0 and <= 100).`);
    }
    const balanceWei = BigInt(opts.balanceWei);
    // Integer basis-points math (2 decimal places of percent precision) — never floats on money.
    const bps = Math.round(pct * 100);
    const amountWei = (balanceWei * BigInt(bps)) / 10000n;
    return { amountWei, isAll: bps === 10000, isPercent: true, percent: pct };
  }

  if (!/^\d+(\.\d+)?$/.test(raw)) {
    throw new AmountError(`"${raw}" is not a valid amount — use a plain decimal ("1.5"), a percentage ("50%"), or "all".`);
  }
  let amountWei;
  try {
    amountWei = parseUnits(raw, decimals);
  } catch {
    throw new AmountError(`"${raw}" has more decimal places than this token supports (${decimals}).`);
  }
  if (amountWei <= 0n) throw new AmountError('Amount must be greater than zero.');
  return { amountWei, isAll: false, isPercent: false, percent: null };
}

/** Formats a base-units BigInt back to a plain decimal string, for display. */
export function formatAmount(amountWei, decimals = 18) {
  return formatUnits(BigInt(amountWei), decimals);
}
