// packages/hartii-cli/src/tui/theme.js
//
// Palette ROLES for the Hartii terminal (the frontend craft notes rules 3-4, translated to a terminal):
// neutral surfaces with a slight violet bias, ONE signal accent (Hartii red) for focus / state / the
// block pulse, the purple camel as the brand voice (mark, titles), and functional colours only for
// status (up/live = green, down/sell = rose, warn = amber). Never washes a whole pane in a colour.
// Contrast: ink on a dark terminal background is >= 7:1; muted >= 4.6:1; faint is for hairlines only.

export const PALETTE = {
  ink: [232, 230, 240], // body text
  muted: [150, 146, 170], // secondary text, labels
  faint: [75, 73, 96], // hairlines only — never text
  signal: [229, 36, 59], // Hartii red #E5243B — focus, selection, newest-block pulse
  camel: [139, 92, 246], // purple camel #8B5CF6
  camelLight: [167, 139, 250], // #A78BFA — titles, mark highlights
  up: [74, 222, 128], // status green #4ADE80
  down: [248, 113, 113], // sell / negative (functional, distinct from the brand signal)
  warn: [251, 191, 36],
};

/** @returns {'truecolor'|'256'|'none'} */
export function colorDepth(env = process.env) {
  if (typeof env.NO_COLOR === 'string' && env.NO_COLOR !== '') return 'none';
  const ct = String(env.COLORTERM || '').toLowerCase();
  if (ct === 'truecolor' || ct === '24bit' || env.WT_SESSION || /^(iTerm|vscode|WezTerm|Hyper)/i.test(String(env.TERM_PROGRAM || ''))) return 'truecolor';
  if (process.platform === 'win32') return 'truecolor'; // Windows 10+ consoles render 24-bit SGR
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

/** SGR parameter string for a cell style under a given colour depth. '' = default style. */
export function sgr(style, depth) {
  if (!style) return '';
  const parts = [];
  if (style.bold) parts.push('1');
  if (style.dim) parts.push('2');
  if (style.inverse) parts.push('7');
  if (depth !== 'none') {
    if (style.fg) parts.push(depth === 'truecolor' ? `38;2;${style.fg.join(';')}` : `38;5;${to256(style.fg)}`);
    if (style.bg) parts.push(depth === 'truecolor' ? `48;2;${style.bg.join(';')}` : `48;5;${to256(style.bg)}`);
  }
  return parts.join(';');
}

// Named styles. In NO_COLOR mode the same roles degrade to weight/inversion only (sgr() drops fg/bg).
export const S = {
  ink: { fg: PALETTE.ink },
  muted: { fg: PALETTE.muted },
  faint: { fg: PALETTE.faint },
  title: { fg: PALETTE.camelLight, bold: true },
  brand: { fg: PALETTE.camel, bold: true },
  signal: { fg: PALETTE.signal, bold: true },
  focus: { fg: PALETTE.ink, bg: PALETTE.signal, bold: true },
  selected: { fg: PALETTE.ink, bold: true, inverse: true },
  up: { fg: PALETTE.up },
  down: { fg: PALETTE.down },
  warn: { fg: PALETTE.warn },
  key: { fg: PALETTE.camelLight, bold: true },
};
