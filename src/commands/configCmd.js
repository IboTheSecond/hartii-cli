// packages/hartii-cli/src/commands/configCmd.js
//
// `hartii config get <key>` / `hartii config set <key> <value>` — thin wrapper over config.js's
// dotted-path get/set, settable keys restricted there to the small documented surface
// (network, currentWallet, limits.perTxQuai, limits.dailyQuai).
import { getHartiiHome, loadConfig, saveConfig, configGet, configSet } from '../config.js';

function runConfigGet(home, key) {
  const cfg = loadConfig(home || getHartiiHome());
  if (!key) return cfg;
  const value = configGet(cfg, key);
  if (value === undefined) throw new Error(`"${key}" is not set.`);
  return { [key]: value };
}

function runConfigSet(home, key, value) {
  const resolvedHome = home || getHartiiHome();
  const cfg = loadConfig(resolvedHome);
  const next = configSet(cfg, key, value);
  saveConfig(resolvedHome, next);
  return { [key]: configGet(next, key) };
}

/** `hartii config get|set ...` */
export function runConfig([sub, key, value], home) {
  if (sub === 'get') return runConfigGet(home, key);
  if (sub === 'set') return runConfigSet(home, key, value);
  throw new Error('Usage: hartii config get <key> | hartii config set <key> <value>');
}
