// Security-run 2026-11-17 (R3-F3): hartii_swap over MCP only accepts QUAI, WQUAI and Hartii-verified tokens.
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Interface, getAddress } from 'quais';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildMcpServer } from '../src/mcp/server.js';
import { ERC20_ABI } from '../src/abi/erc20.js';
import { saveConfig } from '../src/config.js';
import { generateMnemonicAccount } from '../src/keystore.js';
import { offlineWallet } from './fakeBroadcast.mjs';

const addr = (n) => getAddress(`0x001${String(n).padStart(37, '0')}`);
const FROM = addr(1), EVIL = addr(9), ZERO = '0x0000000000000000000000000000000000000000';
const erc = new Interface(ERC20_ABI), factoryI = new Interface(['function curveOf(address) view returns (address)']);
let KEY, home;
beforeAll(() => { KEY = generateMnemonicAccount().privateKey; }, 120_000);
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'hartii-swapsec-'));
  mkdirSync(join(home, 'keystore'));
  writeFileSync(join(home, 'keystore', 'test.json'), JSON.stringify({ address: FROM.slice(2) }));
  saveConfig(home, { network: 'mainnet', currentWallet: 'test', limits: { perTxQuai: '100', dailyQuai: '500' } });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function ctxWith({ indexed, registered }) {
  const fetchFn = vi.fn(async (url, init) => {
    if (init?.method === 'POST') return { status: 200, ok: true, json: async () => ({ result: '0x9' }) };
    const u = String(url);
    if (u.includes('/api/token/') && indexed) return { status: 200, ok: true, json: async () => ({ token: { address: EVIL, curveAddress: addr(3), symbol: 'EVL', network: 'mainnet' } }) };
    throw new Error('no network: ' + u);
  });
  const provider = {
    getNetwork: vi.fn(async () => ({ chainId: 9n })),
    call: vi.fn(async (tx) => {
      let p;
      try { p = factoryI.parseTransaction({ data: tx.data }); } catch { p = null; }
      if (p) return factoryI.encodeFunctionResult('curveOf', [registered ? addr(3) : ZERO]);
      if (String(tx.data).startsWith('0xfc0c546a')) return '0x' + EVIL.slice(2).toLowerCase().padStart(64, '0'); // curve.token()
      try { p = erc.parseTransaction({ data: tx.data }); } catch { p = null; }
      if (p?.name === 'decimals') return erc.encodeFunctionResult('decimals', [18]);
      if (p?.name === 'symbol') return erc.encodeFunctionResult('symbol', ['EVL']);
      if (p?.name === 'balanceOf') return erc.encodeFunctionResult('balanceOf', [10n ** 24n]);
      return '0x';
    }),
    createAccessList: vi.fn(async () => []), estimateGas: vi.fn(async () => 100000n), getFeeData: vi.fn(async () => ({ gasPrice: 1n })),
    getTransactionCount: vi.fn(async () => 0), getBalance: vi.fn(async () => 10n ** 21n), destroy: vi.fn(),
  };
  const sendTransaction = vi.fn();
  return { sendTransaction, ctx: { home, env: { K: KEY }, keyEnv: 'K', allowWrites: true, fetchFn, providerFactory: () => provider, walletFactory: k => offlineWallet(k, provider, sendTransaction), limits: {} } };
}
async function callSwap(c, args) {
  const { server } = buildMcpServer(c.ctx);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 't', version: '0' });
  await server.connect(a); await client.connect(b);
  const r = await client.callTool({ name: 'hartii_swap', arguments: args });
  await client.close();
  return { isError: Boolean(r.isError), text: r.content?.[0]?.text ?? '' };
}

describe('R3-F3 hartii_swap over MCP', () => {
  it('refuses a token the market index does not know', async () => {
    const c = ctxWith({ indexed: false, registered: false });
    const r = await callSwap(c, { tokenIn: 'QUAI', tokenOut: EVIL, amount: '1' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/not a Hartii-verified token/);
    expect(c.sendTransaction).not.toHaveBeenCalled();
  });
  it('refuses an indexed token that no Hartii factory registers', async () => {
    const c = ctxWith({ indexed: true, registered: false });
    const r = await callSwap(c, { tokenIn: EVIL, tokenOut: 'QUAI', amount: '1' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/not a Hartii-verified token/);
  });
  it('a factory-registered token passes the verification gate (any later error is a different one)', async () => {
    const c = ctxWith({ indexed: true, registered: true });
    const r = await callSwap(c, { tokenIn: 'QUAI', tokenOut: EVIL, amount: '1' });
    expect(r.text).not.toMatch(/not a Hartii-verified token/);
  });
});
