// packages/hartii-cli/src/galleryHuman.js
//
// Human (non-JSON) rendering for the `hartii gallery` / `hartii studio` results and the NFT holdings block of
// `hartii portfolio`. Table style matches `hartii tokens`. Every cell is third-party text and goes through safeTerminalText.
import { formatTable, safeTerminalText } from './output.js';

const text = (v) => (v === null || v === undefined || v === '' ? '—' : safeTerminalText(String(v)));
const q = (v) => (v === null || v === undefined ? '—' : `${text(v)} QUAI`);

export function nftHoldingsLines(h, colors) {
  if (!h || !Array.isArray(h.collections)) return [];
  if (!h.collections.length) return ['', 'No NFTs indexed for this address.'];
  const rows = [['NFT COLLECTION', 'COUNT', 'ADDRESS'], ...h.collections.map((c) => [text(c.name ?? 'unlisted collection'), text(c.count), text(c.address)])];
  const lines = ['', colors.bold(`${text(h.total)} NFT${h.total === 1 ? '' : 's'} (Hartii Gallery index)`), formatTable(rows)];
  if (h.truncated) lines.push('Showing the first page only; the address holds more NFTs than listed.');
  return lines;
}

/** Returns the lines for a view-tagged result, or null when `result` is not one. */
export function formatGalleryView(result, colors) {
  const v = result?.view;
  if (typeof v !== 'string') return null;
  const out = [];
  switch (v) {
    case 'studio.rooms': {
      if (!result.items.length) return [result.query ? `No studio room matches "${text(result.query)}". Try a shorter name, or list all with \`hartii studio rooms\`.` : 'No studio rooms indexed.'];
      out.push(colors.bold(`${result.items.length} of ${result.matched} room${result.matched === 1 ? '' : 's'}${result.query ? ` matching "${text(result.query)}"` : ''} (${text(result.total)} in the directory)`));
      for (const r of result.items) out.push('', text(r.text), `  ${text(r.url)}`, `  ${text(r.address)}`);
      if (result.matched > result.items.length) out.push('', `Showing ${result.items.length}; narrow the query or raise --limit (max 100).`);
      return out;
    }
    case 'studio.open':
      out.push(text(result.text), text(result.url));
      if (!result.inDirectory) out.push('Tip: `hartii studio rooms` lists the collections that have a room.');
      out.push(result.opened ? 'Opened in your browser.' : 'Add --open to launch it in your browser.');
      return out;
    case 'gallery.search': {
      if (!result.items.length && !result.tokens.length) return [`No collection matches "${text(result.query)}" (${text(result.matchedBy)}). Try another spelling or the 0x address.`];
      if (result.items.length) out.push(formatTable([['COLLECTION', 'SYMBOL', 'ADDRESS'], ...result.items.map((c) => [text(c.name), text(c.symbol), text(c.address)])]));
      if (result.tokens.length) out.push('', formatTable([['TOKEN', 'ITEM LINK'], ...result.tokens.map((t) => [text(t.name), text(t.url)])]));
      out.push('', `Matched by ${text(result.matchedBy)}. Next: hartii gallery collection <address>`);
      return out;
    }
    case 'gallery.collection': {
      out.push(colors.bold(`${text(result.name)} (${text(result.symbol)})`), text(result.address));
      out.push(`Items: ${text(result.items)} · Owners: ${text(result.owners)} · Standard: ERC-${text(result.standard)}`);
      out.push(`Floor: ${q(result.floorQuai)} · Volume 24h: ${q(result.volume24hQuai)} · Volume total: ${q(result.volumeTotalQuai)}`);
      if (result.recent.length) out.push('', formatTable([['KIND', 'TOKEN', 'PRICE · QUAI', 'WHEN'], ...result.recent.map((e) => [text(e.kind), `#${text(e.tokenId)}`, text(e.priceQuai), text(e.time)])]));
      out.push('', `Gallery: ${text(result.url)}`, `Studio room: ${text(result.studioUrl)}`);
      return out;
    }
    case 'gallery.item': {
      out.push(colors.bold(`${text(result.name ?? `#${result.tokenId}`)}${result.collectionName ? ` · ${text(result.collectionName)}` : ''}`), `${text(result.address)} #${text(result.tokenId)}`);
      out.push(`Owner: ${text(result.owner)}`);
      out.push(result.listing ? `Listed: ${q(result.listing.priceQuai)} by ${text(result.listing.seller)}${result.listing.expiresAt ? ` (until ${text(result.listing.expiresAt)})` : ''}` : result.listingError ? colors.yellow(text(result.listingError)) : 'Listed: no active listing');
      out.push(result.lastSale ? `Last sale: ${q(result.lastSale.priceQuai)} on ${text(result.lastSale.time)} (${text(result.lastSale.from)} -> ${text(result.lastSale.to)})` : 'Last sale: none in the recent history');
      if (result.traits?.length) out.push('', formatTable([['TRAIT', 'VALUE'], ...result.traits.map((t) => [text(t.trait), text(t.value)])]));
      else if (result.traitsError) out.push('', colors.yellow(text(result.traitsError)));
      out.push('', `Gallery: ${text(result.url)}`, `Studio: ${text(result.studioUrl)}`);
      return out;
    }
    case 'gallery.trending': {
      out.push(text(result.basis));
      if (!result.items.length) { out.push('', text(result.note)); return out; }
      out.push('', formatTable([['#', 'COLLECTION', 'SALES', 'VOLUME · QUAI', 'ADDRESS'], ...result.items.map((r) => [text(r.rank), text(r.name), text(r.sales), text(r.volumeQuai), text(r.address)])]));
      if (result.truncated) out.push('', 'The sample hit its 100-sale cap inside the window, so older sales in it are not counted.');
      return out;
    }
    default:
      return null;
  }
}
