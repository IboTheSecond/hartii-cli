// packages/hartii-cli/src/tui/home.js
//
// The wallet-first home screen (everything under the overlays). Pure drawing into a Screen.
//   header   brand, BETA, network, wallet, block height + ribbon      (fields dropped by priority as width shrinks)
//   hero     the balance, big (LED numerals when they fit), "counts up" briefly when funds arrive
//   actions  Receive and Send as the two primary buttons; Trade (Buy Sell Swap) and Tools (Airdrop OTC Claim Wall)
//            one step away; Wallets and Settings
//   panes    token balances + watchlist, and the live trades feed (secondary)
// Layout tiers: narrow 60-79 columns, medium 80-99, wide 100+ (needs 30 rows for the full header).
// Motion is optional (`state.motion === false` freezes the pulse and the count-up). Meaning never rests on colour
// alone: selection uses brackets / a marker glyph, change uses arrows and signs, danger uses words.
import { S, PALETTE } from './theme.js';
import { drawCamel, drawLed, ledWidth, CAMEL_W } from './mark.js';
import { group, fmtUnits, fmtPrice, fmtPct, shortAddr, clock, clip, padR } from './format.js';

export const MENU = ['Receive', 'Send', 'Buy', 'Sell', 'Swap', 'Airdrop', 'OTC', 'Claim', 'Wall', 'Wallets', 'Settings'];
export const FOCUS_ORDER = ['actions', 'balances', 'watch', 'trades'];
export const PRIMARY = ['Receive', 'Send'];
export const TRADE = ['Buy', 'Sell', 'Swap'];
export const TOOLS = ['Airdrop', 'OTC', 'Claim', 'Wall'];
export const MORE = ['Wallets', 'Settings'];
const LEVELS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
export const PULSE_MS = 2600;
export const COUNT_UP_MS = 900;

const len = (t) => Array.from(String(t)).length;
export const tier = (cols) => (cols >= 100 ? 'wide' : cols >= 80 ? 'medium' : 'narrow');

