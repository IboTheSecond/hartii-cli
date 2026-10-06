// packages/hartii-cli/src/prompt.js
//
// Interactive prompts: a masked password prompt (keystore encrypt/decrypt) and a y/N confirm
// (the write pipeline's confirmation gate). Every function here takes its I/O as injectable
// `deps` so command/pipeline tests never spawn a real TTY — the default wires up real
// stdin/stderr only when nothing is injected, keeping stdout clean for --json.
import { createInterface } from 'node:readline';

const closedInput = () => new Error('Input closed before an answer.');

function readLine(label, deps) {
  const stdin = deps.stdin || process.stdin;
  const stdout = deps.stdout || process.stderr;
  if (stdin.readableEnded || stdin.destroyed) return Promise.reject(closedInput());
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: stdin, output: stdout, terminal: false });
    let done = false;
    const finish = (error, answer) => {
      if (done) return;
      done = true;
      stdin.removeListener('error', onError);
      rl.close();
      if (error) reject(error);
      else resolve(answer);
    };
    const onError = (error) => finish(error);
    stdin.once('error', onError);
    rl.once('close', () => finish(closedInput()));
    rl.question(label, (answer) => finish(null, answer));
  });
}

/**
 * Reads one line from stdin with input masked (each keystroke echoed as nothing — not even "*",
 * matching the spec's "hidden prompt" requirement). When stdin is not a TTY it REFUSES (a piped
 * secret cannot be masked) unless `deps.allowPipedSecret` is true, set only by the explicit --stdin flag.
 * @param {string} label
 * @param {{ stdin?: NodeJS.ReadStream, stdout?: NodeJS.WriteStream }} [deps]
 * @returns {Promise<string>}
 */
export function readHiddenInput(label, deps = {}) {
  const stdin = deps.stdin || process.stdin;
  const stdout = deps.stdout || process.stderr;

  if (!stdin.isTTY) {
    // A secret read from a non-terminal stdin cannot be masked and would echo in plain text. Refuse unless the
    // caller deliberately piped it (--stdin); HARTII_PASSWORD never reaches this function.
    if (deps.allowPipedSecret !== true) {
      return Promise.reject(new Error('Refusing to read a password or secret from a non-interactive stdin: it cannot be hidden. Run this in a terminal, set HARTII_PASSWORD for automation, or pass --stdin to deliberately pipe the secret in.'));
    }
    return readLine(label, { ...deps, stdin, stdout });
  }
  if (stdin.readableEnded || stdin.destroyed) return Promise.reject(closedInput());

  return new Promise((resolve, reject) => {
    stdout.write(label);
    let input = '';
    let done = false;
    const previousRaw = Boolean(stdin.isRaw);
    const finish = (error) => {
      if (done) return;
      done = true;
      cleanup();
      stdout.write('\n');
      if (error) reject(error);
      else resolve(input);
    };
    const onData = (chunk) => {
      // A paste may deliver the answer AND CRLF in one data event. Handle code points
      // individually, stopping at the first terminator, without ever echoing the secret.
      for (const c of chunk.toString('utf8')) {
        if (c === '\n' || c === '\r') return finish();
        if (c === '\u0003') return finish(new Error('Aborted.'));
        if (c === '\u0004') return finish(closedInput());
        if (c === '\u007f' || c === '\b') {
          input = Array.from(input).slice(0, -1).join('');
        } else if (c >= ' ' && !(c >= '\u0080' && c <= '\u009f')) {
          input += c;
        }
      }
    };
    const onEnd = () => finish(closedInput());
    const onError = (error) => finish(error);
    const cleanup = () => {
      stdin.setRawMode(previousRaw);
      stdin.removeListener('data', onData);
      stdin.removeListener('end', onEnd);
      stdin.removeListener('close', onEnd);
      stdin.removeListener('error', onError);
      stdin.pause();
    };
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
    stdin.once('end', onEnd);
    stdin.once('close', onEnd);
    stdin.once('error', onError);
    stdin.resume();
  });
}

/**
 * Resolves the password for a keystore operation: `HARTII_PASSWORD` env (loud warning — meant for
 * CI, not interactive use) wins if set, otherwise prompts.
 * @param {{ env?: NodeJS.ProcessEnv, promptFn?: typeof readHiddenInput, label?: string, writeErr?: (s:string)=>void }} [deps]
 */
export async function resolvePassword(deps = {}) {
  const env = deps.env || process.env;
  const writeErr = deps.writeErr || ((s) => process.stderr.write(s));
  if (typeof env.HARTII_PASSWORD === 'string' && env.HARTII_PASSWORD !== '') {
    writeErr('Warning: using HARTII_PASSWORD from the environment — fine for CI, never leave it set on a shared machine.\n');
    return env.HARTII_PASSWORD;
  }
  const promptFn = deps.promptFn || readHiddenInput;
  return promptFn(deps.label || 'Password: ', deps);
}

/**
 * Plain (unmasked) single-line prompt — used for typed confirmations (e.g. "type the wallet name
 * to confirm") where there is nothing secret to hide and seeing what you typed matters.
 * @param {string} label
 * @param {{ stdin?: NodeJS.ReadStream, stdout?: NodeJS.WriteStream }} [deps]
 * @returns {Promise<string>}
 */
export function readVisibleInput(label, deps = {}) {
  return readLine(label, deps);
}

/**
 * y/N confirmation prompt. Any answer other than "y"/"yes" (case-insensitive) is a decline,
 * including an empty line — a write command must never proceed on an ambiguous answer.
 * @param {string} question
 * @param {{ stdin?: NodeJS.ReadStream, stdout?: NodeJS.WriteStream }} [deps]
 * @returns {Promise<boolean>}
 */
export async function confirm(question, deps = {}) {
  const answer = await readLine(`${question} [y/N] `, deps);
  return /^y(es)?$/i.test(String(answer || '').trim());
}
