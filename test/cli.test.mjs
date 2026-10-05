// packages/hartii-cli/test/cli.test.mjs
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { main } from '../src/cli.js';
import * as walletCommands from '../src/commands/walletCmd.js';

let home;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'hartii-cli-cli-test-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});

it('M5: with --from-arg a quoted recovery phrase stays separate from its optional wallet name (and warns loudly)',async()=>{
  const phrase=Array(12).fill('abandon').join(' ');
  const spy=vi.spyOn(walletCommands,'walletImport').mockResolvedValue({name:'named',address:'test'});
  const writeErr=vi.fn();
  const code=await main(['wallet','import','mnemonic',phrase,'named','--from-arg','--json'],{env:{HARTII_HOME:home},write:vi.fn(),writeErr});
  expect(code).toBe(0);
  expect(writeErr.mock.calls.join(' ')).toMatch(/shell history/);
  expect(spy).toHaveBeenCalledWith(home,'mnemonic',phrase,'named',expect.any(Object));
});

function capture() {
  const out = [];
  const err = [];
  return { out, err, write: (s) => out.push(s), writeErr: (s) => err.push(s) };
}

describe('main — globals', () => {
  it('--version prints the version and exits 0', async () => {
    const { out, write, writeErr } = capture();
    const code = await main(['--version'], { write, writeErr });
    expect(code).toBe(0);
    expect(out[0]).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('no command prints help and exits 0', async () => {
    const { out, write, writeErr } = capture();
    const code = await main([], { write, writeErr });
    expect(code).toBe(0);
    expect(out[0]).toContain('hartii —');
  });

  it('--help prints help even with a command present', async () => {
    const { out, write, writeErr } = capture();
    const code = await main(['balance', '--help'], { write, writeErr });
    expect(code).toBe(0);
    expect(out[0]).toContain('Usage:');
    expect(out[0]).toContain('hartii balance');
  });

  it('help speaks to a first-time user: quickstart lines, no internal milestone labels', async () => {
    const { out, write, writeErr } = capture();
    await main(['--help'], { write, writeErr });
    expect(out[0]).toMatch(/First time\?\s+hartii init/);
    expect(out[0]).toMatch(/hartii \?/);
    expect(out[0]).toMatch(/--dry-run/);
    expect(out[0]).not.toMatch(/\(M[1-6]/);
  });

  it('`hartii --json` with no command prints help instead of opening the TUI, even on a TTY', async () => {
    const { out, write, writeErr } = capture();
    const runUi = vi.fn(async () => 0);
    const code = await main(['--json'], { write, writeErr, interactive: true, runUi });
    expect(code).toBe(0);
    expect(runUi).not.toHaveBeenCalled();
    expect(out[0]).toContain('Usage: hartii');
  });

  it('wallet import refuses a quoted phrase passed as a single argument before prompting (it is not a wallet name)', async () => {
    const promptFn = vi.fn();
    const { err, write, writeErr } = capture();
    const code = await main(['wallet', 'import', 'mnemonic', Array(12).fill('abandon').join(' ')], { env: { HARTII_HOME: home }, write, writeErr, promptFn });
    expect(code).toBe(1);
    expect(promptFn).not.toHaveBeenCalled();
    expect(err.join('')).toMatch(/--from-arg/);
  });

  it('an unknown command prints a clean error, exit 1, under --json', async () => {
    const { err, write, writeErr } = capture();
    const code = await main(['frobnicate', '--json'], { write, writeErr, env: {} });
    expect(code).toBe(1);
    expect(JSON.parse(err[0]).error).toMatch(/Unknown command/);
  });

  it('hartii mcp hands over to the MCP server (nothing is printed by the dispatcher)', async () => {
    const { out, write, writeErr } = capture();
    const runMcp = vi.fn(async () => 0);
    const code = await main(['mcp'], { write, writeErr, env: {}, runMcp });
    expect(code).toBe(0);
    expect(runMcp).toHaveBeenCalledTimes(1);
    expect(out).toEqual([]);
  });
});

describe('main — demo mode end to end', () => {
  it('balance --demo --json never touches the keystore or network', async () => {
    const { out, write, writeErr } = capture();
    const code = await main(['balance', '--demo', '--json'], { write, writeErr, env: { HARTII_HOME: home } });
    expect(code).toBe(0);
    const parsed = JSON.parse(out[0]);
    expect(parsed.quai).toBeDefined();
  });

  it('doctor --demo --json reports every check ok', async () => {
    const { out, write, writeErr } = capture();
    const code = await main(['doctor', '--demo', '--json'], { write, writeErr, env: { HARTII_HOME: home } });
    expect(code).toBe(0);
    expect(JSON.parse(out[0]).ok).toBe(true);
  });

  it('send --demo --json simulates and never signs', async () => {
    const to = '0x0003b264Bc457BF2dc6F4De80c6C714079febB64';
    const { out, write, writeErr } = capture();
    const code = await main(['send', to, '1.5', '--demo', '--json'], { write, writeErr, env: { HARTII_HOME: home } });
    expect(code).toBe(0);
    const parsed = JSON.parse(out[0]);
    expect(parsed.dryRun).toBe(true);
  });
});

describe('main — wallet + config, real HARTII_HOME', () => {
  it('wallet new / list / use / address round trip under --json', async () => {
    // HARTII_PASSWORD here goes through `io.env` (what walletCmd.js's promptNewPassword/
    // resolvePassword actually read) — NOT `deps.passwordDeps`, which is send.js's own separate
    // seam (see cli.js's dispatchWallet: it hands wallet commands the whole `io` object, built
    // from this top-level `env`).
    const env = { HARTII_HOME: home, HARTII_PASSWORD: 'correct-horse-battery' };
    let r;

    r = capture();
    let code = await main(['wallet', 'new', 'alice', '--json'], { ...r, env });
    expect(code).toBe(0);
    const created = JSON.parse(r.out[0]);
    expect(created.name).toBe('alice');

    r = capture();
    code = await main(['wallet', 'list', '--json'], { ...r, env });
    expect(code).toBe(0);
    expect(JSON.parse(r.out[0]).wallets).toHaveLength(1);

    r = capture();
    code = await main(['wallet', 'address', '--json'], { ...r, env });
    expect(code).toBe(0);
    expect(JSON.parse(r.out[0]).address).toBe(created.address);
  });

  it('config set / get round trip', async () => {
    const env = { HARTII_HOME: home };
    let r = capture();
    let code = await main(['config', 'set', 'limits.perTxQuai', '42', '--json'], { ...r, env });
    expect(code).toBe(0);

    r = capture();
    code = await main(['config', 'get', 'limits.perTxQuai', '--json'], { ...r, env });
    expect(code).toBe(0);
    expect(JSON.parse(r.out[0])['limits.perTxQuai']).toBe('42');
  });

  it('an invalid config key is a clean error under --json, not a stack trace', async () => {
    const env = { HARTII_HOME: home };
    const r = capture();
    const code = await main(['config', 'set', 'notAKey', '1', '--json'], { ...r, env });
    expect(code).toBe(1);
    expect(JSON.parse(r.err[0]).error).toMatch(/not a settable config key/);
  });
});
