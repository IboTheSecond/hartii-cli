// Native or ERC20 send. Token sends resolve tickers and require a live QUAI valuation.
import { withAddr } from '../output.js';
import { withProviderCleanup, writeRuntime, writeVia } from '../commandContext.js';
import { tokenValueQuai } from '../tokenValue.js';
import { assertCyprus1QuaiAddress } from '../address.js';
import { parseAmount, formatAmount } from '../amount.js';
import { resilientRead } from '../../vendor/packages/agent-mcp/src/rpcClient.js';
import { readGasPrice } from '../gasPrice.js';
import { ERC20_IFACE, readErc20, tokenAddressOf } from '../toolKit.js';
import { DEMO_ADDRESS, DEMO_NETWORK } from '../demoFixtures.js';
import { CliError } from '../errors.js';
import {parseNativePaylink,exactReceiveAmount} from '../paylinks.js';

export class SendError extends CliError {}

/**
 * @param {{ home?: string, network?: string, rpc?: string, wallet?: string, to: string, amount: string, token?: string, yes?: boolean, dryRun?: boolean, json?: boolean, demo?: boolean }} opts
 * @param {{ fetchFn?: typeof fetch, providerFactory?: (rpcUrl:string)=>any, io?: object, passwordDeps?: object, now?: Date }} [deps]
 */
async function runSendCore(opts, deps = {}) {
  let paymentRequest=null;
  if(typeof opts.to==='string'&&/^https?:\/\//i.test(opts.to)){
    paymentRequest=parseNativePaylink(opts.to);
    if(opts.token)throw new SendError('HPAY requests in the CLI send native QUAI only.');
    if(opts.amount&&paymentRequest.amountWei!==null&&exactReceiveAmount(opts.amount)!==paymentRequest.amountWei)throw new SendError('Provided amount differs from this payment request. Request a new link or send directly to the reviewed address.');
    opts={...opts,to:paymentRequest.to,amount:opts.amount||paymentRequest.amount};
  }
  if (!opts.to) throw new SendError('Usage: hartii send <to> <amount> [--token <addr>]');
  if (!opts.amount) throw new SendError('Usage: hartii send <to> <amount> [--token <addr>]');

  if (opts.demo) {
    const to = assertCyprus1QuaiAddress(opts.to);
    const amount = parseAmount(opts.amount, { balanceWei: 1000_000000000000000000n, decimals: 18 });
    return {
      ok: true,
      dryRun: true,
      demo: true,
      summary: { action: opts.token ? 'Send token (demo)' : 'Send QUAI (demo)', network: DEMO_NETWORK, from: DEMO_ADDRESS, to, valueQuai: formatAmount(amount.amountWei) },
    };
  }

  const ctx = await writeRuntime(opts, deps);
  const { net, provider, from: fromAddress } = ctx;
  if(paymentRequest&&net.chainId!==9)throw new SendError('HPAY payments require Quai mainnet chain 9.');
  const to = assertCyprus1QuaiAddress(opts.to);
  let target = to;
  let spendWei;
  let data = '0x';
  let value;
  let action;
  let extraSummary = {};
  if(paymentRequest)extraSummary={paymentRequest:'HPAY · mainnet',memo:paymentRequest.memo||undefined,expiresAt:paymentRequest.expiresAt??undefined};

  if (opts.token) {
    const tokenAddress = await tokenAddressOf(opts.token, deps, net.name);
    const meta = await readErc20(provider, tokenAddress, fromAddress);
    const amount = parseAmount(opts.amount, { balanceWei: meta.balance, decimals: meta.decimals });
    if (amount.amountWei > meta.balance) {
      throw new SendError(`Insufficient ${meta.symbol} balance: have ${formatAmount(meta.balance, meta.decimals)}, tried to send ${formatAmount(amount.amountWei, meta.decimals)}.`);
    }
    data = ERC20_IFACE.encodeFunctionData('transfer', [to, amount.amountWei]);
    value = 0n;
    target = tokenAddress;
    spendWei = await tokenValueQuai(provider, tokenAddress, amount.amountWei, net.name, deps);
    action = `Send ${withAddr(meta.symbol, tokenAddress)}`;
    extraSummary = { recipient: to, token: withAddr(meta.symbol, tokenAddress), tokenAddress, tokenAmount: formatAmount(amount.amountWei, meta.decimals) };
  } else {
    let balanceWei;
    try {
      balanceWei = BigInt(await resilientRead(() => provider.getBalance(fromAddress), { primaryAttempts: 2 }));
    } catch (err) {
      throw new SendError(`Could not read balance: ${err?.message || err}`);
    }
    const amount = parseAmount(opts.amount, { balanceWei, decimals: 18 });
    value = amount.amountWei;
    if (amount.isAll) {
      // Sending the literal full balance as `value` leaves nothing for gas — reserve it first with
      // a zero-value gas estimate (a plain transfer's gas cost does not depend on the value moved).
      try {
        const [estimate, gasPrice] = await Promise.all([
          resilientRead(() => provider.estimateGas({ from: fromAddress, to, data: '0x', value: 0n }), { primaryAttempts: 2 }),
          readGasPrice(provider, net.rpcUrl),
        ]);
        const gasLimit = (BigInt(estimate) * 1200n) / 1000n;
        const fee = gasLimit * gasPrice;
        value = balanceWei - fee;
      } catch (err) {
        throw new SendError(`Could not reserve gas for "all": ${err?.message || err}`);
      }
      if (value <= 0n) throw new SendError('Balance is too low to cover gas for a send.');
    }
    if (value > balanceWei) {
      throw new SendError(`Insufficient QUAI balance: have ${formatAmount(balanceWei)}, tried to send ${formatAmount(value)}.`);
    }
    action = 'Send QUAI';
  }

  return writeVia(ctx, {
    to: target,
    spendWei,
    data,
    validateSimulation: opts.token ? (hex) => { if (ERC20_IFACE.decodeFunctionResult('transfer', hex)[0] !== true) throw new Error('Token transfer returned false.'); } : undefined,
    value,
    action,
    extraSummary,
    validateBeforeSubmit:paymentRequest&&paymentRequest.expiresAt!==null?()=>{if(paymentRequest.expiresAt*1000<=Date.now())throw new SendError('Payment request expired before signing.');}:undefined,
  }, SendError);
}

export function runSend(opts = {}, deps = {}) { return withProviderCleanup(deps, (runtimeDeps) => runSendCore(opts, runtimeDeps)); }
