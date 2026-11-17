// packages/hartii-cli/src/tui/glyphs.js
//
// Unicode with an automatic ASCII fallback. A legacy console (Windows without Windows Terminal or another
// modern host), a non-UTF-8 locale, a dumb terminal, or HARTII_ASCII=1 gets plain ASCII: every glyph maps to
// exactly one ASCII column, so layout never changes between the two modes. Pure.

/** @returns {boolean} true when the terminal should get ASCII only. */
export function detectAscii(env = process.env, platform = process.platform) {
  const forced = String(env.HARTII_ASCII ?? '').toLowerCase();
  if (forced === '1' || forced === 'true') return true;
  if (forced === '0' || forced === 'false') return false;
  if (String(env.TERM || '').toLowerCase() === 'dumb') return true;
  const locale = String(env.LC_ALL || env.LC_CTYPE || env.LANG || '');
  if (locale) {
    if (/^(C|POSIX)(\.|$)/i.test(locale) && !/utf-?8/i.test(locale)) return true;
    if (!/utf-?8/i.test(locale)) return true;
  }
  if (platform === 'win32') {
    const modern = env.WT_SESSION || env.TERM_PROGRAM || env.ConEmuANSI === 'ON' || env.ANSICON || env.MSYSTEM || /xterm|256color|screen|tmux/i.test(String(env.TERM || ''));
    return !modern;
  }
  return false;
}

const MAP = {
  '─': '-', '━': '-', '│': '|', '┃': '|', '╭': '+', '╮': '+', '╰': '+', '╯': '+', '┌': '+', '┐': '+', '└': '+', '┘': '+',
  '▌': '|', '▏': '|', '▀': '^', '▄': '_', '█': '#', '░': '.', '▒': ':', '▓': '#',
  '▁': '_', '▂': '.', '▃': ':', '▅': '=', '▆': '+', '▇': '*',
  '·': '.', '…': '~', '•': '*', '▸': '>', '◂': '<', '▲': '^', '▼': 'v', '■': '#', '✕': 'x', '✓': '+', '●': '*', '○': 'o', '◌': 'o',
  '∩': 'n', '—': '-', '–': '-', '≈': '~', '←': '<', '→': '>', '↑': '^', '↓': 'v', '‹': '<', '›': '>', '×': 'x',
  '⠋': '|', '⠙': '/', '⠹': '-', '⠸': '\\', '⠼': '|', '⠴': '/', '⠦': '-', '⠧': '\\', '⠇': '|', '⠏': '/',
};

/** One cell character -> its ASCII stand-in (always a single printable ASCII column). */
export function asciiChar(ch) {
  if (ch >= ' ' && ch <= '~') return ch;
  return MAP[ch] ?? '?';
}

// Spinner frames per mode (reduced motion shows the first frame only).
export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
export const SPINNER_ASCII = ['|', '/', '-', '\\'];
