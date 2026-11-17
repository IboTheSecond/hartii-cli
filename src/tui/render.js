// packages/hartii-cli/src/tui/render.js
//
// renderFrame(state, cols, rows) -> Screen. Pure: same state in, same frame out (the snapshot tests
// rely on it). Direction (see the design notes): a nocturnal, precise terminal whose signature
// moment is the BLOCK RIBBON — the live height in LED numerals plus the last 32 blocks drawn as a
// strip (cell height = QUAI traded in that block, colour = net flow, newest block pulses Hartii red
// then cools to camel purple). Hierarchy comes from size/weight/position and hairlines, not boxes:
// panes are titled rules, only overlays get a frame.
import { Screen } from './screen.js';
import { S, PALETTE } from './theme.js';
import { drawHome, MENU, FOCUS_ORDER, statusLine } from './home.js';
import { clip, padR } from './format.js';
import { qrDims, drawQr } from '../qr.js';

export const MIN_COLS = 60;
export const MIN_ROWS = 18;
export { MENU, FOCUS_ORDER };

export const defaultUi = () => ({ focus: 'actions', menu: 0, watchSel: 0, tradeScroll: 0, overlay: null, status: null, countUp: null });

/** Full-screen Receive geometry: never crop a QR or its four-module quiet zone. ASCII mode needs a taller terminal. */
export function receiveLayout(o, cols, rows, ascii = false) {
  const size = o.details?.qr?.matrix?.length || 0;
  const { width, height } = qrDims(size, { ascii });
  return { qrFits: size > 0 && cols >= width + 6 && rows >= height + 5, qr: { x: 1, y: 2, width, height }, side: { x: width + 3, y: 2, width: cols - width - 4 } };
}

function receiveOverlay(s, cols, rows, o) {
  s.fill(0, 0, cols, rows, ' ', S.ink);
  s.put(1, 0, `RECEIVE QUAI  ${o.walletName || ''}`, S.title, cols - 2);
  s.put(1, 1, `${o.network || ''} · Cyprus-1`, S.muted, cols - 2);
  s.put(1, rows - 1, '[A] Copy address  [L] Copy paylink  Esc back', S.key, cols - 2);
  if (o.status !== 'ready') { s.put(1, 4, o.message || 'Preparing receiving details...', o.status === 'error' ? S.danger : S.muted, cols - 2); return; }
  const L = receiveLayout(o, cols, rows, s.ascii);
  if (!L.qrFits) {
    s.put(1, 3, `Resize to at least ${L.qr.width + 6}x${L.qr.height + 5} for the complete QR.`, S.warn, cols - 2);
    wrapLine(o.details.address, cols - 2).forEach((line, i) => s.put(1, 5 + i, line, S.ink));
    s.put(1, rows - 2, o.message, o.messageKind === 'ok' ? S.up : S.warn, cols - 2);
    return;
  }
  drawQr(s, L.qr.x, L.qr.y, o.details.qr.matrix, { ascii: s.ascii });
  let y = L.side.y;
  const put = (text, style = S.ink) => {
    for (const line of wrapLine(text, Math.max(4, L.side.width))) { if (y < rows - 3) s.put(L.side.x, y++, line, style, L.side.width); }
  };
  put('YOUR ADDRESS', S.muted); put(o.details.address, S.title); y++;
  put('HARTIIBIOME PAYLINK', S.muted);
  put(o.details.paylink || 'Paylinks require mainnet.', o.details.paylink ? S.ink : S.warn);
  y++; put('QR: public address only. Check the payer network.', S.muted);
  if (o.details.demo) put('DEMO - Do not send funds.', S.warn);
  s.put(1, rows - 2, o.message, o.messageKind === 'ok' ? S.up : o.messageKind === 'error' ? S.danger : S.muted, cols - 2);
}

// ---------------- overlays ----------------
function overlayBox(s, cols, rows, title, w, h) {
  const x = Math.max(0, Math.floor((cols - w) / 2));
  const y = Math.max(0, Math.floor((rows - h) / 2));
  s.fill(x, y, w, h, ' ', null);
  s.box(x, y, w, h, { fg: PALETTE.accent });
  s.put(x + 2, y, ` ${title} `, S.title);
  return { x, y, w, h };
}

