// packages/hartii-cli/src/commands/configCmd.js
//
// `hartii config get <key>` / `hartii config set <key> <value>` — thin wrapper over config.js's
// dotted-path get/set, settable keys restricted there to the small documented surface
// (network, currentWallet, limits.perTxQuai, limits.dailyQuai).
import { tagView } from '../output.js';
import { parseUnits } from 'quais';
import { requireInteractiveTerminal, confirm } from '../prompt.js';
import { getHartiiHome, loadConfig, saveConfig, configGet, configSet } from '../config.js';

function runConfigGet(home, key) {
  const cfg = loadConfig(home || getHartiiHome());
  if (!key) return tagView(cfg, 'config.get');
  const value = configGet(cfg, key);
  if (value === undefined) throw new Error(`"${key}" is not set.`);
  return tagView({ [key]: value }, 'config.get');
}

const capWei = (v) => parseUnits(String(v), 18);

/** True when `next` removes a cap or raises it above what was set (tightening or first-time setting is false). */
function loosensCap(cfg, next, key) {
  if (key !== 'limits.perTxQuai' && key !== 'limits.dailyQuai') return false;
  const before = configGet(cfg, key);
  if (before === undefined) return false;
  const after = configGet(next, key);
  return after === undefined || capWei(after) > capWei(before);
}

async function runConfigSet(home, key, value, io = {}) {
  const resolvedHome = home || getHartiiHome();
  const cfg = loadConfig(resolvedHome);
  const next = configSet(cfg, key, value);
  if (loosensCap(cfg, next, key)) {
    // A script (or an agent with a shell) must not be able to lift its own limit: a human at a terminal confirms.
    requireInteractiveTerminal(io, 'Raising or removing a spending cap');
    const ask = io.confirmFn || confirm;
    const to = configGet(next, key) === undefined ? 'no cap' : `${configGet(next, key)} QUAI`;
    if (!(await ask(`Raise ${key} from ${configGet(cfg, key)} QUAI to ${to}?`, io))) throw new Error('Cap change cancelled. Nothing was changed.');
  }
  saveConfig(resolvedHome, next);
  return tagView({ [key]: configGet(next, key) }, 'config.set');
}

/** `hartii config get|set ...` */
export function runConfig([sub, key, value], home, io) {
  if (sub === 'get') return runConfigGet(home, key);
  if (sub === 'set') return runConfigSet(home, key, value, io);
  throw new Error('Usage: hartii config get <key> | hartii config set <key> <value>');
}
