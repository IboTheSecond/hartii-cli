# Changelog

## [Unreleased]

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
