// packages/hartii-cli/src/qi/engine.js
// Qi wallet logic on top of a "port" (src/qi/port.js) and a mailbox. No prompts, no printing, no secrets:
// the command layer owns those. Qi sends do not go through writePipeline (that is the EVM pipeline); this
// follows the same spirit: validate -> build -> review -> confirm -> broadcast -> receipt status 1 or no success.
import { CliError } from '../errors.js';
import { quaiscanTxUrl } from '../quaiscan.js';
import { DENOMS, selectNotes } from './select.js';
import { formatQi } from './units.js';

export class QiSendError extends CliError {}

/** The quais library pays 2 x (estimate + 10%), which is what Pelagus and the node accepted on Orchard. Tune after live runs. */
export const FEE_NUM = 22n;
export const FEE_DEN = 10n;
export const FIRST_FEE_GUESS_QIT = 15n;
export const NOTIFY_FALLBACK_COST_WEI = 20_000_000_000_000_000n; // 0.02 QUAI when gas cannot be estimated

const bySize = (a, b) => (a.valueQit < b.valueQit ? -1 : a.valueQit > b.valueQit ? 1 : 0);

export async function syncWallet(port, mailbox, { warn } = {}) {
  let codes = [];
  try {
    if (mailbox && await mailbox.available()) codes = await mailbox.notifications(port.paymentCode);
    else warn?.('The payment-notice contract was not found on this network, so Qi from new payment-code senders may not show up yet.');
  } catch {
    warn?.('Could not read payment notices; Qi from new payment-code senders may not show up yet.');
  }
  return port.sync(codes);
}

/** Notes grouped by size, spendable vs locked. */
export function summariseNotes(notes) {
  const spendable = notes.filter((n) => !n.locked);
  const locked = notes.filter((n) => n.locked);
  const sum = (l) => l.reduce((s, n) => s + n.valueQit, 0n);
  const bySizeMap = new Map();
  for (const n of notes) {
    const k = String(n.valueQit);
    const row = bySizeMap.get(k) || { sizeQit: n.valueQit, spendable: 0, locked: 0 };
    if (n.locked) row.locked += 1; else row.spendable += 1;
    bySizeMap.set(k, row);
  }
  return {
    spendableQit: sum(spendable), lockedQit: sum(locked), totalQit: sum(notes),
    bySize: [...bySizeMap.values()].sort((a, b) => (a.sizeQit < b.sizeQit ? 1 : -1)),
  };
}

function groupDenoms(list) {
  const m = new Map();
  for (const i of list) m.set(i, (m.get(i) || 0) + 1);
  return [...m.entries()].map(([i, count]) => ({ sizeQit: DENOMS[i], count }));
}

/**
 * Builds the reviewed plan for one send. Does not sign, broadcast or notify.
 * @returns {{summary:object, plan:object}}
 */
