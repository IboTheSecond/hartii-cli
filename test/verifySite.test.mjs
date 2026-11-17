import { describe, it, expect, vi } from 'vitest';
import { createHash, generateKeyPairSync, sign as edSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.js';
import { runVerifySite } from '../src/commands/verifySite.js';
import { WEB_RELEASE_KEY } from '../src/webReleaseKey.js';
import { COMMANDS } from '../src/help.js';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const pair = () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  return { privateKey, key: { keyId: sha(Buffer.from(der, 'base64')).slice(0, 16), publicKey: der, algorithm: 'ed25519', statement: 'hartii-web-build/v1' } };
};
const TRUSTED = pair(), OTHER = pair();

const HTML = '<!doctype html><html><head><link rel="stylesheet" href="/assets/app.css"><link rel="modulepreload" href="/assets/chunk.js"><script type="module" src="/assets/app.js"></script></head><body></body></html>';
function world({ signer = TRUSTED, files, html = HTML, tamper, badSig = false, huge = false } = {}) {
  const f = files || { 'assets/app.js': Buffer.from('console.log(1)'), 'assets/app.css': Buffer.from('a{}'), 'assets/chunk.js': Buffer.from('export{}'), 'index.html': Buffer.from('<html>built</html>') };
  const manifest = { format: 'hartii-web-build/v1', version: '1.75.0', commit: 'abcdef1234567890', files: Object.fromEntries(Object.entries(f).map(([k, v]) => [k, sha(v)])) };
  const mbuf = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  const stmt = Buffer.from(`hartii-web-build/v1\n${sha(mbuf)}\n${manifest.version}\n`);
  const sig = badSig ? 'A'.repeat(86) + '==' : edSign(null, stmt, signer.privateKey).toString('base64');
  const calls = [];
  const served = { ...f }; if (tamper) served[tamper] = Buffer.concat([f[tamper], Buffer.from('x')]);
  const res = (buf, type = 'application/octet-stream') => ({ ok: true, status: 200, headers: new Headers({ 'content-type': type, 'content-length': String(buf.length) }), arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) });
  const fetchFn = vi.fn(async (url, init) => {
    calls.push({ url: String(url), init });
    const u = new URL(String(url));
    if (u.origin !== 'https://hartiilabs.com') throw new Error('off-origin ' + url);
    if (u.pathname === '/.well-known/hartii-build.json') return huge ? res(Buffer.alloc(3 * 1024 * 1024, 32)) : res(mbuf, 'application/json');
    if (u.pathname === '/.well-known/hartii-build.json.sig') return res(Buffer.from(sig + '\n'), 'text/plain');
    if (u.pathname === '/') return res(Buffer.from(html), 'text/html; charset=utf-8');
    const rel = u.pathname.slice(1);
    return served[rel] ? res(served[rel]) : { ok: false, status: 404, headers: new Headers(), arrayBuffer: async () => new ArrayBuffer(0) };
  });
  return { fetchFn, calls };
}
const go = (w, extra = {}) => runVerifySite({ json: true }, { fetchFn: w.fetchFn, webReleaseKey: TRUSTED.key, ...extra });

describe('pinned web release key', () => {
  it('matches src/data/webReleaseKey.json and its key id is the SPKI hash', () => {
    const site = JSON.parse(readFileSync(new URL('../../../src/data/webReleaseKey.json', import.meta.url), 'utf8'));
    expect({ ...WEB_RELEASE_KEY }).toEqual(site);
    expect(WEB_RELEASE_KEY.keyId).toBe(sha(Buffer.from(WEB_RELEASE_KEY.publicKey, 'base64')).slice(0, 16));
    expect(Object.isFrozen(WEB_RELEASE_KEY)).toBe(true);
  });
});

describe('hartii verify-site', () => {
  it('passes for a valid manifest, signature and assets', async () => {
    const w = world();
    const r = await go(w);
    expect(r).toMatchObject({ ok: true, version: '1.75.0', commit: 'abcdef1234567890', keyId: TRUSTED.key.keyId, failures: [] });
    expect(r.checked).toBe(3);
    expect(w.calls.every((c) => c.url.startsWith('https://hartiilabs.com/') && c.init.redirect === 'manual')).toBe(true);
  });
  it('names a file with one tampered byte', async () => {
    const r = await go(world({ tamper: 'assets/app.js' }));
    expect(r.ok).toBe(false);
    expect(r.failures.join(' ')).toContain('assets/app.js');
  });
  it('fails on a bad signature before fetching any asset', async () => {
    const w = world({ badSig: true });
    const r = await go(w);
    expect(r.ok).toBe(false);
    expect(w.calls.some((c) => c.url.includes('/assets/'))).toBe(false);
  });
  it('fails on a manifest signed by another key', async () => {
    const w = world({ signer: OTHER });
    const r = await go(w);
    expect(r.ok).toBe(false);
    expect(r.failures.join(' ')).toMatch(/signature/i);
    expect(w.calls.some((c) => c.url.includes('/assets/'))).toBe(false);
  });
  it('fails when the HTML references an unlisted script', async () => {
    const r = await go(world({ html: HTML.replace('</head>', '<script src="/evil.js"></script></head>') }));
    expect(r.ok).toBe(false);
    expect(r.failures.join(' ')).toContain('evil.js');
  });
  it('fails on an oversized manifest', async () => {
    const r = await go(world({ huge: true }));
    expect(r.ok).toBe(false);
    expect(r.failures.join(' ')).toMatch(/too large|size/i);
  });
  it('uses the pinned key by default (a test key does not verify)', async () => {
    const r = await runVerifySite({ json: true }, { fetchFn: world().fetchFn });
    expect(r.ok).toBe(false);
    expect(r.keyId).toBe(WEB_RELEASE_KEY.keyId);
  });
  it('exits non-zero on failure and zero on success, human and json', async () => {
    const run = async (w, argv) => { const out = []; const code = await main(argv, { env: { HARTII_HOME: mkdtempSync(join(tmpdir(), 'hartii-vs-')) }, write: (s) => out.push(s), writeErr: () => {}, interactive: false, fetchFn: w.fetchFn, webReleaseKey: TRUSTED.key }); return { code, out: out.join('\n') }; };
    const ok = await run(world(), ['verify-site']);
    expect(ok.code).toBe(0);
    expect(ok.out).toContain('matches the signed build 1.75.0');
    const bad = await run(world({ tamper: 'assets/app.css' }), ['verify-site', '--json']);
    expect(bad.code).toBe(1);
    expect(JSON.parse(bad.out).ok).toBe(false);
    const badHuman = await run(world({ tamper: 'assets/app.css' }), ['verify-site']);
    expect(badHuman.code).toBe(1);
    expect(badHuman.out).toContain('assets/app.css');
  });
  it('is registered in help and has no origin flag', () => {
    expect(COMMANDS.some((c) => c.name === 'verify-site')).toBe(true);
    expect(readFileSync(new URL('../src/commands/verifySite.js', import.meta.url), 'utf8')).not.toMatch(/flags\.(origin|site|url)/);
  });
});
