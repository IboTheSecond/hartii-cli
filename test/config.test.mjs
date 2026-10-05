// packages/hartii-cli/test/config.test.mjs
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getHartiiHome, loadConfig, saveConfig, configGet, configSet, ConfigError, DEFAULT_LIMITS } from '../src/config.js';

let home;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'hartii-cli-config-test-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('getHartiiHome', () => {
  it('uses HARTII_HOME when set', () => {
    expect(getHartiiHome({ HARTII_HOME: '/tmp/foo' })).toBe('/tmp/foo');
  });

  it('falls back to ~/.hartii', () => {
    expect(getHartiiHome({})).toMatch(/\.hartii$/);
  });
});

describe('loadConfig', () => {
  it('returns sensible defaults when no file exists', () => {
    const cfg = loadConfig(home);
    expect(cfg.network).toBe('mainnet');
    expect(cfg.currentWallet).toBeNull();
    expect(cfg.limits).toEqual(DEFAULT_LIMITS);
  });

  it('throws ConfigError on invalid JSON', () => {
    saveConfig(home, { network: 'mainnet', limits: {} });
    const p = join(home, 'config.json');
    writeFileSync(p, 'not json');
    expect(() => loadConfig(home)).toThrow(ConfigError);
  });
});

describe('saveConfig / loadConfig round trip', () => {
  it('persists and reloads', () => {
    saveConfig(home, { network: 'orchard', currentWallet: 'dev', limits: { perTxQuai: '10', dailyQuai: '20' } });
    const cfg = loadConfig(home);
    expect(cfg.network).toBe('orchard');
    expect(cfg.currentWallet).toBe('dev');
    expect(cfg.limits).toEqual({ perTxQuai: '10', dailyQuai: '20' });
  });

  it('creates the home directory if missing', () => {
    const nested = join(home, 'nested');
    saveConfig(nested, { network: 'mainnet', currentWallet: null, limits: DEFAULT_LIMITS });
    expect(existsSync(join(nested, 'config.json'))).toBe(true);
  });
});

describe('configGet / configSet', () => {
  it('gets a dotted-path value', () => {
    const cfg = loadConfig(home);
    expect(configGet(cfg, 'limits.perTxQuai')).toBe('100');
  });

  it('sets network', () => {
    const cfg = loadConfig(home);
    const next = configSet(cfg, 'network', 'orchard');
    expect(next.network).toBe('orchard');
  });

  it('rejects an invalid network', () => {
    const cfg = loadConfig(home);
    expect(() => configSet(cfg, 'network', 'nope')).toThrow(ConfigError);
  });

  it('sets limits.perTxQuai', () => {
    const cfg = loadConfig(home);
    const next = configSet(cfg, 'limits.perTxQuai', '42');
    expect(next.limits.perTxQuai).toBe('42');
    expect(next.limits.dailyQuai).toBe(cfg.limits.dailyQuai); // untouched
  });

  it('rejects a non-numeric limit', () => {
    const cfg = loadConfig(home);
    expect(() => configSet(cfg, 'limits.perTxQuai', 'lots')).toThrow(ConfigError);
  });

  it('rejects a limit with more than 18 decimals (the spending guard could never parse it, bricking every write)', () => {
    const cfg = loadConfig(home);
    expect(() => configSet(cfg, 'limits.dailyQuai', '1.0000000000000000001')).toThrow(/18 decimals/);
    expect(configSet(cfg, 'limits.dailyQuai', '1.000000000000000001').limits.dailyQuai).toBe('1.000000000000000001');
  });

  it('rejects an unknown key', () => {
    const cfg = loadConfig(home);
    expect(() => configSet(cfg, 'notARealKey', '1')).toThrow(ConfigError);
  });

  it('never mutates the input config', () => {
    const cfg = loadConfig(home);
    const frozen = JSON.stringify(cfg);
    configSet(cfg, 'network', 'orchard');
    expect(JSON.stringify(cfg)).toBe(frozen);
  });
});
