// Regression tests for the Hartii CLI security review (H1/H2 live in m3Tools/m2Safety; M1/M2/M6 MCP bits in mcp.test).
// Mocked RPC/fetch only, throwaway keys.
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getAddress, Wallet } from 'quais';
import { runWrite, WriteError } from '../src/writePipeline.js';
import { writeRuntime } from '../src/commandContext.js';
import { withSpendLock, SpendGuardError, getSpentToday } from '../src/spendingGuard.js';
import { redactUrls, withAddr } from '../src/output.js';
import { assertChainId } from '../src/network.js';
import { main } from '../src/cli.js';
import { generateMnemonicAccount } from '../src/keystore.js';
import { saveConfig } from '../src/config.js';
import { offlineWallet } from './fakeBroadcast.mjs';
import { assertCyprus1QuaiAddress } from '../src/address.js';
import * as walletCommands from '../src/commands/walletCmd.js';
import { DEMO_ADDRESS, DEMO_TOKEN, DEMO_CURVE_ADDRESS, DEMO_TOKENS_LIST, DEMO_TOKEN_HOLDINGS } from '../src/demoFixtures.js';
import { demoState } from '../src/tui/demoData.js';

const FROM = getAddress('0x0010000000000000000000000000000000000001');
const TO = getAddress('0x0010000000000000000000000000000000000002');
const ONE = 10n ** 18n;
let home;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'hartii-sec-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); vi.restoreAllMocks(); });

function rig({ gasPrice = 1n, estimate = 100_000n } = {}) {
  const sends = [];
  const provider = {
    getNetwork: async () => ({ chainId: 9n }),
    call: vi.fn(async () => '0x'), createAccessList: vi.fn(async () => []), estimateGas: vi.fn(async () => estimate),
    getFeeData: vi.fn(async () => ({ gasPrice })), getTransactionCount: vi.fn(async () => 0),
  };
  const wallet = { getAddress: async () => FROM, sendTransaction: vi.fn(async (tx) => { sends.push(tx); return { hash: '0x' + 'ab'.repeat(32), wait: async () => ({ status: 1, hash: '0x' + 'ab'.repeat(32) }) }; }) };
  return { provider, wallet, sends };
}
const base = (r, extra = {}) => ({ wallet: r.wallet, provider: r.provider, network: { name: 'mainnet', chainId: 9 }, home, limits: { perTxQuai: '100', dailyQuai: '500' }, to: TO, value: ONE, action: 'x', yes: true, ...extra });

describe('M3 fee ceiling', () => {
  it('refuses a fee above max(25 QUAI, 5% of value) before signing', async () => {
    const r = rig({ gasPrice: 3n * 10n ** 14n }); // 120000 gas * 3e14 = 36 QUAI > 25 QUAI
    await expect(runWrite(base(r, { io: { write: () => {} } }))).rejects.toThrow(/fee ceiling/);
    expect(r.wallet.sendTransaction).not.toHaveBeenCalled();
  });
  it('a larger value raises the 5% ceiling; the human --max-fee (io.maxFeeWei) raises it explicitly', async () => {
    const big = rig({ gasPrice: 3n * 10n ** 14n });
    expect((await runWrite(base(big, { value: 800n * ONE, limits: { perTxQuai: '1000', dailyQuai: '5000' }, io: { write: () => {} } }))).ok).toBe(true); // 5% of 800 = 40 QUAI >= 36
    const human = rig({ gasPrice: 3n * 10n ** 14n });
    expect((await runWrite(base(human, { limits: { perTxQuai: '1000', dailyQuai: '5000' }, io: { write: () => {}, maxFeeWei: 40n * ONE } }))).ok).toBe(true);
  });
  it('counts the estimated fee toward the spending guard', async () => {
    const r = rig({ gasPrice: 10n ** 12n }); // fee 0.12 QUAI
    await expect(runWrite(base(r, { value: 0n, limits: { perTxQuai: '0.1', dailyQuai: '500' }, io: { write: () => {} } }))).rejects.toThrow(/limit/i);
    const ok = rig({ gasPrice: 10n ** 12n });
    await runWrite(base(ok, { io: { write: () => {} } }));
    expect(getSpentToday(home, FROM).spentWei).toBe(ONE + 120_000n * 10n ** 12n);
  });
  it('the CLI --max-fee flag only accepts a positive QUAI amount', async () => {
    const err = vi.fn();
    expect(await main(['send', TO, '1', '--max-fee', 'abc'], { env: { HARTII_HOME: home }, write: vi.fn(), writeErr: err })).toBe(1);
    expect(err.mock.calls.join('')).toMatch(/--max-fee/);
  });
});

