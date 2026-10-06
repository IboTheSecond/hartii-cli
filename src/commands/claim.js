// packages/hartii-cli/src/commands/claim.js
//
// `hartii claim list [--mine|--creator <addr>]` · `hartii claim <campaignId> [--check]` — HartiiClaim
// Merkle campaigns (contracts/contracts/HartiiClaim.sol in the Biome repo; leaf/proof format from
// claimCore.mjs). The campaign's leaves file is fetched from its metadataURI (empty / "/…" means the
// hartiibiome.com hosted endpoint /api/claims/leaves/<root>), RE-HASHED here and rejected unless its
// Merkle root, leaf count and total equal the on-chain campaign — so a wrong or hostile leaves host can
// only ever make a claim fail, never mis-pay one. One claim call claims the caller's next unclaimed leaf.
import { Interface, keccak256, solidityPacked } from 'quais';
import { withAddr } from '../output.js';
import { withProviderCleanup, writeRuntime, readRuntime, resolveSender, writeVia } from '../commandContext.js';
import { assertCyprus1QuaiAddress } from '../address.js';
import { formatAmount } from '../amount.js';
import { biomeAddress, ToolError, assertToolsNetwork } from '../biomeAddresses.js';
import { HARTII_CLAIM_ABI } from '../abi/hartiiTools.js';
import { view, pagedIds, readErc20 } from '../toolKit.js';
import { createProvider } from '../signer.js';
import { DEMO_ADDRESS, DEMO_NETWORK } from '../demoFixtures.js';

export class ClaimError extends ToolError {}

const IFACE = new Interface(HARTII_CLAIM_ABI);
const MAX_LEAVES = 50_000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const HOSTED_LEAVES = 'https://hartiibiome.com/api/claims/leaves/';
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;

/** Campaign ids are keccak outputs: accept decimal or 0x hex, return a bigint. */
export function parseCampaignId(raw) {
  const s = String(raw ?? '').trim();
  if (/^\d{1,78}$/.test(s)) return BigInt(s);
  if (/^0x[0-9a-fA-F]{1,64}$/.test(s)) return BigInt(s);
  throw new ClaimError('Campaign id must be a decimal or 0x-hex integer.');
}

// ---- Merkle (byte-compatible with HartiiClaim._claim and Biome's claimCore.mjs) ----
export function leafHash(id, index, account, amount) {
  return keccak256(solidityPacked(['uint256', 'uint256', 'address', 'uint256'], [id, index, account.toLowerCase(), amount]));
}
const pair = (a, b) => (a.toLowerCase() < b.toLowerCase() ? keccak256(solidityPacked(['bytes32', 'bytes32'], [a, b])) : keccak256(solidityPacked(['bytes32', 'bytes32'], [b, a])));

/** Builds all levels (odd node is promoted unchanged, as in claimCore.mjs buildTree). */
export function buildTree(id, rows) {
  if (!rows.length || rows.length > MAX_LEAVES) throw new ClaimError('Leaves file must hold 1–50,000 leaves.');
  let total = 0n;
  const level0 = rows.map((r, i) => {
    total += r.amount;
    return leafHash(id, BigInt(i), r.address, r.amount);
  });
  const levels = [level0];
  while (levels.at(-1).length > 1) {
    const a = levels.at(-1);
    const next = [];
    for (let i = 0; i < a.length; i += 2) next.push(a[i + 1] ? pair(a[i], a[i + 1]) : a[i]);
    levels.push(next);
  }
  return { rows, levels, root: levels.at(-1)[0], total };
}

export function proofFor(tree, index) {
  const proof = [];
  let i = index;
  for (const level of tree.levels.slice(0, -1)) {
    if (level[i ^ 1]) proof.push(level[i ^ 1]);
    i = Math.floor(i / 2);
  }
  return proof;
}

/** leaves.json: { version:1, campaignId, root, leaves:[[address, amount], ...] } — array position is the index. */
export function parseLeavesFile(file, campaign) {
  if (file?.version !== 1 || !HASH_RE.test(file.root || '') || !Array.isArray(file.leaves) || file.leaves.length > MAX_LEAVES) throw new ClaimError('Leaves file has an invalid schema.');
  const rows = file.leaves.map((r) => {
    if (!Array.isArray(r) || r.length !== 2 || typeof r[1] !== 'string' || !/^\d{1,78}$/.test(r[1])) throw new ClaimError('Leaves file has an invalid leaf tuple.');
    let address;
    try { address = assertCyprus1QuaiAddress(r[0]); } catch { throw new ClaimError('Leaves file has an invalid address.'); }
    return { address, amount: BigInt(r[1]) };
  });
  if (rows.some((r) => r.amount <= 0n)) throw new ClaimError('Leaves file has a zero amount.');
  const tree = buildTree(campaign.id, rows);
  if (tree.root.toLowerCase() !== campaign.root.toLowerCase() || BigInt(rows.length) !== campaign.leafCount || tree.total !== campaign.total) {
    throw new ClaimError('Leaves do not match the on-chain campaign root, count or total — refusing to use them.');
  }
  return tree;
}

