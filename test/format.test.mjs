import { describe, it, expect } from 'vitest';
import * as F from '../src/format.js';

const E18 = 10n ** 18n;

describe('format: amounts', () => {
  it('groups thousands and trims to sensible precision', () => {
    expect(F.quai(1234567890000000000000n)).toBe('1,234.56 QUAI');
    expect(F.quai(12345678900000000000n)).toBe('12.3456 QUAI');
    expect(F.quai(5n * E18)).toBe('5 QUAI');
  });
  it('handles zero, unknown and negative', () => {
    expect(F.quai(0n)).toBe('0 QUAI');
    expect(F.quai(null)).toBe('—');
    expect(F.quai(undefined)).toBe('—');
    expect(F.quai('bad')).toBe('—');
    expect(F.quai(-1500000000000000000n)).toBe('-1.5 QUAI');
  });
  it('handles huge numbers without float loss', () => {
    expect(F.fromUnits(123456789012345678901234567890n * E18)).toBe('123,456,789,012,345,678,901,234,567,890');
  });
  it('keeps four significant digits for tiny values and truncates, never rounds up', () => {
    expect(F.fromUnits(18600000000000n)).toBe('0.0000186');
    expect(F.fromUnits(123456789012345n)).toBe('0.0001234');
    expect(F.fromUnits(1n)).toBe('0.000000000000000001');
    expect(F.fromUnits(1999999999999999999n)).toBe('1.9999');
  });
  it('exact mode keeps every digit for money that moves', () => {
    expect(F.quai(1234567890123456789012n, { exact: true })).toBe('1,234.567890123456789012 QUAI');
    expect(F.quai(2500000000000000000n, { exact: true })).toBe('2.5 QUAI');
  });
  it('rounds up when asked, so a cost is never understated', () => {
    expect(F.quai(1741272636187266000n, { up: true })).toBe('1.7413 QUAI');
    expect(F.fromUnits(1999999999999999999n, { up: true })).toBe('2');
    expect(F.fromUnits(18600000000001n, { up: true })).toBe('0.00001861');
    expect(F.fromUnits(5n * E18, { up: true })).toBe('5');
    expect(F.fee(1741272636187266000n, { up: true, seconds: 5 })).toBe('1.7413 QUAI · about 5 seconds');
  });
  it('formats decimal strings and token decimals', () => {
    expect(F.quaiDecimal('1234.56789')).toBe('1,234.56 QUAI');
    expect(F.quaiDecimal('2.5', { exact: true })).toBe('2.5 QUAI');
    expect(F.amount(1500000n, { decimals: 6, symbol: 'USDC' })).toBe('1.5 USDC');
    expect(F.amountDecimal('x')).toBe('—');
  });
  it('prices keep tiny values readable', () => {
    expect(F.price('18600000000000')).toBe('0.0000186');
    expect(F.price('1000000000000001')).toBe('0.001');
    expect(F.price(null)).toBe('—');
  });
});

describe('format: compact, percent, fee', () => {
  it('compacts big stats', () => {
    expect(F.compact(12400)).toBe('12.4K');
    expect(F.compact(999)).toBe('999');
    expect(F.compact(1000000)).toBe('1M');
    expect(F.compact('3200000000')).toBe('3.2B');
    expect(F.compact(null)).toBe('—');
    expect(F.compact(-12400)).toBe('-12.4K');
    expect(F.count(1337)).toBe('1,337');
  });
  it('percent from bps reads as a percent', () => {
    expect(F.percentFromBps(300)).toBe('3%');
    expect(F.percentFromBps(100)).toBe('1%');
    expect(F.percentFromBps(25)).toBe('0.25%');
    expect(F.percentFromBps('150')).toBe('1.5%');
    expect(F.percentFromBps(null)).toBe('—');
    expect(F.percent(7.83)).toBe('7.83%');
    expect(F.percent(12.4, { sign: true })).toBe('+12.4%');
    expect(F.percent(-3, { sign: true })).toBe('-3%');
    expect(F.percent(0)).toBe('0%');
  });
  it('fee is money plus time when known', () => {
    expect(F.fee(1741272636187266000n)).toBe('1.7412 QUAI');
    expect(F.fee(1741272636187266000n, { seconds: 5 })).toBe('1.7412 QUAI · about 5 seconds');
    expect(F.fee(null, { seconds: 5 })).toBe('—');
    expect(F.eta(120)).toBe('about 2 minutes');
  });
});

describe('format: addresses', () => {
  const raw = '0x0000000000000000000000000000000000000d01';
  it('shows the full checksummed address in four-character groups', () => {
    const c = F.checksummed(raw);
    const text = F.address(raw);
    expect(text.replace(/ /g, '')).toBe(c);
    expect(text.split(' ')).toHaveLength(10);
    expect(F.addressGroups(raw)).toHaveLength(10);
  });
  it('emphasises only the first and last group', () => {
    const text = F.address(raw, { emph: (s) => `[${s}]` });
    expect(text.match(/\[/g)).toHaveLength(2);
    expect(text.startsWith('0x[')).toBe(true);
    expect(text.endsWith(']')).toBe(true);
  });
  it('never alters or abbreviates a non-address and is dash for empty', () => {
    expect(F.address('hello')).toBe('hello');
    expect(F.address(null)).toBe('—');
    expect(F.address('x\u001b]52;c;AAA\u0007y')).not.toContain('\u001b');
  });
  it('wraps to two rows on a narrow terminal', () => {
    expect(F.addressLines(raw, { width: 80 })).toHaveLength(1);
    expect(F.addressLines(raw, { width: 40 })).toHaveLength(2);
  });
  it('short form is only for tight spots', () => {
    expect(F.shortAddress(raw)).toMatch(/^0x[0-9a-fA-F]{4}…[0-9a-fA-F]{4}$/);
  });
});

describe('format: time', () => {
  const now = new Date('2026-11-16T14:05:00Z');
  it('gives relative plus absolute', () => {
    expect(F.time('2026-11-16T14:02:00Z', { now })).toBe('3 minutes ago · 2026-11-16 14:02 UTC');
    expect(F.time('2026-11-16T14:04:50Z', { now })).toBe('just now · 2026-11-16 14:04 UTC');
    expect(F.relativeTime('2026-11-16T16:05:00Z', { now })).toBe('in 2 hours');
    expect(F.relativeTime(new Date('2026-11-14T14:05:00Z'), { now })).toBe('2 days ago');
  });
  it('accepts seconds and milliseconds, and unknown is a dash', () => {
    expect(F.absoluteTime(1794837720)).toBe('2026-11-16 14:02 UTC');
    expect(F.absoluteTime(1794837720000)).toBe('2026-11-16 14:02 UTC');
    expect(F.time(null)).toBe('—');
    expect(F.time('nonsense')).toBe('—');
  });
});
