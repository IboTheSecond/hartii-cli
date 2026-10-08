// packages/hartii-cli/src/commands/update.js
//
// `hartii update` (alias `upgrade`): check hartiilabs.com for a newer CLI and, on request, install it.
// Security posture: same-origin HTTPS only, redirect:'error', timeouts, a size cap, the tarball is checked
// against the published sha256 BEFORE npm ever sees it, and npm is given a fixed argv with our own temp
// file path -- nothing downloaded is ever interpolated into a shell string. Never called from the MCP server
// (the MCP surface has no update tool; it stays read-only).
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CliError } from '../errors.js';
import { PKG_VERSION } from '../version.js';
import { confirm } from '../prompt.js';

export class UpdateError extends CliError {}

export const DOWNLOAD_BASE = 'https://hartiilabs.com/downloads/';
const SHA_RE = /^[0-9a-f]{64}$/;
const MAX_TARBALL_BYTES = 50 * 1024 * 1024;
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Parse "x.y.z[-pre]" or return null. */
export function parseSemver(v) {
  const m = SEMVER_RE.exec(String(v ?? '').trim());
  return m ? { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split('.') : [] } : null;
}

/** semver precedence: -1, 0, 1 (null when either side is not a valid version). */
export function compareSemver(a, b) {
  const x = parseSemver(a), y = parseSemver(b);
  if (!x || !y) return null;
  for (const k of ['major', 'minor', 'patch']) if (x[k] !== y[k]) return x[k] > y[k] ? 1 : -1;
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], r = y.pre[i];
    if (p === undefined) return -1;
    if (r === undefined) return 1;
    if (p === r) continue;
    const pn = /^\d+$/.test(p), rn = /^\d+$/.test(r);
    if (pn && rn) return +p > +r ? 1 : -1;
    if (pn !== rn) return pn ? -1 : 1;
    return p > r ? 1 : -1;
  }
  return 0;
}

/** Read package/package.json out of an in-memory .tgz (npm pack layout). */
export function versionFromTarball(buf) {
  const tar = gunzipSync(buf);
  for (let off = 0; off + 512 <= tar.length;) {
    const name = tar.toString('utf8', off, off + 100).replace(/\0[\s\S]*$/, '');
    if (!name) break;
    const size = parseInt(tar.toString('utf8', off + 124, off + 136).replace(/\0[\s\S]*$/, '').trim() || '0', 8);
    if (name === 'package/package.json') {
      const pkg = JSON.parse(tar.toString('utf8', off + 512, off + 512 + size));
      if (pkg?.name !== '@hartii/cli') throw new UpdateError('The downloaded file is not the @hartii/cli package.');
      return String(pkg.version);
    }
    off += 512 + Math.ceil(size / 512) * 512;
  }
  throw new UpdateError('The downloaded tarball has no package.json.');
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function fetchLimited(fetchFn, url, { asBuffer = false } = {}) {
  let res;
  try { res = await fetchFn(url, { method: 'GET', signal: AbortSignal.timeout(asBuffer ? 60000 : 12000), redirect: 'error' }); }
  catch (err) { throw new UpdateError(`Could not reach ${url}: ${err?.message || err}`); }
  if (res.ok === false || (res.status ?? 200) >= 400) throw new UpdateError(`${url} answered ${res.status ?? '?'}.`);
  if (!asBuffer) return res;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_TARBALL_BYTES) throw new UpdateError('The download is larger than expected; refusing it.');
  return buf;
}

// Same origin as the download base, https only (a 127.0.0.1 base is allowed so tests can serve locally).
function sameOriginUrl(u, base) {
  let url;
  try { url = new URL(u); } catch { return null; }
  const b = new URL(base);
  if (url.origin !== b.origin || url.username || url.password) return null;
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === '127.0.0.1')) return null;
  return url.href;
}

// Windows: .cmd shims cannot be spawned directly (Node refuses) and `shell: true` just concatenates args, so go
// through cmd.exe with a fixed argv; Node quotes the temp path for us. Elsewhere spawn the binary directly.
const wrap = (platform, bin, args, env) => (platform === 'win32'
  ? [env?.ComSpec || 'cmd.exe', ['/d', '/s', '/c', bin === 'npm' ? 'npm.cmd' : bin, ...args]]
  : [bin, args]);
const SAFE_WIN_PATH = /^[\w :\\./()-]+$/;

/** Published manifest first; the .sha256 file is the fallback (version then comes from the tarball itself). */
async function discover(fetchFn, base) {
  try {
    const res = await fetchLimited(fetchFn, new URL('hartii-cli.json', base).href);
    const m = await res.json();
    const url = sameOriginUrl(m?.url, base);
    if (parseSemver(m?.version) && SHA_RE.test(String(m?.sha256)) && url) return { version: String(m.version), sha256: m.sha256, url, source: 'manifest' };
  } catch { /* fall through to the .sha256 file */ }
  const tgz = new URL('hartii-cli.tgz', base).href;
  const res = await fetchLimited(fetchFn, `${tgz}.sha256`);
  const sha = String((await res.text()).trim().split(/\s+/)[0]).toLowerCase();
  if (!SHA_RE.test(sha)) throw new UpdateError('The published checksum file is not a valid sha256.');
  return { version: null, sha256: sha, url: tgz, source: 'sha256-file' };
}