export function leavesUrl(metadataURI, root) {
  const uri = String(metadataURI || '');
  if (!uri || uri.startsWith('/')) return HOSTED_LEAVES + root;
  let url;
  try { url = new URL(uri); } catch { throw new ClaimError('Campaign leaves URL is malformed.'); }
  if (url.protocol !== 'https:') throw new ClaimError('Campaign leaves URL is not HTTPS; refusing to fetch it.');
  if (url.username || url.password) throw new ClaimError('Campaign leaves URL contains credentials; refusing to fetch it.');
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') || /^[\d.]+$/.test(host) || host.includes(':') || host.startsWith('[')) throw new ClaimError('Campaign leaves URL points at a local/IP host; refusing to fetch it.');
  return url.href;
}

async function fetchLeaves(url, fetchFn) {
  let res;
  try {
    res = await (fetchFn || fetch)(url, { method: 'GET', signal: AbortSignal.timeout(30_000), redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer' });
  } catch (err) {
    throw new ClaimError(`Could not fetch the campaign leaves (${url}): ${err?.message || err}`);
  }
  if (!res.ok && (res.status ?? 200) >= 400) throw new ClaimError(`Leaves unavailable (${res.status}). Ask the campaign creator for leaves.json.`);
  const len = Number(res.headers?.get?.('content-length'));
  if (Number.isFinite(len) && len > MAX_FILE_BYTES) throw new ClaimError('Leaves file exceeds 5 MB.');
  const text = await res.text();
  if (text.length > MAX_FILE_BYTES) throw new ClaimError('Leaves file exceeds 5 MB.');
  try { return JSON.parse(text); } catch { throw new ClaimError('Leaves file is not valid JSON.'); }
}

export function campaignStatus(c, nowSec) {
  if (!c) return 'missing';
  if (c.closed) return 'closed';
  return BigInt(nowSec) >= c.expiry ? 'expired' : 'open';
}

async function readCampaign(provider, contract, id) {
  const r = await view(provider, IFACE, contract, 'campaigns', [id]);
  if (/^0x0{40}$/i.test(r.creator)) return null;
  const token = /^0x0{40}$/i.test(r.token) ? null : assertCyprus1QuaiAddress(r.token);
  let meta = { symbol: 'QUAI', decimals: 18 };
  if (token) { try { meta = await readErc20(provider, token); } catch { meta = { symbol: 'Unknown', decimals: 18 }; } }
  return {
    id, creator: r.creator, token, symbol: meta.symbol, decimals: meta.decimals, total: BigInt(r.totalAmount), remaining: BigInt(r.remaining),
    root: r.merkleRoot, leafCount: BigInt(r.leafCount), expiry: BigInt(r.expiry), closed: r.closed, metadataURI: r.metadataURI,
  };
}

function campaignJson(c, nowSec) {
  return {
    id: c.id.toString(), status: campaignStatus(c, nowSec), creator: c.creator, token: c.token, symbol: c.symbol,
    total: formatAmount(c.total, c.decimals), remaining: formatAmount(c.remaining, c.decimals), leafCount: c.leafCount.toString(),
    expiresAt: new Date(Number(c.expiry) * 1000).toISOString(), link: `https://hartiibiome.com/claim.html?campaign=${c.id}&chain=9&v=1`,
  };
}

async function runClaimCore(opts, deps = {}) {
  const nowSec = Math.floor((deps.now ? new Date(deps.now).getTime() : Date.now()) / 1000);
  const isList = opts.sub === 'list';
  if (!isList && !opts.id) throw new ClaimError('Usage: hartii claim list [--mine|--creator <addr>] | hartii claim <campaignId> [--check]');

  if (opts.demo) {
    if (isList) return { items: [{ id: '1', status: 'open', creator: DEMO_ADDRESS, token: null, symbol: 'QUAI', total: '1000.0', remaining: '640.0', leafCount: '200', expiresAt: null, link: null }] };
    return { ok: true, dryRun: true, demo: true, summary: { action: 'Claim (demo)', network: DEMO_NETWORK, from: DEMO_ADDRESS, campaign: String(opts.id), claimFeeQuai: '0.05' } };
  }

  if (isList) {
    const { net, home } = readRuntime(opts, deps);
    const { address: contract, source } = await biomeAddress('claim', { ...deps, network: net.name });
    const provider = (deps.providerFactory || createProvider)(net.rpcUrl);
    const creator = opts.creator ? assertCyprus1QuaiAddress(opts.creator) : assertCyprus1QuaiAddress(resolveSender(home, opts, deps).address);
    const all = await pagedIds(provider, IFACE, contract, 'campaignsByCreator', [creator]);
    const ids = all.ids.reverse().slice(0, Math.min(Math.max(Number(opts.limit) || 25, 1), 100));
    const items = [];
    for (const id of ids) { const c = await readCampaign(provider, contract, id); if (c) items.push(campaignJson(c, nowSec)); }
    return { contract, addressSource: source, network: net.name, creator, ...(all.truncated ? { truncated: true, note: `Only the first ${all.ids.length} campaigns were read; the newest are missing.` } : {}), items };
  }

  const id = parseCampaignId(opts.id);
  // --check is read-only and only needs the wallet's public address; a real claim needs the signer.
  assertToolsNetwork(readRuntime(opts, deps).net.name);
  const ctx = opts.check ? null : await writeRuntime(opts, deps);
  const rt = ctx || readRuntime(opts, deps);
  const { net } = rt;
  const { address: contract, source } = await biomeAddress('claim', { ...deps, network: net.name });
  const provider = ctx ? ctx.provider : (deps.providerFactory || createProvider)(net.rpcUrl);
  const account = ctx ? ctx.from : assertCyprus1QuaiAddress(resolveSender(rt.home, opts, deps).address);

  const campaign = await readCampaign(provider, contract, id);
  if (!campaign) throw new ClaimError(`Campaign ${id} not found.`);
  const status = campaignStatus(campaign, nowSec);
  const tree = parseLeavesFile(await fetchLeaves(leavesUrl(campaign.metadataURI, campaign.root), deps.fetchFn), campaign);
  const mine = tree.rows.map((r, index) => ({ ...r, index })).filter((r) => r.address.toLowerCase() === account.toLowerCase());
  const leaves = [];
  for (const l of mine) leaves.push({ index: l.index, amount: l.amount, claimed: Boolean((await view(provider, IFACE, contract, 'isClaimed', [id, BigInt(l.index)]))[0]) });
  const unclaimed = leaves.filter((l) => !l.claimed);
  const eligibility = status !== 'open' ? status : !leaves.length ? 'not eligible' : !unclaimed.length ? 'already claimed' : 'eligible';
  const claimFee = BigInt((await view(provider, IFACE, contract, 'claimFee'))[0]);
  const report = {
    contract, addressSource: source, network: net.name, account, campaign: campaignJson(campaign, nowSec), eligibility,
    allocations: leaves.map((l) => ({ index: l.index, amount: formatAmount(l.amount, campaign.decimals), claimed: l.claimed })),
    unclaimedTotal: formatAmount(unclaimed.reduce((s, l) => s + l.amount, 0n), campaign.decimals), claimFeeQuai: formatAmount(claimFee),
  };
  if (opts.check) return report;
  if (eligibility !== 'eligible') throw new ClaimError(`Campaign ${id}: ${eligibility}.`);
  if ((await view(provider, IFACE, contract, 'paused'))[0]) throw new ClaimError('HartiiClaim is paused.');

  const leaf = unclaimed[0];
  const proof = proofFor(tree, leaf.index);
  return writeVia(ctx, {
    to: contract, data: IFACE.encodeFunctionData('claim', [id, BigInt(leaf.index), account, leaf.amount, proof]), value: claimFee,
    action: `Claim ${withAddr(campaign.symbol, campaign.token)}`,
    extraSummary: { contract, addressSource: source, campaign: id.toString(), leafIndex: String(leaf.index), claiming: `${formatAmount(leaf.amount, campaign.decimals)} ${withAddr(campaign.symbol, campaign.token)}`, claimFeeQuai: formatAmount(claimFee), proofLength: String(proof.length), moreAllocations: String(unclaimed.length - 1) },
  }, ClaimError);
}

export function runClaim(opts = {}, deps = {}) { return withProviderCleanup(deps, (d) => runClaimCore(opts, d)); }
