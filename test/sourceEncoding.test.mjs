// Every shipped CLI text file must be valid UTF-8. A stray cp1252 byte (0x85 "…" in src/help.js, 0.6.0)
// prints as a broken character in `hartii qi ?` on every UTF-8 terminal.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const TEXT = /\.(js|mjs|cjs|json|md)$/;
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '__snapshots__') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out); else if (TEXT.test(name)) out.push(p);
  }
  return out;
}

describe('source encoding', () => {
  it('every shipped text file decodes as UTF-8', () => {
    const files = [...walk(join(PKG, 'src')), ...walk(join(PKG, 'bin')), join(PKG, 'README.md'), join(PKG, 'CHANGELOG.md'), join(PKG, 'package.json')];
    expect(files.length).toBeGreaterThan(20);
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const bad = files.filter((f) => { try { decoder.decode(readFileSync(f)); return false; } catch { return true; } });
    expect(bad).toEqual([]);
  });
});
