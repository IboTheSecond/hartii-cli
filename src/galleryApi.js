// packages/hartii-cli/src/galleryApi.js
//
// Read-only wrappers over the Hartii Gallery's PUBLIC JSON API (https://hartiigallery.com/api/...), the
// only network the `hartii gallery`, `hartii studio` commands and their MCP tools touch. Nothing here
// signs, joins a room or writes. Same `fetchFn` injection convention as marketApi.js.
//
// Routes used (all verified live 2026-11-05): /api/studio/hall-art?scope=collections, /api/studio/world?collection=,
// /api/nft/search, /api/nft/collections/:addr, /api/nft/tokens/:addr/:id, /api/nft/activity?kind=sale,
// /api/nft/owners/:addr, /api/collections (active listings), /api/meta?u= (token metadata JSON).
//
// `deps.cache` (a Map) turns on a 60 s in-memory read cache: the long-lived MCP server passes one so an
// agent re-asking the same question does not re-read the Gallery's D1 index. The one-shot CLI passes none.
// Every string that comes from the index or token metadata is third-party data and is stripped of
// terminal control characters here.
import { CliError } from './errors.js';
import { assertMarketNetwork } from './marketApi.js';
import { formatAmount } from './amount.js';
import { safeTerminalText } from './output.js';

export const GALLERY_BASE = 'https://hartiigallery.com';
export const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 200;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const TOKEN_ID_RE = /^\d{1,78}$/;
const MAX_TRAITS = 50;

export class GalleryError extends CliError {}

const FIND_HINT = 'Find the right address with `hartii gallery search <name>` (MCP: hartii_gallery_search).';

