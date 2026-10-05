// packages/hartii-cli/src/commands/airdrop.js
//
// `hartii airdrop --csv <file> [--token <addr|ticker>] [--amount <n>]` — HartiiAirdrop batch sender
// (contracts/contracts/HartiiAirdrop.sol in the Biome repo). QUAI by default, or one standard fee-less
// ERC-20. Lists are split into batches of <= 500 recipients (the contract's MAX_RECIPIENTS); each batch
// is its own transaction paying its own fee, read live from quoteFee(n). CSV rules mirror the Biome page
// (airdropCore.mjs parseRecipients): `address[,amount]`, optional header, duplicate addresses collapse
// only when the amount matches, Cyprus-1 Quai addresses only (Qi rejected), no zero amounts.
import { readFileSync, statSync } from 'node:fs';
import { Interface } from 'quais';
import { withAddr } from '../output.js';
import { WriteError } from '../writePipeline.js';
import { withProviderCleanup, toolsRuntime, writeVia } from '../commandContext.js';
import { assertCyprus1QuaiAddress } from '../address.js';
import { parseAmount, formatAmount } from '../amount.js';
import { tokenValueQuai } from '../tokenValue.js';
import { biomeAddress, ToolError } from '../biomeAddresses.js';
import { HARTII_AIRDROP_ABI } from '../abi/hartiiTools.js';
import { view, readErc20, ensureAllowance, approvalStop, tokenAddressOf } from '../toolKit.js';
import { resilientRead } from '../../vendor/packages/agent-mcp/src/rpcClient.js';
import { DEMO_ADDRESS, DEMO_NETWORK } from '../demoFixtures.js';

export class AirdropError extends ToolError {}

export const MAX_RECIPIENTS = 500;
export const MAX_ROWS = 10_000;
const MAX_CSV_BYTES = 2 * 1024 * 1024;
const IFACE = new Interface(HARTII_AIRDROP_ABI);

/**
 * Pure CSV parser. `decimals` is the asset's decimals; `sameAmount` (optional) is applied to every
 * address-only row. Returns { rows:[{address, amount:bigint}], errors:[{line, reason}], total, duplicates }.
 */
export function parseRecipientsCsv(text, decimals = 18, sameAmount = '') {
  const rows = [];
  const errors = [];
  const seen = new Map();
  let total = 0n;
  let duplicates = 0;
  const lines = String(text).replace(/^\ufeff/, '').split(/\r?\n/);
  if (lines.length > MAX_ROWS + 2) return { rows, errors: [{ line: 0, reason: `Limit ${MAX_ROWS} rows per plan.` }], total, duplicates };
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].trim()) continue;
    try {
      const cols = lines[i].split(',').map((v) => {
        const t = v.trim();
        if (t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1);
        if (t.includes('"')) throw new Error('Malformed CSV quotes.');
        return t;
      });
      if (rows.length === 0 && errors.length === 0 && /^address$/i.test(cols[0]) && (cols.length === 1 || (cols.length === 2 && /^amount$/i.test(cols[1])))) continue;
      const same = String(sameAmount || '').trim();
      if (cols.length > 2 || (same && cols.length !== 1)) throw new Error('Use address only (with --amount) or address,amount.');
      const address = assertCyprus1QuaiAddress(cols[0]);
      if (/^0x0{40}$/i.test(address)) throw new Error('Zero address is not a recipient.');
      const amount = parseAmount(same || cols[1] || '', { decimals }).amountWei;
      const key = address.toLowerCase();
      if (seen.has(key)) {
        if (seen.get(key) !== amount) throw new Error('Duplicate address has conflicting amounts; edit the source.');
        duplicates += 1;
        continue;
      }
      total += amount;
      seen.set(key, amount);
      rows.push({ address, amount });
    } catch (err) {
      errors.push({ line: i + 1, reason: err.message });
    }
  }
  if (!rows.length && !errors.length) errors.push({ line: 0, reason: 'Add at least one recipient.' });
  return { rows, errors, total, duplicates };
}

export function splitBatches(rows) {
  const out = [];
  for (let i = 0; i < rows.length; i += MAX_RECIPIENTS) out.push(rows.slice(i, i + MAX_RECIPIENTS));
  return out;
}

function readCsvFile(path) {
  let size;
  try { size = statSync(path).size; } catch { throw new AirdropError(`Cannot read CSV file "${path}".`); }
  if (size > MAX_CSV_BYTES) throw new AirdropError('CSV file is larger than 2 MB; split the list.');
  return readFileSync(path, 'utf8');
}

function planErrors(parsed) {
  if (!parsed.errors.length) return;
  const shown = parsed.errors.slice(0, 10).map((e) => `line ${e.line}: ${e.reason}`).join('; ');
  throw new AirdropError(`CSV has ${parsed.errors.length} invalid row(s): ${shown}${parsed.errors.length > 10 ? ' …' : ''}`, { errors: parsed.errors });
}

function stripReceipt(r) {
  return { ok: r.ok, aborted: r.aborted || undefined, dryRun: r.dryRun || undefined, txHash: r.txHash, status: r.status, quaiscanUrl: r.quaiscanUrl, summary: r.summary };
}

