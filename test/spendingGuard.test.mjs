// packages/hartii-cli/test/spendingGuard.test.mjs
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkSpend, recordSpend, getSpentToday, SpendGuardError, withSpendLock, reserveSpend, settleSpend } from '../src/spendingGuard.js';

const LIMITS = { perTxQuai: '100', dailyQuai: '500' };
const ADDRESS = '0x0003b264Bc457BF2dc6F4De80c6C714079febB64';

let home;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'hartii-cli-spend-test-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('checkSpend', () => {
  it('allows a transaction under both caps', () => {
    expect(() => checkSpend(home, ADDRESS, 10_000000000000000000n, LIMITS)).not.toThrow();
  });

  it('rejects a single transaction over the per-tx cap', () => {
    expect(() => checkSpend(home, ADDRESS, 101_000000000000000000n, LIMITS)).toThrow(SpendGuardError);
    expect(() => checkSpend(home, ADDRESS, 101_000000000000000000n, LIMITS)).toThrow(/per-transaction/);
  });

  it('never records on a mere check — repeated checks of the same amount all pass', () => {
    checkSpend(home, ADDRESS, 50_000000000000000000n, LIMITS);
    checkSpend(home, ADDRESS, 50_000000000000000000n, LIMITS);
    checkSpend(home, ADDRESS, 50_000000000000000000n, LIMITS);
    expect(getSpentToday(home, ADDRESS).spentWei).toBe(0n);
  });

  it('rejects once the running daily total would be exceeded', () => {
    recordSpend(home, ADDRESS, 90_000000000000000000n);
    recordSpend(home, ADDRESS, 90_000000000000000000n);
    recordSpend(home, ADDRESS, 90_000000000000000000n);
    recordSpend(home, ADDRESS, 90_000000000000000000n);
    recordSpend(home, ADDRESS, 90_000000000000000000n); // 450 QUAI spent today
    expect(() => checkSpend(home, ADDRESS, 60_000000000000000000n, LIMITS)).toThrow(/daily limit/);
    expect(() => checkSpend(home, ADDRESS, 50_000000000000000000n, LIMITS)).not.toThrow();
  });

  it('tracks each address independently', () => {
    const other = '0x00606Ee2fF3A26B20213906a41aa8CAfCB251237';
    recordSpend(home, ADDRESS, 90_000000000000000000n);
    expect(() => checkSpend(home, other, 90_000000000000000000n, LIMITS)).not.toThrow();
  });

  it('resets the running total on a new UTC day', () => {
    const yesterday = new Date('2026-01-01T00:00:00Z');
    const today = new Date('2026-01-02T00:00:00Z');
    recordSpend(home, ADDRESS, 90_000000000000000000n, { now: yesterday });
    expect(() => checkSpend(home, ADDRESS, 90_000000000000000000n, LIMITS, { now: today })).not.toThrow();
  });
});

describe('recordSpend / getSpentToday', () => {
  it('accumulates across calls on the same day', () => {
    recordSpend(home, ADDRESS, 10n);
    recordSpend(home, ADDRESS, 20n);
    expect(getSpentToday(home, ADDRESS).spentWei).toBe(30n);
  });

  it('is case-insensitive on the address', () => {
    recordSpend(home, ADDRESS, 10n);
    expect(getSpentToday(home, ADDRESS.toLowerCase()).spentWei).toBe(10n);
  });
});

describe('durable spend safety', () => {
  it.each(['{broken', 'null', '[]', '{"x":{"date":"2026-01-01","spentWei":"-1"}}'])('fails closed on damaged ledger %s', raw => {
    writeFileSync(join(home, 'spend.json'), raw);
    expect(() => checkSpend(home, ADDRESS, 1n, LIMITS)).toThrow(/ledger/i);
  });
  it('rejects negative spend or malformed limits', () => {
    expect(() => checkSpend(home, ADDRESS, -1n, LIMITS)).toThrow(SpendGuardError);
    expect(() => checkSpend(home, ADDRESS, 1n, { ...LIMITS, dailyQuai: '-1' })).toThrow(SpendGuardError);
  });
  it('reserves headroom before broadcast without recording a confirmed spend', () => {
    const limits = { perTxQuai: '100', dailyQuai: '100' };
    reserveSpend(home, ADDRESS, 90_000000000000000000n, limits);
    expect(getSpentToday(home, ADDRESS).spentWei).toBe(0n);
    expect(() => checkSpend(home, ADDRESS, 11_000000000000000000n, limits)).toThrow(/daily limit/);
  });
  it('retains unknown pending amounts across UTC rollover', () => {
    reserveSpend(home, ADDRESS, 90_000000000000000000n, { perTxQuai: '100', dailyQuai: '100' }, { now: new Date('2026-01-01') });
    expect(() => checkSpend(home, ADDRESS, 11_000000000000000000n, { perTxQuai: '100', dailyQuai: '100' }, { now: new Date('2026-01-02') })).toThrow(/daily limit/);
  });
  it('settles confirmed reservations once, while a rejected-before-broadcast send releases them', () => {
    const id = reserveSpend(home, ADDRESS, 20n, LIMITS);
    settleSpend(home, ADDRESS, id, { confirmed: true });
    expect(getSpentToday(home, ADDRESS).spentWei).toBe(20n);
    expect(() => settleSpend(home, ADDRESS, id, { confirmed: true })).toThrow(/reservation/i);
    const reverted = reserveSpend(home, ADDRESS, 30n, LIMITS);
    settleSpend(home, ADDRESS, reverted, { confirmed: false });
    expect(getSpentToday(home, ADDRESS)).toMatchObject({ spentWei: 20n, reservedWei: 0n });
  });
  it('serializes the shared file across addresses and releases locks on errors', async () => {
    let release;
    const first = withSpendLock(home, ADDRESS, () => new Promise(resolve => { release = resolve; }));
    await expect(withSpendLock(home, 'another-wallet', async () => {})).rejects.toThrow(/in progress|lock/i);
    release(); await first;
    await expect(withSpendLock(home, ADDRESS, async () => { throw new Error('test failure'); })).rejects.toThrow('test failure');
    await expect(withSpendLock(home, ADDRESS, async () => 42)).resolves.toBe(42);
  });
});
