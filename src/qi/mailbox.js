// packages/hartii-cli/src/qi/mailbox.js
// The payment-channel mailbox contract: a sender posts notify(senderCode, receiverCode) once so the
// receiver can find the payment. Receiving reads getNotifications(myCode) to learn who paid us.
import { Contract, Interface, Wallet } from 'quais';
import { CliError } from '../errors.js';
import { runWrite } from '../writePipeline.js';
import { buildReviewedWallet } from '../commandContext.js';

export class QiMailboxError extends CliError {}

export const MAILBOX_ADDRESSES = {
  orchard: '0x004C82298b3ED69a949008d7037918B13A4260c5',
  mainnet: '0x004C82298b3ED69a949008d7037918B13A4260c5', // same constant the wallet build ships; verified by code check at use
};
const ABI = [
  'function notify(string senderPaymentCode, string receiverPaymentCode)',
  'function getNotifications(string receiverPaymentCode) view returns (string[])',
];
export const MAILBOX_IFACE = new Interface(ABI);

/**
 * `signerKey` is only needed to notify. The factory never stores or prints it.
 * `run` carries what the shared write pipeline needs for the notice: { home, chainId, rpcUrl, unlockData, walletFactory, io }.
 */
export function createMailbox({ provider, network, signerKey, run = {} }) {
  const address = MAILBOX_ADDRESSES[network];
  const read = () => new Contract(address, MAILBOX_IFACE, provider);
  return {
    address,
    async available() {
      const code = await provider.getCode(address);
      return typeof code === 'string' && code !== '0x' && code.length > 2;
    },
    async notifications(receiverCode) {
      const list = await read().getNotifications(receiverCode);
      return Array.from(list || []).map(String);
    },
    async hasNotified(senderCode, receiverCode) {
      return (await this.notifications(receiverCode)).includes(senderCode);
    },
    /** Sends the notice and requires a status-1 receipt. */
    async notify(senderCode, receiverCode) {
      if (!signerKey) throw new QiMailboxError('No signer for the notification.');
      if (!run.home || run.chainId === undefined) throw new QiMailboxError('The payment notice needs the local data folder and chain; refusing to send it outside the write pipeline.');
      // R3-F4: a real QUAI transaction, so it goes through the SAME pipeline as every other write: chain pin, simulation,
      // access list, fee ceiling, spend reservation, the write lock and the offline-signing wallet. The user already
      // confirmed the whole Qi send (the question names the notice), and the Qi caps were checked in Qi.
      const from = new Wallet(signerKey).address;
      const wallet = buildReviewedWallet({
        provider, from, chainId: run.chainId, walletFactory: run.walletFactory, io: run.io,
        getPrivateKey: async () => signerKey,
      });
      const result = await runWrite({
        wallet, provider, network: { name: network, chainId: run.chainId, rpcUrl: run.rpcUrl }, home: run.home, limits: {},
        to: address, data: MAILBOX_IFACE.encodeFunctionData('notify', [senderCode, receiverCode]), value: 0n,
        action: 'Announce Qi payment (payment notice)', unlockData: run.unlockData,
        io: { write: () => {}, writeErr: () => {}, confirmFn: async () => true, now: run.io?.now, maxFeeWei: run.io?.maxFeeWei },
      }).catch((e) => { throw new QiMailboxError(String(e?.message || e).split(/\r?\n/)[0]); });
      if (!result?.ok || !result.txHash) throw new QiMailboxError('The payment notice was not sent.');
      return { hash: result.txHash };
    },
  };
}
