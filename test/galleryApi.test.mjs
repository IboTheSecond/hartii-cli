import { describe, it, expect, vi } from 'vitest';
import {
  GALLERY_BASE, GalleryError, galleryGet, listRooms, roomLink, searchCollections, getCollection, getItem, getTrending, getNftHoldings, parseItemRef,
} from '../src/galleryApi.js';
import { openGalleryUrl } from '../src/openUrl.js';
import * as F from './galleryFixtures.mjs';

const res = (body, status = 200) => ({ status, ok: status < 400, json: async () => body });
/** routes: { '/api/path?query': body | { status, body } | Error } — an unknown path throws so a stray call fails loudly. */
function mockFetch(routes) {
  return vi.fn(async (url) => {
    const u = String(url);
    expect(u.startsWith(GALLERY_BASE)).toBe(true);
    const key = u.slice(GALLERY_BASE.length);
    if (!(key in routes)) throw new Error(`unexpected fetch ${key}`);
    const r = routes[key];
    if (r instanceof Error) throw r;
    return r && r.__status ? res(r.body, r.__status) : res(r);
  });
}
const at = (status, body) => ({ __status: status, body });
const urls = (fetchFn) => fetchFn.mock.calls.map(([u]) => String(u).slice(GALLERY_BASE.length));

