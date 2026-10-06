import { HARTIISWAP_ROUTER_ABI } from '../src/abi/hartiiSwapRouter.js';
// packages/hartii-cli/test/send.test.mjs
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getAddress, Interface } from 'quais';
import { runSend, SendError } from '../src/commands/send.js';
import { generateMnemonicAccount, encryptAccount, writeKeystoreFile } from '../src/keystore.js';
import { saveConfig, loadConfig } from '../src/config.js';
import { ERC20_ABI } from '../src/abi/erc20.js';
import { NetworkError } from '../src/network.js';
import { getSpentToday } from '../src/spendingGuard.js';
import { formatAmount } from '../src/amount.js';
import { buildReceiveLink } from '../src/paylinks.js';

const TOKEN = getAddress('0x00' + Buffer.from('token', 'utf8').toString('hex').padEnd(38, '0').slice(0, 38));
const TO = getAddress('0x00' + Buffer.from('recipient', 'utf8').toString('hex').padEnd(38, '0').slice(0, 38));
const ERC20_IFACE = new Interface(ERC20_ABI);
const SCRYPT_FAST = { N: 2, r: 1, p: 1 };
const PASSWORD = 'correct-horse-battery-staple';

function chainOkFetch() {
  return vi.fn(async (_url, options) => {
    if (options.method === 'GET') return {status:404,json:async()=>({error:'Not indexed'})};
    const body = JSON.parse(options.body);
    if (body.method === 'quai_chainId') return { json: async () => ({ result: '0x9' }) };
    return { json: async () => ({ error: { message: 'unexpected' } }) };
  });
}

let home;
let account;
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'hartii-cli-send-test-'));
  account = generateMnemonicAccount();
  const json = await encryptAccount({ address: account.address, privateKey: account.privateKey }, PASSWORD, { scrypt: SCRYPT_FAST });
  writeKeystoreFile(home, 'default', json);
  saveConfig(home, { ...loadConfig(home), currentWallet: 'default' });
}, 120_000);
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function nativeProvider({ balance = 100_000000000000000000n, estimate = 39_000n, gasPrice = 2_000000000n, nonce = 0 } = {}) {
  return {
    getBalance: vi.fn(async () => balance),
    call: vi.fn(async () => '0x'),
    createAccessList: vi.fn(async () => []),
    estimateGas: vi.fn(async () => estimate),
    getFeeData: vi.fn(async () => ({ gasPrice })),
    getTransactionCount: vi.fn(async () => nonce),
    getNetwork: vi.fn(async () => ({ chainId: 9n })),
  };
}

// Real quais Wallet.sendTransaction needs a provider implementing its full internal
// zone/broadcast surface — a plain mocked provider (as every test here uses) cannot support that.
// `send.js`'s `deps.walletFactory` seam exists exactly so tests can swap in this simple mocked
// signer instead, the same shape writePipeline.test.mjs / packages/agent-mcp/test/execute.test.mjs
// already use, while production always builds the real quais Wallet.
function mockWalletFactory(address, { receiptStatus = 1 } = {}) {
  return (_privateKey, _provider) => ({
    getAddress: vi.fn(async () => address),
    sendTransaction: vi.fn(async (tx) => ({
      hash: '0x' + 'ab'.repeat(32),
      wait: vi.fn(async () => ({ status: receiptStatus, hash: '0x' + 'ab'.repeat(32) })),
      ...tx,
    })),
  });
}

function erc20Provider({ symbol = 'TEST', decimals = 18, balance = 1_000_000000000000000000n, estimate = 60_000n, gasPrice = 2_000000000n, nonce = 0 } = {}) {
  const router = new Interface(HARTIISWAP_ROUTER_ABI);
  const sel = {
    [router.getFunction('getAmountsOut').selector]: () => router.encodeFunctionResult('getAmountsOut', [[10n ** 18n, 10n ** 18n]]),
    [ERC20_IFACE.getFunction('symbol').selector]: () => ERC20_IFACE.encodeFunctionResult('symbol', [symbol]),
    [ERC20_IFACE.getFunction('decimals').selector]: () => ERC20_IFACE.encodeFunctionResult('decimals', [decimals]),
    [ERC20_IFACE.getFunction('balanceOf').selector]: () => ERC20_IFACE.encodeFunctionResult('balanceOf', [balance]),
    [ERC20_IFACE.getFunction('transfer').selector]: () => ERC20_IFACE.encodeFunctionResult('transfer', [true]),
  };
  return {
    call: vi.fn(async (tx) => {
      const selector = tx.data.slice(0, 10);
      if (!sel[selector]) throw new Error(`unmocked selector ${selector}`);
      return sel[selector]();
    }),
    createAccessList: vi.fn(async () => []),
    estimateGas: vi.fn(async () => estimate),
    getFeeData: vi.fn(async () => ({ gasPrice })),
    getTransactionCount: vi.fn(async () => nonce),
    getNetwork: vi.fn(async () => ({ chainId: 9n })),
  };
}

