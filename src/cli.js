// packages/hartii-cli/src/cli.js
//
// The single entry every caller (bin/hartii.js, the test suite) goes through:
//   parse argv -> route help/shortcuts/UI (router.js) -> look the command up (commandTable.js) -> print.
// Prints exactly one of: --json output, human-coloured output, or an error — never a mix, and never a
// raw stack trace for an expected (CliError) failure.
import { parseArgv } from './args.js';
import { formatHumanResult } from './humanOutput.js';
import { makeColors, printJson, safeTerminalText, redactUrls, uiOptions, withProgress } from './output.js';
import { getHartiiHome, loadConfig } from './config.js';
import { route } from './router.js';
import { COMMAND_TABLE, RAW_COMMANDS } from './commandTable.js';
import { suggest } from './help.js';
import { CliError } from './errors.js';
import { WalletError } from './keystore.js';
import { runTui } from './tui/run.js';

// Commands that can ask for a password, a confirmation or typed input: a spinner on stderr would draw over the prompt.
const PROMPTING_COMMANDS = new Set(['send', 'buy', 'sell', 'swap', 'airdrop', 'otc', 'claim', 'wall', 'wallet', 'init', 'desk', 'update', 'contacts', 'vault', 'trader', 'qi', 'config']);

function printError(err, { json, writeErr, colors }) {
  const message = redactUrls(err?.message || String(err));
  if (json) writeErr(JSON.stringify({ ok: false, error: message }, null, 2) + '\n');
  else writeErr(colors.red('Error: ') + safeTerminalText(message) + '\n');
}

/** --max-fee <quai> -> wei (human CLI only; the MCP server never gets one). */
function parseMaxFee(v) {
  if (typeof v !== 'string' || !/^\d+(\.\d{1,18})?$/.test(v) || Number(v) <= 0) throw new WalletError('--max-fee must be a positive QUAI amount like 2 or 0.5.');
  const [whole, frac = ''] = v.split('.');
  return BigInt(whole) * 10n ** 18n + BigInt(frac.padEnd(18, '0'));
}

/**
 * @param {string[]} argv already stripped of node/script path
 * @param {{ write?: (s:string)=>void, writeErr?: (s:string)=>void, env?: NodeJS.ProcessEnv, fetchFn?: typeof fetch, providerFactory?: Function, passwordDeps?: object, confirmTypedFn?: Function, io?: object, now?: Date }} [deps]
 * @returns {Promise<number>} process exit code
 */
export async function main(argv, deps = {}) {
  const write = deps.write || ((s) => process.stdout.write(s + '\n'));
  const writeErr = deps.writeErr || ((s) => process.stderr.write(s + '\n'));
  const env = deps.env || process.env;
  const colors = makeColors({ env });

  let parsed;
  try {
    parsed = parseArgv(argv);
  } catch (err) {
    if (!(err instanceof CliError) && deps.rethrowUnknown) throw err;
    printError(err, { json: argv.includes('--json'), writeErr, colors });
    return 1;
  }
  const { globals, extraFlags: flags, command: rawCommand, commandArgs: rawArgs } = parsed;
  const interactive = deps.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const routed = route({ command: rawCommand, commandArgs: rawArgs, globals, extraFlags: flags }, { colors, interactive });

  if (routed.done) {
    const { code, out, err, json } = routed.done;
    if (json) printJson(json, { write });
    else if (out !== undefined) write(out);
    else writeErr(err);
    return code;
  }
  if (routed.ui) {
    const ui = deps.runUi || runTui;
    return ui({ env, demo: globals.demo, home: globals.demo ? undefined : getHartiiHome(env), network: globals.network, rpc: globals.rpc, wallet: globals.wallet, fetchFn: deps.fetchFn, providerFactory: deps.providerFactory, walletFactory: deps.walletFactory, WebSocketImpl: deps.WebSocketImpl, stdin: deps.stdin, stdout: deps.stdout });
  }

  const { command, commandArgs: args } = routed;
  const io = {
    env, writeErr, write, colors, passwordDeps: { allowPipedSecret: flags.stdin === true, ...deps.passwordDeps }, allowPipedSecret: flags.stdin === true, confirmTypedFn: deps.confirmTypedFn, promptFn: deps.promptFn,
    confirmFn: deps.confirmFn, stdin: deps.stdin, stdout: deps.stdout, now: deps.now,
  };
  // Presentation: --terse / config ui.terse, --details, terminal width (60/80/120 all work). A config that cannot be read
  // must not stop a command here; the command itself reports it.
  let uiCfg = {};
  if (!globals.demo) { try { uiCfg = loadConfig(getHartiiHome(env)); } catch { uiCfg = {}; } }
  const ui = uiOptions({ flags, cfg: uiCfg, stdout: deps.stdout || process.stdout });
  io.details = ui.details; io.terse = ui.terse; io.width = ui.width;

  try {
    if (flags['max-fee'] !== undefined) io.maxFeeWei = parseMaxFee(flags['max-fee']);
    const handler = COMMAND_TABLE[command];
    if (!handler) {
      const near = suggest(command);
      const label=/^[a-z][a-z0-9_-]{0,31}$/i.test(command)?` "${safeTerminalText(command)}"`:'';
      throw new Error(`Unknown command${label}.${near.length ? ` Did you mean: ${near.join(', ')}?` : ''} Run \`hartii ?\` for every command.`);
    }
    const run = () => handler({ args, flags, g: globals, deps, env, io, write, home: globals.demo ? null : getHartiiHome(env) });
    // A progress line on stderr only for read commands on a TTY (never while a command may prompt, never with --json).
    const quietCommand = RAW_COMMANDS.has(command) || PROMPTING_COMMANDS.has(command);
    const result = quietCommand ? await run() : await withProgress('Working…', run, { json: globals.json });
    if (RAW_COMMANDS.has(command)) return result; // the handler already owns stdout and returns the exit code
    if (globals.json) printJson(result, { write });
    else write(formatHumanResult(result, { colors, width: ui.width, terse: ui.terse }));
    return result && result.ok === false ? 1 : 0;
  } catch (err) {
    if (err instanceof CliError || !deps.rethrowUnknown) {
      printError(err, { json: globals.json, writeErr, colors });
      return 1;
    }
    throw err;
  }
}