function compactNum(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

/** Title rule for a pane: "▌TITLE ────── meta". */
export function paneTitle(s, x, y, w, title, focused, meta) {
  s.put(x, y, focused ? '▌' : ' ', S.signal);
  s.put(x + 1, y, title, focused ? S.title : S.muted);
  const used = 1 + len(title) + 1;
  const m = meta ? ` ${meta}` : '';
  const room = w - used - len(m);
  if (room > 1) s.hline(x + used + 1, y, room - 1, '─', S.faint);
  if (meta && room >= 0) s.putRight(x + w, y, m, S.muted);
}

function ribbon(s, x, y, w, history, now, blockAt, motion, align = 'right') {
  const cells = history.slice(-w);
  const max = Math.max(0.0001, ...cells.map((c) => c.quai || 0));
  const start = align === 'left' ? x : x + w - cells.length;
  cells.forEach((c, i) => {
    const cx = start + i;
    const newest = i === cells.length - 1;
    const pulsing = motion && newest && now - blockAt < PULSE_MS;
    if (!c.count) { s.put(cx, y, newest && pulsing ? '▁' : '·', newest && pulsing ? S.signal : S.faint); return; }
    const lvl = Math.min(7, Math.max(0, Math.round(((c.quai || 0) / max) * 7)));
    const st = pulsing ? S.signal : c.net > 0 ? S.up : c.net < 0 ? S.muted : { fg: PALETTE.accent };
    s.put(cx, y, LEVELS[lvl], st);
  });
}

export function liveBadge(state) {
  const l = state.live?.state;
  if (state.mode === 'demo' || l === 'demo') return { text: 'DEMO', st: S.warn };
  if (l === 'connected') {
    const at = state.live?.receivedAt || state.block?.at || 0;
    if (!at || (state.now ?? Date.now()) - at > 30000) return { text: '◌ stale', st: S.warn };
    return { text: '● LIVE', st: S.up };
  }
  if (l === 'connecting') return { text: '○ connecting', st: S.muted };
  return { text: '○ polling', st: S.muted };
}

// ------------------------------------------------------------------------------------------------ header
function header(s, state, cols, rows, motion) {
  const now = state.now;
  const height = state.block?.height;
  const wallet = state.wallet;
  const age = state.block?.at ? Math.max(0, Math.floor((now - state.block.at) / 1000)) : null;
  const hist = state.block?.history || [];
  const badge = liveBadge(state);
  const walletText = wallet ? `${wallet.name}  ${shortAddr(wallet.address, 8, 6)}` : 'no wallet yet';
  if (cols >= 100 && rows >= 30) {
    drawCamel(s, 1, 0);
    const x = 1 + CAMEL_W + 2;
    s.put(x, 0, 'H A R T I I', S.brand);
    s.put(x + 13, 0, ' BETA ', { fg: PALETTE.warn, bold: true, inverse: true });
    let lx = cols - 2;
    if (height) {
      const txt = group(String(height), 0);
      const w = ledWidth(txt);
      lx = cols - 2 - w;
      drawLed(s, lx, 0, txt, { fg: PALETTE.ink, bold: true });
      s.putRight(lx - 2, 1, 'BLOCK', S.muted);
      s.putRight(lx - 2, 2, age === null ? '' : `${age}s ago`, S.faint);
    }
    const bound = lx - 10;
    const net = `${state.network} · cyprus-1`;
    s.put(x, 1, net, S.ink);
    if (x + len(net) + 3 + len(badge.text) < bound) s.put(x + len(net) + 3, 1, badge.text, badge.st);
    s.put(x, 2, walletText, wallet ? S.muted : S.warn, bound - x);
    const tag = 'terminal wallet for Quai';
    if (x + len(tag) < bound) s.put(x, 3, tag, S.faint);
    const rw = Math.min(32, Math.max(0, cols - 2 - (x + len(tag) + 4)));
    if (rw >= 8) {
      ribbon(s, cols - 2 - rw, 3, rw, hist, now, state.block?.at || 0, motion);
      const lab = `last ${Math.min(rw, hist.length)} blocks`;
      if (cols - 2 - rw - 1 - len(lab) > x + len(tag) + 2) s.putRight(cols - 2 - rw - 1, 3, lab, S.faint);
    }
    s.hline(0, 4, cols, '─', S.faint);
    return 5;
  }
  // compact header (2 rows + rule). Priority: brand+BETA > network > wallet > live badge > block > ribbon.
  s.put(1, 0, '∩∩', S.brand);
  s.put(4, 0, 'HARTII', S.brand);
  s.put(11, 0, 'BETA', { fg: PALETTE.warn, bold: true });
  const net = `${state.network} · cyprus-1`;
  const right = [];
  right.push({ t: net, st: S.ink });
  if (cols >= 72) right.push({ t: badge.text, st: badge.st });
  let rx = cols - 1;
  for (const it of right.slice().reverse()) {
    const w = len(it.t);
    if (rx - w <= 17) break;
    s.putRight(rx, 0, it.t, it.st);
    rx -= w + 2;
  }
  // row 1: wallet on the left, block + ribbon on the right, whatever fits
  const wtxt = wallet ? `${wallet.name}  ${shortAddr(wallet.address, cols >= 80 ? 8 : 6, cols >= 80 ? 6 : 4)}` : 'no wallet yet';
  s.put(1, 1, wtxt, wallet ? S.muted : S.warn, cols - 2);
  let bx = cols - 1;
  const blk = height ? `#${group(String(height), 0)}${age === null ? '' : ` ${age}s`}` : '';
  if (blk && bx - len(blk) > 1 + len(wtxt) + 3) { s.putRight(bx, 1, blk, { fg: PALETTE.ink, bold: true }); bx -= len(blk) + 1; }
  const rw = Math.min(32, bx - (1 + len(wtxt) + 3) - 1);
  if (rw >= 8 && hist.length) ribbon(s, bx - rw, 1, rw, hist, now, state.block?.at || 0, motion);
  s.hline(0, 2, cols, '─', S.faint);
  return 3;
}

// ------------------------------------------------------------------------------------------------ hero
/** The balance shown right now: counts up from the previous value for COUNT_UP_MS after funds arrive. */
export function shownWei(state, ui, motion) {
  if (state.quaiWei == null) return null;
  let to;
  try { to = BigInt(state.quaiWei); } catch { return null; }
  const cu = ui.countUp;
  if (!cu || !motion) return to;
  const t = Math.min(1, Math.max(0, (state.now - cu.at) / COUNT_UP_MS));
  if (t >= 1) return to;
  const ease = 1 - (1 - t) ** 3;
  const from = BigInt(cu.fromWei);
  return from + ((to - from) * BigInt(Math.round(ease * 1000))) / 1000n;
}

function portfolioTotalWei(state) {
  if (state.quaiWei == null) return null;
  try { return (state.holdings || []).reduce((t, h) => (h.valueQuai != null ? t + BigInt(h.valueQuai) : t), BigInt(state.quaiWei)); } catch { return null; }
}

function hero(s, state, ui, y, cols, rows, motion) {
  const wei = shownWei(state, ui, motion);
  const total = portfolioTotalWei(state);
  if (!state.wallet) {
    s.put(1, y, 'BALANCE', S.muted);
    s.put(1, y + 1, 'No wallet yet. Open Wallets to create or import one.', S.warn, cols - 2);
    return 3;
  }
  s.put(1, y, 'BALANCE', S.muted);
  if (total !== null && state.holdings?.length) {
    const t = `≈ ${fmtUnits(total, 18, 2)} QUAI with tokens`;
    if (len(t) + 12 < cols) s.putRight(cols - 1, y, t, S.muted);
  }
  if (wei === null) { s.put(1, y + 1, state.holdingsError ? 'balance unavailable' : 'loading…', S.muted); return 2; }
  const roomy = rows >= 24;
  let txt = fmtUnits(wei, 18, 4);
  if (roomy && cols >= 70) {
    if (ledWidth(txt) + 8 > cols - 2) txt = fmtUnits(wei, 18, 2);
    if (ledWidth(txt) + 8 <= cols - 2) {
      const w = drawLed(s, 1, y + 1, txt, { fg: PALETTE.ink, bold: true });
      s.put(1 + w + 2, y + 3, 'QUAI', S.accent);
      return 4;
    }
  }
  s.put(1, y + 1, txt, { fg: PALETTE.ink, bold: true });
  s.put(1 + len(txt) + 1, y + 1, 'QUAI', S.accent);
  return 2;
}

// ------------------------------------------------------------------------------------------------ actions
function button(s, x, y, w, h, label, glyph, selected, focused) {
  const on = selected && focused;
  const edge = on ? { fg: PALETTE.accentBright, bold: true } : selected ? { fg: PALETTE.accent, bold: true } : S.faint;
  const text = on ? S.focus : selected ? S.strong : S.ink;
  if (h >= 3) {
    s.box(x, y, w, 3, edge);
    if (on) s.fill(x + 1, y + 1, w - 2, 1, ' ', S.focus);
    const t = `${selected ? '›' : ' '} ${glyph} ${label}`;
    s.put(x + 2, y + 1, t, text, w - 3);
  } else {
    const t = ` ${selected ? '›' : ' '}${glyph} ${label} `;
    s.put(x, y, padR(t, w), on ? S.focus : selected ? S.selected : S.ink, w);
  }
}

function chips(s, x, y, label, items, ui, focused, maxX) {
  s.put(x, y, padR(label, 6), S.muted);
  let cx = x + 7;
  for (const name of items) {
    const i = MENU.indexOf(name);
    const sel = i === ui.menu;
    const text = sel ? `[${name}]` : ` ${name} `;
    if (cx + len(text) > maxX) break;
    s.put(cx, y, text, sel ? (focused ? S.focus : S.selected) : S.ink);
    cx += len(text) + 1;
  }
}

function actions(s, state, ui, y, cols, rows) {
  const focused = ui.focus === 'actions';
  const big = rows >= 24;
  const bw = Math.min(28, Math.floor((cols - 4) / 2));
  const glyph = { Receive: '↓', Send: '↑' };
  let cy = y;
  PRIMARY.forEach((name, i) => button(s, 1 + i * (bw + 2), cy, bw, big ? 3 : 1, name, glyph[name], ui.menu === MENU.indexOf(name), focused));
  cy += big ? 3 : 1;
  cy += big ? 1 : 0;
  chips(s, 1, cy, 'Trade', TRADE, ui, focused, cols - 1);
  chips(s, 1, cy + 1, 'Tools', TOOLS, ui, focused, cols - 1);
  // Wallets and Settings sit at the right end of the Trade row when it fits, otherwise on a third row (never hidden).
  const moreW = MORE.reduce((n, m) => n + len(m) + 3, 0);
  if (moreW + 40 < cols) { chips(s, cols - 1 - moreW - 7, cy, '', MORE, ui, focused, cols - 1); return cy + 2 - y; }
  chips(s, 1, cy + 2, 'More', MORE, ui, focused, cols - 1);
  return cy + 3 - y;
}

// ------------------------------------------------------------------------------------------------ panes
function balancesPane(s, state, x, y, w, h, focused) {
  const total = portfolioTotalWei(state);
  paneTitle(s, x, y, w, 'BALANCES', focused, total === null ? null : `≈ ${fmtUnits(total, 18, 2)} QUAI`);
  let row = y + 1;
  const holds = state.holdings || [];
  const symW = Math.min(10, Math.max(6, ...holds.map((hl) => len(hl.symbol || '???')), 4));
  const quai = state.quaiWei != null ? fmtUnits(state.quaiWei, 18, 6) : '—';
  if (row < y + h) { s.put(x + 1, row, padR('QUAI', symW), { fg: PALETTE.ink, bold: true }); s.putRight(x + w - 1, row, quai, { fg: PALETTE.ink, bold: true }); row += 1; }
  if (state.holdingsError) { if (row < y + h) s.put(x + 1, row, clip(state.holdingsError, w - 2), S.warn); return; }
  if (!holds.length) { if (row < y + h) s.put(x + 1, row, 'no tokens held', S.muted); return; }
  const showVal = w >= symW + 2 + 12 + 14;
  for (const hld of holds) {
    if (row >= y + h) break;
    s.put(x + 1, row, padR(hld.symbol || '???', symW), S.ink);
    const valW = showVal ? 14 : 0;
    const bal = fmtUnits(hld.balance, 18, 2);
    s.putRight(x + w - 1 - valW, row, bal, S.ink);
    if (showVal) s.putRight(x + w - 1, row, hld.valueQuai != null ? `≈ ${fmtUnits(hld.valueQuai, 18, 2)}` : '', S.muted);
    row += 1;
  }
}

function watchPane(s, state, x, y, w, h, focused, ui) {
  const list = state.watch || [];
  paneTitle(s, x, y, w, 'WATCHLIST', focused, focused ? 'a add · d remove' : `${list.length} tokens`);
  if (!list.length) { s.put(x + 1, y + 1, w >= 44 ? 'empty — focus this pane and press a to add' : 'empty — press a to add', S.muted, w - 2); return; }
  const cap = Math.max(1, h - 1);
  const start = Math.max(0, Math.min((ui.watchSel || 0) - cap + 1, list.length - cap));
  const symW = Math.min(10, Math.max(6, ...list.map((t) => len(t.symbol || '???'))));
  const pctW = 9; // "▲ +123.4%" fits; reserved so the symbol is never cut
  const priceW = 12;
  const showPrice = w >= 1 + symW + 1 + pctW + priceW;
  list.slice(start, start + cap).forEach((t, offset) => {
    const i = start + offset;
    const row = y + 1 + offset;
    const sel = focused && i === ui.watchSel;
    s.put(x, row, sel ? '▸' : ' ', S.signal);
    s.put(x + 1, row, padR(t.symbol || '???', symW), sel ? S.strong : S.ink);
    if (showPrice) s.putRight(x + w - 1 - pctW, row, fmtPrice(t.priceWei), S.ink);
    const pct = t.change24h;
    const none = pct === null || pct === undefined;
    const up = pct > 0;
    s.putRight(x + w - 1, row, none ? '' : `${up ? '▲' : pct < 0 ? '▼' : '■'} ${fmtPct(pct)}`, none ? S.muted : up ? S.up : S.muted);
  });
}

function tradesPane(s, state, x, y, w, h, focused, ui) {
  paneTitle(s, x, y, w, 'LIVE TRADES', focused, w >= 40 ? 'per block · newest first' : null);
  const trades = state.trades || [];
  if (!trades.length) { s.put(x + 1, y + 1, state.network === 'orchard' ? 'Market trades are available on mainnet.' : state.live?.state === 'connected' ? 'waiting for the next trade…' : 'feed offline — balances and actions still work', S.muted, w - 2); return; }
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
        s.hline(x + 3 + len(label), row, Math.max(0, w - 4 - len(label)), '─', S.faint);
        row += 1;
        if (row >= y + h) break;
      }
      prev = t.blockNumber;
    }
    const buy = t.side === 'buy';
    const st = buy ? S.up : S.muted;
    let cx = x + 1;
    if (!compact) { s.put(cx, row, clock(t.ts), S.muted); cx += 10; }
    s.put(cx, row, buy ? '▲ BUY ' : t.side === 'burn' ? '✕ BURN' : '▼ SELL', st); cx += 7;
    s.put(cx, row, padR(t.symbol || '???', 7), S.ink); cx += 8;
    const q = t.quai == null ? '' : `${group(String(t.quai), 2)} QUAI`;
    s.putRight(cx + 13, row, q, S.strong); cx += 15;
    if (w >= 66 && t.token != null) { s.putRight(cx + 13, row, `${compactNum(t.token)} ${t.symbol || ''}`, S.muted); cx += 15; }
    if (cx + 8 < x + w) s.put(cx, row, shortAddr(t.trader, 6, 4), S.muted, x + w - cx - 1);
    row += 1;
  }
}

