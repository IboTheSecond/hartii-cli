import { beforeAll, beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Interface, Wallet, QuaiTransaction, Zone, JsonRpcApiProvider } from 'quais';
import { runBuy } from '../src/commands/buy.js';
import { main } from '../src/cli.js';
import { readGasPrice } from '../src/gasPrice.js';
import { saveConfig } from '../src/config.js';
import { generateMnemonicAccount } from '../src/keystore.js';
import { listSpendReservations } from '../src/spendingGuard.js';
import { BONDING_CURVE_ABI, BONDING_CURVE_V3_ABI, BONDING_CURVE_V3_TRADE_ABI } from '../src/abi/bondingCurve.js';
import { DEMO_CURVE_META } from '../src/demoFixtures.js';
import { rawBuyOut } from '../src/curveQuote.js';

const TOKEN = '0x0010000000000000000000000000000000000002';
const CURVE = '0x0010000000000000000000000000000000000003';
const ONE = 10n ** 18n;
const curve = new Interface([...BONDING_CURVE_ABI, ...BONDING_CURVE_V3_ABI]);
const trade = new Interface(BONDING_CURVE_V3_TRADE_ABI);
const factory = new Interface(['function curveOf(address) view returns (address)']);
let account, home;
beforeAll(() => { account = generateMnemonicAccount(); }, 120_000);
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'hartii-buy-reliability-'));
  mkdirSync(join(home, 'keystore'));
  writeFileSync(join(home, 'keystore', 'synthetic.json'), JSON.stringify({ address: account.address.slice(2) }));
  saveConfig(home, { network: 'mainnet', currentWallet: 'synthetic', limits: { perTxQuai: '100', dailyQuai: '500' } });
  vi.stubGlobal('fetch', vi.fn(() => { throw Error('Live network is forbidden in this proof'); }));
});
afterEach(() => { vi.unstubAllGlobals(); }); // Preserve synthetic evidence; never touch a user's home.

function harness({ balance = 20n * ONE, nonce = 0, gasPrice = 1n, gas = 100_000n, meta = DEMO_CURVE_META } = {}) {
  const provider = {
    call: vi.fn(async tx => {
      if (tx.data?.startsWith(factory.getFunction('curveOf').selector)) return factory.encodeFunctionResult('curveOf', [CURVE]);
      if (tx.data?.startsWith(trade.getFunction('buy').selector)) return trade.encodeFunctionResult('buy', [1n]);
      const p = curve.parseTransaction({ data: tx.data });
      if (p.name === 'token') return curve.encodeFunctionResult(p.name, [TOKEN]);
      if (p.name === 'creatorPayout') {
        if (!meta.isV3) throw JsonRpcApiProvider.prototype.getRpcError.call({}, { method: 'quai_call', params: [tx, 'latest'] }, { error: { code: -32000, message: 'execution reverted', data: '0x' } }, '0x00');
        return curve.encodeFunctionResult(p.name, [account.address]);
      }
      if (p.name === 'quoteBuy') return curve.encodeFunctionResult(p.name, [rawBuyOut(meta, p.args[0])]);
      if (p.name === 'buy') return curve.encodeFunctionResult(p.name, [1n]);
      return curve.encodeFunctionResult(p.name, [meta[p.name] ?? 0n]);
    }),
    getNetwork: vi.fn(async () => ({ chainId: 9n })),
    getBalance: vi.fn(async () => balance),
    getTransactionCount: vi.fn(async () => nonce),
    getFeeData: vi.fn(async () => ({ gasPrice })),
    estimateGas: vi.fn(async () => gas),
    createAccessList: vi.fn(async () => []),
    broadcastTransaction: vi.fn(async (_zone, raw) => {
      const signed = QuaiTransaction.from(raw);
      return { ...signed.toJSON(), hash: signed.hash, wait: async () => ({ status: 1, hash: signed.hash, fee: 7n }) };
    }),
    destroy: vi.fn(),
  };
  const deps = {
    env: { HARTII_HOME: home, SYNTHETIC_KEY: account.privateKey },
    fetchFn: vi.fn(async (_url, init) => ({ status: 200, json: async () => init?.method === 'POST'
      ? { result: '0x9' } : { token: { address: TOKEN, curveAddress: CURVE, symbol: 'TEST', network: 'mainnet' } } })),
    providerFactory: () => provider,
    io: { write: vi.fn(), writeErr: vi.fn() },
  };
  return { provider, deps, opts: { home, token: TOKEN, quai: '1', keyEnv: 'SYNTHETIC_KEY', yes: true } };
}

