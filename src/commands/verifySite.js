// packages/hartii-cli/src/commands/verifySite.js
//
// `hartii verify-site`: is hartiilabs.com serving exactly the build Hartii signed?
//  1. fetch the signed manifest + signature (/.well-known/hartii-build.json[.sig])
//  2. verify the ed25519 signature with the key PINNED in this CLI (src/webReleaseKey.js), before any asset is fetched
//  3. fetch every non-HTML file the manifest lists and compare sha256
//  4. fetch `/` and require every script/stylesheet/modulepreload it references to be in the signed manifest
//     (route HTML is rewritten per route by the site's SEO middleware, so HTML is checked by its assets, not by hash)
// Fixed origin, no override flag, redirects are failures, size caps and timeouts everywhere, never retries into a pass.
import { createHash, createPublicKey, verify as edVerify } from 'node:crypto';
import { WEB_RELEASE_KEY } from '../webReleaseKey.js';
import { tagView } from '../output.js';

export const ORIGIN = 'https://hartiilabs.com';
const MANIFEST_PATH = '.well-known/hartii-build.json';
const SIGNATURE_PATH = '.well-known/hartii-build.json.sig';
const FORMAT = 'hartii-web-build/v1';
const MAX_MANIFEST = 2 * 1024 * 1024;
const MAX_SIGNATURE = 1024;
const MAX_HTML = 5 * 1024 * 1024;
const MAX_FILE = 25 * 1024 * 1024;
const MAX_TOTAL = 400 * 1024 * 1024;
const MAX_FILES = 5000;
const CONCURRENCY = 6;
const TIMEOUT_MS = 20000;

const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const isHtml = (p) => /\.html?$/i.test(p);

class Fail extends Error {}

function verifySignature({ manifestSha256, version, signature, key }) {
  try {
    if (!/^[A-Za-z0-9+/]{86}==$/.test(signature)) return false;
    const pub = createPublicKey({ key: Buffer.from(key.publicKey, 'base64'), format: 'der', type: 'spki' });
    return edVerify(null, Buffer.from(`${FORMAT}\n${manifestSha256}\n${version}\n`, 'utf8'), pub, Buffer.from(signature, 'base64'));
  } catch { return false; }
}

function htmlAssetRefs(html) {
  const refs = new Set();
  for (const tag of html.match(/<(?:script|link)\b[^>]*>/gi) || []) {
    const isLink = /^<link/i.test(tag);
    if (isLink && !/\brel\s*=\s*["']?(?:stylesheet|modulepreload)/i.test(tag)) continue;
    const m = tag.match(isLink ? /\bhref\s*=\s*["']([^"']+)["']/i : /\bsrc\s*=\s*["']([^"']+)["']/i);
    if (m) refs.add(m[1]);
  }
  return [...refs];
}

export async function runVerifySite(opts = {}, deps = {}) {
  const key = deps.webReleaseKey || WEB_RELEASE_KEY; // injectable for tests only; the CLI wiring never sets it
  const fetchImpl = deps.fetchFn || fetch;
  const failures = [];
  let checked = 0, total = 0, version = null, commit = null;
  const finish = () => tagView({ ok: failures.length === 0, origin: ORIGIN, version, commit, keyId: key.keyId, checked, failures }, 'verify-site');

  async function get(path, max) {
    const label = path || '/';
    const url = path === '' ? `${ORIGIN}/` : `${ORIGIN}/${path.split('/').map(encodeURIComponent).join('/')}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), deps.timeoutMs || TIMEOUT_MS);
    try {
      const res = await fetchImpl(url, { method: 'GET', signal: ctrl.signal, redirect: 'manual', cache: 'no-store' });
      if (res.status >= 300 && res.status < 400) throw new Fail(`${label}: redirected (HTTP ${res.status}), refused`);
      if (res.status !== 200) throw new Fail(`${label}: HTTP ${res.status}`);
      const declared = Number(res.headers?.get?.('content-length'));
      if (Number.isFinite(declared) && declared > max) throw new Fail(`${label}: too large (${declared} bytes, limit ${max})`);
      let buf;
      if (res.body && typeof res.body.getReader === 'function') {
        const reader = res.body.getReader(); const chunks = []; let n = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          n += value.length;
          if (n > max) { try { await reader.cancel(); } catch { /* already closed */ } throw new Fail(`${label}: too large (over ${max} bytes)`); }
          chunks.push(Buffer.from(value));
        }
        buf = Buffer.concat(chunks);
      } else {
        buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > max) throw new Fail(`${label}: too large (${buf.length} bytes, limit ${max})`);
      }
      return { buf, type: res.headers?.get?.('content-type') || '' };
    } catch (e) {
      if (e instanceof Fail) throw e;
      throw new Fail(`${label}: ${e?.name === 'AbortError' ? 'timed out' : 'could not be fetched'}`);
    } finally { clearTimeout(timer); }
  }

  let manifest;
  try {
    const [m, s] = await Promise.all([get(MANIFEST_PATH, MAX_MANIFEST), get(SIGNATURE_PATH, MAX_SIGNATURE)]);
    try { manifest = JSON.parse(m.buf.toString('utf8')); } catch { manifest = null; }
    const shapeOk = manifest && manifest.format === FORMAT && typeof manifest.version === 'string' && manifest.files && typeof manifest.files === 'object' && !Array.isArray(manifest.files);
    if (!shapeOk) { failures.push('manifest: missing or malformed'); return finish(); }
    if (!verifySignature({ manifestSha256: sha256(m.buf), version: manifest.version, signature: s.buf.toString('utf8').trim(), key })) {
      failures.push(`signature: does not verify with the Hartii web release key ${key.keyId}`);
      return finish();
    }
  } catch (e) { failures.push(e.message); return finish(); }
  version = manifest.version;
  commit = typeof manifest.commit === 'string' ? manifest.commit : null;

  const entries = Object.entries(manifest.files);
  if (entries.length > MAX_FILES) { failures.push(`manifest: lists too many files (${entries.length})`); return finish(); }
  const assets = entries.filter(([p]) => !isHtml(p));
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, assets.length) }, async () => {
    while (next < assets.length) {
      const [path, want] = assets[next++];
      try {
        if (total > MAX_TOTAL) throw new Fail(`${path}: skipped, total download cap reached`);
        const { buf } = await get(path, MAX_FILE);
        total += buf.length;
        checked++;
        if (sha256(buf) !== want) failures.push(`${path}: content differs from the signed build`);
      } catch (e) { checked++; failures.push(e.message); }
    }
  }));

  try {
    const { buf, type } = await get('', MAX_HTML);
    if (!/text\/html/i.test(type)) failures.push('/: not an HTML page');
    else {
      const refs = htmlAssetRefs(buf.toString('utf8'));
      if (!refs.length) failures.push('/: no script or stylesheet references found');
      for (const ref of refs) {
        let u;
        try { u = new URL(ref, `${ORIGIN}/`); } catch { failures.push(`/: unreadable reference ${ref}`); continue; }
        if (u.origin !== ORIGIN) { failures.push(`/: ${ref} points to another origin`); continue; }
        let rel;
        try { rel = decodeURIComponent(u.pathname.replace(/^\//, '')); } catch { rel = u.pathname; }
        if (!Object.hasOwn(manifest.files, rel)) failures.push(`/: ${rel} is not in the signed build`);
      }
    }
  } catch (e) { failures.push(e.message); }
  failures.sort();
  return finish();
}
