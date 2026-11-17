# Changelog

## [Unreleased]

## [0.7.0] — 2026-11-17

Security hardening from the 2026-11-17 review (each item has a test that failed before the fix), plus `hartii verify-site`. Ships with Labs 1.75.0.

Security hardening from the 2026-11-17 adversarial review (R3). Still BETA.

- **Export and remove need a terminal (R3-F1).** `wallet export` and `wallet remove` refuse without an interactive terminal, and export always asks for the password at a hidden prompt: `HARTII_PASSWORD`, `--key-env` and a pipe no longer unlock it.
- **Raising a cap needs a terminal (R3-F2).** `config set limits.*` to a higher value or `none` asks for confirmation on a terminal and refuses in scripts; tightening or first-time setting works anywhere. README Security model now says plainly: MCP caps are a real control, a shell with `HARTII_PASSWORD` is full access.
- **MCP swap is verified-token only (R3-F3).** `hartii_swap` accepts QUAI, WQUAI and factory-registered Hartii tokens; any other token address is refused.
- **Qi payment notice uses the write pipeline (R3-F4).** The QUAI transaction that announces a payment-code send now gets the chain check, simulation, access list, 25 QUAI fee ceiling, spend ledger entry and write lock; the offline-signing wallet moved to `buildReviewedWallet` in `commandContext.js` so there is one signing path.
- **Qi ledger sealed, merged on save (R3-F5).** The Qi address ledger is sealed with the same local vault as the spend ledger (a plain one is sealed when the vault is created) and reads as locked without a password.
- **Qi and Quai address checksums (R3-F6).** A mixed-case Qi address with a wrong checksum is refused; all-lowercase is accepted and normalised. README wording corrected.
- **Qi caps with more than 3 decimals are an error (R3-F7)**, never silently "no cap".
- **Look-alike check is real (R3-F9).** For a look-alike address you type the 6 characters where it differs from the known address, not the shared last 4.
- **Update path limits (R3-F11).** Streamed 50 MB download cap, 200 MB unpacked cap, signature checked before parsing when the manifest names the version.
- **Vault (R3-F13, F14).** `wallet remove` drops the wallet's vault slot (the last slot is retired, never deleted, so data stays reachable and `vault enroll` guides re-enrolment); new slots use scrypt N=2^17 and a vault asking for more than 2^18 is refused; older slots are re-wrapped on the next unlock.
- **`hartii verify-site`.** Checks that hartiilabs.com serves exactly the signed build: manifest + ed25519 signature verified with the web release key pinned in `src/webReleaseKey.js` (id `a17f68595150dac6`, same as `src/data/webReleaseKey.json`, kept in sync by a root test), every listed non-HTML file compared by sha256, and `/` must reference only signed scripts and styles. Fixed origin, no redirects, size caps (manifest 2 MB, signature 1 KB, 25 MB per file), concurrency 6, `--json` object `{ ok, version, commit, keyId, checked, failures }`, non-zero exit on any failure.
- Fence test `test/writeLaneFence.test.mjs`: fails if any module outside the reviewed write lanes signs or broadcasts.

## [0.6.1] — 2026-11-17

One setup fix and a docs patch.

- **Setup no longer misses a fast deposit.** "Waiting for funds" took its baseline from the first balance check after the screen opened, so funds that landed before that check (up to 4 s) left it waiting forever. A wallet created in setup now starts from zero, and a reading for another wallet is ignored. An imported wallet still uses its first reading, so funds it already holds are not shown as received.
- README brought up to 0.6.0: no default spending caps (`none` clears a cap), the plain review and new-payee check, signed updates (key id 3f0f68fc9ba1a619), encrypted local files, `contacts`, `vault enroll`, `qi`, `ui.terse`, and how `hartii mcp` caps combine with yours (no config caps: the MCP caps apply; with config caps the lower wins).
- `hartii qi ?` printed a broken character: `src/help.js` carried one cp1252 byte. Fixed, and `test/sourceEncoding.test.mjs` now fails on any shipped file that is not valid UTF-8.
- `hartii config ?` lists `ui.terse` and that `none` clears a cap.