export function statusLine(s, state, cols, y, ui) {
  const st = ui.status;
  const b = liveBadge(state);
  const right = cols >= 70 ? `? help · q quit   ${b.text}` : `? help · q quit`;
  if (st) s.put(1, y, clip(st.text, cols - len(right) - 3), st.kind === 'error' ? S.danger : st.kind === 'ok' ? S.ok : S.muted);
  else if (cols >= 70) s.put(1, y, 'Tab pane · ←→ action · Enter open', S.faint);
  s.putRight(cols - 1, y, right, S.faint);
  if (cols >= 70) s.putRight(cols - 1, y, b.text, b.st);
}

function backupBanner(s, y, cols) {
  const t = '! Back up your recovery phrase. Press B to check your backup.';
  s.put(1, y, clip(t, cols - 2), S.warn);
}

// ------------------------------------------------------------------------------------------------ the page
export function drawHome(s, state, ui, cols, rows) {
  const motion = state.motion !== false;
  let y = header(s, state, cols, rows, motion);
  y += rows >= 26 ? 1 : 0;
  y += hero(s, state, ui, y, cols, rows, motion) + (rows >= 24 ? 1 : 0);
  if (state.backupPending) { backupBanner(s, y, cols); y += 1; }
  y += actions(s, state, ui, y, cols, rows) + 1;
  const bottom = rows - 1; // status row
  const ch = bottom - y;
  if (ch < 3) return;
  const t = tier(cols);
  if (t === 'wide' && ch >= 8) {
    const lw = Math.max(46, Math.floor(cols * 0.4));
    const balH = Math.max(5, Math.floor(ch * 0.45));
    balancesPane(s, state, 1, y, lw - 2, balH, ui.focus === 'balances');
    watchPane(s, state, 1, y + balH + 1, lw - 2, ch - balH - 1, ui.focus === 'watch', ui);
    s.vline(lw, y, ch, '│', S.faint);
    tradesPane(s, state, lw + 2, y, cols - lw - 3, ch, ui.focus === 'trades', ui);
  } else {
    const half = Math.floor((cols - 3) / 2);
    const topH = Math.min(7, Math.max(3, Math.floor(ch * 0.5)));
    balancesPane(s, state, 1, y, half - 1, topH, ui.focus === 'balances');
    s.vline(half + 1, y, topH, '│', S.faint);
    watchPane(s, state, half + 3, y, cols - half - 4, topH, ui.focus === 'watch', ui);
    if (ch - topH - 1 >= 3) tradesPane(s, state, 1, y + topH + 1, cols - 2, ch - topH - 1, ui.focus === 'trades', ui);
  }
}
