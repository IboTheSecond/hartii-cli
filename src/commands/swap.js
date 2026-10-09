// Direct HartiiSwap routes use live router quotes; QUAI/WQUAI wrap 1:1.
import { Interface } from 'quais';
import { withAddr } from '../output.js';
import { withProviderCleanup, marketRuntime, writeVia, managedExitSpend } from '../commandContext.js';
import { assertCyprus1QuaiAddress, checksumAddress } from '../address.js';
import { checkSpend } from '../spendingGuard.js';
import { parseAmount, formatAmount } from '../amount.js';
import { resilientRead } from '../../vendor/packages/agent-mcp/src/rpcClient.js';
import { applySlippage } from '../../vendor/src/utils/tradeTx.js';
import { deadlineTimestamp } from '../../vendor/src/utils/deadline.js';
import { HARTIISWAP_ROUTER_ABI } from '../abi/hartiiSwapRouter.js';
import { hartiiSwapAddresses } from '../liveAddresses.js';
import { resolveToken, MarketError } from '../marketApi.js';
import { parseSlippageBps } from '../trade.js';
import { reserveFeeWei } from '../gasReserve.js';
import { readErc20, ensureAllowance, approvalStop } from '../toolKit.js';
import { DEMO_ADDRESS, DEMO_NETWORK } from '../demoFixtures.js';
import { CliError, rethrowAs } from '../errors.js';

export class SwapError extends CliError {}

const ROUTER_IFACE = new Interface(HARTIISWAP_ROUTER_ABI);

/** Resolves one side of a swap to {kind:'native'|'erc20', address, symbol, decimals}. */
async function resolveSide(input, { wquai, provider, from, deps }) {
  const raw = String(input || '').trim();
  if (!raw) throw new SwapError('Both <in> and <out> are required.');
  if (raw.toLowerCase() === 'quai') return { kind: 'native', address: null, symbol: 'QUAI', decimals: 18 };
  if (raw.toLowerCase() === 'wquai') return erc20Side(wquai, provider, from);
  if (/^0x[0-9a-fA-F]{40}$/.test(raw)) return erc20Side(assertCyprus1QuaiAddress(raw), provider, from);
  // Ticker — resolve through the launchpad API (works for any Hartii-indexed token, graduated or not).
  const info = await rethrowAs(MarketError, SwapError, () => resolveToken(raw, deps), `"${raw}" is neither QUAI/WQUAI, a 0x address, nor an indexed ticker: `);
  return erc20Side(assertCyprus1QuaiAddress(info.address), provider, from);
}

async function erc20Side(address, provider, from) {
  const { symbol, decimals, balance } = await readErc20(provider, address, from);
  return { kind: 'erc20', address, symbol, decimals, balance };
}

const readBalance = (side, provider, from) => (side.kind === 'native'
  ? resilientRead(() => provider.getBalance(from), { method: 'quai_getBalance', params: [from, 'latest'] }).then(BigInt)
  : side.balance);

/**
 * @param {{ home?: string, network?: string, rpc?: string, wallet?: string, tokenIn: string, tokenOut: string, amount: string, slippage?: string, yes?: boolean, dryRun?: boolean, json?: boolean, demo?: boolean }} opts
 * @param {{ fetchFn?: typeof fetch, providerFactory?: Function, io?: object, passwordDeps?: object, walletFactory?: Function, now?: Date }} [deps]
 * @param {object} [approvedCtx] the runtime of a run whose approval just confirmed: reused so the keystore is decrypted once
 */
