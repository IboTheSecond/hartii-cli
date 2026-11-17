// Security-run 2026-11-17 (R3-F4): the Qi payment-notice transaction uses the shared write pipeline.
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMailbox, MAILBOX_ADDRESSES, MAILBOX_IFACE } from '../../src/qi/mailbox.js';
import { generateMnemonicAccount } from '../../src/keystore.js';
import { offlineWallet } from '../fakeBroadcast.mjs';

let KEY, home;
beforeAll(() => { KEY = generateMnemonicAccount().privateKey; }, 120_000);
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'hartii-qinotice-')); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

function provider({ gasPrice = 3_000_000_000n, chain = 15000n } = {}) {
  const mailbox = MAILBOX_ADDRESSES.orchard;
  return {
    call: vi.fn(async () => '0x'),
    createAccessList: vi.fn(async () => [{ address: mailbox, storageKeys: [] }]),
    estimateGas: vi.fn(async () => 120_000n),
    getFeeData: vi.fn(async () => ({ gasPrice })),
    getTransactionCount: vi.fn(async () => 3),
    getNetwork: vi.fn(async () => ({ chainId: chain })),
    getBalance: vi.fn(async () => 10n ** 22n),
    getCode: vi.fn(async () => '0x01'),
  };
}
function setup(p, extra = {}) {
  const sent = [];
  const walletFactory = (key, prov) => offlineWallet(key, prov, async (tx) => { sent.push(tx); return { wait: async () => ({ status: 1, blockNumber: 1 }) }; });
  const unlockData = vi.fn(async () => ({ unlocked: true }));
  const mb = createMailbox({ provider: p, network: 'orchard', signerKey: KEY, run: { home, chainId: 15000, rpcUrl: 'https://orchard.rpc.quai.network', unlockData, walletFactory, ...extra } });
  return { mb, sent, unlockData };
}

describe('R3-F4 payment notice goes through runWrite', () => {
  it('refuses an absurd RPC fee (the 25 QUAI ceiling) and signs nothing', async () => {
    const p = provider({ gasPrice: 10n ** 18n });
    const { mb, sent } = setup(p);
    await expect(mb.notify('PM8Tsender', 'PM8Treceiver')).rejects.toThrow(/fee ceiling/);
    expect(sent).toHaveLength(0);
  });
  it('re-checks the chain: an RPC on another chain is refused', async () => {
    const p = provider({ chain: 9n });
    const { mb, sent } = setup(p);
    await expect(mb.notify('a', 'b')).rejects.toThrow();
    expect(sent).toHaveLength(0);
  });
  it('signs the notify call with an access list, unlocks the vault and holds the lock', async () => {
    const p = provider();
    const { mb, sent, unlockData } = setup(p);
    const r = await mb.notify('PM8Tsender', 'PM8Treceiver');
    expect(r.hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(unlockData).toHaveBeenCalled();
    expect(p.createAccessList).toHaveBeenCalled();
    expect(sent).toHaveLength(1);
    expect(sent[0].accessList?.length).toBeGreaterThan(0);
    expect(sent[0].to.toLowerCase()).toBe(MAILBOX_ADDRESSES.orchard.toLowerCase());
    expect(sent[0].data).toBe(MAILBOX_IFACE.encodeFunctionData('notify', ['PM8Tsender', 'PM8Treceiver']));
  });
  it('refuses to run outside the pipeline when the run context is missing', async () => {
    const mb = createMailbox({ provider: provider(), network: 'orchard', signerKey: KEY });
    await expect(mb.notify('a', 'b')).rejects.toThrow(/write pipeline/);
  });
});
