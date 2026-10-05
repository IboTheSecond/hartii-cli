import { redactUrls } from './output.js';
import { CliError } from './errors.js';
// packages/hartii-cli/src/network.js
//
// The two networks this CLI ever talks to (see the product spec HARD RULES): mainnet is the
// default, `--network orchard` is the only other option. Both RPC URLs are the zone-specific
// Cyprus-1 endpoint (ending `/cyprus1`) — same convention as packages/agent-mcp/src/config.js and
// contracts/scripts/deploy-agent-vault.cjs's own NETWORKS table, cross-checked against that file
// so this CLI never drifts from the addresses the rest of the repo deploys against.
export const NETWORKS = {
  mainnet: {
    name: 'mainnet',
    rpcUrl: 'https://rpc.quai.network/cyprus1',
    chainId: 9,
    chainIdHex: '0x9',
  },
  orchard: {
    name: 'orchard',
    rpcUrl: 'https://orchard.rpc.quai.network/cyprus1',
    chainId: 15000,
    chainIdHex: '0x3a98',
  },
};

export class NetworkError extends CliError {}

/**
 * @param {string} name 'mainnet' | 'orchard' (case-insensitive)
 * @returns {{name:string, rpcUrl:string, chainId:number, chainIdHex:string}}
 */
export function resolveNetwork(name) {
  const key = String(name || 'mainnet').toLowerCase();
  const net = NETWORKS[key];
  if (!net) throw new NetworkError(`Unknown network "${name}" — must be "mainnet" or "orchard".`);
  return net;
}

/**
 * Resolves the effective {rpcUrl, chainId, name} for this invocation: an explicit `--rpc`
 * overrides only the URL (chain id to verify against still comes from `--network`, defaulting to
 * mainnet) — this lets a user point at a private/alternate RPC for the same chain without the CLI
 * silently trusting an unverified chain id.
 * @param {{ network?: string|null, rpc?: string|null }} globals
 */
export function resolveRuntimeNetwork(globals = {}) {
  const net = resolveNetwork(globals.network || 'mainnet');
  return { ...net, rpcUrl: globals.rpc || net.rpcUrl };
}

/** One raw JSON-RPC POST, no quais dependency — just enough to read a chain id for the boot-time guard. */
async function rpcChainId(rpcUrl, method, fetchFn) {
  const res = await fetchFn(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [] }),
  });
  const json = await res.json();
  if (!json || json.error || !json.result) throw new Error(json?.error?.message || `${method} returned no result`);
  return json.result;
}

/**
 * Boot-time, key-free check that `rpcUrl` actually answers as the chain id the user's `--network`
 * selection expects before any write is attempted — a misconfigured or swapped RPC must never let
 * a send believe it's on mainnet (or vice versa). Mirrors packages/agent-mcp/src/config.js's
 * assertChainId exactly (quai_chainId, falling back to eth_chainId for a generic-EVM-shaped
 * endpoint), generalised to take the expected chain id instead of hardcoding mainnet's.
 * @param {string} rpcUrl
 * @param {number} expectedChainId
 * @param {{ fetchFn?: typeof fetch }} [deps]
 * @throws {NetworkError}
 */
export async function assertChainId(rpcUrl, expectedChainId, deps = {}) {
  const fetchFn = deps.fetchFn || fetch;
  let chainId;
  try {
    chainId = await rpcChainId(rpcUrl, 'quai_chainId', fetchFn);
  } catch {
    try {
      chainId = await rpcChainId(rpcUrl, 'eth_chainId', fetchFn);
    } catch (err) {
      throw new NetworkError(`Could not read ${redactUrls(rpcUrl)}'s chain id (${redactUrls(err?.message || 'request failed')}). Refusing to continue.`);
    }
  }
  const got = Number(chainId);
  if (got !== expectedChainId) {
    throw new NetworkError(`${redactUrls(rpcUrl)} reports chain id ${got}, expected ${expectedChainId}. Refusing to continue — check --network/--rpc.`);
  }
  return got;
}
