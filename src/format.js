// packages/hartii-cli/src/format.js
//
// One formatter for every human view of the Hartii CLI (and, after integration, the TUI): amounts,
// compact numbers, percent, fee, address and time. Pure, no I/O. JSON output never goes through
// here: --json keeps exact base units and decimal strings.
//
// Display rules (owner 2026-11-16): never raw base units or wei in a human view; thousands separators;
// unknown is always a dash; display values are TRUNCATED (never rounded up, so a balance is never
// overstated). A value that moves money (a send review) uses `exact: true`: full precision, no trimming.
import { getAddress } from 'quais';
import { safeTerminalText } from './output.js';

export const DASH = '—';
const MINUS = '-';

/** "1234567" -> "1,234,567". Input is a string of digits only. */
export function groupDigits(digits) {
  return String(digits).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function unitsParts(value, decimals) {
  let n;
  try {
    if (typeof value === 'bigint') n = value;
    else if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) n = BigInt(value.trim());
    else if (typeof value === 'number' && Number.isSafeInteger(value)) n = BigInt(value);
    else return null;
  } catch { return null; }
  const neg = n < 0n;
  const abs = neg ? -n : n;
  const base = 10n ** BigInt(decimals);
  const whole = (abs / base).toString();
  const frac = decimals ? (abs % base).toString().padStart(decimals, '0') : '';
  return { neg, whole, frac };
}

function decimalParts(text) {
  const s = String(text ?? '').trim();
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(s);
  return m ? { neg: Boolean(m[1]), whole: m[2].replace(/^0+(?=\d)/, ''), frac: m[3] || '' } : null;
}

function render({ neg, whole: whole0, frac }, { exact = false, maxFrac, sig = 4, up = false } = {}) {
  let whole = whole0;
  let f = frac.replace(/0+$/, '');
  if (!exact) {
    let cap = maxFrac;
    if (cap === undefined) {
      if (whole !== '0') cap = whole.length >= 4 ? 2 : 4;
      else cap = Math.min(18, (f.match(/^0*/)[0].length) + sig);
    }
    const dropped = f.slice(cap);
    f = f.slice(0, cap);
    if (up && /[1-9]/.test(dropped)) {
      // Round UP (never understate a cost): bump the last kept digit with exact integer maths.
      const digits = BigInt(whole + f.padEnd(cap, '0')) + 1n;
      const s2 = digits.toString().padStart(cap + 1, '0');
      whole = s2.slice(0, s2.length - cap) || '0';
      f = cap ? s2.slice(s2.length - cap) : '';
    }
    f = f.replace(/0+$/, '');
  }
  const zero = /^0*$/.test(whole) && f === '';
  return `${neg && !zero ? MINUS : ''}${groupDigits(whole)}${f ? `.${f}` : ''}`;
}

/** Base units (bigint or digit string) -> grouped decimal string, no symbol. Unknown -> dash. */
export function fromUnits(value, { decimals = 18, exact = false, maxFrac, sig, up = false } = {}) {
  const parts = unitsParts(value, decimals);
  return parts ? render(parts, { exact, maxFrac, sig, up }) : DASH;
}

/** A plain decimal string ("1234.5678") -> grouped decimal string. Unknown -> dash. */
export function fromDecimal(text, { exact = false, maxFrac, sig } = {}) {
  const parts = decimalParts(text);
  return parts ? render(parts, { exact, maxFrac, sig }) : DASH;
}

const withSymbol = (text, symbol) => (text === DASH || !symbol ? text : `${text} ${symbol}`);

/** Token or QUAI amount from base units: "1,234.56 QUAI". */
export function amount(value, { decimals = 18, symbol, exact, maxFrac, sig, up } = {}) {
  return withSymbol(fromUnits(value, { decimals, exact, maxFrac, sig, up }), symbol);
}

