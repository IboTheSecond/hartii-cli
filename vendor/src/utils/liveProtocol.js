// liveProtocol.js — the wire contract between the live hub (workers/live-hub, a Durable Object) and
// the browser. Pure: no DOM, no fetch, no timers. Both sides import this file, so a message the
// hub builds is a message the client can decode by construction.
//
// Channels:  'global'                — every trade / graduation / launch on the launchpad
//            'curve:<curve address>' — one bonding curve (the token page subscribes with the curve
//                                      it already knows; no token → curve lookup anywhere)
// Messages:  { v, channel, type, seq, ts, data } with wei values as STRINGS, never numbers.

export const PROTOCOL_VERSION = 1;
export const GLOBAL_CHANNEL = 'global';
export const MAX_CLIENT_MESSAGE_BYTES = 2048;
export const MAX_CHANNELS_PER_SOCKET = 8;

const ADDR_RE = /^0x[0-9a-f]{40}$/;

export function curveChannel(curveAddress) {
  const a = String(curveAddress || '').toLowerCase();
  return ADDR_RE.test(a) ? `curve:${a}` : null;
}

export function isValidChannel(channel) {
  if (channel === GLOBAL_CHANNEL) return true;
  if (typeof channel !== 'string') return false;
  if (channel.startsWith('curve:')) return ADDR_RE.test(channel.slice(6));
  if (channel.startsWith('agent:')) return ADDR_RE.test(channel.slice(6));
  return false;
}

/** Curve address of a curve channel, else null. */
export function channelCurve(channel) {
  return typeof channel === 'string' && channel.startsWith('curve:') && ADDR_RE.test(channel.slice(6)) ? channel.slice(6) : null;
}

export function agentChannel(vaultAddress) {
  const a = String(vaultAddress || '').toLowerCase();
  return ADDR_RE.test(a) ? `agent:${a}` : null;
}

/** Vault address of an agent channel, else null. */
export function channelAgent(channel) {
  return typeof channel === 'string' && channel.startsWith('agent:') && ADDR_RE.test(channel.slice(6)) ? channel.slice(6) : null;
}

/**
 * Parse one inbound client frame. Returns { type, channel } or null for anything malformed,
 * oversized or unknown — the hub drops silently, never throws, never echoes.
 */
export function parseClientMessage(raw, { maxBytes = MAX_CLIENT_MESSAGE_BYTES } = {}) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > maxBytes) return null;
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!msg || typeof msg !== 'object') return null;
  if (msg.type === 'ping') return { type: 'ping' };
  if (msg.type === 'subscribe' || msg.type === 'unsubscribe') {
    const channel = typeof msg.channel === 'string' ? msg.channel.toLowerCase() : '';
    if (!isValidChannel(channel)) return null;
    return { type: msg.type, channel };
  }
  return null;
}

/** Build one outbound frame. `seq` is per channel; `ts` is the hub's clock in ms. */
export function makeMessage(channel, type, seq, data, ts = Date.now()) {
  return { v: PROTOCOL_VERSION, channel, type, seq, ts, data: data ?? {} };
}

export function encodeMessage(msg) {
  return JSON.stringify(msg);
}

/** Decode an outbound frame on the client. Null for anything that is not a v1 message. */
export function decodeMessage(raw) {
  if (typeof raw !== 'string') return null;
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!msg || msg.v !== PROTOCOL_VERSION || typeof msg.type !== 'string' || typeof msg.channel !== 'string') return null;
  return msg;
}

/**
 * A gap in per-channel sequence numbers means frames were missed (only possible across a
 * reconnect): the consumer should re-fetch from the indexed API. The first frame never triggers.
 */
export function shouldReconcile(lastSeq, seq) {
  if (lastSeq === null || lastSeq === undefined) return false;
  if (!Number.isFinite(seq) || !Number.isFinite(lastSeq)) return false;
  return seq !== lastSeq + 1;
}

