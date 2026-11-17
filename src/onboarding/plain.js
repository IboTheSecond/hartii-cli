// packages/hartii-cli/src/onboarding/plain.js
//
// The guided setup for a plain terminal (no full-screen UI): `hartii wallet new` and `hartii init` on a TTY.
// It drives the SAME SetupFlow state machine as the TUI with prompts in sequence. The recovery phrase is shown
// once on the terminal's ALTERNATE screen and wiped (clear + leave) right after, so it never lands in scrollback;
// it never touches stdout, a log, shell history or the clipboard. Not for --json or a non-TTY: callers keep the
// scriptable path there, and this refuses to run without an interactive terminal.
import { SetupFlow, CAPS_CHOICES } from './flow.js';
import { makeSetupEffects } from './effects.js';
import { passwordStrength } from './password.js';
import { addressGroups } from '../tui/setup.js';
import { createReceiveQr, renderReceiveQr } from '../qr.js';
import { readHiddenInput, readVisibleInput } from '../prompt.js';
import { PRESETS, resolvePreset } from '../presets.js';
import { WalletError } from '../keystore.js';
import { detectAscii } from '../tui/glyphs.js';

const ALT_ON = '\u001b[?1049h\u001b[2J\u001b[H';
const ALT_OFF = '\u001b[2J\u001b[H\u001b[?1049l';

/**
 * @param {string} home
 * @param {object} [io] { mode: 'create'|'ask', env, stdin, stdout (prompt stream), out(s), promptFn (hidden), visibleFn, effects, scrypt, rng, now, interactive, ascii, walletName }
 * @returns {Promise<{ name: string, address: string, backedUp: boolean, backupPending: boolean, caps: string|null }>}
 */