async function runSwapCore(opts, deps = {}, approvedCtx = null) {
  if (!opts.tokenIn || !opts.tokenOut || !opts.amount) throw new SwapError('Usage: hartii swap <in> <out> <amount> [--slippage 3]');
  const slippageBps = parseSlippageBps(opts.slippage);

  if (opts.demo) {
    return {
      ok: true, dryRun: true, demo: true,
      summary: { action: 'Swap (demo)', network: DEMO_NETWORK, from: DEMO_ADDRESS, tokenIn: opts.tokenIn, tokenOut: opts.tokenOut, amountIn: opts.amount },
    };
  }

  const ctx = approvedCtx || await marketRuntime(opts, deps);
  const { home, net, limits, provider, from: fromAddress } = ctx;
  deps = ctx.deps;

  const swap = hartiiSwapAddresses(net.name);
  if (!swap?.router) throw new SwapError(`HartiiSwap is not available on ${net.name}.`);
  const router = checksumAddress(swap.router);
  const wquai = checksumAddress(swap.wquai);



  const [sideIn, sideOut] = await Promise.all([
    resolveSide(opts.tokenIn, { wquai, provider, from: fromAddress, deps }),
    resolveSide(opts.tokenOut, { wquai, provider, from: fromAddress, deps }),
  ]);
  if (sideIn.kind === 'native' && sideOut.kind === 'native') throw new SwapError('Cannot swap QUAI for QUAI.');

  let amountInWei;
  let nativeBalanceWei; // set when a QUAI input amount is derived from the balance (all / %)
  if (String(opts.amount).trim().toLowerCase() === 'all' || /%$/.test(String(opts.amount).trim())) {
    const balanceWei = await readBalance(sideIn, provider, fromAddress);
    if (sideIn.kind === 'native') nativeBalanceWei = balanceWei;
    amountInWei = parseAmount(opts.amount, { balanceWei, decimals: sideIn.decimals }).amountWei;
  } else {
    amountInWei = parseAmount(opts.amount, { decimals: sideIn.decimals }).amountWei;
  }

  if (amountInWei <= 0n) throw new SwapError('Swap amount must be positive.');
  // QUAI input taken from the balance must leave the gas: estimate the real call and re-run with the trimmed amount.
  const trimForGas = async (tx) => {
    if (nativeBalanceWei === undefined) return null;
    let fee;
    try { fee = await reserveFeeWei(provider, net.rpcUrl, [tx], { fallbackGas: 700_000n }); }
    catch (err) { throw new SwapError(`Could not reserve gas for the swap: ${err?.message || err}`); }
    if (amountInWei + fee <= nativeBalanceWei) return null;
    if (nativeBalanceWei <= fee) throw new SwapError('Balance is too low to cover gas for a swap.');
    return runSwapCore({ ...opts, amount: formatAmount(nativeBalanceWei - fee) }, deps, ctx);
  };
  const path = [sideIn.kind === 'native' ? wquai : sideIn.address, sideOut.kind === 'native' ? wquai : sideOut.address];

  if (path[0].toLowerCase() === path[1].toLowerCase() && sideIn.kind !== sideOut.kind) {
    // IWETH in contracts/contracts/swap/HartiiSwapRouter.sol: standard 1:1 wrap/unwrap.
    const wrapped = new Interface(['function deposit() payable', 'function withdraw(uint256)']);
    const wrapping = sideIn.kind === 'native';
    if (wrapping) { const trimmed = await trimForGas({ from: fromAddress, to: wquai, data: wrapped.encodeFunctionData('deposit', []), value: amountInWei }); if (trimmed) return trimmed; }
    return writeVia(ctx, {
      to: wquai, data: wrapped.encodeFunctionData(wrapping ? 'deposit' : 'withdraw', wrapping ? [] : [amountInWei]),
      value: wrapping ? amountInWei : 0n, spendWei: amountInWei,
      action: wrapping ? 'Wrap QUAI' : 'Unwrap WQUAI',
      extraSummary: { amountIn: formatAmount(amountInWei), expectedOut: formatAmount(amountInWei), feeBps: '0' },
    });
  }
  if (path[0].toLowerCase() === path[1].toLowerCase()) throw new SwapError('Cannot swap identical assets; use wrapping/unwrapping directly for QUAI/WQUAI.');
  let amounts;
  try {
    const data = ROUTER_IFACE.encodeFunctionData('getAmountsOut', [amountInWei, path]);
    const hex = await resilientRead(() => provider.call({ to: router, data }), { primaryAttempts: 2 });
    amounts = ROUTER_IFACE.decodeFunctionResult('getAmountsOut', hex)[0].map((a) => BigInt(a));
  } catch (err) {
    throw new SwapError(`Could not quote this swap (no HartiiSwap pair for ${sideIn.symbol}/${sideOut.symbol}?): ${err?.message || err}`);
  }
  const expectedOut = amounts[amounts.length - 1];
  const minOut = applySlippage(expectedOut, slippageBps, 'min');
  const deadline = deadlineTimestamp();

  let to;
  let data;
  let value;
  if (sideIn.kind === 'native') {
    to = router;
    data = ROUTER_IFACE.encodeFunctionData('swapExactETHForTokens', [minOut, path, fromAddress, deadline]);
    value = amountInWei;
  } else if (sideOut.kind === 'native') {
    to = router;
    data = ROUTER_IFACE.encodeFunctionData('swapExactTokensForETH', [amountInWei, minOut, path, fromAddress, deadline]);
    value = 0n;
  } else {
    to = router;
    data = ROUTER_IFACE.encodeFunctionData('swapExactTokensForTokens', [amountInWei, minOut, path, fromAddress, deadline]);
    value = 0n;
  }



  if (sideIn.kind === 'native') { const trimmed = await trimForGas({ from: fromAddress, to, data, value }); if (trimmed) return trimmed; }

  // Native input is already QUAI; otherwise value the input using a fresh QUAI route.
  let spendWei = amountInWei;
  if (sideIn.kind !== 'native' && sideIn.address.toLowerCase() !== wquai.toLowerCase()) {
    const valuationData = ROUTER_IFACE.encodeFunctionData('getAmountsOut', [amountInWei, [sideIn.address, wquai]]);
    let valuation;
    try { valuation = ROUTER_IFACE.decodeFunctionResult('getAmountsOut', await provider.call({to:router,data:valuationData}))[0]; }
    catch { throw new SwapError('Cannot value token input in QUAI for spending limits; refusing swap.'); }
    spendWei = BigInt(valuation[valuation.length - 1]);
    if (spendWei <= 0n) throw new SwapError('Token input has no positive QUAI valuation.');
  }
  const managedSpend=managedExitSpend(ctx,{action:sideIn.kind==='erc20' && sideOut.kind==='native'?'sell':'swap',token:sideIn.address,spender:router,units:amountInWei.toString()});
  if(managedSpend!==null)spendWei=managedSpend;
  checkSpend(home, fromAddress, spendWei, limits, {now:deps.io?.now});
  const plannedTrade = { action: `Swap ${withAddr(sideIn.symbol, sideIn.address)} -> ${withAddr(sideOut.symbol, sideOut.address)}`, amountIn:formatAmount(amountInWei,sideIn.decimals), expectedOut:formatAmount(expectedOut,sideOut.decimals), minOut:formatAmount(minOut,sideOut.decimals), guardedQuai:formatAmount(spendWei), path:path.join(' -> '), feeBps:'30' };
  // Approval, through the SAME write pipeline, whenever the input side is an ERC-20.
  if (sideIn.kind === 'erc20') {
    const approval = await ensureAllowance(ctx, {
      token: sideIn.address, symbol: sideIn.symbol, decimals: sideIn.decimals, spender: router, amount: amountInWei,
      action: `Approve ${withAddr(sideIn.symbol, sideIn.address)} for HartiiSwap`,
      extraSummary: { plannedAction: plannedTrade.action, expectedOut: plannedTrade.expectedOut, minOut: plannedTrade.minOut },
      ErrorClass: SwapError,
      beforeApprove: () => { if (approvedCtx) throw new SwapError('Confirmed approval did not provide enough allowance; refusing another approval.'); },
    });
    const stop = approvalStop(approval, { dryRun: opts.dryRun, planKey: 'plannedTrade', plan: plannedTrade, note: 'Approval simulated only (--dry-run) — re-run without --dry-run to approve and swap for real.' });
    if (stop) return stop;
    // refresh quote, balances, caps and deadline after a real approval
    if (approval.needed) return runSwapCore(opts, deps, ctx);
  }

  const extraSummary = {
    feeBps: '30',
    feeIncludedInQuote: true,
    tokenIn: withAddr(sideIn.symbol, sideIn.address),
    tokenOut: withAddr(sideOut.symbol, sideOut.address),
    amountIn: formatAmount(amountInWei, sideIn.decimals),
    expectedOut: formatAmount(expectedOut, sideOut.decimals),
    minOut: formatAmount(minOut, sideOut.decimals),
    slippageBps: String(slippageBps),
    path: path.join(' -> '),
  };

  return writeVia(ctx, {
    to, data, value, spendWei,
    action: plannedTrade.action,
    extraSummary,
  }, SwapError);
}

export function runSwap(opts = {}, deps = {}) { return withProviderCleanup(deps, (runtimeDeps) => runSwapCore(opts, runtimeDeps)); }
