// Tiny ANSI-SGR to HTML converter for the screenshot gate: truecolor, 256 and 16-colour foregrounds, bold and faint.
// Pure; used by test/screens.test.mjs to write HTML previews of the key views.
const BASIC = ['#0D0D0E', '#F0465C', '#22C55E', '#FFB020', '#6D28D9', '#7C3AED', '#A78BFA', '#9B98A3'];
const BRIGHT = ['#66636D', '#F0465C', '#22C55E', '#FFB020', '#A78BFA', '#A78BFA', '#A78BFA', '#F2F1F4'];
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function color256(n) {
  if (n < 8) return BASIC[n];
  if (n < 16) return BRIGHT[n - 8];
  if (n >= 232) { const v = 8 + (n - 232) * 10; return `rgb(${v},${v},${v})`; }
  const i = n - 16; const c = (x) => (x ? 55 + x * 40 : 0);
  return `rgb(${c(Math.floor(i / 36))},${c(Math.floor(i / 6) % 6)},${c(i % 6)})`;
}
export function ansiToHtml(input, { title = 'Hartii CLI screen' } = {}) {
  let fg = null; let bold = false; let faint = false; let open = false;
  let out = '';
  const close = () => { if (open) { out += '</span>'; open = false; } };
  const start = () => {
    const style = [fg ? `color:${fg}` : '', bold ? 'font-weight:700' : '', faint ? 'opacity:.6' : ''].filter(Boolean).join(';');
    if (style) { out += `<span style="${style}">`; open = true; }
  };
  // eslint-disable-next-line no-control-regex
  const parts = String(input).split(/(\u001b\[[0-9;]*m)/);
  for (const part of parts) {
    // eslint-disable-next-line no-control-regex
    const m = /^\u001b\[([0-9;]*)m$/.exec(part);
    if (!m) { out += esc(part); continue; }
    close();
    const codes = m[1] === '' ? [0] : m[1].split(';').map(Number);
    for (let i = 0; i < codes.length; i += 1) {
      const c = codes[i];
      if (c === 0) { fg = null; bold = false; faint = false; }
      else if (c === 1) bold = true;
      else if (c === 2) faint = true;
      else if (c === 22) { bold = false; faint = false; }
      else if (c === 39) fg = null;
      else if (c >= 30 && c <= 37) fg = BASIC[c - 30] === '#0D0D0E' ? '#9B98A3' : BASIC[c - 30];
      else if (c >= 90 && c <= 97) fg = BRIGHT[c - 90];
      else if (c === 38 && codes[i + 1] === 2) { fg = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`; i += 4; }
      else if (c === 38 && codes[i + 1] === 5) { fg = color256(codes[i + 2]); i += 2; }
    }
    start();
  }
  close();
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>\n<style>body{margin:0;background:#0D0D0E;color:#F2F1F4}pre{margin:0;padding:24px;font:14px/1.45 "Cascadia Mono",Consolas,Menlo,monospace;white-space:pre}</style></head>\n<body><pre>${out}</pre></body></html>\n`;
}
