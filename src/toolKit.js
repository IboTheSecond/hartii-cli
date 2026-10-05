// packages/hartii-cli/src/toolKit.js
//
// Small helpers shared by every write command: typed view calls, ERC-20 metadata/allowance reads,
// token-argument resolution, and an exact-amount approval step that runs through the same write
// pipeline (so it is simulated, summarised, confirmed and capped like any other write).
import { Interface } from 'quais';
import { resilientRead } from '../vendor/packages/agent-mcp/src/rpcClient.js';
import { ERC20_ABI } from './abi/erc20.js';
import { WriteError } from './writePipeline.js';
import { writeVia } from './commandContext.js';
import { formatAmount } from './amount.js';
import { withAddr } from './output.js';
import { assertCyprus1QuaiAddress } from './address.js';
import { resolveToken } from './marketApi.js';
import { needsApproval } from '../vendor/src/utils/tradeTx.js';

export const ERC20_IFACE = new Interface(ERC20_ABI);

/** One typed eth_call: view(provider, iface, to, 'fn', [args], from?) -> decoded Result. */
export async function view(provider, iface, to, fn, args = [], from) {
  const data = iface.encodeFunctionData(fn, args);
  const tx = from ? { from, to, data } : { to, data };
  const hex = await resilientRead(() => provider.call(tx), { primaryAttempts: 2 });
  return iface.decodeFunctionResult(fn, hex);
}

export async function readErc20(provider, token, owner) {
  const call = (fn, args = []) => view(provider, ERC20_IFACE, token, fn, args).then((r) => r[0]);
  const [symbol, decimals, balance] = await Promise.all([
    call('symbol').catch(() => '???'),
    call('decimals'),
    owner ? call('balanceOf', [owner]) : Promise.resolve(0n),
  ]);
  const d = Number(decimals);
  if (!Number.isInteger(d) || d < 0 || d > 77) throw new WriteError('Unsupported token decimals.');
  return { symbol: String(symbol), decimals: d, balance: BigInt(balance) };
}

export async function readAllowance(provider, token, owner, spender) {
  return BigInt((await view(provider, ERC20_IFACE, token, 'allowance', [owner, spender]))[0]);
}

/** A `--token` / CLI argument that is either a 0x address or an indexed ticker -> checksummed Cyprus-1 address. */
export async function tokenAddressOf(input, deps, network) {
  if (/^0x/i.test(input)) return assertCyprus1QuaiAddress(input);
  return assertCyprus1QuaiAddress((await resolveToken(input, { ...deps, network })).address);
}

/**
 * Ensures `spender` may pull `amount` of `token` from the connected wallet. If the allowance is
 * short, sends an EXACT-amount approve through the write pipeline. Returns:
 *   { needed: false }                      allowance already enough
 *   { needed: true, result }               approve ran (result is runWrite's result; check result.ok / dryRun)
 */
export async function ensureAllowance(ctx, { token, symbol, decimals, spender, amount, action, extraSummary = {}, ErrorClass = WriteError, beforeApprove }) {
  const allowance = await readAllowance(ctx.provider, token, ctx.from, spender);
  if (!needsApproval(allowance, amount)) return { needed: false };
  beforeApprove?.();
  const result = await writeVia(ctx, {
    to: token, data: ERC20_IFACE.encodeFunctionData('approve', [spender, amount]), value: 0n,
    validateSimulation: (hex) => { if (ERC20_IFACE.decodeFunctionResult('approve', hex)[0] !== true) throw new Error('Token approval returned false.'); },
    action: action || `Approve ${withAddr(symbol, token)}`,
    extraSummary: { token: withAddr(symbol, token), tokenAddress: token, spender, allowance: formatAmount(amount, decimals), ...extraSummary },
  }, ErrorClass, 'Approval failed: ');
  return { needed: true, result };
}

/**
 * After ensureAllowance: the result to return early (approval declined, or a dry run that can only
 * simulate the approval), or undefined when the real write should go ahead.
 */
export function approvalStop(approval, { dryRun, planKey, plan, note }) {
  if (!approval.needed) return undefined;
  if (!approval.result.ok) return approval.result;
  if (!dryRun) return undefined;
  return { ok: true, dryRun: true, tradeSimulated: false, ...(planKey && { [planKey]: plan }), summary: { ...approval.result.summary, note } };
}

/** Base-unit bigint -> JSON-safe decimal string. */
export const str = (v) => (v === null || v === undefined ? null : String(v));
