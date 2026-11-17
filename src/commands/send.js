// Native or ERC20 send. Token sends resolve tickers and require a live QUAI valuation.
import { withAddr } from '../output.js';
import { withProviderCleanup, writeRuntime, writeVia } from '../commandContext.js';
import { tokenValueQuai } from '../tokenValue.js';
import { assertCyprus1QuaiAddress } from '../address.js';
import { parseAmount, formatAmount } from '../amount.js';
import { resilientRead } from '../../vendor/packages/agent-mcp/src/rpcClient.js';
import { reserveFeeWei } from '../gasReserve.js';
import { ERC20_IFACE, readErc20, tokenAddressOf } from '../toolKit.js';
import { DEMO_ADDRESS, DEMO_NETWORK } from '../demoFixtures.js';
import { CliError } from '../errors.js';
import { tradeWarnings } from '../trade.js';
import { findContactByName, addContact, hasContactsFile, ContactError } from '../contacts.js';
import { readVisibleInput } from '../prompt.js';
import { shortAddress } from '../address.js';
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
  // A saved contact name resolves to its address; the review still shows the full address and the contact name.
  let toInput = opts.to;
  if (!/^0x/i.test(String(toInput).trim())) {
    if (hasContactsFile(ctx.home)) await ctx.unlockData?.();
    const contact = hasContactsFile(ctx.home) ? findContactByName(ctx.home, toInput) : null;
    if (!contact) throw new SendError(`"${String(toInput).slice(0, 40)}" is not an address and not a saved contact. Use a 0x address, or save one first: hartii contacts add <name> <address>`);
    toInput = contact.address;
  }
  const to = assertCyprus1QuaiAddress(toInput);
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
      // Sending the literal full balance as `value` leaves nothing for gas. Reserve it from estimates of the
      // REAL transfer shape: a value transfer to a never-seen account costs about twice a value:0 call, so
      // estimate both value 0 and value 1 and hold back the higher (plus the pipeline's 1.2x buffer and a margin).
      try {
        const fee = await reserveFeeWei(provider, net.rpcUrl, [
          { from: fromAddress, to, data: '0x', value: 0n },
          { from: fromAddress, to, data: '0x', value: 1n },
        ]);
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

  const result = await writeVia(ctx, {
    to: target,
    spendWei,
    recipient: to,
    warnings: opts.token ? tradeWarnings({ tickers: [opts.token] }) : [],
    data,
    validateSimulation: opts.token ? (hex) => { if (ERC20_IFACE.decodeFunctionResult('transfer', hex)[0] !== true) throw new Error('Token transfer returned false.'); } : undefined,
    value,
    action,
    extraSummary,
    validateBeforeSubmit:paymentRequest&&paymentRequest.expiresAt!==null?()=>{if(paymentRequest.expiresAt*1000<=Date.now())throw new SendError('Payment request expired before signing.');}:undefined,
  }, SendError);
  await offerContact(ctx, result, opts, deps);
  return result;
}

/** After a successful send to an address you had never paid: offer to save it (interactive only; never fails the send). */
async function offerContact(ctx, result, opts, deps) {
  if (!result?.ok || !result.newRecipient || opts.json || opts.yes) return;
  const ask = deps.io?.offerContactFn || (process.stdin.isTTY && process.stdout.isTTY ? (q) => readVisibleInput(q, { stdout: process.stderr }) : null);
  if (!ask) return;
  try {
    const name = String(await ask(`Save ${shortAddress(result.newRecipient)} as a contact? Type a name, or press Enter to skip: `) ?? '').trim();
    if (!name) return;
    const saved = addContact(ctx.home, name, result.newRecipient);
    result.contactSaved = saved.name;
  } catch (error) {
    try { process.stderr.write(`Contact not saved: ${error instanceof ContactError ? error.message : 'unexpected error'}
`); } catch { /* stderr closed */ }
  }
}

export function runSend(opts = {}, deps = {}) { return withProviderCleanup(deps, (runtimeDeps) => runSendCore(opts, runtimeDeps)); }
