// packages/hartii-cli/src/commands/tokens.js
//
// `hartii tokens [trending|new|search <q>]` — the launchpad directory/feed, read-only (never
// needs a wallet/keystore). No subcommand defaults to `trending`, matching the product spec 
// `tokens [trending|new|search <q>]` shape (the bracket is the whole subcommand, optional).
import { fetchTokens, searchTokens } from '../marketApi.js';
import { DEMO_TOKENS_LIST } from '../demoFixtures.js';
import { readRuntime } from '../commandContext.js';
import { assertMarketNetwork } from '../marketApi.js';
import { CliError } from '../errors.js';

export class TokensError extends CliError {}

const KNOWN_SUBS = new Set(['trending', 'new', 'search']);

function slim(token) {
  return {
    address: token.address,
    symbol: token.symbol,
    name: token.name,
    status: token.status,
    curveAddress: token.curveAddress || null,
    holderCount: token.holderCount ?? null,
    volume24hWei: token.volume24hWei ?? null,
    lastPriceWei: token.lastPriceWei ?? null,
    trendingScore: token.trendingScore ?? null,
  };
}

/**
 * @param {{ sub?: string, query?: string, limit?: number, home?: string, demo?: boolean }} opts
 * @param {{ apiBase?: string, fetchFn?: typeof fetch }} [deps]
 */
export async function runTokens(opts = {}, deps = {}) {
  const sub = opts.sub || 'trending';
  if (!KNOWN_SUBS.has(sub)) {
    throw new TokensError(`Unknown \`tokens\` subcommand "${sub}". Try: trending, new, search <query>.`);
  }

  if (opts.demo) {
    if (sub === 'search') {
      const q = String(opts.query || '').toLowerCase();
      return { sort: 'search', query: opts.query, items: DEMO_TOKENS_LIST.filter((t) => t.symbol.toLowerCase().includes(q) || t.name.toLowerCase().includes(q)).map(slim) };
    }
    return { sort: sub, items: DEMO_TOKENS_LIST.map(slim), nextCursor: null };
  }

  const { net } = readRuntime(opts, deps);
  assertMarketNetwork(net.name);
  deps = { ...deps, network: net.name };
  if (sub === 'search') {
    if (!opts.query) throw new TokensError('Usage: hartii tokens search <query>');
    const items = await searchTokens(opts.query, deps);
    return { sort: 'search', query: opts.query, scope: 'first 100 newest indexed tokens', items: items.map(slim) };
  }

  const { items, nextCursor } = await fetchTokens({ sort: sub, limit: opts.limit }, deps);
  return { sort: sub, items: items.map(slim), nextCursor };
}

