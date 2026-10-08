# Hartii CLI (`hartii`) — BETA

> **BETA.** The Hartii terminal wallet is beta software and has not been independently audited. Start with small amounts, use `--dry-run`, and keep your recovery phrase backed up.

A Hartii-branded terminal wallet and trading terminal for **Quai Network** (Cyprus-1, mainnet chain 9; Orchard
testnet for the wallet basics). Three ways to use it, one engine underneath:

1. **Interactive TUI** — run `hartii` in a terminal. Full-screen, arrow-key driven.
2. **Scriptable commands** — every command has a stable `--json` output for pipelines.
3. **MCP server** — `hartii mcp` lets AI coding agents (Claude Code, Cursor) read balances and markets and,
   only when you explicitly allow it, act.

It is wired to Hartii's own products: HartiiLabs bonding curves, HartiiSwap, Airdrop, OTC Link, Claim and the
Wall of Blocks, plus the live trade feed. Runtime dependencies are only `quais`, `@modelcontextprotocol/sdk`
and `zod`. A pinned, MIT-licensed QR encoder is included locally; QR creation never contacts a hosted service.
The CLI has no application analytics. RPC/API/WebSocket providers and any agent client can observe or retain request metadata and public addresses; transactions are permanent on chain.

> Status: beta (0.2.3). Verification uses isolated synthetic wallets and mocked RPC; run it against
> Orchard or with small amounts before trusting it with real money.

## Install

```bash
# Node 20+. Install once, then just type `hartii`.
npm install -g https://hartiilabs.com/downloads/hartii-cli.tgz
hartii --version
hartii ?          # every command
```

Update with `hartii update` (alias `upgrade`):

```
hartii update --check       # only report: "Update available: 0.2.2 → 0.2.3" or "You're on the latest version"
hartii update               # ask, download, verify, install
hartii update --yes         # no prompt (required when not on a terminal or with --json)
```

It reads `https://hartiilabs.com/downloads/hartii-cli.json` (`{version, sha256, url}`; falls back to the `.sha256` file), downloads the tarball over same-origin HTTPS with no redirects, refuses unless its sha256 equals the published one, then runs `npm install -g <the verified local file>` and confirms with `hartii --version`. If npm fails it prints the exact manual command (`npm install -g https://hartiilabs.com/downloads/hartii-cli.tgz`; on macOS/Linux with EACCES use `sudo` or an npm prefix in your home). The MCP server never updates anything. Versions up to 0.2.2 only print a hint: run the manual command above once to reach 0.2.3. One-off without installing: `npx -y https://hartiilabs.com/downloads/hartii-cli.tgz --help`.

The download's checksum is published next to it: `https://hartiilabs.com/downloads/hartii-cli.tgz.sha256`.

## Quickstart

```bash
hartii ui --demo               # look around with fixture data — no wallet, no network, never signs
hartii wallet new              # creates an encrypted keystore (password prompt) and selects it
hartii wallet address          # your Cyprus-1 Quai address
hartii doctor                  # RPC, chain id, keystore perms, address ledger, API, clock skew
hartii balance --tokens        # QUAI + HartiiLabs-indexed holdings
hartii tokens trending
hartii buy DEMO 5 --dry-run    # simulate and show the exact summary, sign nothing
hartii buy DEMO 5              # same summary, then y/N, then send
```

Global flags work anywhere on the line: `--json`, `--network mainnet|orchard`, `--rpc <url>`,
`--wallet <name>`, `--yes` / `-y`, `--dry-run`, `--demo`, `--key-env <VAR>`, `--help`, `--version`.
Default network is mainnet (`https://rpc.quai.network/cyprus1`, chain 9); Orchard is
`https://orchard.rpc.quai.network/cyprus1`, chain 15000. The chain id is verified before every write.

## Receive and send QUAI

