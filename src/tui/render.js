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
import { drawCamel, drawLed, ledWidth, CAMEL_W } from './mark.js';
import { group, fmtUnits, fmtPrice, fmtPct, shortAddr, clock, clip, padR } from './format.js';

export const MIN_COLS = 60;
export const MIN_ROWS = 18;
export const MENU = ['Send', 'Buy', 'Sell', 'Swap', 'Airdrop', 'OTC', 'Claim', 'Wall', 'Wallets', 'Settings'];
export const FOCUS_ORDER = ['actions', 'balances', 'watch', 'trades'];
const LEVELS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
const PULSE_MS = 2600;

/** 1234567 -> 1.23M (raw token units already scaled by the caller). */
function compactNum(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

export const defaultUi = () => ({ focus: 'actions', menu: 0, watchSel: 0, tradeScroll: 0, overlay: null, status: null });

/** Title rule for a pane: "▌TITLE ────── meta". Returns nothing; draws at (x,y) across w columns. */
function paneTitle(s, x, y, w, title, focused, meta) {
  s.put(x, y, focused ? '▌' : ' ', S.signal);
  s.put(x + 1, y, title, focused ? S.title : S.muted);
  const used = 1 + title.length + 1;
  if (w > used + 1) s.hline(x + used + 1, y, w - used - 1, '─', S.faint);
  if (meta) s.putRight(x + w, y, ` ${meta}`, S.muted);
}

function ribbon(s, x, y, w, history, now, blockAt, align = 'right') {
  const cells = history.slice(-w);
  const max = Math.max(0.0001, ...cells.map((c) => c.quai || 0));
  const start = align === 'left' ? x : x + w - cells.length;
  cells.forEach((c, i) => {
    const cx = start + i;
    const newest = i === cells.length - 1;
    const pulsing = newest && now - blockAt < PULSE_MS;
    if (!c.count) { s.put(cx, y, newest && pulsing ? '▁' : '·', newest && pulsing ? S.signal : S.faint); return; }
    const lvl = Math.min(7, Math.max(0, Math.round(((c.quai || 0) / max) * 7)));
    const st = pulsing ? S.signal : c.net > 0 ? S.up : c.net < 0 ? S.down : { fg: PALETTE.camel };
    s.put(cx, y, LEVELS[lvl], st);
  });
}

function liveBadge(state) {
  const l = state.live?.state;
  if (state.mode === 'demo' || l === 'demo') return { text: 'DEMO', st: S.warn };
  if (l === 'connected') return { text: '● LIVE', st: S.up };
  if (l === 'connecting') return { text: '○ connecting', st: S.muted };
  return { text: '○ polling', st: S.muted };
}

function header(s, state, cols, compact) {
  const now = state.now;
  const height = state.block?.height;
  const wallet = state.wallet;
  const quai = state.quaiWei != null ? fmtUnits(state.quaiWei, 18, 4) : '—';
  const age = state.block?.at ? Math.max(0, Math.floor((now - state.block.at) / 1000)) : null;
  if (!compact) {
    drawCamel(s, 1, 0);
    const x = 1 + CAMEL_W + 2;
    s.put(x, 0, 'H A R T I I', S.brand);
    s.put(x + 14, 0, 'terminal wallet for Quai', S.muted);
    s.put(x + 39, 0, ' BETA ', { fg: PALETTE.warn, bold: true, inverse: true });
    s.put(x, 1, `${state.network} · cyprus-1`, S.ink);
    s.put(x, 2, wallet ? `${wallet.name}  ${shortAddr(wallet.address, 8, 6)}` : 'no wallet — run `hartii wallet new`', wallet ? S.muted : S.warn);
    s.put(x, 3, `${quai} `, { fg: PALETTE.ink, bold: true });
    s.put(x + quai.length + 1, 3, 'QUAI', S.muted);
    if (height) {
      const txt = group(String(height), 0);
      const w = ledWidth(txt);
      const lx = cols - 2 - w;
      drawLed(s, lx, 0, txt, { fg: PALETTE.ink, bold: true });
      s.putRight(lx - 2, 1, 'BLOCK', S.muted);
      s.putRight(lx - 2, 2, age === null ? '' : `${age}s ago`, S.faint);
    }
    const rw = Math.min(32, Math.max(8, cols - (x + 42)));
    ribbon(s, cols - 2 - rw, 3, rw, state.block?.history || [], now, state.block?.at || 0);
    s.putRight(cols - 2 - rw - 1, 3, `last ${Math.min(rw, (state.block?.history || []).length)} blocks`, S.faint);
    s.hline(0, 4, cols, '─', S.faint);
    return 5;
  }
  s.put(1, 0, '∩∩', S.brand);
  s.put(4, 0, 'HARTII', S.brand);
  s.put(11, 0, 'BETA', { fg: PALETTE.warn, bold: true });
  s.put(16, 0, state.network, S.ink);
  if (height) s.put(16 + state.network.length + 2, 0, `#${group(String(height), 0)}`, { fg: PALETTE.ink, bold: true });
  s.putRight(cols - 1, 0, wallet ? `${shortAddr(wallet.address, 6, 4)}` : 'no wallet', wallet ? S.muted : S.warn);
  const qx = cols - 1 - (wallet ? shortAddr(wallet.address, 6, 4).length : 9) - 2;
  s.putRight(qx, 0, `${quai} QUAI`, { fg: PALETTE.ink, bold: true });
  const rw = Math.min(40, cols - 14);
  ribbon(s, 1, 1, rw, state.block?.history || [], now, state.block?.at || 0, 'left');
  s.put(Math.min(rw, (state.block?.history || []).length) + 2, 1, age === null ? '' : `${age}s`, S.faint);
  s.hline(0, 2, cols, '─', S.faint);
  return 3;
}

/** QUAI balance + every priced holding, in wei (portfolio API valueQuai is a wei string). Null until the balance is known. */
function portfolioTotalWei(state) {
  if (state.quaiWei == null) return null;
  try {
    return (state.holdings || []).reduce((t, h) => (h.valueQuai != null ? t + BigInt(h.valueQuai) : t), BigInt(state.quaiWei));
  } catch { return null; }
}

function balancesPane(s, state, x, y, w, h, focused) {
  const total = portfolioTotalWei(state);
  paneTitle(s, x, y, w, 'BALANCES', focused, total === null ? null : `≈ ${fmtUnits(total, 18, 2)} QUAI`);
  let row = y + 1;
  const quai = state.quaiWei != null ? fmtUnits(state.quaiWei, 18, 6) : '—';
  s.put(x + 1, row, 'QUAI', { fg: PALETTE.ink, bold: true });
  s.putRight(x + w - 1, row, quai, { fg: PALETTE.ink, bold: true });
  row += 1;
  const holds = state.holdings || [];
  if (state.holdingsError) { s.put(x + 1, row, clip(state.holdingsError, w - 2), S.warn); return; }
  if (!holds.length && row < y + h) { s.put(x + 1, row, 'no tokens held', S.muted); return; }
  const vw = 14;
  for (const hld of holds) {
    if (row >= y + h) break;
    s.put(x + 1, row, padR(hld.symbol || '???', 7), S.ink);
    const bal = fmtUnits(hld.balance, 18, 2);
    s.putRight(x + w - 1 - vw, row, bal, S.ink);
    const val = hld.valueQuai != null ? `≈ ${fmtUnits(hld.valueQuai, 18, 2)}` : '';
    s.putRight(x + w - 1, row, val, S.muted);
    row += 1;
  }
}

function watchPane(s, state, x, y, w, h, focused, ui) {
  paneTitle(s, x, y, w, 'WATCHLIST', focused, focused ? 'a add · d remove' : `${(state.watch || []).length} tokens`);
  const list = state.watch || [];
  if (!list.length) { s.put(x + 1, y + 1, 'empty — press a (focus this pane) to add a token', S.muted, w - 2); return; }
  list.slice(0, h - 1).forEach((t, i) => {
    const row = y + 1 + i;
    const sel = focused && i === ui.watchSel;
    s.put(x, row, sel ? '▸' : ' ', S.signal);
    s.put(x + 1, row, padR(t.symbol || '???', 7), sel ? { fg: PALETTE.ink, bold: true } : S.ink);
    s.putRight(x + w - 11, row, fmtPrice(t.priceWei), S.ink);
    const pct = t.change24h;
    const up = pct > 0;
    const st = pct === null || pct === undefined ? S.muted : up ? S.up : pct < 0 ? S.down : S.muted;
    s.putRight(x + w - 1, row, `${pct === null || pct === undefined ? ' ' : up ? '▲' : pct < 0 ? '▼' : '■'} ${fmtPct(pct)}`, st);
  });
}

function tradesPane(s, state, x, y, w, h, focused, ui) {
  paneTitle(s, x, y, w, 'LIVE TRADES', focused, 'per block · newest first');
  const trades = state.trades || [];
  if (!trades.length) { s.put(x + 1, y + 1, state.live?.state === 'connected' ? 'waiting for the next trade…' : 'feed offline — balances and actions still work', S.muted, w - 2); return; }
  const compact = w < 60;
  let row = y + 1;
  let prev = null;
  const start = Math.min(ui.tradeScroll, Math.max(0, trades.length - 1));
  for (let i = start; i < trades.length && row < y + h; i += 1) {
    const t = trades[i];
    if (t.blockNumber != null && t.blockNumber !== prev) {
      if (prev !== null || i === start) {
        const label = ` block ${group(String(t.blockNumber), 0)} `;
        s.put(x + 1, row, '──', S.faint);
        s.put(x + 3, row, label, S.muted);
        s.hline(x + 3 + label.length, row, Math.max(0, w - 4 - label.length), '─', S.faint);
        row += 1;
        if (row >= y + h) break;
      }
      prev = t.blockNumber;
    }
    const buy = t.side === 'buy';
    const st = buy ? S.up : S.down;
    let cx = x + 1;
    if (!compact) { s.put(cx, row, clock(t.ts), S.muted); cx += 10; }
    s.put(cx, row, buy ? '▲ BUY ' : t.side === 'burn' ? '✕ BURN' : '▼ SELL', st); cx += 7;
    s.put(cx, row, padR(t.symbol || '???', 6), S.ink); cx += 7;
    const q = t.quai == null ? '' : `${group(String(t.quai), 2)} QUAI`;
    s.putRight(cx + 13, row, q, { fg: PALETTE.ink, bold: true }); cx += 15;
    if (w >= 66 && t.token != null) { s.putRight(cx + 13, row, `${compactNum(t.token)} ${t.symbol || ''}`, S.muted); cx += 15; }
    if (cx + 8 < x + w) s.put(cx, row, shortAddr(t.trader, 6, 4), S.muted, x + w - cx - 1);
    row += 1;
  }
}

function actionsBar(s, state, cols, y, ui) {
  let x = 1;
  const focused = ui.focus === 'actions';
  MENU.forEach((name, i) => {
    const sel = i === ui.menu;
    const label = ` ${name} `;
    if (x + label.length >= cols) return;
    s.put(x, y, label, sel ? (focused ? S.focus : S.selected) : S.muted);
    x += label.length + 1;
  });
}

function statusLine(s, state, cols, y, ui) {
  const st = ui.status;
  if (st) s.put(1, y, clip(st.text, cols - 30), st.kind === 'error' ? S.down : st.kind === 'ok' ? S.up : S.muted);
  else s.put(1, y, 'Tab pane · ←→ action · Enter open', S.faint);
  const b = liveBadge(state);
  s.putRight(cols - 1, y, `? help · q quit   ${b.text}`, S.faint);
  s.putRight(cols - 1, y, b.text, b.st);
}

// ---------------- overlays ----------------
function overlayBox(s, cols, rows, title, w, h) {
  const x = Math.max(0, Math.floor((cols - w) / 2));
  const y = Math.max(0, Math.floor((rows - h) / 2));
  s.fill(x, y, w, h, ' ', null);
  s.box(x, y, w, h, { fg: PALETTE.camel });
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
  o.fields.forEach((f, i) => {
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
    if (f.error) s.put(b.x + 3, y + 2, `✕ ${clip(f.error, w - 8)}`, S.down);
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
  const lines = o.lines || [];
  const w = Math.min(cols - 4, Math.max(40, ...lines.map((l) => Array.from(String(l.text ?? l)).length + 6), o.title.length + 8));
  const h = Math.min(rows - 2, lines.length + 6);
  const b = overlayBox(s, cols, rows, o.title.toUpperCase(), w, h);
  lines.slice(0, h - 5).forEach((l, i) => {
    const text = typeof l === 'string' ? l : l.text;
    const st = typeof l === 'string' ? S.ink : (l.st || S.ink);
    s.put(b.x + 3, b.y + 2 + i, clip(text, w - 6), st);
  });
  if (o.footer) s.put(b.x + 3, b.y + h - 2, clip(o.footer, w - 6), S.key);
}

function overlays(s, cols, rows, o) {
  if (!o) return;
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
  const s = new Screen(cols, rows);
  const ui = { ...defaultUi(), ...(state.ui || {}) };
  if (cols < MIN_COLS || rows < MIN_ROWS) {
    s.put(1, Math.floor(rows / 2), clip(`Hartii needs at least ${MIN_COLS}x${MIN_ROWS} (this window is ${cols}x${rows}).`, cols - 2), S.warn);
    return s;
  }
  const compact = cols < 100 || rows < 30;
  const top = header(s, state, cols, compact);
  const bottom = rows - 2; // actions bar row; status = rows - 1
  const cy = top;
  const ch = bottom - cy - 1; // leave one blank row above the action bar
  if (!compact) {
    const lw = Math.max(46, Math.floor(cols * 0.4));
    const balH = Math.max(6, Math.floor(ch * 0.4));
    balancesPane(s, state, 1, cy, lw - 2, balH, ui.focus === 'balances');
    watchPane(s, state, 1, cy + balH + 1, lw - 2, ch - balH - 1, ui.focus === 'watch', ui);
    s.vline(lw, cy, ch, '│', S.faint);
    tradesPane(s, state, lw + 2, cy, cols - lw - 3, ch, ui.focus === 'trades', ui);
  } else {
    const half = Math.floor((cols - 3) / 2);
    const topH = Math.min(8, Math.max(5, Math.floor(ch * 0.42)));
    balancesPane(s, state, 1, cy, half - 1, topH, ui.focus === 'balances');
    s.vline(half + 1, cy, topH, '│', S.faint);
    watchPane(s, state, half + 3, cy, cols - half - 4, topH, ui.focus === 'watch', ui);
    tradesPane(s, state, 1, cy + topH + 1, cols - 2, ch - topH - 1, ui.focus === 'trades', ui);
  }
  actionsBar(s, state, cols, bottom, ui);
  statusLine(s, state, cols, rows - 1, ui);
  if (ui.overlay) s.dimAll();
  overlays(s, cols, rows, ui.overlay);
  return s;
}
