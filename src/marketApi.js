import { CliError } from './errors.js';
// packages/hartii-cli/src/marketApi.js
//
// Thin wrappers over hartiilabs.com's public read API (GET /api/tokens, GET /api/token/:addr[,
// /reference]) — the only non-RPC network hartii-cli's market/trading commands touch, per
// the product spec HARD RULES ("no network calls other than the configured RPC, hartiilabs.com /
// hartiibiome.com public APIs and the live WS"). Same `apiBase`/`fetchFn` injection convention as
// balance.js so every command stays testable without a real network.
export const API_BASE = 'https://hartiilabs.com';

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
export function assertMarketNetwork(network = 'mainnet') {
  if (network !== 'mainnet') throw new MarketError('Hartii market APIs and live feed are mainnet-only; Orchard market operations are unavailable.');
}

export class MarketError extends CliError {}

async function getJson(url, fetchFn) {
  let res;
  try {
    res = await fetchFn(url, { method: 'GET', signal: AbortSignal.timeout(12000), redirect: 'error' });
  } catch (err) {
    throw new MarketError(`Could not reach ${url}: ${err?.message || err}`);
  }
  let body;
  try {
    body = await res.json();
  } catch {
    throw new MarketError(`${url} did not return valid JSON.`);
  }
  return { status: res.status ?? 200, body };
}

/**
 * GET /api/tokens?sort=trending|new|volume&limit=&cursor= — the launchpad directory/feed.
 * @param {{ sort?: string, limit?: number, cursor?: string }} [opts]
 * @param {{ apiBase?: string, fetchFn?: typeof fetch }} [deps]
 */
export async function fetchTokens(opts = {}, deps = {}) {
  assertMarketNetwork(deps.network);
  const apiBase = deps.apiBase || API_BASE;
  const fetchFn = deps.fetchFn || fetch;
  const params = new URLSearchParams();
  if (opts.sort) params.set('sort', opts.sort);
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.cursor) params.set('cursor', opts.cursor);
  const qs = params.toString();
  const { status, body } = await getJson(`${apiBase}/api/tokens${qs ? `?${qs}` : ''}`, fetchFn);
  if (body?.partial) throw new MarketError('Market directory is partial or unavailable; retry later.');
  if (status >= 400 || body?.error || !Array.isArray(body?.items)) {
    throw new MarketError(body?.error ? `${body.error} (hartiilabs.com)` : `hartiilabs.com returned ${status}`);
  }
  return { items: Array.isArray(body?.items) ? body.items : [], nextCursor: body?.nextCursor ?? null };
}

/**
 * `tokens search <q>` — hartiilabs.com has no server-side search endpoint today, so this does the
 * sensible thing: pulls a generous page of the directory (sort=new, the only sort that doesn't
 * need the trending-score ranking cache) and filters client-side on name/symbol/address substring
 * match. Documented here as a deliberate, pragmatic default — not a real search index — rather
 * than silently pretending to be one.
 * @param {string} query
 * @param {{ apiBase?: string, fetchFn?: typeof fetch, limit?: number }} [deps]
 */
export async function searchTokens(query, deps = {}) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) throw new MarketError('Usage: hartii tokens search <query>');
  const { items } = await fetchTokens({ sort: 'new', limit: deps.limit || 100 }, deps);
  return items.filter((t) => String(t.symbol || '').toLowerCase().includes(q) || String(t.name || '').toLowerCase().includes(q) || String(t.address || '').toLowerCase() === q);
}

/**
 * GET /api/token/:addrOrTicker — the server resolves EITHER shape itself (readTokenBySymbol for a
 * non-address), so this is the one lookup every command that accepts `<addr|ticker>` goes through.
 * @param {string} addrOrTicker
 * @param {{ apiBase?: string, fetchFn?: typeof fetch }} [deps]
 * @returns {Promise<{ token: object, graduation_progress: object }>}
 */
export async function fetchToken(addrOrTicker, deps = {}) {
  assertMarketNetwork(deps.network);
  const apiBase = deps.apiBase || API_BASE;
  const fetchFn = deps.fetchFn || fetch;
  const id = String(addrOrTicker || '').trim();
  if (!id) throw new MarketError('A token address or ticker is required.');
  const { status, body } = await getJson(`${apiBase}/api/token/${encodeURIComponent(id)}`, fetchFn);
  if (status === 404 || !body?.token) {
    throw new MarketError(`Token "${id}" is not indexed on hartiilabs.com.`);
  }
  if (status >= 400) throw new MarketError(`hartiilabs.com returned ${status}`);
  if (!ADDRESS_RE.test(body.token.address)) throw new MarketError('Malformed token address.');
  if (ADDRESS_RE.test(id) && body.token.address.toLowerCase() !== id.toLowerCase()) throw new MarketError('Token response address does not match the requested address.');
  if (body.network && body.network !== 'mainnet' || body.token.network && body.token.network !== 'mainnet') throw new MarketError('Token response network mismatch.');
  return { token: body.token, graduationProgress: body.graduation_progress || null };
}

/** GET /api/token/:addr/reference — cross-venue price reference (curve + HartiiSwap pair). */
export async function fetchTokenReference(address, deps = {}) {
  assertMarketNetwork(deps.network);
  const apiBase = deps.apiBase || API_BASE;
  const fetchFn = deps.fetchFn || fetch;
  if (!ADDRESS_RE.test(String(address || ''))) throw new MarketError(`"${address}" is not a token address.`);
  const { status, body } = await getJson(`${apiBase}/api/token/${address}/reference`, fetchFn);
  if (status === 404) return null;
  if (status >= 400 || body?.error) throw new MarketError(`hartiilabs.com returned ${status}`);
  return body;
}

/**
 * Resolves a user-typed `<addr|ticker>` to the token record every buy/sell/token/tx-adjacent
 * command needs (address, symbol, curveAddress, graduated). Throws MarketError with an actionable
 * message when the token isn't indexed, or has no curve (an externally-discovered/Quainance-venue
 * token this CLI's curve-only buy/sell/tokens path does not support yet — see buy.js/sell.js).
 * @param {string} input
 * @param {{ apiBase?: string, fetchFn?: typeof fetch }} [deps]
 */
export async function resolveToken(input, deps = {}) {
  const { token } = await fetchToken(input, deps);
  return {
    address: token.address,
    symbol: token.symbol || '???',
    name: token.name || null,
    curveAddress: token.curveAddress || null,
    graduated: token.status === 'graduated',
    venue: token.venue || 'hartii',
    raw: token,
  };
}
