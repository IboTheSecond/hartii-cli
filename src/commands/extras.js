// packages/hartii-cli/src/commands/extras.js
//
// The "everyday" commands layered on the core ones: price, quote, holders, trades, block, gas, open, limits,
// networks, whoami, init, update, about. All read-only (they never sign and never prompt for a password).
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { formatUnits } from 'quais';
import { readRuntime } from '../commandContext.js';
import { resolveWalletAddress } from './balance.js';
import { walletList } from './walletCmd.js';
import { fetchToken, resolveToken, MarketError, API_BASE, assertMarketNetwork } from '../marketApi.js';
import { buildTools } from '../mcp/tools.js';
import { createProvider } from '../signer.js';
import { NETWORKS } from '../network.js';
import { getSpentToday } from '../spendingGuard.js';
import { formatAmount } from '../amount.js';
import { quaiscanTxUrl, quaiscanAddressUrl } from '../quaiscan.js';
import { assertCyprus1QuaiAddress } from '../address.js';
import { resilientRead } from '../../vendor/packages/agent-mcp/src/rpcClient.js';
import { PKG_VERSION } from '../version.js';
import { readGasPrice } from '../gasPrice.js';
import { fmtPrice } from '../tui/format.js';
import { CliError, rethrowAs } from '../errors.js';
import { runUpdate } from './update.js';

export class ExtraError extends CliError {}

const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const q = (wei) => { try { return formatAmount(BigInt(wei)); } catch { return null; } };

async function getJson(url, fetchFn) {
  let res;
  try { res = await (fetchFn || fetch)(url, { method: 'GET', signal: AbortSignal.timeout(12000), redirect: 'error' }); }
  catch (err) { throw new ExtraError(`Could not reach ${url}: ${err?.message || err}`); }
  let body = null;
  try { body = await res.json(); } catch { /* handled below */ }
  if (res.status >= 400 || !body) throw new ExtraError(`${url} answered ${res.status ?? '?'}.`);
  return body;
}

function clamp(n, d, max) { const v = Number(n); return Number.isInteger(v) && v >= 1 ? Math.min(v, max) : d; }