describe('buy transaction preparation with the real quais signing implementation', () => {
  it('preserves an explicitly reviewed nonce zero instead of letting SDK population replace it', async () => {
    const { provider, deps, opts } = harness();
    // A first-use wallet is reviewed at nonce zero; an extra SDK population read sees a different nonce.
    provider.getTransactionCount.mockImplementation(async () => provider.getTransactionCount.mock.calls.length <= 3 ? 0 : 1);
    const result = await runBuy(opts, deps);
    expect(result.status).toBe('success');
    expect(provider.getTransactionCount).toHaveBeenCalledTimes(3);
    expect(provider.broadcastTransaction).toHaveBeenCalledTimes(1);
    expect(QuaiTransaction.from(provider.broadcastTransaction.mock.calls[0][1]).nonce).toBe(0);
    expect(listSpendReservations(home)).toEqual([]);
  });

  it('releases a reservation when offline signing fails before the broadcast call is entered', async () => {
    const { provider, deps, opts } = harness();
    const signer = new Wallet(account.privateKey, provider);
    signer.signTransaction = vi.fn(async () => { throw Error('Synthetic local signing failure'); });
    await expect(runBuy(opts, { ...deps, walletFactory: () => signer })).rejects.toThrow(/rejected before broadcast/);
    expect(provider.broadcastTransaction).not.toHaveBeenCalled();
    expect(listSpendReservations(home)).toEqual([]);
  });

  it('rejects signed bytes whose nonce differs from the reviewed transaction before broadcasting', async () => {
    const { provider, deps, opts } = harness();
    const signer = new Wallet(account.privateKey, provider);
    const sign = signer.signTransaction.bind(signer);
    signer.signTransaction = tx => sign({ ...tx, nonce: tx.nonce + 1 });
    await expect(runBuy(opts, { ...deps, walletFactory: () => signer })).rejects.toThrow(/rejected before broadcast/);
    expect(provider.broadcastTransaction).not.toHaveBeenCalled();
    expect(listSpendReservations(home)).toEqual([]);
  });

  it.each(['nonce', 'chain', 'expiry'])('rechecks %s after asynchronous offline signing before dispatch', async change => {
    const { provider, deps, opts } = harness();
    const signer = new Wallet(account.privateKey);
    const sign = signer.signTransaction.bind(signer);
    let expired = false;
    signer.signTransaction = async tx => {
      const raw = await sign(tx);
      if (change === 'nonce') provider.getTransactionCount.mockResolvedValue(1);
      if (change === 'chain') provider.getNetwork.mockResolvedValue({ chainId: 15000n });
      if (change === 'expiry') expired = true;
      return raw;
    };
    const io = { ...deps.io, validateBeforeSubmit: () => { if (expired) throw Error('Synthetic approval expired'); } };
    await expect(runBuy(opts, { ...deps, io, walletFactory: () => signer })).rejects.toThrow(/rejected before broadcast/);
    expect(provider.broadcastTransaction).not.toHaveBeenCalled();
    expect(listSpendReservations(home)).toEqual([]);
  });

  it('preserves canonical access-list authority through offline signing', async () => {
    const { provider, deps, opts } = harness();
    provider.createAccessList.mockResolvedValue([{ address: CURVE.toLowerCase(), storageKeys: ['0x' + 'AB'.repeat(32)] }]);
    const result = await runBuy(opts, deps);
    expect(result.ok).toBe(true);
    const signed = QuaiTransaction.from(provider.broadcastTransaction.mock.calls[0][1]);
    expect(signed.accessList).toEqual([{ address: CURVE, storageKeys: ['0x' + 'ab'.repeat(32)] }]);
  });

  it('retains the locally computed signed hash when the broadcast response is lost', async () => {
    const { provider, deps, opts } = harness();
    provider.broadcastTransaction.mockRejectedValue(Error('Synthetic connection reset after dispatch'));
    await expect(runBuy(opts, deps)).rejects.toThrow(/outcome unknown/);
    expect(provider.broadcastTransaction).toHaveBeenCalledTimes(1);
    const signed = QuaiTransaction.from(provider.broadcastTransaction.mock.calls[0][1]);
    expect(listSpendReservations(home)[0].txHash).toBe(signed.hash);
  });

  it('returns the known pending hash through the buy error boundary for inspection', async () => {
    const { provider, deps, opts } = harness();
    provider.broadcastTransaction.mockRejectedValue(Error('Synthetic connection reset after dispatch'));
    let failure;
    try { await runBuy(opts, deps); } catch (error) { failure = error; }
    const signed = QuaiTransaction.from(provider.broadcastTransaction.mock.calls[0][1]);
    expect(failure).toMatchObject({ txHash: signed.hash, status: 'unconfirmed' });
    expect(failure.message).toContain(signed.hash);
  });

  it('does not release allowance for an admission-looking error from a concurrent broadcast head read', async () => {
    const { provider, deps, opts } = harness();
    provider.broadcastTransaction.mockRejectedValue(Object.assign(Error('Synthetic block query failure'), {
      code: 'INSUFFICIENT_FUNDS', info: { error: { message: 'insufficient funds' } },
      payload: { method: 'quai_blockNumber', params: [] },
    }));
    await expect(runBuy(opts, deps)).rejects.toThrow(/outcome unknown/);
    expect(listSpendReservations(home)).toHaveLength(1);
    expect(listSpendReservations(home)[0].txHash).toBe(QuaiTransaction.from(provider.broadcastTransaction.mock.calls[0][1]).hash);
  });

  it('releases allowance for an SDK node rejection bound to the exact signed bytes', async () => {
    const { provider, deps, opts } = harness();
    provider.broadcastTransaction.mockImplementation(async (_zone, raw) => { throw Object.assign(Error('Node refused raw transaction'), {
      code: 'INSUFFICIENT_FUNDS', transaction: raw, info: { error: { code: -32000, message: 'insufficient funds' } },
    }); });
    await expect(runBuy(opts, deps)).rejects.toThrow(/rejected before broadcast/);
    expect(provider.broadcastTransaction).toHaveBeenCalledTimes(1);
    expect(listSpendReservations(home)).toEqual([]);
  });

  it('rejects a returned hash different from the locally signed transaction and keeps its known hash pending', async () => {
    const { provider, deps, opts } = harness();
    const wrongHash = '0x' + 'ab'.repeat(32);
    provider.broadcastTransaction.mockResolvedValue({ hash: wrongHash, wait: async () => ({ status: 1, hash: wrongHash }) });
    await expect(runBuy(opts, deps)).rejects.toThrow(/outcome unknown/);
    const signed = QuaiTransaction.from(provider.broadcastTransaction.mock.calls[0][1]);
    expect(listSpendReservations(home)[0].txHash).toBe(signed.hash);
  });

  it('refuses a missing contract access list before unlocking or broadcasting', async () => {
    const { provider, deps, opts } = harness();
    provider.createAccessList.mockResolvedValue(undefined);
    const walletFactory = vi.fn(() => new Wallet(account.privateKey, provider));
    await expect(runBuy(opts, { ...deps, walletFactory })).rejects.toThrow(/access list/i);
    expect(walletFactory).not.toHaveBeenCalled();
    expect(provider.broadcastTransaction).not.toHaveBeenCalled();
    expect(listSpendReservations(home)).toEqual([]);
  });

  it('reserves gas using the same access list as the actual full-balance buy', async () => {
    const { provider, deps, opts } = harness({ balance: ONE, gasPrice: 10n ** 12n });
    provider.estimateGas.mockImplementation(async tx => tx.accessList ? 150_000n : 100_000n);
    const result = await runBuy({ ...opts, quai: 'all', dryRun: true }, deps);
    expect(result.ok).toBe(true);
    expect(BigInt(result.summary.gasLimit)).toBe(180_000n);
    expect(BigInt(result.summary.gasPriceWei)).toBe(10n ** 12n);
    expect(result.summary.valueQuai).toBe('0.802');
    expect(provider.broadcastTransaction).not.toHaveBeenCalled();
  });

  it.each(['all', '100%', '90%'])('rechecks gas after trimming and requoting a %s buy', async quai => {
    const { provider, deps, opts } = harness({ balance: ONE, gasPrice: 10n ** 12n });
    provider.estimateGas.mockImplementation(async tx => tx.value >= 900_000_000_000_000_000n ? 100_000n : 170_000n);
    const result = await runBuy({ ...opts, quai, dryRun: true }, deps);
    expect(result.ok).toBe(true);
    expect(result.summary.valueQuai).toBe('0.7756');
    expect(result.summary.estimatedFeeQuai).toBe('0.204');
    expect(provider.broadcastTransaction).not.toHaveBeenCalled();
  });

  it('runs real CLI argument parsing and emits one successful dry-run JSON result without a signing account', async () => {
    const { provider, deps } = harness();
    const write = vi.fn(), writeErr = vi.fn(), walletFactory = vi.fn();
    const code = await main(['buy', TOKEN, '1', '--dry-run', '--json'], { ...deps, walletFactory, write, writeErr });
    expect(code).toBe(0);
    expect(write).toHaveBeenCalledTimes(1);
    expect(JSON.parse(write.mock.calls[0][0])).toMatchObject({ ok: true, dryRun: true, summary: { from: account.address, nonce: 0, chainId: 9, quaiIn: '1.0' } });
    expect(walletFactory).not.toHaveBeenCalled();
    expect(provider.broadcastTransaction).not.toHaveBeenCalled();
    expect(provider.destroy).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['legacy bonding curve', { ...DEMO_CURVE_META, isV3: false }],
    ['V3/V4 bonding curve', DEMO_CURVE_META],
    ['graduated V3/V4 internal pool', { ...DEMO_CURVE_META, graduated: true, poolQuaiReserve: 25_000n * ONE, poolTokenReserve: 200_000_000n * ONE }],
  ])('keeps exact fee rounding and the appropriate buy ABI for a %s', async (_phase, meta) => {
    const amount = ONE + 1n;
    const { provider, deps, opts } = harness({ meta });
    const result = await runBuy({ ...opts, quai: '1.000000000000000001', dryRun: true }, deps);
    const quoteCall = provider.call.mock.calls.find(([tx]) => tx.data.startsWith(curve.getFunction('quoteBuy').selector))[0];
    expect(curve.parseTransaction(quoteCall).args[0]).toBe(amount - amount * meta.feeBps / 10_000n);
    const simulation = provider.call.mock.calls.find(([tx]) => tx.from)[0];
    expect(simulation.data.slice(0,10)).toBe((meta.isV3 ? trade : curve).getFunction('buy').selector);
    expect(result.summary.phase).toBe(meta.graduated ? 'pool (graduated)' : 'bonding curve');
  });
});

describe('gas-price SDK routing', () => {
  it('passes the Cyprus-1 zone required by quais instead of forcing every read into its raw fallback', async () => {
    const provider = { getFeeData: vi.fn(async zone => {
      if (zone !== Zone.Cyprus1) throw Error('Invalid shard');
      return { gasPrice: 123n };
    }) };
    expect(await readGasPrice(provider, 'https://public.invalid/cyprus1')).toBe(123n);
    expect(provider.getFeeData).toHaveBeenCalledWith(Zone.Cyprus1);
    expect(fetch).not.toHaveBeenCalled();
  });
});
