// packages/hartii-cli/src/config.js
//
// Everything this CLI persists locally lives under one "home" directory, `~/.hartii` by default,
// `HARTII_HOME` overridden for tests (and for anyone who wants an isolated profile — CI, a second
// identity). Nothing sensitive lives in config.json itself: wallet *keys* live only in
// keystore.js's encrypted per-wallet files under `<home>/keystore/`; this file holds the small
// amount of non-secret state (current network, current wallet name, spending-guard limits).
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { CliError } from './errors.js';

export class ConfigError extends CliError {}

export const DEFAULT_LIMITS = { perTxQuai: '100', dailyQuai: '500' };

/** @param {NodeJS.ProcessEnv} [env] */
export function getHartiiHome(env = process.env) {
  return env.HARTII_HOME || join(homedir(), '.hartii');
}

export function configPath(home) {
  return join(home, 'config.json');
}

function defaultConfig() {
  return {
    network: 'mainnet',
    currentWallet: null,
    limits: { ...DEFAULT_LIMITS },
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
  const defaults = defaultConfig();
  return {
    ...defaults,
    ...parsed,
    limits: { ...defaults.limits, ...(parsed.limits || {}) },
  };
}

/**
 * Writes `cfg` to `<home>/config.json`, creating `<home>` (mode 0700 best-effort) if needed.
 * Owner-only permissions are best-effort: Windows ignores POSIX modes entirely, and chmod/mkdir
 * mode failures there must never block the write (see keystore.js for the same convention).
 * @param {string} home
 * @param {object} cfg
 */
export function saveConfig(home, cfg) {
  if (!existsSync(home)) {
    mkdirSync(home, { recursive: true, mode: 0o700 });
  }
  const p = configPath(home);
  writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  try {
    chmodSync(p, 0o600);
  } catch {
    // best-effort (Windows) — see header note
  }
}

/** Dotted-path get, e.g. "limits.perTxQuai". Returns undefined for an unknown path. */
export function configGet(cfg, key) {
  return String(key)
    .split('.')
    .reduce((acc, part) => (acc === undefined || acc === null ? undefined : acc[part]), cfg);
}

const SETTABLE_KEYS = new Set(['network', 'currentWallet', 'limits.perTxQuai', 'limits.dailyQuai']);

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
  const next = { ...cfg, limits: { ...cfg.limits } };
  if (key === 'network') {
    const v = String(value).toLowerCase();
    if (v !== 'mainnet' && v !== 'orchard') throw new ConfigError('network must be "mainnet" or "orchard".');
    next.network = v;
  } else if (key === 'currentWallet') {
    next.currentWallet = value;
  } else if (key === 'limits.perTxQuai' || key === 'limits.dailyQuai') {
    // Same shape the spending guard accepts (<= 18 decimals): a limit the guard cannot parse would
    // otherwise refuse EVERY later write with a confusing error.
    if (!/^\d+(\.\d{1,18})?$/.test(String(value))) throw new ConfigError(`${key} must be a plain decimal QUAI amount with at most 18 decimals.`);
    next.limits[key.split('.')[1]] = String(value);
  }
  return next;
}
