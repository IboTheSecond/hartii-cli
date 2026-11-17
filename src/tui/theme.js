// packages/hartii-cli/src/tui/theme.js
//
// The Hartii terminal palette (Labs look, owner 2026-11-16): a black-and-white base, violet as the ONE
// accent, red ONLY for danger or failure. Tokens are truecolor and degrade to the nearest 256 and 16
// colours; NO_COLOR drops colour entirely, so meaning is always also carried by a word or a glyph
// (never by colour alone). Never washes a whole pane in a colour.
//   text #F2F1F4  muted #9B98A3  dim #66636D  surface #141416  background #0D0D0E
//   accent #7C3AED  accent bright #A78BFA  accent dark #6D28D9
//   danger #F0465C  ok #22C55E  warn #FFB020

export const PALETTE = {
  ink: [242, 241, 244], // text #F2F1F4
  muted: [155, 152, 163], // #9B98A3 secondary text, labels
  faint: [102, 99, 109], // #66636D hairlines and the quietest hints
  surface: [20, 20, 22], // #141416
  bg: [13, 13, 14], // #0D0D0E
  accent: [124, 58, 237], // violet #7C3AED, the one accent
  accentBright: [167, 139, 250], // #A78BFA
  accentDark: [109, 40, 217], // #6D28D9
  danger: [240, 70, 92], // #F0465C, danger and failure only
  up: [34, 197, 94], // ok green #22C55E
  warn: [255, 176, 32], // amber #FFB020
};
// Legacy aliases kept so older call sites keep compiling. `signal` is now the accent, never red.
PALETTE.signal = PALETTE.accentBright;
PALETTE.camel = PALETTE.accent;
PALETTE.camelLight = PALETTE.accentBright;
PALETTE.down = PALETTE.muted;

/** @returns {'truecolor'|'256'|'16'|'none'} */
export function colorDepth(env = process.env, platform = process.platform) {
  if (typeof env.NO_COLOR === 'string' && env.NO_COLOR !== '') return 'none';
  const term = String(env.TERM || '').toLowerCase();
  if (term === 'dumb') return 'none';
  const ct = String(env.COLORTERM || '').toLowerCase();
  if (ct === 'truecolor' || ct === '24bit' || env.WT_SESSION || /^(iTerm|vscode|WezTerm|Hyper)/i.test(String(env.TERM_PROGRAM || ''))) return 'truecolor';
  if (platform === 'win32') return 'truecolor'; // Windows 10+ consoles render 24-bit SGR
  if (/256color/.test(term)) return '256';
  if (['linux', 'vt100', 'vt220', 'ansi', 'cons25', 'cygwin'].includes(term)) return '16';
  return '256';
}

function to256([r, g, b]) {
  if (r === g && g === b) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return 232 + Math.round(((r - 8) / 247) * 24);
  }
  const c = (v) => Math.round((v / 255) * 5);
  return 16 + 36 * c(r) + 6 * c(g) + c(b);
}

// The 16 ANSI colours (typical xterm values) for nearest-colour matching: index 0-7 normal, 8-15 bright.
const ANSI16 = [[0, 0, 0], [205, 49, 49], [13, 188, 121], [229, 229, 16], [36, 114, 200], [188, 63, 188], [17, 168, 205], [229, 229, 229],
  [102, 102, 102], [241, 76, 76], [35, 209, 139], [245, 245, 67], [59, 142, 234], [214, 112, 214], [41, 184, 219], [255, 255, 255]];
function to16([r, g, b]) {
  let best = 0, bd = Infinity;
  ANSI16.forEach(([R, G, B], i) => { const d = (r - R) ** 2 + (g - G) ** 2 + (b - B) ** 2; if (d < bd) { bd = d; best = i; } });
  return best;
}
const fg16 = (i) => (i < 8 ? 30 + i : 90 + i - 8);
const bg16 = (i) => (i < 8 ? 40 + i : 100 + i - 8);

/** SGR parameter string for a cell style under a given colour depth. '' = default style. */
export function sgr(style, depth) {
  if (!style) return '';
  const parts = [];
  if (style.bold) parts.push('1');
  if (style.dim) parts.push('2');
  if (style.inverse || (style.invertIfNoColor && depth === 'none')) parts.push('7');
  if (depth !== 'none') {
    if (style.fg) parts.push(depth === 'truecolor' ? `38;2;${style.fg.join(';')}` : depth === '16' ? String(fg16(to16(style.fg))) : `38;5;${to256(style.fg)}`);
    if (style.bg) parts.push(depth === 'truecolor' ? `48;2;${style.bg.join(';')}` : depth === '16' ? String(bg16(to16(style.bg))) : `48;5;${to256(style.bg)}`);
  }
  return parts.join(';');
}

// Named styles. In NO_COLOR mode the same roles degrade to weight/inversion only (sgr() drops fg/bg).
export const S = {
  ink: { fg: PALETTE.ink },
  strong: { fg: PALETTE.ink, bold: true },
  muted: { fg: PALETTE.muted },
  faint: { fg: PALETTE.faint },
  title: { fg: PALETTE.accentBright, bold: true },
  brand: { fg: PALETTE.accent, bold: true },
  signal: { fg: PALETTE.accentBright, bold: true }, // focus marker, newest-block pulse
  accent: { fg: PALETTE.accentBright },
  focus: { fg: PALETTE.ink, bg: PALETTE.accent, bold: true },
  selected: { fg: PALETTE.ink, bold: true, inverse: true },
  up: { fg: PALETTE.up },
  ok: { fg: PALETTE.up },
  down: { fg: PALETTE.muted }, // a sell / a fall is not an error; the arrow glyph carries the meaning
  danger: { fg: PALETTE.danger, bold: true }, // danger and failure only
  warn: { fg: PALETTE.warn },
  key: { fg: PALETTE.accentBright, bold: true },
};
