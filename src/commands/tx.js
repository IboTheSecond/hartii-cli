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
import { listSpendReservations, inspectSpendLock } from '../spendingGuard.js';
import { getHartiiHome } from '../config.js';

export class TxError extends CliError {}

const HASH_RE = /^0x[0-9a-fA-F]{64}$/;

/**
 * @param {{ hash: string, home?: string, network?: string, rpc?: string, demo?: boolean }} opts
 * @param {{ providerFactory?: Function }} [deps]
 */
async function runTxCore(opts = {}, deps = {}) {
  if(opts.hash==='pending'){
    const home=opts.home||getHartiiHome();
    const pending=listSpendReservations(home);
    return {readOnly:true,pending,count:pending.length,lock:inspectSpendLock(home),note:pending.length?'These local reservations are unresolved; they do not prove a transaction is still pending on chain. Inspect each hash with hartii tx <hash>. Never delete reservations or retry a send without verified receipt and nonce reconciliation.':'No unresolved reservations in this profile.'};
  }
  if (!opts.hash) throw new TxError('Usage: hartii tx <hash> | hartii tx pending');
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

  const receiptStatus=receipt?.status;
  const status = receipt ? ([1,1n,'1','0x1'].includes(receiptStatus) ? 'success' : [0,0n,'0','0x0'].includes(receiptStatus) ? 'reverted' : 'unknown') : 'pending';
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
