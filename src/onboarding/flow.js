// packages/hartii-cli/src/onboarding/flow.js
//
// The guided first-run setup as a state machine. No terminal I/O and no rendering here: the full-screen UI
// (tui/setup.js + tui/app.js) drives it with key(), the plain terminal driver (onboarding/plain.js) drives it
// with the explicit step methods, and every side effect goes through injected `effects`, so the same rules hold
// in both and the tests need no terminal, keystore or network.
//
// Steps: welcome -> (import-kind -> import-secret ->) password -> confirm -> creating -> (phrase -> verify ->)
//        caps (-> caps-custom) -> receive -> received -> done          (+ error)
//
// Recovery-phrase rules (owner 2026-11-16): the phrase lives only in `this.#phrase` while the setup runs, is shown
// only by the renderer of the 'phrase' step, is never part of the public state (`snapshot()`), is dropped the moment
// the backup is verified or the user explicitly chooses "back up later", and never goes through a logger, history,
// clipboard or any effect. Setup cannot finish with an unverified backup unless "back up later" was chosen on
// purpose, which writes a persistent reminder via effects.markBackupPending.
import { randomInt } from 'node:crypto';
import { checkNewPassword, passwordStrength } from './password.js';
import { PRESET_NAMES, resolvePreset } from '../presets.js';

export const STEPS = ['welcome', 'import-kind', 'import-secret', 'password', 'confirm', 'creating', 'phrase', 'verify', 'caps', 'caps-custom', 'receive', 'received', 'done', 'error'];
export const WELCOME_CHOICES = ['create', 'import'];
export const IMPORT_KINDS = ['mnemonic', 'key'];
export const CAPS_CHOICES = [...PRESET_NAMES, 'custom', 'skip'];
export const VERIFY_ROWS = 6; // 3 word fields, check, show again, back up later
const WORD = /^[a-z]{3,8}$/;
const DEC = /^(?:0|[1-9]\d{0,17})(?:\.\d{1,18})?$/;

const printable = (k) => k.str && !k.ctrl && !k.meta && k.str >= ' ' && !/[\u007f-\u009f]/.test(k.str);

export class SetupFlow {
  #phrase = null; // string[] | null
  #password = null;
  #secret = null;

  /**
   * @param {object} o
   * @param {object} o.effects {
   *   createWallet({password, name}) -> {name, address, phrase},
   *   importWallet({kind, secret, password, name}) -> {name, address},
   *   saveCaps({perTxQuai, dailyQuai}) -> void, markBackupPending(name), clearBackupPending(name),
   *   activate?(name) -> void  (tell the app the new wallet is the current one), copyText?(text) -> {ok} }
   * @param {() => number} [o.now]
   * @param {(n:number) => number} [o.rng] integer in [0,n)
   * @param {string} [o.walletName] suggested wallet name
   * @param {boolean} [o.backupOnly] start at 'unlock'-less backup flow is handled by the app; unused here
   */
  constructor({ effects, now = Date.now, rng = (n) => randomInt(n), walletName = undefined } = {}) {
    this.effects = effects || {};
    this.now = now;
    this.rng = rng;
    this.walletName = walletName;
    this.step = 'welcome';
    this.mode = null; // 'create' | 'import'
    this.importKind = null;
    this.name = null;
    this.address = null;
    this.error = '';
    this.notice = '';
    this.sel = 0; // list cursor (welcome / import-kind / caps)
    this.text = ''; // the single-line buffer of password / confirm / import-secret
    this.words = ['', '', '']; // verify answers
    this.askIdx = []; // 0-based positions asked in verify
    this.row = 0; // verify focus row / caps-custom field
    this.attempts = 0;
    this.laterArmed = false;
    this.backupVerified = false;
    this.backupPending = false;
    this.capsChoice = null;
    this.caps = { perTx: '', daily: '' };
    this.baselineWei = null;
    this.receivedWei = null;
    this.balanceWei = null;
    this.waitStartedAt = null;
    this.receivedAt = null;
    this.quitRequested = false;
    this.busy = false;
  }

  /** The backup check for an existing wallet (the home banner): starts on the phrase page with a phrase the app just decrypted. */
  static forBackup({ effects, name, address, phrase, rng, now }) {
    const f = new SetupFlow({ effects, rng, now });
    f.mode = 'backup'; f.name = name; f.address = address; f.backupPending = true;
    f.#phrase = String(phrase).trim().split(/\s+/);
    return f;
  }