export async function planSend({ port, mailbox, quai, recipient, amountQit, net, fromCode, notes, beta }) {
  const warnings = [];
  const sel = (fee) => selectNotes({ notes, amountQit, feeQit: fee });
  let fee = FIRST_FEE_GUESS_QIT;
  let selection;
  let spendAddrs = [];
  let changeAddrs = [];
  let settled = false;
  for (let attempt = 0; attempt < 6 && !settled; attempt += 1) {
    selection = sel(fee);
    if (spendAddrs.length < selection.spendDenoms.length) spendAddrs = await port.sendAddresses(recipient, selection.spendDenoms.length);
    if (changeAddrs.length < selection.changeDenoms.length) changeAddrs = await port.changeAddresses(selection.changeDenoms.length);
    const est = await port.estimateFee(selection, spendAddrs.slice(0, selection.spendDenoms.length), changeAddrs.slice(0, selection.changeDenoms.length));
    const need = (est * FEE_NUM + FEE_DEN - 1n) / FEE_DEN;
    if (need <= fee) settled = true; else fee = need;
  }
  if (!settled) throw new QiSendError('Could not settle on a network fee. Nothing was sent; try again.');
  const spendOut = spendAddrs.slice(0, selection.spendDenoms.length);
  const changeOut = changeAddrs.slice(0, selection.changeDenoms.length);

  if (selection.breaksLargeNote) warnings.push({ level: 'warn', code: 'qi-large-note-broken', text: `This send breaks a large note of ${formatQi(selection.inputs.reduce((m, n) => (n.valueQit > m ? n.valueQit : m), 0n))} Qi into ${selection.changeDenoms.length} change notes (no smaller notes cover it).` });
  if (selection.inputs.length > 4) warnings.push({ level: 'info', code: 'qi-many-notes', text: `This send combines ${selection.inputs.length} notes, which raises the fee.` });
  if (beta) warnings.push({ level: 'danger', code: 'qi-mainnet-beta', text: beta });
  if (recipient.kind === 'qi-address') warnings.push({ level: 'info', code: 'qi-address-reuse', text: 'A plain Qi address is less private than a payment code; the recipient should not reuse it.' });

  let notice = { needed: false };
  if (recipient.kind === 'payment-code') {
    if (!mailbox || !(await mailbox.available())) throw new QiSendError('The payment-notice contract was not found on this network, so a payment-code send cannot be announced to the recipient. Nothing was sent. Send to a Qi address instead.');
    const done = await mailbox.hasNotified(fromCode, recipient.value);
    if (!done) {
      const cost = quai.estimatedCostWei ?? NOTIFY_FALLBACK_COST_WEI;
      notice = { needed: true, quaiAddress: quai.address, quaiBalanceWei: String(quai.balanceWei), estimatedCostWei: String(cost) };
      if (BigInt(quai.balanceWei) < BigInt(cost)) {
        throw new QiSendError(`The first Qi you send to a new payment code also posts a notice on-chain so they can find it, and that costs a little QUAI. Your Quai address ${quai.address} has too little (${quai.balanceWei} wei, needs about ${cost} wei). Add some QUAI there and try again. Nothing was sent.`);
      }
      warnings.push({ level: 'info', code: 'qi-notice-gas', text: 'The first send to this payment code also posts a small on-chain notice, paid in QUAI from your Quai address.' });
    }
  }

  const spend = amountQit + fee;
  const summary = {
    action: 'qi-send',
    network: net.name,
    chainId: net.chainId,
    from: fromCode,
    to: recipient.value,
    recipientKind: recipient.kind,
    amount: formatQi(amountQit),
    amountQit: String(amountQit),
    fee: formatQi(fee),
    feeQit: String(fee),
    total: formatQi(spend),
    totalQit: String(spend),
    unit: 'Qi',
    changeOutputs: groupDenoms(selection.changeDenoms).map((g) => ({ size: formatQi(g.sizeQit), count: g.count })),
    changeQit: String(selection.changeQit),
    notesSpent: selection.inputs.map((n) => ({ txHash: n.txHash, index: n.index, size: formatQi(n.valueQit) })),
    notice,
    warnings,
  };
  return { summary, plan: { selection: { ...selection, feeQit: fee }, spendAddrs: spendOut, changeAddrs: changeOut, spendQit: spend, notice } };
}

/**
 * Signs, (notifies,) broadcasts and waits for a receipt. Only status 1 is success. Any unclear outcome is
 * reported as unknown with the hash and is NEVER retried here.
 */
export async function executeSend({ port, mailbox, ledger, recipient, plan, fromCode, net, chainId, sleep, pollMs = 2500, timeoutMs = 120_000 }) {
  const { selection, spendAddrs, changeAddrs } = plan;
  // Never reuse an address, even if this send fails or is unknown.
  ledger.add([...spendAddrs.filter((a) => recipient.kind === 'payment-code' || a !== recipient.value), ...changeAddrs]);

  if (plan.notice?.needed) {
    // Notice first: a notice with no payment is harmless; a payment nobody can find is not.
    try { await mailbox.notify(fromCode, recipient.value); } catch (e) {
      throw new QiSendError(`The payment notice failed, so no Qi was sent. ${String(e?.message || e).split('\n')[0]}`);
    }
  }
  let signed;
  try { signed = await port.buildSigned(selection, spendAddrs, changeAddrs, chainId); } catch (e) {
    throw new QiSendError(`Could not build the transaction; nothing was sent. ${String(e?.message || e).split('\n')[0]}`);
  }
  const base = { txHash: signed.hash, network: net.name, explorer: quaiscanTxUrl(net.name, signed.hash) };
  ledger.addSent(plan.spendQit);
  try {
    const hash = await port.broadcast(signed.raw);
    if (typeof hash !== 'string' || hash.toLowerCase() !== signed.hash.toLowerCase()) {
      return { ok: false, status: 'unknown', ...base, message: 'The node answered with a different transaction hash. Check the hash below before doing anything else. Do not send again.' };
    }
  } catch (e) {
    return { ok: false, status: 'unknown', ...base, message: `Broadcast failed or was unclear (${String(e?.message || e).split('\n')[0]}). The send may still have gone through. Check the hash below before doing anything else. Do not send again.` };
  }
  const waitFn = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const deadline = Date.now() + timeoutMs;
  let polls = 0;
  for (;;) {
    let receipt = null;
    try { receipt = await port.receipt(signed.hash); } catch { receipt = null; }
    if (receipt) {
      if (Number(receipt.status) === 1) return { ok: true, status: 'confirmed', ...base };
      return { ok: false, status: 'failed', ...base, message: 'The network confirmed the transaction as failed. No Qi left your wallet.' };
    }
    polls += 1;
    if (Date.now() >= deadline || polls > Math.ceil(timeoutMs / pollMs) + 1) break;
    await waitFn(pollMs);
  }
  return { ok: false, status: 'unknown', ...base, message: 'No confirmation yet. The send may still land. Check the hash below before doing anything else. Do not send again.' };
}
