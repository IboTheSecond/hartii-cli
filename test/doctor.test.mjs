// packages/hartii-cli/test/doctor.test.mjs
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runDoctor } from '../src/commands/doctor.js';
import { saveConfig, loadConfig } from '../src/config.js';
import { generateMnemonicAccount, encryptAccount, writeKeystoreFile } from '../src/keystore.js';

let home;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'hartii-cli-doctor-test-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function fakeFetchAllHealthy() {
  return vi.fn(async (url, options) => {
    if (options && options.method === 'POST') {
      const body = JSON.parse(options.body);
      if (body.method === 'quai_chainId') return { json: async () => ({ result: '0x9' }) };
      if (body.method === 'quai_getBlockByNumber') return { json: async () => ({ result: { woHeader: { timestamp: '0x' + Math.floor(Date.now() / 1000).toString(16) } } }) };
      return { json: async () => ({ error: { message: 'unexpected method' } }) };
    }
    return { ok: true, status: 200 }; // GET /api/health
  });
}

describe('runDoctor — demo mode', () => {
  it('never touches the network and reports every check ok', async () => {
    const fetchFn = vi.fn();
    const result = await runDoctor({ demo: true }, { fetchFn });
    expect(result.ok).toBe(true);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(result.checks.map((c) => c.name)).toEqual(['rpc', 'chainId', 'keystorePerms', 'addressLedger', 'api', 'clockSkew']);
  });
});

describe('runDoctor — real checks (mocked fetch)', () => {
  it('reports every check healthy when everything answers correctly', async () => {
    const fetchFn = fakeFetchAllHealthy();
    const result = await runDoctor({ home, network: 'mainnet' }, { fetchFn });
    expect(result.ok).toBe(true);
    for (const c of result.checks) expect(c.ok).toBe(true);
  });

  it('flags a chain id mismatch', async () => {
    const fetchFn = vi.fn(async (url, options) => {
      if (options?.method === 'POST') {
        const body = JSON.parse(options.body);
        if (body.method === 'quai_chainId') return { json: async () => ({ result: '0x3a98' }) }; // orchard's id
        return { json: async () => ({ result: { timestamp: '0x0' } }) };
      }
      return { ok: true, status: 200 };
    });
    const result = await runDoctor({ home, network: 'mainnet' }, { fetchFn });
    const chainIdCheck = result.checks.find((c) => c.name === 'chainId');
    expect(chainIdCheck.ok).toBe(false);
    expect(result.ok).toBe(false);
  });

  it('flags an unreachable RPC and skips the dependent checks honestly', async () => {
    const fetchFn = vi.fn(async (url, options) => {
      if (options?.method === 'POST') throw new Error('ECONNREFUSED');
      return { ok: true, status: 200 };
    });
    const result = await runDoctor({ home, network: 'mainnet' }, { fetchFn });
    expect(result.checks.find((c) => c.name === 'rpc').ok).toBe(false);
    expect(result.checks.find((c) => c.name === 'chainId').detail).toMatch(/skipped/);
    expect(result.checks.find((c) => c.name === 'clockSkew').detail).toMatch(/skipped/);
  });

  it('flags an unreachable API', async () => {
    const fetchFn = vi.fn(async (url, options) => {
      if (options?.method === 'POST') {
        const body = JSON.parse(options.body);
        if (body.method === 'quai_chainId') return { json: async () => ({ result: '0x9' }) };
        return { json: async () => ({ result: { timestamp: Math.floor(Date.now() / 1000).toString(16) } }) };
      }
      throw new Error('api down');
    });
    const result = await runDoctor({ home, network: 'mainnet' }, { fetchFn });
    expect(result.checks.find((c) => c.name === 'api').ok).toBe(false);
  });

  it('reports the address-ledger check for the current wallet without a password', async () => {
    const account = generateMnemonicAccount();
    const json = await encryptAccount({ address: account.address, privateKey: account.privateKey }, 'pw', { scrypt: { N: 2, r: 1, p: 1 } });
    writeKeystoreFile(home, 'default', json);
    saveConfig(home, { ...loadConfig(home), currentWallet: 'default' });

    const fetchFn = fakeFetchAllHealthy();
    const result = await runDoctor({ home, network: 'mainnet' }, { fetchFn });
    const check = result.checks.find((c) => c.name === 'addressLedger');
    expect(check.ok).toBe(true);
    expect(check.detail).toContain(account.address);
  });

  it('reports no current wallet honestly rather than failing', async () => {
    const fetchFn = fakeFetchAllHealthy();
    const result = await runDoctor({ home, network: 'mainnet' }, { fetchFn });
    const check = result.checks.find((c) => c.name === 'addressLedger');
    expect(check.ok).toBe(true);
    expect(check.detail).toMatch(/no current wallet/i);
  });
});