## [0.6.0] — 2026-11-17

Built from the owner's 21 answers of 2026-11-16 (scan and spec: newcomers first; safety, then ease). Still BETA.

- **Guided first run.** `hartii` with no wallet opens setup instead of an empty dashboard: create or import, a password of at least 12 characters, the recovery phrase shown once on a screen that is cleared afterwards, a check of 3 random words (or "back up later", which leaves a reminder and a `B` key on the home screen), an optional spending-cap step, then the receive screen that waits for funds. `hartii init` and `hartii wallet new` on a terminal run the same flow; scripts and `--json` stay non-interactive and never show the phrase. `wallet export` is unchanged.
- **No default spending caps.** Caps exist only when you set them (setup recommends it; `hartii config set limits.perTxQuai <n>` / `limits.dailyQuai`, `none` clears). A cap you set works as before. `--yes` is refused unless caps are set, so nothing is sent without a preview. The MCP server still requires its own caps.
- **Plain-sentence review** before every send ("You send 2.5 QUAI to …", fee and total rounded up, warnings, "Nothing is sent until you confirm"); `--details` adds the technical fields; `--terse` or `hartii config set ui.terse true` keeps one line per result. JSON output is unchanged.
- **Warnings that never block:** slippage above 10%, a token picked by ticker instead of address, a fee bigger than the amount, a new recipient, a look-alike address.
- **New payee check:** for an address never paid from this computer, type its last 4 characters (also in the dashboard). Unattended sends to a new address need `--yes --new-recipient-ok`; a look-alike address is never allowed unattended. Agent (`hartii mcp`) sends can only go to addresses this computer has already paid: pay a new address once from the terminal first (the agent's dry run still works).
- **Contacts:** `hartii contacts add|list|remove|rename`, `hartii send <name> <amount>`; after a send to a new address you can save it.
- **Encrypted local files:** the spending ledger, the paid list, contacts and the desk journal are sealed with the wallet password once you make a real send; `hartii vault enroll <wallet>` adds a wallet with a different password. The watchlist stays readable (public token list). Read commands show sealed data as locked when no password can be asked.
- **Signed updates:** releases are signed with ed25519; `hartii update` verifies the signature against the key built into the CLI (key id 3f0f68fc9ba1a619) before npm runs and refuses unsigned or changed releases. The package ships an `npm-shrinkwrap.json`.
- **`hartii qi`** (BETA, Orchard testnet first): `address`, `balance`, `notes`, `receive`, `send <payment-code|qi-address> <amount>`. Needs a wallet made from a recovery phrase; smallest-note selection; only receipt status 1 counts; an unclear outcome is never retried; addresses are never reused. Mainnet sends need `--network mainnet --allow-mainnet-qi`. Proven on Orchard on 2026-11-17 (tx 0x00ca0087…c95f).
- **New look:** Hartii Labs black-and-white with violet as the one accent and red only for danger; wallet-first home (balance, Receive, Send; trade and tools one step away); LED camel and numerals with subtle motion (`HARTII_REDUCED_MOTION=1` turns it off); works at 60, 80 and 120 columns; ASCII fallback for older consoles (`HARTII_ASCII=1`); `NO_COLOR` respected.
- **Readable screens:** one formatter for amounts (no raw wei or base units in human views), designed views for balance, whoami, networks, gas, limits, token, tokens, tx, block, config, about and init; `doctor` ends with one verdict and the fix command for each failure, and warns when the wallet folder is outside your user profile; bare `hartii wallet` lists its subcommands; `limits` works without a wallet.
- **Smaller fixes:** the watchlist is written atomically and never through a link; swap no longer falls back to the Hartii proxy when you set your own `--rpc`; the chain-id check refuses redirects; Windows hardens a new wallet folder; a test fails the build if the CLI contacts a server outside the published list.

## [0.5.0] — 2026-11-12

- Constraint Desk / Fill Ledger beta commands: watch-only position context, swap preview, individually confirmed guarded swaps, private decision journal, canonical receipt observations and self-contained HTML/JSON exports.
- Capture reviewed authority and locally verified signed hashes through existing native hooks. Preserve unknown outcomes and separate approval decisions; no new signing engine or automatic trading mode.
- Include raw asset units/decimals in swap summaries for exact-denomination quote comparisons. Distinguish gas ceilings, observed fees and event-derived output; do not invent native proceeds, balance proof or historical P&L.
- Convert API portfolio wei marks to QUAI in Desk and the existing balance table. Keep exact `indexedValueWei` alongside formatted `indexedValueQuai`; distinguish unknown/malformed values from zero. Balance fixtures now match the live API's wei wire units.

## [0.4.0] — 2026-11-05

Read-only Hartii Gallery and Studio tools, as CLI commands and MCP tools. No wallet, signing or NFT writes are involved; data comes only from the Gallery's public API (`https://hartiigallery.com/api`).

- `--preset conservative|normal|degen` for `hartii mcp --allow-writes` and `hartii trader init`: implies per-tx/per-day caps (10/50, 50/250, 250/1000 QUAI) and an MCP slippage ceiling (1%, 2%, 5%); explicit caps may only lower a preset. Active preset shown in `hartii_trader_limits`, `hartii_wallet` and `hartii trader status`.
- New commands: `hartii gallery search|collection|item|trending` and `hartii studio rooms|open [--open]`. `studio open` prints the Studio deep link (`/studio?collection=<address>` or `/studio?piece=<address>:<tokenId>`); `--open` launches it only after checking the URL is on `https://hartiigallery.com/`.
- New MCP read tools: `hartii_studio_rooms`, `hartii_studio_link`, `hartii_gallery_search`, `hartii_gallery_collection`, `hartii_gallery_item`, `hartii_gallery_trending`. All are annotated read-only and open-world, and their descriptions label names and traits as third-party data.
- `hartii portfolio` / `balance --tokens` and `hartii_portfolio` now include the address's NFT holdings grouped by collection (first page of up to 100 tokens). A Gallery outage adds `nftHoldingsError` and never fails the balance.
- `gallery trending` ranks collections by indexed marketplace sales in the last N days (default 30), then by volume, and states that basis in its output; it is not a floor or social ranking.
- The MCP server keeps a 60 second in-memory cache of Gallery reads to keep Gallery D1 reads low.
- Not included: live visitor counts per Studio room. The Gallery exposes presence only through a WebSocket join and has no public count endpoint, and these tools never join a room.

## [0.3.4] — 2026-10-16

- Reject inline values on declared boolean flags before command, TUI or MCP dispatch. Inputs such as `--dry-run=true` can no longer silently disable the requested safety mode; use the bare `--dry-run` switch. MCP write opt-in remains bare-only. Parser errors return exit 1, keep stdout clean and do not echo the supplied value.

## [0.3.3] — 2026-10-11

- Copy-only patch: drop the audit-status disclaimer wording from `hartii help`, `hartii doctor`, `hartii version` status output, wallet reminders, the MCP server description, the README and the public SECURITY text. No command, flag, signing or limit behaviour changes.

## [0.3.2] — 2026-10-11

- Fix every confirmed remaining wallet audit defect: mutable selected-wallet/network context with stale-response fencing; Orchard feed isolation; ticker watch removal; visible menu/list/form selection; complete result arrays; stale-feed indication; terminal exception cleanup.
- Integrate the reviewed Receive pane with complete QR geometry and bounded, cancellable public-text clipboard writes. Clipboard success is shown only after a successful setter exit; demo never copies or signs.
- Honor global wallet selection for public-address/export-review/lock-check routes, preserving positional precedence and typed export confirmation. Correct browser/address-QR boolean parsing and unknown clock verification; bound doctor reads.
- Route actual installer output to stderr for clean JSON, correct the Cursor profile example and omit missing development scripts from runtime packages while keeping source-export tooling.
- Keep bulk RPC batches at 20, verified through the real SDK against a bounded local RPC fixture. Preserve the 0.3.1 signing/receipt safeguards. No auto-signing grant, key cache or activation is added.

## [0.3.1] — 2026-10-11

- Correct the pinned Quai SDK's nonce-zero broadcast response: after locally verified signed bytes and matching hash, restore its null nonce to the reviewed zero. Actual transaction/receipt identity mismatches remain unconfirmed and keep their reservations.
- Show uncertain broadcasts as UNCONFIRMED with the public hash and status-check command; distinguish confirmed reverts from ordinary failures. Never suggest resending an uncertain transaction.
- Wrap and scroll TUI result pages and retain every scalar summary row, including the transaction hash on long results.
- Added regressions through the real SDK broadcast formatter at nonce 0, 1 and 17, conflicting nonce guards, and TUI outcome/result navigation. Receipt I/O in these tests is synthetic; these tests do not establish every funded operation on a live network.

## [0.3.0] — 2026-10-10

Adds the BETA personal holder trader (Observe and Paper only; Live is gated and not enabled) and keyless MCP trader reads. Requires Node 22 or newer.

- New `hartii trader` command group: `init` (public owner and dedicated trading addresses, four absolute QUAI budgets, optional `--pair`), `paper` (`--demo` is an offline proof on labeled empty data), `run --observe`, `watch`, `status`, `pause` and `export`, plus the gated `arm`, `run` and `reconcile`. Observe and Paper need no transaction key. A profile is stored under `HARTII_HOME/trader/<profile>`; pairing uses a hidden one-use code and an Ed25519 device key kept in an encrypted envelope.
- `hartii mcp` gains three keyless local reads: `hartii_trader_status`, `hartii_trader_limits` and `hartii_trader_activity`. Every MCP tool now has a strict input schema, an output schema, annotations and `structuredContent` with a `_hartii` capability block (authority, mode, chain); the text content stays the same JSON.
- Shared write path: internal hooks let the trader's in-process adapter persist the signed transaction hash before broadcast and account a managed exit's gas instead of its proceeds. No CLI flag or MCP input installs them, and the ordinary per-transaction and daily limits are unchanged.
- New bare boolean flags `--once`, `--observe`, `--pair` and `--create-wallet`.
- `hartii update` accepts Windows 8.3 short-name temp paths (a literal `~`) and still rejects `&`, `%` and `!` before npm runs.
- Output redaction keeps a complete explorer transaction or address URL readable and masks any other path segment of 16 or more characters.
- Node 22 or newer (`engines`); `@modelcontextprotocol/sdk` 1.32.1 and `zod` 4.6.5.
- Installs on 0.2.2 or older still cannot self-update (run the install command once); 0.2.3 and newer are offered 0.3.0 by `hartii update`.

## [0.2.3] — 2026-10-08

- `hartii update` (alias `upgrade`) now really updates. It reads the new `hartii-cli.json` manifest (`version`, `sha256`, `url`; falls back to the `.sha256` file and the version inside the tarball), compares versions with semver, and says "You're on the latest version" or "Update available: a → b". `--check` only reports; a confirmation is asked on a terminal, and non-terminal or `--json` runs need `--yes`.
- The tarball is downloaded to a temp file (same-origin HTTPS, `redirect: error`, timeout, size cap), refused unless its sha256 equals the published one and its inner version matches, installed with `npm install -g <local file>` (`npm.cmd` on Windows, no shell interpolation of downloaded content), then verified with `hartii --version`. Failures print the exact manual command, with an EACCES sudo / npm-prefix hint on macOS and Linux. The MCP server has no update tool and stays read-only.
- The tarball build now also writes `hartii-cli.json` next to `hartii-cli.tgz` and `.sha256`.
- Installs up to 0.2.2 cannot self-update: run `npm install -g https://hartiilabs.com/downloads/hartii-cli.tgz` once.

## [0.2.2] — 2026-10-08

- Sign the complete reviewed transaction offline and verify its canonical bytes and sender. Preserve an explicit nonce of zero; recheck chain, pending nonce and local expiry after signing, then broadcast once.
- Release allowance for proven local signing failures; retain the locally computed transaction hash and allowance for ambiguous broadcasts. Node rejection must be bound to the exact submitted raw transaction.
- Require valid contract access lists for gas preparation and query Cyprus-1 fee data explicitly.
- Requote and re-estimate gas after reducing `buy all` / percentage values, with bounded decreasing preparation passes. Final gas, balance, spending and slippage checks remain mandatory.
- Regression verification uses isolated synthetic wallets and in-memory providers; no funded-chain success claim is made.

## [0.2.1] — 2026-10-06

Fixes from an adversarial review of the money-handling paths.

- `send <fresh address> all`, `buy all|N%` and QUAI-in `swap all|N%` reserve gas from the highest estimate of the real transaction shape (x1.2 x1.1) instead of a value:0 estimate, so the node no longer refuses them and strands the spend reservation.
- Every write checks `balance >= value + gasLimit x gasPrice` before the summary and again before reserving; a shortfall is a clear error with nothing reserved.
- A JSON-RPC rejection response (insufficient funds, nonce too low, underpriced, invalid sender) is a proven pre-broadcast rejection and releases the reservation; bare error codes and transport errors still keep it.
- `--key-env` dry runs, `claim --check`/`list` and `otc list --mine` resolve the sender exactly like the real run; dry runs also run the pending-authority and provider-chain checks.
- A process-level guard sends every `console.*` call to stderr (bin and MCP), so a library logging to stdout can no longer corrupt `--json` output or MCP frames.
- TUI confirm overlay wraps and scrolls the whole summary (`N more lines` marker); `y` is refused until the end is visible, or when the terminal is too small to review.
- MCP: a dry run returns a `reviewToken`; `confirm:true` requires it (one use, 10 minutes) and the real run is refused with "Terms changed since the review" if any reviewed term moved or gas drifted more than 20%.
- Terminal and MCP text share one category-based sanitizer (Cc, Cf, Zl, Zp, tag block U+E0000-E007F, invisible fillers).
- A spend-lock cleanup problem never masks the operation's own result; `config set limits.*` rejects leading zeros; secret prompts refuse a non-TTY stdin unless `HARTII_PASSWORD` or an explicit `--stdin` is used; `receive --expires` needs `30m`/`2h`/`7d`; `otc`/`claim` lists page through every id (cap 5000, `truncated` flag); zero-balance `all`/tiny `%` say "nothing to spend"; the chain-id check times out after 8s; plain `http://` RPCs are refused unless `--allow-insecure-rpc` and localhost.

## [0.2.0] — 2026-10-06

- Receive QUAI offline with a real terminal QR, SVG export and an HPAY payment link, including exact amounts and optional memos.
- Send native QUAI to an address or reviewed mainnet HPAY link through the same guarded pipeline.
- Bind confirmation to signer, chain, nonce and transaction; recheck before signing and block new sends while an outcome is unresolved.
- Inspect public reservation and lock metadata with `hartii tx pending` without unlocking a wallet.
- Refuse secrets in command-line arguments, linked wallet files and corrupt configuration; authenticate recovery metadata on decrypt.
- Require literal MCP write opt-in and report Windows wallet permissions as unverified.
- Include an isolated native test launcher and stricter standalone export checks. This remains beta software.

## [0.1.1] — 2026-10-05

- Count gas for every canonical mined success or revert, including SDK errors carrying receipts.
- Retain the complete spending reservation for missing, malformed or uncertain receipt outcomes.
- Keep the exact reviewed transaction and actual gas accounting in the guarded write path.

## [0.1.0] — 2026-10-05

- First beta terminal wallet and trading package; TUI, script commands and explicit-write MCP interface.
