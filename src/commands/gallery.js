// packages/hartii-cli/src/commands/gallery.js
//
// `hartii gallery search|collection|item|trending` — read-only Hartii Gallery (NFT market) lookups from the
// Gallery's public API (hartiigallery.com/api). No wallet, no signing, no writes. Names, traits and other
// strings are third-party data.
import { searchCollections, getCollection, getItem, getTrending, parseItemRef, GalleryError } from '../galleryApi.js';
import { readRuntime } from '../commandContext.js';

export class GalleryCommandError extends GalleryError {}

const SUBS = ['search', 'collection', 'item', 'trending'];

/**
 * @param {{ sub?: string, args?: string[], limit?: string|number, days?: string|number, home?: string, network?: string, demo?: boolean }} opts
 * @param {{ fetchFn?: Function, cache?: Map, now?: any, base?: string }} [deps]
 */
export async function runGallery(opts = {}, deps = {}) {
  const sub = opts.sub;
  if (!SUBS.includes(sub)) throw new GalleryCommandError(`Usage: hartii gallery <${SUBS.join('|')}> ... — search <name|address>, collection <address|name>, item <address> <tokenId>, trending [--days n].`);
  if (opts.demo) throw new GalleryCommandError('--demo has no Gallery fixtures: these commands read the live public Gallery API. Run without --demo.');
  const { net } = readRuntime(opts, deps);
  const d = { ...deps, network: net.name };
  const args = opts.args || [];
  const num = (v) => (v === undefined ? undefined : Number(v));

  switch (sub) {
    case 'search': {
      if (!args[0]) throw new GalleryCommandError('Usage: hartii gallery search <collection name or 0x address> [--limit n]');
      return { view: 'gallery.search', ...(await searchCollections(args.join(' '), { limit: num(opts.limit) }, d)) };
    }
    case 'collection': {
      if (!args[0]) throw new GalleryCommandError('Usage: hartii gallery collection <collection address|name>');
      return { view: 'gallery.collection', ...(await getCollection(args.join(' '), d)) };
    }
    case 'item': {
      if (!args[0]) throw new GalleryCommandError('Usage: hartii gallery item <collection address> <tokenId>   (or <address>:<tokenId>)');
      const { address, tokenId } = parseItemRef(args[0], args[1]);
      return { view: 'gallery.item', ...(await getItem(address, tokenId, d)) };
    }
    default:
      return { view: 'gallery.trending', ...(await getTrending({ days: num(opts.days), limit: num(opts.limit) }, d)) };
  }
}
