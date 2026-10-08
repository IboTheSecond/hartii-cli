// Real offline signing with an in-memory broadcast boundary. Never contacts a node.
import { Wallet, QuaiTransaction } from 'quais';

export function offlineWallet(key, provider, onBroadcast = async () => ({ wait: async () => ({ status: 1 }) })) {
  provider.broadcastTransaction = async (_zone, raw) => {
    const signed = QuaiTransaction.from(raw);
    const tx = Object.fromEntries(['from','to','data','value','gasLimit','gasPrice','nonce','chainId','accessList'].map(field => [field, signed[field]]));
    const result = await onBroadcast(tx);
    return { ...result, ...tx, hash: signed.hash, wait: async (...args) => {
      const receipt = await result.wait(...args);
      return receipt && { ...receipt, hash: signed.hash, ...(receipt.transactionHash === undefined ? {} : { transactionHash: signed.hash }) };
    } };
  };
  return new Wallet(key);
}