```bash
hartii receive                              # address + HPAY link + terminal QR; never unlocks
hartii receive --amount 2.5 --memo Coffee     # exact mainnet QUAI request
hartii receive --out payment.svg             # share or scan a locally generated SVG
hartii receive --address-qr                  # raw public-address QR for a wallet scanner
hartii wallet address --qr                   # the selected address as QR
hartii send 0xYOUR_CYPRUS1_QUAI_ADDRESS 2.5 --dry-run
hartii send "https://hartiibiome.com/hpay?to=...&amt=...&chain=9&v=1" --dry-run
hartii tx pending                           # inspect local reservations; no signing
```

HPAY requests encode native QUAI in exact integer wei and target mainnet chain 9. They contain no private key or recovery phrase. Address QR codes do not identify a network: the payer must select the displayed network. On Orchard, use an explicit `--address-qr`; a mainnet HPAY request is refused. A large memo may need a wider terminal; SVG export preserves the complete QR.

The CLI accepts fixed-address HPAY links only from the approved HTTPS Hartii origins, with explicit chain/version, unambiguous fields, positive exact amounts and valid expiry. A conflicting supplied amount or token transfer is refused. `@name` links should be resolved in HPAY or regenerated as address links. Expiry is checked again before submission. Normal address sending uses the same simulation, confirmation, identity and spending checks. The TUI Actions menu includes Receive and Send.

No transaction is sent by receiving, `--demo` or `--dry-run`. Review the full recipient, amount, network and maximum fee before approving a real write.

## Commands

