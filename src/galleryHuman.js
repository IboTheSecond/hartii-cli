// packages/hartii-cli/src/galleryHuman.js
//
// Human (non-JSON) rendering for the `hartii gallery` / `hartii studio` results and the NFT holdings block of
// `hartii portfolio`. Same look as every other view (screenKit). Every cell is third-party text and goes through
// safeTerminalText.
import { safeTerminalText } from './output.js';
import { makeKit } from './screenKit.js';
import * as F from './format.js';

const text = (v) => (v === null || v === undefined || v === '' ? '—' : safeTerminalText(String(v)));
const q = (v) => (v === null || v === undefined || v === '' ? '—' : F.quaiDecimal(String(v)));
const when = (v) => (v === null || v === undefined || v === '' ? '—' : F.time(v));

/** NFT holdings block as lines, for a kit. */
export function nftLinesFor(h, K) {
  if (!h || !Array.isArray(h.collections)) return [];
  if (!h.collections.length) return ['', K.t.muted('No NFTs indexed for this address.')];
  const out = [...K.section(`${F.count(h.total)} NFT${h.total === 1 ? '' : 's'}  ${K.t.muted('Hartii Gallery index')}`), '', ...K.table([
    { title: 'COLLECTION', flex: true, get: (c) => text(c.name ?? 'unlisted collection') },
    { title: 'COUNT', align: 'r', get: (c) => F.count(c.count) },
    { title: 'ADDRESS', priority: 1, bare: true, get: (c) => text(c.address), style: (s) => K.t.muted(s) },
  ], h.collections)];
  if (h.truncated) out.push('', K.t.muted('Showing the first page only; the address holds more NFTs than listed.'));
  return out;
}

/** Back-compat helper (colours object instead of a kit). */
export function nftHoldingsLines(h, colors, { width = 80 } = {}) {
  return nftLinesFor(h, makeKit({ colors, width }));
}