/**
 * @param {{ check?: boolean, json?: boolean, yes?: boolean }} o
 * @param {object} deps injectable: fetchFn, spawnFn, confirmFn, interactive, writeErr, installed, base, platform, tmp
 */
export async function runUpdate(o, deps = {}) {
  const fetchFn = deps.fetchFn || fetch;
  const spawnFn = deps.spawnFn || spawnSync;
  const platform = deps.platform || process.platform;
  const base = deps.base || DOWNLOAD_BASE;
  const installed = deps.installed || PKG_VERSION;
  const say = o.json ? () => {} : (s) => (deps.writeErr || ((x) => process.stderr.write(`${x}\n`)))(s);
  const manual = `npm install -g ${new URL('hartii-cli.tgz', base).href}`;
  const interactive = deps.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);

  const info = await discover(fetchFn, base);
  let buf = null;
  const download = async () => {
    buf = await fetchLimited(fetchFn, info.url, { asBuffer: true });
    const got = sha256(buf);
    if (got !== info.sha256) throw new UpdateError(`Checksum mismatch: downloaded ${got}, published ${info.sha256}. Refusing to install.`);
    const inside = versionFromTarball(buf);
    if (info.version && inside !== info.version) throw new UpdateError(`The tarball is ${inside} but the manifest says ${info.version}. Refusing to install.`);
    info.version = inside;
  };
  if (!info.version) await download(); // fallback path: the version is only knowable from the tarball

  const cmp = compareSemver(info.version, installed);
  if (cmp === null) throw new UpdateError(`Could not compare versions (${installed} vs ${info.version}).`);
  const head = { installed, latest: info.version, sha256: info.sha256, source: info.source };
  if (cmp <= 0) return { ...head, ok: true, updateAvailable: false, message: `You're on the latest version (${installed})` };
  say(`Update available: ${installed} → ${info.version}`);
  if (o.check) return { ...head, ok: true, updateAvailable: true, message: `Update available: ${installed} → ${info.version}`, upgrade: 'hartii update' };

  if (!o.yes) {
    if (o.json || !interactive) throw new UpdateError('hartii update needs --yes when stdin/stdout is not a terminal or with --json (or use --check to only look).');
    const ok = await (deps.confirmFn || ((q) => confirm(q, { stdout: process.stderr })))(`Install @hartii/cli ${info.version} now?`);
    if (!ok) return { ...head, ok: true, updateAvailable: true, aborted: true, message: 'Not installed.' };
  }

  if (!buf) await download();
  const dir = mkdtempSync(join(deps.tmp || tmpdir(), 'hartii-update-'));
  const file = join(dir, 'hartii-cli.tgz');
  try {
    if (platform === 'win32' && !SAFE_WIN_PATH.test(file)) throw new UpdateError(`Temp path ${file} has characters npm.cmd cannot take safely. Run: ${manual}`);
    writeFileSync(file, buf, { mode: 0o600 });
    say(`Verified sha256 ${info.sha256.slice(0, 12)}... Installing with npm...`);
    const [npmCmd, npmArgs] = wrap(platform, 'npm', ['install', '-g', file], process.env);
    const r = spawnFn(npmCmd, npmArgs, { stdio: 'inherit', windowsHide: true });
    if (r?.error || r?.status !== 0) {
      const lines = [`npm install failed${r?.status != null ? ` (exit ${r.status})` : r?.error ? ` (${r.error.message})` : ''}.`, `Run it yourself:  ${manual}`];
      if (platform !== 'win32') lines.push('If it said EACCES (permission denied): re-run with sudo, or install to your home: npm config set prefix ~/.npm-global && export PATH=~/.npm-global/bin:$PATH');
      return { ...head, ok: false, updateAvailable: true, exitCode: r?.status ?? null, message: lines.join('\n'), upgrade: manual };
    }
    const [hCmd, hArgs] = wrap(platform, 'hartii', ['--version'], process.env);
    const v = spawnFn(hCmd, hArgs, { encoding: 'utf8', windowsHide: true });
    const seen = String(v?.stdout || '').trim().split(/\s+/).pop();
    if (v?.status !== 0 || seen !== info.version) {
      return { ...head, ok: false, updateAvailable: true, message: `npm finished but \`hartii --version\` reports ${seen || 'nothing'}, not ${info.version}. Another hartii earlier on your PATH may be shadowing it (where hartii / which -a hartii).`, upgrade: manual };
    }
    return { ...head, ok: true, updateAvailable: false, updated: true, message: `Updated to ${info.version}` };
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp only */ }
  }
}
