// A Quai-shaped, offline stand-in for the Orchard Cyprus-1 node, at the quais provider-method level.
// Shapes follow what the live node returned (HARTII-PELAGUS-NOTES.md):
//  - blocks carry number/hash only in woHeader;
//  - outpoints are {denomination, index, lock, txHash} HEX quantities on the wire, formatted by quais to
//    {txhash, index, denomination, lock} numbers (we keep the hex form and convert the same way);
//  - Qi transactions come back with inputs[].previousOutPoint and an UNCOMPRESSED (0x04, 65-byte) pubKey;
//  - fees come from estimateFeeForQi; receipts have a status.
// Real signing is exercised: broadcastTransaction decodes the signed bytes with QiTransaction.from.
import { QiTransaction, computeAddress, SigningKey } from 'quais';
import { DENOMS } from '../../src/qi/select.js';

const hex = (n) => '0x' + BigInt(n).toString(16);

export function createQiNode({ head = 8_000_000, feeQit = 8n } = {}) {
  const state = {
    head, feeQit, outpointsRaw: new Map(), txs: new Map(), broadcasts: 0, receiptMode: 'ok', broadcastError: null,
    quaiBalance: 5_000_000_000_000_000_000n, estimateCalls: 0, log: [],
  };
  const key = (a) => String(a).toLowerCase();
  const fmt = (list) => list.map((o) => ({ txhash: o.txHash, index: Number(BigInt(o.index)), denomination: Number(BigInt(o.denomination)), lock: Number(BigInt(o.lock)) }));
  const addNote = (address, { denomination, lock = 0, txHash, index = 0 }) => {
    const k = key(address);
    const list = state.outpointsRaw.get(k) || [];
    list.push({ denomination: hex(denomination), index: hex(index), lock: hex(lock), txHash: txHash || '0x' + (state.outpointsRaw.size + list.length + 1).toString(16).padStart(64, '0') });
    state.outpointsRaw.set(k, list);
  };
  let n = 0;
  const provider = {
    state,
    destroy() {},
    async getNetwork() { return { chainId: 15000n }; },
    async getBlock() { return { hash: '0x' + '9'.repeat(64), woHeader: { number: state.head } }; },
    async getBlockNumber() { return state.head; },
    async getBalance() { return state.quaiBalance; },
    async getCode() { return '0x6080'; },
    async getOutpointsByAddress(a) { return fmt(state.outpointsRaw.get(key(a)) || []); },
    async getOutpointsByAddresses(addresses) {
      const m = new Map();
      for (const a of addresses) m.set(a, fmt(state.outpointsRaw.get(key(a)) || []));
      return m;
    },
    async estimateFeeForQi(tx) {
      state.estimateCalls += 1;
      // the wire shape the node expects
      if (!tx.txIn?.length || !tx.txIn.every((i) => i.previousOutpoint?.txHash && /^0x/.test(i.previousOutpoint.index))) throw new Error('bad txIn');
      if (!tx.txOut.every((o) => /^0x/.test(o.denomination))) throw new Error('bad txOut');
      return state.feeQit * BigInt(tx.txIn.length + tx.txOut.length) / 3n || 1n;
    },
    async broadcastTransaction(_zone, raw) {
      state.broadcasts += 1;
      if (state.broadcastError) throw new Error(state.broadcastError);
      const tx = QiTransaction.from(raw);
      if (!tx.signature) throw new Error('unsigned');
      // inputs must be uncompressed-key shaped on the way back out, like the node serves them
      const inputs = tx.txInputs.map((i) => ({ previousOutPoint: { txHash: i.txhash, index: hex(i.index) }, pubKey: SigningKey.computePublicKey(i.pubkey, false) }));
      state.txs.set(tx.hash, { inputs, outputs: tx.txOutputs, raw });
      for (const i of tx.txInputs) {
        const a = key(computeAddress(i.pubkey));
        state.outpointsRaw.set(a, (state.outpointsRaw.get(a) || []).filter((o) => !(o.txHash === i.txhash && BigInt(o.index) === BigInt(i.index))));
      }
      if (state.receiptMode !== 'never-lands') {
        tx.txOutputs.forEach((o, idx) => addNote(o.address, { denomination: o.denomination, lock: 0, txHash: tx.hash, index: idx }));
      }
      n += 1;
      return { hash: tx.hash };
    },
    async getTransactionReceipt(hash) {
      if (state.receiptMode === 'none' || state.receiptMode === 'never-lands') return null;
      if (state.receiptMode === 'throw') throw new Error('rpc down');
      if (!state.txs.has(hash)) return null;
      return { hash, status: state.receiptMode === 'revert' ? 0 : 1 };
    },
  };
  return { provider, state, addNote, DENOMS };
}
