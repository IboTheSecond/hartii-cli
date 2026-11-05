// packages/hartii-cli/src/commands/studio.js
//
// `hartii studio rooms [query]` and `hartii studio open <collection|name> [tokenId] [--open]` — read-only
// links into the Hartii Studio (the 3D museum at hartiigallery.com/studio). Data comes only from the
// Gallery's public API. This command never joins a room, never signs, and never needs a wallet.
// Visitor counts are NOT offered: the Gallery exposes presence only over a WebSocket join, no count endpoint.
import { listRooms, roomLink, GalleryError } from '../galleryApi.js';
import { openGalleryUrl } from '../openUrl.js';
import { readRuntime } from '../commandContext.js';

export class StudioError extends GalleryError {}

const SUBS = ['rooms', 'open'];

/**
 * @param {{ sub?: string, args?: string[], limit?: string|number, open?: boolean, home?: string, network?: string, demo?: boolean }} opts
 * @param {{ fetchFn?: Function, cache?: Map, now?: any, spawnFn?: Function, noSpawn?: boolean, base?: string }} [deps]
 */
export async function runStudio(opts = {}, deps = {}) {
  const sub = opts.sub;
  if (!SUBS.includes(sub)) throw new StudioError(`Usage: hartii studio <${SUBS.join('|')}> ... — "rooms [query]" lists collection rooms, "open <collection|name> [tokenId] [--open]" prints a room link.`);
  if (opts.demo) throw new StudioError('--demo has no Studio fixtures: these commands read the live public Gallery API. Run without --demo.');
  const { net } = readRuntime(opts, deps);
  const d = { ...deps, network: net.name };
  const args = opts.args || [];
  const limit = opts.limit === undefined ? undefined : Number(opts.limit);

  if (sub === 'rooms') return { view: 'studio.rooms', ...(await listRooms(args.join(' ') || undefined, { limit }, d)) };

  let [ref, tokenId] = args;
  if (!ref) throw new StudioError('Usage: hartii studio open <collection address|name> [tokenId] [--open]');
  const m = /^(0x[0-9a-fA-F]{40}):(\d+)$/.exec(String(ref));
  if (m && tokenId === undefined) [, ref, tokenId] = m;
  const link = await roomLink({ collection: ref, tokenId }, d);
  const opened = opts.open ? openGalleryUrl(link.url, { spawnFn: deps.spawnFn, noSpawn: deps.noSpawn }) : false;
  return { view: 'studio.open', ...link, opened };
}
