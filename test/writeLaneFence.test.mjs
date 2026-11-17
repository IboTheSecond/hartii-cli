// Security-run 2026-11-17 (fence test, review R3): no command module may sign or broadcast on its own.
// Every QUAI transaction goes writePipeline.runWrite -> the reviewed wallet in commandContext.js; every Qi transaction goes
// qi/port.js. A new module that calls a signer or broadcast function must be added to ALLOWED here on purpose, after review.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const walk = (dir) => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  if (statSync(p).isDirectory()) return n === 'vendor' ? [] : walk(p);
  return p.endsWith('.js') ? [p] : [];
});
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/(^|\s)\/\/.*$/, '$1')).join('\n');
const rel = (p) => relative(SRC, p).split(sep).join('/');

const SIGN_OR_SEND = /\b(sendTransaction|signTransaction|broadcastTransaction|sendRawTransaction)\b|(port|provider|node|rpc)\.broadcast\(/;
const ALLOWED_TX = new Set([
  'commandContext.js', // buildReviewedWallet: offline sign, decode-compare, chain/nonce re-check, explicit broadcast
  'writePipeline.js', // the only caller of wallet.sendTransaction, after review and reservation
  'qi/port.js', // the Qi UTXO lane (build, sign, broadcast)
  'qi/engine.js', // drives port.broadcast after review, caps and ledger
]);

describe('write-lane fence', () => {
  const files = walk(SRC).map((p) => ({ path: rel(p), text: code(readFileSync(p, 'utf8')) }));

  it('only the reviewed modules sign or broadcast a transaction', () => {
    const offenders = files.filter((f) => SIGN_OR_SEND.test(f.text) && !ALLOWED_TX.has(f.path)).map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it('only writePipeline calls wallet.sendTransaction', () => {
    const callers = files.filter((f) => /\bwallet\.sendTransaction\(/.test(f.text)).map((f) => f.path);
    expect(callers).toEqual(['writePipeline.js']);
  });

  it('no module builds its own Wallet signer except the reviewed runtime, key-env address derivation and the Qi notice', () => {
    const allowed = new Set(['commandContext.js', 'mcp/tools.js', 'qi/mailbox.js', 'trader/services.js']);
    const offenders = files.filter((f) => /\bnew Wallet\(/.test(f.text) && !allowed.has(f.path)).map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it('the Qi payment notice reaches the chain only through runWrite', () => {
    const mailbox = files.find((f) => f.path === 'qi/mailbox.js').text;
    expect(mailbox).toMatch(/\brunWrite\(/);
    expect(mailbox).not.toMatch(/new Contract\([^)]*wallet/);
    expect(SIGN_OR_SEND.test(mailbox)).toBe(false);
  });
});