export async function runPlainSetup(home, io = {}) {
  const env = io.env || process.env;
  const stdin = io.stdin || process.stdin;
  const out = io.out || ((s) => process.stderr.write(s));
  const interactive = io.interactive ?? Boolean(stdin.isTTY && (io.stdout || process.stderr).isTTY);
  if (!interactive) throw new WalletError('The guided setup needs an interactive terminal. For scripts use `hartii wallet new` with HARTII_PASSWORD, which never shows the recovery phrase.');
  if (String(env.TERM || '').toLowerCase() === 'dumb') throw new WalletError('This terminal cannot hide the recovery phrase after showing it (TERM=dumb). Open a normal terminal window and try again.');
  const ascii = io.ascii ?? detectAscii(env);
  const hidden = io.promptFn || readHiddenInput;
  const visible = io.visibleFn || readVisibleInput;
  const streams = { stdin, stdout: io.stdout || process.stderr };
  const effects = io.effects || makeSetupEffects({ home, scrypt: io.scrypt, walletName: io.walletName });
  const flow = new SetupFlow({ effects, rng: io.rng, now: io.now });
  let inAlt = false; // true while the recovery phrase page is on the alternate screen
  const say = (s = '') => out(`${s}\n`);
  const ask = (label) => visible(label, streams);

  try {
    say(''); say('Hartii wallet setup (BETA). It takes about two minutes and nothing leaves this computer.'); say('');
    if (io.mode === 'ask') {
      say('  1  Create a new wallet'); say('  2  I already have a wallet (import it)');
      const a = String(await ask('Choose 1 or 2: ')).trim();
      flow.choose(a === '2' ? 'import' : 'create');
    } else flow.choose('create');

    if (flow.step === 'import-kind') {
      say('  1  A recovery phrase (12 or 24 words)'); say('  2  A private key');
      const a = String(await ask('Choose 1 or 2: ')).trim();
      flow.chooseImportKind(a === '2' ? 'key' : 'mnemonic');
      for (;;) {
        flow.submitSecret(await hidden(flow.importKind === 'key' ? 'Private key (hidden): ' : 'Recovery phrase (hidden): ', streams));
        if (flow.step !== 'import-secret') break;
        say(`  ! ${flow.error}`);
      }
    }

    // password -> confirm -> create (retry until it is accepted)
    while (flow.step === 'password' || flow.step === 'confirm') {
      if (flow.step === 'password') {
        say('Choose a password. It locks this wallet on this computer. Use at least 12 characters.');
        const pw = await hidden('New password (12+ characters): ', streams);
        const st = passwordStrength(pw);
        flow.submitPassword(pw);
        if (flow.step === 'password') { say(`  ! ${flow.error}`); continue; }
        say(`  Strength: ${st.label}`);
      } else {
        await flow.submitConfirm(await hidden('Confirm password: ', streams));
        if (flow.step === 'confirm') { say(`  ! ${flow.error}`); flow.key({ name: 'escape' }); }
      }
    }
    if (flow.step === 'error') throw new WalletError(flow.error);

    // recovery phrase: alternate screen, once, wiped
    if (flow.step === 'phrase') {
      let done = false;
      while (!done) {
        const words = flow.phraseWords;
        let page = ALT_ON + 'YOUR RECOVERY PHRASE\n\n';
        page += 'These words are the only way to get your wallet back. Write them on paper, in order.\n';
        page += 'Never type them anywhere else. Nobody from Hartii will ever ask for them.\n\n';
        words.forEach((w, i) => { page += `  ${String(i + 1).padStart(2)}. ${w}\n`; });
        page += '\nShown once. It is not saved, logged or copied anywhere.\n\n';
        out(page); inAlt = true;
        await visible('Press Enter once you have written them down: ', streams);
        out(ALT_OFF); inAlt = false;
        flow.startVerify();
        let verified = false;
        while (flow.step === 'verify' && !verified) {
          say(''); say(`Check your backup: type words ${flow.askIdx.map((i) => `#${i + 1}`).join(', ')}.`);
          say('(Type "show" to see the phrase again, or "later" to back up later.)');
          const answers = [];
          let special = null;
          for (const idx of flow.askIdx) {
            const a = String(await ask(`Word #${idx + 1}: `)).trim().toLowerCase();
            if (a === 'show' || a === 'later') { special = a; break; }
            answers.push(a);
          }
          if (special === 'show') { flow.showAgain(); break; }
          if (special === 'later') {
            flow.backUpLater();
            say(`  ! ${flow.notice}`);
            const yes = /^y(es)?$/i.test(String(await ask('Back up later anyway? [y/N] ')).trim());
            if (yes) flow.backUpLater();
            if (flow.step !== 'verify') { done = true; verified = true; }
            continue;
          }
          if (flow.submitWords(answers)) { done = true; verified = true; } else say(`  ! ${flow.error}`);
        }
        if (flow.step === 'caps') done = true;
      }
    }

    // spending caps (recommended, skippable)
    if (flow.step === 'caps') {
      say(''); say('Set a safety limit? (recommended) A cap limits how much QUAI one send, or one day of sends, can move.');
      CAPS_CHOICES.forEach((c, i) => {
        const label = c === 'custom' ? 'Custom amounts' : c === 'skip' ? 'Skip for now' : c[0].toUpperCase() + c.slice(1);
        const hint = PRESETS[c] ? (() => { const p = resolvePreset({ preset: c }); return `  ${p.perTxQuai} QUAI per send, ${p.dailyQuai} per day`; })() : '';
        say(`  ${i + 1}  ${label}${hint}`);
      });
      for (;;) {
        const n = Number(String(await ask(`Choose 1-${CAPS_CHOICES.length} [1]: `)).trim() || '1');
        const choice = CAPS_CHOICES[n - 1];
        if (!choice) { say('  ! Pick one of the numbers above.'); continue; }
        if (choice === 'custom') {
          flow.setCaps('custom');
          const perTx = String(await ask('Most QUAI per send: ')).trim();
          const daily = String(await ask('Most QUAI per day: ')).trim();
          if (!flow.setCaps('custom', { perTxQuai: perTx, dailyQuai: daily })) { say(`  ! ${flow.error}`); flow.key({ name: 'escape' }); continue; }
        } else flow.setCaps(choice);
        break;
      }
    }

    // receive
    say(''); say('Your address (copy it from the line below, or scan the QR):');
    say(`  ${flow.address}`);
    say(`  ${addressGroups(flow.address).join('  ')}`);
    try {
      if (!ascii) say(renderReceiveQr(createReceiveQr(flow.address).matrix, { color: false }).text);
      else say('  Run `hartii wallet address --qr` for a QR code.');
    } catch { /* the address above is enough */ }
    say('Send some QUAI to it from an exchange or another wallet (Quai network, Cyprus-1 zone). Run `hartii` to watch it arrive.');
    if (flow.backupPending) say('! Back up your recovery phrase: run `hartii` and press B, or `hartii wallet export`.');
    return { name: flow.name, address: flow.address, backedUp: flow.backupVerified, backupPending: flow.backupPending, caps: flow.capsChoice };
  } catch (error) {
    flow.abort();
    if (inAlt) out(ALT_OFF); // Ctrl-C on the phrase page still wipes it
    throw error;
  }
}

/** `hartii init` on a TTY with no wallet yet: same flow, but asks create or import first. */
export function runGuidedInit(home, io = {}) {
  return runPlainSetup(home, { ...io, mode: 'ask' });
}
