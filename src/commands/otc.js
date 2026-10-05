// packages/hartii-cli/src/commands/otc.js
//
// `hartii otc create|fill|cancel|list` — HartiiOTCLink (contracts/contracts/HartiiOTCLink.sol in the
// Biome repo): zero-deposit offers of one standard fee-less ERC-20 for native QUAI. The maker approves the
// contract for the offered amount (create does this first, exact amount); the taker pays
// amountWanted + fee (feeBps, read live via quoteFill) in a single fillOffer call. Offer ids are
// sequential from 1. No partial fills, no ERC-20-for-ERC-20.
import { Interface } from 'quais';
import { withAddr } from '../output.js';
import { withProviderCleanup, toolsRuntime, readRuntime, writeVia } from '../commandContext.js';
import { resolveWalletAddress } from './balance.js';
import { assertCyprus1QuaiAddress } from '../address.js';
import { parseAmount, formatAmount } from '../amount.js';
import { biomeAddress, ToolError } from '../biomeAddresses.js';
import { HARTII_OTC_ABI } from '../abi/hartiiTools.js';
import { view, readErc20, ensureAllowance, approvalStop, tokenAddressOf } from '../toolKit.js';
import { createProvider } from '../signer.js';
import { DEMO_ADDRESS, DEMO_NETWORK, DEMO_TOKEN } from '../demoFixtures.js';

export class OtcError extends ToolError {}

const IFACE = new Interface(HARTII_OTC_ABI);
const ZERO = '0x0000000000000000000000000000000000000000';
const MAX_EXPIRY_S = 30 * 86400;
const MAX_LIST = 100;

/** "7d" | "12h" | "90m" | "none" -> seconds (0 = no expiry). Max 30 days (the contract's MAX_EXPIRY). */
export function parseExpiry(input = '7d') {
  const raw = String(input).trim().toLowerCase();
  if (raw === 'none' || raw === '0') return 0;
  const m = raw.match(/^(\d+)\s*([dhm])$/);
  if (!m) throw new OtcError('Expiry must look like 7d, 12h, 90m or none (max 30d).');
  const seconds = Number(m[1]) * { d: 86400, h: 3600, m: 60 }[m[2]];
  if (!Number.isSafeInteger(seconds) || seconds < 600) throw new OtcError('Expiry must be at least 10 minutes.');
  if (seconds > MAX_EXPIRY_S) throw new OtcError('Expiry cannot exceed 30 days.');
  return seconds;
}

function parseId(raw) {
  if (!/^[1-9]\d{0,30}$/.test(String(raw ?? ''))) throw new OtcError('Offer id must be a positive integer.');
  return BigInt(raw);
}

export function offerStatus(o, nowSec) {
  if (o.filled) return 'filled';
  if (!o.active) return 'cancelled';
  if (o.expiry !== 0n && o.expiry <= BigInt(nowSec)) return 'expired';
  return o.likelyFillable ? 'open' : 'stale-unfillable';
}

async function readOffer(provider, contract, id, tokenCache = new Map()) {
  const [o, q] = await Promise.all([view(provider, IFACE, contract, 'offers', [id]), view(provider, IFACE, contract, 'quoteFill', [id])]);
  if (/^0x0{40}$/i.test(o.maker)) return null;
  const token = assertCyprus1QuaiAddress(o.tokenOffered);
  let meta = tokenCache.get(token.toLowerCase());
  if (!meta) {
    try { meta = await readErc20(provider, token); } catch { meta = { symbol: 'Unknown', decimals: 18, balance: 0n }; }
    tokenCache.set(token.toLowerCase(), meta);
  }
  return {
    id, maker: o.maker, token, symbol: meta.symbol, decimals: meta.decimals,
    amountOffered: BigInt(o.amountOffered), amountWanted: BigInt(o.amountWanted), taker: o.takerOnly,
    expiry: BigInt(o.expiry), active: o.active, filled: o.filled,
    totalDue: BigInt(q.totalDue), fee: BigInt(q.fee), likelyFillable: q.likelyFillable,
  };
}

