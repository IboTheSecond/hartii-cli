// packages/hartii-cli/test/output.test.mjs
import { describe, it, expect } from 'vitest';
import { colorEnabled, makeColors, stripAnsi, printJson, formatTable } from '../src/output.js';
import * as output from '../src/output.js';
it('redacts complete diagnostic URLs including punctuation in credentials and dotted/padded paths',()=>{
  for(const url of ['https://user:prefix)fixture-password@rpc.invalid/path','https://rpc.invalid/v3/fixture.path.secret.long','https://rpc.invalid/v3/fixture_path_secret_long==']) {
    expect(output.redactUrls(url)).not.toMatch(/fixture-password|fixture.path.secret.long|fixture_path_secret_long/);
  }
  const link='https://quaiscan.io/tx/0x'+'a'.repeat(64);
  expect(output.redactUrls(link+')')).toBe(link+')');
});

describe('safeTerminalText', () => {
  it('removes cursor commands and OSC clipboard/link/title payloads', () => {
    const hostile = 'A\u001b[2J\u001b[H\u001b]52;c;c2VjcmV0\u0007B\u001b]8;;https://evil.invalid\u001b\\link\u001b]8;;\u001b\\';
    expect(output.safeTerminalText?.(hostile)).toBe('ABlink');
  });

  it('removes C0/DEL/C1 controls including CR, LF and alternate CSI/OSC forms', () => {
    expect(output.safeTerminalText?.('x\r\n\t\b\u0000\u007f\u0085\u009b2J\u009dtitle\u009cy')).toBe('xy');
  });

  it('drops unterminated escape payloads and preserves ordinary Unicode text', () => {
    expect(output.safeTerminalText?.('QUAI 🐪 café\u001b]52;unfinished')).toBe('QUAI 🐪 café');
    expect(output.safeTerminalText?.(123)).toBe('123');
  });

  it('strips bidi overrides and zero-width characters so a symbol cannot visually reorder or hide the address next to it', () => {
    const addr = '0x0010000000000000000000000000000000000002';
    expect(output.safeTerminalText?.(`\u202eLIVE\u200b\u200d\u2066\ufeff (${addr})\u202c`)).toBe(`LIVE (${addr})`);
    expect(output.safeTerminalText?.('ok … ▁▂ ─')).toBe('ok … ▁▂ ─'); // ordinary TUI glyphs stay
  });
});

describe('colorEnabled', () => {
  it('is false when NO_COLOR is set, even on a TTY', () => {
    expect(colorEnabled({ env: { NO_COLOR: '1' }, isTTY: true })).toBe(false);
  });

  it('is true when FORCE_COLOR is set, even off a TTY', () => {
    expect(colorEnabled({ env: { FORCE_COLOR: '1' }, isTTY: false })).toBe(true);
  });

  it('NO_COLOR wins over FORCE_COLOR', () => {
    expect(colorEnabled({ env: { NO_COLOR: '1', FORCE_COLOR: '1' }, isTTY: true })).toBe(false);
  });

  it('follows isTTY when neither env var is set', () => {
    expect(colorEnabled({ env: {}, isTTY: true })).toBe(true);
    expect(colorEnabled({ env: {}, isTTY: false })).toBe(false);
  });
});

describe('makeColors', () => {
  it('wraps with ANSI codes when enabled', () => {
    const c = makeColors({ enabled: true });
    expect(c.red('hi')).toBe('\u001b[31mhi\u001b[0m');
  });

  it('returns the plain string when disabled', () => {
    const c = makeColors({ enabled: false });
    expect(c.red('hi')).toBe('hi');
    expect(c.bold('hi')).toBe('hi');
  });
});

describe('stripAnsi', () => {
  it('removes SGR escape codes', () => {
    const c = makeColors({ enabled: true });
    expect(stripAnsi(c.purple('camel'))).toBe('camel');
  });

  it('is a no-op on plain text', () => {
    expect(stripAnsi('plain')).toBe('plain');
  });
});

describe('printJson', () => {
  it('writes pretty JSON with no BigInt (caller must pre-convert)', () => {
    let out = '';
    printJson({ a: 1, b: 'two' }, { write: (s) => (out = s) });
    expect(JSON.parse(out)).toEqual({ a: 1, b: 'two' });
  });
});

describe('formatTable', () => {
  it('pads columns to the widest cell', () => {
    const table = formatTable([
      ['name', 'address'],
      ['a', '0x123'],
      ['longname', '0x1'],
    ]);
    const lines = table.split('\n');
    expect(lines[0].startsWith('name      ')).toBe(true); // padded to "longname".length
  });

  it('returns empty string for no rows', () => {
    expect(formatTable([])).toBe('');
  });
});
