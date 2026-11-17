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
    get depth() { return enabled ? colorDepth({ env: opts.env, isTTY: true }) : 0; },
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
    // Category approach, not a hand list: control (Cc), format (Cf: bidi, zero-width, BOM, soft hyphen,
    // Arabic letter mark, Mongolian separator, tag characters), line/paragraph separators (Zl/Zp), lone
    // surrogates, plus the invisible fillers that are letters (Hangul/Khmer fillers) and the whole tag block.
    // eslint-disable-next-line no-misleading-character-class -- remove each invisible filler independently
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}\u061c\u115f\u1160\u17b4\u17b5\u180e\u3164\uffa0\u{e0000}-\u{e007f}]/gu, '');
}

/**
 * The one and only shape every `--json` command prints: `JSON.stringify(payload, null, 2)` plus a
 * trailing newline, written straight to the given `write` sink (default process.stdout.write, injectable
 * for tests). BigInt values are rejected by JSON.stringify by default — commands must convert any
 * BigInt (wei amounts) to a decimal string *before* calling this, so a bug there fails loudly
 * instead of silently losing precision through Number conversion.
 * @param {object} payload
 * @param {{ write?: (s: string) => void }} [opts]
 */
export function printJson(payload, opts = {}) {
  const write = opts.write || ((s) => process.stdout.write(s + '\n'));
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
  return String(text).replace(/https?:\/\/[^\s]+/gi, (raw) => {
    try {
      // Closing punctuation is valid userinfo; only known complete explorer paths
      // may be split from surrounding prose before parsing the whole URL token.
      const explorer=raw.match(/^(https:\/\/(?:quaiscan\.io|orchard\.quaiscan\.io)\/(?:tx\/0x[0-9a-f]{64}|address\/0x[0-9a-f]{40})\/?)([)\]}.,;!:'"<>]*)$/i);
      if(explorer)return explorer[1]+explorer[2];
      const u = new URL(raw);
      const path = u.pathname.split('/').map(seg => {
        let decoded;try {decoded=decodeURIComponent(seg);}catch{return '***';}
        return decoded.length>=16 ? '***' : seg;
      }).join('/');
      return `${u.protocol}//${u.host}${path}${u.search || u.hash ? '?***' : ''}`;
    } catch { return '[redacted-url]'; }
  });
}

// ---------------------------------------------------------------------------------------------
// Hartii look (2026-11-16): Labs black-and-white base, violet as the one accent, red only for danger.
// Truecolor with a 256 then 16 colour fallback; NO_COLOR gives plain text. Meaning never depends on
// colour alone: callers always pair a colour with a word or a symbol.
// ---------------------------------------------------------------------------------------------

/** The colour tokens, from the shared brief. */
export const TOKENS = {
  text: '#F2F1F4', muted: '#9B98A3', dim: '#66636D', surface: '#141416', background: '#0D0D0E',
  accent: '#7C3AED', accentBright: '#A78BFA', accentDark: '#6D28D9',
  danger: '#F0465C', ok: '#22C55E', warn: '#FFB020',
};

/** 24 (truecolor), 8-bit 256, or 4-bit 16. Not a TTY or NO_COLOR: 0. */
export function colorDepth(opts = {}) {
  const env = opts.env || process.env;
  if (!colorEnabled(opts)) return 0;
  const force = typeof env.FORCE_COLOR === 'string' ? env.FORCE_COLOR : '';
  if (force === '1') return 4;
  if (force === '2') return 8;
  if (force === '3') return 24;
  const ct = String(env.COLORTERM || '').toLowerCase();
  if (ct === 'truecolor' || ct === '24bit' || env.WT_SESSION || /^(vscode|iTerm\.app|WezTerm|ghostty)$/i.test(env.TERM_PROGRAM || '')) return 24;
  if (/256color|-direct$/i.test(env.TERM || '')) return 8;
  return 4;
}

const hexRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
function to256([r, g, b]) {
  if (Math.abs(r - g) < 10 && Math.abs(g - b) < 10) {
    const avg = Math.round((r + g + b) / 3);
    if (avg < 8) return 16;
    if (avg > 248) return 231;
    return 232 + Math.round(((avg - 8) / 247) * 23);
  }
  const c = (v) => Math.round((v / 255) * 5);
  return 16 + 36 * c(r) + 6 * c(g) + c(b);
}
const SIXTEEN = { text: '97', muted: '37', dim: '90', accent: '35', accentBright: '95', accentDark: '35', danger: '91', ok: '92', warn: '93' };

