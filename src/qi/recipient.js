// packages/hartii-cli/src/qi/recipient.js
// A Qi send goes to a payment code (private, reusable) or to a Cyprus-1 Qi address. A Quai address is
// the other ledger: Qi cannot be sent there directly, it has to be converted.
import { decodeBase58, sha256, getBytes, isQiAddress, getZoneForAddress, getAddress, Zone } from 'quais';
import { CliError } from '../errors.js';

export class QiRecipientError extends CliError {}

/** Same checks as the quais payment-code validator (version, features byte, pubkey prefix, zero tail), plus base58check. */
export function isPaymentCode(text) {
  try {
    if (typeof text !== 'string' || !/^PM8T[1-9A-HJ-NP-Za-km-z]{100,130}$/.test(text)) return false;
    const n = decodeBase58(text);
    const bytes = getBytes('0x' + n.toString(16).padStart(85 * 2, '0'));
    if (bytes.length !== 85) return false;
    const body = bytes.slice(0, 81);
    const check = getBytes(sha256(sha256(body))).slice(0, 4);
    if (!check.every((b, i) => b === bytes[81 + i])) return false;
    return body[0] === 0x47 && body[1] === 0x01 && body[2] === 0x00 && (body[3] === 0x02 || body[3] === 0x03) && body.slice(68).every((b) => b === 0);
  } catch { return false; }
}

export function classifyRecipient(input) {
  const value = String(input ?? '').trim();
  if (isPaymentCode(value)) return { kind: 'payment-code', value };
  if (/^0x[0-9a-fA-F]{40}$/.test(value)) {
    let qi = false;
    try { qi = isQiAddress(value); } catch { qi = false; }
    if (!qi) throw new QiRecipientError('That is a Quai address. Qi can only go to a payment code (starts with PM8T) or a Qi address, never straight to a Quai address. To get QUAI from Qi you convert it first.');
    // R3-F6: a mixed-case address carries a checksum and a wrong one is a typo. All-lowercase (or all-uppercase) is accepted and normalised.
    const body = value.slice(2);
    let checksummed = value;
    try { checksummed = getAddress(value); } catch { throw new QiRecipientError('That Qi address does not look right (its checksum is wrong). Copy it again.'); }
    if (body !== body.toLowerCase() && body !== body.toUpperCase() && checksummed !== value) throw new QiRecipientError('That Qi address has a wrong checksum (a letter was mistyped or changed case). Copy it again.');
    let zone;
    try { zone = getZoneForAddress(value); } catch { zone = null; }
    if (zone !== Zone.Cyprus1) throw new QiRecipientError('That Qi address is not on Cyprus-1, the zone this CLI uses.');
    return { kind: 'qi-address', value: checksummed };
  }
  throw new QiRecipientError('Enter a payment code (starts with PM8T) or a Cyprus-1 Qi address.');
}
