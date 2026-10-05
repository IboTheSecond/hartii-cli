// packages/hartii-cli/src/tui/app.js
//
// The TUI controller: state, key handling and the glue that turns a form into the SAME command call the
// CLI makes. No terminal I/O here (see run.js) — keys go in via key(), frames come out via frame(), and
// every side effect (commands, config, watchlist file) goes through injected `deps`, so the whole flow
// is testable with a fake `exec`.
import { renderFrame, defaultUi, FOCUS_ORDER, MENU } from './render.js';
import { ACTIONS, fieldsFor, validateAll, commandFor } from './forms.js';
import { S } from './theme.js';
import { stripAnsi } from '../output.js';

const SENSITIVE_NOTE = 'Keys stay in the encrypted keystore. Create or import wallets with the CLI so recovery phrases are never drawn on this screen.';

export class TuiApp {
  /**
   * @param {object} init
   * @param {object} init.data initial data (see demoData.demoState) — mutated by data sources via setData()
   * @param {{cols:number, rows:number}} init.size
   * @param {object} init.deps { runCommand(fn, opts, io) -> result, listWallets(), useWallet(name), saveSettings(values), loadSettings(), addWatch(ref), removeWatch(ref), refresh(), quit(), now() }
   * @param {boolean} [init.demo]
   */
  constructor({ data, size, deps = {}, demo = false }) {
    this.data = { ...data, ui: defaultUi() };
    this.size = size;
    this.deps = deps;
    this.demo = demo;
    this.quitRequested = false;
    this.dirty = true;
    this.pending = null; // { resolve, reject } for password / confirm overlays
  }

  get ui() { return this.data.ui; }
  now() { return this.deps.now ? this.deps.now() : Date.now(); }
  invalidate() { this.dirty = true; this.onChange?.(); }

  setData(patch) { Object.assign(this.data, patch); this.invalidate(); }
  resize(cols, rows) { this.size = { cols, rows }; this.invalidate(); }
  status(text, kind = 'info') { this.ui.status = text ? { text, kind } : null; this.invalidate(); }

  frame() {
    return renderFrame({ ...this.data, now: this.now() }, this.size.cols, this.size.rows);
  }

  // ---------------------------------------------------------------- keys
  /** @param {{name?:string, ctrl?:boolean, shift?:boolean, str?:string}} k */
  key(k) {
    const o = this.ui.overlay;
    if (k.ctrl && k.name === 'c') return this.quit();
    if (o) return this.overlayKey(o, k);
    const name = k.name;
    if (k.str === 'q') return this.quit();
    if (k.str === '?') { this.ui.overlay = { type: 'help' }; return this.invalidate(); }
    if (k.str === 'r') { this.deps.refresh?.(); this.status('Refreshing…'); return undefined; }
    if (name === 'tab') return this.cycleFocus(k.shift ? -1 : 1);
    const focus = this.ui.focus;
    if (focus === 'actions') {
      if (name === 'left') this.ui.menu = (this.ui.menu + MENU.length - 1) % MENU.length;
      else if (name === 'right') this.ui.menu = (this.ui.menu + 1) % MENU.length;
      else if (name === 'return') return this.openAction(MENU[this.ui.menu]);
      else if (name === 'down') this.ui.focus = 'balances';
    } else if (focus === 'watch') {
      const n = (this.data.watch || []).length;
      if (name === 'up') { if (this.ui.watchSel > 0) this.ui.watchSel -= 1; else this.ui.focus = 'balances'; }
      else if (name === 'down') this.ui.watchSel = Math.min(Math.max(0, n - 1), this.ui.watchSel + 1);
      else if (k.str === 'a') return this.promptWatchAdd();
      else if (k.str === 'd') return this.removeWatch();
      else if (name === 'return' && n) return this.openAction('Buy', { token: this.data.watch[this.ui.watchSel].symbol });
      else if (k.str === 's' && n) return this.openAction('Sell', { token: this.data.watch[this.ui.watchSel].symbol });
    } else if (focus === 'trades') {
      const n = (this.data.trades || []).length;
      if (name === 'up') this.ui.tradeScroll = Math.max(0, this.ui.tradeScroll - 1);
      else if (name === 'down') this.ui.tradeScroll = Math.min(Math.max(0, n - 1), this.ui.tradeScroll + 1);
    } else if (focus === 'balances') {
      if (name === 'down') this.ui.focus = 'watch';
      else if (name === 'up') this.ui.focus = 'actions';
    }
    if (name === 'escape') this.ui.focus = 'actions';
    return this.invalidate();
  }

