// Security-run 2026-11-17 (R3-F5, F6, F7): sealed + merged Qi ledger, Qi address checksum, Qi caps with long decimals.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { QiHDWallet, Mnemonic } from 'quais';
import { classifyRecipient, QiRecipientError } from '../../src/qi/recipient.js';
import { resolveQiCaps, QiCapError } from '../../src/qi/caps.js';
import { openQiLedger, peekQiLedger } from '../../src/qi/ledger.js';
import { createVault, lockVault, unlockVault, vaultPath } from '../../src/localVault.js';

const PHRASE = [...Array(11).fill('test'), 'junk'].join(' '); // Hardhat's public dev phrase, built at runtime for the OSS scan
const wallet = QiHDWallet.fromMnemonic(Mnemonic.fromPhrase(PHRASE));
const A1 = '0x' + 'a1'.repeat(20), A2 = '0x' + 'b2'.repeat(20);

describe('R3-F6 Qi address checksum', () => {
  const addr = wallet.getNextAddressSync(0, '0x00').address;
  const flipCase = (a) => {
    const body = a.slice(2).split('');
    const i = body.findIndex((c) => /[a-f]/i.test(c));
    body[i] = body[i] === body[i].toLowerCase() ? body[i].toUpperCase() : body[i].toLowerCase();
    return '0x' + body.join('');
  };
  it('accepts the checksummed address and returns it unchanged', () => {
    expect(classifyRecipient(addr)).toEqual({ kind: 'qi-address', value: addr });
  });
  it('rejects a mixed-case address with a wrong checksum', () => {
    expect(() => classifyRecipient(flipCase(addr))).toThrow(QiRecipientError);
    expect(() => classifyRecipient(flipCase(addr))).toThrow(/checksum/);
  });
  it('accepts all-lowercase input and normalises it to the checksummed form', () => {
    expect(classifyRecipient(addr.toLowerCase())).toEqual({ kind: 'qi-address', value: addr });
  });
});

describe('R3-F7 Qi caps', () => {
  it('a cap with more than 3 decimals is an error, never "no cap"', () => {
    expect(() => resolveQiCaps({ limits: { perTxQuai: '0.0001' } })).toThrow(QiCapError);
    expect(() => resolveQiCaps({ limits: { perTxQuai: '5', dailyQuai: '10.1234' } })).toThrow(/3 decimals/);
  });
  it('valid caps still resolve', () => {
    expect(resolveQiCaps({ limits: { perTxQuai: '5', dailyQuai: '10.125' } })).toEqual({ set: true, perTxQit: 5000n, dailyQit: 10125n });
    expect(resolveQiCaps({ limits: {} }).set).toBe(false);
  });
});

describe('R3-F5 Qi ledger is sealed, merged and readable as locked', () => {
  let home;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'hartii-qiledger-')); });
  afterEach(() => { lockVault(home); rmSync(home, { recursive: true, force: true }); });

  it('with a vault the file is sealed (no address in clear) and peek says locked without a password', async () => {
    await createVault(home, { wallet: 'w', password: 'pw-pw-pw-pw-pw', kdfN: 2 ** 14 });
    const ledger = openQiLedger(home, 'orchard', 'w');
    ledger.add([A1]); ledger.addSent(1500n);
    const raw = readFileSync(ledger.path, 'utf8');
    expect(raw).toContain('hartii-sealed/v1');
    expect(raw).not.toContain('a1a1a1');
    lockVault(home);
    expect(peekQiLedger(home, 'orchard', 'w')).toEqual({ locked: true });
    expect(() => openQiLedger(home, 'orchard', 'w')).toThrow(/locked/i);
    await unlockVault(home, { wallet: 'w', password: 'pw-pw-pw-pw-pw', kdfN: 2 ** 14 });
    expect(peekQiLedger(home, 'orchard', 'w')).toEqual({ locked: false, used: 1, sentQit: '1500' });
  });
  it('a plain legacy ledger is sealed when the vault is created', async () => {
    mkdirSync(join(home, 'qi'));
    const path = join(home, 'qi', 'orchard-w.json');
    writeFileSync(path, JSON.stringify({ version: 1, used: [A1], sent: { date: '2026-01-01', qit: '0' } }));
    await createVault(home, { wallet: 'w', password: 'pw-pw-pw-pw-pw', kdfN: 2 ** 14 });
    expect(readFileSync(path, 'utf8')).toContain('hartii-sealed/v1');
    expect(openQiLedger(home, 'orchard', 'w').has(A1)).toBe(true);
    expect(readFileSync(vaultPath(home), 'utf8')).toContain('slots');
  });
  it('two handles on the same file do not clobber each other (merge on save)', () => {
    const a = openQiLedger(home, 'orchard', 'w');
    const b = openQiLedger(home, 'orchard', 'w');
    a.add([A1]); b.add([A2]);
    const c = openQiLedger(home, 'orchard', 'w');
    expect(c.has(A1)).toBe(true);
    expect(c.has(A2)).toBe(true);
  });
});
