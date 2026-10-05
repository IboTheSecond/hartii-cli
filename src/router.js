// packages/hartii-cli/src/router.js
//
// Everything that happens to a parsed command line BEFORE a command runs: help in every spelling
// (`hartii ?`, `help [cmd]`, `<cmd> ?`, `<cmd> --help`, `commands`, `completion`), shortcut expansion,
// `--version`, and the decision to open the full-screen UI. Pure: it never touches the filesystem or network.
//
// route() returns one of:
//   { done: { code, out?, err?, json? } }   print `out` (stdout) / `err` (stderr) / `json` and exit with `code`
//   { ui: true }                            open the TUI
//   { command, commandArgs }                run this command (shortcuts already expanded)
import { fullHelp, commandHelp, commandList, completionScript, suggest, expandAlias, HELP_WORDS } from './help.js';
import { safeTerminalText } from './output.js';
import { PKG_VERSION } from './version.js';

const out = (text) => ({ done: { code: 0, out: text } });
const fail = (text) => ({ done: { code: 1, err: text } });

const commandsText = (list) => list.map((c) => `${c.name.padEnd(12)}${c.summary}${c.aliases.length ? `   [${c.aliases.join(', ')}]` : ''}`).join('\n');

/**
 * @param {{ command: string|null, commandArgs: string[], globals: object, extraFlags: object }} parsed (extraFlags may gain shortcut flags)
 * @param {{ colors: object, interactive: boolean }} env
 */
export function route({ command, commandArgs, globals, extraFlags }, { colors, interactive }) {
  const wantsHelp = (args) => globals.help || args[0] === '?';
  const error = (msg) => fail(`${colors.red('Error: ')}${msg}\n`);

  // `hartii <cmd> ?` / `hartii <cmd> --help` for any command or shortcut (not for a bare `?`).
  if (command && command !== '?' && !globals.version && wantsHelp(commandArgs)) {
    const text = commandHelp(command);
    if (text) return out(text);
  }

  if (command) {
    const expanded = expandAlias(command, commandArgs);
    ({ command, commandArgs } = expanded);
    Object.assign(extraFlags, expanded.flags);
  }

  if (globals.version) return out(PKG_VERSION);

  if (!globals.help && ((command === 'ui' && commandArgs[0] !== '?') || (!command && interactive && !globals.json))) return { ui: true };

  // hartii ? | hartii help [cmd] | hartii h ...
  if (command && HELP_WORDS.has(command)) {
    const target = commandArgs[0] === '?' ? 'help' : commandArgs[0];
    const text = target ? commandHelp(target) : (globals.help && command === 'help' ? commandHelp('help') : fullHelp());
    if (text) return out(text);
    const near = suggest(target);
    return error(`No command "${safeTerminalText(target)}".${near.length ? ` Did you mean: ${near.join(', ')}?` : ''}`);
  }

  if (command === 'commands' && !wantsHelp(commandArgs)) {
    return globals.json ? { done: { code: 0, json: { commands: commandList() } } } : out(commandsText(commandList()));
  }
  if (command === 'completion' && !wantsHelp(commandArgs)) {
    const script = completionScript(commandArgs[0]);
    return script ? out(script.replace(/\n$/, '')) : error('Usage: hartii completion <bash|zsh|powershell|fish>');
  }

  if (command && wantsHelp(commandArgs)) {
    const text = commandHelp(command);
    if (text) return out(text);
  }
  if (!command || globals.help) return out(fullHelp());

  return { command, commandArgs };
}