  cycleFocus(dir) {
    const i = FOCUS_ORDER.indexOf(this.ui.focus);
    this.ui.focus = FOCUS_ORDER[(i + dir + FOCUS_ORDER.length) % FOCUS_ORDER.length];
    this.invalidate();
  }

  quit() {
    this.quitRequested = true;
    if (this.pending) { this.pending.reject?.(new Error('Aborted.')); this.pending = null; }
    this.deps.quit?.();
    this.invalidate();
  }

  // ---------------------------------------------------------------- overlays
  closeOverlay() { this.ui.overlay = null; this.ui.focus = 'actions'; this.invalidate(); }

  overlayKey(o, k) {
    const name = k.name;
    if (o.type === 'help' || o.type === 'result') {
      if (name === 'escape' || name === 'return' || k.str === 'q') return this.closeOverlay();
      return undefined;
    }
    if (o.type === 'busy') return undefined; // cannot interrupt a running command; Ctrl-C quits
    if (o.type === 'confirm') {
      if (k.str === 'y' || k.str === 'Y') { const p = this.pending; this.pending = null; this.ui.overlay = { type: 'busy', title: o.title, lines: ['Submitting…'] }; this.invalidate(); p?.resolve(true); return undefined; }
      if (k.str === 'n' || k.str === 'N' || name === 'escape') { const p = this.pending; this.pending = null; this.ui.overlay = { type: 'busy', title: o.title, lines: ['Cancelling…'] }; this.invalidate(); p?.resolve(false); return undefined; }
      return undefined;
    }
    if (o.type === 'list') {
      if (name === 'escape') return this.closeOverlay();
      if (name === 'up') o.index = Math.max(0, o.index - 1);
      else if (name === 'down') o.index = Math.min(o.items.length - 1, o.index + 1);
      else if (name === 'return') return o.onSelect(o.items[o.index]);
      this.refreshListLines(o);
      return this.invalidate();
    }
    if (o.type === 'prompt') return this.promptKey(o, k);
    if (o.type === 'form') return this.formKey(o, k);
    return undefined;
  }

  refreshListLines(o) {
    o.lines = o.items.map((it, i) => ({ text: `${i === o.index ? '▸' : ' '} ${it.label}`, st: i === o.index ? S.title : S.ink }));
  }

  editField(fld, k) {
    if (fld.type === 'select') return false;
    if (k.name === 'backspace') { fld.value = Array.from(String(fld.value || '')).slice(0, -1).join(''); return true; }
    if (k.str && !k.ctrl && !k.meta && k.str >= ' ' && !/[\u007f-\u009f]/.test(k.str)) { fld.value = String(fld.value || '') + k.str; return true; }
    return false;
  }

  promptKey(o, k) {
    const fld = o.fields[0];
    if (k.name === 'escape') { const p = this.pending; this.pending = null; this.closeOverlay(); p?.reject(new Error('Aborted.')); return undefined; }
    if (k.name === 'return') { const p = this.pending; this.pending = null; const value = fld.value || ''; if (o.keepOpen) { this.ui.overlay = { type: 'busy', title: o.title, lines: ['Working…'] }; } this.invalidate(); p?.resolve(value); return undefined; }
    this.editField(fld, k);
    return this.invalidate();
  }

  // ---------------------------------------------------------------- forms
  openAction(name, prefill = {}) {
    if (name === 'Wallets') return this.openWallets();
    const def = ACTIONS[name];
    if (!def) return undefined;
    const values = { ...prefill };
    if (def.select) values[def.select.key] = def.select.options[0];
    const o = { type: 'form', action: name, title: def.title, values, index: 0, fields: [], select: def.select };
    this.ui.overlay = o;
    const init = name === 'Settings' ? this.deps.loadSettings?.() : null;
    if (init) Object.assign(values, init);
    this.rebuildForm(o, true);
    return this.invalidate();
  }

