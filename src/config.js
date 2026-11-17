// packages/hartii-cli/src/config.js
//
// Everything this CLI persists locally lives under one "home" directory, `~/.hartii` by default,
// `HARTII_HOME` overridden for tests (and for anyone who wants an isolated profile — CI, a second
// identity). Nothing sensitive lives in config.json itself: wallet *keys* live only in
// keystore.js's encrypted per-wallet files under `<home>/keystore/`; this file holds the small
// amount of non-secret state (current network, current wallet name, spending-guard limits).
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { CliError } from './errors.js';
import { assertValidWalletName } from './keystore.js';
import { securePath, atomicPrivateWrite } from './secureFiles.js';

export class ConfigError extends CliError {}

// 2026-11-16 (owner): NO default spending caps. `limits` holds only the caps the user chose; an empty object means
// no per-transaction and no daily cap. A cap that is set behaves exactly as before.
export const DEFAULT_LIMITS = Object.freeze({});

/** @param {NodeJS.ProcessEnv} [env] */
export function getHartiiHome(env = process.env) {
  return env.HARTII_HOME || join(homedir(), '.hartii');
}

export function configPath(home) {
  try { return securePath(join(home, 'config.json'), { regularFile: true }).path; } catch (error) { throw new ConfigError(error.message); }
}

const DECIMAL_LIMIT = /^\d{1,78}(\.\d{1,18})?$/;
// What `config set` accepts: the spending guard's canonical form (no leading zeros), so a limit set here can never be refused later.
const CANONICAL_LIMIT = /^(?:0|[1-9]\d{0,77})(?:\.\d{1,18})?$/;
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function validateConfig(value) {
  if (!plainObject(value) || Object.keys(value).some(key => !['network', 'currentWallet', 'limits', 'ui'].includes(key)) || (value.ui !== undefined && (!plainObject(value.ui) || Object.keys(value.ui).some(key => key !== 'terse') || (value.ui.terse !== undefined && typeof value.ui.terse !== 'boolean'))) || !['mainnet', 'orchard'].includes(value.network) || !(value.limits === undefined || plainObject(value.limits)) || Object.keys(value.limits || {}).some(key => !['perTxQuai', 'dailyQuai'].includes(key)) || !['perTxQuai', 'dailyQuai'].every(key => value.limits?.[key] === undefined || (typeof value.limits[key] === 'string' && DECIMAL_LIMIT.test(value.limits[key])))) {
    throw new ConfigError('Config is malformed or has unsupported fields. Restore a valid network and, if you set spending caps, explicit decimal caps; nothing was substituted.');
  }
  if (value.currentWallet !== null && value.currentWallet !== undefined) {
    try { assertValidWalletName(value.currentWallet); } catch { throw new ConfigError('Config contains an invalid wallet selection.'); }
  }
  return { network: value.network, currentWallet: value.currentWallet ?? null, ...(value.ui && value.ui.terse !== undefined ? { ui: { terse: value.ui.terse } } : {}), limits: Object.fromEntries(['perTxQuai', 'dailyQuai'].filter(key => value.limits?.[key] !== undefined).map(key => [key, value.limits[key]])) };
}

function defaultConfig() {
  return {
    network: 'mainnet',
    currentWallet: null,
    limits: {},
  };
}

/**
 * Reads `<home>/config.json`, returning the defaults (never throwing) if the file or the home
 * directory does not exist yet — a brand-new install has no config until something is `set`.
 * @param {string} home
 */
export function loadConfig(home) {
  const p = configPath(home);
  if (!existsSync(p)) return defaultConfig();
  let raw;
  try {
    raw = readFileSync(p, 'utf8');
  } catch (err) {
    throw new ConfigError(`Could not read ${p}: ${err?.message || err}.`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError(`${p} is not valid JSON — fix or delete it.`);
  }
  return validateConfig(parsed);
}

/**
 * Writes `cfg` to `<home>/config.json`, creating `<home>` (mode 0700 best-effort) if needed.
 * Owner-only permissions are best-effort: Windows ignores POSIX modes entirely, and chmod/mkdir
 * mode failures there must never block the write (see keystore.js for the same convention).
 * @param {string} home
 * @param {object} cfg
 */
export function saveConfig(home, cfg) {
  const checked = validateConfig(cfg);
  const p = configPath(home);
  try { atomicPrivateWrite(p, JSON.stringify(checked, null, 2) + '\n', { replace: true }); } catch (error) { throw new ConfigError(error.message); }
}

/** Dotted-path get, e.g. "limits.perTxQuai". Returns undefined for an unknown path. */
export function configGet(cfg, key) {
  return String(key)
    .split('.')
    .reduce((acc, part) => (acc === undefined || acc === null ? undefined : acc[part]), cfg);
}

const SETTABLE_KEYS = new Set(['network', 'currentWallet', 'limits.perTxQuai', 'limits.dailyQuai', 'ui.terse']);

/**
 * Dotted-path set, returning a NEW config object (never mutates `cfg`). Only ever touches one of
 * the known settable keys — `config set` is a narrow, documented surface, not an arbitrary JSON
 * patcher a typo in could corrupt.
 * @param {object} cfg
 * @param {string} key
 * @param {string} value
 */
export function configSet(cfg, key, value) {
  if (!SETTABLE_KEYS.has(key)) {
    throw new ConfigError(`"${key}" is not a settable config key. Settable keys: ${[...SETTABLE_KEYS].join(', ')}.`);
  }
  const checked = validateConfig(cfg);
  const next = { ...checked, limits: { ...checked.limits } };
  if (key === 'ui.terse') {
    const v = String(value).toLowerCase();
    if (v !== 'true' && v !== 'false') throw new ConfigError('ui.terse must be true or false.');
    next.ui = { terse: v === 'true' };
    return next;
  }
  if (key === 'network') {
    const v = String(value).toLowerCase();
    if (v !== 'mainnet' && v !== 'orchard') throw new ConfigError('network must be "mainnet" or "orchard".');
    next.network = v;
  } else if (key === 'currentWallet') {
    assertValidWalletName(value);
    next.currentWallet = value;
  } else if (key === 'limits.perTxQuai' || key === 'limits.dailyQuai') {
    // Same shape the spending guard accepts (<= 18 decimals): a limit the guard cannot parse would
    // otherwise refuse EVERY later write with a confusing error.
    if (['none', 'off', ''].includes(String(value).toLowerCase())) { delete next.limits[key.split('.')[1]]; return next; } // clear a cap
    if (/^0\d/.test(String(value))) throw new ConfigError(`${key} must not have leading zeros (use "50", not "050").`);
    if (!CANONICAL_LIMIT.test(String(value))) throw new ConfigError(`${key} must be a plain decimal QUAI amount with at most 18 decimals and 78 whole digits.`);
    next.limits[key.split('.')[1]] = String(value);
  }
  return next;
}
