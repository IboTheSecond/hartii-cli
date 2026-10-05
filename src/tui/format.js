// packages/hartii-cli/src/tui/format.js — number/address formatting for the TUI. Pure, no I/O.
import { formatUnits } from 'quais';

/** "1234567.8900" -> "1,234,567.89" (thousands separators, at most `maxFrac` decimals, trailing zeros trimmed). */
export function group(decimalString, maxFrac = 4) {
  const s = String(decimalString ?? '').trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) return s || '—';
  const neg = s.startsWith('-');
  const [w, f = ''] = (neg ? s.slice(1) : s).split('.');
  const whole = w.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = f.slice(0, maxFrac).replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

/** base units (bigint/string) -> grouped decimal string. */
export function fmtUnits(value, decimals = 18, maxFrac = 4) {
  try { return group(formatUnits(BigInt(value), decimals), maxFrac); } catch { return '—'; }
}

/** A QUAI price in wei -> compact string keeping ~4 significant digits for tiny prices. */
export function fmtPrice(priceWei) {
  let n;
  try { n = BigInt(priceWei); } catch { return '—'; }
  if (n <= 0n) return '—';
  const s = formatUnits(n, 18); // plain decimal
  const [w, f = ''] = s.split('.');
  if (BigInt(w) > 0n) return group(s, 4);
  const lead = f.match(/^0*/)[0].length;
  return `0.${f.slice(0, lead + 4).replace(/0+$/, '')}`;
}

export function shortAddr(a, head = 6, tail = 4) {
  const s = String(a || '');
  return s.length > head + tail + 1 ? `${s.slice(0, head)}…${s.slice(-tail)}` : s;
}

/** 12.345 -> "+12.3%" ; null -> "—". */
export function fmtPct(p) {
  if (p === null || p === undefined || !Number.isFinite(Number(p))) return '—';
  const n = Number(p);
  return `${n > 0 ? '+' : ''}${n.toFixed(Math.abs(n) >= 100 ? 0 : 1)}%`;
}

export function fmtInt(n) {
  return Number.isFinite(Number(n)) ? String(Math.trunc(Number(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ',') : '—';
}

export function clock(tsMs) {
  const d = new Date(Number(tsMs));
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(11, 19) : '--:--:--';
}

export const clip = (s, w) => {
  const a = Array.from(String(s));
  return a.length <= w ? a.join('') : `${a.slice(0, Math.max(0, w - 1)).join('')}…`;
};
export const padR = (s, w) => { const t = clip(s, w); return t + ' '.repeat(Math.max(0, w - Array.from(t).length)); };
export const padL = (s, w) => { const t = clip(s, w); return ' '.repeat(Math.max(0, w - Array.from(t).length)) + t; };
