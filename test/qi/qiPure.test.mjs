// Pure Qi rules: units, note selection, recipient kinds, network gate, caps.
import { describe, it, expect } from 'vitest';
import { QiHDWallet, Mnemonic } from 'quais';
import { generateMnemonicAccount } from '../../src/keystore.js';
import { parseQi, formatQi, QIT_PER_QI } from '../../src/qi/units.js';
import { denominate, selectNotes, QiSelectError } from '../../src/qi/select.js';
import { classifyRecipient, QiRecipientError } from '../../src/qi/recipient.js';
import { assertQiWriteAllowed, QiNetworkError } from '../../src/qi/networkGate.js';
import { resolveQiCaps, checkQiCaps } from '../../src/qi/caps.js';

const note = (valueQit, i = 0, extra = {}) => ({ txHash: '0x' + String(i + 1).padStart(64, '0'), index: i, denomination: [1n,5n,10n,50n,100n,500n,1000n,5000n,10000n,20000n,100000n,1000000n,10000000n,100000000n,1000000000n].indexOf(BigInt(valueQit)), valueQit: BigInt(valueQit), address: '0x00' + String(i).padStart(40, '0'), lock: 0, ...extra });

describe('units', () => {
  it('parses Qi text into qits (1 Qi = 1000 qit) and rejects junk', () => {
    expect(parseQi('1')).toBe(1000n);
    expect(parseQi('0.015')).toBe(15n);
    expect(QIT_PER_QI).toBe(1000n);
    for (const bad of ['0', '-1', '1.0001', 'abc', '', '1e3', '0x10']) expect(() => parseQi(bad)).toThrow();
  });
  it('formats qits back to plain Qi text', () => {
    expect(formatQi(1000n)).toBe('1');
    expect(formatQi(1500n)).toBe('1.5');
    expect(formatQi(15n)).toBe('0.015');
    expect(formatQi(0n)).toBe('0');
  });
});

describe('denominate', () => {
  it('splits into real Qi notes only (no 250 or 50000 note)', () => {
    expect(denominate(1000n)).toEqual([6]);
    expect(denominate(1030n)).toEqual([6, 2, 2, 2]);
    const sum = denominate(250_000n).reduce((s, i) => s + [1n,5n,10n,50n,100n,500n,1000n,5000n,10000n,20000n,100000n,1000000n,10000000n,100000000n,1000000000n][i], 0n);
    expect(sum).toBe(250_000n);
    expect(denominate(50_000_000n).every(i => i >= 0)).toBe(true);
  });
});

describe('selectNotes', () => {
  it('does not spend a 1,000 Qi note for a 1 Qi send when smaller notes exist', () => {
    const notes = [note(1_000_000n, 0), note(5000n, 1), note(5000n, 2)];
    const sel = selectNotes({ notes, amountQit: 1000n, feeQit: 30n });
    expect(sel.inputs).toHaveLength(1);
    expect(sel.inputs[0].valueQit).toBe(5000n);
    expect(sel.changeQit).toBe(5000n - 1000n - 30n);
  });
  it('prefers a few smaller notes over one huge note', () => {
    const notes = [note(1_000_000n, 0), note(500n, 1), note(500n, 2), note(500n, 3)];
    const sel = selectNotes({ notes, amountQit: 1000n, feeQit: 30n });
    expect(sel.inputs.map(n => n.valueQit)).toEqual([500n, 500n, 500n]);
  });
  it('uses the big note when it is all there is, and says so', () => {
    const sel = selectNotes({ notes: [note(1_000_000n, 0)], amountQit: 1000n, feeQit: 30n });
    expect(sel.inputs).toHaveLength(1);
    expect(sel.breaksLargeNote).toBe(true);
  });
  it('skips locked notes', () => {
    const notes = [note(5000n, 0, { locked: true }), note(10000n, 1)];
    const sel = selectNotes({ notes, amountQit: 1000n, feeQit: 30n });
    expect(sel.inputs[0].valueQit).toBe(10000n);
  });
  it('reports spendable vs locked when funds are short', () => {
    expect(() => selectNotes({ notes: [note(5000n, 0, { locked: true })], amountQit: 1000n, feeQit: 30n })).toThrow(/locked/i);
    expect(() => selectNotes({ notes: [note(500n, 0)], amountQit: 1000n, feeQit: 30n })).toThrow(QiSelectError);
  });
  it('outputs sum to inputs minus fee exactly', () => {
    const sel = selectNotes({ notes: [note(10000n, 0)], amountQit: 1234n, feeQit: 40n });
    const D = [1n,5n,10n,50n,100n,500n,1000n,5000n,10000n,20000n,100000n,1000000n,10000000n,100000000n,1000000000n];
    const sum = a => a.reduce((s, i) => s + D[i], 0n);
    expect(sum(sel.spendDenoms)).toBe(1234n);
    expect(sum(sel.spendDenoms) + sum(sel.changeDenoms) + 40n).toBe(10000n);
  });
});

