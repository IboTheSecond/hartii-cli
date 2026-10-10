// packages/hartii-cli/src/args.js
//
// Minimal, zero-dependency argv parser. No commander/yargs/minimist — this CLI's hard dependency
// rule allows only quais/@modelcontextprotocol/sdk/zod (see AGENTS.md "Hartii CLI" + the work
// order's HARD RULES), so the global-flag + subcommand parser is hand-rolled, once, here.
//
// Supported shapes for any flag: `--foo bar`, `--foo=bar`, `--foo` (boolean, true if no value
// follows or the next token is itself a flag), `-y` (short alias, only for the globals that
// define one). Positionals are every non-flag token, in order; everything before the first
// positional that isn't a known global is still just collected as the command path.

// Every global flag, plus their value/boolean shape and short
// aliases. Subcommand-specific flags (--slippage, --tokens, --csv, ...) are parsed the same way by
// each command, from `rest`, below.
export const GLOBAL_FLAG_SPECS = {
  json: { type: 'boolean' },
  network: { type: 'string' },
  rpc: { type: 'string' },
  wallet: { type: 'string' },
  yes: { type: 'boolean', alias: 'y' },
  'dry-run': { type: 'boolean' },
  demo: { type: 'boolean' },
  help: { type: 'boolean', alias: 'h' },
  version: { type: 'boolean' },
  'key-env': { type: 'string' }, // raw-key-from-env escape hatch for CI, loud warning at use site
};

// Command-specific flags that never take a value (so they cannot swallow a following positional).
const EXTRA_BOOLEAN_FLAGS = ['from-arg', 'trust-live-addresses', 'allow-writes', 'mine', 'check', 'qr', 'tokens', 'stdin', 'allow-insecure-rpc', 'once', 'observe', 'pair', 'create-wallet'];

function isFlagToken(tok) {
  return typeof tok === 'string' && tok.length > 1 && tok[0] === '-';
}

function stripDashes(tok) {
  if (tok.startsWith('--')) return tok.slice(2);
  return tok.slice(1);
}

function resolveAliases(specs) {
  const byAlias = {};
  for (const [name, spec] of Object.entries(specs)) {
    if (spec.alias) byAlias[spec.alias] = name;
  }
  return byAlias;
}

/**
 * Parses `argv` (already stripped of `node`/script path — i.e. `process.argv.slice(2)`) into a
 * flat `{ flags, positionals }` using `specs` to know which flags are boolean vs value-taking.
 * Flags not present in `specs` are still accepted (value-taking if followed by a non-flag token,
 * boolean otherwise) so command-specific flags pass straight through when this is used to parse
 * the remainder after the known globals are pulled out.
 * @param {string[]} argv
 * @param {Record<string, {type:'boolean'|'string', alias?:string}>} specs
 */
export function parseFlags(argv, specs = {}) {
  const byAlias = resolveAliases(specs);
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i];
    if (!isFlagToken(tok)) {
      positionals.push(tok);
      continue;
    }
    let name = stripDashes(tok);
    let inlineValue;
    const eq = name.indexOf('=');
    if (eq !== -1) {
      inlineValue = name.slice(eq + 1);
      name = name.slice(0, eq);
    }
    if (byAlias[name]) name = byAlias[name];

    const spec = specs[name];
    const wantsValue = spec ? spec.type === 'string' : inlineValue === undefined && i + 1 < argv.length && !isFlagToken(argv[i + 1]);

    if (inlineValue !== undefined) {
      flags[name] = inlineValue;
    } else if (wantsValue) {
      flags[name] = argv[i + 1];
      i += 1;
    } else {
      flags[name] = true;
    }
  }
  return { flags, positionals };
}

/**
 * Top-level parse: pulls every global flag (anywhere in argv, not just before the command — a
 * user typing `hartii send 0xabc 1 --yes` or `hartii --yes send 0xabc 1` gets the same result)
 * out first, then returns the remaining positionals as `[command, ...subcommandPositionals]` plus
 * whatever non-global flags were present, for the command handler to parse with its own spec.
 * @param {string[]} argv
 */
export function parseArgv(argv) {
  const { flags: allFlags, positionals } = parseFlags(argv, { ...GLOBAL_FLAG_SPECS, ...Object.fromEntries(EXTRA_BOOLEAN_FLAGS.map((f) => [f, { type: 'boolean' }])) });
  const globals = {};
  const extraFlags = {};
  for (const [k, v] of Object.entries(allFlags)) {
    if (Object.prototype.hasOwnProperty.call(GLOBAL_FLAG_SPECS, k)) globals[k] = v;
    else extraFlags[k] = v;
  }
  const [command, ...commandArgs] = positionals;
  return {
    command: command || null,
    commandArgs,
    globals: {
      json: globals.json === true,
      network: typeof globals.network === 'string' ? globals.network : null,
      rpc: typeof globals.rpc === 'string' ? globals.rpc : null,
      wallet: typeof globals.wallet === 'string' ? globals.wallet : null,
      yes: globals.yes === true,
      dryRun: globals['dry-run'] === true,
      demo: globals.demo === true,
      help: globals.help === true,
      version: globals.version === true,
      keyEnv: typeof globals['key-env'] === 'string' ? globals['key-env'] : null,
    },
    extraFlags,
  };
}