| Command | What it does |
| --- | --- |
| `hartii` / `hartii ui [--demo]` | Full-screen TUI. Piped (no TTY) it prints one plain 80×24 frame. |
| `wallet new [name]` · `import mnemonic [name]` · `import key [name]` | Create/import a wallet (first Cyprus-1 Quai address). The recovery phrase / key is read from a **hidden prompt or stdin**, never from argv; `--from-arg` is refused with a migration error: use the hidden prompt or stdin. Phrases and keys are **never printed** here. |
| `wallet list` · `use <name>` · `address [--qr]` · `rename <old> <new>` · `lock-check [name]` | Manage wallets. `address --qr` renders the public receive address as a real offline QR. |
| `wallet export [name]` · `wallet remove <name>` | The only place a mnemonic/key can appear (export) — behind a typed confirmation of the wallet name. |
| `balance [--tokens] [--address <addr>]` | QUAI balance; `--tokens` adds indexed holdings with QUAI values and price source. `--address` reads any Cyprus-1 Quai address. |
| `send <to> <amount> [--token <addr\|ticker>]` | QUAI or ERC-20 transfer. `amount` = decimal, `50%` or `all` (QUAI "all" reserves gas). |
| `tokens [trending\|new\|search <q>]` · `token <addr\|ticker>` | Launchpad directory; one token's price reference, live curve state, graduation progress, holders, links. |
| `buy <token> <quai> [--slippage 3]` | Bonding-curve buy with the on-chain quote and a slippage floor (a buy that finishes the curve uses the repo's finishing-buy rule). |
| `sell <token> <amount\|all\|50%> [--slippage 3]` | Curve sell; approves the exact amount first when needed. |
| `swap <in> <out> <amount> [--slippage 3]` | HartiiSwap router; `QUAI`/`WQUAI` wrap 1:1. |
| `tx <hash>` · `watch <token\|all>` | Transaction status; live trade frames (NDJSON with `--json`). |
| `airdrop --csv <file> [--token <addr\|ticker>] [--amount <n>]` | HartiiAirdrop batch send, ≤ 500 recipients per transaction, fee read live from the contract. |
| `otc create <token> <amount> <quai> [--taker <addr>] [--expiry 7d]` · `otc fill <id>` · `otc cancel <id>` · `otc list [--mine] [--status open\|all]` | HartiiOTCLink offers (token for QUAI). |
| `claim list [--mine\|--creator <addr>]` · `claim <campaignId> [--check]` | HartiiClaim: list a creator's campaigns; check or claim your allocation (Merkle leaves are re-verified against the on-chain root). |
| `wall engrave "<message>" [--color #hex] [--token <addr\|ticker>]` · `wall stats` · `wall recent [n]` | Wall of Blocks (Global Wall). Price read live. |
| `help` · `?` · `commands` · `completion <shell>` | Help for everything (`hartii ?`, `hartii buy ?`), a flat command list, shell completion. |
| `init` · `whoami` · `limits` · `networks` · `about` · `update` | First-run checklist, who you are, your spending caps and today's spend, networks, version/links, whether a newer CLI exists (`update`: `--check`, `--yes`). |
| `price` · `quote <buy\|sell>` · `holders` · `trades` · `gas` · `block` · `open` | Read-only lookups; no wallet needed. |
| shortcuts | `bal`, `pf`/`portfolio`, `ls`, `use`, `addr`, `top`, `new`, `search`, `me`. |
| `config get <key>` · `config set <key> <value>` | Keys: `network`, `currentWallet`, `limits.perTxQuai`, `limits.dailyQuai`. |
| `doctor` | Health checklist. |
| `mcp [--allow-writes --max-per-tx <q> --max-per-day <q>]` | stdio MCP server (see below). |

Airdrop / OTC / Claim / Wall and the market commands (tokens, token, buy, sell, swap, watch) are **mainnet only**;
the CLI refuses them on Orchard before touching the network.

### Every write goes through one pipeline

validate addresses (checksummed, Quai ledger only, Qi `0x0080…` rejected) → spending guard → **simulate**
(`quai_call` from the real sender) → Quai **access list** (`quai_createAccessList`) → gas = estimate × 1.2 at the
live gas price → print the **confirmation summary** (action, amounts, fee, gas cost, destination, network) →
`y/N` (skip with `--yes`) → send → **require receipt status 1** → print the quaiscan link. `--dry-run` stops after the
summary and never signs. Examples:

```bash
hartii send 0x00… 12.5 --dry-run
hartii sell DEMO 50% --slippage 2 --yes --json
hartii otc create DEMO 100000 25 --expiry 3d
hartii airdrop --csv recipients.csv --token DEMO --dry-run
hartii wall engrave "gm quai" --color '#e5243b'
```

CSV for `airdrop`: optional `address,amount` header, then `address,amount` rows (or address-only rows with
`--amount`). Duplicate addresses collapse only when amounts match; Qi-ledger and zero addresses are rejected.

## `--json` output

JSON goes to stdout, one document per command (`watch` streams NDJSON frames). Wei-scale quantities are decimal
strings. Failures print `{"ok": false, "error": "…"}` to stderr and exit non-zero. Stable shapes:

```jsonc
// write commands (send, buy, sell, swap, otc create|fill|cancel, claim, wall engrave)
{ "ok": true, "txHash": "0x…", "status": "success", "quaiscanUrl": "https://quaiscan.io/tx/0x…",
  "summary": { "action": "Buy DEMO", "network": "mainnet", "chainId": 9, "from": "0x…", "to": "0x…",
               "valueQuai": "5.0", "guardedQuai": "5.0", "gasLimit": "…", "gasPriceWei": "…",
               "estimatedFeeQuai": "…", /* command-specific lines: minTokensOut, feeBps, phase, … */ },
  "receipt": { "status": 1, "blockNumber": 0, "transactionHash": "0x…", "gasUsed": "…" } }
// --dry-run:   { "ok": true, "dryRun": true, "summary": { … } }
// declined:    { "ok": false, "aborted": true, "summary": { … } }
// multi-step (approve then trade) with --dry-run: { "ok": true, "dryRun": true, "tradeSimulated": false, "summary": { …approval… } }

// balance
{ "wallet": "0x…", "walletName": "main", "network": "mainnet", "quai": "12.34", "quaiWei": "…",
  "holdings": [ { "tokenAddress": "0x…", "symbol": "DEMO", "balance": "…", "priceQuai": "…", "valueQuai": "…", "priceSource": "curve" } ],
  "totals": { "valueQuai": "…" } }

// tokens
{ "sort": "trending", "items": [ { "address": "0x…", "symbol": "DEMO", "name": "…", "status": "active", "curveAddress": "0x…",
  "holderCount": 42, "volume24hWei": "…", "lastPriceWei": "…", "trendingScore": 91 } ], "nextCursor": null }

// token
{ "token": { … }, "network": "mainnet", "graduationProgress": { … }, "reference": { … }, "curveState": { … }, "links": { … } }

// tx
{ "hash": "0x…", "network": "mainnet", "status": "success|reverted|pending|not found", "blockNumber": 0,
  "from": "0x…", "to": "0x…", "valueQuai": "…", "gasUsed": "…", "quaiscanUrl": "…" }

// airdrop
{ "ok": true, "dryRun": false, "plan": { "contract": "0x…", "addressSource": "live|bundled", "asset": "QUAI", "recipients": 600,
  "duplicatesCollapsed": 0, "batches": 2, "total": "…", "serviceFeesQuai": "…" },
  "batches": [ { "batch": 1, "recipients": 500, "ok": true, "txHash": "0x…", "status": "success", "summary": { … } } ] }

// otc list
{ "contract": "0x…", "addressSource": "live|bundled", "network": "mainnet", "status": "open", "scanned": 25,
  "items": [ { "id": "7", "status": "open", "maker": "0x…", "token": "0x…", "symbol": "DEMO", "amount": "1000.0",
               "wantedQuai": "25.0", "priceQuaiPerToken": "0.025", "feeQuai": "0.125", "totalDueQuai": "25.125",
               "takerOnly": null, "expiresAt": "2026-10-12T…Z", "link": "https://hartiibiome.com/otc.html?offer=7&chain=9&v=1" } ] }

// claim <id> --check
{ "contract": "0x…", "network": "mainnet", "account": "0x…", "eligibility": "eligible|already claimed|not eligible|expired|closed",
  "campaign": { "id": "…", "status": "open", "symbol": "QUAI", "total": "…", "remaining": "…", "leafCount": "…", "expiresAt": "…" },
  "allocations": [ { "index": 3, "amount": "5.0", "claimed": false } ], "unclaimedTotal": "5.0", "claimFeeQuai": "0.05" }

// wall stats | recent
{ "contract": "0x…", "wall": "Global Wall", "blockCount": "412", "nextPriceQuai": "21.6", "engraveBaseQuai": "1.0",
  "wallFeeQuai": "10.0", "totalEngravings": "…", "totalPaidQuai": "…", "recent": [ { "index": "411", "author": "0x…", "color": "#7c3aed", "paidQuai": "…", "token": null, "message": "…", "at": "…" } ] }

// doctor
{ "ok": true, "checks": [ { "name": "rpc", "ok": true, "detail": "…" } ] }
```

`watch --json` prints one live-hub frame per line: `{ "v": 1, "channel": "global", "type": "trade|burn|head", "seq": 1, "ts": 0, "data": { … } }`.

## The TUI

`hartii` opens a full-screen terminal UI (alternate screen, restored on exit; 80×24 and up, resize-aware; plain
output when stdout is not a TTY; `NO_COLOR` removes all colour). The header carries the Hartii camel, the network,
your wallet and balance, the **live block height in LED numerals** and the **block ribbon** — the last 32 blocks as a
strip where each cell's height is the QUAI traded in that block and its colour is the net flow; the newest block
pulses Hartii red, then cools. Panes: **Balances**, **Watchlist** (live prices and 24h change; `a` add, `d` remove,
stored in `~/.hartii/watchlist.json`), **Live trades** (per block, newest first), and the **Actions** bar:
Send · Buy · Sell · Swap · Airdrop · OTC · Claim · Wall · Wallets · Settings.

Keys: `↑↓←→` move · `Tab` / `Shift-Tab` switch pane · `Enter` open / confirm · `Esc` back · `r` refresh · `?` help ·
`q` quit. Forms validate inline; submitting runs the same command as the CLI, shows its exact simulated summary and
waits for `y` (or `n`); the keystore password is asked in a masked prompt. Create and import wallets in the shell, so
a recovery phrase is never drawn on screen. `hartii ui --demo` runs the whole thing on fixtures and can never sign.

## MCP server for AI agents

```bash
hartii mcp                                          # read-only
hartii mcp --allow-writes --max-per-tx 5 --max-per-day 20
```

**Read tools** (always): `hartii_wallet`, `hartii_balance`, `hartii_portfolio`, `hartii_trending`, `hartii_token`,
`hartii_quote`, `hartii_tx_status`, `hartii_otc_list`, `hartii_claim_eligibility`, `hartii_wall_stats`.
**Write tools** — registered **only** with `--allow-writes`: `hartii_send`, `hartii_buy`, `hartii_sell`,
`hartii_swap`, `hartii_otc_fill`, `hartii_otc_cancel`, `hartii_claim`. Every write is a **dry run** (the simulated
confirmation summary, nothing signed) unless the call passes `confirm: true`, and a real send returns the summary plus
the receipt. `--max-per-tx` / `--max-per-day` can only **tighten** the configured spending caps, never loosen them.

Stdio is the protocol channel, so there is no password prompt: signing needs `HARTII_PASSWORD` (or `--key-env`) in the
server's environment. Dry runs work without it.

Claude Code:

```bash
claude mcp add hartii -- hartii mcp
# with writes (caps are yours to choose; password via env, never on the command line):
claude mcp add hartii -e HARTII_PASSWORD=… -- hartii mcp --allow-writes --max-per-tx 5 --max-per-day 20
```

Cursor (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "hartii": {
      "command": "hartii",
      "args": ["mcp", "--max-per-tx", "5", "--max-per-day", "20"],
      "env": { "HARTII_HOME": "~/.hartii" }
    }
  }
}
```

Token names, symbols, metadata and wall messages are third-party text: the server strips control characters and tells
the model to treat them as data, but keep write access to a wallet that holds only what you are willing to let an
agent spend.

## Security model

- **Keys live only in an encrypted keystore** (`~/.hartii/keystore/<name>.json`, scrypt keystore v3, mode 0600 where
  the OS supports it). The password comes from a hidden prompt or `HARTII_PASSWORD`. `--key-env VAR` reads a raw key
  from an environment variable for CI and prints a loud warning.
- **Keys and mnemonics are never printed**, except by `wallet export` after you type the wallet's name back.
- **Spending guard** on every write, including MCP: `limits.perTxQuai` (default 100) and `limits.dailyQuai` (default
  500), tracked in `~/.hartii/spend.json`. Canonical mined successes charge guarded value plus gas; canonical mined
  reverts charge gas even though the requested value did not move. Unknown or non-final receipts retain the full
  guarded-value-plus-gas reservation; check the transaction before retrying or reconciling allowance.
  Native QUAI value is capped directly; token-denominated writes are valued in QUAI from a live quote and
  **refused** if no QUAI valuation exists.
- **Balance pre-check**: before the summary and again before any reservation, a write must satisfy `balance >= value + gasLimit x gasPrice`. `send all`, `buy all|N%` and QUAI-in `swap all|N%` hold back gas estimated from the real transaction shape (a first transfer to a never-seen account costs about twice a zero-value call). A node's JSON-RPC rejection (insufficient funds, nonce too low, underpriced, invalid sender) releases the reservation; ambiguous errors keep it.
- **MCP review token**: a write tool's dry run returns a `reviewToken` (digest of tool, chain, from, to, value, calldata shape and every reviewed term). `confirm:true` needs that token, once, within 10 minutes; the real run is re-simulated and refused ("Terms changed since the review") if any reviewed term differs or gas/price drifted more than 20%. In an approve-then-trade flow the token binds the first transaction (the approval); the trade is re-quoted under the same caps.
- **Clean stdout**: every `console.*` call is redirected to stderr for the process lifetime, so a dependency logging an error cannot corrupt `--json` output or MCP frames; results are written with `process.stdout.write`.
- **Secret prompts need a TTY**: a password or secret is never read unmasked from a pipe. Use a terminal, `HARTII_PASSWORD` (automation), or the explicit `--stdin` flag (e.g. `wallet import key --stdin < keyfile`).
- **RPC transport**: `--rpc` must be `https://`; plain `http://` is refused unless `--allow-insecure-rpc` is passed and the host is localhost. The chain-id check times out after 8 seconds.
- **TUI confirm**: the confirm overlay shows every summary line (wrapped, scrollable); `y` is accepted only after the end is visible, and a terminal too small to review refuses it ("resize or use the CLI").
- **No blind signing**: every write is simulated from your address, carries an access list, an explicit gas limit, and
  must return receipt status 1 before success is reported. Quai-ledger addresses only; mainnet requires checksummed
  addresses and the chain id is verified first.
