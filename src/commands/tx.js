import { redactUrls } from '../output.js';
import { withProviderCleanup } from '../commandContext.js';
// packages/hartii-cli/src/commands/tx.js
//
// `hartii tx <hash>` — look up one transaction's status. Read-only; never needs a wallet/keystore.
import { createProvider } from '../signer.js';
import { formatAmount } from '../amount.js';
import { quaiscanTxUrl } from '../quaiscan.js';
import { resilientRead } from '../../vendor/packages/agent-mcp/src/rpcClient.js';
import { DEMO_NETWORK } from '../demoFixtures.js';
import { readRuntime } from '../commandContext.js';
import { CliError } from '../errors.js';

export class TxError extends CliError {}

const HASH_RE = /^0x[0-9a-fA-F]{64}$/;

/**
 * @param {{ hash: string, home?: string, network?: string, rpc?: string, demo?: boolean }} opts
 * @param {{ providerFactory?: Function }} [deps]
 */
async function runTxCore(opts = {}, deps = {}) {
  if (!opts.hash) throw new TxError('Usage: hartii tx <hash>');
  if (!HASH_RE.test(opts.hash)) throw new TxError(`"${opts.hash}" is not a well-formed 32-byte transaction hash.`);

  if (opts.demo) {
    return {
      hash: opts.hash, network: DEMO_NETWORK, status: 'success', blockNumber: 10400000,
      from: '0x0000000000000000000000000000000000000d12', to: '0x0000000000000000000000000000000000000d04',
      valueQuai: '5.0', gasUsed: '98234', quaiscanUrl: quaiscanTxUrl(DEMO_NETWORK, opts.hash),
    };
  }

  const { net } = readRuntime(opts, deps);
  const providerFactory = deps.providerFactory || createProvider;
  const provider = providerFactory(net.rpcUrl);

  let transaction;
  try {
    transaction = await resilientRead(() => provider.getTransaction(opts.hash), { primaryAttempts: 2 });
  } catch (err) {
    throw new TxError(`Could not read ${opts.hash} from ${redactUrls(net.rpcUrl)}: ${redactUrls(err?.message || err)}`);
  }
  if (!transaction) {
    return { hash: opts.hash, network: net.name, status: 'not found', quaiscanUrl: quaiscanTxUrl(net.name, opts.hash) };
  }

  let receipt = null;
  try {
    receipt = await resilientRead(() => provider.getTransactionReceipt(opts.hash), { primaryAttempts: 2 });
  } catch {
    throw new TxError('Receipt lookup unavailable; transaction status is unknown.');
  }

  const status = receipt ? (Number(receipt.status) === 1 ? 'success' : Number(receipt.status) === 0 ? 'reverted' : 'unknown') : 'pending';
  return {
    hash: opts.hash,
    network: net.name,
    status,
    blockNumber: receipt?.blockNumber ?? transaction.blockNumber ?? null,
    from: transaction.from,
    to: transaction.to,
    valueQuai: formatAmount(BigInt(transaction.value || 0n)),
    gasUsed: receipt?.gasUsed != null ? String(receipt.gasUsed) : null,
    quaiscanUrl: quaiscanTxUrl(net.name, opts.hash),
  };
}

export function runTx(opts = {}, deps = {}) { return withProviderCleanup(deps, (runtimeDeps) => runTxCore(opts, runtimeDeps)); }
