export class TraderError extends Error {
  constructor(code, message = code) { super(message); this.name = 'TraderError'; this.code = code; this.retryable = false; }
}
export function invariant(ok, code) { if (!ok) throw new TraderError(code); }
export function exactObject(value, keys, code = 'invalid-fields') {
  invariant(value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype, code);
  invariant(Object.keys(value).every(k => keys.includes(k)), code);
  return value;
}
export function uint(value, name = 'amount') {
  invariant(typeof value === 'string' && /^(0|[1-9]\d{0,95})$/.test(value), `invalid-${name}`);
  return BigInt(value);
}
export function timestamp(value) { invariant(Number.isSafeInteger(value) && value >= 0, 'invalid-timestamp'); return value; }
export function address(value) {
  invariant(typeof value === 'string' && /^0x00[0-7][0-9a-fA-F]{37}$/.test(value) && !/^0x0{40}$/i.test(value), 'invalid-cyprus-quai-address');
  return value;
}
export function identifier(value) { invariant(typeof value === 'string' && /^[A-Za-z0-9_-]{1,96}$/.test(value), 'invalid-identifier'); return value; }
export function hash(value) { invariant(typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value), 'invalid-tx-hash'); return value; }
export function parseUnits(value, decimals = 18) {
  invariant(Number.isSafeInteger(decimals) && decimals >= 0 && decimals <= 36, 'invalid-decimals');
  invariant(typeof value === 'string' && /^(0|[1-9]\d*)(\.\d+)?$/.test(value) && value.length <= 96, 'invalid-decimal');
  const [whole, fraction = ''] = value.split('.');
  invariant(fraction.length <= decimals, 'excess-decimal-precision');
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
}
export const min = (...values) => values.reduce((a, b) => a < b ? a : b);
export const max = (...values) => values.reduce((a, b) => a > b ? a : b);
export const ceilDiv = (a, b) => (a + b - 1n) / b;
export const bps = (value, basisPoints) => value * BigInt(basisPoints) / 10000n;
export const dayOf = now => new Date(timestamp(now)).toISOString().slice(0, 10);
export function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') { invariant(Number.isSafeInteger(value), 'invalid-canonical-number'); return String(value); }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  invariant(value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype, 'invalid-canonical-value');
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}