- **Hartii tool contracts**: the BUNDLED Airdrop / OTC / Claim addresses are authoritative. `hartiibiome.com/live-addresses.json`
  may only confirm them (`addressSource: live`); a different live address is refused with "update the CLI". Humans can
  override once with `--trust-live-addresses` (never available over MCP; labelled UNVERIFIED in the summary). Claim leaves files are
  re-hashed and rejected unless they match the on-chain Merkle root, leaf count and total.
- **Curves are factory-verified**: before any buy/sell/approve (and before valuing a token for the spend guard) the curve
  the market API names must be registered for that token by one of the bundled launch factories (`curveOf(token)`, from
  `src/data/liveAddresses.json`), then pass the curve's own `token()` binding. Otherwise the command refuses.
- **MCP limits**: write tools take a token **address**, never a ticker; slippage above 10% is rejected; `--allow-writes`
  refuses to start without explicit `--max-per-tx` and `--max-per-day` (they only tighten the config caps); the fee
  ceiling cannot be raised over MCP.
- **Fee ceiling**: a write whose estimated fee (gas limit x gas price) exceeds max(25 QUAI, 5% of the value moved) is
  refused unless a human passes `--max-fee <quai>`. The estimated fee counts toward the spending guard.
- **Chain pinned at signing**: every transaction carries the expected chain id (9 mainnet / 15000 orchard) and the signer
  refuses unless the provider agrees immediately before signing.
