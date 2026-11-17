// packages/hartii-cli/src/tui/setup.js
//
// Renders the guided first-run setup (see onboarding/flow.js) into a Screen. Pure: same flow state in, same frame out.
// The recovery phrase is drawn ONLY by the 'phrase' step, straight from the flow's in-memory copy, into the cell
// buffer of the alternate screen. The app clears the whole terminal when it leaves that step (app.consumeClear).
import { Screen } from './screen.js';
import { S, PALETTE } from './theme.js';
import { drawCamel, CAMEL_W } from './mark.js';
import { qrDims, drawQr, createReceiveQr } from '../qr.js';
import { fmtUnits, clip, padR } from './format.js';
import { SPINNER, SPINNER_ASCII } from './glyphs.js';
import { PRESETS, resolvePreset } from '../presets.js';
import { CAPS_CHOICES, WELCOME_CHOICES, IMPORT_KINDS } from '../onboarding/flow.js';

const len = (t) => Array.from(String(t)).length;

export function wrap(text, width) {
  const out = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (!line) line = word;
      else if (len(line) + 1 + len(word) <= width) line += ` ${word}`;
      else { out.push(line); line = word; }
    }
    out.push(line);
  }
  return out;
}

/** 0x + 40 hex -> readable groups of four, five groups per line. */
export function addressGroups(address) {
  const hex = String(address || '').replace(/^0x/i, '');
  const groups = hex.match(/.{1,4}/g) || [];
  const lines = [];
  for (let i = 0; i < groups.length; i += 5) lines.push(groups.slice(i, i + 5).join(' '));
  if (lines.length) lines[0] = `0x ${lines[0]}`;
  return lines;
}

const STEP_OF = { welcome: 0, 'import-kind': 0, 'import-secret': 0, password: 1, confirm: 1, creating: 1, phrase: 2, verify: 2, caps: 3, 'caps-custom': 3, receive: 4, received: 4, done: 4, error: 1 };
const LABELS = ['Start', 'Password', 'Backup', 'Safety', 'Funds'];

function progress(s, x, y, step, flow) {
  const n = STEP_OF[step] ?? 0;
  const labels = flow.mode === 'import' ? ['Start', 'Password', 'Safety', 'Funds'] : LABELS;
  const idx = flow.mode === 'import' ? { 0: 0, 1: 1, 2: 1, 3: 2, 4: 3 }[n] : n;
  let cx = x;
  labels.forEach((l, i) => {
    const mark = i < idx ? '✓' : i === idx ? '●' : '○';
    const text = `${mark} ${l}`;
    s.put(cx, y, text, i === idx ? S.title : i < idx ? S.ok : S.faint);
    cx += len(text) + 3;
  });
}

function field(s, x, y, w, label, value, { mask = false, active = true, hint = '' } = {}) {
  s.put(x, y, label, active ? S.title : S.muted);
  const shown = mask ? '•'.repeat(Math.min(len(value), w - 6)) : value;
  s.put(x, y + 1, `${active ? '›' : ' '} ${shown}`, active ? S.strong : S.ink, w);
  if (active) s.put(x + 2 + len(shown), y + 1, '▏', S.signal);
  if (hint) s.putRight(x + w, y, hint, S.faint);
}

function strengthBar(level) {
  return `${'█'.repeat(level)}${'░'.repeat(4 - level)}`;
}