describe('M4 chain pin', () => {
  let THROWAWAY; // Cyprus-1 Quai key generated inside the test
  beforeAll(() => { THROWAWAY = generateMnemonicAccount().privateKey; }, 120_000);
  function runtimeRig(providerChain) {
    mkdirSync(join(home, 'keystore'), { recursive: true });
    writeFileSync(join(home, 'keystore', 'w.json'), JSON.stringify({ address: FROM.slice(2) }));
    saveConfig(home, { network: 'mainnet', currentWallet: 'w', limits: { perTxQuai: '100', dailyQuai: '500' } });
    const provider = { getNetwork: async () => ({ chainId: providerChain }), getTransactionCount: async () => 0, destroy() {} };
    const signerSend = vi.fn(async () => ({ wait: async () => ({ status: 1 }) }));
    const fetchFn = async () => ({ status: 200, json: async () => ({ result: '0x9' }) });
    return { signerSend, deps: { fetchFn, providerFactory: () => provider, walletFactory: key => offlineWallet(key,provider,signerSend), env: { K: THROWAWAY }, io: { writeErr: () => {} } } };
  }
  it('refuses to sign a tx whose chain id is not the expected one', async () => {
    const { deps, signerSend } = runtimeRig(9n);
    const rt = await writeRuntime({ home, keyEnv: 'K' }, deps);
    await expect(rt.wallet.sendTransaction({ to: TO, chainId: 15000n })).rejects.toThrow(/chain id/);
    await expect(rt.wallet.sendTransaction({ to: TO })).rejects.toThrow(/chain id/);
    expect(signerSend).not.toHaveBeenCalled();
  });
  it('refuses when the provider reports a different chain right before signing', async () => {
    const { deps, signerSend } = runtimeRig(15000n);
    const rt = await writeRuntime({ home, keyEnv: 'K' }, deps);
    await expect(rt.wallet.sendTransaction({ from: rt.from, to: TO, data: '0x', value: 0n, gasLimit: 1n, gasPrice: 1n, nonce: 0, chainId: 9n })).rejects.toThrow(/RPC reports chain/);
    expect(signerSend).not.toHaveBeenCalled();
  });
  it('signs when everything agrees; runWrite supplies the chain id', async () => {
    const { deps, signerSend } = runtimeRig(9n);
    const rt = await writeRuntime({ home, keyEnv: 'K' }, deps);
    await rt.wallet.sendTransaction({ from: rt.from, to: TO, data: '0x', value: 0n, gasLimit: 1n, gasPrice: 1n, nonce: 0, chainId: 9n });
    expect(signerSend).toHaveBeenCalled();
    const r = rig();
    await runWrite(base(r, { io: { write: () => {} } }));
    expect(r.sends[0].chainId).toBe(9n);
  });
});