describe('galleryGet', () => {
  it('caches successful reads for 60 s and refetches after, never caching errors', async () => {
    let t = 1_000_000;
    const cache = new Map();
    const fetchFn = mockFetch({ '/api/x': { ok: 1 } });
    const deps = { fetchFn, cache, now: () => t };
    await galleryGet('/api/x', deps);
    await galleryGet('/api/x', deps);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    t += 61_000;
    await galleryGet('/api/x', deps);
    expect(fetchFn).toHaveBeenCalledTimes(2);

    const bad = mockFetch({ '/api/y': at(503, { error: 'down' }) });
    await expect(galleryGet('/api/y', { fetchFn: bad, cache, now: () => t })).rejects.toThrow(GalleryError);
    await expect(galleryGet('/api/y', { fetchFn: bad, cache, now: () => t })).rejects.toThrow(GalleryError);
    expect(bad).toHaveBeenCalledTimes(2);
  });

  it('maps a network failure and an unavailable index to actionable errors', async () => {
    await expect(galleryGet('/api/x', { fetchFn: mockFetch({ '/api/x': new Error('ECONNRESET') }) })).rejects.toThrow(/Could not reach hartiigallery\.com.*ECONNRESET/);
    await expect(galleryGet('/api/x', { fetchFn: mockFetch({ '/api/x': at(503, { error: 'index unavailable' }) }) })).rejects.toThrow(/unavailable.*retry/i);
  });

  it('refuses a non-mainnet network before any request', async () => {
    const fetchFn = mockFetch({});
    await expect(searchCollections('youkai', {}, { fetchFn, network: 'orchard' })).rejects.toThrow(/mainnet-only/);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('studio rooms and links', () => {
  const dir = { '/api/studio/hall-art?scope=collections': F.DIRECTORY };

  it('lists rooms from the directory by name substring (case-insensitive), with one line of text and a deep link each', async () => {
    const r = await listRooms('YOUKAI', {}, { fetchFn: mockFetch(dir) });
    expect(r.items).toEqual([{ address: F.YOUKAI, name: 'Fanged Youkai', pieces: 960, piecesApproximate: false, url: `https://hartiigallery.com/studio?collection=${F.YOUKAI}`, text: 'Fanged Youkai room, 960 pieces' }]);
  });

  it('matches an exact address in any case and respects limit; no query lists the directory', async () => {
    const byAddr = await listRooms(F.YOUKAI.toUpperCase().replace('0X', '0x'), {}, { fetchFn: mockFetch(dir) });
    expect(byAddr.items.map((i) => i.name)).toEqual(['Fanged Youkai']);
    const all = await listRooms(undefined, { limit: 2 }, { fetchFn: mockFetch(dir) });
    expect(all.items).toHaveLength(2);
    expect(all.total).toBe(4);
  });

  it('builds a collection link with the room name and piece count from the world endpoint', async () => {
    const fetchFn = mockFetch({ [`/api/studio/world?collection=${F.YOUKAI}`]: F.WORLD_YOUKAI });
    const r = await roomLink({ collection: F.YOUKAI.toUpperCase().replace('0X', '0x') }, { fetchFn });
    expect(r).toMatchObject({ address: F.YOUKAI, tokenId: null, name: 'Fanged Youkai', url: `https://hartiigallery.com/studio?collection=${F.YOUKAI}`, text: 'Fanged Youkai room, 960 pieces', inDirectory: true });
  });

  it('builds a piece link', async () => {
    const fetchFn = mockFetch({ [`/api/studio/world?collection=${F.YOUKAI}`]: F.WORLD_YOUKAI });
    const r = await roomLink({ collection: F.YOUKAI, tokenId: '5' }, { fetchFn });
    expect(r.url).toBe(`https://hartiigallery.com/studio?piece=${F.YOUKAI}:5`);
    expect(r.text).toBe('Fanged Youkai room, piece #5 (960 pieces)');
  });

  it('says plainly when a collection has no room yet', async () => {
    const fetchFn = mockFetch({ [`/api/studio/world?collection=${F.NOROOM}`]: F.WORLD_NOROOM });
    const r = await roomLink({ collection: F.NOROOM }, { fetchFn });
    expect(r.inDirectory).toBe(false);
    expect(r.text).toMatch(/no hall-eligible art/i);
    expect(r.url).toBe(`https://hartiigallery.com/studio?collection=${F.NOROOM}`);
  });

  it('resolves a collection name through the directory, and refuses an ambiguous or unknown one', async () => {
    const fetchFn = mockFetch({ ...dir, [`/api/studio/world?collection=${F.YOUKAI}`]: F.WORLD_YOUKAI });
    expect((await roomLink({ collection: 'fanged youkai' }, { fetchFn })).address).toBe(F.YOUKAI);
    await expect(roomLink({ collection: 'quai' }, { fetchFn })).rejects.toThrow(/matches 2 rooms.*Quai Miners.*Quai Club/s);
    await expect(roomLink({ collection: 'zzzz' }, { fetchFn })).rejects.toThrow(/No studio room matches "zzzz".*hartii studio rooms/s);
  });

  it('rejects a bad token id before any request', async () => {
    const fetchFn = mockFetch({});
    await expect(roomLink({ collection: F.YOUKAI, tokenId: '-1' }, { fetchFn })).rejects.toThrow(/token id/i);
    await expect(roomLink({ collection: F.YOUKAI, tokenId: '1e3' }, { fetchFn })).rejects.toThrow(/token id/i);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('collection search', () => {
  it('asks the Gallery index (name/symbol substring, or exact address) and returns links', async () => {
    const fetchFn = mockFetch({ '/api/nft/search?q=youkai': F.SEARCH_YOUKAI });
    const r = await searchCollections('youkai', {}, { fetchFn });
    expect(r.items).toEqual([{ address: F.YOUKAI, name: 'Fanged Youkai', symbol: 'FGYK', url: `https://hartiigallery.com/collection/${F.YOUKAI}`, studioUrl: `https://hartiigallery.com/studio?collection=${F.YOUKAI}` }]);
    expect(r.tokens[0]).toMatchObject({ address: F.YOUKAI, tokenId: '5', name: 'Fanged Youkai 5', url: `https://hartiigallery.com/item/${F.YOUKAI}/5` });
  });

  it('lowercases an address query so the match is exact', async () => {
    const fetchFn = mockFetch({ [`/api/nft/search?q=${F.YOUKAI}`]: { ...F.SEARCH_YOUKAI, tokens: [] } });
    const r = await searchCollections(F.YOUKAI.toUpperCase().replace('0X', '0x'), {}, { fetchFn });
    expect(r.items).toHaveLength(1);
  });

  it('falls back to a punctuation/space-insensitive directory match when the index finds nothing', async () => {
    const fetchFn = mockFetch({ '/api/nft/search?q=fanged-youkai': F.SEARCH_EMPTY, '/api/studio/hall-art?scope=collections': F.DIRECTORY });
    const r = await searchCollections('fanged-youkai', {}, { fetchFn });
    expect(r.items.map((i) => i.address)).toEqual([F.YOUKAI]);
    expect(r.matchedBy).toBe('normalized name (studio directory)');
  });

  it('rejects a query shorter than two characters with a hint, without a request', async () => {
    const fetchFn = mockFetch({});
    await expect(searchCollections('a', {}, { fetchFn })).rejects.toThrow(/at least 2 characters/);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('collection detail', () => {
  it('summarises stats, QUAI amounts, recent activity and both links', async () => {
    const fetchFn = mockFetch({ [`/api/nft/collections/${F.YOUKAI}`]: F.COLLECTION_YOUKAI });
    const r = await getCollection(F.YOUKAI, { fetchFn });
    expect(r).toMatchObject({ address: F.YOUKAI, name: 'Fanged Youkai', symbol: 'FGYK', standard: '721', items: 1471, owners: 1329, floorQuai: '2.5', volume24hQuai: '0.0', volumeTotalQuai: '4.0', indexedToBlock: 10980962 });
    expect(r.recent[0]).toMatchObject({ kind: 'sale', tokenId: '7', priceQuai: '1.5', time: '2026-10-01T10:00:00.000Z' });
    expect(r.recent[1].priceQuai).toBeNull();
    expect(r.url).toBe(`https://hartiigallery.com/collection/${F.YOUKAI}`);
    expect(r.studioUrl).toBe(`https://hartiigallery.com/studio?collection=${F.YOUKAI}`);
  });

  it('resolves a unique name through search; a 404 tells you how to search', async () => {
    const fetchFn = mockFetch({ '/api/nft/search?q=youkai': F.SEARCH_YOUKAI, [`/api/nft/collections/${F.YOUKAI}`]: F.COLLECTION_YOUKAI, [`/api/nft/collections/${F.NOROOM}`]: at(404, { error: 'collection not found in the index' }) });
    expect((await getCollection('youkai', { fetchFn })).address).toBe(F.YOUKAI);
    await expect(getCollection(F.NOROOM, { fetchFn })).rejects.toThrow(/not found in the Gallery index.*hartii gallery search/s);
  });
});

describe('item detail', () => {
  const metaUrl = `/api/meta?u=${encodeURIComponent(F.TOKEN_YOUKAI_5.token.uri)}`;
  const base = (extra = {}) => ({ [`/api/nft/tokens/${F.YOUKAI}/5`]: F.TOKEN_YOUKAI_5, '/api/collections': F.COLLECTIONS_FULL, [metaUrl]: F.META_YOUKAI_5, ...extra });

  it('returns owner, active listing, last sale and traits', async () => {
    const r = await getItem(F.YOUKAI, '5', { fetchFn: mockFetch(base()), now: () => Date.parse('2026-11-05T00:00:00Z') });
    expect(r).toMatchObject({ address: F.YOUKAI, tokenId: '5', name: 'Fanged Youkai 5', collectionName: 'Fanged Youkai', standard: '721', owner: F.OWNER, url: `https://hartiigallery.com/item/${F.YOUKAI}/5`, studioUrl: `https://hartiigallery.com/studio?piece=${F.YOUKAI}:5` });
    expect(r.listing).toMatchObject({ priceQuai: '3.0', priceWei: '3000000000000000000', seller: F.WALLET, expiresAt: null });
    expect(r.lastSale).toMatchObject({ priceQuai: '1.5', from: F.WALLET, to: F.OWNER, time: '2026-10-02T10:00:00.000Z', txHash: `0x${'33'.repeat(32)}` });
    expect(r.traits).toEqual([{ trait: 'Background', value: 'PurpleTooth' }, { trait: 'Skull', value: 'Cracked' }, { trait: 'Level', value: '7' }]);
  });

  it('ignores an expired listing and reports no listing / no sale as null', async () => {
    const fetchFn = mockFetch(base({
      [`/api/nft/tokens/${F.YOUKAI}/9`]: { ...F.TOKEN_YOUKAI_5, token: { ...F.TOKEN_YOUKAI_5.token, tokenId: '9', uri: null }, history: [] },
    }));
    const r = await getItem(F.YOUKAI, '9', { fetchFn, now: () => Date.parse('2026-11-05T00:00:00Z') });
    expect(r.listing).toBeNull(); // listing 3 expired at unix 1
    expect(r.lastSale).toBeNull();
    expect(r.traits).toBeNull();
  });

  it('degrades, not fails, when listings or traits cannot be read', async () => {
    const fetchFn = mockFetch(base({ '/api/collections': at(503, { error: 'x' }), [metaUrl]: new Error('timeout') }));
    const r = await getItem(F.YOUKAI, '5', { fetchFn });
    expect(r.owner).toBe(F.OWNER);
    expect(r.listing).toBeNull();
    expect(r.listingError).toMatch(/listings unavailable/i);
    expect(r.traits).toBeNull();
    expect(r.traitsError).toMatch(/traits unavailable/i);
  });

  it('caps and strips trait text', async () => {
    const evil = { attributes: [{ trait_type: 'A\u001b[2J', value: 'x'.repeat(500) }, ...Array.from({ length: 80 }, (_, i) => ({ trait_type: `t${i}`, value: 'v' }))] };
    const r = await getItem(F.YOUKAI, '5', { fetchFn: mockFetch(base({ [metaUrl]: evil })) });
    expect(r.traits).toHaveLength(50);
    expect(r.traits[0].trait).not.toMatch(/\u001b/);
    expect(r.traits[0].value.length).toBeLessThanOrEqual(120);
  });

  it('a 404 says the token is not in the index; a bad id is rejected locally', async () => {
    const fetchFn = mockFetch({ [`/api/nft/tokens/${F.YOUKAI}/99999`]: at(404, { error: 'token not found in the index' }) });
    await expect(getItem(F.YOUKAI, '99999', { fetchFn })).rejects.toThrow(/not found in the Gallery index/);
    await expect(getItem(F.YOUKAI, 'abc', { fetchFn })).rejects.toThrow(/token id/i);
    await expect(getItem('nope', '1', { fetchFn })).rejects.toThrow(/0x/);
  });

  it('parseItemRef accepts "addr id" and "addr:id"', () => {
    expect(parseItemRef(F.YOUKAI, '5')).toEqual({ address: F.YOUKAI, tokenId: '5' });
    expect(parseItemRef(`${F.YOUKAI}:12`)).toEqual({ address: F.YOUKAI, tokenId: '12' });
    expect(() => parseItemRef(F.YOUKAI)).toThrow(/token id/i);
  });
});

describe('trending', () => {
  const route = { '/api/nft/activity?kind=sale&limit=100': F.SALES };
  const now = () => Date.parse('2026-11-05T12:00:00Z');

  it('ranks collections by sales count then volume over the window, and states the basis', async () => {
    const r = await getTrending({ days: 30 }, { fetchFn: mockFetch(route), now });
    expect(r.basis).toMatch(/indexed marketplace sales/i);
    expect(r.windowDays).toBe(30);
    expect(r.salesCounted).toBe(3);
    expect(r.items.map((i) => [i.rank, i.name, i.sales, i.volumeQuai])).toEqual([[1, 'Fanged Youkai', 2, '3.0'], [2, 'Quai Miners', 1, '9.0']]);
    expect(r.items[0]).toMatchObject({ address: F.YOUKAI, lastSaleTime: '2026-11-03T10:00:00.000Z', url: `https://hartiigallery.com/collection/${F.YOUKAI}` });
  });

  it('breaks a sales-count tie by volume and honours limit', async () => {
    const r = await getTrending({ days: 365, limit: 1 }, { fetchFn: mockFetch(route), now });
    expect(r.items).toHaveLength(1);
    const t = await getTrending({ days: 365 }, { fetchFn: mockFetch(route), now });
    expect(t.items.map((i) => i.name)).toEqual(['Fanged Youkai', 'Quai Miners', 'Foxe']);
  });

  it('reports an empty window honestly instead of inventing a ranking', async () => {
    const r = await getTrending({ days: 1 }, { fetchFn: mockFetch(route), now });
    expect(r.items).toEqual([]);
    expect(r.note).toMatch(/no indexed marketplace sales in the last 1 day/i);
  });

  it('rejects out-of-range days and limit', async () => {
    await expect(getTrending({ days: 0 }, { fetchFn: mockFetch(route) })).rejects.toThrow(/days/);
    await expect(getTrending({ limit: 101 }, { fetchFn: mockFetch(route) })).rejects.toThrow(/limit/);
  });
});

describe('NFT holdings by owner', () => {
  it('groups holdings by collection with names from the registered list, then single-collection reads', async () => {
    const fetchFn = mockFetch({
      [`/api/nft/owners/${F.WALLET}?limit=100`]: F.OWNERS_PAGE,
      '/api/collections': F.COLLECTIONS_FULL, // names Foxe
      [`/api/nft/collections/${F.YOUKAI}`]: F.COLLECTION_YOUKAI, // names the one the list lacks
    });
    const r = await getNftHoldings(F.WALLET, {}, { fetchFn });
    expect(r.total).toBe(3);
    expect(r.truncated).toBe(false);
    expect(r.collections).toEqual([
      { address: F.FOXE, name: 'Foxe', count: 2, tokenIds: ['0', '3'] },
      { address: F.YOUKAI, name: 'Fanged Youkai', count: 1, tokenIds: ['5'] },
    ]);
  });

  it('flags a truncated page and survives unreadable name sources', async () => {
    const fetchFn = mockFetch({
      [`/api/nft/owners/${F.WALLET}?limit=100`]: { ...F.OWNERS_PAGE, nextCursor: `${F.YOUKAI}:5` },
      '/api/collections': at(503, { error: 'x' }),
    });
    const r = await getNftHoldings(F.WALLET, {}, { fetchFn });
    expect(r.truncated).toBe(true);
    expect(r.collections.map((c) => c.name)).toEqual([null, null]); // names come only from the Gallery; never guessed
  });
});

describe('openGalleryUrl', () => {
  it('launches only https://hartiigallery.com/ URLs', () => {
    const spawnFn = vi.fn(() => ({ unref() {} }));
    expect(openGalleryUrl(`https://hartiigallery.com/studio?collection=${F.YOUKAI}`, { spawnFn, platform: 'win32' })).toBe(true);
    expect(spawnFn).toHaveBeenCalledWith('cmd', ['/c', 'start', '', `https://hartiigallery.com/studio?collection=${F.YOUKAI}`], expect.anything());
    for (const bad of ['http://hartiigallery.com/studio', 'https://hartiigallery.com.evil.com/studio', 'https://evil.com/?https://hartiigallery.com/', 'file:///etc/passwd', 'https://hartiigallery.com/studio?a=1&calc=2']) {
      expect(() => openGalleryUrl(bad, { spawnFn, platform: 'win32' }), bad).toThrow(/hartiigallery\.com/);
    }
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });

  it('uses open / xdg-open elsewhere and never spawns when noSpawn is set', () => {
    const spawnFn = vi.fn(() => ({ unref() {} }));
    openGalleryUrl('https://hartiigallery.com/studio', { spawnFn, platform: 'darwin' });
    expect(spawnFn.mock.calls[0][0]).toBe('open');
    openGalleryUrl('https://hartiigallery.com/studio', { spawnFn, platform: 'linux' });
    expect(spawnFn.mock.calls[1][0]).toBe('xdg-open');
    expect(openGalleryUrl('https://hartiigallery.com/studio', { spawnFn, noSpawn: true })).toBe(false);
    expect(spawnFn).toHaveBeenCalledTimes(2);
  });
});
