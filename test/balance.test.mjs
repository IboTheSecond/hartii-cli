// packages/hartii-cli/test/balance.test.mjs
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runBalance, resolveWalletAddress, BalanceError } from '../src/commands/balance.js';
import { saveConfig, loadConfig } from '../src/config.js';
import { generateMnemonicAccount, encryptAccount, writeKeystoreFile } from '../src/keystore.js';
import { DEMO_ADDRESS } from '../src/demoFixtures.js';

let home;
let account;
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'hartii-cli-balance-test-'));
  account = generateMnemonicAccount();
  const json = await encryptAccount({ address: account.address, privateKey: account.privateKey }, 'pw', { scrypt: { N: 2, r: 1, p: 1 } });
  writeKeystoreFile(home, 'default', json);
}, 120_000);
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('resolveWalletAddress', () => {
  it('throws BalanceError with no wallet configured at all', () => {
    expect(() => resolveWalletAddress(home)).toThrow(BalanceError);
  });

  it('resolves the current wallet from config', () => {
    saveConfig(home, { ...loadConfig(home), currentWallet: 'default' });
    const { name, address } = resolveWalletAddress(home);
    expect(name).toBe('default');
    expect(address).toBe(account.address);
  });

  it('an explicit wallet name overrides the configured current wallet', () => {
    expect(resolveWalletAddress(home, 'default').address).toBe(account.address);
  });

  it('throws for an unknown wallet name', () => {
    expect(() => resolveWalletAddress(home, 'ghost')).toThrow(BalanceError);
  });

  it('never needs a password (reads the keystore file\'s own plaintext address field)', () => {
    expect(() => resolveWalletAddress(home, 'default')).not.toThrow();
  });
});

describe('runBalance', () => {
  it('reads the QUAI balance through the injected provider', async () => {
    const providerFactory = vi.fn(() => ({ getBalance: vi.fn(async () => 5_000000000000000000n) }));
    const result = await runBalance({ home, wallet: 'default' }, { providerFactory });
    expect(result.wallet).toBe(account.address);
    expect(result.quai).toBe('5.0');
    expect(result.network).toBe('mainnet');
    expect(providerFactory).toHaveBeenCalledWith('https://rpc.quai.network/cyprus1');
  });

  it('honors --network orchard for the RPC URL', async () => {
    const providerFactory = vi.fn(() => ({ getBalance: vi.fn(async () => 0n) }));
    await runBalance({ home, wallet: 'default', network: 'orchard' }, { providerFactory });
    expect(providerFactory).toHaveBeenCalledWith('https://orchard.rpc.quai.network/cyprus1');
  });

  it('fetches token holdings when --tokens is passed', async () => {
    const providerFactory = () => ({ getBalance: vi.fn(async () => 0n) });
    const fetchFn = vi.fn(async () => ({ ok: true, json: async () => ({ holdings: [{ symbol: 'DEMO', balance: '1' }], totals: { valueQuai: '1' } }) }));
    const result = await runBalance({ home, wallet: 'default', tokens: true }, { providerFactory, fetchFn });
    expect(result.holdings).toHaveLength(1);
    expect(fetchFn).toHaveBeenCalledWith(`https://hartiilabs.com/api/portfolio/${account.address}`, expect.objectContaining({ method: 'GET' }));
  });

  it('degrades gracefully when the portfolio API is unreachable', async () => {
    const providerFactory = () => ({ getBalance: vi.fn(async () => 0n) });
    const fetchFn = vi.fn(async () => {
      throw new Error('network down');
    });
    const result = await runBalance({ home, wallet: 'default', tokens: true }, { providerFactory, fetchFn });
    expect(result.holdings).toBeNull();
    expect(result.holdingsError).toMatch(/network down/);
  });

  it('wraps a provider read failure in BalanceError', async () => {
    // A failing primary provider read makes rpcClient.js's resilientRead fall back to a raw POST
    // against its own proxyUrl — stub global fetch too, so this test's failure path never reaches
    // the real network (see the product spec : "mocked RPC/fetch only (no live network in tests)").
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('no live network in tests');
      }),
    );
    const providerFactory = () => ({
      getBalance: vi.fn(async () => {
        throw new Error('rpc down');
      }),
    });
    await expect(runBalance({ home, wallet: 'default' }, { providerFactory })).rejects.toThrow(BalanceError);
    vi.unstubAllGlobals();
  });

  it('demo mode never touches the network or keystore', async () => {
    const providerFactory = vi.fn();
    const result = await runBalance({ demo: true, tokens: true }, { providerFactory });
    expect(result.wallet).toBe(DEMO_ADDRESS);
    expect(result.holdings.length).toBeGreaterThan(0);
    expect(providerFactory).not.toHaveBeenCalled();
  });
  it('never falls back from an Orchard RPC failure to the mainnet proxy', async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, json: async () => ({ result: '0x99' }) }));
    vi.stubGlobal('fetch', fetchFn);
    try {
      await expect(runBalance({ home, wallet: 'default', network: 'orchard' }, { providerFactory: () => ({ getBalance: async () => { throw new Error('orchard offline'); } }) })).rejects.toThrow(/orchard offline/);
      expect(fetchFn).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });
  it('does not mix mainnet portfolio records into Orchard balances', async () => {
    const fetchFn = vi.fn();
    const result = await runBalance({ home, wallet: 'default', network: 'orchard', tokens: true }, { fetchFn, providerFactory: () => ({ getBalance: async () => 1n }) });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(result.holdings).toBeNull();
    expect(result.holdingsError).toMatch(/mainnet/i);
  });
  it.each([{ ok: false, status: 503, body: { holdings: [] } }, { ok: true, body: { error: 'unavailable' } }])('reports unavailable portfolio instead of fabricated empty holdings', async ({ ok, status, body }) => {
    const result = await runBalance({ home, wallet: 'default', tokens: true }, { fetchFn: async () => ({ ok, status, json: async () => body }), providerFactory: () => ({ getBalance: async () => 1n }) });
    expect(result.holdings).toBeNull();
    expect(result.holdingsError).toBeTruthy();
  });
});
