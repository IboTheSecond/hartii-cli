// packages/hartii-cli/src/output.js
/* eslint-disable no-control-regex -- this module's whole job is matching terminal control sequences */
//
// Zero-dependency coloured output + the --json escape hatch every command supports (see
// the product spec : "every one supports --json with a stable documented schema"). No chalk/
// picocolors/etc — this CLI's own hard rule is zero runtime dependencies beyond
// quais/@modelcontextprotocol/sdk/zod (see AGENTS.md "Hartii CLI"), and the TUI
// needs this exact same raw-ANSI approach anyway, so it is written once, here.
//
// Respects NO_COLOR (https://no-color.org — any non-empty value disables colour, full stop) and
// FORCE_COLOR (a non-empty, non-"0" value re-enables it even when stdout isn't a TTY, e.g. piped
// into a colour-aware pager in tests/CI). Colour is also off automatically whenever stdout is not
// a TTY (piped/redirected) so a `hartii balance | cat` never embeds escape codes in a file.
//
// `--json` mode (see args.js) goes through printJson() only — human-formatted colour/table output
// must never be mixed into the same stream a pipeline is parsing, so callers are expected to
// branch on `ctx.json` before calling either helper, never call both for the same command.

const CODES = {
  reset: '0',
  bold: '1',
  dim: '2',
  red: '31',
  green: '32',
  yellow: '33',
  blue: '34',
  purple: '35', // Hartii purple-camel brand accent (#8B5CF6/#A78BFA family)
  cyan: '36',
  grey: '90',
};

/**
 * @param {{ env?: NodeJS.ProcessEnv, isTTY?: boolean }} [opts] injectable for tests — real callers
 *   pass nothing and get `process.env` / `process.stdout.isTTY`.
 * @returns {boolean}
 */
export function colorEnabled(opts = {}) {
  const env = opts.env || process.env;
  const isTTY = opts.isTTY !== undefined ? opts.isTTY : Boolean(process.stdout && process.stdout.isTTY);
  if (typeof env.NO_COLOR === 'string' && env.NO_COLOR !== '') return false;
  if (typeof env.FORCE_COLOR === 'string' && env.FORCE_COLOR !== '' && env.FORCE_COLOR !== '0') return true;
  return isTTY;
}

/**
 * Builds a small set of colour-wrapping functions bound to one enabled/disabled decision — pass
 * the result around instead of re-reading env/TTY state on every call (and makes tests trivial:
 * `makeColors({ enabled: false })` always returns the plain string).
 * @param {{ enabled?: boolean, env?: NodeJS.ProcessEnv, isTTY?: boolean }} [opts]
 */
export function makeColors(opts = {}) {
  const enabled = opts.enabled !== undefined ? opts.enabled : colorEnabled(opts);
  const wrap = (code) => (s) => (enabled ? `\u001b[${code}m${s}\u001b[0m` : String(s));
  return {
    enabled,
    bold: wrap(CODES.bold),
    dim: wrap(CODES.dim),
    red: wrap(CODES.red),
    green: wrap(CODES.green),
    yellow: wrap(CODES.yellow),
    blue: wrap(CODES.blue),
    purple: wrap(CODES.purple),
    cyan: wrap(CODES.cyan),
    grey: wrap(CODES.grey),
  };
}

/** Strips ANSI SGR escape sequences — used by TUI snapshot tests and safe to use anywhere. */
export function stripAnsi(s) {
  return String(s).replace(/\u001b\[[0-9;]*m/g, '');
}

/** Sanitize one untrusted terminal field BEFORE adding trusted layout/colour escapes.
 * Drops OSC (clipboard/link/title), control strings, CSI and C0/C1 controls, including CR/LF, plus
 * the invisible Unicode format characters (bidi overrides/isolates, zero-width joiners/spaces, BOM)
 * a token symbol could use to visually reorder or hide the address printed right next to it.
 * Do not apply this to an assembled frame: its intentional newlines and colours would be lost.
 */
export function safeTerminalText(value) {
  return String(value)
    .replace(/(?:\u001b\]|\u009d)[\s\S]*?(?:\u0007|\u001b\\|\u009c|$)/g, '')
    .replace(/(?:\u001b[P^_X]|[\u0090\u0098\u009e\u009f])[\s\S]*?(?:\u001b\\|\u009c|$)/g, '')
    .replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*(?:[@-~]|$)/g, '')
    .replace(/\u001b[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .replace(/[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff]/g, '');
}

/**
 * The one and only shape every `--json` command prints: `JSON.stringify(payload, null, 2)` plus a
 * trailing newline, written straight to the given `write` sink (default `console.log`, injectable
 * for tests). BigInt values are rejected by JSON.stringify by default — commands must convert any
 * BigInt (wei amounts) to a decimal string *before* calling this, so a bug there fails loudly
 * instead of silently losing precision through Number conversion.
 * @param {object} payload
 * @param {{ write?: (s: string) => void }} [opts]
 */
export function printJson(payload, opts = {}) {
  const write = opts.write || ((s) => console.log(s));
  write(JSON.stringify(payload, null, 2));
}

/**
 * Minimal left-aligned column table for human output (no deps). `rows` is an array of arrays of
 * already-stringified cells; column widths are computed from the longest cell in each column.
 * @param {string[][]} rows
 * @returns {string} joined by newlines, no trailing newline
 */
export function formatTable(rows) {
  if (!rows.length) return '';
  const colCount = Math.max(...rows.map((r) => r.length));
  const widths = Array.from({ length: colCount }, (_, i) => Math.max(...rows.map((r) => (r[i] || '').length)));
  return rows.map((r) => Array.from({ length: colCount }, (_, i) => (r[i] || '')).map((cell, i) => cell.padEnd(widths[i])).join('  ').trimEnd()).join('\n');
}

/** "SYM (0xaddress)" — a third-party token symbol must never be shown without its address. */
export function withAddr(symbol, address) {
  const s = String(symbol ?? '???');
  if (!address || /^0x[0-9a-fA-F]{40}$/.test(s) || s.includes('(0x')) return s;
  return `${s} (${address})`;
}

/** Strips credentials, query strings and key-like path segments from every URL inside `text`. */
export function redactUrls(text) {
  return String(text).replace(/https?:\/\/[^\s"'<>)]+/gi, (raw) => {
    try {
      const u = new URL(raw);
      const path = u.pathname.split('/').map((seg) => {let decoded;try{decoded=decodeURIComponent(seg);}catch{return '***';}return /^[A-Za-z0-9_-]{16,}$/.test(decoded)&&!/^0x[0-9a-fA-F]+$/.test(decoded)?'***':seg;}).join('/');
      return `${u.protocol}//${u.host}${path}${u.search || u.hash ? '?***' : ''}`;
    } catch { return '[redacted-url]'; }
  });
}