/** Third-party text: control characters out, whitespace collapsed, bounded. */
export function cleanText(value, max = 120) {
  if (value === null || value === undefined) return null;
  const s = safeTerminalText(String(value)).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

const nowMs = (deps) => (typeof deps?.now === 'function' ? Number(deps.now()) : deps?.now ? new Date(deps.now).getTime() : Date.now());
const lower = (a) => String(a).toLowerCase();
const quai = (wei) => { try { return wei === null || wei === undefined ? null : formatAmount(BigInt(wei)); } catch { return null; } };
const compact = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export const collectionUrl = (a) => `${GALLERY_BASE}/collection/${lower(a)}`;
export const itemUrl = (a, id) => `${GALLERY_BASE}/item/${lower(a)}/${id}`;
export const roomUrl = (a, tokenId = null) => (tokenId === null || tokenId === undefined ? `${GALLERY_BASE}/studio?collection=${lower(a)}` : `${GALLERY_BASE}/studio?piece=${lower(a)}:${tokenId}`);

function assertAddress(value, label = 'collection') {
  const v = String(value ?? '').trim();
  if (!ADDRESS_RE.test(v)) throw new GalleryError(`${label} must be a 0x address (42 characters), got "${cleanText(v, 60)}". ${FIND_HINT}`);
  return lower(v);
}
function assertTokenId(value) {
  const v = String(value ?? '').trim();
  if (!TOKEN_ID_RE.test(v)) throw new GalleryError(`The token id must be a plain decimal number, got "${cleanText(v, 40)}".`);
  return v;
}
function assertWindow(value, name, def, min, max) {
  if (value === undefined || value === null) return def;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new GalleryError(`${name} must be a whole number from ${min} to ${max}.`);
  return n;
}

/** GET a Gallery path (with optional 60 s cache). Throws GalleryError; a 404 carries `.status = 404`. */
export async function galleryGet(path, deps = {}, { timeoutMs = 12000 } = {}) {
  assertMarketNetwork(deps.network);
  const url = `${deps.base || GALLERY_BASE}${path}`;
  const cache = deps.cache;
  const t = nowMs(deps);
  const hit = cache?.get(url);
  if (hit && t - hit.at < CACHE_TTL_MS) return hit.body;

  const fetchFn = deps.fetchFn || fetch;
  let res;
  try {
    res = await fetchFn(url, { method: 'GET', signal: AbortSignal.timeout(timeoutMs), redirect: 'error', headers: { accept: 'application/json' } });
  } catch (err) {
    throw new GalleryError(`Could not reach hartiigallery.com: ${cleanText(err?.message || err, 160)}. Check your connection and retry.`);
  }
  let body = null;
  try { body = await res.json(); } catch { /* handled below */ }
  const status = res.status ?? 200;
  if (status >= 500) throw new GalleryError(`The Gallery index is unavailable right now (HTTP ${status}); retry in a minute.`, { status });
  if (status >= 400) throw new GalleryError(`${cleanText(body?.error, 160) || `hartiigallery.com returned HTTP ${status}`} (hartiigallery.com)`, { status });
  if (body === null || typeof body !== 'object') throw new GalleryError('hartiigallery.com did not return valid JSON; retry later.');
  if (cache) {
    if (cache.size >= CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value);
    cache.set(url, { at: t, body });
  }
  return body;
}

// ---- Studio -------------------------------------------------------------------------------------------

async function directory(deps) {
  // The directory is edge-cached (30 min) but a cold read has taken ~20 s, so it gets a longer timeout.
  const body = await galleryGet('/api/studio/hall-art?scope=collections', deps, { timeoutMs: 30000 });
  if (!Array.isArray(body.collections)) throw new GalleryError('The Studio room directory came back malformed; retry later.');
  return body;
}

function roomRow(c) {
  const pieces = Number(c.items) || 0;
  const approx = c.itemsUpperBound === true;
  const name = cleanText(c.name, 80) || 'Unnamed collection';
  return { address: lower(c.address), name, pieces, piecesApproximate: approx, url: roomUrl(c.address), text: `${name} room, ${approx ? `up to ${pieces}` : pieces} ${pieces === 1 ? 'piece' : 'pieces'}` };
}

function matchRooms(rows, query) {
  const q = String(query ?? '').trim();
  if (!q) return rows;
  if (ADDRESS_RE.test(q)) return rows.filter((r) => r.address === lower(q));
  const c = compact(q);
  const ql = q.toLowerCase();
  return rows.filter((r) => r.name.toLowerCase().includes(ql) || (c.length >= 2 && compact(r.name).includes(c)));
}

/** Studio rooms (collections with hall-eligible art): name substring (case-insensitive) or exact address. */
export async function listRooms(query, { limit } = {}, deps = {}) {
  const max = assertWindow(limit, 'limit', 25, 1, 100);
  const dir = await directory(deps);
  const rows = dir.collections.filter((c) => ADDRESS_RE.test(c.address || '')).map(roomRow);
  const matched = matchRooms(rows, query);
  return { query: query ? String(query).trim() : null, total: Number(dir.total ?? rows.length), matched: matched.length, items: matched.slice(0, max) };
}

async function resolveRoomAddress(input, deps) {
  const v = String(input ?? '').trim();
  if (!v) throw new GalleryError('A collection address or name is required. Browse with `hartii studio rooms [query]`.');
  if (ADDRESS_RE.test(v)) return lower(v);
  const { items } = await listRooms(v, { limit: 100 }, deps);
  const exact = items.filter((r) => compact(r.name) === compact(v));
  const pick = exact.length === 1 ? exact : items;
  if (pick.length === 0) throw new GalleryError(`No studio room matches "${cleanText(v, 60)}". List rooms with \`hartii studio rooms\`, or pass the collection's 0x address.`);
  if (pick.length > 1) throw new GalleryError(`"${cleanText(v, 60)}" matches ${pick.length} rooms: ${pick.slice(0, 6).map((r) => `${r.name} (${r.address})`).join(', ')}. Pass the 0x address of the one you mean.`);
  return pick[0].address;
}

/** The deep link for a collection room (or a piece in it) plus one line of text. Never joins a room. */
export async function roomLink({ collection, tokenId } = {}, deps = {}) {
  const id = tokenId === undefined || tokenId === null || tokenId === '' ? null : assertTokenId(tokenId);
  const address = await resolveRoomAddress(collection, deps);
  const world = await galleryGet(`/api/studio/world?collection=${address}`, deps);
  const dirRow = world?.collection?.inDirectory === true ? world.collection.directory : null;
  const url = roomUrl(address, id);
  if (!dirRow) {
    return { address, tokenId: id, name: null, pieces: 0, url, inDirectory: false, text: `${address} has no studio room yet (no hall-eligible art indexed); the link opens an empty room.` };
  }
  const row = roomRow(dirRow);
  const text = id === null ? row.text : `${row.name} room, piece #${id} (${plural(row.pieces, 'piece')})`;
  return { address, tokenId: id, name: row.name, pieces: row.pieces, url, inDirectory: true, text };
}

// ---- Gallery ------------------------------------------------------------------------------------------

/** Collections by name/symbol substring (server side) or exact address, with a punctuation-insensitive directory fallback. */
export async function searchCollections(query, { limit } = {}, deps = {}) {
  const raw = String(query ?? '').trim();
  if (raw.length < 2) throw new GalleryError('Search needs at least 2 characters: `hartii gallery search <name or 0x address>`.');
  const max = assertWindow(limit, 'limit', 10, 1, 10);
  const isAddr = ADDRESS_RE.test(raw);
  const q = isAddr ? lower(raw) : raw;
  const body = await galleryGet(`/api/nft/search?q=${encodeURIComponent(q)}`, deps);
  const cols = (Array.isArray(body.collections) ? body.collections : []).filter((c) => ADDRESS_RE.test(c.contract || ''));
  const toRow = (address, name, symbol) => ({ address: lower(address), name: cleanText(name, 80), symbol: cleanText(symbol, 24), url: collectionUrl(address), studioUrl: roomUrl(address) });
  const tokens = (Array.isArray(body.tokens) ? body.tokens : []).filter((t) => ADDRESS_RE.test(t.contract || '') && TOKEN_ID_RE.test(String(t.tokenId))).slice(0, 10)
    .map((t) => ({ address: lower(t.contract), tokenId: String(t.tokenId), name: cleanText(t.name, 80), url: itemUrl(t.contract, String(t.tokenId)) }));
  if (cols.length > 0 || isAddr || compact(raw).length < 2) {
    return { query: raw, matchedBy: isAddr ? 'exact address' : 'name/symbol substring', items: cols.slice(0, max).map((c) => toRow(c.contract, c.name, c.symbol)), tokens };
  }
  const dir = await directory(deps).catch(() => null);
  const fallback = dir ? matchRooms(dir.collections.filter((c) => ADDRESS_RE.test(c.address || '')).map(roomRow), raw) : [];
  return {
    query: raw, matchedBy: fallback.length ? 'normalized name (studio directory)' : 'name/symbol substring',
    items: fallback.slice(0, max).map((r) => toRow(r.address, r.name, null)), tokens,
  };
}

async function resolveCollectionAddress(input, deps) {
  const v = String(input ?? '').trim();
  if (ADDRESS_RE.test(v)) return lower(v);
  if (!v) throw new GalleryError(`A collection address or name is required. ${FIND_HINT}`);
  const { items } = await searchCollections(v, {}, deps);
  const exact = items.filter((r) => compact(r.name) === compact(v));
  const pick = exact.length === 1 ? exact : items;
  if (pick.length === 0) throw new GalleryError(`No collection matches "${cleanText(v, 60)}". ${FIND_HINT}`);
  if (pick.length > 1) throw new GalleryError(`"${cleanText(v, 60)}" matches ${pick.length} collections: ${pick.slice(0, 6).map((r) => `${r.name} (${r.address})`).join(', ')}. Pass the 0x address of the one you mean.`);
  return pick[0].address;
}

const activityRow = (e) => ({
  kind: cleanText(e.kind, 20), tokenId: e.tokenId === undefined ? null : String(e.tokenId), from: e.from || null, to: e.to || null,
  priceQuai: quai(e.priceWei), time: e.blockTime || null, txHash: e.txHash || null,
});

/** One collection: size, owners, floor, volume, recent activity. */
export async function getCollection(input, deps = {}) {
  const address = await resolveCollectionAddress(input, deps);
  let body;
  try { body = await galleryGet(`/api/nft/collections/${address}`, deps); } catch (err) {
    if (err.status === 404) throw new GalleryError(`Collection ${address} is not found in the Gallery index. ${FIND_HINT}`);
    throw err;
  }
  const c = body.collection || {};
  return {
    address, name: cleanText(c.name, 80), symbol: cleanText(c.symbol, 24), standard: c.standard ?? null,
    items: c.items ?? null, owners: c.owners ?? null,
    floorQuai: quai(c.floorWei), volume24hQuai: quai(c.vol24Wei), volumeTotalQuai: quai(c.volTotalWei), transfers: c.transfers ?? null,
    recent: (Array.isArray(body.recent) ? body.recent : []).slice(0, 10).map(activityRow),
    url: collectionUrl(address), studioUrl: roomUrl(address), indexedToBlock: body.asOfBlock ?? null,
  };
}

/** `<address> <id>` or `<address>:<id>` -> { address, tokenId }. */
export function parseItemRef(a, b) {
  let addr = a; let id = b;
  if ((id === undefined || id === null || id === '') && typeof a === 'string' && a.includes(':')) [addr, id] = a.split(':');
  if (id === undefined || id === null || id === '') throw new GalleryError('An item needs a token id: `hartii gallery item <collection address> <token id>` (or <address>:<id>).');
  return { address: assertAddress(addr), tokenId: assertTokenId(id) };
}

function readTraits(meta) {
  const attrs = Array.isArray(meta?.attributes) ? meta.attributes : [];
  return attrs.filter((a) => a && typeof a === 'object' && a.value !== undefined && a.value !== null && typeof a.value !== 'object')
    .slice(0, MAX_TRAITS).map((a) => ({ trait: cleanText(a.trait_type ?? a.name ?? 'trait', 60), value: cleanText(a.value, 120) }));
}

/** One NFT: owner, active listing, last sale, traits. Listing/traits failures degrade into *Error fields. */
export async function getItem(addressInput, tokenIdInput, deps = {}) {
  const address = assertAddress(addressInput);
  const tokenId = assertTokenId(tokenIdInput);
  let body;
  try { body = await galleryGet(`/api/nft/tokens/${address}/${tokenId}`, deps); } catch (err) {
    if (err.status === 404) throw new GalleryError(`Token ${address}:${tokenId} is not found in the Gallery index. ${FIND_HINT}`);
    throw err;
  }
  const t = body.token || {};
  const history = Array.isArray(body.history) ? body.history : [];
  const out = {
    address, tokenId, name: cleanText(t.name, 120), collectionName: cleanText(history[0]?.collectionName, 80), standard: t.standard ?? null,
    owner: t.owner ?? null, supply: t.supply ?? null, listing: null, lastSale: null, traits: null,
    url: itemUrl(address, tokenId), studioUrl: roomUrl(address, tokenId), indexedToBlock: body.asOfBlock ?? null,
  };
  const sale = history.find((e) => e.kind === 'sale' && e.priceWei);
  if (sale) out.lastSale = { priceQuai: quai(sale.priceWei), from: sale.from || null, to: sale.to || null, time: sale.blockTime || null, txHash: sale.txHash || null };

  try {
    const all = await galleryGet('/api/collections', deps);
    const t0 = nowMs(deps);
    const live = (Array.isArray(all.listings) ? all.listings : [])
      .filter((l) => lower(l.collection) === address && String(l.tokenId) === tokenId && (!Number(l.expiry) || Number(l.expiry) * 1000 > t0))
      .sort((a, b) => (BigInt(a.price) < BigInt(b.price) ? -1 : 1));
    if (live[0]) out.listing = { priceQuai: quai(live[0].price), priceWei: String(live[0].price), seller: live[0].seller || null, marketplace: live[0].marketplace || null, expiresAt: Number(live[0].expiry) ? new Date(Number(live[0].expiry) * 1000).toISOString() : null };
  } catch (err) {
    out.listingError = `Listings unavailable: ${cleanText(err.message, 140)}`;
  }

  if (typeof t.uri === 'string' && /^(ipfs|https):\/\//i.test(t.uri)) {
    try { out.traits = readTraits(await galleryGet(`/api/meta?u=${encodeURIComponent(t.uri)}`, deps)); } catch (err) {
      out.traitsError = `Traits unavailable: ${cleanText(err.message, 140)}`;
    }
  }
  return out;
}

/** Collections ranked by indexed marketplace sales in a window, then by volume. */
export async function getTrending({ days, limit } = {}, deps = {}) {
  const windowDays = assertWindow(days, 'days', 30, 1, 365);
  const max = assertWindow(limit, 'limit', 10, 1, 100);
  const body = await galleryGet('/api/nft/activity?kind=sale&limit=100', deps);
  const rows = Array.isArray(body.items) ? body.items : [];
  const cutoff = nowMs(deps) - windowDays * 86_400_000;
  const inWindow = rows.filter((s) => s.kind === 'sale' && ADDRESS_RE.test(s.contract || '') && s.priceWei && Date.parse(s.blockTime) >= cutoff);
  const byCol = new Map();
  for (const s of inWindow) {
    const k = lower(s.contract);
    const e = byCol.get(k) || { address: k, name: cleanText(s.collectionName, 80), sales: 0, volume: 0n, lastSaleTime: null };
    e.sales += 1; e.volume += BigInt(s.priceWei);
    if (!e.lastSaleTime || Date.parse(s.blockTime) > Date.parse(e.lastSaleTime)) e.lastSaleTime = s.blockTime;
    byCol.set(k, e);
  }
  const ranked = [...byCol.values()].sort((a, b) => b.sales - a.sales || (b.volume > a.volume ? 1 : b.volume < a.volume ? -1 : 0) || (a.address < b.address ? -1 : 1));
  const dayWord = plural(windowDays, 'day');
  return {
    basis: `Ranked by number of indexed marketplace sales in the last ${dayWord}, then by total sale volume in QUAI. Computed from the ${rows.length} most recent sales the Gallery index returns; it is not a floor, price-change or social ranking.`,
    windowDays, salesCounted: inWindow.length,
    truncated: rows.length >= 100 && rows.every((s) => Date.parse(s.blockTime) >= cutoff),
    items: ranked.slice(0, max).map((e, i) => ({ rank: i + 1, address: e.address, name: e.name, sales: e.sales, volumeQuai: quai(e.volume), lastSaleTime: e.lastSaleTime, url: collectionUrl(e.address) })),
    ...(ranked.length === 0 ? { note: `No indexed marketplace sales in the last ${dayWord}. Try a longer window with --days, or browse with \`hartii gallery search\`.` } : {}),
  };
}

/** Names for collection addresses: the Gallery's registered-collection list first, then (at most 10) single-collection reads. Never guessed. */
async function collectionNames(addresses, deps) {
  const names = new Map();
  try {
    for (const c of (await galleryGet('/api/collections', deps)).collections || []) if (ADDRESS_RE.test(c.address || '') && c.name) names.set(lower(c.address), cleanText(c.name, 80));
  } catch { /* fall through to single reads */ }
  for (const a of addresses.filter((x) => !names.has(x)).slice(0, 10)) {
    try { const n = cleanText((await galleryGet(`/api/nft/collections/${a}`, deps)).collection?.name, 80); if (n) names.set(a, n); } catch { /* name stays null */ }
  }
  return names;
}

/** NFTs held by an address, grouped by collection (first page of up to `limit` tokens). */
export async function getNftHoldings(ownerInput, { limit } = {}, deps = {}) {
  const owner = assertAddress(ownerInput, 'address');
  const max = assertWindow(limit, 'limit', 100, 1, 100);
  const body = await galleryGet(`/api/nft/owners/${owner}?limit=${max}`, deps);
  if (!Array.isArray(body.holdings)) throw new GalleryError('The Gallery holdings response was malformed; retry later.');
  const names = await collectionNames([...new Set(body.holdings.map((h) => String(h.contract || '').toLowerCase()).filter((a) => ADDRESS_RE.test(a)))], deps);
  const groups = new Map();
  let total = 0;
  for (const h of body.holdings) {
    if (!ADDRESS_RE.test(h.contract || '')) continue;
    const k = lower(h.contract);
    let amount = 1n; try { amount = BigInt(h.amount ?? '1'); } catch { /* keep 1 */ }
    const g = groups.get(k) || { address: k, name: names.get(k) ?? null, count: 0, tokenIds: [] };
    g.count += Number(amount); total += Number(amount);
    if (g.tokenIds.length < 20) g.tokenIds.push(String(h.tokenId));
    groups.set(k, g);
  }
  return { owner, total, truncated: Boolean(body.nextCursor), collections: [...groups.values()], indexedToBlock: body.asOfBlock ?? null };
}
