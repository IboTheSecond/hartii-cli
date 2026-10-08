// Regression tests for the adversarial review of the Hartii CLI (2026-10-06). Each describe block
// names the finding it pins; every test here failed before the matching fix.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getAddress } from 'quais';
import { runWrite, WriteError, BroadcastError } from '../src/writePipeline.js';
import { runSend } from '../src/commands/send.js';
import { generateMnemonicAccount, encryptAccount, writeKeystoreFile } from '../src/keystore.js';
import { saveConfig, loadConfig } from '../src/config.js';
import { getSpentToday } from '../src/spendingGuard.js';
import { installConsoleGuard } from '../src/stdoutGuard.js';
import { safeTerminalText } from '../src/output.js';
import { clean } from '../src/mcp/tools.js';
import { offlineWallet } from './fakeBroadcast.mjs';

const mkAddr = (label) => getAddress('0x00' + Buffer.from(label, 'utf8').toString('hex').padEnd(38, '0').slice(0, 38));
const FROM = mkAddr('sender');
const TO = mkAddr('dest');
const FRESH = mkAddr('freshaccount');
const HASH = '0x' + 'ab'.repeat(32);
const NETWORK = { name: 'mainnet', chainId: 9 };
const LIMITS = { perTxQuai: '100', dailyQuai: '500' };
const ONE = 10n ** 18n;

let home;
let io;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'hartii-cli-review-')); io = { write: () => {}, writeErr: () => {}, confirmFn: async () => true }; });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

/** A fake node: balance-aware estimateGas/sendTransaction. A send to a never-seen account costs 55k, else 28k. */
function fakeNode({ balance, gasPrice = 2_000_000_000n, nodeBalance = balance, fresh = new Set([FRESH]) }) {
  const cost = (tx) => (fresh.has(tx.to) && BigInt(tx.value ?? 0) > 0n ? 55_000n : 28_000n);
  const sends = [];
  const provider = {
    getBalance: vi.fn(async () => balance),
    call: vi.fn(async () => '0x'),
    createAccessList: vi.fn(async () => []),
    estimateGas: vi.fn(async (tx) => cost(tx)),
    getFeeData: vi.fn(async () => ({ gasPrice })),
    getTransactionCount: vi.fn(async () => 0),
    getNetwork: vi.fn(async () => ({ chainId: 9n })),
  };
  const wallet = {
    getAddress: async () => FROM,
    sendTransaction: vi.fn(async (tx) => {
      sends.push(tx);
      const needed = BigInt(tx.value) + BigInt(tx.gasLimit) * BigInt(tx.gasPrice);
      if (needed > nodeBalance) {
        const raw = '0x0102'; // local synthetic broadcast proof, never submitted
        throw new BroadcastError(Object.assign(new Error('insufficient funds for intrinsic transaction cost'), { code: 'INSUFFICIENT_FUNDS', transaction: raw, info: { error: { code: -32000, message: 'insufficient funds for gas * price + value' } } }), HASH, raw);
      }
      return { hash: HASH, wait: async () => ({ status: 1, hash: HASH }) };
    }),
  };
  return { provider, wallet, sends };
}

describe('P1: send all to a fresh address must not brick the wallet', () => {
  const PASSWORD = 'correct-horse-battery-staple';
  it('reserves gas from the real value-bearing estimate and the send is accepted', async () => {
    const account = generateMnemonicAccount();
    writeKeystoreFile(home, 'default', await encryptAccount({ address: account.address, privateKey: account.privateKey }, PASSWORD, { scrypt: { N: 2, r: 1, p: 1 } }));
    saveConfig(home, { ...loadConfig(home), currentWallet: 'default' });
    const node = fakeNode({ balance: 10n * ONE });
    const wallet = { ...node.wallet, getAddress: async () => account.address };
    wallet.sendTransaction = vi.fn(async (tx) => {
      const needed = BigInt(tx.value) + BigInt(tx.gasLimit) * BigInt(tx.gasPrice);
      if (needed > 10n * ONE) throw Object.assign(new Error('insufficient funds'), { code: 'INSUFFICIENT_FUNDS', info: { error: { message: 'insufficient funds' } } });
      return { hash: HASH, wait: async () => ({ status: 1, hash: HASH }) };
    });
    const chainFetch = vi.fn(async () => ({ json: async () => ({ result: '0x9' }) }));
    const result = await runSend({ home, to: FRESH, amount: 'all', yes: true }, { fetchFn: chainFetch, providerFactory: () => node.provider, walletFactory: key => offlineWallet(key,node.provider,wallet.sendTransaction), passwordDeps: { env: { HARTII_PASSWORD: PASSWORD } } });
    expect(result.ok).toBe(true);
    expect(wallet.sendTransaction).toHaveBeenCalledTimes(1);
    expect(getSpentToday(home, account.address).reservedWei).toBe(0n);
  });
});