describe('runSend — demo mode', () => {
  it('never touches the network or keystore', async () => {
    const providerFactory = vi.fn();
    const result = await runSend({ to: TO, amount: '1.5', demo: true }, { providerFactory });
    expect(result.ok).toBe(true);
    expect(result.demo).toBe(true);
    expect(providerFactory).not.toHaveBeenCalled();
  });
});

describe('runSend — network guard', () => {
  it('refuses to proceed when the RPC reports the wrong chain id', async () => {
    const fetchFn = vi.fn(async () => ({ json: async () => ({ result: '0x3a98' }) })); // orchard's id, while mainnet is expected
    await expect(
      runSend({ home, to: TO, amount: '1' }, { fetchFn, providerFactory: () => nativeProvider(), passwordDeps: { env: { HARTII_PASSWORD: PASSWORD } } }),
    ).rejects.toThrow(NetworkError);
  });
});

describe('runSend — native QUAI', () => {
  it('sends the exact amount and recipient from an HPAY link through the guarded pipeline', async () => {
    const sendTransaction = vi.fn(async tx => ({ hash: '0x' + 'ab'.repeat(32), wait: async () => ({status:1,hash:'0x'+'ab'.repeat(32)}), ...tx }));
    const result = await runSend({home,to:buildReceiveLink({address:TO,amount:'0.000000000000000001',memo:'Invoice 12'}),yes:true}, {
      fetchFn:chainOkFetch(),providerFactory:()=>nativeProvider(),walletFactory:()=>({getAddress:async()=>account.address,sendTransaction}),passwordDeps:{env:{HARTII_PASSWORD:PASSWORD}},
    });
    expect(result.ok).toBe(true);
    expect(sendTransaction.mock.calls[0][0]).toMatchObject({to:TO,value:1n});
    expect(result.summary.memo).toBe('Invoice 12');
  });
  it('refuses a conflicting explicit amount before network or password access', async () => {
    const providerFactory=vi.fn(),promptFn=vi.fn();
    await expect(runSend({home,to:buildReceiveLink({address:TO,amount:'2.5'}),amount:'3',yes:true},{providerFactory,passwordDeps:{promptFn}})).rejects.toThrow(/differs/);
    expect(providerFactory).not.toHaveBeenCalled();expect(promptFn).not.toHaveBeenCalled();
  });
  it('refuses an expired payment link before network access', async () => {
    const providerFactory=vi.fn();
    await expect(runSend({home,to:buildReceiveLink({address:TO,amount:'2.5',expiresAt:1}),yes:true},{providerFactory})).rejects.toThrow(/expired/);
    expect(providerFactory).not.toHaveBeenCalled();
  });
  it('sends a plain decimal amount end to end', async () => {
    const provider = nativeProvider();
    const providerFactory = vi.fn(() => provider);
    const result = await runSend(
      { home, to: TO, amount: '5', yes: true },
      { fetchFn: chainOkFetch(), providerFactory, walletFactory: mockWalletFactory(account.address), passwordDeps: { env: { HARTII_PASSWORD: PASSWORD } }, io: {} },
    );
    expect(result.ok).toBe(true);
    expect(result.txHash).toBeDefined();
    { const spent = getSpentToday(home, account.address).spentWei; expect(spent >= 5_000000000000000000n && spent < 5_000000000000000000n + 10n ** 15n).toBe(true); /* value + estimated fee counts toward the guard (M3) */ }
  });

  it('rejects the wrong password', async () => {
    const provider = nativeProvider();
    await expect(
      runSend({ home, to: TO, amount: '5', yes: true }, { fetchFn: chainOkFetch(), providerFactory: () => provider, passwordDeps: { env: { HARTII_PASSWORD: 'wrong' } } }),
    ).rejects.toThrow(/wrong password/i);
  });

  it('"all" reserves gas instead of sending the literal full balance', async () => {
    const provider = nativeProvider({ balance: 10_000000000000000000n, estimate: 39_000n, gasPrice: 2_000000000n });
    const result = await runSend(
      { home, to: TO, amount: 'all', yes: true },
      { fetchFn: chainOkFetch(), providerFactory: () => provider, walletFactory: mockWalletFactory(account.address), passwordDeps: { env: { HARTII_PASSWORD: PASSWORD } } },
    );
    expect(result.ok).toBe(true);
    // reserve = estimate x1.2 buffer x1.1 margin (see src/gasReserve.js)
    const expectedFee = ((((39_000n * 1200n) / 1000n) * 2_000000000n) * 110n) / 100n;
    const expectedValue = 10_000000000000000000n - expectedFee;
    expect(result.summary.valueQuai).toBe(formatAmount(expectedValue));
  });

  it('rejects sending more than the balance', async () => {
    const provider = nativeProvider({ balance: 1_000000000000000000n });
    await expect(
      runSend({ home, to: TO, amount: '5', yes: true }, { fetchFn: chainOkFetch(), providerFactory: () => provider, passwordDeps: { env: { HARTII_PASSWORD: PASSWORD } } }),
    ).rejects.toThrow(SendError);
  });

  it('rejects an invalid destination before touching the keystore password', async () => {
    const provider = nativeProvider();
    const passwordDeps = { env: {}, promptFn: vi.fn() };
    await expect(runSend({ home, to: 'not-an-address', amount: '1', yes: true }, { fetchFn: chainOkFetch(), providerFactory: () => provider, passwordDeps })).rejects.toThrow();
    expect(passwordDeps.promptFn).not.toHaveBeenCalled();
  });
});

