# Changelog

## [Unreleased]

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