describe('P1: pre-broadcast balance check and node-rejection classification', () => {
  it('refuses value+gas above the balance BEFORE reserving or sending', async () => {
    const node = fakeNode({ balance: 10n * ONE });
    await expect(runWrite({ wallet: node.wallet, provider: node.provider, network: NETWORK, home, limits: LIMITS, to: TO, value: 10n * ONE, action: 'x', yes: true, io })).rejects.toThrow(/Insufficient QUAI for value plus gas/);
    expect(node.wallet.sendTransaction).not.toHaveBeenCalled();
    expect(getSpentToday(home, FROM).reservedWei).toBe(0n);
  });

  it('a node insufficient-funds rejection releases the reservation; the next write is NOT blocked', async () => {
    // The balance read is stale (says funded) but the node refuses the raw transaction.
    const node = fakeNode({ balance: 100n * ONE, nodeBalance: 1n * ONE });
    await expect(runWrite({ wallet: node.wallet, provider: node.provider, network: NETWORK, home, limits: LIMITS, to: TO, value: 5n * ONE, action: 'x', yes: true, io })).rejects.toThrow(/rejected before broadcast/);
    expect(getSpentToday(home, FROM).reservedWei).toBe(0n);
    const ok = fakeNode({ balance: 100n * ONE });
    const second = await runWrite({ wallet: ok.wallet, provider: ok.provider, network: NETWORK, home, limits: LIMITS, to: TO, value: ONE, action: 'x', yes: true, io });
    expect(second.ok).toBe(true);
  });

  it.each([
    ['NONCE_EXPIRED', 'nonce too low'],
    ['REPLACEMENT_UNDERPRICED', 'replacement transaction underpriced'],
    ['UNKNOWN_ERROR', 'invalid sender'],
  ])('node response %s / "%s" releases the reservation', async (code, message) => {
    const node = fakeNode({ balance: 100n * ONE });
    node.wallet.sendTransaction = vi.fn(async () => {
      const raw = '0x0102';
      const fields = code === 'UNKNOWN_ERROR' ? { error: { message }, payload: { method: 'quai_sendRawTransaction', params: [raw] } }
        : { transaction: raw, info: { error: { code: -32000, message } } };
      throw new BroadcastError(Object.assign(new Error('x'), { code, ...fields }), HASH, raw);
    });
    await expect(runWrite({ wallet: node.wallet, provider: node.provider, network: NETWORK, home, limits: LIMITS, to: TO, value: ONE, action: 'x', yes: true, io })).rejects.toThrow(WriteError);
    expect(getSpentToday(home, FROM).reservedWei).toBe(0n);
  });

  it('an error that merely claims a code (no node response body) keeps the reservation', async () => {
    const node = fakeNode({ balance: 100n * ONE });
    node.wallet.sendTransaction = vi.fn(async () => { throw Object.assign(new Error('socket hang up'), { code: 'INSUFFICIENT_FUNDS' }); });
    await expect(runWrite({ wallet: node.wallet, provider: node.provider, network: NETWORK, home, limits: LIMITS, to: TO, value: ONE, action: 'x', yes: true, io })).rejects.toThrow(/outcome unknown/);
    expect(getSpentToday(home, FROM).reservedWei).toBeGreaterThan(0n);
  });
});

