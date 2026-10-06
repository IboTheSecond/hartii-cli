// Buy through the token-bound launchpad curve, including its internal graduated pool.
import { withAddr } from '../output.js';
import { withProviderCleanup, marketRuntime, writeVia } from '../commandContext.js';
import { parseAmount, formatAmount } from '../amount.js';
import { resilientRead } from '../../vendor/packages/agent-mcp/src/rpcClient.js';
import { quoteAndBuildBuy, parseSlippageBps, resolveCurveToken, divergenceSummary, quoteAs } from '../trade.js';
import { DEMO_ADDRESS, DEMO_NETWORK, DEMO_TOKEN, DEMO_CURVE_META } from '../demoFixtures.js';
import { reserveFeeWei } from '../gasReserve.js';
import { localQuote } from '../curveQuote.js';
import { CliError } from '../errors.js';

export class BuyError extends CliError {}

/**
 * @param {{ home?: string, network?: string, rpc?: string, wallet?: string, token: string, quai: string, slippage?: string, yes?: boolean, dryRun?: boolean, json?: boolean, demo?: boolean }} opts
 * @param {{ fetchFn?: typeof fetch, providerFactory?: Function, io?: object, passwordDeps?: object, walletFactory?: Function, now?: Date }} [deps]
 */
async function runBuyCore(opts, deps = {}) {
  if (!opts.token || !opts.quai) throw new BuyError('Usage: hartii buy <token> <quai> [--slippage 3]');
  const slippageBps = parseSlippageBps(opts.slippage);

  if (opts.demo) {
    const quaiWei = parseAmount(opts.quai, { balanceWei: 1000_000000000000000000n, decimals: 18 }).amountWei;
    const q = localQuote({ meta: DEMO_CURVE_META, side: 'buy', amountWei: quaiWei });
    return {
      ok: true, dryRun: true, demo: true,
      summary: {
        action: 'Buy (demo)', network: DEMO_NETWORK, from: DEMO_ADDRESS, token: DEMO_TOKEN.symbol, tokenAddress: DEMO_TOKEN.address,
        quaiIn: formatAmount(quaiWei), expectedTokensOut: q ? formatAmount(q.expectedOut) : null,
      },
    };
  }

  const ctx = await marketRuntime(opts, deps);
  const { provider, from: fromAddress } = ctx;
  const { tokenInfo, curveAddress, tokenAddress } = await resolveCurveToken(opts.token, { provider, network: ctx.net.name, deps: ctx.deps, ErrorClass: BuyError });

  let quaiWei;
  let balanceWei;
  if (String(opts.quai).trim().toLowerCase() === 'all' || /%$/.test(String(opts.quai).trim())) {
    try {
      balanceWei = BigInt(await resilientRead(() => provider.getBalance(fromAddress), { primaryAttempts: 2 }));
    } catch (err) {
      throw new BuyError(`Could not read QUAI balance: ${err?.message || err}`);
    }
    quaiWei = parseAmount(opts.quai, { balanceWei, decimals: 18 }).amountWei;
  } else {
    quaiWei = parseAmount(opts.quai, { decimals: 18 }).amountWei;
  }

  let quote = await quoteAs(BuyError, 'buy', () => quoteAndBuildBuy(provider, curveAddress, quaiWei, slippageBps));
  if (balanceWei !== undefined) {
    // Amount derived from the balance (all / %): never leave less than the gas, estimated, from the real buy call; trim and re-quote when it would not fit.
    let fee;
    try { fee = await reserveFeeWei(provider, ctx.net.rpcUrl, [{ from: fromAddress, to: curveAddress, data: quote.data, value: quote.valueWei }], { fallbackGas: 600_000n }); }
    catch (err) { throw new BuyError(`Could not reserve gas for the buy: ${err?.message || err}`); }
    if (quote.valueWei + fee > balanceWei) {
      quaiWei = balanceWei - fee;
      if (quaiWei <= 0n) throw new BuyError('Balance is too low to cover gas for a buy.');
      quote = await quoteAs(BuyError, 'buy', () => quoteAndBuildBuy(provider, curveAddress, quaiWei, slippageBps));
    }
  }

  const extraSummary = {
    feeBps: String(quote.meta.feeBps),
    feeQuai: formatAmount((quote.valueWei * quote.meta.feeBps) / 10_000n),
    token: withAddr(tokenInfo.symbol, tokenAddress),
    tokenAddress: tokenInfo.address,
    curveAddress,
    quaiIn: formatAmount(quote.valueWei),
    expectedTokensOut: formatAmount(quote.expectedOut),
    minTokensOut: formatAmount(quote.minTokensOut),
    slippageBps: String(slippageBps),
    phase: quote.meta.graduated ? 'pool (graduated)' : 'bonding curve',
    finishingBuy: quote.finishing ? 'yes — this buy would finish the curve; the contract clamps and refunds the rest' : 'no',
    ...divergenceSummary(quote),
  };

  return writeVia(ctx, {
    to: curveAddress,
    data: quote.data,
    value: quote.valueWei,
    action: `Buy ${withAddr(tokenInfo.symbol, tokenAddress)}`,
    extraSummary,
  }, BuyError);
}

export function runBuy(opts = {}, deps = {}) { return withProviderCleanup(deps, (runtimeDeps) => runBuyCore(opts, runtimeDeps)); }
