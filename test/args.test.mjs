// packages/hartii-cli/test/args.test.mjs
import { describe, it, expect } from 'vitest';
import { parseFlags, parseArgv, GLOBAL_FLAG_SPECS } from '../src/args.js';

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

  it.each(['true', 'false', '1', 'no', ''])('rejects inline values on a declared boolean (%s)', (value) => {
    expect(() => parseFlags([`--yes=${value}`], { yes: { type: 'boolean' } })).toThrow(/--yes.*does not accept a value/);
  });

  it('also rejects an inline value on a boolean short alias', () => {
    expect(() => parseFlags(['-y=true'], { yes: { type: 'boolean', alias: 'y' } })).toThrow(/--yes.*does not accept a value/);
  });

  it('keeps string and unspecified flag values unchanged', () => {
    expect(parseFlags(['--network=orchard', '--slippage=2'], { network: { type: 'string' } }).flags)
      .toEqual({ network: 'orchard', slippage: '2' });
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

  const booleanFlags = [
    ...Object.entries(GLOBAL_FLAG_SPECS).filter(([, spec]) => spec.type === 'boolean').map(([name]) => name),
    'from-arg', 'trust-live-addresses', 'allow-writes', 'mine', 'check', 'qr', 'tokens', 'stdin',
    'allow-insecure-rpc', 'once', 'observe', 'pair', 'create-wallet', 'browser', 'address-qr',
  ];
  it.each(booleanFlags)('refuses inline --%s before it can silently change meaning', (flag) => {
    for (const value of ['true', 'false', '']) {
      expect(() => parseArgv(['send', 'public-address-fixture', '1', `--${flag}=${value}`, '--yes']))
        .toThrow(/does not accept a value/);
    }
  });

  it('does not allow a later bare flag to conceal an invalid inline boolean', () => {
    expect(() => parseArgv(['send', '--dry-run=false', '--dry-run'])).toThrow(/--dry-run/);
  });
});