describe('--key-env: dry run resolves the same sender as the real run', () => {
  const PASSWORD = 'correct-horse-battery-staple';
  it('dry-run summary.from is the env-key address and equals what the real run signs', async () => {
    const keystoreAccount = generateMnemonicAccount();
    const envAccount = generateMnemonicAccount();
    writeKeystoreFile(home, 'default', await encryptAccount({ address: keystoreAccount.address, privateKey: keystoreAccount.privateKey }, PASSWORD, { scrypt: { N: 2, r: 1, p: 1 } }));
    saveConfig(home, { ...loadConfig(home), currentWallet: 'default' });
    const env = { HARTII_TEST_KEY: envAccount.privateKey };
    const node = fakeNode({ balance: 50n * ONE });
    const signed = [];
    const walletFactory = key => offlineWallet(key,node.provider,async tx => { signed.push(tx); return { hash: HASH, wait: async () => ({ status: 1, hash: HASH }), ...tx }; });
    const deps = { fetchFn: async () => ({ json: async () => ({ result: '0x9' }) }), providerFactory: () => node.provider, walletFactory, env, io: { write: () => {}, writeErr: () => {}, env } };
    const base = { home, to: TO, amount: '1', keyEnv: 'HARTII_TEST_KEY', yes: true, json: true };
    const dry = await runSend({ ...base, dryRun: true }, deps);
    const real = await runSend(base, deps);
    expect(dry.summary.from).toBe(envAccount.address);
    expect(dry.summary.from).not.toBe(keystoreAccount.address);
    for (const k of ['from', 'to', 'valueQuai', 'dataDigest', 'gasLimit']) expect(dry.summary[k]).toBe(real.summary[k]);
    expect(signed[0].from).toBe(dry.summary.from);
    expect(signed[0].to).toBe(dry.summary.to);
  });

  it('resolveSender (used by claim --check and otc list --mine) honours --key-env', async () => {
    const { resolveSender } = await import('../src/commandContext.js');
    const envAccount = generateMnemonicAccount();
    const r = resolveSender(home, { keyEnv: 'K' }, { env: { K: envAccount.privateKey }, io: { writeErr: () => {} } });
    expect(r.address).toBe(envAccount.address);
  });

  it('a dry run is refused while unconfirmed spending authority exists (parity with the real run)', async () => {
    const { reserveSpend } = await import('../src/spendingGuard.js');
    reserveSpend(home, FROM, 1n, LIMITS, { authority: { chainId: '9', nonce: 0, to: TO.toLowerCase(), valueWei: '1', dataDigest: '0x' + '0'.repeat(64), intentDigest: '0x' + '1'.repeat(64), spendWei: '1', maxFeeWei: '0', createdAt: new Date().toISOString() } });
    const node = fakeNode({ balance: 50n * ONE });
    await expect(runWrite({ wallet: node.wallet, provider: node.provider, network: NETWORK, home, limits: LIMITS, to: TO, value: ONE, action: 'x', dryRun: true, io })).rejects.toThrow(/Unconfirmed spending authority/);
  });
});

