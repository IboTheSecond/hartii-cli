// packages/hartii-cli/src/help.js
//
// The one command registry: drives `hartii help`, `hartii ?`, `hartii <cmd> ?`, the "did you mean" hint,
// shell completion and the alias table, so they can never drift apart. Pure data + tiny helpers, no I/O.

export const GROUPS = [
  ['start', 'Start here'],
  ['wallet', 'Wallet'],
  ['read', 'Look things up (read-only)'],
  ['trade', 'Trade (mainnet) — every write is simulated, capped and confirmed'],
  ['tools', 'Hartii tools (mainnet)'],
  ['system', 'Setup, safety and system'],
  ['agents', 'Agents'],
];

// name, group, one-line summary, usage lines, examples, aliases (alias tokens that expand to this command),
// to (optional: a shortcut for another command — { command, args: prefix, flags, dropArgs: ignore the user's own args })
export const COMMANDS = [
  { name: 'trader', group: 'agents', summary: 'BETA holder trader: keyless Observe/Paper, locally gated Live', usage: [
    'hartii trader init --owner <address> --trading-address <address> --capital <QUAI> --max-per-tx <QUAI> --max-per-day <QUAI> --max-fee <QUAI>',
    'hartii trader init --pair   # hidden pairing code; confirm fingerprint in dashboard',
    'hartii trader paper [--once] [--demo]', 'hartii trader run --observe [--once]',
    'hartii trader arm [--wallet <dedicated-name>]   # propose, sign in browser, repeat for local typed ARM',
    'hartii trader arm --policy-file <reviewed-owner-signed.json>   # local typed ARM, max 24 hours',
    'hartii trader run [--wallet <dedicated-name>] [--once]',
    'hartii trader reconcile [--funding-tx <hash>]   # verified direct native transfer, 20 confirmations',
    'hartii trader watch|status|pause [--profile <name>] [--json]',
    'hartii trader export [--mode all|observe|paper|live] [--out <history.jsonl>] # stop writers first',
    'hartii trader init ... --provider openai|anthropic --model <name> --pricing-file <file> [--model-key-env <NAME>]',
  ], examples: ['hartii trader paper --demo --once --json', 'hartii trader watch --once', 'hartii trader export --mode all --out trader-history.jsonl'] },
  { name: 'ui', group: 'start', summary: 'full-screen terminal UI (also: just run `hartii`)', usage: ['hartii ui [--demo]'], examples: ['hartii ui --demo   # fixture data, never signs', 'hartii'] },
  { name: 'init', group: 'start', summary: 'guided first-run checklist (wallet, network, next steps)', usage: ['hartii init'], examples: ['hartii init'] },
  { name: 'help', group: 'start', summary: 'this help; `hartii help <command>` for one command', usage: ['hartii help [command]', 'hartii ?', 'hartii <command> ?'], examples: ['hartii help buy', 'hartii buy ?'] },
  { name: 'commands', group: 'start', summary: 'flat list of every command (script-friendly with --json)', usage: ['hartii commands [--json]'], examples: ['hartii commands --json'] },

  { name: 'wallet', group: 'wallet', summary: 'create / import / list / use / export wallets (encrypted keystore)', usage: ['hartii wallet new [name]', 'hartii wallet import mnemonic|key [name] [--stdin]', 'hartii wallet list', 'hartii wallet use <name>', 'hartii wallet address [--qr]', 'hartii wallet export [name]', 'hartii wallet rename <old> <new>', 'hartii wallet remove <name>', 'hartii wallet lock-check [name]'], examples: ['hartii wallet new main', 'hartii wallet use main'] },
  { name: 'whoami', group: 'wallet', summary: 'your current wallet, address and network', usage: ['hartii whoami'], examples: ['hartii whoami'], aliases: ['me'] },
  { name: 'address', group: 'wallet', summary: 'print your receive address (also: `addr`)', usage: ['hartii address'], examples: ['hartii address'], aliases: ['addr'], to: { command: 'wallet', args: ['address'] } },
  { name: 'receive', group: 'wallet', summary: 'offline receive QR and HPAY payment link', usage: ['hartii receive [--amount <QUAI>] [--memo <text>] [--out <qr.svg>]', 'hartii receive --address-qr'], examples: ['hartii receive', 'hartii receive --amount 2.5 --memo Coffee --out payment.svg'] },
  { name: 'wallets', group: 'wallet', summary: 'list your wallets (same as `wallet list`)', usage: ['hartii wallets'], examples: ['hartii wallets'], aliases: ['ls'], to: { command: 'wallet', args: ['list'], dropArgs: true } },
  { name: 'use', group: 'wallet', summary: 'switch wallet (same as `wallet use <name>`)', usage: ['hartii use <name>'], examples: ['hartii use trading'], to: { command: 'wallet', args: ['use'] } },
  { name: 'balance', group: 'wallet', summary: 'QUAI balance; --tokens adds holdings with QUAI values', usage: ['hartii balance [--tokens] [--address <addr>]'], examples: ['hartii balance --tokens', 'hartii bal --address 0x00…'], aliases: ['bal'] },
  { name: 'portfolio', group: 'wallet', summary: 'balance + token holdings (same as `balance --tokens`)', usage: ['hartii portfolio [--address <addr>]'], examples: ['hartii portfolio'], aliases: ['pf', 'holdings'], to: { command: 'balance', flags: { tokens: true } } },
  { name: 'send', group: 'wallet', summary: 'send QUAI or a token to an address', usage: ['hartii send <to> <amount> [--token <addr|ticker>] [--max-fee <quai>]'], examples: ['hartii send 0x00… 12.5 --dry-run', 'hartii send 0x00… 50% --token DEMO'] },

  { name: 'tokens', group: 'read', summary: 'launchpad directory: trending, new, search', usage: ['hartii tokens [trending|new|search <q>] [--limit n]'], examples: ['hartii tokens trending', 'hartii tokens search camel'] },
  { name: 'trending', group: 'read', summary: 'trending tokens (same as `tokens trending`)', usage: ['hartii trending [--limit n]'], examples: ['hartii trending'], aliases: ['top', 'markets'], to: { command: 'tokens', args: ['trending'], dropArgs: true } },
  { name: 'new', group: 'read', summary: 'newest launches (same as `tokens new`)', usage: ['hartii new [--limit n]'], examples: ['hartii new'], aliases: ['launches'], to: { command: 'tokens', args: ['new'], dropArgs: true } },
  { name: 'search', group: 'read', summary: 'find a token by name / ticker (same as `tokens search`)', usage: ['hartii search <query>'], examples: ['hartii search qaxe'], to: { command: 'tokens', args: ['search'] } },
  { name: 'token', group: 'read', summary: 'one token: price, curve state, graduation, holders, links', usage: ['hartii token <addr|ticker>'], examples: ['hartii token QAXE'], aliases: ['info'] },
  { name: 'price', group: 'read', summary: 'quick price + 24h change for a token', usage: ['hartii price <addr|ticker>'], examples: ['hartii price QAXE'] },
  { name: 'quote', group: 'read', summary: 'exact on-chain curve quote for a buy or sell (no wallet needed)', usage: ['hartii quote <buy|sell> <token> <amount> [--slippage 3]'], examples: ['hartii quote buy DEMO 5', 'hartii quote sell DEMO 1000'] },
  { name: 'holders', group: 'read', summary: 'top holders of a token', usage: ['hartii holders <token> [--limit 20]'], examples: ['hartii holders QAXE'] },
  { name: 'trades', group: 'read', summary: 'recent trades of a token', usage: ['hartii trades <token> [--limit 20]'], examples: ['hartii trades QAXE'] },
  { name: 'watch', group: 'read', summary: 'live trade feed (NDJSON with --json)', usage: ['hartii watch <token|all>'], examples: ['hartii watch all', 'hartii watch DEMO --json'] },
  { name: 'tx', group: 'read', summary: 'transaction status and local pending reservations', usage: ['hartii tx <hash>', 'hartii tx pending'], examples: ['hartii tx pending', 'hartii tx 0x…'] },
  { name: 'block', group: 'read', summary: 'current block height', usage: ['hartii block'], examples: ['hartii block'], aliases: ['height'] },
  { name: 'gas', group: 'read', summary: 'live gas price and what a transfer costs', usage: ['hartii gas'], examples: ['hartii gas'] },
  { name: 'open', group: 'read', summary: 'quaiscan link for a tx hash or address (--browser opens it)', usage: ['hartii open <hash|address> [--browser]'], examples: ['hartii open 0x…'], aliases: ['explorer'] },

  { name: 'buy', group: 'trade', summary: 'buy a token with QUAI on its bonding curve', usage: ['hartii buy <token> <quai> [--slippage 3] [--max-fee <quai>]'], examples: ['hartii buy DEMO 5 --dry-run', 'hartii buy DEMO 25%'] },
  { name: 'sell', group: 'trade', summary: 'sell a token for QUAI (approves the exact amount first)', usage: ['hartii sell <token> <amount|all|50%> [--slippage 3]'], examples: ['hartii sell DEMO 50%', 'hartii sell DEMO all --dry-run'] },
  { name: 'swap', group: 'trade', summary: 'swap on HartiiSwap (QUAI / WQUAI / tokens)', usage: ['hartii swap <in> <out> <amount> [--slippage 3]'], examples: ['hartii swap QUAI DEMO 2', 'hartii swap DEMO WQUAI 100%'] },

  { name: 'airdrop', group: 'tools', summary: 'batch-send QUAI or a token from a CSV (<=500 per tx)', usage: ['hartii airdrop --csv <file> [--token <addr|ticker>] [--amount <n>]'], examples: ['hartii airdrop --csv list.csv --dry-run'] },
  { name: 'otc', group: 'tools', summary: 'OTC Link offers: create, fill, cancel, list', usage: ['hartii otc create <token> <amount> <quai> [--taker <addr>] [--expiry 7d]', 'hartii otc fill <id>', 'hartii otc cancel <id>', 'hartii otc list [--mine] [--status open|all]'], examples: ['hartii otc list', 'hartii otc create DEMO 100000 25 --expiry 3d'] },
  { name: 'claim', group: 'tools', summary: 'Claim campaigns: list, check, claim your allocation', usage: ['hartii claim list [--mine|--creator <addr>]', 'hartii claim <campaignId> [--check]'], examples: ['hartii claim 123 --check', 'hartii claim 123'] },
  { name: 'wall', group: 'tools', summary: 'Wall of Blocks: engrave a message, see stats', usage: ['hartii wall engrave "<message>" [--color #hex] [--token <addr|ticker>]', 'hartii wall stats', 'hartii wall recent [n]'], examples: ['hartii wall engrave "gm quai"', 'hartii wall recent 10'] },

  { name: 'doctor', group: 'system', summary: 'health check: RPC, chain id, keystore perms, API, clock', usage: ['hartii doctor'], examples: ['hartii doctor'] },
  { name: 'limits', group: 'system', summary: 'your spending caps and what you have spent today', usage: ['hartii limits'], examples: ['hartii limits', 'hartii config set limits.perTxQuai 25'] },
  { name: 'config', group: 'system', summary: 'read / change settings (network, wallet, spending caps)', usage: ['hartii config get <key>', 'hartii config set <key> <value>   keys: network, currentWallet, limits.perTxQuai, limits.dailyQuai'], examples: ['hartii config set network orchard'] },
  { name: 'networks', group: 'system', summary: 'the networks this CLI can talk to and which is active', usage: ['hartii networks'], examples: ['hartii networks'] },
  { name: 'update', group: 'system', summary: 'check for a newer CLI and install it (sha256-verified)', usage: ['hartii update [--check] [--yes]   --check only reports; --yes skips the prompt (needed with --json or off a terminal)'], examples: ['hartii update --check', 'hartii update', 'hartii update --yes'], aliases: ['upgrade'] },
  { name: 'completion', group: 'system', summary: 'print a shell completion script (bash, zsh, powershell, fish)', usage: ['hartii completion <bash|zsh|powershell|fish>'], examples: ['hartii completion bash >> ~/.bashrc', 'hartii completion powershell | Out-String | Invoke-Expression'] },
  { name: 'about', group: 'system', summary: 'version, links and where your data lives', usage: ['hartii about'], examples: ['hartii about'], aliases: ['links'] },
  { name: 'version', group: 'system', summary: 'print the version (also --version)', usage: ['hartii version'], examples: ['hartii version'], aliases: ['ver'] },

  { name: 'mcp', group: 'agents', summary: 'stdio MCP server for AI agents (Claude Code, Cursor)', usage: ['hartii mcp', 'hartii mcp --allow-writes --max-per-tx <quai> --max-per-day <quai>   (writes REQUIRE both caps)'], examples: ['claude mcp add hartii -- hartii mcp'] },
];