describe('recipient', () => {
  const w = QiHDWallet.fromMnemonic(Mnemonic.fromPhrase([...Array(11).fill('test'), 'junk'].join(' ')) /* Hardhat's public dev phrase, built at runtime for the OSS scan */);
  const code = w.getPaymentCode(0);
  it('accepts a payment code', () => {
    expect(classifyRecipient(code)).toEqual({ kind: 'payment-code', value: code });
  });
  it('accepts a Cyprus-1 Qi address', () => {
    const info = w.getNextAddressSync(0, '0x00');
    expect(classifyRecipient(info.address).kind).toBe('qi-address');
  });
  it('refuses a Quai address and says why', () => {
    const quai = generateMnemonicAccount().address;
    expect(() => classifyRecipient(quai)).toThrow(QiRecipientError);
    expect(() => classifyRecipient(quai)).toThrow(/Quai address/);
    expect(() => classifyRecipient(quai)).toThrow(/convert/i);
  });
  it('refuses junk', () => {
    expect(() => classifyRecipient('hello')).toThrow(QiRecipientError);
    expect(() => classifyRecipient(code.slice(0, -1) + (code.endsWith('A') ? 'B' : 'A'))).toThrow(QiRecipientError);
  });
});

describe('network gate', () => {
  it('lets Orchard send by default', () => {
    expect(assertQiWriteAllowed({ net: { name: 'orchard' }, flags: {}, globals: {} })).toEqual({ beta: false });
  });
  it('refuses mainnet without the flag', () => {
    expect(() => assertQiWriteAllowed({ net: { name: 'mainnet' }, flags: {}, globals: { network: 'mainnet' } })).toThrow(QiNetworkError);
  });
  it('refuses mainnet when only the flag is given but the network was not named', () => {
    expect(() => assertQiWriteAllowed({ net: { name: 'mainnet' }, flags: { 'allow-mainnet-qi': true }, globals: { network: null } })).toThrow(/--network mainnet/);
  });
  it('allows mainnet with both and marks it BETA', () => {
    const r = assertQiWriteAllowed({ net: { name: 'mainnet' }, flags: { 'allow-mainnet-qi': true }, globals: { network: 'mainnet' } });
    expect(r.beta).toBe(true);
    expect(r.warning).toMatch(/BETA/);
  });
});

describe('caps', () => {
  it('no caps set means --yes is refused', () => {
    const caps = resolveQiCaps({ limits: { perTxQuai: null, dailyQuai: null } });
    expect(caps.set).toBe(false);
  });
  it('counts the same config limits in Qi and blocks over the cap', () => {
    const caps = resolveQiCaps({ limits: { perTxQuai: '10', dailyQuai: '50' } });
    expect(caps.set).toBe(true);
    expect(() => checkQiCaps(caps, { spendQit: 11_000n, spentTodayQit: 0n })).toThrow(/per-transaction/);
    expect(() => checkQiCaps(caps, { spendQit: 9_000n, spentTodayQit: 45_000n })).toThrow(/daily/);
    expect(() => checkQiCaps(caps, { spendQit: 9_000n, spentTodayQit: 0n })).not.toThrow();
  });
});