export async function runExtra(command, args, ctx) {
  const { opts, deps, extraFlags } = ctx;
  const rt = () => readRuntime(opts, deps);
  if (opts.demo && ['price', 'quote', 'holders', 'trades', 'block', 'gas'].includes(command)) return demoExtra(command, args);
  const providerFor = (url) => (deps.providerFactory || createProvider)(url);

  switch (command) {
    case 'price': {
      if (!args[0]) throw new ExtraError('Usage: hartii price <addr|ticker>');
      const rtm = rt(); assertMarketNetwork(rtm.net.name);
      const { token, graduationProgress } = await fetchToken(args[0], { ...deps, network: rtm.net.name });
      return {
        symbol: token.symbol, token: token.address, priceQuai: token.lastPriceWei ? fmtPrice(token.lastPriceWei) : null, priceWei: token.lastPriceWei ?? null,
        change24hPct: token.change24h ?? null, phase: token.status || null, holders: token.holderCount ?? null,
        volume24hQuai: token.volume24hWei ? q(token.volume24hWei) : null, graduation: graduationProgress ?? null, source: `${API_BASE}/api/token`,
      };
    }
    case 'quote': {
      const [side, token, amount] = args;
      if (!['buy', 'sell'].includes(side) || !token || !amount) throw new ExtraError('Usage: hartii quote <buy|sell> <token> <amount> [--slippage 3]');
      const tool = buildTools({ home: opts.home, network: opts.network, rpc: opts.rpc, wallet: opts.wallet, env: deps.env, fetchFn: deps.fetchFn, providerFactory: deps.providerFactory, limits: {}, allowWrites: false }).find((t) => t.name === 'hartii_quote');
      return tool.handler({ token, side, amount, slippage: extraFlags.slippage });
    }
    case 'holders':
    case 'trades': {
      if (!args[0]) throw new ExtraError(`Usage: hartii ${command} <addr|ticker> [--limit 20]`);
      const rtm = rt(); assertMarketNetwork(rtm.net.name);
      const info = await rethrowAs(MarketError, ExtraError, () => resolveToken(args[0], { ...deps, network: rtm.net.name }));
      const limit = clamp(extraFlags.limit, 20, 100);
      const body = await getJson(`${API_BASE}/api/token/${info.address}/${command}?limit=${limit}`, deps.fetchFn);
      const items = Array.isArray(body.items) ? body.items : [];
      return { token: info.symbol, address: info.address, count: items.length, items: items.slice(0, limit).map((it) => (command === 'holders'
        ? { holder: it.holder ?? it.address, balance: it.balance, pct: it.pct ?? it.percent ?? null }
        : { side: it.side, quai: it.quaiAmount ? q(it.quaiAmount) : null, trader: it.trader, tx: it.txHash, block: it.blockNumber ?? null, at: it.blockTime ?? null })) };
    }
    case 'block': {
      const n = rt().net;
      const provider = providerFor(n.rpcUrl);
      try {
        const height = Number(await resilientRead(() => provider.getBlockNumber(), { primaryAttempts: 2 }));
        return { network: n.name, height };
      } finally { provider.destroy?.(); }
    }
    case 'gas': {
      const n = rt().net;
      const provider = providerFor(n.rpcUrl);
      try {
        const gp = await readGasPrice(provider, n.rpcUrl);
        return { network: n.name, gasPriceWei: gp.toString(), gasPriceGwei: formatUnits(gp, 9), transferCostQuai: formatAmount(gp * 39_000n), contractCallCostQuai: formatAmount(gp * 250_000n), note: 'transfer ~39k gas (a never-seen recipient), contract call ~250k; real writes simulate first' };
      } finally { provider.destroy?.(); }
    }
    case 'open': {
      const target = args[0];
      if (!target) throw new ExtraError('Usage: hartii open <tx hash|address> [--browser]');
      const n = rt().net;
      let url;
      if (HASH_RE.test(target)) url = quaiscanTxUrl(n.name, target);
      else { try { url = quaiscanAddressUrl(n.name, assertCyprus1QuaiAddress(target)); } catch { throw new ExtraError(`"${target}" is neither a 32-byte tx hash nor a Cyprus-1 Quai address.`); } }
      if (extraFlags.browser && !deps.noSpawn) {
        const [cmd, a] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
        try { spawn(cmd, a, { stdio: 'ignore', detached: true }).unref(); } catch { /* the URL is printed anyway */ }
      }
      return { url };
    }
    case 'limits': {
      const r = rt();
      const { address } = resolveWalletAddress(r.home, opts.wallet);
      const spent = getSpentToday(r.home, address);
      return { wallet: address, network: r.net.name, perTxQuai: r.limits.perTxQuai, dailyQuai: r.limits.dailyQuai, spentTodayQuai: formatAmount(BigInt(spent.spentWei)), reservedQuai: formatAmount(BigInt(spent.reservedWei || 0)), change: 'hartii config set limits.perTxQuai <quai>  |  limits.dailyQuai <quai>' };
    }
    case 'networks': {
      const active = rt().net.name;
      return { active, networks: Object.values(NETWORKS).map((n) => ({ name: n.name, chainId: n.chainId, rpc: n.rpcUrl, active: n.name === active, marketAndTools: n.name === 'mainnet' })) };
    }
    case 'whoami': {
      const r = rt();
      let w = null;
      try { w = resolveWalletAddress(r.home, opts.wallet); } catch { /* none yet */ }
      return { wallet: w?.name ?? null, address: w?.address ?? null, network: r.net.name, home: r.home, hint: w ? undefined : 'No wallet yet: run `hartii wallet new` (or `hartii init`).' };
    }
    case 'init': {
      const r = rt();
      let wallets = [];
      try { wallets = walletList(r.home); } catch { /* no keystore dir yet */ }
      const current = wallets.find((x) => x.current);
      const steps = [];
      if (!wallets.length) steps.push('hartii wallet new            create your encrypted wallet (you choose the password)');
      else if (!current) steps.push(`hartii wallet use ${wallets[0].name}      pick a wallet`);
      steps.push('hartii doctor                check RPC, chain id and API');
      if (current) steps.push('hartii balance --tokens     see what you hold');
      steps.push('hartii ui --demo              tour the full-screen UI on fixture data', 'hartii help                  every command (also: hartii ?)');
      return { status: 'BETA — the Hartii terminal wallet is beta software and has not been independently audited; start with small amounts.', node: process.versions.node, nodeOk: Number(process.versions.node.split('.')[0]) >= 20, home: r.home, homeExists: existsSync(r.home), network: r.net.name, wallets: wallets.length, currentWallet: current?.name ?? null, address: current?.address ?? null, nextSteps: steps };
    }
    case 'update':
      return runUpdate({ check: extraFlags.check === true, json: opts.json === true, yes: opts.yes === true }, { fetchFn: deps.fetchFn, spawnFn: deps.spawnFn, confirmFn: deps.confirmFn, interactive: deps.interactive, writeErr: deps.writeErr, base: deps.updateBase, tmp: deps.tmp });
    case 'about':
    case 'version':
      return { name: '@hartii/cli', version: PKG_VERSION, status: 'BETA — not audited', node: process.versions.node, home: rt().home, site: 'https://hartiilabs.com/cli', docs: 'https://docs.hartiilabs.com', download: 'https://hartiilabs.com/downloads/hartii-cli.tgz' };
    default:
      throw new ExtraError(`Unknown command "${command}".`);
  }
}

function demoExtra(command, args) {
  const demo = { demo: true, note: 'fixture data — no network' };
  if (command === 'price') return { ...demo, symbol: 'DEMO', priceQuai: '0.0000186', change24hPct: 12.4, phase: 'active', holders: 42 };
  if (command === 'quote') return { ...demo, side: args[0] || 'buy', token: args[1] || 'DEMO', expectedTokensOut: '267444.05', feeBps: '100' };
  if (command === 'block') return { ...demo, network: 'mainnet', height: 10412877 };
  if (command === 'gas') return { ...demo, network: 'mainnet', gasPriceGwei: '58.7', transferCostQuai: '0.0000023' };
  return { ...demo, token: args[0] || 'DEMO', count: 0, items: [] };
}

export const EXTRA_COMMANDS = new Set(['price', 'quote', 'holders', 'trades', 'block', 'gas', 'open', 'limits', 'networks', 'whoami', 'init', 'update', 'about', 'version']);