const byName = new Map(COMMANDS.map((c) => [c.name, c]));

/** alias token -> canonical command name */
export const ALIASES = new Map(COMMANDS.flatMap((c) => (c.aliases || []).map((a) => [a, c.name])));

export const HELP_WORDS = new Set(['?', 'help', 'h', '-?', '/?']);
export const commandNames = () => COMMANDS.map((c) => c.name);

/**
 * Resolves a shortcut token (`bal`, `pf`, `ls`, `top`, `me`, ...) to the command that really runs, following the
 * registry: alias -> canonical entry -> its `to` shortcut, if any. Real commands come back unchanged.
 * @returns {{ command: string, commandArgs: string[], flags: object }}
 */
export function expandAlias(command, commandArgs) {
  const name = ALIASES.get(command) || command;
  const to = byName.get(name)?.to;
  if (!to) return { command: name, commandArgs, flags: {} };
  return { command: to.command, commandArgs: [...(to.args || []), ...(to.dropArgs ? [] : commandArgs)], flags: to.flags || {} };
}

export function lookup(name) {
  return byName.get(ALIASES.get(name) || name) || null;
}

function levenshtein(a, b) {
  const m = a.length; const n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j += 1) d[0][j] = j;
  for (let i = 1; i <= m; i += 1) for (let j = 1; j <= n; j += 1) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}