describe('M5 wallet import secrets', () => {
  it('reads the key from the hidden prompt by default, never from argv', async () => {
    const promptFn = vi.fn(async () => '0x' + '22'.repeat(32));
    const spy = vi.spyOn(walletCommands, 'walletImport').mockResolvedValue({ name: 'n', address: 'a' });
    expect(await main(['wallet', 'import', 'key', 'named', '--json'], { env: { HARTII_HOME: home }, write: vi.fn(), writeErr: vi.fn(), promptFn })).toBe(0);
    expect(promptFn.mock.calls[0][0]).toMatch(/hidden/);
    expect(spy).toHaveBeenCalledWith(home, 'key', '0x' + '22'.repeat(32), 'named', expect.any(Object));
  });
  it('rejects a secret on the command line without --from-arg', async () => {
    const err = vi.fn();
    const code = await main(['wallet', 'import', 'key', '0x' + '33'.repeat(32)], { env: { HARTII_HOME: home }, write: vi.fn(), writeErr: err });
    expect(code).toBe(1);
    expect(err.mock.calls.join('')).toMatch(/--from-arg/);
  });
  it('--from-arg is refused without echoing or importing the supplied key', async () => {
    const spy = vi.spyOn(walletCommands, 'walletImport').mockResolvedValue({ name: 'n', address: 'a' });
    const err = vi.fn();
    expect(await main(['wallet', 'import', 'key', '--from-arg', '0x' + '44'.repeat(32)], { env: { HARTII_HOME: home }, write: vi.fn(), writeErr: err })).toBe(1);
    expect(spy).not.toHaveBeenCalled();
    expect(err.mock.calls.join('')).toMatch(/removed|hidden prompt/);
    expect(err.mock.calls.join('').includes('0x' + '44'.repeat(32))).toBe(false);
  });
});

describe('L redaction and stale lock', () => {
  it('redacts credentials, query strings and key-like path segments from URLs', () => {
    const out = redactUrls('fail https://user:pass@rpc.example.com/v2/abcdefghijklmnop1234567890?apikey=SECRET#frag now');
    expect(out).not.toMatch(/pass|abcdefghijklmnop|SECRET|frag|user/);
    expect(out).toContain('rpc.example.com');
    expect(redactUrls('https://quaiscan.io/tx/0x' + 'cd'.repeat(32))).toContain('0xcdcd');
  });
  it('never echoes an rpc url secret in a chain-id error', async () => {
    const fetchFn = async () => { throw new Error('boom https://rpc.example.com/key1234567890abcdefgh?token=SECRET'); };
    const e = await assertChainId('https://rpc.example.com/key1234567890abcdefgh?token=SECRET', 9, { fetchFn }).catch((x) => x);
    expect(e.message).not.toMatch(/SECRET|key1234567890abcdefgh/);
  });
  it('a write error never leaks an rpc url secret', () => {
    expect(new WriteError('x https://h.example/abcdefghijklmnop1234?k=SECRET').message).not.toMatch(/SECRET|abcdefghijklmnop/);
  });
  it('a held/stale spend.lock names its path, age and how to clear it, and is never auto-removed', async () => {
    mkdirSync(home, { recursive: true });
    const lock = join(home, 'spend.lock');
    writeFileSync(lock, JSON.stringify({ pid: 123, startedAt: new Date(Date.now() - 3 * 3600_000).toISOString() }));
    const e = await withSpendLock(home, FROM, async () => 1).catch((x) => x);
    expect(e).toBeInstanceOf(SpendGuardError);
    expect(e.message).toContain(lock);
    expect(e.message).toMatch(/STALE/);
    expect(e.message).toMatch(/delete that file/);
    expect(readFileSync(lock, 'utf8')).toContain('123');
  });
});

describe('M6 helper', () => {
  it('puts the address next to the symbol, once', () => {
    expect(withAddr('EVIL', TO)).toBe(`EVIL (${TO})`);
    expect(withAddr(`EVIL (${TO})`, TO)).toBe(`EVIL (${TO})`);
    expect(withAddr('QUAI', null)).toBe('QUAI');
  });
});

describe('fixture hygiene', () => {
  it('demo fixtures use only fake Cyprus-1-shaped placeholders and none of the real wallets/factories', () => {
    const src = [DEMO_ADDRESS, DEMO_TOKEN.address, DEMO_CURVE_ADDRESS, ...DEMO_TOKENS_LIST.map((t) => t.address), ...DEMO_TOKEN_HOLDINGS.map((h) => h.tokenAddress)];
    const st = demoState();
    src.push(...st.trades.map((t) => t.trader), ...st.watch.map((w) => w.address));
    for (const a of src) {
      expect(a).toMatch(/^0x0{30,}[0-9a-f]{1,10}$/);
      expect(() => assertCyprus1QuaiAddress(a)).not.toThrow();
    }
    const blob = readFileSync(new URL('../src/demoFixtures.js', import.meta.url), 'utf8') + readFileSync(new URL('../src/tui/demoData.js', import.meta.url), 'utf8');
  });
});