/** Exponential backoff with full jitter, capped. attempt 0 → ~base. */
export function nextBackoffMs(attempt, { base = 1000, max = 30_000, random = Math.random } = {}) {
  const n = Math.max(0, Math.min(20, Number(attempt) || 0));
  const ceiling = Math.min(max, base * 2 ** n);
  return Math.round(base / 2 + random() * (ceiling - base / 2));
}

/** Which channels to (un)subscribe when the wanted set changes. Pure set diff. */
export function diffSubscriptions(prev, next) {
  const before = new Set(prev || []);
  const after = new Set(next || []);
  return {
    toSubscribe: [...after].filter((c) => !before.has(c)),
    toUnsubscribe: [...before].filter((c) => !after.has(c)),
  };
}

/** Bounded remembered-keys set for dedupe (txHash-logIndex). Oldest keys fall off first. */
export class RingSet {
  constructor(max = 500) {
    this.max = max;
    this.set = new Set();
    this.order = [];
  }

  has(key) {
    return this.set.has(key);
  }

  add(key) {
    if (this.set.has(key)) return false;
    this.set.add(key);
    this.order.push(key);
    while (this.order.length > this.max) this.set.delete(this.order.shift());
    return true;
  }
}

export function tradeKey(t) {
  return `${String(t?.txHash || '').toLowerCase()}-${t?.logIndex ?? ''}`;
}

/** The trade frame both the hub's watcher and the indexer publish. Wei stays a string. */
export function tradeData({ tokenAddress = null, curveAddress = null, symbol = null, txHash, logIndex, side, quaiWei, tokenWei, priceWei = null, trader, blockNumber = null, blockTime = null, confirmed = false }) {
  return {
    tokenAddress: tokenAddress ? String(tokenAddress).toLowerCase() : null,
    curveAddress: curveAddress ? String(curveAddress).toLowerCase() : null,
    symbol: symbol || null,
    txHash: String(txHash || '').toLowerCase(),
    logIndex: Number.isFinite(Number(logIndex)) ? Number(logIndex) : null,
    side: side === 'sell' ? 'sell' : 'buy',
    quaiAmount: String(quaiWei ?? '0'),
    tokenAmount: String(tokenWei ?? '0'),
    priceWei: priceWei === null || priceWei === undefined ? null : String(priceWei),
    trader: trader ? String(trader).toLowerCase() : null,
    blockNumber: Number.isFinite(Number(blockNumber)) ? Number(blockNumber) : null,
    blockTime: blockTime || null,
    confirmed: Boolean(confirmed),
  };
}

/**
 * The burn frame. A burn is a Transfer to the zero address: it has a token amount and a burner,
 * and no QUAI side at all — `quaiAmount` stays null so nothing downstream ever prices it as a
 * trade. It rides the same channels, the same sequence numbers and the same txHash-logIndex key
 * as a trade, so the ticker and the feed merge and dedupe it with no special casing.
 */
export function burnData({ tokenAddress = null, curveAddress = null, symbol = null, txHash, logIndex, tokenWei, burner = null, blockNumber = null, blockTime = null, confirmed = true }) {
  return {
    tokenAddress: tokenAddress ? String(tokenAddress).toLowerCase() : null,
    curveAddress: curveAddress ? String(curveAddress).toLowerCase() : null,
    symbol: symbol || null,
    txHash: String(txHash || '').toLowerCase(),
    logIndex: Number.isFinite(Number(logIndex)) ? Number(logIndex) : null,
    side: 'burn',
    quaiAmount: null,
    tokenAmount: String(tokenWei ?? '0'),
    trader: burner ? String(burner).toLowerCase() : null,
    blockNumber: Number.isFinite(Number(blockNumber)) ? Number(blockNumber) : null,
    blockTime: blockTime || null,
    confirmed: Boolean(confirmed),
  };
}