function offerJson(o, nowSec) {
  const priceWei = o.amountOffered > 0n ? (o.amountWanted * 10n ** BigInt(o.decimals)) / o.amountOffered : 0n;
  return {
    id: o.id.toString(), status: offerStatus(o, nowSec), maker: o.maker, token: o.token, symbol: o.symbol,
    amount: formatAmount(o.amountOffered, o.decimals), wantedQuai: formatAmount(o.amountWanted),
    priceQuaiPerToken: formatAmount(priceWei), feeQuai: formatAmount(o.fee), totalDueQuai: formatAmount(o.totalDue),
    takerOnly: /^0x0{40}$/i.test(o.taker) ? null : o.taker,
    expiresAt: o.expiry === 0n ? null : new Date(Number(o.expiry) * 1000).toISOString(),
    link: `https://hartiibiome.com/otc.html?offer=${o.id}&chain=9&v=1`,
  };
}

async function runOtcCore(opts, deps = {}) {
  const sub = opts.sub;
  if (!['create', 'fill', 'cancel', 'list'].includes(sub)) throw new OtcError('Usage: hartii otc create <token> <amount> <quai> [--taker <addr>] [--expiry 7d] | fill <id> | cancel <id> | list [--mine]');
  const nowSec = Math.floor((deps.now ? new Date(deps.now).getTime() : Date.now()) / 1000);

  if (opts.demo) {
    if (sub === 'list') return { items: [{ id: '1', status: 'open', maker: DEMO_ADDRESS, token: DEMO_TOKEN.address, symbol: DEMO_TOKEN.symbol, amount: '1000000.0', wantedQuai: '25.0', priceQuaiPerToken: '0.000025', feeQuai: '0.125', totalDueQuai: '25.125', takerOnly: null, expiresAt: null, link: 'https://hartiibiome.com/otc.html?offer=1&chain=9&v=1' }] };
    return { ok: true, dryRun: true, demo: true, summary: { action: `OTC ${sub} (demo)`, network: DEMO_NETWORK, from: DEMO_ADDRESS } };
  }

  if (sub === 'list') return listOffers(opts, deps, nowSec);

  const ctx = await toolsRuntime(opts, deps);
  const { net, provider, from } = ctx;
  const { address: contract, source } = await biomeAddress('otc', { ...deps, network: net.name });
  if (sub !== 'cancel' && (await view(provider, IFACE, contract, 'paused'))[0]) throw new OtcError('HartiiOTCLink is paused (cancel still works).');
  const write = (params, ErrorClass = OtcError) => writeVia(ctx, { to: contract, ...params }, ErrorClass);

  if (sub === 'create') {
    if (!opts.token || !opts.amount || !opts.quai) throw new OtcError('Usage: hartii otc create <token> <amount> <quai> [--taker <addr>] [--expiry 7d]');
    const token = await tokenAddressOf(opts.token, deps, net.name);
    const meta = await readErc20(provider, token, from);
    const amount = parseAmount(opts.amount, { balanceWei: meta.balance, decimals: meta.decimals }).amountWei;
    const wanted = parseAmount(opts.quai, { decimals: 18 }).amountWei;
    if (amount > meta.balance) throw new OtcError(`Insufficient ${meta.symbol}: have ${formatAmount(meta.balance, meta.decimals)}, offering ${formatAmount(amount, meta.decimals)}.`);
    const [minNotional, feeBps] = await Promise.all([view(provider, IFACE, contract, 'minOfferNotional'), view(provider, IFACE, contract, 'feeBps')]);
    if (wanted < BigInt(minNotional[0])) throw new OtcError(`Minimum offer is ${formatAmount(BigInt(minNotional[0]))} QUAI (the contract's spam floor).`);
    const taker = opts.taker ? assertCyprus1QuaiAddress(opts.taker) : ZERO;
    if (taker !== ZERO && (taker.toLowerCase() === from.toLowerCase() || taker.toLowerCase() === contract.toLowerCase())) throw new OtcError('The restricted taker cannot be you or the OTC contract.');
    const seconds = parseExpiry(opts.expiry || '7d');
    // Chain time can trail wall-clock a little; keep a margin under the contract's 30-day cap.
    const expiry = seconds === 0 ? 0 : nowSec + Math.min(seconds, MAX_EXPIRY_S - 900);
    const approval = await ensureAllowance(ctx, { token, symbol: meta.symbol, decimals: meta.decimals, spender: contract, amount, extraSummary: { plannedAction: `OTC offer ${formatAmount(amount, meta.decimals)} ${meta.symbol} for ${formatAmount(wanted)} QUAI` }, ErrorClass: OtcError });
    const stop = approvalStop(approval, { dryRun: opts.dryRun, note: 'Approval simulated only (--dry-run) — re-run without --dry-run to approve and create the offer.' });
    if (stop) return stop;
    const data = IFACE.encodeFunctionData('createOffer', [token, amount, wanted, taker, expiry]);
    const result = await write({
      data, value: 0n,
      action: `OTC offer ${withAddr(meta.symbol, token)}`,
      extraSummary: { contract, addressSource: source, offering: `${formatAmount(amount, meta.decimals)} ${withAddr(meta.symbol, token)}`, wantedQuai: formatAmount(wanted), takerFeeBps: String(feeBps[0]), takerOnly: taker === ZERO ? 'anyone' : taker, expiresAt: expiry === 0 ? 'never' : new Date(expiry * 1000).toISOString(), custody: 'tokens stay in your wallet until a taker fills; the allowance is exact' },
    });
    if (result.ok && !result.dryRun) {
      try {
        const ids = (await view(provider, IFACE, contract, 'offersByMaker', [from, 0, 500]))[0];
        if (ids.length) { result.offerId = ids[ids.length - 1].toString(); result.link = `https://hartiibiome.com/otc.html?offer=${result.offerId}&chain=9&v=1`; }
      } catch { /* best effort: the receipt is the source of truth */ }
    }
    return result;
  }

  const id = parseId(opts.id);
  const offer = await readOffer(provider, contract, id);
  if (!offer) throw new OtcError(`Offer #${id} does not exist.`);

  if (sub === 'cancel') {
    if (offer.maker.toLowerCase() !== from.toLowerCase()) throw new OtcError(`Offer #${id} was made by ${offer.maker}; only the maker can cancel it.`);
    if (!offer.active) throw new OtcError(`Offer #${id} is not active (${offerStatus(offer, nowSec)}).`);
    return write({ data: IFACE.encodeFunctionData('cancelOffer', [id]), value: 0n, action: `OTC cancel #${id}`, extraSummary: { contract, addressSource: source, offer: `${formatAmount(offer.amountOffered, offer.decimals)} ${withAddr(offer.symbol, offer.token)} for ${formatAmount(offer.amountWanted)} QUAI` } });
  }

  // fill
  const status = offerStatus(offer, nowSec);
  if (status !== 'open') throw new OtcError(`Offer #${id} is ${status}; it cannot be filled.`);
  if (offer.maker.toLowerCase() === from.toLowerCase()) throw new OtcError('You cannot fill your own offer.');
  if (!/^0x0{40}$/i.test(offer.taker) && offer.taker.toLowerCase() !== from.toLowerCase()) throw new OtcError(`Offer #${id} is restricted to ${offer.taker}.`);
  return write({
    data: IFACE.encodeFunctionData('fillOffer', [id]), value: offer.totalDue,
    action: `OTC fill #${id}`,
    extraSummary: { contract, addressSource: source, receiving: `${formatAmount(offer.amountOffered, offer.decimals)} ${withAddr(offer.symbol, offer.token)}`, token: offer.token, makerReceivesQuai: formatAmount(offer.amountWanted), serviceFeeQuai: formatAmount(offer.fee), totalDueQuai: formatAmount(offer.totalDue), maker: offer.maker },
  });
}

