// packages/hartii-cli/src/qi/port.js
// The one place that touches the quais QiHDWallet. Everything else (engine, command) talks to this small
// "port", so tests can swap it and the library's internals stay in one file.
// Library quirks handled here: it console.logs during scans/fee checks (silenced), it keeps address
// state only in memory (the local ledger fills the gap), and its one-shot sendTransaction broadcasts
// without a review step (we select notes, show a review, sign and broadcast ourselves).
import { QiHDWallet, QiTransaction, Zone, AddressStatus, toShard } from 'quais';
import { CliError } from '../errors.js';
import { DENOMS } from './select.js';

export class QiPortError extends CliError {}

export async function quiet(fn) {
  const saved = { log: console.log, warn: console.warn, info: console.info, debug: console.debug };
  console.log = console.warn = console.info = console.debug = () => {};
  try { return await fn(); } finally { Object.assign(console, saved); }
}

const lower = (a) => String(a).toLowerCase();

export function createQiPort({ mnemonic, provider, ledger, zone = Zone.Cyprus1, wallet: given }) {
  const wallet = given || QiHDWallet.fromMnemonic(mnemonic); // `wallet`: test seam (a pre-derived wallet)
  wallet.connect(provider);
  const shard = toShard(zone);

  const onChainUsed = async (address) => {
    const outs = await provider.getOutpointsByAddress(address);
    return Array.isArray(outs) && outs.length > 0;
  };
  const fresh = async (derive, count) => {
    const out = [];
    let guard = 0;
    while (out.length < count) {
      if (++guard > 500) throw new QiPortError('Could not find unused Qi addresses. Try again in a moment.');
      const address = derive();
      if (ledger.has(address) || out.includes(address)) continue;
      if (await onChainUsed(address)) { ledger.add([address]); continue; }
      out.push(address);
    }
    return out;
  };
  const unusedFromWallet = (bip44) => bip44.getAddressesInZone(zone)
    .filter((a) => a.account === 0 && a.status === AddressStatus.UNUSED && !ledger.has(a.address))
    .sort((a, b) => a.index - b.index).map((a) => a.address);

  const noteList = (blockNumber) => wallet.getOutpoints(zone).map((o) => {
    const lock = Number(o.outpoint.lock ?? 0);
    const denomination = Number(o.outpoint.denomination);
    return {
      txHash: o.outpoint.txhash, index: Number(o.outpoint.index), denomination,
      valueQit: DENOMS[denomination], address: o.address, lock,
      locked: lock !== 0 && !(lock < blockNumber),
    };
  });

  const selectionFor = (sel, spendAddrs, changeAddrs) => ({
    inputs: sel.inputs.map((n) => ({ txhash: n.txHash, index: n.index, address: n.address, denomination: n.denomination })),
    spendOutputs: sel.spendDenoms.map((d) => ({ denomination: d })),
    changeOutputs: sel.changeDenoms.map((d) => ({ denomination: d })),
  });

  return {
    paymentCode: wallet.getPaymentCode(0),
    async blockNumber() {
      const block = await provider.getBlock(shard, 'latest');
      const n = block?.woHeader?.number;
      if (n === undefined || n === null) throw new QiPortError('The node did not return a block height.');
      return Number(n);
    },
    /** Opens a channel per sender that left a notice, then scans. A bad code from the mailbox is skipped. */
    async sync(senderCodes = []) {
      for (const code of senderCodes) { try { wallet.openChannel(code); } catch { /* not a valid code: ignore */ } }
      await quiet(() => wallet.scan(zone, 0));
      const block = await this.blockNumber();
      const notes = noteList(block);
      ledger.add(notes.map((n) => n.address));
      return { blockNumber: block, notes };
    },
    async receiveAddress() {
      const existing = unusedFromWallet(wallet.externalBip44);
      for (const a of existing) { if (!(await onChainUsed(a))) return a; ledger.add([a]); }
      return (await fresh(() => wallet.getNextAddressSync(0, zone).address, 1))[0];
    },
    async changeAddresses(count) {
      if (count === 0) return [];
      const pool = unusedFromWallet(wallet.changeBip44);
      const out = [];
      for (const a of pool) { if (out.length >= count) break; if (!(await onChainUsed(a))) out.push(a); }
      if (out.length < count) out.push(...await fresh(() => wallet.getNextChangeAddressSync(0, zone).address, count - out.length));
      return out;
    },
    async sendAddresses(recipient, count) {
      if (recipient.kind === 'qi-address') return Array(count).fill(recipient.value);
      wallet.openChannel(recipient.value);
      return fresh(() => wallet.getNextSendAddress(recipient.value, zone).address, count);
    },
    async estimateFee(sel, spendAddrs, changeAddrs) {
      const selection = selectionFor(sel);
      const pubs = sel.inputs.map((n) => wallet.getAddressInfo(n.address)?.pubKey);
      if (pubs.some((p) => !p)) throw new QiPortError('A note in this wallet has no known key. Run the command again so the wallet can rescan.');
      const tx = wallet.prepareFeeEstimationTransaction(selection, pubs, spendAddrs, changeAddrs);
      return BigInt(await quiet(() => provider.estimateFeeForQi(tx)));
    },
    /** Builds and signs offline, then checks the bytes match the reviewed plan before anything is sent. */
    async buildSigned(sel, spendAddrs, changeAddrs, chainId) {
      const selection = selectionFor(sel);
      const tx = await wallet.prepareTransaction(selection, spendAddrs, changeAddrs, Number(chainId));
      const wantIn = sel.inputs.map((n) => `${lower(n.txHash)}:${n.index}`);
      const gotIn = tx.txInputs.map((i) => `${lower(i.txhash)}:${Number(i.index)}`);
      const outSum = tx.txOutputs.reduce((s, o) => s + DENOMS[Number(o.denomination)], 0n);
      if (wantIn.join() !== gotIn.join() || tx.txOutputs.length !== spendAddrs.length + changeAddrs.length
        || outSum + sel.feeQit !== sel.totalInQit) throw new QiPortError('The transaction built does not match the reviewed plan. Nothing was sent.');
      const raw = await quiet(() => wallet.signTransaction(tx));
      const signed = QiTransaction.from(raw);
      return { raw, hash: signed.hash };
    },
    async broadcast(raw) {
      const sent = await provider.broadcastTransaction(zone, raw);
      return sent?.hash;
    },
    async receipt(hash) {
      return provider.getTransactionReceipt(hash);
    },
  };
}