/** Same, from a decimal string such as the write summary's `valueQuai`. */
export function amountDecimal(text, { symbol, exact, maxFrac, sig } = {}) {
  return withSymbol(fromDecimal(text, { exact, maxFrac, sig }), symbol);
}

export const quai = (wei, opts = {}) => amount(wei, { ...opts, symbol: 'QUAI' });
export const quaiDecimal = (text, opts = {}) => amountDecimal(text, { ...opts, symbol: 'QUAI' });

/** A price in wei per whole token: keeps four significant digits for tiny prices ("0.0000186"). */
export function price(wei, { exact = false } = {}) {
  const parts = unitsParts(wei, 18);
  if (!parts) return DASH;
  if (parts.neg) return render(parts, { exact });
  return render(parts, { exact, sig: 4 });
}

/** 12400 -> "12.4K". Only for stats where the TUI already uses compact forms. */
export function compact(value) {
  let n;
  if (typeof value === 'bigint') n = Number(value);
  else if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) n = Number(value);
  else if (typeof value === 'number') n = value;
  else return DASH;
  if (!Number.isFinite(n)) return DASH;
  const abs = Math.abs(n);
  const units = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
  for (const [size, tag] of units) {
    if (abs >= size) {
      const scaled = Math.floor((abs / size) * 10) / 10;
      return `${n < 0 ? MINUS : ''}${scaled % 1 === 0 ? scaled.toFixed(0) : scaled.toFixed(1)}${tag}`;
    }
  }
  return `${n < 0 ? MINUS : ''}${groupDigits(String(Math.trunc(abs)))}`;
}

/** A whole count (holders, trades): "1,337". */
export function count(value) {
  if (value === null || value === undefined || value === '') return DASH;
  const n = Number(value);
  return Number.isFinite(n) ? `${n < 0 ? MINUS : ''}${groupDigits(String(Math.trunc(Math.abs(n))))}` : DASH;
}

/** Basis points -> "3%" (not "300 bps"); 25 -> "0.25%". */
export function percentFromBps(bps) {
  const n = Number(bps);
  if (bps === null || bps === undefined || bps === '' || !Number.isFinite(n)) return DASH;
  return percent(n / 100);
}

/** A percentage number (7.83) -> "7.83%"; whole numbers drop the decimals. Pass `sign` for deltas. */
export function percent(value, { sign = false, maxFrac = 2 } = {}) {
  const n = Number(value);
  if (value === null || value === undefined || value === '' || !Number.isFinite(n)) return DASH;
  const scale = 10 ** maxFrac;
  const t = Math.trunc(Math.abs(n) * scale) / scale;
  const body = t.toFixed(maxFrac).replace(/\.?0+$/, '');
  const neg = n < 0 && t !== 0;
  return `${neg ? MINUS : sign && t !== 0 ? '+' : ''}${body}%`;
}

/** 5 -> "about 5 seconds"; 90 -> "about 2 minutes". */
export function eta(seconds) {
  const s = Number(seconds);
  if (seconds === null || seconds === undefined || seconds === '' || !Number.isFinite(s) || s < 0) return null;
  if (s < 90) { const r = Math.max(1, Math.round(s)); return `about ${r} second${r === 1 ? '' : 's'}`; }
  const m = Math.round(s / 60);
  return `about ${m} minute${m === 1 ? '' : 's'}`;
}

/** Fee as money plus time when known: "1.74 QUAI · about 5 seconds". */
export function fee(wei, { seconds, exact = false, up = false, decimals = 18, symbol = 'QUAI' } = {}) {
  const money = amount(wei, { decimals, symbol, exact, up });
  if (money === DASH) return DASH;
  const t = eta(seconds);
  return t ? `${money} · ${t}` : money;
}

// ---------- addresses ----------

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** The checksummed form of a well-formed address; anything else returns null. */
export function checksummed(addr) {
  const s = String(addr ?? '').trim();
  if (!ADDRESS_RE.test(s)) return null;
  try { return getAddress(s); } catch { try { return getAddress(s.toLowerCase()); } catch { return null; } }
}

