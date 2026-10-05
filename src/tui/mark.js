// packages/hartii-cli/src/tui/mark.js
//
// Bespoke Hartii glyphs, drawn from the product rather than a stock set:
//  - the purple camel (two humps = the Bactrian camel Hartii is named for), pixel art rendered with
//    half-blocks so one character row carries two pixel rows;
//  - LED numerals (3x5 dot-matrix) for the live block height — the chain's cadence is the signature
//    moment of this terminal.
import { PALETTE } from './theme.js';

// 16 x 8 pixels. 'o' = body, 'h' = hump highlight, 'e' = eye (the one red pixel), '.' = empty.
const CAMEL = [
  '.............ooo..',
  '..hh..hh....oeooo.',
  '.hhhh.hhhh..ooooo.',
  '.oooooooooo.oo....',
  '.ooooooooooooo....',
  '.oooooooooooo.....',
  '.oo.oo....oo.oo...',
  '.oo.oo....oo.oo...',
];

const PIX = { o: PALETTE.camel, h: PALETTE.camelLight, e: PALETTE.signal };

export const CAMEL_W = 18;
export const CAMEL_H = 4;

/** Paints the camel at (x, y) as 4 terminal rows x 18 columns. */
export function drawCamel(screen, x, y) {
  for (let r = 0; r < CAMEL_H; r += 1) {
    const top = CAMEL[r * 2];
    const bot = CAMEL[r * 2 + 1];
    for (let c = 0; c < CAMEL_W; c += 1) {
      const t = PIX[top[c]];
      const b = PIX[bot[c]];
      if (!t && !b) continue;
      if (t && b) screen.put(x + c, y + r, '▀', { fg: t, bg: b });
      else if (t) screen.put(x + c, y + r, '▀', { fg: t });
      else screen.put(x + c, y + r, '▄', { fg: b });
    }
  }
  return { w: CAMEL_W, h: CAMEL_H };
}

// 3 x 5 LED digits.
const LED = {
  0: ['###', '#.#', '#.#', '#.#', '###'],
  1: ['.#.', '##.', '.#.', '.#.', '###'],
  2: ['###', '..#', '###', '#..', '###'],
  3: ['###', '..#', '###', '..#', '###'],
  4: ['#.#', '#.#', '###', '..#', '..#'],
  5: ['###', '#..', '###', '..#', '###'],
  6: ['###', '#..', '###', '#.#', '###'],
  7: ['###', '..#', '.#.', '.#.', '.#.'],
  8: ['###', '#.#', '###', '#.#', '###'],
  9: ['###', '#.#', '###', '..#', '###'],
  ',': ['..', '..', '..', '.#', '#.'],
};

/** Width in columns of `text` rendered as LED numerals (digits 3 wide, comma 2 wide, 1 gap). */
export function ledWidth(text) {
  let w = 0;
  for (const ch of String(text)) if (LED[ch]) w += (ch === ',' ? 2 : 3) + 1;
  return Math.max(0, w - 1);
}

/** Draws digits/commas as 3 terminal rows (5 pixel rows + 1 blank) at (x, y). Returns the width. */
export function drawLed(screen, x, y, text, st) {
  let cx = x;
  for (const ch of String(text)) {
    const g = LED[ch];
    if (!g) continue;
    const w = ch === ',' ? 2 : 3;
    for (let r = 0; r < 3; r += 1) {
      const a = g[r * 2] || '.'.repeat(w);
      const b = g[r * 2 + 1] || '.'.repeat(w);
      for (let c = 0; c < w; c += 1) {
        const t = a[c] === '#';
        const u = b[c] === '#';
        if (t && u) screen.put(cx + c, y + r, '█', st);
        else if (t) screen.put(cx + c, y + r, '▀', st);
        else if (u) screen.put(cx + c, y + r, '▄', st);
      }
    }
    cx += w + 1;
  }
  return cx - x - 1;
}
