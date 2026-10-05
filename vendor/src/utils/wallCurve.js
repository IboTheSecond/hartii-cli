// Pure price-curve + color/message logic for the Wall of Blocks — no DOM, no
// network, no quais. Local mirror of QuaiWallV2's bytecode arithmetic, same
// discipline as the testnet prototype (hartii-sandbox/wall-of-blocks/src/lib/curve.js):
// this module's numbers must match the deployed contract exactly. Unit-tested in
// test/wallCurve.test.js (BigInt math, UTF-8 byte counting, color<->hex).

import { MAX_MESSAGE_LEN, MAX_WALL_NAME, PRICE_SLOPE_DIV } from '../abi/quaiWallV2.js';

export { MAX_MESSAGE_LEN, MAX_WALL_NAME, PRICE_SLOPE_DIV };

/**
 * Mirror of QuaiWallV2.priceOf(): slot price for the (blockCount+1)-th
 * engraving on a wall with the given snapshotted base.
 * priceOf = base + base * blockCount / PRICE_SLOPE_DIV
 * @param {bigint|string|number} basePriceWei
 * @param {bigint|string|number} blockCount
 * @returns {bigint} price in wei
 */
export function priceAt(basePriceWei, blockCount) {
  const base = BigInt(basePriceWei);
  const n = BigInt(blockCount);
  if (base < 0n || n < 0n) throw new Error('negative curve input');
  return base + (base * n) / PRICE_SLOPE_DIV;
}

/**
 * The next `count` slot prices from the current block count — the wall
 * page's "price ladder" strip.
 * @returns {bigint[]}
 */
export function priceLadder(basePriceWei, blockCount, count = 5) {
  const out = [];
  for (let i = 0n; i < BigInt(count); i += 1n) {
    out.push(priceAt(basePriceWei, BigInt(blockCount) + i));
  }
  return out;
}

/**
 * Byte length of a string as Solidity sees it (UTF-8 bytes, not JS UTF-16
 * code units) — the contract caps BYTES, so multibyte input must be counted
 * the same way or valid input could revert on-chain.
 */
export function byteLength(s) {
  return new TextEncoder().encode(String(s ?? '')).length;
}

/** Validate an engraving message locally with the contract's own rules. */
export function validateMessage(message) {
  const bytes = byteLength(message);
  if (bytes === 0) return { ok: false, error: 'Message is empty.', bytes };
  if (bytes > MAX_MESSAGE_LEN) {
    return { ok: false, error: `Message is ${bytes} bytes (max ${MAX_MESSAGE_LEN}).`, bytes };
  }
  return { ok: true, bytes };
}

/** Validate a wall name locally with the contract's own rules. */
export function validateWallName(name) {
  const bytes = byteLength(name);
  if (bytes === 0) return { ok: false, error: 'Name is empty.', bytes };
  if (bytes > MAX_WALL_NAME) {
    return { ok: false, error: `Name is ${bytes} bytes (max ${MAX_WALL_NAME}).`, bytes };
  }
  return { ok: true, bytes };
}

// ---- color (uint24 <-> hex, chosen by the engraver, rendered as a
//      background value ONLY — never interpolated into markup) ----

/** "#e5243b" | "e5243b" -> 0xe5243b as a number, or null if invalid. */
export function hexToColor(hex) {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(String(hex ?? '').trim());
  if (!m) return null;
  return parseInt(m[1], 16);
}

/** 0xe5243b -> "#e5243b". Clamps to the uint24 range like the ABI does. */
export function colorToHex(color) {
  const c = Number(BigInt(color) & 0xffffffn);
  return `#${c.toString(16).padStart(6, '0')}`;
}

/**
 * Whether dark text reads better on this block color (relative-luminance cut
 * at 0.55) — the grid draws each block's index label in a color that stays
 * legible on the engraver's chosen background.
 */
export function prefersDarkText(color) {
  const c = Number(BigInt(color) & 0xffffffn);
  const r = (c >> 16) & 0xff;
  const g = (c >> 8) & 0xff;
  const b = c & 0xff;
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return lum > 0.55;
}

/** The engrave form's preset swatches (on-brand first, then a usable range). */
export const PRESET_COLORS = [
  0x7c3aed, 0x0a0a0b, 0xececef, 0x4ade80, 0xfbbf24, 0x38bdf8,
  0xe5243b, 0xf472b6, 0xfb923c, 0x2dd4bf, 0x64748b, 0x84cc16,
];
