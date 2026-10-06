// stdout belongs to the CLI's own result writer (--json) and to the MCP protocol (stdio transport).
// quais logs errors with console.log/error (e.g. provider-jsonrpc.js on an unreachable RPC), which
// would corrupt a JSON document or an MCP frame. Redirect every console method to stderr for the
// life of the process; the CLI writes its results with process.stdout.write directly.
import { format } from 'node:util';

const METHODS = ['log', 'info', 'debug', 'warn', 'error', 'trace'];
let installed = null;

/** Idempotent. Returns restore() (tests / embedded callers; bin/hartii.js never restores). */
export function installConsoleGuard() {
  if (installed) return installed.restore;
  const saved = {};
  for (const m of METHODS) {
    saved[m] = console[m];
    console[m] = (...args) => { try { process.stderr.write(format(...args) + '\n'); } catch { /* a closed stderr must not crash a write */ } };
  }
  installed = { restore: () => { for (const m of METHODS) console[m] = saved[m]; installed = null; } };
  return installed.restore;
}