/** @param {import('../onboarding/flow.js').SetupFlow} flow @param {{cols:number, rows:number, now:number, motion?:boolean, ascii?:boolean}} ctx */
export function renderSetup(flow, ctx) {
  const { cols, rows, now } = ctx;
  const motion = ctx.motion !== false;
  const s = new Screen(cols, rows, { ascii: Boolean(ctx.ascii) });
  if (cols < 60 || rows < 18) {
    s.put(1, Math.floor(rows / 2), clip(`Hartii setup needs at least 60x18 (this window is ${cols}x${rows}).`, cols - 2), S.warn);
    return s;
  }
  const cw = Math.min(cols - 4, 72);
  const x = Math.floor((cols - cw) / 2);
  let y = 0;
  // header
  if (cols >= 80 && rows >= 26) { drawCamel(s, x, 0); s.put(x + CAMEL_W + 2, 0, 'H A R T I I', S.brand); s.put(x + CAMEL_W + 14, 0, ' BETA ', { fg: PALETTE.warn, bold: true, inverse: true }); s.put(x + CAMEL_W + 2, 1, 'Set up your wallet', S.ink); y = 5; } else { s.put(x, 0, '∩∩', S.brand); s.put(x + 3, 0, 'HARTII', S.brand); s.put(x + 10, 0, 'BETA', { fg: PALETTE.warn, bold: true }); s.put(x + 16, 0, 'Set up your wallet', S.muted); y = 2; }
  progress(s, x, y - 1 > 1 ? y - 1 : 1, flow.step, flow);
  s.hline(x, y, cw, '─', S.faint);
  y += 2;
  const foot = (text) => s.put(x, rows - 1, clip(text, cw), S.faint);
  const para = (text, st = S.ink, indent = 0) => { for (const l of wrap(text, cw - indent)) { if (y < rows - 2) s.put(x + indent, y++, l, st); } };
  const err = () => { if (flow.error) { y += 0; s.put(x, y++, clip(`✕ ${flow.error}`, cw), S.danger); } };
  const dots = ctx.ascii ? '...' : '…';
  const sel = (items, labels, hints = []) => {
    const widest = Math.max(...labels.map(len));
    items.forEach((it, i) => {
      const on = i === flow.sel;
      s.put(x, y, `${on ? '›' : ' '} ${i + 1}  ${labels[i]}`, on ? S.strong : S.ink);
      if (hints[i]) s.put(x + 5 + widest + 3, y, clip(hints[i], Math.max(0, cw - 8 - widest)), S.muted);
      y += 1;
    });
  };

  switch (flow.step) {
    case 'welcome':
      s.put(x, y++, 'Welcome to Hartii', S.title); y += 1;
      para('Let us set up your wallet. It takes about two minutes and nothing leaves this computer.');
      para('Hartii CLI is BETA. Start with small amounts.', S.muted); y += 1;
      sel(WELCOME_CHOICES, ['Create a new wallet', 'I already have a wallet (import it)']);
      foot('↑↓ choose · Enter continue · Esc quit');
      break;
    case 'import-kind':
      s.put(x, y++, 'What do you want to import?', S.title); y += 1;
      sel(IMPORT_KINDS, ['A recovery phrase (12 or 24 words)', 'A private key'], []);
      foot('↑↓ choose · Enter continue · Esc back');
      break;
    case 'import-secret':
      s.put(x, y++, flow.importKind === 'key' ? 'Paste your private key' : 'Paste your recovery phrase', S.title); y += 1;
      para('It stays hidden as you type and is never shown or saved anywhere in plain text.', S.muted); y += 1;
      field(s, x, y, cw, flow.importKind === 'key' ? 'Private key' : 'Recovery phrase', flow.text, { mask: true, hint: `${len(flow.text)} characters` }); y += 3;
      err();
      foot('Enter continue · Esc back');
      break;
    case 'password':
    case 'confirm': {
      const confirm = flow.step === 'confirm';
      s.put(x, y++, confirm ? 'Type the password again' : 'Choose a password', S.title); y += 1;
      if (!confirm) para('It locks this wallet on this computer. Use at least 12 characters. If you forget it, only your recovery phrase can restore the wallet.', S.muted);
      else para('Same password, once more, to be sure.', S.muted);
      y += 1;
      field(s, x, y, cw, confirm ? 'Confirm password' : 'Password', flow.text, { mask: true, hint: `${len(flow.text)} characters` }); y += 3;
      if (!confirm) {
        const st = flow.strength;
        const stSt = st.level >= 3 ? S.ok : st.level === 2 ? S.accent : S.warn;
        s.put(x, y, `${strengthBar(st.level)}  ${st.label}`, stSt); y += 1;
      }
      err();
      foot(confirm ? 'Enter create wallet · Esc back' : 'Enter continue · Esc back');
      break;
    }
    case 'creating': {
      const frames = ctx.ascii ? SPINNER_ASCII : SPINNER;
      const f = motion ? frames[Math.floor(now / 120) % frames.length] : frames[0];
      s.put(x, y++, `Creating your wallet${dots}`, S.title); y += 1;
      s.put(x, y, `${f} Locking it with your password. This takes a few seconds${dots === '…' ? '.' : '.'}`, S.ink, cw);
      break;
    }
    case 'phrase': {
      const words = flow.phraseWords || [];
      s.put(x, y++, 'Your recovery phrase', S.title);
      para('These words are the only way to get your wallet back. Write them on paper, in order. Never type them anywhere else, and nobody from Hartii will ever ask for them.', S.ink);
      y += 1;
      const cols3 = cw >= 56 ? 3 : 2;
      const per = Math.ceil(words.length / cols3);
      const cwid = Math.floor(cw / cols3);
      words.forEach((w, i) => {
        const col = Math.floor(i / per), row = i % per;
        if (y + row < rows - 4) s.put(x + col * cwid, y + row, `${padR(String(i + 1), 3)} ${w}`, S.strong);
      });
      y += per + 1;
      if (y < rows - 3) s.put(x, y, 'Shown once. It is not saved, logged or copied anywhere.', S.warn, cw);
      foot('Enter: I wrote them down');
      break;
    }
    case 'verify': {
      s.put(x, y++, 'Check your backup', S.title); y += 1;
      const nums = flow.askIdx.map((i) => `#${i + 1}`);
      para(`Type words ${nums[0]}, ${nums[1]} and ${nums[2]} from the list you wrote down.`);
      y += 1;
      flow.askIdx.forEach((idx, i) => {
        const on = flow.row === i;
        s.put(x, y, `Word #${idx + 1}`, on ? S.title : S.muted);
        s.put(x + 12, y, `${on ? '›' : ' '} ${flow.words[i]}${on ? '▏' : ''}`, on ? S.strong : S.ink);
        y += 1;
      });
      y += 1;
      ['Check my words', 'Show the phrase again', 'Back up later'].forEach((l, i) => {
        const on = flow.row === 3 + i;
        s.put(x, y++, `${on ? '›' : ' '} ${l}`, on ? S.strong : i === 2 ? S.muted : S.ink);
      });
      y += 1;
      if (flow.error) para(`✕ ${flow.error}`, S.danger);
      if (flow.notice) para(`! ${flow.notice}`, S.warn);
      foot('↑↓ move · Enter next · type the words in lower case');
      break;
    }
    case 'caps':
    case 'caps-custom': {
      s.put(x, y++, 'Set a safety limit?  (recommended)', S.title); y += 1;
      para('A cap stops one send, or one day of sends, from moving more QUAI than you chose. You can change it any time in Settings.', S.muted);
      y += 1;
      if (flow.step === 'caps') {
        const labels = CAPS_CHOICES.map((c) => (c === 'custom' ? 'Custom amounts' : c === 'skip' ? 'Skip for now' : c[0].toUpperCase() + c.slice(1)));
        const hints = CAPS_CHOICES.map((c) => { if (!PRESETS[c]) return ''; const p = resolvePreset({ preset: c }); return `${p.perTxQuai} QUAI per send, ${p.dailyQuai} per day`; });
        sel(CAPS_CHOICES, labels, hints);
      } else {
        field(s, x, y, cw, 'Most per send (QUAI)', flow.caps.perTx, { active: flow.row === 0 }); y += 3;
        field(s, x, y, cw, 'Most per day (QUAI)', flow.caps.daily, { active: flow.row === 1 }); y += 3;
      }
      err();
      foot(flow.step === 'caps' ? '↑↓ choose · Enter confirm · Esc skip' : 'Enter next · Esc back');
      break;
    }
    case 'receive':
    case 'received': {
      const addr = flow.address || '';
      y -= 1; // the QR (when it fits) starts right under the rule so it fits at 80x24
      const lines = addressGroups(addr);
      let matrix = null;
      try { matrix = createReceiveQr(addr).matrix; } catch { matrix = null; }
      const dims = matrix ? qrDims(matrix.length, { ascii: Boolean(ctx.ascii) }) : { width: 0, height: 0 };
      const sideBySide = matrix && cols >= dims.width + 38 && rows >= dims.height + y + 2;
      if (!sideBySide) y += 1;
      let tx = x, ty = y;
      if (sideBySide) { drawQr(s, x, y, matrix, { ascii: Boolean(ctx.ascii) }); tx = x + dims.width + 3; }
      const tw = x + cw - tx;
      const put = (text, st = S.ink) => { for (const l of wrap(text, Math.max(10, tw))) { if (ty < rows - 2) s.put(tx, ty++, l, st); } };
      put(flow.step === 'received' ? 'Funds arrived' : 'Add funds', S.title);
      ty += 1;
      put('Your address', S.muted);
      for (const l of lines) { if (ty < rows - 2) s.put(tx, ty++, l, S.strong); }
      ty += 1;
      if (!sideBySide && !matrix) put('QR code unavailable.', S.muted);
      else if (!sideBySide) put(ctx.ascii ? 'The text QR needs a taller window. Copy the address instead.' : 'Make the window larger to see the QR code.', S.muted);
      put('Send some QUAI here from an exchange or another wallet. Only the Quai network, Cyprus-1 zone.', S.muted);
      ty += 1;
      if (flow.step === 'received') {
        put(`✓ Received ${fmtUnits(flow.receivedWei, 18, 4)} QUAI`, S.ok);
        put(`Taking you to your wallet${dots}`, S.muted);
      } else {
        const frames = ctx.ascii ? SPINNER_ASCII : SPINNER;
        const f = motion ? frames[Math.floor(now / 120) % frames.length] : '·';
        put(`${f} Waiting for funds${dots}`, S.accent);
      }
      if (flow.notice) put(flow.notice, S.ok);
      foot(flow.step === 'received' ? 'Enter continue' : 'C copy address · Enter skip for now');
      break;
    }
    case 'error':
      s.put(x, y++, 'Something went wrong', S.danger); y += 1;
      para(flow.error || 'The wallet could not be created. Nothing was saved.', S.ink);
      para('Nothing was sent anywhere.', S.muted);
      foot('Enter try again · Esc quit');
      break;
    default:
      break;
  }
  return s;
}