/** Normalizes one AgentAction into the same lower-cased, confirmed-flagged shape tradeData/burnData use. */
export function agentActionData({ vaultAddress, target = null, selector = null, kind = 'other', valueWei = '0', txHash, logIndex, blockNumber = null, blockTime = null, confirmed = false }) {
  return {
    vaultAddress: String(vaultAddress || '').toLowerCase(),
    target: target ? String(target).toLowerCase() : null,
    selector: selector ? String(selector).toLowerCase() : null,
    kind: kind || 'other',
    valueWei: String(valueWei ?? '0'),
    txHash: String(txHash || '').toLowerCase(),
    logIndex: Number.isFinite(Number(logIndex)) ? Number(logIndex) : null,
    blockNumber: Number.isFinite(Number(blockNumber)) ? Number(blockNumber) : null,
    blockTime: blockTime || null,
    confirmed: Boolean(confirmed),
  };
}

/**
 * The 'head' frame's data (PR2, latency programme): one upstream newHeads notification, broadcast
 * on GLOBAL_CHANNEL so every open page — the ticker is mounted on every page, so this is
 * effectively every visitor — can sample hub→client latency for the chain's own block cadence,
 * independent of whether any curve is trading. `timestamp` is unix SECONDS (or null when the
 * header carried none); `hubAt` is the hub's own clock in ms, the same shape `tradeData`'s
 * additive `hubAt` field already uses for the trade-latency sample. Additive: PROTOCOL_VERSION
 * stays 1, and an old client's useLiveFeed.js if/else chain silently ignores an unknown frame type.
 */
export function headData({ blockNumber = null, timestamp = null, hubAt = Date.now() } = {}) {
  // null/undefined must stay null — Number(null) is 0, which IS finite, so that coercion has to
  // happen only for a value that was actually provided.
  const numOrNull = (v) => {
    if (v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return {
    blockNumber: numOrNull(blockNumber),
    timestamp: numOrNull(timestamp),
    hubAt: Number.isFinite(Number(hubAt)) ? Number(hubAt) : Date.now(),
  };
}

/** True for a feed row that is a burn rather than a buy or a sell. */
export function isBurnRow(row) {
  return row?.side === 'burn';
}

/**
 * Chart tick the token page already understands (see useLiveTrades / candleTicks.applyTick).
 *
 * `blockTime` comes in two shapes depending on the source: the indexer's confirmed rows carry an
 * ISO date string (parsed below with Date.parse, unchanged since before PR2); the live hub's
 * upstream-subscription path (PR2) attaches it as unix seconds straight from a newHeads header, so
 * that form is preferred first when it looks sane — no Date.parse round trip needed, and it can
 * never collide with the string form since typeof already tells them apart.
 */
export function tickFromTradeData(d, nowSec = Math.floor(Date.now() / 1000)) {
  let quai = 0;
  let tokens = 0;
  try {
    quai = Number(BigInt(d.quaiAmount)) / 1e18;
    tokens = Number(BigInt(d.tokenAmount)) / 1e18;
  } catch {
    return null;
  }
  if (!(tokens > 0)) return null;
  let ts = nowSec;
  // Unix SECONDS only: > 1e9 rules out block numbers / zero, < 4e9 rules out millisecond stamps.
  if (typeof d.blockTime === 'number' && Number.isFinite(d.blockTime) && d.blockTime > 1e9 && d.blockTime < 4e9) {
    ts = Math.floor(d.blockTime);
  } else if (d.blockTime) {
    const parsed = Math.floor(Date.parse(d.blockTime) / 1000);
    if (Number.isFinite(parsed)) ts = parsed;
  }
  return {
    price: quai / tokens,
    volumeQuai: quai,
    ts: Number.isFinite(ts) ? ts : nowSec,
    side: d.side,
    trader: d.trader,
    blockNumber: d.blockNumber,
    txHash: d.txHash,
    logIndex: d.logIndex,
    quaiWei: BigInt(d.quaiAmount),
    tokenWei: BigInt(d.tokenAmount),
  };
}
