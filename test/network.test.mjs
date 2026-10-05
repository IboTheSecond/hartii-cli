// packages/hartii-cli/test/network.test.mjs
import { describe, it, expect, vi } from 'vitest';
import { resolveNetwork, resolveRuntimeNetwork, assertChainId, NetworkError, NETWORKS } from '../src/network.js';

describe('resolveNetwork', () => {
  it('resolves mainnet by default shape', () => {
    expect(resolveNetwork('mainnet')).toEqual(NETWORKS.mainnet);
  });

  it('resolves orchard with its own chain id/url', () => {
    const net = resolveNetwork('orchard');
    expect(net.chainId).toBe(15000);
    expect(net.rpcUrl).toBe('https://orchard.rpc.quai.network/cyprus1');
  });

  it('is case-insensitive', () => {
    expect(resolveNetwork('MAINNET').name).toBe('mainnet');
  });

  it('throws NetworkError for an unknown network', () => {
    expect(() => resolveNetwork('sepolia')).toThrow(NetworkError);
  });
});

describe('resolveRuntimeNetwork', () => {
  it('defaults to mainnet with no globals', () => {
    const net = resolveRuntimeNetwork({});
    expect(net.name).toBe('mainnet');
    expect(net.rpcUrl).toBe(NETWORKS.mainnet.rpcUrl);
  });

  it('an explicit --rpc overrides only the URL, not the expected chain id', () => {
    const net = resolveRuntimeNetwork({ network: 'mainnet', rpc: 'https://custom.example/rpc' });
    expect(net.rpcUrl).toBe('https://custom.example/rpc');
    expect(net.chainId).toBe(9);
  });
});

function fakeFetch(resultByMethod) {
  return vi.fn(async (_url, options) => {
    const body = JSON.parse(options.body);
    const result = resultByMethod[body.method];
    if (result === undefined) return { json: async () => ({ error: { message: `no mock for ${body.method}` } }) };
    return { json: async () => ({ result }) };
  });
}

describe('assertChainId', () => {
  it('passes when quai_chainId matches', async () => {
    const fetchFn = fakeFetch({ quai_chainId: '0x9' });
    await expect(assertChainId('https://rpc.example', 9, { fetchFn })).resolves.toBe(9);
  });

  it('falls back to eth_chainId when quai_chainId is unavailable', async () => {
    const fetchFn = fakeFetch({ eth_chainId: '0x9' });
    await expect(assertChainId('https://rpc.example', 9, { fetchFn })).resolves.toBe(9);
  });

  it('throws NetworkError on a mismatched chain id', async () => {
    const fetchFn = fakeFetch({ quai_chainId: '0x3a98' }); // orchard's id, while we expect mainnet's
    await expect(assertChainId('https://rpc.example', 9, { fetchFn })).rejects.toThrow(NetworkError);
  });

  it('throws NetworkError when the RPC is entirely unreachable', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    await expect(assertChainId('https://rpc.example', 9, { fetchFn })).rejects.toThrow(NetworkError);
  });
});