  /** Public, secret-free view for renderers/tests. */
  snapshot() {
    return {
      step: this.step, mode: this.mode, importKind: this.importKind, name: this.name, address: this.address, error: this.error, notice: this.notice,
      sel: this.sel, textLength: Array.from(this.text).length, words: [...this.words], askIdx: [...this.askIdx], row: this.row, attempts: this.attempts,
      laterArmed: this.laterArmed, backupVerified: this.backupVerified, backupPending: this.backupPending, capsChoice: this.capsChoice, caps: { ...this.caps },
      receivedWei: this.receivedWei, balanceWei: this.balanceWei,
    };
  }

  get phraseWords() { return this.#phrase ? [...this.#phrase] : null; }
  get hasPhrase() { return Boolean(this.#phrase); }
  get strength() { return passwordStrength(this.text); }

  #go(step) { this.step = step; this.error = ''; this.notice = ''; this.text = ''; this.sel = 0; this.row = 0; }

  // ---------------------------------------------------------------- explicit step methods (used by both drivers)
  choose(kind) {
    if (this.step !== 'welcome') return;
    if (!WELCOME_CHOICES.includes(kind)) return;
    this.mode = kind;
    this.#go(kind === 'create' ? 'password' : 'import-kind');
  }

  chooseImportKind(kind) {
    if (this.step !== 'import-kind' || !IMPORT_KINDS.includes(kind)) return;
    this.importKind = kind;
    this.#go('import-secret');
  }

  submitSecret(secret) {
    if (this.step !== 'import-secret') return;
    const v = String(secret ?? '').trim();
    if (!v) { this.error = this.importKind === 'key' ? 'Paste the private key first.' : 'Paste the recovery phrase first.'; return; }
    this.#secret = v;
    this.#go('password');
  }

  submitPassword(pw) {
    if (this.step !== 'password') return;
    const why = checkNewPassword(pw);
    if (why) { this.error = why; return; }
    this.#password = String(pw);
    this.#go('confirm');
  }

  /** Confirm the password; on a match creates (or imports) the wallet. */
  async submitConfirm(pw2) {
    if (this.step !== 'confirm') return;
    if (String(pw2) !== this.#password) { this.error = 'The two passwords do not match. Try again.'; this.text = ''; return; }
    await this.#create();
  }

  async #create() {
    this.#go('creating');
    this.busy = true;
    try {
      if (this.mode === 'create') {
        const r = await this.effects.createWallet({ password: this.#password, name: this.walletName });
        this.name = r.name; this.address = r.address;
        this.#phrase = String(r.phrase).trim().split(/\s+/);
        this.effects.activate?.(this.name);
        this.#go('phrase');
      } else {
        const r = await this.effects.importWallet({ kind: this.importKind, secret: this.#secret, password: this.#password, name: this.walletName });
        this.name = r.name; this.address = r.address;
        this.effects.activate?.(this.name);
        this.#go('caps');
      }
    } catch (e) {
      this.#go('error');
      this.error = String(e?.message || e).split('\n')[0].slice(0, 160);
    } finally {
      this.#password = null; this.#secret = null; this.busy = false;
    }
  }

  /** From the error page back to the start of the password step (keeps the mode). */
  retry() {
    if (this.step !== 'error') return;
    this.#go(this.mode === 'import' && !this.#secret ? 'import-secret' : 'password');
  }

  /** The user says they wrote the phrase down: ask for 3 random words. */
  startVerify() {
    if (this.step !== 'phrase' || !this.#phrase) return;
    const picks = new Set();
    for (let tries = 0; picks.size < 3 && tries < 200; tries += 1) picks.add(this.rng(this.#phrase.length));
    for (let i = 0; picks.size < 3; i += 1) picks.add(i); // a stuck random source can never hang setup
    this.askIdx = [...picks].sort((a, b) => a - b);
    this.words = ['', '', ''];
    this.laterArmed = false;
    this.#go('verify');
  }

  /** Re-draw the phrase page (from verify). */
  showAgain() {
    if (this.step !== 'verify') return;
    this.#go('phrase');
  }

  /** @param {string[]} answers three words, in the order of askIdx */
  submitWords(answers) {
    if (this.step !== 'verify' || !this.#phrase) return false;
    let wrong = 0;
    this.askIdx.forEach((pos, i) => {
      const given = String(answers[i] ?? '').trim().toLowerCase();
      if (given !== this.#phrase[pos]) wrong += 1;
    });
    if (wrong) {
      this.attempts += 1;
      this.error = wrong === 3 ? 'None of the words match. Check your notes, or show the phrase again.' : `${wrong} of 3 words do not match. Check your notes, or show the phrase again.`;
      this.laterArmed = false;
      return false;
    }
    this.#phrase = null;
    this.backupVerified = true;
    if (this.backupPending) { this.backupPending = false; this.effects.clearBackupPending?.(this.name); }
    this.#go(this.mode === 'backup' ? 'done' : 'caps');
    return true;
  }

  /** Explicit "back up later". Two presses: the first arms it with a warning, the second confirms. */
  backUpLater() {
    if (this.step !== 'verify' && this.step !== 'phrase') return false;
    if (!this.laterArmed) { this.laterArmed = true; this.notice = 'Without your phrase, nobody can recover this wallet. Choose "Back up later" again to confirm.'; return false; }
    this.#dropPhrase();
    this.effects.markBackupPending?.(this.name);
    this.backupPending = true;
    this.#go(this.mode === 'backup' ? 'done' : 'caps');
    return true;
  }

  #dropPhrase() { this.#phrase = null; this.laterArmed = false; }

  /** Called when the app quits/aborts: an unverified backup leaves the reminder behind, and the phrase is dropped. */
  abort() {
    if (this.#phrase && this.name) { this.effects.markBackupPending?.(this.name); this.backupPending = true; }
    this.#phrase = null; this.#password = null; this.#secret = null;
  }

  setCaps(choice, custom = null) {
    if (this.step !== 'caps' && this.step !== 'caps-custom') return false;
    if (choice === 'skip') { this.capsChoice = 'skip'; this.#go('receive'); this.#startWait(); return true; }
    if (choice === 'custom') {
      if (!custom) { this.#go('caps-custom'); return false; }
      const perTx = String(custom.perTxQuai ?? '').trim(), daily = String(custom.dailyQuai ?? '').trim();
      if (!DEC.test(perTx) || !/[1-9]/.test(perTx)) { this.error = 'Per-transaction cap must be a QUAI amount like 5 or 0.5.'; return false; }
      if (!DEC.test(daily) || !/[1-9]/.test(daily)) { this.error = 'Daily cap must be a QUAI amount like 20 or 2.5.'; return false; }
      if (Number(perTx) > Number(daily)) { this.error = 'The per-transaction cap cannot be above the daily cap.'; return false; }
      this.effects.saveCaps?.({ perTxQuai: perTx, dailyQuai: daily });
      this.capsChoice = 'custom'; this.#go('receive'); this.#startWait();
      return true;
    }
    if (!PRESET_NAMES.includes(choice)) return false;
    const p = resolvePreset({ preset: choice });
    this.effects.saveCaps?.({ perTxQuai: p.perTxQuai, dailyQuai: p.dailyQuai });
    this.capsChoice = choice; this.#go('receive'); this.#startWait();
    return true;
  }

  // A wallet created in this setup is a fresh random key, so its baseline is zero: a deposit that lands before the first
  // balance poll still counts as received. An imported wallet may already hold funds, so its first reading is the baseline.
  #startWait() { this.waitStartedAt = this.now(); this.baselineWei = this.mode === 'create' ? 0n : null; }

  /** Feed the live balance (wei string or null) and, when known, the address it was read for. Readings for another wallet
   *  are ignored. The baseline is zero for a created wallet, else the first reading; any increase after it is "received". */
  onBalance(wei, address) {
    if (wei === null || wei === undefined) return;
    if (address && this.address && String(address).toLowerCase() !== String(this.address).toLowerCase()) return;
    let w;
    try { w = BigInt(wei); } catch { return; }
    this.balanceWei = w.toString();
    if (this.step !== 'receive') return;
    if (this.baselineWei === null) { this.baselineWei = w; return; }
    if (w > this.baselineWei) {
      this.receivedWei = (w - this.baselineWei).toString();
      this.receivedAt = this.now();
      this.#go('received');
    } else if (w < this.baselineWei) this.baselineWei = w;
  }

  skipReceive() { if (this.step === 'receive' || this.step === 'received') this.#go('done'); }
  finish() { if (this.step === 'received') this.#go('done'); }

  // ---------------------------------------------------------------- key driver (full-screen UI)
  /** @returns {Promise<void>|void} */
  key(k) {
    const name = k.name;
    switch (this.step) {
      case 'welcome': return this.#listKey(k, WELCOME_CHOICES, (c) => this.choose(c), () => { this.quitRequested = true; });
      case 'import-kind': return this.#listKey(k, IMPORT_KINDS, (c) => this.chooseImportKind(c), () => this.#go('welcome'));
      case 'import-secret':
        if (name === 'escape') return this.#go('import-kind');
        if (name === 'return') return this.submitSecret(this.text);
        return this.#edit(k);
      case 'password':
        if (name === 'escape') return this.#back();
        if (name === 'return') return this.submitPassword(this.text);
        return this.#edit(k);
      case 'confirm':
        if (name === 'escape') { this.#password = null; return this.#go('password'); }
        if (name === 'return') { const v = this.text; this.text = ''; return this.submitConfirm(v); }
        return this.#edit(k);
      case 'phrase':
        if (name === 'return' || name === 'right') return this.startVerify();
        return undefined;
      case 'verify': return this.#verifyKey(k);
      case 'caps': return this.#listKey(k, CAPS_CHOICES, (c) => this.setCaps(c), () => this.setCaps('skip'));
      case 'caps-custom': return this.#customKey(k);
      case 'receive':
        if (name === 'return' || name === 'escape' || k.str === 's') return this.skipReceive();
        if (k.str === 'c' && this.address) { this.notice = ''; return Promise.resolve(this.effects.copyText?.(this.address)).then((r) => { this.notice = r?.ok ? 'Address copied.' : 'Could not copy. Select the address and copy it by hand.'; }); }
        return undefined;
      case 'received':
        if (name === 'return' || name === 'escape') return this.finish();
        return undefined;
      case 'error':
        if (name === 'return') return this.retry();
        if (name === 'escape') { this.quitRequested = true; }
        return undefined;
      default: return undefined;
    }
  }

  #back() { this.#password = null; if (this.mode === 'import') this.#go('import-secret'); else this.#go('welcome'); }

  #edit(k) {
    if (k.name === 'backspace') { this.text = Array.from(this.text).slice(0, -1).join(''); this.error = ''; return; }
    if (printable(k)) { this.text += k.str; this.error = ''; }
  }

  #listKey(k, items, pick, escape) {
    if (k.name === 'up') this.sel = (this.sel + items.length - 1) % items.length;
    else if (k.name === 'down' || k.name === 'tab') this.sel = (this.sel + 1) % items.length;
    else if (k.name === 'return') return pick(items[this.sel]);
    else if (k.name === 'escape') return escape();
    else if (/^[1-9]$/.test(k.str || '') && Number(k.str) <= items.length) { this.sel = Number(k.str) - 1; return pick(items[this.sel]); }
    return undefined;
  }

  #verifyKey(k) {
    const name = k.name;
    if (name === 'up') { this.row = (this.row + VERIFY_ROWS - 1) % VERIFY_ROWS; return; }
    if (name === 'down' || name === 'tab') { this.row = (this.row + 1) % VERIFY_ROWS; return; }
    if (name === 'escape') { this.showAgain(); return; }
    if (this.row < 3) {
      if (name === 'return') { if (this.row < 2) this.row += 1; else this.row = 3; return; }
      if (name === 'backspace') { this.words[this.row] = Array.from(this.words[this.row]).slice(0, -1).join(''); this.error = ''; return; }
      if (printable(k) && k.str !== ' ' && this.words[this.row].length < 12) { this.words[this.row] += k.str.toLowerCase(); this.error = ''; this.laterArmed = false; }
      return;
    }
    if (name !== 'return') return;
    if (this.row === 3) { this.submitWords(this.words); return; }
    if (this.row === 4) { this.showAgain(); return; }
    this.backUpLater();
  }

  #customKey(k) {
    const name = k.name;
    const fields = ['perTx', 'daily'];
    if (name === 'escape') { this.#go('caps'); return; }
    if (name === 'up' || name === 'down' || name === 'tab') { this.row = (this.row + 1) % 2; return; }
    if (name === 'return') {
      if (this.row === 0) { this.row = 1; return; }
      this.setCaps('custom', { perTxQuai: this.caps.perTx, dailyQuai: this.caps.daily });
      return;
    }
    const f = fields[this.row];
    if (name === 'backspace') { this.caps[f] = this.caps[f].slice(0, -1); this.error = ''; return; }
    if (printable(k) && /^[0-9.]$/.test(k.str) && this.caps[f].length < 24) { this.caps[f] += k.str; this.error = ''; }
  }
}

export { WORD };
