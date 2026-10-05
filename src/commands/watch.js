import { safeTerminalText } from '../output.js';
import { createRequire } from 'node:module';
import { readRuntime } from '../commandContext.js';
import { assertMarketNetwork } from '../marketApi.js';
// Foreground live feed: NDJSON with --json, bounded recent frame history, mainnet only.
import { decodeMessage, encodeMessage, GLOBAL_CHANNEL, curveChannel } from '../../vendor/src/utils/liveProtocol.js';
import { resolveToken, MarketError } from '../marketApi.js';
import { DEMO_TRADE_FRAMES, DEMO_NETWORK } from '../demoFixtures.js';
import { CliError, rethrowAs } from '../errors.js';

export class WatchError extends CliError {}

const API_BASE = 'https://hartiilabs.com';

function wsUrl(apiBase, channel) {
  const wsBase = apiBase.replace(/^http/, 'ws');
  return `${wsBase}/api/live/ws?channel=${encodeURIComponent(channel)}`;
}

function frameLine(msg) {
  const d = Object.fromEntries(Object.entries(msg.data || {}).map(([k,v]) => [k,safeTerminalText(v)]));
  if (msg.type === 'trade') {
    return `[${d.symbol || d.tokenAddress || '?'}] ${String(d.side || '?').toUpperCase()} quai=${d.quaiAmount} token=${d.tokenAmount} trader=${d.trader} tx=${d.txHash}`;
  }
  if (msg.type === 'burn') {
    return `[${d.symbol || d.tokenAddress || '?'}] BURN token=${d.tokenAmount} by=${d.trader} tx=${d.txHash}`;
  }
  return `[${msg.channel}] ${msg.type} ${JSON.stringify(d)}`;
}

/**
 * @param {{ target: string, home?: string, network?: string, apiBase?: string, json?: boolean, demo?: boolean }} opts
 * @param {{ fetchFn?: typeof fetch, WebSocketImpl?: typeof WebSocket, write?: (s:string)=>void, limit?: number, onFrame?: (msg:object)=>void }} [deps]
 * @returns {Promise<{ ok: boolean, channel: string, frames: object[] }>}
 */
export async function runWatch(opts = {}, deps = {}) {
  if (!opts.target) throw new WatchError('Usage: hartii watch <token|all>');
  const write = deps.write || ((s) => process.stdout.write(s + '\n'));

  if (opts.demo) {
    for (const frame of DEMO_TRADE_FRAMES) {
      write(opts.json ? JSON.stringify(frame) : frameLine(frame));
      if (deps.onFrame) deps.onFrame(frame);
    }
    return { ok: true, demo: true, channel: 'global', network: DEMO_NETWORK, frames: DEMO_TRADE_FRAMES };
  }

  const { net } = readRuntime(opts, deps);
  assertMarketNetwork(net.name);
  let channel;
  if (String(opts.target).toLowerCase() === 'all') {
    channel = GLOBAL_CHANNEL;
  } else {
    const info = await rethrowAs(MarketError, WatchError, () => resolveToken(opts.target, deps));
    if (!info.curveAddress) throw new WatchError(`"${opts.target}" has no bonding curve to watch.`);
    channel = curveChannel(info.curveAddress);
    if (!channel) throw new WatchError(`Could not build a live channel for "${opts.target}".`);
  }

  const apiBase = opts.apiBase || deps.apiBase || API_BASE;
  const url = wsUrl(apiBase, channel);
  const WS = deps.WebSocketImpl || getWebSocketImpl();

  const frames = [];
  let frameCount = 0;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        // already closing/closed — fine
      }
      resolve(result);
    };

    const ws = new WS(url, { headers: { Origin: 'https://hartiilabs.com' } });
    ws.addEventListener('open', () => {
      ws.send(encodeMessage({ type: 'subscribe', channel }));
    });
    ws.addEventListener('message', (event) => {
      const msg = decodeMessage(event.data);
      if (!msg) return;
      if (msg.type === 'trade' || msg.type === 'burn' || msg.type === 'head') {
        write(opts.json ? JSON.stringify(msg) : frameLine(msg));
        frames.push(msg);
        frameCount++;
        if (frames.length > 200) frames.shift();
        if (deps.onFrame) deps.onFrame(msg);
        if (deps.limit && frameCount >= deps.limit) finish({ ok: true, channel, frames, frameCount });
      }
    });
    ws.addEventListener('error', (event) => {
      if (!settled) { settled = true; ws.close(); reject(new WatchError(`Live feed connection error: ${event?.message || 'unknown error'}`)); }
    });
    ws.addEventListener('close', () => finish({ ok: true, channel, frames, frameCount }));
  });
}

// Resolve the installed ws dependency at its owning quais package. No global WebSocket assumption.
export function getWebSocketImpl() {
  const require = createRequire(import.meta.url);
  return createRequire(require.resolve('quais'))('ws');
}