async function runAirdropCore(opts, deps = {}) {
  if (!opts.csv || opts.csv === true) throw new AirdropError('Usage: hartii airdrop --csv <file> [--token <addr|ticker>] [--amount <n>]');

  if (opts.demo) {
    const parsed = parseRecipientsCsv(readCsvFile(opts.csv), 18, opts.amount || '');
    planErrors(parsed);
    const batches = splitBatches(parsed.rows);
    const fee = batches.reduce((s, b) => s + 10n ** 18n + 5n * 10n ** 16n * BigInt(b.length), 0n);
    return {
      ok: true, dryRun: true, demo: true,
      summary: { action: 'Airdrop (demo)', network: DEMO_NETWORK, from: DEMO_ADDRESS, recipients: String(parsed.rows.length), batches: String(batches.length), total: formatAmount(parsed.total), feeQuai: formatAmount(fee) },
    };
  }

  const ctx = await toolsRuntime(opts, deps);
  const { net, provider, from } = ctx;
  const { address: contract, source } = await biomeAddress('airdrop', { ...deps, network: net.name });

  // Asset: QUAI or one ERC-20.
  let asset = { kind: 'native', symbol: 'QUAI', decimals: 18, address: null, balance: 0n };
  if (opts.token) {
    const tokenAddress = await tokenAddressOf(opts.token, deps, net.name);
    asset = { kind: 'erc20', address: tokenAddress, ...(await readErc20(provider, tokenAddress, from)) };
  }

  const parsed = parseRecipientsCsv(readCsvFile(opts.csv), asset.decimals, opts.amount || '');
  planErrors(parsed);
  const batches = splitBatches(parsed.rows);

  if ((await view(provider, IFACE, contract, 'paused'))[0]) throw new AirdropError('HartiiAirdrop is paused.');

  // Fees are read live, per batch size.
  const fees = [];
  for (const b of batches) fees.push(BigInt((await view(provider, IFACE, contract, 'quoteFee', [b.length]))[0]));
  const totalFees = fees.reduce((a, b) => a + b, 0n);

  const nativeBalance = BigInt(await resilientRead(() => provider.getBalance(from), { primaryAttempts: 2 }));
  if (asset.kind === 'erc20' && parsed.total > asset.balance) {
    throw new AirdropError(`Insufficient ${asset.symbol}: have ${formatAmount(asset.balance, asset.decimals)}, plan needs ${formatAmount(parsed.total, asset.decimals)}.`);
  }
  const needNative = totalFees + (asset.kind === 'native' ? parsed.total : 0n);
  if (nativeBalance < needNative) {
    throw new AirdropError(`Insufficient QUAI: have ${formatAmount(nativeBalance)}, plan needs ${formatAmount(needNative)} (amounts + ${formatAmount(totalFees)} service fees) plus gas.`);
  }

  const plan = {
    contract, addressSource: source, asset: withAddr(asset.symbol, asset.address), recipients: parsed.rows.length, duplicatesCollapsed: parsed.duplicates,
    batches: batches.length, total: formatAmount(parsed.total, asset.decimals), serviceFeesQuai: formatAmount(totalFees),
  };
  const results = [];

  // One exact approval covering the whole plan (HartiiAirdrop pulls each batch with transferFrom).
  if (asset.kind === 'erc20') {
    const approval = await ensureAllowance(ctx, {
      token: asset.address, symbol: asset.symbol, decimals: asset.decimals, spender: contract, amount: parsed.total,
      extraSummary: { plannedAction: `Airdrop ${plan.total} ${asset.symbol} to ${plan.recipients} recipients` }, ErrorClass: AirdropError,
    });
    const stop = approvalStop(approval, { dryRun: opts.dryRun, planKey: 'plan', plan, note: 'Approval simulated only (--dry-run) — re-run without --dry-run to approve and send.' });
    if (stop) return stop;
  }

  for (let i = 0; i < batches.length; i += 1) {
    const rows = batches[i];
    const addresses = rows.map((r) => r.address);
    const amounts = rows.map((r) => r.amount);
    const batchTotal = amounts.reduce((a, b) => a + b, 0n);
    const fee = BigInt((await view(provider, IFACE, contract, 'quoteFee', [rows.length]))[0]); // re-read: never sign a stale fee
    if (fee !== fees[i]) throw new AirdropError('Service fee changed while preparing; re-run to review the new fee.');
    const native = asset.kind === 'native';
    const data = native
      ? IFACE.encodeFunctionData('airdropQuai', [addresses, amounts])
      : IFACE.encodeFunctionData('airdropToken', [asset.address, addresses, amounts]);
    const value = native ? batchTotal + fee : fee;
    let spendWei = value;
    if (!native) spendWei = fee + (await tokenValueQuai(provider, asset.address, batchTotal, net.name, deps));
    try {
      const r = await writeVia(ctx, {
        to: contract, data, value, spendWei,
        action: `Airdrop ${withAddr(asset.symbol, asset.address)} (batch ${i + 1}/${batches.length})`,
        extraSummary: { contract, addressSource: source, recipients: String(rows.length), total: formatAmount(batchTotal, asset.decimals), asset: withAddr(asset.symbol, asset.address), serviceFeeQuai: formatAmount(fee) },
      });
      results.push({ batch: i + 1, recipients: rows.length, ...stripReceipt(r) });
      if (!r.ok) break;
    } catch (err) {
      const done = results.filter((x) => x.status === 'success').map((x) => `batch ${x.batch}: ${x.txHash}`).join(', ');
      if (err instanceof WriteError) throw new AirdropError(`Batch ${i + 1}/${batches.length} failed: ${err.message}${done ? ` Already sent: ${done}.` : ''}`, { results });
      throw err;
    }
  }
  const ok = results.length > 0 && results.every((r) => r.ok);
  return { ok, dryRun: Boolean(opts.dryRun), plan, batches: results };
}

export function runAirdrop(opts = {}, deps = {}) { return withProviderCleanup(deps, (d) => runAirdropCore(opts, d)); }