  rebuildForm(o, seed = false) {
    const defs = fieldsFor(o.action, o.values);
    const fields = [];
    if (o.select) {
      const sel = o.select;
      fields.push({ key: sel.key, label: sel.label, type: 'select', options: sel.options, selected: Math.max(0, sel.options.indexOf(o.values[sel.key])) });
    }
    for (const d of defs) {
      if (seed && o.values[d.key] === undefined && d.value !== undefined) o.values[d.key] = d.value;
      if (!seed && o.values[d.key] === undefined && d.value !== undefined) o.values[d.key] = d.value;
      fields.push({ key: d.key, label: d.label, optional: d.optional, placeholder: d.placeholder, hint: d.hint, value: o.values[d.key] ?? '', error: o.errors?.[d.key] || '' });
    }
    o.fields = fields;
    o.index = Math.min(o.index, Math.max(0, fields.length - 1));
  }

  syncValues(o) {
    for (const fld of o.fields) o.values[fld.key] = fld.type === 'select' ? fld.options[fld.selected] : fld.value;
  }

  formKey(o, k) {
    const name = k.name;
    if (name === 'escape') return this.closeOverlay();
    const fld = o.fields[o.index];
    if (!fld) { if (name === 'return') return this.submitForm(o); return undefined; }
    if (name === 'tab' || name === 'down') { o.index = (o.index + (k.shift ? -1 : 1) + o.fields.length) % o.fields.length; return this.invalidate(); }
    if (name === 'up') { o.index = (o.index - 1 + o.fields.length) % o.fields.length; return this.invalidate(); }
    if (fld.type === 'select') {
      if (name === 'left' || name === 'right') {
        fld.selected = (fld.selected + (name === 'right' ? 1 : -1) + fld.options.length) % fld.options.length;
        this.syncValues(o);
        o.errors = {};
        this.rebuildForm(o);
        return this.invalidate();
      }
      if (name === 'return') { if (o.fields.length === 1) return this.submitForm(o); o.index = Math.min(o.fields.length - 1, o.index + 1); return this.invalidate(); }
      return undefined;
    }
    if (name === 'return') {
      if (o.index < o.fields.length - 1) { o.index += 1; return this.invalidate(); }
      return this.submitForm(o);
    }
    if (this.editField(fld, k)) { fld.error = ''; this.syncValues(o); return this.invalidate(); }
    return undefined;
  }

  async submitForm(o) {
    this.syncValues(o);
    if (o.action === 'Settings') return this.submitSettings(o);
    const { errors, ok } = validateAll(o.action, o.values);
    o.errors = errors;
    this.rebuildForm(o);
    if (!ok) {
      o.index = Math.max(0, o.fields.findIndex((f) => f.error));
      return this.invalidate();
    }
    const cmd = commandFor(o.action, o.values);
    return this.execute(o.title, cmd);
  }

  async submitSettings(o) {
    const { errors, ok } = validateAll('Settings', o.values);
    o.errors = errors;
    this.rebuildForm(o);
    if (!ok) return this.invalidate();
    try {
      await this.deps.saveSettings?.(o.values);
      this.closeOverlay();
      this.status(`Saved: ${o.values.network}, per-tx ${o.values.perTxQuai} QUAI, daily ${o.values.dailyQuai} QUAI`, 'ok');
      this.deps.refresh?.();
    } catch (e) {
      o.fields.find((f) => f.key === 'perTxQuai').error = String(e.message || e).slice(0, 100);
      this.invalidate();
    }
    return undefined;
  }

  // ---------------------------------------------------------------- command execution (same code path as the CLI)
  makeIo(summary) {
    const plain = (s) => stripAnsi(String(s));
    return {
      write: (s) => { summary.push(plain(s)); },
      writeErr: (s) => { summary.push(plain(s)); },
      colors: undefined,
      confirmFn: () => new Promise((resolve, reject) => {
        const lines = summary.splice(0).join('\n').split('\n').filter((l) => l.trim()).map((text, i) => ({ text, st: i === 0 ? S.title : S.ink }));
        this.pending = { resolve, reject };
        this.ui.overlay = { type: 'confirm', title: 'Confirm', lines, footer: 'y  confirm and sign     n  cancel' };
        this.invalidate();
      }),
    };
  }

