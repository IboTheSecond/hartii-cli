// Security-run 2026-11-17 (R3-F9): a look-alike recipient is confirmed with characters that DIFFER from the known address.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getAddress } from 'quais';
import { runWrite } from '../src/writePipeline.js';
import { recordPaid, lookalikeChallenge } from '../src/contacts.js';

const look = (middle) => getAddress('0x0012cd34' + middle.repeat(28).slice(0, 28) + 'f00d');
const FROM = getAddress('0x00' + Buffer.from('sender', 'utf8').toString('hex').padEnd(38, '0').slice(0, 38));
const HASH = '0x' + 'ab'.repeat(32);
const KNOWN = look('5'), POISON = look('9');
let home;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'hartii-lookalike-')); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

function node() {
  const provider = {
    getBalance: vi.fn(async () => 10n ** 21n), call: vi.fn(async () => '0x'), createAccessList: vi.fn(async () => []),
    estimateGas: vi.fn(async () => 28_000n), getFeeData: vi.fn(async () => ({ gasPrice: 2_000_000_000n })),
    getTransactionCount: vi.fn(async () => 0), getNetwork: vi.fn(async () => ({ chainId: 9n })),
  };
  const wallet = { getAddress: async () => FROM, sendTransaction: vi.fn(async () => ({ hash: HASH, wait: async () => ({ status: 1, hash: HASH }) })) };
  return { provider, wallet };
}
const send = (n, typedConfirmFn) => runWrite({ wallet: n.wallet, provider: n.provider, network: { name: 'mainnet', chainId: 9 }, home, limits: {}, to: POISON, value: 10n ** 18n, action: 'Send QUAI', recipient: POISON, io: { write: () => {}, typedConfirmFn, interactive: true, now: new Date('2026-11-16T12:00:00Z') } });

describe('R3-F9 look-alike confirmation', () => {
  it('the challenge starts where the addresses first differ (not at the shared ends)', () => {
    const c = lookalikeChallenge(POISON, KNOWN);
    expect(c.start).toBeGreaterThanOrEqual(8);
    expect(POISON.slice(2).toLowerCase().slice(c.start, c.end)).toBe(c.expected);
    expect(KNOWN.slice(2).toLowerCase().slice(c.start, c.end)).not.toBe(c.expected);
  });
  it('typing the last 4 characters (shared with the known address) is refused and nothing is sent', async () => {
    recordPaid(home, 9, KNOWN);
    const n = node();
    const r = await send(n, async () => POISON.slice(-4));
    expect(r.aborted).toBe(true);
    expect(n.wallet.sendTransaction).not.toHaveBeenCalled();
  });
  it('typing the differing characters confirms', async () => {
    recordPaid(home, 9, KNOWN);
    const n = node();
    const asked = [];
    const r = await send(n, async (q) => { asked.push(q); return lookalikeChallenge(POISON, KNOWN).expected; });
    expect(asked[0]).toMatch(/LOOK-ALIKE/);
    expect(r.status).toBe('success');
  });
});