describe('stdout guard: dependency console output never reaches stdout (--json and MCP)', () => {
  const bin = fileURLToPath(new URL('../bin/hartii.js', import.meta.url));
  const addrArg = mkAddr('someone');
  let preload;
  beforeEach(() => {
    // Simulates quais printing to console.log from inside a command: the first network call logs noise.
    preload = join(home, 'noise.mjs');
    writeFileSync(preload, "const f = globalThis.fetch; globalThis.fetch = (...a) => { console.log('QUAI-NOISE-STDOUT'); console.error('QUAI-NOISE-ERR'); return f(...a); };\n");
  });
  const env = () => ({ ...process.env, HARTII_HOME: home, NODE_OPTIONS: `--import ${pathToFileURL(preload).href}`, NO_COLOR: '1' });

  it('installConsoleGuard sends every console method to stderr and restores', () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const restore = installConsoleGuard();
    try { console.log('a'); console.info('b'); console.debug('c'); console.warn('d'); console.error('e'); } finally { restore(); }
    expect(out).not.toHaveBeenCalled();
    expect(err.mock.calls.map((c) => c[0]).join('')).toBe('a\nb\nc\nd\ne\n');
    out.mockRestore(); err.mockRestore();
  });

  it('--json: a console.log inside a command does not reach stdout', () => {
    const r = spawnSync(process.execPath, [bin, 'tokens', 'trending', '--json'], { env: env(), encoding: 'utf8', timeout: 60_000 });
    expect(r.stdout).not.toMatch(/QUAI-NOISE/);
    expect(r.stderr).toMatch(/QUAI-NOISE-STDOUT/); // redirected, not lost
    if (r.stdout.trim()) expect(() => JSON.parse(r.stdout)).not.toThrow();
  });

  it('MCP: stdout carries only protocol frames even when a dependency logs', async () => {
    const child = spawn(process.execPath, [bin, 'mcp', '--rpc', 'https://127.0.0.1:1'], { env: env(), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    const send = (m) => child.stdin.write(JSON.stringify(m) + '\n');
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'hartii_balance', arguments: { address: addrArg } } });
    const deadline = Date.now() + 30_000;
    while (!/"id":2/.test(out) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    child.kill();
    expect(/"id":2/.test(out)).toBe(true);
    for (const line of out.split('\n').filter(Boolean)) expect(() => JSON.parse(line), line).not.toThrow();
    expect(out).not.toMatch(/QUAI-NOISE/);
  }, 60_000);
});

describe('safeTerminalText / MCP clean(): one category-based sanitizer', () => {
  const hostile = {
    'unicode tag block (hidden ASCII smuggling)': 'USDC' + String.fromCodePoint(0xe0001, 0xe0049, 0xe006e, 0xe007f),
    'line / paragraph separators': 'a\u2028b\u2029c',
    'arabic letter mark': 'a\u061cb',
    'hangul filler': 'a\u3164b\uffa0c\u115fd\u1160e',
    'mongolian vowel separator': 'a\u180eb',
    'zero-width and directional marks': 'a\u200b\u200c\u200d\u200e\u200fb',
    'bidi overrides and isolates': 'a\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069b',
    'invisible math operators': 'a\u2060\u2061\u2062\u2063\u2064b',
    'BOM and soft hyphen': '\ufeffa\u00adb',
    'C0/C1 and newlines': 'a\u0000\u001b\u0085\r\nb',
    'lone surrogate': 'a\ud800b',
  };
  it.each(Object.entries(hostile))('strips %s', (_name, input) => {
    const out = safeTerminalText(input);
    expect(out).toMatch(/^[A-Za-z]*$/);
    expect(out.length).toBeLessThanOrEqual(5);
    expect(clean(input)).toBe(out); // MCP uses the very same function
  });
  it('keeps ordinary visible text, including non-ASCII letters and emoji', () => {
    expect(safeTerminalText('Quai Ünï 日本 🚀')).toBe('Quai Ünï 日本 🚀');
  });
});

describe('spend lock cleanup never masks the real outcome', () => {
  it('lock drift after a successful operation still returns its result, warns on stderr and keeps the NEXT write blocked', async () => {
    const { withSpendLock } = await import('../src/spendingGuard.js');
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const lock = join(home, 'spend.lock');
    const result = await withSpendLock(home, FROM, async () => { writeFileSync(lock, 'tampered by another process'); return { txHash: HASH }; });
    expect(result).toEqual({ txHash: HASH });
    expect(err.mock.calls.map((c) => c[0]).join('')).toMatch(/Write lock changed unexpectedly/);
    err.mockRestore();
    await expect(withSpendLock(home, FROM, async () => 1)).rejects.toThrow(/in progress/);
  });

  it('lock drift after a failing operation rethrows the operation\'s own error', async () => {
    const { withSpendLock } = await import('../src/spendingGuard.js');
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(withSpendLock(home, FROM, async () => { writeFileSync(join(home, 'spend.lock'), 'x'); throw new Error('send failed: real cause'); })).rejects.toThrow('send failed: real cause');
    err.mockRestore();
  });
});