/** Up to 3 closest command names / aliases for a mistyped command. */
export function suggest(input) {
  const word = String(input || '').toLowerCase();
  if (!word) return [];
  const pool = [...byName.keys(), ...ALIASES.keys()];
  return pool
    .map((n) => ({ n, s: n.startsWith(word) || word.startsWith(n) ? 0 : levenshtein(word, n) }))
    .filter((x) => x.s <= Math.max(2, Math.floor(word.length / 3)))
    .sort((a, b) => a.s - b.s || a.n.localeCompare(b.n))
    .map((x) => ALIASES.get(x.n) || x.n)
    .filter((n, i, arr) => arr.indexOf(n) === i)
    .slice(0, 3);
}

export function fullHelp() {
  const out = [
    'hartii — Hartii terminal wallet + trading terminal for Quai Network (BETA, not audited)',
    '',
    'Just type `hartii` for the full-screen UI. Ask for help anywhere:  hartii ?   hartii help <command>   hartii <command> ?',
    'Usage: hartii <command> [args] [--json] [--network mainnet|orchard] [--rpc <url>] [--wallet <name>] [--yes] [--dry-run] [--demo]',
    '',
  ];
  for (const [key, title] of GROUPS) {
    out.push(`${title}:`);
    const rows = COMMANDS.filter((c) => c.group === key);
    const w = Math.max(...rows.map((c) => c.name.length)) + 2;
    for (const c of rows) out.push(`  ${c.name.padEnd(w)}${c.summary}`);
    out.push('');
  }
  out.push('Shortcuts: bal · pf · ls · top · me · addr · gas · block — see `hartii commands` for all aliases.');
  out.push('First time?  hartii init     Look around without a wallet:  hartii ui --demo');
  out.push('BETA: the Hartii terminal wallet is beta software and has not been independently audited. Start small.');
  out.push('Safety: every write is simulated, fee-capped and spending-guarded (100 QUAI/tx, 500/day by default), then');
  out.push('confirmed with y/N and only reported as done on receipt status 1. Keys live only in the encrypted keystore.');
  return out.join('\n');
}

