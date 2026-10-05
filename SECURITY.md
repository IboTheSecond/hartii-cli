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

Keys live only in an encrypted keystore; every write is simulated and must report receipt status 1; there is no
telemetry; network access is limited to your RPC, hartiilabs.com / hartiibiome.com and the live WebSocket.