  askPassword(label) {
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      this.ui.overlay = { type: 'prompt', title: 'Keystore password', fields: [{ label: String(label).replace(/:\s*$/, ''), value: '', mask: true }], index: 0, keepOpen: true };
      this.invalidate();
    });
  }

  async execute(title, cmd) {
    this.ui.overlay = { type: 'busy', title, lines: [this.demo ? 'Demo — nothing is signed or sent…' : 'Simulating…'] };
    this.invalidate();
    const summary = [];
    const io = this.makeIo(summary);
    try {
      const result = await this.deps.runCommand(cmd.fn, cmd.opts, { io, passwordDeps: { promptFn: (label) => this.askPassword(label) } });
      this.showResult(title, result);
      this.deps.refresh?.();
    } catch (e) {
      const msg = String(e?.message || e);
      this.ui.overlay = { type: 'result', title: `${title} — failed`, lines: msg.split(/(?<=.{70})\s/).map((text) => ({ text, st: S.down })), footer: 'Esc close' };
      this.invalidate();
    }
  }

  showResult(title, result) {
    const lines = [];
    if (result?.aborted) lines.push({ text: 'Cancelled — nothing was sent.', st: S.warn });
    else if (result?.demo) lines.push({ text: 'DEMO — fixture data, nothing signed', st: S.warn });
    else if (result?.dryRun) lines.push({ text: 'Simulated only — not sent', st: S.warn });
    else if (result?.status === 'success') lines.push({ text: 'Confirmed on-chain', st: S.up });
    const flat = result?.summary ? flatten(result.summary) : flatten(result || {});
    for (const row of flat.slice(0, 18)) lines.push({ text: row, st: S.ink });
    if (result?.txHash) lines.push({ text: `tx ${result.txHash}`, st: S.muted });
    if (result?.quaiscanUrl) lines.push({ text: result.quaiscanUrl, st: S.muted });
    this.ui.overlay = { type: 'result', title, lines, footer: 'Esc close' };
    this.invalidate();
  }

  // ---------------------------------------------------------------- wallets / watchlist
  openWallets() {
    const wallets = this.deps.listWallets?.() || [];
    if (!wallets.length) {
      this.ui.overlay = { type: 'result', title: 'Wallets', lines: [{ text: 'No wallets yet.', st: S.warn }, { text: 'Run `hartii wallet new` or `hartii wallet import` in a shell.', st: S.ink }, { text: SENSITIVE_NOTE, st: S.muted }], footer: 'Esc close' };
      return this.invalidate();
    }
    const o = {
      type: 'list', title: 'Wallets', index: Math.max(0, wallets.findIndex((w) => w.current)), lines: [],
      items: wallets.map((w) => ({ name: w.name, label: `${w.name}  ${w.address}${w.current ? '  (current)' : ''}` })),
      footer: '↑↓ choose · Enter use · Esc close',
      onSelect: (item) => { this.deps.useWallet?.(item.name); this.closeOverlay(); this.status(`Using wallet "${item.name}"`, 'ok'); this.deps.refresh?.(); },
    };
    this.refreshListLines(o);
    this.ui.overlay = o;
    return this.invalidate();
  }

  promptWatchAdd() {
    const o = { type: 'prompt', title: 'Add to watchlist', fields: [{ label: 'Token ticker or address', value: '', mask: false }], index: 0 };
    this.ui.overlay = o;
    this.pending = {
      resolve: async (value) => {
        const ref = String(value).trim();
        this.closeOverlay();
        if (!ref) return;
        try { await this.deps.addWatch?.(ref); this.status(`Watching ${ref}`, 'ok'); } catch (e) { this.status(String(e.message || e), 'error'); }
      },
      reject: () => this.closeOverlay(),
    };
    return this.invalidate();
  }

  async removeWatch() {
    const t = (this.data.watch || [])[this.ui.watchSel];
    if (!t) return undefined;
    try { await this.deps.removeWatch?.(t.address || t.symbol); this.ui.watchSel = Math.max(0, this.ui.watchSel - 1); this.status(`Removed ${t.symbol}`, 'ok'); } catch (e) { this.status(String(e.message || e), 'error'); }
    return undefined;
  }
}

/** Flattens a (JSON-safe) summary into "key: value" rows, one level deep for nested objects. */
export function flatten(obj, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === undefined || v === null || k === 'action' || k === 'ok' || k === 'demo') continue;
    if (Array.isArray(v)) { out.push(`${prefix}${k}: ${v.length} item(s)`); for (const it of v.slice(0, 6)) out.push(...flatten(typeof it === 'object' ? it : { value: it }, '  ')); }
    else if (typeof v === 'object') { out.push(`${prefix}${k}:`); out.push(...flatten(v, `${prefix}  `)); }
    else out.push(`${prefix}${k}: ${v}`);
  }
  return out;
}
