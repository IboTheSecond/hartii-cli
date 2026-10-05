// packages/hartii-cli/test/args.test.mjs
import { describe, it, expect } from 'vitest';
import { parseFlags, parseArgv } from '../src/args.js';

describe('parseFlags', () => {
  it('parses --foo=bar', () => {
    const { flags } = parseFlags(['--foo=bar']);
    expect(flags.foo).toBe('bar');
  });

  it('parses --foo bar (space-separated value)', () => {
    const { flags } = parseFlags(['--foo', 'bar'], { foo: { type: 'string' } });
    expect(flags.foo).toBe('bar');
  });

  it('treats a boolean flag spec as always boolean even if a value-like token follows', () => {
    const { flags, positionals } = parseFlags(['--yes', 'positional'], { yes: { type: 'boolean' } });
    expect(flags.yes).toBe(true);
    expect(positionals).toEqual(['positional']);
  });

  it('collects positionals in order', () => {
    const { positionals } = parseFlags(['a', 'b', '--x', '1', 'c']);
    expect(positionals).toEqual(['a', 'b', 'c']);
  });

  it('resolves a short alias', () => {
    const { flags } = parseFlags(['-y'], { yes: { type: 'boolean', alias: 'y' } });
    expect(flags.yes).toBe(true);
  });

  it('a flag with no value and nothing following is boolean true', () => {
    const { flags } = parseFlags(['--demo']);
    expect(flags.demo).toBe(true);
  });
});

describe('parseArgv', () => {
  it('extracts globals anywhere in argv', () => {
    const { command, commandArgs, globals } = parseArgv(['send', '0xabc', '1.5', '--yes', '--network', 'orchard']);
    expect(command).toBe('send');
    expect(commandArgs).toEqual(['0xabc', '1.5']);
    expect(globals.yes).toBe(true);
    expect(globals.network).toBe('orchard');
  });

  it('globals before the command still work', () => {
    const { command, globals } = parseArgv(['--json', '--demo', 'balance']);
    expect(command).toBe('balance');
    expect(globals.json).toBe(true);
    expect(globals.demo).toBe(true);
  });

  it('non-global flags land in extraFlags, not globals', () => {
    const { extraFlags, globals } = parseArgv(['balance', '--tokens']);
    expect(extraFlags.tokens).toBe(true);
    expect(globals.tokens).toBeUndefined();
  });

  it('defaults every global to its falsy/null shape with no flags', () => {
    const { globals } = parseArgv(['doctor']);
    expect(globals).toEqual({ json: false, network: null, rpc: null, wallet: null, yes: false, dryRun: false, demo: false, help: false, version: false, keyEnv: null });
  });

  it('no command and no flags yields command: null', () => {
    expect(parseArgv([]).command).toBeNull();
  });
});