- **Token addresses beside names**: every summary and MCP result shows a token's address right next to its (third-party,
  spoofable) symbol, e.g. `SYM (0x...)`.
- **RPC URLs are redacted** (credentials, query strings, key-like path segments) in every error and output.
- **Pending authority**: a locally unresolved send blocks new signing by the same sender on that chain, even when a daily budget has room. Legacy unbound reservations conservatively block all chains for that sender. The profile-wide file lock also serializes active writes. State is scoped to the configured `HARTII_HOME`; it cannot coordinate other wallets or deliberately separate profiles.
- **Read-only recovery view**: run `hartii tx pending`, then `hartii tx <hash>` for recorded hashes. A missing hash or stale process is not proof of cancellation. Never delete reservations or blindly resend; reconcile the exact chain, sender, nonce, destination, value, receipt and gas first. The CLI never automatically expires or unlocks uncertain authority.
- **Private storage**: new/renamed wallet files publish without overwriting another destination; linked and hardlinked paths are refused. Malformed config does not restore broader default limits. Recovery metadata must derive the same key/address before an exported phrase is returned. Windows ACLs remain explicitly unverified rather than certified from POSIX bits.
- **Privacy**: the CLI keeps encrypted wallets, config, watchlists and spending/transaction metadata in the selected local profile. RPC, Hartii APIs, WebSocket providers and browsers opened to explorer links can process network metadata. MCP clients may send or retain tool output under their own policies. Receiving QR codes and HPAY links is offline and exposes only the public address and optional payment request; memo text in a shared link is public.

## Develop

```bash
npm install            # quais, @modelcontextprotocol/sdk, zod (+ vitest for the tests)
npm test               # mocked RPC/fetch only: no network, no real keys
node bin/hartii.js ui --demo
```

The `vendor/` folder holds a few small pure helpers (curve and fee math, the live-hub protocol, RPC retry) that are shared
with the HartiiLabs web app. Releases are built from the HartiiLabs monorepo; this repository is the public, reviewable copy.
Contributions are welcome: open an issue first for anything that touches signing, keys or the spending guard.

MIT licensed. See [SECURITY.md](SECURITY.md) to report a vulnerability.
