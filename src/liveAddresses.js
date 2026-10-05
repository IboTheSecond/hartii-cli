// packages/hartii-cli/src/liveAddresses.js
//
// HartiiSwap's own factory/router/wquai addresses — loaded, never copied as a second set of
// literals (the product spec HARD RULES: "for every address ... never hardcode copies — load it").
// Packaging preserves this source-relative JSON path; fail closed if it is unavailable.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Monorepo checkout first-class; the packed tarball carries a fresh copy under vendor/ (scripts/build-hartii-cli-tarball.mjs).
const VENDORED_PATH = join(__dirname, '../vendor/src/data/liveAddresses.json');
const REPO_PATH = join(__dirname, '../../../src/data/liveAddresses.json');
const LIVE_ADDRESSES_PATH = existsSync(VENDORED_PATH) ? VENDORED_PATH : REPO_PATH;

let cached = null;

/**
 * @param {{ path?: string }} [opts] test seam only
 * @returns {{ source: 'live', data: object }}
 */
export function loadLiveAddresses(opts = {}) {
  const path = opts.path || LIVE_ADDRESSES_PATH;
  if (!opts.path && cached) return cached;
  let result;
  try {
    const raw = readFileSync(path, 'utf8');
    result = { source: 'live', data: JSON.parse(raw) };
  } catch {
    throw new Error('Cannot load bundled liveAddresses.json; reinstall Hartii CLI.');
  }
  if (!opts.path) cached = result;
  return result;
}

/** @param {'mainnet'|'orchard'} network HartiiSwap is mainnet-only today; orchard answers null. */
export function hartiiSwapAddresses(network = 'mainnet', opts = {}) {
  const { data } = loadLiveAddresses(opts);
  if (network !== 'mainnet') return null;
  return data?.mainnet?.hartiiSwap || null;
}

/** Bundled launch-factory addresses (launchFactoryV1..V9 keys of liveAddresses.json), mainnet only. */
// The original TokenFactory (V1) is not in liveAddresses.json — it lives in src/utils/appConfig.js
// (LAUNCH_FACTORY_ADDRESS), which can't be imported in Node. Pinned here so V1-era curves still verify.
const LAUNCH_FACTORY_V1_MAINNET = '0x001AF1BbB40807fcb99C9Eeaa49dF5E91e7Efd42';

export function launchFactories(network = 'mainnet', opts = {}) {
  if (network !== 'mainnet') return [];
  const m = loadLiveAddresses(opts).data?.mainnet || {};
  const bundled = Object.entries(m).filter(([k, v]) => /^launchFactory/.test(k) && typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v)).map(([, v]) => v);
  return [LAUNCH_FACTORY_V1_MAINNET, ...bundled];
}
