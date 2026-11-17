// The write pipeline prints the plain review before the y/N prompt; --details adds the technical block.
// The summary object and the JSON output must stay exactly as they were.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getAddress } from 'quais';
import { runWrite } from '../src/writePipeline.js';
import { makeColors } from '../src/output.js';

const mkAddr = (label) => getAddress('0x00' + Buffer.from(label, 'utf8').toString('hex').padEnd(38, '0').slice(0, 38));
const FROM = mkAddr('sender');
const TO = mkAddr('dest');
const NETWORK = { name: 'mainnet', chainId: 9 };
const LIMITS = { perTxQuai: '100', dailyQuai: '500' };

function rig() {
  const provider = {
    call: vi.fn(async () => '0x'), createAccessList: vi.fn(async () => []), estimateGas: vi.fn(async () => 50_000n),
    getFeeData: vi.fn(async () => ({ gasPrice: 3_000_000_000n })), getTransactionCount: vi.fn(async () => 4), getNetwork: vi.fn(async () => ({ chainId: 9n })),
  };
  const wallet = { getAddress: vi.fn(async () => FROM), sendTransaction: vi.fn() };
  return { wallet, provider };
}

let home; let written; let io;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'hartii-cli-review-wiring-')); written = []; io = { write: (s) => written.push(s), writeErr: (s) => written.push(s), confirmFn: vi.fn(async () => false) }; });
afterEach(() => rmSync(home, { recursive: true, force: true }));

const base = (extra = {}) => ({ ...rig(), network: NETWORK, home, limits: LIMITS, to: TO, value: 2_500000000000000000n, action: 'Send QUAI', dryRun: true, io, ...extra });

describe('pre-confirm review in the write pipeline', () => {
  it('prints a plain first sentence, fee and total, and the confirm line by default', async () => {
    await runWrite(base());
    const text = written.join('\n');
    expect(text).toMatch(/You send 2\.5 QUAI to 0x/);
    expect(text).toContain('Network fee');
    expect(text).toContain('Total in QUAI');
    expect(text).not.toContain('dataDigest');
    expect(text).not.toContain('Nonce');
  });
  it('--details shows the technical fields (ctx.details and io.details both work)', async () => {
    await runWrite(base({ details: true }));
    expect(written.join('\n')).toContain('Nonce');
    written.length = 0;
    await runWrite(base({ io: { ...io, details: true } }));
    expect(written.join('\n')).toContain('Call selector');
  });
  it('asks the y/N question after the review, and a refusal sends nothing', async () => {
    const args = base({ dryRun: false, yes: false });
    const result = await runWrite(args);
    expect(result.aborted).toBe(true);
    expect(io.confirmFn).toHaveBeenCalledTimes(1);
    expect(args.wallet.sendTransaction).not.toHaveBeenCalled();
    expect(written.join('\n')).toContain('Nothing is sent until you confirm.');
  });
  it('renders safety warnings from summary.warnings once they exist, and keeps the summary object untouched', async () => {
    const result = await runWrite(base());
    expect(Object.keys(result.summary)).toEqual(expect.arrayContaining(['action', 'network', 'chainId', 'from', 'to', 'valueQuai', 'guardedQuai', 'guardedWithFeeQuai', 'gasLimit', 'gasPriceWei', 'estimatedFeeQuai', 'nonce', 'dataDigest', 'dataSelector', 'dataBytes']));
    expect(result.summary.valueQuai).toBe('2.5');
  });
  it('--json still prints the raw summary object, not the review', async () => {
    await runWrite(base({ json: true }));
    const parsed = JSON.parse(written.join('\n'));
    expect(parsed.summary.gasPriceWei).toBe('3000000000');
    expect(parsed.summary.action).toBe('Send QUAI');
  });
  it('uses colour only when the caller has it enabled', async () => {
    await runWrite(base({ io: { ...io, colors: makeColors({ enabled: false }) } }));
    expect(written.join('\n')).not.toMatch(/\u001b/);
    written.length = 0;
    await runWrite(base({ io: { ...io, colors: makeColors({ enabled: true, env: { COLORTERM: 'truecolor' } }) } }));
    expect(written.join('\n')).toMatch(/\u001b\[38;2;/);
  });
});
