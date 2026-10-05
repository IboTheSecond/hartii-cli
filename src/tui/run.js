// packages/hartii-cli/src/tui/run.js
//
// Terminal lifecycle for the TUI: alternate screen buffer, raw keypresses via readline, resize-aware
// redraws, and a guaranteed restore of the terminal on quit / Ctrl-C / crash. Zero dependencies.
// Non-TTY stdin/stdout (a pipe, CI) never enters raw mode: it prints ONE plain-text frame instead.
import { emitKeypressEvents } from 'node:readline';
import { TuiApp } from './app.js';
import { createDataSource } from './data.js';
import { colorDepth } from './theme.js';
import { renderFrame } from './render.js';

const ENTER = '\u001b[?1049h\u001b[?25l\u001b[2J';
const LEAVE = '\u001b[0m\u001b[?25h\u001b[?1049l';

export function writeFrame(stdout, screen, depth) {
  const rows = screen.toAnsiRows(depth);
  let out = '\u001b[H';
  for (let i = 0; i < rows.length; i += 1) out += `\u001b[${i + 1};1H${rows[i]}\u001b[0m`;
  stdout.write(out);
}

/**
 * @param {{ stdin?: any, stdout?: any, env?: object, demo?: boolean, home?: string, network?: string|null, rpc?: string|null, wallet?: string|null, fetchFn?: Function, providerFactory?: Function, walletFactory?: Function, WebSocketImpl?: any }} o
 * @returns {Promise<number>} exit code
 */
export async function runTui(o = {}) {
  const stdin = o.stdin || process.stdin;
  const stdout = o.stdout || process.stdout;
  const env = o.env || process.env;
  const depth = colorDepth(env);
  const source = createDataSource({ ...o, env });
  const size = () => ({ cols: stdout.columns || 80, rows: stdout.rows || 24 });

  // Not an interactive terminal: one plain frame, no raw mode, no alternate screen.
  if (!stdin.isTTY || !stdout.isTTY) {
    const app = new TuiApp({ data: source.initial, size: { cols: 80, rows: 24 }, deps: source.deps, demo: Boolean(o.demo) });
    stdout.write(`${app.frame().toPlain()}\n`);
    return 0;
  }

  const app = new TuiApp({ data: source.initial, size: size(), deps: source.deps, demo: Boolean(o.demo) });
  return new Promise((resolve) => {
    let finished = false;
    let timer = null;
    let queued = false;
    const draw = () => { queued = false; if (!finished) writeFrame(stdout, app.frame(), depth); };
    const schedule = () => { if (!queued) { queued = true; setImmediate(draw); } };
    app.onChange = schedule;

    const onKey = (str, key = {}) => app.key({ str, name: key.name, ctrl: key.ctrl, shift: key.shift, meta: key.meta });
    const onResize = () => { const s = size(); app.resize(s.cols, s.rows); };
    const cleanup = () => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      source.stop();
      stdin.removeListener('keypress', onKey);
      stdout.removeListener('resize', onResize);
      process.removeListener('exit', cleanup);
      process.removeListener('SIGTERM', onSignal);
      try { stdin.setRawMode(false); } catch { /* not raw */ }
      stdin.pause();
      stdout.write(LEAVE);
    };
    const onSignal = () => { cleanup(); resolve(130); };
    app.deps.quit = () => { cleanup(); resolve(0); };

    emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('keypress', onKey);
    stdout.on('resize', onResize);
    process.on('exit', cleanup);
    process.on('SIGTERM', onSignal);
    stdout.write(ENTER);
    source.start(app);
    timer = setInterval(() => app.invalidate(), 500); // ages + the block pulse fade
    draw();
  });
}

/** One-shot plain frame (no TTY needed) — used by `hartii ui --demo | cat` and the tests. */
export function plainFrame(o = {}, cols = 80, rows = 24) {
  const source = createDataSource({ ...o, demo: true });
  const app = new TuiApp({ data: source.initial, size: { cols, rows }, deps: source.deps, demo: true });
  return renderFrame({ ...app.data, now: app.now() }, cols, rows).toPlain();
}
