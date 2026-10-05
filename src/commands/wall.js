// packages/hartii-cli/src/commands/wall.js
//
// `hartii wall engrave "<message>" [--color #hex] [--token <addr|ticker>]` · `wall stats` · `wall recent [n]`
// QuaiWallV2 "Wall of Blocks" (src/abi/quaiWallV2.js, contracts/contracts/wall/QuaiWallV2.sol). Always the
// Global Wall (id 1). The price is read live (priceOf — it climbs with every engraving) and never
// hardcoded; the call carries the live price plus a 5% headroom because another engraving can land first
// and raise it, and QuaiWallV2 refunds any excess in the same transaction.
import { Interface } from 'quais';
import { withProviderCleanup, toolsRuntime, readRuntime, writeVia } from '../commandContext.js';
import { formatAmount } from '../amount.js';
import { wallAddress, ToolError } from '../biomeAddresses.js';
import { QUAI_WALL_V2_ABI } from '../abi/hartiiTools.js';
import { view, tokenAddressOf } from '../toolKit.js';
import { createProvider } from '../signer.js';
import { PRESET_COLORS, validateMessage, hexToColor, colorToHex } from '../../vendor/src/utils/wallCurve.js';
import { DEMO_ADDRESS, DEMO_NETWORK } from '../demoFixtures.js';

export class WallError extends ToolError {}

const IFACE = new Interface(QUAI_WALL_V2_ABI);
const GLOBAL_WALL = 1n;
const ZERO = '0x0000000000000000000000000000000000000000';
const HEADROOM_PCT = 105n;

function checkMessage(message) {
  if (typeof message !== 'string' || !message) throw new WallError('Usage: hartii wall engrave "<message>" [--color #hex] [--token <addr|ticker>]');
  const v = validateMessage(message);
  if (!v.ok) throw new WallError(v.error);
}

function parseColor(input) {
  if (input === undefined || input === true) return PRESET_COLORS[0];
  const c = hexToColor(String(input));
  if (c === null || c === undefined) throw new WallError('Color must be a 6-digit hex like #7c3aed.');
  return c;
}

async function runWallCore(opts, deps = {}) {
  const sub = opts.sub || 'engrave';
  if (!['engrave', 'stats', 'recent'].includes(sub)) throw new WallError('Usage: hartii wall engrave "<message>" [--color #hex] [--token <addr|ticker>] | wall stats | wall recent [n]');

  if (opts.demo) {
    if (sub === 'engrave') {
      checkMessage(opts.message);
      return { ok: true, dryRun: true, demo: true, summary: { action: 'Wall engrave (demo)', network: DEMO_NETWORK, from: DEMO_ADDRESS, message: opts.message, color: colorToHex(parseColor(opts.color)), priceQuai: '1.0' } };
    }
    return { wall: 'Global Wall', blockCount: '412', nextPriceQuai: '21.6', engraveBaseQuai: '1.0', wallFeeQuai: '10.0', recent: [] };
  }

  if (sub === 'engrave') checkMessage(opts.message);

  if (sub !== 'engrave') {
    const { net } = readRuntime(opts, deps);
    const contract = wallAddress(net.name);
    const provider = (deps.providerFactory || createProvider)(net.rpcUrl);
    const wall = await view(provider, IFACE, contract, 'getWall', [GLOBAL_WALL]);
    const stats = await view(provider, IFACE, contract, 'stats');
    const blockCount = BigInt(wall.blockCount);
    const out = {
      contract, network: net.name, wall: wall.wall.name, blockCount: blockCount.toString(), nextPriceQuai: formatAmount(BigInt(wall.nextPrice)),
      engraveBaseQuai: formatAmount(BigInt(stats.engraveBase)), wallFeeQuai: formatAmount(BigInt(stats.wallFee)), totalEngravings: BigInt(stats.totalEngravings).toString(), totalPaidQuai: formatAmount(BigInt(stats.totalPaidWei)),
    };
    if (sub === 'recent') {
      const n = BigInt(Math.min(Math.max(Number(opts.n) || 5, 1), 50));
      const offset = blockCount > n ? blockCount - n : 0n;
      const page = await view(provider, IFACE, contract, 'engravingsPage', [GLOBAL_WALL, offset, n]);
      out.recent = page.page.map((e, i) => ({ index: (offset + BigInt(i)).toString(), author: e.author, color: colorToHex(Number(e.color)), paidQuai: formatAmount(BigInt(e.paid)), token: /^0x0{40}$/i.test(e.token) ? null : e.token, muted: Boolean(page.mutedFlags[i]), message: e.message, at: new Date(Number(e.timestamp) * 1000).toISOString() })).reverse();
    }
    return out;
  }

  const ctx = await toolsRuntime(opts, deps);
  const { net, provider } = ctx;
  const contract = wallAddress(net.name);
  const color = parseColor(opts.color);
  let token = ZERO;
  if (opts.token && opts.token !== true) {
    token = await tokenAddressOf(opts.token, deps, net.name);
  }
  const price = BigInt((await view(provider, IFACE, contract, 'priceOf', [GLOBAL_WALL]))[0]);
  if (price <= 0n) throw new WallError('The wall reported a zero price; refusing to engrave.');
  const value = (price * HEADROOM_PCT + 99n) / 100n;
  return writeVia(ctx, {
    to: contract, data: IFACE.encodeFunctionData('engrave', [GLOBAL_WALL, opts.message, color, token]), value,
    action: 'Wall engrave',
    extraSummary: { contract, wall: 'Global Wall (#1)', message: opts.message, bytes: String(Buffer.byteLength(opts.message, 'utf8')), color: colorToHex(color), promotedToken: token === ZERO ? 'none' : token, livePriceQuai: formatAmount(price), maxSentQuai: formatAmount(value), refund: 'any excess over the price at execution is refunded' },
  }, WallError);
}

export function runWall(opts = {}, deps = {}) { return withProviderCleanup(deps, (d) => runWallCore(opts, d)); }
