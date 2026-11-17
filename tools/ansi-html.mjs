// packages/hartii-cli/tools/ansi-html.mjs
//
// Zero-dependency ANSI SGR -> HTML, the same job `ansi-to-html` does (that package is not installed in this
// monorepo and no installs are allowed here). Handles exactly what the Hartii TUI emits: reset, bold, dim, inverse,
// 24-bit / 256 / 16 colour foreground and background.
const XTERM16 = ['#000000', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5', '#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#ffffff'];
const hex = (n) => n.toString(16).padStart(2, '0');
function color256(n) {
  if (n < 16) return XTERM16[n];
  if (n >= 232) { const v = 8 + (n - 232) * 10; return `#${hex(v)}${hex(v)}${hex(v)}`; }
  const i = n - 16; const c = (v) => (v === 0 ? 0 : 55 + v * 40);
  return `#${hex(c(Math.floor(i / 36)))}${hex(c(Math.floor(i / 6) % 6))}${hex(c(i % 6))}`;
}
const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function ansiToHtml(text, { fg = '#F2F1F4', bg = '#0D0D0E' } = {}) {
  let st = {};
  let out = '';
  const re = /\u001b\[([0-9;]*)m/g;
  let last = 0;
  const open = () => {
    let f = st.fg, b = st.bg;
    if (st.inverse) { const t = f || fg; f = b || bg; b = t; }
    const css = [];
    if (f) css.push(`color:${f}`);
    if (b) css.push(`background:${b}`);
    if (st.bold) css.push('font-weight:700');
    if (st.dim) css.push('opacity:.6');
    return css.length ? `<span style="${css.join(';')}">` : '';
  };
  const emit = (chunk) => { if (!chunk) return; const o = open(); out += o ? `${o}${esc(chunk)}</span>` : esc(chunk); };
  let m;
  while ((m = re.exec(text))) {
    emit(text.slice(last, m.index));
    last = re.lastIndex;
    const p = m[1] === '' ? [0] : m[1].split(';').map(Number);
    for (let i = 0; i < p.length; i += 1) {
      const c = p[i];
      if (c === 0) st = {};
      else if (c === 1) st.bold = true;
      else if (c === 2) st.dim = true;
      else if (c === 7) st.inverse = true;
      else if (c === 38 || c === 48) {
        const key = c === 38 ? 'fg' : 'bg';
        if (p[i + 1] === 2) { st[key] = `rgb(${p[i + 2]},${p[i + 3]},${p[i + 4]})`; i += 4; }
        else if (p[i + 1] === 5) { st[key] = color256(p[i + 2]); i += 2; }
      } else if (c >= 30 && c <= 37) st.fg = XTERM16[c - 30];
      else if (c >= 90 && c <= 97) st.fg = XTERM16[c - 90 + 8];
      else if (c >= 40 && c <= 47) st.bg = XTERM16[c - 40];
      else if (c >= 100 && c <= 107) st.bg = XTERM16[c - 100 + 8];
    }
  }
  emit(text.slice(last));
  return out;
}

/** A self-contained dark page with one titled <pre> per screen. */
export function htmlPage(title, sections) {
  const body = sections.map(({ name, ansi }) => `<section><h2>${esc(name)}</h2><pre>${ansiToHtml(ansi)}</pre></section>`).join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{color-scheme:dark}body{margin:0;padding:24px 16px;background:#0D0D0E;color:#F2F1F4;font:14px/1.3 system-ui,sans-serif}
h1{font-size:18px;margin:0 0 16px}h2{font-size:13px;color:#9B98A3;margin:24px 0 6px;font-weight:600}
pre{margin:0;padding:12px;background:#0D0D0E;border:1px solid #2a2a2e;border-radius:6px;overflow:auto;font:14px/1.2 "Cascadia Mono","SF Mono",Menlo,Consolas,monospace;letter-spacing:0}
</style></head><body><h1>${esc(title)}</h1>
${body}
</body></html>
`;
}
