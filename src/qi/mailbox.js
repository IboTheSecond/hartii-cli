// packages/hartii-cli/src/qi/mailbox.js
// The payment-channel mailbox contract: a sender posts notify(senderCode, receiverCode) once so the
// receiver can find the payment. Receiving reads getNotifications(myCode) to learn who paid us.
import { Contract, Interface, Wallet } from 'quais';
import { CliError } from '../errors.js';

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

/** `signerKey` is only needed to notify. The factory never stores or prints it. */
export function createMailbox({ provider, network, signerKey }) {
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
      const wallet = new Wallet(signerKey, provider);
      const contract = new Contract(address, MAILBOX_IFACE, wallet);
      const tx = await contract.notify(senderCode, receiverCode);
      const receipt = await tx.wait();
      if (!receipt || Number(receipt.status) !== 1) throw new QiMailboxError(`The payment notice did not confirm (tx ${tx.hash}).`);
      return { hash: tx.hash };
    },
  };
}