export function commandHelp(name) {
  const c = lookup(name);
  if (!c) return null;
  const out = [`hartii ${c.name} — ${c.summary}`, '', 'Usage:', ...c.usage.map((u) => `  ${u}`)];
  if (c.aliases?.length) out.push('', `Aliases: ${c.aliases.join(', ')}`);
  if (c.examples?.length) out.push('', 'Examples:', ...c.examples.map((e) => `  ${e}`));
  out.push('', 'Global flags: --json  --network mainnet|orchard  --rpc <url>  --wallet <name>  --yes  --dry-run  --demo', 'Hartii CLI is BETA software and has not been audited: start with small amounts.');
  return out.join('\n');
}

export function commandList() {
  return COMMANDS.map((c) => ({ name: c.name, group: c.group, summary: c.summary, aliases: c.aliases || [] }));
}

// ---- shell completion ----
export function completionScript(shell) {
  const names = [...commandNames(), ...ALIASES.keys()].filter((n) => n !== 'help').concat(['help']).sort().join(' ');
  const flags = '--json --network --rpc --wallet --yes --dry-run --demo --help --version --key-env';
  switch (shell) {
    case 'bash':
      return `# hartii bash completion — add to ~/.bashrc:  eval "$(hartii completion bash)"\n_hartii() { local cur="\${COMP_WORDS[COMP_CWORD]}"; if [ "$COMP_CWORD" -eq 1 ]; then COMPREPLY=( $(compgen -W "${names}" -- "$cur") ); else COMPREPLY=( $(compgen -W "${flags}" -- "$cur") ); fi; }\ncomplete -F _hartii hartii\n`;
    case 'zsh':
      return `# hartii zsh completion — add to ~/.zshrc:  eval "$(hartii completion zsh)"\n_hartii() { if (( CURRENT == 2 )); then compadd ${names}; else compadd -- ${flags}; fi }\ncompdef _hartii hartii\n`;
    case 'fish':
      return `# hartii fish completion — save as ~/.config/fish/completions/hartii.fish\ncomplete -c hartii -f -n '__fish_use_subcommand' -a '${names}'\ncomplete -c hartii -f -l json -l demo -l yes -l dry-run -l help -l version\n`;
    case 'powershell':
    case 'pwsh':
      return `# hartii PowerShell completion — add to $PROFILE:  hartii completion powershell | Out-String | Invoke-Expression\nRegister-ArgumentCompleter -Native -CommandName hartii -ScriptBlock { param($wordToComplete, $commandAst, $cursorPosition)\n  $words = '${names}'.Split(' '); $flags = '${flags}'.Split(' ')\n  $pool = if ($commandAst.CommandElements.Count -le 2) { $words } else { $flags }\n  $pool | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_) } }\n`;
    default:
      return null;
  }
}
