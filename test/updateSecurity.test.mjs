// Security-run 2026-11-17 (R3-F11): the update path caps download and unpacked size and checks the signature before parsing.
import { describe, it, expect, vi } from 'vitest';
import { gzipSync } from 'node:zlib';
import { createHash, generateKeyPairSync, sign as edSign } from 'node:crypto';
import { releaseMessage, keyIdOf } from '../src/releaseKey.js';
import { runUpdate, UpdateError } from '../src/commands/update.js';

const BASE = 'https://hartiilabs.com/downloads/';
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const der = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
const KEY = { algorithm: 'ed25519', publicKey: der, keyId: keyIdOf(der) };
const sha = (b) => createHash('sha256').update(b).digest('hex');
const ab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.length);
const sign = (sha256, version) => edSign(null, releaseMessage({ sha256, version }), privateKey).toString('base64');
const run = (deps) => runUpdate({ yes: true, json: true }, { base: BASE, installed: '0.1.0', releaseKey: KEY, spawnFn: () => ({ status: 0 }), ...deps });

describe('R3-F11 update download limits', () => {
  it('a gzip bomb with a matching checksum is refused as an UpdateError (checksum-file fallback path)', async () => {
    const bomb = gzipSync(Buffer.alloc(260 * 1024 * 1024));
    expect(bomb.length).toBeLessThan(2 * 1024 * 1024);
    const fetchFn = vi.fn(async (url) => {
      const u = String(url);
      if (u.endsWith('.json')) return { ok: false, status: 404 };
      if (u.endsWith('.sha256')) return { ok: true, status: 200, text: async () => `${sha(bomb)}\n` };
      if (u.endsWith('.sig')) return { ok: true, status: 200, text: async () => `${sign(sha(bomb), '9.9.9')}\n` };
      return { ok: true, status: 200, arrayBuffer: async () => ab(bomb) };
    });
    const err = await run({ fetchFn }).catch((e) => e);
    expect(err).toBeInstanceOf(UpdateError);
    expect(String(err.message)).toMatch(/unpacks to far more|not a valid package/);
  }, 60_000);

  it('with a manifest, a bad signature is refused BEFORE the archive is unpacked', async () => {
    const bomb = gzipSync(Buffer.alloc(260 * 1024 * 1024));
    const fetchFn = vi.fn(async (url) => {
      const u = String(url);
      if (u.endsWith('hartii-cli.json')) return { ok: true, status: 200, json: async () => ({ version: '9.9.9', sha256: sha(bomb), url: `${BASE}hartii-cli.tgz`, signature: sign('0'.repeat(64), '9.9.9'), keyId: KEY.keyId }) };
      return { ok: true, status: 200, arrayBuffer: async () => ab(bomb) };
    });
    const err = await run({ fetchFn }).catch((e) => e);
    expect(err).toBeInstanceOf(UpdateError);
    expect(String(err.message)).toMatch(/signature does not match/); // not the unpack error: nothing was parsed
  }, 60_000);

  it('an oversized declared download is refused without reading the body', async () => {
    const body = vi.fn(async () => new ArrayBuffer(8));
    const fetchFn = vi.fn(async (url) => {
      const u = String(url);
      if (u.endsWith('hartii-cli.json')) return { ok: true, status: 200, json: async () => ({ version: '9.9.9', sha256: 'a'.repeat(64), url: `${BASE}hartii-cli.tgz` }) };
      return { ok: true, status: 200, headers: { get: (h) => (h === 'content-length' ? String(80 * 1024 * 1024) : null) }, arrayBuffer: body };
    });
    await expect(run({ fetchFn })).rejects.toThrow(/larger than expected/);
    expect(body).not.toHaveBeenCalled();
  });

  it('a streamed body stops at the cap instead of filling memory', async () => {
    let pulled = 0;
    const chunk = new Uint8Array(8 * 1024 * 1024);
    const stream = { getReader: () => ({ read: async () => { pulled += 1; return pulled > 100 ? { done: true } : { done: false, value: chunk }; }, cancel: async () => {} }) };
    const fetchFn = vi.fn(async (url) => {
      const u = String(url);
      if (u.endsWith('hartii-cli.json')) return { ok: true, status: 200, json: async () => ({ version: '9.9.9', sha256: 'a'.repeat(64), url: `${BASE}hartii-cli.tgz` }) };
      return { ok: true, status: 200, body: stream };
    });
    await expect(run({ fetchFn })).rejects.toThrow(/larger than expected/);
    expect(pulled).toBeLessThanOrEqual(8);
  });
});