/** Groups of four characters after the 0x prefix: ["00ab","12cd",...] (10 groups). Null when not an address. */
export function addressGroups(addr) {
  const c = checksummed(addr);
  return c ? c.slice(2).match(/.{4}/g) : null;
}

/**
 * The full checksummed address in readable 4-character groups, first and last group emphasised:
 * `0x` + `00Ab` `12cd` ... `99fE`. `emph` wraps the first and last group (bold/accent). Not an address: dash or the
 * sanitised text, never silently altered. Never abbreviated.
 */
export function address(addr, { emph = (s) => s, sep = ' ' } = {}) {
  if (addr === null || addr === undefined || addr === '') return DASH;
  const g = addressGroups(addr);
  if (!g) return safeTerminalText(String(addr));
  const last = g.length - 1;
  return `0x${g.map((x, i) => (i === 0 || i === last ? emph(x) : x)).join(sep)}`;
}

/** The address split over `lines` rows of equal group counts, for narrow terminals. */
export function addressLines(addr, { width = 80, emph = (s) => s } = {}) {
  const g = addressGroups(addr);
  if (!g) return [address(addr)];
  const full = 2 + g.length * 4 + (g.length - 1);
  if (full <= width) return [address(addr, { emph })];
  const rows = [g.slice(0, 5), g.slice(5)];
  const last = g.length - 1;
  let idx = 0;
  return rows.map((row, r) => `${r === 0 ? '0x' : '  '}${row.map((x) => { const i = idx++; return i === 0 || i === last ? emph(x) : x; }).join(' ')}`);
}

/** The compact "0x1234…abcd" form, only for places that cannot hold the full address (never for a recipient). */
export function shortAddress(addr, head = 6, tail = 4) {
  const c = checksummed(addr);
  const s = c ?? String(addr ?? '');
  if (!s) return DASH;
  return s.length > head + tail + 1 ? `${s.slice(0, head)}…${s.slice(-tail)}` : s;
}

// ---------- time ----------

function toDate(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value > 1e11 ? value : value * 1000);
  if (typeof value === 'string' && value.trim() !== '') {
    if (/^\d+$/.test(value.trim())) return toDate(Number(value.trim()));
    const d = new Date(value);
    return Number.isFinite(d.getTime()) ? d : null;
  }
  return null;
}

/** "3 minutes ago" / "in 2 hours". */
export function relativeTime(value, { now = new Date() } = {}) {
  const d = toDate(value);
  if (!d) return DASH;
  const diff = Math.round((new Date(now).getTime() - d.getTime()) / 1000);
  const abs = Math.abs(diff);
  const unit = (n, name) => `${n} ${name}${n === 1 ? '' : 's'}`;
  let body;
  if (abs < 45) body = 'a few seconds';
  else if (abs < 90) body = '1 minute';
  else if (abs < 3600) body = unit(Math.round(abs / 60), 'minute');
  else if (abs < 86400) body = unit(Math.round(abs / 3600), 'hour');
  else if (abs < 86400 * 60) body = unit(Math.round(abs / 86400), 'day');
  else body = unit(Math.round(abs / (86400 * 30)), 'month');
  if (body === 'a few seconds') return diff >= 0 ? 'just now' : 'in a few seconds';
  return diff >= 0 ? `${body} ago` : `in ${body}`;
}

/** "2026-11-16 14:02 UTC". */
export function absoluteTime(value) {
  const d = toDate(value);
  return d ? `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC` : DASH;
}

/** Relative plus absolute: "3 minutes ago · 2026-11-16 14:02 UTC". */
export function time(value, { now } = {}) {
  const d = toDate(value);
  if (!d) return DASH;
  return `${relativeTime(d, { now })} · ${absoluteTime(d)}`;
}
