# Security

Hartii CLI is **beta** software that handles private keys and can move funds. It has not been independently audited.

## Reporting a vulnerability

Please report security issues privately through GitHub's "Report a vulnerability" (Security tab of this repository)
rather than a public issue. Include the version (`hartii version`), what you did and what you expected. Do not include
real keys, recovery phrases or passwords. We aim to acknowledge reports within a few days.

## What is in scope

- Anything that could expose a key, mnemonic or password (keystore, prompts, logs, MCP output).
- Anything that could make a write go to a destination, amount or contract the user did not confirm.
- Bypasses of the spending guard, the fee ceiling, the dry-run default of the MCP write tools, or the `--allow-writes` gate.
- Terminal-injection through untrusted text (token names, wall messages) in the CLI or the TUI.

## Design notes (see README "Security model")

Keys are stored in encrypted local keystores; secret argv imports are refused. Recovery metadata is checked against the decrypted signing identity. Writes share simulation, chain/signer/nonce validation, exact spending accounting and conservative unresolved-transaction reservations. Canonical receipt status and matching locally known transaction identity are required; an RPC error alone does not release authority.

Windows ACLs are not certified from POSIX file modes. Static file checks are not an operating-system sandbox against a privileged local attacker. No test suite establishes safety of every dependency or funded execution on every network. Start with an isolated profile and small amounts.

Receiving QR codes and links is generated offline from public metadata. Shared payment memos are public. Local files, RPC/API/WebSocket infrastructure, browser explorer links and agent-client retention have separate privacy boundaries. See README for the full model. The CLI performs no application analytics itself.