function helpOverlay(s, cols, rows) {
  const lines = [
    ['↑ ↓  ← →', 'move within a pane / the action bar'],
    ['Tab · Shift-Tab', 'switch pane (actions, balances, watch, trades)'],
    ['Enter', 'open the selected action / confirm a field'],
    ['Esc', 'close a form or overlay, back to actions'],
    ['a · d', 'watchlist: add / remove the selected token'],
    ['r', 'refresh balances and watchlist now'],
    ['y · n', 'confirm / cancel a transaction summary'],
    ['q · Ctrl-C', 'quit and restore the terminal'],
  ];
  const w = Math.min(cols - 4, 70);
  const h = lines.length + 7;
  const b = overlayBox(s, cols, rows, 'KEYS', w, h);
  lines.forEach(([k, d], i) => { s.put(b.x + 3, b.y + 2 + i, padR(k, 17), S.key); s.put(b.x + 21, b.y + 2 + i, clip(d, w - 24), S.ink); });
  s.put(b.x + 3, b.y + h - 4, 'Every write shows the exact simulated summary first.', S.muted, w - 6);
  s.put(b.x + 3, b.y + h - 3, 'Spending limits apply to every action; keys stay in the keystore.', S.muted, w - 6);
}

function formOverlay(s, cols, rows, o) {
  const w = Math.min(cols - 4, 70);
  const h = Math.min(rows - 2, o.fields.length * 3 + 6);
  const b = overlayBox(s, cols, rows, o.title.toUpperCase(), w, h);
  let y = b.y + 2;
  const cap = Math.max(1, Math.floor((h - 5) / 3));
  const start = Math.max(0, Math.min(o.index - cap + 1, o.fields.length - cap));
  o.fields.slice(start, start + cap).forEach((f, offset) => {
    const i = start + offset;
    if (y + 2 >= b.y + h - 2) return;
    const active = i === o.index;
    s.put(b.x + 3, y, f.label, active ? S.title : S.muted);
    if (f.optional) s.put(b.x + 3 + f.label.length + 1, y, 'optional', S.faint);
    let shown;
    if (f.type === 'select') shown = `◂ ${f.options[f.selected ?? 0]} ▸`;
    else shown = f.mask ? '•'.repeat(String(f.value || '').length) : String(f.value || '');
    const field = clip(shown, w - 8);
    s.put(b.x + 3, y + 1, (active ? '› ' : '  ') + field, active ? { fg: PALETTE.ink, bold: true } : S.ink);
    if (active && f.type !== 'select') s.put(b.x + 5 + Array.from(field).length, y + 1, '▏', S.signal);
    if (!field && f.placeholder) s.put(b.x + 5, y + 1, clip(f.placeholder, w - 10), S.faint);
    if (f.error) s.put(b.x + 3, y + 2, `✕ ${clip(f.error, w - 8)}`, S.danger);
    else if (f.hint && active) s.put(b.x + 3, y + 2, clip(f.hint, w - 8), S.faint);
    y += 3;
  });
  s.put(b.x + 3, b.y + h - 2, 'Enter next/submit · Tab field · Esc cancel', S.faint);
}

/** Hard-wraps one summary line to `width` code points (nothing is ever clipped away in a confirm overlay). */
function wrapLine(text, width) {
  const chars = Array.from(String(text));
  return chars.length <= width ? [chars.join('')] : rewrap(chars, width);
}
function rewrap(chars, width) {
  const out = [];
  let i = 0;
  while (i < chars.length) {
    const room = out.length ? width - 2 : width;
    out.push((out.length ? '  ' : '') + chars.slice(i, i + room).join(''));
    i += room;
  }
  return out;
}

/**
 * Geometry of a confirm overlay: EVERY summary line is wrapped (never clipped) and the visible window scrolls.
 * `tooSmall` means the transaction cannot be reviewed at this terminal size, so it must not be confirmable.
 */
export function confirmLayout(o, cols, rows) {
  const raw = (o.lines || []).map((l) => (typeof l === 'string' ? { text: l, st: S.ink } : { text: String(l.text), st: l.st || S.ink }));
  const w = Math.min(cols - 4, Math.max(40, ...raw.map((l) => Array.from(l.text).length + 6), o.title.length + 8));
  const lines = raw.flatMap((l) => wrapLine(l.text, w - 6).map((text) => ({ text, st: l.st })));
  const h = Math.min(rows - 2, lines.length + 6);
  const cap = h - 5;
  return { w, h, cap, lines, maxScroll: Math.max(0, lines.length - cap), tooSmall: lines.length > cap && cap < 5 };
}