/**
 * The themed palette. `depth` 0 returns identity functions. Every style closes only what it opened
 * (39 for colour, 22 for weight) so styles nest without cancelling each other.
 */
export function makeTheme(opts = {}) {
  const depth = opts.depth !== undefined ? opts.depth : colorDepth(opts);
  const on = depth > 0;
  const fg = (name) => {
    if (!on) return (s) => String(s);
    const open = depth >= 24 ? `38;2;${hexRgb(TOKENS[name]).join(';')}` : depth >= 8 ? `38;5;${to256(hexRgb(TOKENS[name]))}` : SIXTEEN[name];
    return (s) => `\u001b[${open}m${s}\u001b[39m`;
  };
  const weight = (on_, off) => (s) => (on ? `\u001b[${on_}m${s}\u001b[${off}m` : String(s));
  const theme = { enabled: on, depth, bold: weight(1, 22) };
  for (const name of ['text', 'muted', 'dim', 'accent', 'accentBright', 'accentDark', 'danger', 'ok', 'warn']) theme[name] = fg(name);
  // `dim` is the colour token; the SGR "faint" weight lives under its own name.
  theme.faint = weight(2, 22);
  return theme;
}

/** Length of `s` on screen: ANSI colour removed, wide/emoji not special-cased (Hartii output is Latin + box drawing). */
export function visibleLength(s) {
  return Array.from(stripAnsi(s)).length;
}

/** Word-wrap plain or coloured text to `width` columns; splits an over-long word. Keeps leading `indent`. */
export function wrapText(s, width, { indent = '', hang = indent } = {}) {
  const words = String(s).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = indent;
  let lead = true;
  const room = (pre) => Math.max(10, width - visibleLength(pre));
  for (const w of words) {
    const test = lead ? line + w : `${line} ${w}`;
    if (visibleLength(test) <= width || lead) {
      if (lead && visibleLength(test) > width) {
        const chars = Array.from(stripAnsi(w));
        const max = room(indent);
        for (let i = 0; i < chars.length; i += max) lines.push(`${i ? hang : indent}${chars.slice(i, i + max).join('')}`);
        line = hang; lead = true;
        continue;
      }
      line = test; lead = false;
    } else {
      lines.push(line);
      line = hang + w; lead = false;
    }
  }
  if (!lead || !lines.length) lines.push(line);
  return lines;
}

const VIEW = Symbol.for('hartii.view');
/** Mark a command result with the human view that should render it. Invisible to JSON, spread and Object.keys. */
export function tagView(result, name) {
  if (result && typeof result === 'object') Object.defineProperty(result, VIEW, { value: name, enumerable: false, configurable: true });
  return result;
}
export const viewOf = (result) => (result && typeof result === 'object' ? result[VIEW] : undefined);

/**
 * A small progress line on stderr for waits longer than `delayMs` (default 300). Only on a TTY, never with --json
 * or NO_COLOR-agnostic animation: a plain `label…` that is rewritten in place and cleared when done.
 */
export async function withProgress(label, fn, { stream = process.stderr, json = false, delayMs = 300, tty = Boolean(process.stderr && process.stderr.isTTY), frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] } = {}) {
  if (json || !tty) return fn();
  let timer = null;
  let ticker = null;
  let shown = false;
  let i = 0;
  const draw = () => { stream.write(`\r${frames[i++ % frames.length]} ${label}`); shown = true; };
  timer = setTimeout(() => { draw(); ticker = setInterval(draw, 90); }, delayMs);
  try { return await fn(); } finally {
    clearTimeout(timer);
    if (ticker) clearInterval(ticker);
    if (shown) stream.write(`\r${' '.repeat(visibleLength(label) + 2)}\r`);
  }
}

/**
 * Presentation options for one invocation: `--terse` (or config `ui.terse`) keeps one line per result,
 * `--details` shows the technical block under a review, width is the terminal width (60/80/120 all work).
 * Pure: pass `cfg` (loaded config), the parsed extra flags and the stdout stream.
 */
export function uiOptions({ flags = {}, cfg = {}, stdout = process.stdout } = {}) {
  const cfgTerse = cfg?.ui?.terse === true || cfg?.ui?.terse === 'true';
  const columns = Number(stdout && stdout.columns);
  return {
    terse: flags.terse === true || (flags.terse === undefined && cfgTerse),
    details: flags.details === true,
    width: Number.isFinite(columns) && columns > 0 ? columns : 80,
  };
}
