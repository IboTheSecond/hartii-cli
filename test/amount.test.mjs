// packages/hartii-cli/test/amount.test.mjs
import { describe, it, expect } from 'vitest';
import { parseAmount, formatAmount, AmountError } from '../src/amount.js';

describe('parseAmount — plain decimals', () => {
  it('parses a whole number', () => {
    expect(parseAmount('5').amountWei).toBe(5_000000000000000000n);
  });

  it('parses a decimal', () => {
    expect(parseAmount('1.5').amountWei).toBe(1_500000000000000000n);
  });

  it('rejects zero', () => {
    expect(() => parseAmount('0')).toThrow(AmountError);
  });

  it('rejects negative/garbage input', () => {
    expect(() => parseAmount('-1')).toThrow(AmountError);
    expect(() => parseAmount('abc')).toThrow(AmountError);
    expect(() => parseAmount('')).toThrow(AmountError);
  });

  it('rejects more decimal places than the token supports', () => {
    expect(() => parseAmount('1.1234567', { decimals: 2 })).toThrow(AmountError);
  });

  it('respects a non-18 decimals token', () => {
    expect(parseAmount('1.5', { decimals: 6 }).amountWei).toBe(1_500000n);
  });
});

describe('parseAmount — "all"', () => {
  it('resolves to the full balance', () => {
    const r = parseAmount('all', { balanceWei: 12345n });
    expect(r.amountWei).toBe(12345n);
    expect(r.isAll).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(parseAmount('ALL', { balanceWei: 5n }).amountWei).toBe(5n);
  });

  it('throws without a balance', () => {
    expect(() => parseAmount('all')).toThrow(AmountError);
  });
});

describe('parseAmount — percentages', () => {
  it('computes a round percentage', () => {
    const r = parseAmount('50%', { balanceWei: 1000n });
    expect(r.amountWei).toBe(500n);
    expect(r.isPercent).toBe(true);
    expect(r.isAll).toBe(false);
  });

  it('computes a fractional percentage without float drift', () => {
    const r = parseAmount('33.33%', { balanceWei: 1_000000000000000000n });
    // 1e18 * 3333 / 10000 = 333300000000000000
    expect(r.amountWei).toBe(333300000000000000n);
  });

  it('100% is equivalent to "all"', () => {
    const r = parseAmount('100%', { balanceWei: 777n });
    expect(r.amountWei).toBe(777n);
    expect(r.isAll).toBe(true);
  });

  it('rejects 0% and over 100%', () => {
    expect(() => parseAmount('0%', { balanceWei: 100n })).toThrow(AmountError);
    expect(() => parseAmount('150%', { balanceWei: 100n })).toThrow(AmountError);
  });

  it('throws without a balance', () => {
    expect(() => parseAmount('50%')).toThrow(AmountError);
  });
});

describe('formatAmount', () => {
  it('round-trips with parseAmount', () => {
    expect(formatAmount(1_500000000000000000n)).toBe('1.5');
  });

  it('respects decimals', () => {
    expect(formatAmount(1_500000n, 6)).toBe('1.5');
  });
});