async function listOffers(opts, deps, nowSec) {
  const { net, home } = readRuntime(opts, deps);
  const { address: contract, source } = await biomeAddress('otc', { ...deps, network: net.name });
  const provider = (deps.providerFactory || createProvider)(net.rpcUrl);
  const limit = Math.min(Math.max(Number(opts.limit) || 25, 1), MAX_LIST);
  let ids;
  if (opts.mine) {
    const { address } = resolveWalletAddress(home, opts.wallet);
    ids = (await view(provider, IFACE, contract, 'offersByMaker', [assertCyprus1QuaiAddress(address), 0, 500]))[0].map(BigInt).reverse().slice(0, limit);
  } else {
    const count = BigInt((await view(provider, IFACE, contract, 'offerCount'))[0]);
    ids = [];
    for (let i = count; i >= 1n && ids.length < limit; i -= 1n) ids.push(i);
  }
  const cache = new Map();
  const offers = [];
  for (const id of ids) { const o = await readOffer(provider, contract, id, cache); if (o) offers.push(o); }
  const wantStatus = opts.status || (opts.mine ? 'all' : 'open');
  const items = offers.map((o) => offerJson(o, nowSec)).filter((o) => wantStatus === 'all' || o.status === wantStatus);
  return { contract, addressSource: source, network: net.name, status: wantStatus, scanned: ids.length, items };
}

export function runOtc(opts = {}, deps = {}) { return withProviderCleanup(deps, (d) => runOtcCore(opts, d)); }
