// Main-loop integration of the four rework lanes (2026-11-16): the global presentation flags and the
// config key the SCREENS lane needs, wired through cli.js without changing --json.
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSet, loadConfig, saveConfig } from '../src/config.js';
import { parseArgv } from '../src/args.js';
import { main } from '../src/cli.js';

describe('integration hooks', () => {
  it('config accepts ui.terse true/false and nothing else under ui', () => {
    const home = mkdtempSync(join(tmpdir(), 'hartii-hooks-'));
    const cfg = configSet(loadConfig(home), 'ui.terse', 'true');
    expect(cfg.ui).toEqual({ terse: true });
    saveConfig(home, cfg);
    expect(loadConfig(home).ui).toEqual({ terse: true });
    expect(configSet(cfg, 'ui.terse', 'false').ui).toEqual({ terse: false });
    expect(() => configSet(cfg, 'ui.terse', 'maybe')).toThrow(/true or false/);
    expect(() => configSet(cfg, 'ui.colour', 'x')).toThrow(/not a settable/);
  });

  it('--terse and --details are booleans, so they never swallow the next word', () => {
    const p = parseArgv(['--terse', 'balance', '--details']);
    expect(p.command).toBe('balance');
    expect(p.extraFlags.terse).toBe(true);
    expect(p.extraFlags.details).toBe(true);
  });

  it('--terse reaches the human printer and --json output is unchanged by it', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hartii-hooks-'));
    const env = { HARTII_HOME: home };
    const run = async (argv) => { const out = []; const code = await main(argv, { env, write: (s) => out.push(s), writeErr: () => {}, interactive: false }); return { code, out: out.join('\n') }; };
    const plain = await run(['limits']);
    const terse = await run(['limits', '--terse']);
    const json = await run(['limits', '--json']);
    const jsonTerse = await run(['limits', '--json', '--terse']);
    expect(plain.code).toBe(0);
    expect(terse.out.split('\n').length).toBeLessThanOrEqual(plain.out.split('\n').length);
    expect(jsonTerse.out).toBe(json.out);
  });
});
