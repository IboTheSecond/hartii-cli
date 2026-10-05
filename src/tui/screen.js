// packages/hartii-cli/src/tui/screen.js
//
// A tiny cell buffer. Every glyph the TUI draws is one terminal column wide (no emoji / CJK), so a
// frame is cols x rows cells, and layout code never has to measure ANSI-wrapped strings. The same
// buffer serialises to ANSI (the real terminal) or to plain text (the snapshot tests).
import { sgr } from './theme.js';
import { safeTerminalText } from '../output.js';

export class Screen {
  constructor(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    this.cells = Array.from({ length: rows }, () => Array.from({ length: cols }, () => ({ ch: ' ', st: null })));
  }

  /** Writes `text` (sanitised, single line) at (x, y), clipped to the screen / optional `maxW`. Returns the width written. */
  put(x, y, text, st = null, maxW = Infinity) {
    if (y < 0 || y >= this.rows) return 0;
    const chars = Array.from(safeTerminalText(String(text)));
    let n = 0;
    for (const ch of chars) {
      const cx = x + n;
      if (n >= maxW || cx >= this.cols) break;
      if (cx >= 0) this.cells[y][cx] = { ch, st };
      n += 1;
    }
    return n;
  }

  /** Right-aligns `text` so it ends at column `xEnd` (exclusive). */
  putRight(xEnd, y, text, st = null) {
    const len = Array.from(safeTerminalText(String(text))).length;
    return this.put(xEnd - len, y, text, st);
  }

  fill(x, y, w, h, ch = ' ', st = null) {
    for (let j = 0; j < h; j += 1) for (let i = 0; i < w; i += 1) this.put(x + i, y + j, ch, st);
  }

  hline(x, y, w, ch = '─', st = null) { this.fill(x, y, w, 1, ch, st); }
  vline(x, y, h, ch = '│', st = null) { this.fill(x, y, 1, h, ch, st); }

  /** Draws a rounded box outline (no fill). */
  box(x, y, w, h, st = null) {
    if (w < 2 || h < 2) return;
    this.hline(x + 1, y, w - 2, '─', st);
    this.hline(x + 1, y + h - 1, w - 2, '─', st);
    this.vline(x, y + 1, h - 2, '│', st);
    this.vline(x + w - 1, y + 1, h - 2, '│', st);
    this.put(x, y, '╭', st); this.put(x + w - 1, y, '╮', st);
    this.put(x, y + h - 1, '╰', st); this.put(x + w - 1, y + h - 1, '╯', st);
  }

  /** Dims everything drawn so far (used behind a modal overlay so the foreground reads first). */
  dimAll() {
    for (const row of this.cells) for (const c of row) c.st = { ...(c.st || {}), dim: true, bold: false };
  }

  /** Plain text frame, trailing spaces trimmed — used by the snapshot tests. */
  toPlain() {
    return this.cells.map((row) => row.map((c) => c.ch).join('').replace(/\s+$/, '')).join('\n');
  }

  /** ANSI frame: one string per row, style changes only where they happen, always ends reset. */
  toAnsiRows(depth = 'truecolor') {
    return this.cells.map((row) => {
      let out = '';
      let cur = '';
      for (const c of row) {
        const want = sgr(c.st, depth);
        if (want !== cur) { out += want ? `\u001b[0;${want}m` : '\u001b[0m'; cur = want; }
        out += c.ch;
      }
      return cur ? `${out}\u001b[0m` : out;
    });
  }
}