describe('runSend — ERC20', () => {
  it('sends a token amount end to end', async () => {
    const provider = erc20Provider({ symbol: 'HRTI', decimals: 18, balance: 1_000_000000000000000000n });
    const result = await runSend(
      { home, to: TO, amount: '10', token: TOKEN, yes: true },
      { fetchFn: chainOkFetch(), providerFactory: () => provider, walletFactory: mockWalletFactory(account.address), passwordDeps: { env: { HARTII_PASSWORD: PASSWORD } } },
    );
    expect(result.ok).toBe(true);
    expect(result.summary.token).toMatch(/^HRTI \(0x[0-9a-fA-F]{40}\)$/); // M6
    expect(result.summary.tokenAmount).toBe('10.0');
    // The live QUAI quote gates and records non-native spending.
    { const spent = getSpentToday(home, account.address).spentWei; expect(spent >= 10n**18n && spent < 10n**18n + 10n ** 15n).toBe(true); /* value + estimated fee counts toward the guard (M3) */ }
  });

  it('rejects an amount over the token balance', async () => {
    const provider = erc20Provider({ balance: 1_000000000000000000n }); // 1 token
    await expect(
      runSend({ home, to: TO, amount: '5', token: TOKEN, yes: true }, { fetchFn: chainOkFetch(), providerFactory: () => provider, passwordDeps: { env: { HARTII_PASSWORD: PASSWORD } } }),
    ).rejects.toThrow(SendError);
  });

  it('rejects a ticker that is not indexed', async () => {
    const provider = erc20Provider();
    await expect(
      runSend({ home, to: TO, amount: '1', token: 'HRTI', yes: true }, { fetchFn: chainOkFetch(), providerFactory: () => provider, passwordDeps: { env: { HARTII_PASSWORD: PASSWORD } } }),
    ).rejects.toThrow(/not indexed/i);
  });
});

describe('runSend — confirmation gate', () => {
  it('aborts without sending when the user declines', async () => {
    const provider = nativeProvider();
    const confirmFn = vi.fn(async () => false);
    const result = await runSend(
      { home, to: TO, amount: '1' },
      { fetchFn: chainOkFetch(), providerFactory: () => provider, passwordDeps: { env: { HARTII_PASSWORD: PASSWORD } }, io: { confirmFn, write: () => {} } },
    );
    expect(result.ok).toBe(false);
    expect(result.aborted).toBe(true);
  });
});
