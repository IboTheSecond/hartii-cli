// packages/hartii-cli/src/commandTable.js
//
// COMMAND_TABLE: command name -> handler(ctx). Each handler only translates the parsed command line
// (ctx.args, ctx.flags, ctx.g = global flags) into the options/deps its command module takes, and
// returns that command's result — cli.js prints it. Commands in RAW_COMMANDS return their own exit code
// instead (they stream or own stdout themselves).
import { getHartiiHome } from './config.js';
import { CliError } from './errors.js';
import { runDoctor } from './commands/doctor.js';
import { runBalance } from './commands/balance.js';
import { runSend } from './commands/send.js';
import { runConfig } from './commands/configCmd.js';
import { runWallet } from './commands/walletRoute.js';
import { runTokens } from './commands/tokens.js';
import { runToken } from './commands/token.js';
import { runBuy } from './commands/buy.js';
import { runSell } from './commands/sell.js';
import { runSwap } from './commands/swap.js';
import { runTx } from './commands/tx.js';
import { runReceive } from './commands/receive.js';
import { runWatch } from './commands/watch.js';
import { runAirdrop } from './commands/airdrop.js';
import { runOtc } from './commands/otc.js';
import { runClaim } from './commands/claim.js';
import { runWall } from './commands/wall.js';
import { runExtra, EXTRA_COMMANDS, ExtraError } from './commands/extras.js';
import { runMcp } from './mcp/server.js';

/** ctx = { args, flags, g, deps, env, io, home, write } — see cli.js. */
const readOpts = ({ home, g }) => ({ home, network: g.network, rpc: g.rpc, demo: g.demo });
const walletOpts = (c) => ({ ...readOpts(c), wallet: c.g.wallet, keyEnv: c.g.keyEnv });
const writeOpts = (c) => ({ ...walletOpts(c), yes: c.g.yes, dryRun: c.g.dryRun, json: c.g.json });
const readDeps = ({ deps }) => ({ fetchFn: deps.fetchFn, providerFactory: deps.providerFactory });
const writeDeps = (c) => ({
  ...readDeps(c), walletFactory: c.deps.walletFactory, io: c.io, passwordDeps: c.io.passwordDeps, now: c.deps.now,
  trustLiveAddresses: c.flags['trust-live-addresses'] === true, // human-only; the MCP server never sets it
});

const writeCmd = (run, specific) => (c) => run({ ...writeOpts(c), ...specific(c) }, writeDeps(c));

const mcp = (c) => (c.deps.runMcp || runMcp)({
  env: c.env, home: getHartiiHome(c.env), network: c.g.network, rpc: c.g.rpc, wallet: c.g.wallet, keyEnv: c.g.keyEnv,
  allowWrites: c.flags['allow-writes'] === true,
  maxPerTx: c.flags['max-per-tx'], maxPerDay: c.flags['max-per-day'],
  fetchFn: c.deps.fetchFn, providerFactory: c.deps.providerFactory, walletFactory: c.deps.walletFactory, now: c.deps.now, transport: c.deps.mcpTransport,
});

const watch = async (c) => {
  const [target] = c.args;
  const result = await runWatch(
    { target, home: c.home, network: c.g.network, json: c.g.json, demo: c.g.demo },
    { fetchFn: c.deps.fetchFn, WebSocketImpl: c.deps.WebSocketImpl, write: c.write, limit: c.deps.watchLimit, onFrame: c.deps.onFrame },
  );
  return result?.ok === false ? 1 : 0; // an NDJSON stream: nothing more to print
};

const extra = (command) => async (c) => {
  try {
    return await runExtra(command, c.args, {
      opts: { ...readOpts(c), wallet: c.g.wallet },
      deps: { env: c.env, fetchFn: c.deps.fetchFn, providerFactory: c.deps.providerFactory, noSpawn: c.deps.noSpawn },
      extraFlags: c.flags,
    });
  } catch (e) {
    throw e instanceof CliError ? e : new ExtraError(String(e?.shortMessage || e?.message || e).split('\n')[0]);
  }
};

export const COMMAND_TABLE = {
  wallet: (c) => runWallet(c.args, c.flags, c),
  receive: (c)=>runReceive({...walletOpts(c),amount:c.flags.amount,memo:c.flags.memo,addressQr:c.flags['address-qr']===true,out:c.flags.out,expiresAt:c.flags.expires===undefined?null:Number(c.flags.expires)}),
  config: (c) => runConfig(c.args, c.home),
  balance: (c) => runBalance({ ...walletOpts(c), tokens: Boolean(c.flags.tokens), address: typeof c.flags.address === 'string' ? c.flags.address : undefined }, readDeps(c)),
  doctor: (c) => runDoctor(readOpts(c), { fetchFn: c.deps.fetchFn, now: c.deps.now }),
  tokens: (c) => runTokens({ sub: c.args[0], query: c.args[1], limit: c.flags.limit, home: c.home, network: c.g.network, demo: c.g.demo }, { fetchFn: c.deps.fetchFn }),
  token: (c) => runToken({ id: c.args[0], ...readOpts(c) }, readDeps(c)),
  tx: (c) => runTx({ hash: c.args[0], ...readOpts(c) }, { providerFactory: c.deps.providerFactory }),
  send: writeCmd(runSend, ({ args: [to, amount], flags }) => ({ to, amount, token: flags.token })),
  buy: writeCmd(runBuy, ({ args: [token, quai], flags }) => ({ token, quai, slippage: flags.slippage })),
  sell: writeCmd(runSell, ({ args: [token, amount], flags }) => ({ token, amount, slippage: flags.slippage })),
  swap: writeCmd(runSwap, ({ args: [tokenIn, tokenOut, amount], flags }) => ({ tokenIn, tokenOut, amount, slippage: flags.slippage })),
  airdrop: writeCmd(runAirdrop, ({ flags }) => ({ csv: flags.csv, token: flags.token, amount: flags.amount })),
  otc: writeCmd(runOtc, ({ args: [sub, a, b, third], flags }) => ({
    sub, taker: flags.taker, expiry: flags.expiry, mine: Boolean(flags.mine), limit: flags.limit, status: flags.status,
    ...(sub === 'create' ? { token: a, amount: b, quai: third } : sub === 'fill' || sub === 'cancel' ? { id: a } : {}),
  })),
  claim: writeCmd(runClaim, ({ args: [first], flags }) => ({
    sub: first === 'list' ? 'list' : 'claim', id: first === 'list' ? undefined : first,
    mine: Boolean(flags.mine), creator: flags.creator, check: Boolean(flags.check), limit: flags.limit,
  })),
  wall: writeCmd(runWall, ({ args: [sub = 'engrave', message], flags }) => ({
    sub, message: sub === 'engrave' ? message : undefined, n: sub === 'recent' ? message : undefined, color: flags.color, token: flags.token,
  })),
  watch,
  mcp,
  ...Object.fromEntries([...EXTRA_COMMANDS].map((name) => [name, extra(name)])),
};

/** Handlers that return a process exit code themselves instead of a result to print. */
export const RAW_COMMANDS = new Set(['watch', 'mcp']);