describe('config set limits use the spending guard\'s canonical form', () => {
  it.each(['050', '00', '01.5', '007'])('rejects leading zeros: %s', async (v) => {
    const { configSet, ConfigError } = await import('../src/config.js');
    expect(() => configSet(loadConfig(home), 'limits.perTxQuai', v)).toThrow(/leading zeros/);
    expect(() => configSet(loadConfig(home), 'limits.dailyQuai', v)).toThrow(ConfigError);
  });
  it.each(['0', '0.5', '50', '100.25', '12.123456789012345678'])('accepts canonical %s and the guard accepts it too', async (v) => {
    const { configSet } = await import('../src/config.js');
    const { checkSpend } = await import('../src/spendingGuard.js');
    const next = configSet(loadConfig(home), 'limits.perTxQuai', v);
    expect(next.limits.perTxQuai).toBe(v);
    expect(() => checkSpend(home, FROM, 0n, next.limits)).not.toThrow();
  });
});

describe('secret prompts need a TTY (no unmasked echo from a pipe)', () => {
  it('readHiddenInput refuses a non-TTY stdin by default and never reads the stream', async () => {
    const { readHiddenInput } = await import('../src/prompt.js');
    const { PassThrough } = await import('node:stream');
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    stdin.write('super-secret-password\n');
    await expect(readHiddenInput('Password: ', { stdin, stdout })).rejects.toThrow(/non-interactive stdin.*HARTII_PASSWORD.*--stdin/s);
    expect(stdout.read()).toBeNull(); // not even the label was echoed
  });
  it('--stdin (allowPipedSecret) is the explicit opt-in', async () => {
    const { readHiddenInput } = await import('../src/prompt.js');
    const { PassThrough } = await import('node:stream');
    const stdin = new PassThrough();
    const result = readHiddenInput('Password: ', { stdin, stdout: new PassThrough(), allowPipedSecret: true });
    stdin.end('piped-secret\n');
    expect(await result).toBe('piped-secret');
  });
  it('HARTII_PASSWORD still works without a TTY', async () => {
    const { resolvePassword } = await import('../src/prompt.js');
    expect(await resolvePassword({ env: { HARTII_PASSWORD: 'from-env' }, writeErr: () => {} })).toBe('from-env');
  });
  it('the real binary refuses `wallet import key` over a pipe without --stdin and never echoes the key', () => {
    const bin = fileURLToPath(new URL('../bin/hartii.js', import.meta.url));
    const secret = 'ab'.repeat(32);
    const r = spawnSync(process.execPath, [bin, 'wallet', 'import', 'key'], { input: secret + '\n', env: { ...process.env, HARTII_HOME: home, HARTII_PASSWORD: '', NO_COLOR: '1' }, encoding: 'utf8', timeout: 60_000 });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Refusing to read a password or secret from a non-interactive stdin/);
    expect(r.stdout + r.stderr).not.toContain(secret);
  });
});

describe('receive --expires needs an explicit duration', () => {
  const NOW = new Date('2026-10-06T12:00:00Z');
  async function receive(args) {
    const { main } = await import('../src/cli.js');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(home, 'keystore'), { recursive: true });
    writeFileSync(join(home, 'keystore', 'main.json'), JSON.stringify({ address: FROM.slice(2) }), { mode: 0o600 });
    saveConfig(home, { network: 'mainnet', currentWallet: 'main', limits: { perTxQuai: '100', dailyQuai: '500' } });
    let out = '', err = '';
    const code = await main(['receive', ...args, '--json'], { env: { HARTII_HOME: home }, write: (s) => { out += s; }, writeErr: (s) => { err += s; }, now: NOW });
    return { code, out, err };
  }
  it.each(['30m', '2h', '7d'])('%s becomes an absolute exp = now + duration', async (d) => {
    const secs = Number(d.slice(0, -1)) * { m: 60, h: 3600, d: 86400 }[d.slice(-1)];
    const r = await receive(['--expires', d]);
    expect(r.code).toBe(0);
    const exp = new URL(JSON.parse(r.out).paylink).searchParams.get('exp');
    expect(exp).toBe(String(Math.floor(NOW.getTime() / 1000) + secs));
  });
  it.each([[['--expires'], 'bare flag (used to become 1 = already expired)'], [['--expires', '1'], 'bare number'], [['--expires', '1800000'], 'ms-looking number'], [['--expires', '0m'], 'zero'], [['--expires', '2w'], 'unknown unit'], [['--expires', '9999d'], 'over a year']])('rejects %j (%s)', async (args) => {
    const r = await receive(args);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/--expires/);
  });
});

