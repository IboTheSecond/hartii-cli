// packages/hartii-cli/src/biomeAddresses.js
//
// Addresses of the Hartii Biome tool contracts (Airdrop / OTC Link / Claim). Per the spec:
// read https://hartiibiome.com/live-addresses.json `mainnet.*` at runtime, falling back to the
// bundled snapshot (src/data/biomeLiveAddresses.json, copied from the Biome repo's own file) when
// the site is unreachable or answers anything malformed. The source ('live'|'bundled') is always
// reported so a human can see which one signed off on the destination. The Wall is NOT here: it is
// this repo's own src/data/liveAddresses.json `mainnet.wall.address` (see wallAddress()).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { assertCyprus1QuaiAddress } from './address.js';
import { loadLiveAddresses } from './liveAddresses.js';
import { CliError } from './errors.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const BIOME_LIVE_ADDRESSES_URL = 'https://hartiibiome.com/live-addresses.json';
const KEYS = { airdrop: 'hartiiAirdrop', otc: 'hartiiOtcLink', claim: 'hartiiClaim' };

export class ToolError extends CliError {}

function bundled() {
  return JSON.parse(readFileSync(join(__dirname, 'data/biomeLiveAddresses.json'), 'utf8'));
}

function pick(doc, key) {
  const v = doc?.mainnet?.[key];
  if (typeof v !== 'string') return null;
  try { return assertCyprus1QuaiAddress(v); } catch { return null; }
}

/**
 * @param {'airdrop'|'otc'|'claim'} tool
 * @param {{ network?: string, fetchFn?: typeof fetch }} [deps]
 * @returns {Promise<{ address: string, source: 'live'|'bundled' }>}
 */
export async function biomeAddress(tool, deps = {}) {
  assertToolsNetwork(deps.network);
  const key = KEYS[tool];
  if (!key) throw new ToolError(`Unknown Hartii tool "${tool}".`);
  // The BUNDLED address is authoritative. The live file may only confirm it; a different live
  // address is refused (a compromised site must never be able to redirect approvals/funds).
  const snap = pick(bundled(), key);
  let live = null;
  if (deps.fetchFn !== false) {
    try {
      const fetchFn = deps.fetchFn || fetch;
      const res = await fetchFn(BIOME_LIVE_ADDRESSES_URL, { method: 'GET', signal: AbortSignal.timeout(8000), redirect: 'error' });
      if ((res.status ?? 200) < 400) live = pick(await res.json(), key);
    } catch { /* unreachable or malformed: the bundled snapshot stands */ }
  }
  if (live && live.toLowerCase() !== String(snap || '').toLowerCase()) {
    if (deps.trustLiveAddresses === true) return { address: live, source: 'live (UNVERIFIED, --trust-live-addresses)' };
    throw new ToolError(`hartiibiome.com now publishes a different ${tool} address (${live}) than this CLI's bundled one${snap ? ` (${snap})` : ''}. Refusing to use it: update the Hartii CLI. Humans may override once with --trust-live-addresses after verifying the address themselves.`);
  }
  if (!snap) throw new ToolError(`${tool} is not deployed on mainnet yet (no address published).`);
  return { address: snap, source: live ? 'live' : 'bundled' };
}

export function wallAddress(network = 'mainnet') {
  assertToolsNetwork(network);
  const a = loadLiveAddresses().data?.mainnet?.wall?.address;
  if (!a) throw new ToolError('The Wall of Blocks is not deployed (no address in liveAddresses.json).');
  return assertCyprus1QuaiAddress(a);
}

export function assertToolsNetwork(network = 'mainnet') {
  if (network !== 'mainnet') throw new ToolError('Hartii Airdrop / OTC / Claim / Wall are mainnet-only; Orchard is not supported for these tools.');
}