/** Returns the lines for a view-tagged result, or null when `result` is not one. */
export function formatGalleryView(result, colors, { width = 80, terse = false } = {}) {
  const v = result?.view;
  if (typeof v !== 'string' || !/^(gallery|studio)\./.test(v)) return null;
  const K = makeKit({ colors, width, terse });
  const out = [];
  const url = (u) => K.t.accentBright(text(u));
  switch (v) {
    case 'studio.rooms': {
      if (!result.items.length) return K.frame([result.query ? `No studio room matches "${text(result.query)}". Try a shorter name, or list all with \`hartii studio rooms\`.` : 'No studio rooms indexed.']);
      if (terse) return result.items.map((r) => `${text(r.text)}  ${text(r.url)}`);
      out.push(...K.heading('Studio rooms', `${result.items.length} of ${result.matched}${result.query ? ` matching "${text(result.query)}"` : ''} · ${text(result.total)} in the directory`));
      for (const r of result.items) out.push('', K.t.bold(K.t.text(text(r.text))), `  ${url(r.url)}`, `  ${K.t.muted(text(r.address))}`);
      if (result.matched > result.items.length) out.push('', K.t.muted(`Showing ${result.items.length}; narrow the query or raise --limit (max 100).`));
      return K.frame(out);
    }
    case 'studio.open':
      if (terse) return [text(result.url)];
      out.push(...K.heading('Studio room'), '', K.t.bold(K.t.text(text(result.text))), url(result.url));
      if (!result.inDirectory) out.push('', K.t.muted('Tip: `hartii studio rooms` lists the collections that have a room.'));
      out.push('', result.opened ? 'Opened in your browser.' : K.t.muted('Add --open to launch it in your browser.'));
      return K.frame(out);
    case 'gallery.search': {
      if (!result.items.length && !result.tokens.length) return K.frame([`No collection matches "${text(result.query)}" (${text(result.matchedBy)}). Try another spelling or the 0x address.`]);
      if (terse) return [...result.items.map((c) => `${text(c.name)} ${text(c.symbol)} ${text(c.address)}`), ...result.tokens.map((t) => `${text(t.name)} ${text(t.url)}`)];
      out.push(...K.heading('Gallery search', `"${text(result.query)}" · matched by ${text(result.matchedBy)}`), '');
      if (result.items.length) out.push(...K.table([
        { title: 'COLLECTION', flex: true, get: (c) => text(c.name) },
        { title: 'SYMBOL', get: (c) => text(c.symbol) },
        { title: 'ADDRESS', priority: 1, bare: true, get: (c) => text(c.address), style: (s) => K.t.muted(s) },
      ], result.items));
      if (result.tokens.length) out.push('', ...K.table([
        { title: 'TOKEN', flex: true, get: (t) => text(t.name) },
        { title: 'ITEM LINK', priority: 1, get: (t) => text(t.url), style: (s) => K.t.accentBright(s) },
      ], result.tokens));
      out.push('', K.t.muted('Next: ') + K.command('hartii gallery collection <address>'));
      return K.frame(out);
    }
    case 'gallery.collection': {
      if (terse) return [`${text(result.name)} (${text(result.symbol)}) · floor ${q(result.floorQuai)} · ${F.count(result.items)} items`];
      out.push(...K.heading(`${text(result.name)}`, text(result.symbol)), '', ...K.kv([
        ['Address', text(result.address)],
        ['Items', F.count(result.items)], ['Owners', F.count(result.owners)], ['Standard', `ERC-${text(result.standard)}`],
        ['Floor', q(result.floorQuai)], ['Volume 24h', q(result.volume24hQuai)], ['Volume total', q(result.volumeTotalQuai)],
      ]));
      if (result.recent.length) out.push(...K.section('Recent activity'), '', ...K.table([
        { title: 'KIND', get: (e) => text(e.kind) },
        { title: 'TOKEN', align: 'r', get: (e) => `#${text(e.tokenId)}` },
        { title: 'PRICE (QUAI)', align: 'r', get: (e) => (e.priceQuai == null ? '—' : F.fromDecimal(String(e.priceQuai))) },
        { title: 'WHEN', get: (e) => (e.time == null ? '—' : F.relativeTime(e.time)), style: (s) => K.t.muted(s) },
      ], result.recent));
      out.push('', ...K.kv([['Gallery', url(result.url)], ['Studio room', url(result.studioUrl)]]));
      return K.frame(out);
    }
    case 'gallery.item': {
      const title = `${text(result.name ?? `#${result.tokenId}`)}`;
      if (terse) return [`${title}${result.collectionName ? ` · ${text(result.collectionName)}` : ''} · ${result.listing ? `listed ${q(result.listing.priceQuai)}` : 'not listed'}`];
      out.push(...K.heading(title, result.collectionName ? text(result.collectionName) : undefined), '', ...K.kv([
        ['Collection', text(result.address)],
        ['Token', `#${text(result.tokenId)}`],
        ['Owner', text(result.owner)],
        ['Listing', result.listing ? `${q(result.listing.priceQuai)} by ${F.shortAddress(result.listing.seller)}${result.listing.expiresAt ? ` (until ${F.absoluteTime(result.listing.expiresAt)})` : ''}` : result.listingError ? K.t.warn(text(result.listingError)) : K.t.muted('no active listing')],
        ['Last sale', result.lastSale ? `${q(result.lastSale.priceQuai)} · ${when(result.lastSale.time)}` : K.t.muted('none in the recent history')],
      ]));
      if (result.traits?.length) out.push(...K.section('Traits'), '', ...K.table([{ title: 'TRAIT', get: (t) => text(t.trait) }, { title: 'VALUE', get: (t) => text(t.value) }], result.traits));
      else if (result.traitsError) out.push('', K.t.warn(text(result.traitsError)));
      out.push('', ...K.kv([['Gallery', url(result.url)], ['Studio', url(result.studioUrl)]]));
      return K.frame(out);
    }
    case 'gallery.trending': {
      if (terse) return (result.items || []).map((r) => `${text(r.rank)}. ${text(r.name)} · ${F.count(r.sales)} sales · ${q(r.volumeQuai)}`);
      out.push(...K.heading('Gallery trending'), '', K.t.muted(text(result.basis)));
      if (!result.items.length) { out.push('', text(result.note)); return K.frame(out); }
      out.push('', ...K.table([
        { title: '#', align: 'r', get: (r) => text(r.rank) },
        { title: 'COLLECTION', flex: true, get: (r) => text(r.name), style: (s) => K.t.text(s) },
        { title: 'SALES', align: 'r', get: (r) => F.count(r.sales) },
        { title: 'VOLUME (QUAI)', align: 'r', get: (r) => (r.volumeQuai == null ? '—' : F.fromDecimal(String(r.volumeQuai))) },
        { title: 'ADDRESS', priority: 1, bare: true, get: (r) => text(r.address), style: (s) => K.t.muted(s) },
      ], result.items));
      if (result.truncated) out.push('', K.t.muted('The sample hit its 100-sale cap inside the window, so older sales in it are not counted.'));
      return K.frame(out);
    }
    default:
      return null;
  }
}