describe('small hardening', () => {
  it('parseAmount: "all" of a zero balance and a percentage that rounds to zero say "nothing to spend"', async () => {
    const { parseAmount, AmountError } = await import('../src/amount.js');
    expect(() => parseAmount('all', { balanceWei: 0n })).toThrow(/Nothing to spend/);
    expect(() => parseAmount('0.01%', { balanceWei: 5n })).toThrow(/Nothing to spend/);
    expect(() => parseAmount('50%', { balanceWei: 0n })).toThrow(AmountError);
    expect(parseAmount('50%', { balanceWei: 10n }).amountWei).toBe(5n);
  });

  it('assertChainId aborts a hung RPC after 8s', async () => {
    const { assertChainId, NetworkError } = await import('../src/network.js');
    let signal;
    const fetchFn = vi.fn((_url, init) => { signal = init.signal; return Promise.reject(new Error('aborted')); });
    await expect(assertChainId('https://rpc.example', 9, { fetchFn })).rejects.toThrow(NetworkError);
    expect(signal).toBeInstanceOf(AbortSignal);
    vi.useFakeTimers();
    try {
      const hung = (_u, init) => new Promise((_res, rej) => init.signal.addEventListener('abort', () => rej(new Error('timeout'))));
      const p = assertChainId('https://rpc.example', 9, { fetchFn: hung }).catch((e) => e);
      await vi.advanceTimersByTimeAsync(8_100);
      expect(await p).toBeInstanceOf(NetworkError);
    } finally { vi.useRealTimers(); }
  });

  it('plain http:// RPC is refused unless --allow-insecure-rpc AND localhost', async () => {
    const { resolveRuntimeNetwork, NetworkError } = await import('../src/network.js');
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(() => resolveRuntimeNetwork({ rpc: 'http://rpc.example/cyprus1' })).toThrow(/Refusing a plain http/);
      expect(() => resolveRuntimeNetwork({ rpc: 'http://rpc.example/cyprus1', allowInsecureRpc: true })).toThrow(/only permits http:\/\/ to localhost/);
      expect(() => resolveRuntimeNetwork({ rpc: 'http://127.0.0.1:8545' })).toThrow(NetworkError);
      expect(() => resolveRuntimeNetwork({ rpc: 'ftp://x' })).toThrow(/https/);
      expect(resolveRuntimeNetwork({ rpc: 'http://localhost:8545', allowInsecureRpc: true }).rpcUrl).toBe('http://localhost:8545');
      expect(err.mock.calls.join('')).toMatch(/INSECURE/);
      expect(resolveRuntimeNetwork({ rpc: 'https://rpc.example/cyprus1' }).rpcUrl).toBe('https://rpc.example/cyprus1');
    } finally { err.mockRestore(); }
  });

  it('CLI: --rpc http:// is refused by the real command path without the flag', async () => {
    const { main } = await import('../src/cli.js');
    let err = '';
    const code = await main(['balance', '--address', TO, '--rpc', 'http://localhost:8545', '--json'], { env: { HARTII_HOME: home }, write: () => {}, writeErr: (s) => { err += s; }, fetchFn: async () => { throw new Error('must not be reached'); } });
    expect(code).toBe(1);
    expect(err).toMatch(/Refusing a plain http/);
  });
});
