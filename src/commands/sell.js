// Sell through the token-bound curve. Exact approvals use the shared write pipeline.
// Amounts use the wallet balance; final simulation enforces vesting and curve inventory limits.
import { withAddr } from '../output.js';
import { withProviderCleanup, marketRuntime, writeVia } from '../commandContext.js';
import { checkSpend } from '../spendingGuard.js';
import { parseAmount, formatAmount } from '../amount.js';
import { readErc20, ensureAllowance, approvalStop } from '../toolKit.js';
import { quoteAndBuildSell, parseSlippageBps, resolveCurveToken, divergenceSummary, quoteAs } from '../trade.js';
import { DEMO_ADDRESS, DEMO_NETWORK, DEMO_TOKEN, DEMO_CURVE_META } from '../demoFixtures.js';
import { localQuote } from '../curveQuote.js';
import { CliError } from '../errors.js';

export class SellError extends CliError {}

/**
 * @param {{ home?: string, network?: string, rpc?: string, wallet?: string, token: string, amount: string, slippage?: string, yes?: boolean, dryRun?: boolean, json?: boolean, demo?: boolean }} opts
 * @param {{ fetchFn?: typeof fetch, providerFactory?: Function, io?: object, passwordDeps?: object, walletFactory?: Function, now?: Date }} [deps]
 */
async function runSellCore(opts, deps = {}) {
  if (!opts.token || !opts.amount) throw new SellError('Usage: hartii sell <token> <amount|all|50%> [--slippage 3]');
  const slippageBps = parseSlippageBps(opts.slippage);

  if (opts.demo) {
    const amountWei = parseAmount(opts.amount, { balanceWei: 268_000_000000000000000000n, decimals: 18 }).amountWei;
    const q = localQuote({ meta: DEMO_CURVE_META, side: 'sell', amountWei });
    return {
      ok: true, dryRun: true, demo: true,
      summary: { action: 'Sell (demo)', network: DEMO_NETWORK, from: DEMO_ADDRESS, token: DEMO_TOKEN.symbol, tokenAddress: DEMO_TOKEN.address, tokensIn: formatAmount(amountWei), expectedQuaiOut: q ? formatAmount(q.expectedOut) : null },
    };
  }

  const ctx = await marketRuntime(opts, deps);
  const { home, provider, limits, from: fromAddress } = ctx;
  const { tokenInfo, curveAddress, tokenAddress } = await resolveCurveToken(opts.token, { provider, network: ctx.net.name, deps: ctx.deps, ErrorClass: SellError });
  const label = withAddr(tokenInfo.symbol, tokenAddress);

  const token = await readErc20(provider, tokenAddress, fromAddress);
  const amount = parseAmount(opts.amount, { balanceWei: token.balance, decimals: token.decimals }).amountWei;
  if (amount > token.balance) {
    throw new SellError(`Insufficient ${tokenInfo.symbol} balance: have ${formatAmount(token.balance, token.decimals)}, tried to sell ${formatAmount(amount, token.decimals)}.`);
  }
  if (amount <= 0n) throw new SellError(`"${opts.amount}" resolves to zero ${tokenInfo.symbol}.`);

  let quote = await quoteAs(SellError, 'sell', () => quoteAndBuildSell(provider, curveAddress, amount, slippageBps));

  checkSpend(home, fromAddress, quote.grossOnChain, limits, { now: deps.io?.now });
  const plannedTrade = { action: `Sell ${label}`, tokensIn: formatAmount(amount, token.decimals), expectedQuaiOut: formatAmount(quote.expectedOut), minQuaiOut: formatAmount(quote.minQuaiOut), feeQuai: formatAmount(quote.grossOnChain - quote.expectedOut), feeBps: String(quote.meta.feeBps), curveAddress };
  // Approval, through the SAME write pipeline, as its own confirmed tx — only when short. A dry run
  // can't actually raise the allowance, so it reports the approval's own summary and stops there.
  const approval = await ensureAllowance(ctx, {
    token: tokenAddress, symbol: tokenInfo.symbol, decimals: token.decimals, spender: curveAddress, amount,
    action: `Approve ${label} for curve`,
    extraSummary: { expectedQuaiOut: plannedTrade.expectedQuaiOut, minQuaiOut: plannedTrade.minQuaiOut },
    ErrorClass: SellError,
  });
  const stop = approvalStop(approval, { dryRun: opts.dryRun, planKey: 'plannedTrade', plan: plannedTrade, note: 'Approval simulated only (--dry-run) — re-run without --dry-run to approve and sell for real.' });
  if (stop) return stop;

  // An approval may take minutes; re-read the quote and deadline before building the sell.
  if (!opts.dryRun) quote = await quoteAndBuildSell(provider, curveAddress, amount, slippageBps);
  const extraSummary = {
    feeBps: String(quote.meta.feeBps),
    feeQuai: formatAmount(quote.grossOnChain - quote.expectedOut),
    token: label,
    tokenAddress,
    curveAddress,
    tokensIn: formatAmount(amount, token.decimals),
    expectedQuaiOut: formatAmount(quote.expectedOut),
    minQuaiOut: formatAmount(quote.minQuaiOut),
    slippageBps: String(slippageBps),
    phase: quote.meta.graduated ? 'pool (graduated)' : 'bonding curve',
    ...divergenceSummary(quote),
  };

  return writeVia(ctx, {
    to: curveAddress,
    data: quote.data,
    value: 0n,
    spendWei: quote.grossOnChain,
    action: `Sell ${label}`,
    extraSummary,
  }, SellError);
}

export function runSell(opts = {}, deps = {}) { return withProviderCleanup(deps, (runtimeDeps) => runSellCore(opts, runtimeDeps)); }
