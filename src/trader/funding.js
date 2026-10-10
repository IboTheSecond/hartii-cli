import { Zone } from 'quais';
import { TraderError } from '../../vendor/packages/hartii-trader/src/index.mjs';
import { readRuntime,withProviderCleanup } from '../commandContext.js';
import { createProvider } from '../signer.js';
import { assertCyprus1QuaiAddress } from '../address.js';
const HASH=/^0x[0-9a-fA-F]{64}$/;
const same=(a,b)=>typeof a==='string' && typeof b==='string' && a.toLowerCase()===b.toLowerCase();
function uint(value) {
  if(typeof value==='bigint' && value>=0n)return value;
  if(typeof value==='number' && Number.isSafeInteger(value) && value>=0)return BigInt(value);
  if(typeof value==='string' && /^(?:0|[1-9][0-9]*|0x[0-9a-fA-F]+)$/.test(value))return BigInt(value);
  throw new TraderError('funding-invalid-chain-quantity');
}
/** Explicit direct native transfers only. No balance-difference anchoring or caller amounts. */
export async function readFundingTransaction({txHash,tradingWallet,managedHashes=[],...opts},deps={}) {
  if(!HASH.test(txHash || ''))throw new TraderError('funding-transaction-hash-required');
  if(managedHashes.some(hash=>same(hash,txHash)))throw new TraderError('managed-transaction-is-not-funding');
  const wallet=assertCyprus1QuaiAddress(tradingWallet);
  return withProviderCleanup(deps,async runtimeDeps=>{
    const runtime=readRuntime(opts,runtimeDeps);
    if(runtime.net.chainId!==9)throw new TraderError('funding-wrong-network');
    const provider=(runtimeDeps.providerFactory || createProvider)(runtime.net.rpcUrl);
    if(uint((await provider.getNetwork()).chainId)!==9n)throw new TraderError('funding-wrong-network');
    const [tx,receipt,head]=await Promise.all([provider.getTransaction(txHash),provider.getTransactionReceipt(txHash),provider.getBlockNumber(Zone.Cyprus1)]);
    if(!tx || !receipt || !same(tx.hash,txHash) || !same(receipt.hash || receipt.transactionHash,txHash) || uint(tx.chainId)!==9n ||
      !same(receipt.from,tx.from) || !same(receipt.to,tx.to) || !same(tx.blockHash,receipt.blockHash) || !HASH.test(receipt.blockHash || ''))throw new TraderError('funding-transaction-identity-mismatch');
    if(![1,1n,'1','0x1'].includes(receipt.status) || tx.data!=='0x')throw new TraderError('funding-requires-successful-direct-native-transfer');
    assertCyprus1QuaiAddress(tx.from);assertCyprus1QuaiAddress(tx.to);uint(tx.nonce);
    const blockNumber=uint(receipt.blockNumber);
    if(tx.blockNumber!=null && uint(tx.blockNumber)!==blockNumber || uint(head)<blockNumber+20n || blockNumber>BigInt(Number.MAX_SAFE_INTEGER))throw new TraderError('funding-receipt-not-final');
    const block=await provider.getBlock(Zone.Cyprus1,Number(blockNumber));
    if(!block || !same(block.hash || block.woHeader?.hash,receipt.blockHash) || uint(block.woHeader?.number ?? block.number)!==blockNumber ||
      !Array.isArray(block.transactions) || !block.transactions.some(hash=>same(typeof hash==='string'?hash:hash?.hash,txHash)))throw new TraderError('funding-block-not-canonical');
    const seconds=uint(block.woHeader?.timestamp ?? block.timestamp),now=deps.clock?.() ?? Date.now();
    if(seconds>BigInt(Number.MAX_SAFE_INTEGER)/1000n || seconds*1000n>BigInt(now))throw new TraderError('funding-block-time-unavailable');
    const incoming=same(tx.to,wallet) && !same(tx.from,wallet),outgoing=same(tx.from,wallet) && !same(tx.to,wallet);
    if(!incoming && !outgoing)throw new TraderError('funding-wallet-mismatch');
    const amount=uint(tx.value);
    if(amount===0n)throw new TraderError('funding-positive-transfer-required');
    let gas=0n;
    if(outgoing) {
      gas=receipt.fee!=null?uint(receipt.fee):uint(receipt.gasUsed)*uint(receipt.gasPrice ?? receipt.effectiveGasPrice);
      if(gas===0n)throw new TraderError('funding-gas-unavailable');
    }
    const observedCashWei=uint(await provider.getBalance(wallet)).toString();
    if(uint((await provider.getNetwork()).chainId)!==9n)throw new TraderError('funding-wrong-network');
    return {flow:{id:`funding-${txHash.slice(2).toLowerCase()}`,direction:incoming?'deposit':'withdrawal',amountWei:amount.toString(),gasWei:gas.toString(),at:Number(seconds)*1000},observedCashWei,checkedAt:now};
  });
}
