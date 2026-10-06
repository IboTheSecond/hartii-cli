import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, linkSync, existsSync } from 'node:fs';
import { isAbsolute, basename, join } from 'node:path';
import { getHartiiHome, loadConfig, saveConfig } from '../src/config.js';
import { assertValidWalletName, writeKeystoreFile, readKeystoreFile, removeKeystoreFile, renameKeystoreFile, generateMnemonicAccount, encryptAccount, decryptAccount } from '../src/keystore.js';
import { walletLockCheck, walletNew } from '../src/commands/walletCmd.js';
import { runDoctor } from '../src/commands/doctor.js';
import { runWallet } from '../src/commands/walletRoute.js';
import { buildTools } from '../src/mcp/tools.js';
import { resolveMcpContext } from '../src/mcp/server.js';

// The native launcher sets this BEFORE Vitest/module imports. Never fall back to ~/.hartii.
const base = process.env.HARTII_HOME;
if (!base || !isAbsolute(base) || !basename(base).startsWith('hartii-cli-proof-')) throw Error('Native isolated HARTII_HOME required');
expect(getHartiiHome()).toBe(base);
const ADDRESS = '0x0011111111111111111111111111111111111111';
const encryptedFixture = JSON.stringify({ version: 3, address: ADDRESS.slice(2), crypto: { cipher: 'synthetic encrypted fixture' } });
let home;
beforeEach(() => { home = mkdtempSync(join(base, 'keystore-case-')); vi.stubGlobal('fetch', () => { throw Error('No network in wallet safety tests'); }); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('wallet local boundaries', () => {
  it('rejects unauthenticated recovery metadata that does not recover the encrypted key', async () => {
    const account = generateMnemonicAccount();
    const json = JSON.parse(await encryptAccount(account, 'synthetic-password', { scrypt: { N: 2, r: 1, p: 1 } }));
    const cipher = json['x-quais'].mnemonicCiphertext;
    json['x-quais'].mnemonicCiphertext = (cipher.startsWith('00') ? '01' : '00') + cipher.slice(2);
    let accepted = false; try { await decryptAccount(JSON.stringify(json), 'synthetic-password'); accepted = true; } catch { /* do not print any synthetic secret */ }
    expect(accepted).toBe(false);
  });
  it.each(['CON', 'NUL', 'aux', 'COM1', 'LPT9'])('rejects reserved Windows wallet name %s', name => {
    expect(() => assertValidWalletName(name)).toThrow();
  });
  it('rejects a keystore junction before reading or writing another directory', () => {
    const other = mkdtempSync(join(base, 'other-case-')); const target = join(other, 'alice.json');
    writeFileSync(target, 'preserve synthetic neighbor');
    symlinkSync(other, join(home, 'keystore'), 'junction');
    expect(() => writeKeystoreFile(home, 'alice', encryptedFixture, { force: true })).toThrow(/link|reparse|redirect|unsafe/i);
    expect(() => readKeystoreFile(home, 'alice')).toThrow(/link|reparse|redirect|unsafe/i);
    expect(readFileSync(target, 'utf8')).toBe('preserve synthetic neighbor');
  });
  it('rejects hardlinked keystore files for read/write/rename/remove', () => {
    mkdirSync(join(home, 'keystore')); const other = join(base, `${basename(home)}-neighbor.json`);
    writeFileSync(other, 'preserve synthetic neighbor'); linkSync(other, join(home, 'keystore', 'alice.json'));
    for (const action of [() => readKeystoreFile(home, 'alice'), () => writeKeystoreFile(home, 'alice', encryptedFixture, { force: true }), () => renameKeystoreFile(home, 'alice', 'renamed'), () => removeKeystoreFile(home, 'alice')]) expect(action).toThrow(/link|unsafe/i);
    expect(readFileSync(other, 'utf8')).toBe('preserve synthetic neighbor');
  });
  it.each([null, [], 'corrupt', { limits: null }, { network: 'mainnet', limits: 'corrupt' }, { network: 'mainnet', limits: { perTxQuai: '1', dailyQuai: null } }])('existing corrupt config fails closed rather than installing default caps', value => {
    writeFileSync(join(home, 'config.json'), JSON.stringify(value));
    expect(() => loadConfig(home)).toThrow(/config/i);
  });
  it('rejects config hardlinks and directory junctions', () => {
    const other = join(base, `${basename(home)}-config.json`); writeFileSync(other, 'preserve synthetic config');
    linkSync(other, join(home, 'config.json'));
    expect(() => saveConfig(home, { network: 'mainnet', currentWallet: null, limits: { perTxQuai: '1', dailyQuai: '2' } })).toThrow(/link|unsafe/i);
    expect(readFileSync(other, 'utf8')).toBe('preserve synthetic config');
  });
  it('removes secret argv import without echoing a supplied synthetic marker or prompting', async () => {
    const marker = 'synthetic-secret-marker'; const promptFn = vi.fn(); const writeErr = vi.fn();
    let error; try { await runWallet(['import', 'key', marker], { 'from-arg': true }, { home, io: { promptFn, writeErr } }); } catch (caught) { error = caught; }
    expect(error).toBeDefined(); expect(String(error).includes(marker)).toBe(false);
    expect(promptFn).not.toHaveBeenCalled(); expect(writeErr).not.toHaveBeenCalled(); expect(existsSync(join(home, 'keystore'))).toBe(false);
  });
  it('Windows permissions are unknown instead of green', () => {
    if (process.platform !== 'win32') return;
    writeKeystoreFile(home, 'alice', encryptedFixture);
    saveConfig(home, { network: 'mainnet', currentWallet: 'alice', limits: { perTxQuai: '1', dailyQuai: '2' } });
    expect(walletLockCheck(home, 'alice').permsOk).toBeNull();
  });
  it('a weak environment password cannot create a new wallet file', async () => {
    await expect(walletNew(home, 'alice', { env: { HARTII_PASSWORD: 'weak' }, scrypt: { N: 2, r: 1, p: 1 }, writeErr: vi.fn() })).rejects.toThrow(/at least 8/);
    expect(existsSync(join(home, 'keystore', 'alice.json'))).toBe(false);
  });
  it('doctor reports existing Windows ACLs unverified with mocked reads only', async () => {
    if (process.platform !== 'win32') return;
    writeKeystoreFile(home, 'alice', encryptedFixture);
    const fetchFn = async (_url, opts) => ({ ok: true, json: async () => opts?.method === 'POST' ? { result: JSON.parse(opts.body).method === 'quai_chainId' ? '0x9' : { timestamp: Math.floor(Date.now() / 1000) } } : {} });
    const result = await runDoctor({ home }, { fetchFn });
    expect(result.checks.find(check => check.name === 'keystorePerms')).toMatchObject({ ok: null, status: 'unverified' });
    expect(result.verified).toBe(false);
  });
});

describe('MCP write opt-in', () => {
  it.each(['false', 'true', 1, {}])('truthy non-boolean opt-in cannot register write tools', allowWrites => {
    expect(buildTools({ home, env: {}, allowWrites }).some(tool => tool.write)).toBe(false);
    expect(resolveMcpContext({ home, env: {}, allowWrites, maxPerTx: '1', maxPerDay: '2' }).allowWrites).toBe(false);
  });
  it('direct handler rejects unknown auth/cap parameters before any read or signing dependency', async () => {
    const providerFactory = vi.fn(); const tool = buildTools({ home, env: {}, allowWrites: true, providerFactory }).find(tool => tool.name === 'hartii_send');
    await expect(tool.handler({ to: ADDRESS, amount: '1', confirm: true, keyEnv: 'UNTRUSTED', maxFee: '1000000' })).rejects.toThrow(/parameter|argument|request/i);
    expect(providerFactory).not.toHaveBeenCalled();
  });
  it('invalid raw environment key errors never echo the synthetic bytes', async () => {
    const marker = '0x' + '0'.repeat(64);
    const tool = buildTools({ home, env: { FIXTURE_KEY: marker }, keyEnv: 'FIXTURE_KEY' }).find(tool => tool.name === 'hartii_wallet');
    let error; try { await tool.handler({}); } catch (caught) { error = caught; }
    expect(error).toBeDefined(); expect(String(error).includes(marker)).toBe(false);
  });
});