function confirmOverlay(s, cols, rows, o) {
  const L = confirmLayout(o, cols, rows);
  const b = overlayBox(s, cols, rows, o.title.toUpperCase(), L.w, L.h);
  if (L.tooSmall) {
    s.put(b.x + 3, b.y + 2, clip('Terminal too small to review this transaction: resize or use the CLI.', L.w - 6), S.warn);
    s.put(b.x + 3, b.y + L.h - 2, 'n  cancel', S.key);
    return;
  }
  const scroll = Math.min(Math.max(0, o.scroll || 0), L.maxScroll);
  L.lines.slice(scroll, scroll + L.cap).forEach((l, i) => s.put(b.x + 3, b.y + 2 + i, clip(l.text, L.w - 6), l.st));
  if (L.maxScroll > 0) {
    const below = L.lines.length - (scroll + L.cap);
    const marks = [scroll > 0 ? `▲ ${scroll} above` : '', below > 0 ? `▼ ${below} more line${below === 1 ? '' : 's'}` : 'end of summary'].filter(Boolean).join(' · ');
    s.put(b.x + 3, b.y + L.h - 3, clip(marks, L.w - 6), S.warn);
  }
  const atEnd = scroll >= L.maxScroll;
  const footer = o.notice || (atEnd ? o.footer : '↑↓ PgUp PgDn scroll, y at the end · n cancel');
  s.put(b.x + 3, b.y + L.h - 2, clip(footer, L.w - 6), S.key);
}

function textOverlay(s, cols, rows, o) {
  if (o.type === 'result') {
    const L = confirmLayout(o, cols, rows);
    const b = overlayBox(s, cols, rows, o.title.toUpperCase(), L.w, L.h);
    const scroll = Math.min(Math.max(0, o.scroll || 0), L.maxScroll);
    L.lines.slice(scroll, scroll + L.cap).forEach((line, i) => s.put(b.x + 3, b.y + 2 + i, line.text, line.st, L.w - 6));
    if (L.maxScroll > 0) s.put(b.x + 3, b.y + L.h - 3, `${scroll + 1}-${Math.min(scroll + L.cap, L.lines.length)} of ${L.lines.length} · ↑↓ PgUp PgDn Home End`, S.muted, L.w - 6);
    if (o.footer) s.put(b.x + 3, b.y + L.h - 2, o.footer, S.key, L.w - 6);
    return;
  }
  const lines = o.lines || [];
  const w = Math.min(cols - 4, Math.max(40, ...lines.map((l) => Array.from(String(l.text ?? l)).length + 6), o.title.length + 8));
  const h = Math.min(rows - 2, lines.length + 6);
  const b = overlayBox(s, cols, rows, o.title.toUpperCase(), w, h);
  const cap = Math.max(1, h - 5);
  const start = o.type === 'list' ? Math.max(0, Math.min(o.index - cap + 1, lines.length - cap)) : 0;
  lines.slice(start, start + cap).forEach((l, i) => {
    const text = typeof l === 'string' ? l : l.text;
    const st = typeof l === 'string' ? S.ink : (l.st || S.ink);
    s.put(b.x + 3, b.y + 2 + i, clip(text, w - 6), st);
  });
  if (o.footer) s.put(b.x + 3, b.y + h - 2, clip(o.footer, w - 6), S.key);
}

function overlays(s, cols, rows, o) {
  if (!o) return;
  if (o.type === 'receive') return receiveOverlay(s, cols, rows, o);
  if (o.type === 'help') return helpOverlay(s, cols, rows);
  if (o.type === 'form' || o.type === 'prompt') return formOverlay(s, cols, rows, o);
  if (o.type === 'confirm') return confirmOverlay(s, cols, rows, o);
  return textOverlay(s, cols, rows, o);
}

/**
 * @param {object} state demo/live data + `ui` (see defaultUi)
 * @param {number} cols
 * @param {number} rows
 */
export function renderFrame(state, cols, rows) {
  const s = new Screen(cols, rows, { ascii: Boolean(state.ascii) });
  const ui = { ...defaultUi(), ...(state.ui || {}) };
  if (cols < MIN_COLS || rows < MIN_ROWS) {
    s.put(1, Math.floor(rows / 2), clip(`Hartii needs at least ${MIN_COLS}x${MIN_ROWS} (this window is ${cols}x${rows}).`, cols - 2), S.warn);
    return s;
  }
  drawHome(s, state, ui, cols, rows);
  statusLine(s, state, cols, rows - 1, ui);
  if (ui.overlay) s.dimAll();
  overlays(s, cols, rows, ui.overlay);
  return s;
}
