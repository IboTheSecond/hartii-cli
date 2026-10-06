import { describe, it, expect, beforeEach, vi } from 'vitest';
const fault = vi.hoisted(() => ({ collide: null, failReplace: false }));
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal();
  const collide = path => { if (path === fault.collide) { fault.collide = null; actual.writeFileSync(path, 'preserve concurrent fixture'); } };
  return { ...actual,
    writeFileSync(path, ...rest) { if (typeof path === 'string') collide(path); return actual.writeFileSync(path, ...rest); },
    linkSync(oldPath, newPath) { collide(newPath); return actual.linkSync(oldPath, newPath); },
    renameSync(oldPath, newPath) { if (fault.failReplace) throw Error('synthetic interrupted replacement'); collide(newPath); return actual.renameSync(oldPath, newPath); },
  };
});
import { mkdtempSync, mkdirSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, basename, isAbsolute } from 'node:path';
import { writeKeystoreFile, renameKeystoreFile } from '../src/keystore.js';
import { saveConfig, loadConfig } from '../src/config.js';
const base = process.env.HARTII_HOME;
if (!base || !isAbsolute(base) || !basename(base).startsWith('hartii-cli-proof-')) throw Error('Native isolated HARTII_HOME required');
let home;
beforeEach(() => { home = mkdtempSync(join(base, 'atomic-case-')); fault.collide = null; fault.failReplace = false; });
const payload = JSON.stringify({ version: 3, address: '0011111111111111111111111111111111111111', crypto: { cipher: 'synthetic' } });

describe('actual keystore filesystem race boundaries', () => {
  it('a concurrent wallet creator wins without being overwritten', () => {
    mkdirSync(join(home, 'keystore')); const target = join(home, 'keystore', 'alice.json'); fault.collide = target;
    let refused = false; try { writeKeystoreFile(home, 'alice', payload); } catch { refused = true; }
    expect(refused).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('preserve concurrent fixture');
  });
  it('rename never overwrites a destination created after its precheck', () => {
    writeKeystoreFile(home, 'alice', payload); const target = join(home, 'keystore', 'bob.json'); fault.collide = target;
    let refused = false; try { renameKeystoreFile(home, 'alice', 'bob'); } catch { refused = true; }
    expect(refused).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('preserve concurrent fixture');
    expect(existsSync(join(home, 'keystore', 'alice.json'))).toBe(true);
  });
  it('replacement failure preserves the original complete encrypted file', () => {
    writeKeystoreFile(home, 'alice', payload); fault.failReplace = true;
    expect(() => writeKeystoreFile(home, 'alice', payload + 'changed', { force: true })).toThrow();
    expect(readFileSync(join(home, 'keystore', 'alice.json'), 'utf8')).toBe(payload);
    expect(readdirSync(join(home, 'keystore')).filter(file => file.endsWith('.tmp'))).toEqual([]);
  });
  it('config replacement failure preserves the previous caps', () => {
    const cfg = { network: 'mainnet', currentWallet: null, limits: { perTxQuai: '1', dailyQuai: '2' } };
    saveConfig(home, cfg); fault.failReplace = true;
    expect(() => saveConfig(home, { ...cfg, limits: { perTxQuai: '100', dailyQuai: '500' } })).toThrow();
    expect(loadConfig(home).limits).toEqual(cfg.limits);
  });
});
