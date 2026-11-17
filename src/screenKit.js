// packages/hartii-cli/src/screenKit.js
//
// Layout primitives shared by every designed human view: one heading style, aligned label/value blocks,
// tables that adapt to 60/80/120 columns, status words and callouts. Pure: returns arrays of lines.
// Look: Labs black-and-white base, violet accent, red only for danger. Colour never carries meaning alone:
// every status has a word ("OK", "Check", "Fix", "Warning").
import { makeTheme, visibleLength, wrapText, safeTerminalText, stripAnsi } from './output.js';

export const MARGIN = '  ';
const GAP = '  ';

export function clampWidth(width) {
  const w = Number(width);
  return Number.isFinite(w) && w > 0 ? Math.max(40, Math.min(Math.floor(w), 110)) : 80;
}

const pad = (s, w, align = 'l') => {
  const gap = Math.max(0, w - visibleLength(s));
  return align === 'r' ? ' '.repeat(gap) + s : s + ' '.repeat(gap);
};

export function clip(text, w) {
  const a = Array.from(String(text));
  return a.length <= w ? a.join('') : `${a.slice(0, Math.max(0, w - 1)).join('')}…`;
}

/** @param {{ colors?: any, width?: number, terse?: boolean }} o */
export function makeKit({ colors, width, terse = false } = {}) {
  const t = makeTheme({ depth: colors?.depth ?? 0 });
  const W = clampWidth(width) - MARGIN.length * 2;
  const text = (v) => (v === null || v === undefined || v === '' ? '—' : safeTerminalText(String(v)));

  /** Title line plus a thin rule. `sub` is muted context (network, wallet name). */
  const heading = (title, sub) => {
    const head = `${t.accent('▍')} ${t.bold(t.text(title))}${sub ? `  ${t.muted(sub)}` : ''}`;
    return [head, t.dim('─'.repeat(Math.min(W, 44)))];
  };
  const section = (title) => ['', t.bold(t.text(title))];

  /** Label / value block with aligned values. rows: [label, value] or [label, value, tone]. */
  const kv = (rows, { labelWidth } = {}) => {
    const live = rows.filter((r) => r && r[1] !== undefined);
    const lw = labelWidth || Math.min(16, Math.max(...live.map((r) => Array.from(r[0]).length), 4));
    const out = [];
    for (const [label, value, tone] of live) {
      const body = String(value);
      const style = tone && t[tone] ? t[tone] : (s) => s;
      const room = Math.max(12, W - lw - 2);
      const parts = body.split(String.fromCharCode(10)).flatMap((seg) => (visibleLength(seg) <= room ? [seg] : wrapText(seg, room)));
      if (visibleLength(body) > room && !/\s/.test(stripAnsi(body))) {
        // One unbreakable token (URL, hash): its own line, so it stays whole and copyable.
        out.push(t.muted(label), `  ${style(body)}`);
        continue;
      }
      parts.forEach((p, i) => out.push(`${i === 0 ? t.muted(pad(label, lw)) : ' '.repeat(lw)}  ${style(p)}`));
    }
    return out;
  };

  /**
   * Table that adapts to the width. columns: { title, get(row)->plain text, align, priority (higher = dropped first,
   * 0 = never), style(text,row)->styled, flex (this column may be truncated) }. When a column does not fit and
   * `stack` is set, its value moves to an indented line under the row instead of vanishing.
   */
  const table = (columns, rows, { stack = true, header = true } = {}) => {
    let cols = columns.slice();
    const cells = (c) => rows.map((r) => String(c.get(r) ?? '—'));
    const widthOf = (c) => Math.max(header ? Array.from(c.title).length : 0, ...cells(c).map((x) => Array.from(x).length));
    const total = (list) => list.reduce((n, c) => n + widthOf(c), 0) + GAP.length * (list.length - 1);
    const stacked = [];
    while (total(cols) > W) {
      const droppable = cols.filter((c) => c.priority > 0).sort((a, b) => b.priority - a.priority)[0];
      if (!droppable) break;
      cols = cols.filter((c) => c !== droppable);
      stacked.push(droppable);
    }
    const widths = cols.map(widthOf);
    const over = total(cols) - W;
    if (over > 0) {
      const flexIdx = cols.findIndex((c) => c.flex);
      if (flexIdx >= 0) widths[flexIdx] = Math.max(8, widths[flexIdx] - over);
    }
    const out = [];
    if (header) out.push(cols.map((c, i) => t.muted(pad(clip(c.title, widths[i]), widths[i], c.align))).join(GAP).trimEnd());
    rows.forEach((r) => {
      out.push(cols.map((c, i) => {
        const raw = clip(String(c.get(r) ?? '—'), widths[i]);
        const padded = pad(raw, widths[i], c.align);
        return c.style ? c.style(padded, r) : padded;
      }).join(GAP).trimEnd());
      if (stack) for (const c of stacked.slice().reverse()) out.push(c.bare ? `${MARGIN}${c.style ? c.style(String(c.get(r) ?? '—'), r) : String(c.get(r) ?? '—')}` : `${MARGIN}${t.muted(c.title.toLowerCase())}  ${String(c.get(r) ?? '—')}`);
    });
    return out;
  };

  const status = {
    ok: (label = 'OK') => t.ok(`${label}`),
    warn: (label = 'Check') => t.warn(label),
    fail: (label = 'Fix') => t.danger(label),
    info: (label) => t.accentBright(label),
  };

  /** A sentence with a leading word so it reads without colour: "Warning: ...". */
  const callout = (level, sentence) => {
    const word = level === 'danger' ? 'Warning' : level === 'warn' ? 'Careful' : 'Note';
    const tone = level === 'danger' ? t.danger : level === 'warn' ? t.warn : t.accentBright;
    return wrapText(`${tone(t.bold(`${word}:`))} ${sentence}`, W, { indent: '', hang: ' '.repeat(word.length + 2) });
  };

  const wrap = (s, opts) => wrapText(s, W, opts);
  const wrapTo = (s, width) => wrapText(s, width);
  /** Apply the left margin to every line of a view. */
  const frame = (lines) => lines.flatMap((l) => {
    if (l === '') return [''];
    // Safety net: a long sentence wraps at the margin; tables, aligned blocks and unbreakable tokens are left alone.
    if (visibleLength(l) > W && /\S\s\S/.test(stripAnsi(l)) && !/\S {2,}\S/.test(stripAnsi(l).trim())) {
      const lead = /^ */.exec(l)[0];
      return wrapText(l.trim(), W, { indent: lead, hang: lead }).map((x) => MARGIN + x);
    }
    return [MARGIN + l];
  });
  const command = (cmd) => t.accentBright(cmd);

  return { t, W, terse, text, wrapTo, heading, section, kv, table, status, callout, wrap, frame, command, pad };
}
