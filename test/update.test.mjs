import { describe, it, expect, vi } from 'vitest';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.js';
import { compareSemver, versionFromTarball, runUpdate } from '../src/commands/update.js';

const BASE = 'https://hartiilabs.com/downloads/';
const sha = (b) => createHash('sha256').update(b).digest('hex');
const ab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.length);

function tgz(version, name = '@hartii/cli') {
  const body = Buffer.from(JSON.stringify({ name, version }));
  const h = Buffer.alloc(512);
  h.write('package/package.json', 0);
  h.write(body.length.toString(8).padStart(11, '0') + '\0', 124);
  const pad = Buffer.alloc((512 - (body.length % 512)) % 512);
  return gzipSync(Buffer.concat([h, body, pad, Buffer.alloc(1024)]));
}

// A fake hartiilabs.com/downloads. `tamper` serves different bytes than the published sha256 describes.
function world({ version = '0.2.3', manifest = true, tamper = false, calls = [] } = {}) {
  const tar = tgz(version);
  const served = tamper ? tgz(version, '@hartii/cli ') : tar;
  const fetchFn = vi.fn(async (url, init) => {
    calls.push({ url: String(url), init });
    const u = String(url);
    const ok = (extra) => ({ ok: true, status: 200, ...extra });
    if (u === `${BASE}hartii-cli.json`) return manifest ? ok({ json: async () => ({ version, sha256: sha(tar), url: `${BASE}hartii-cli.tgz` }) }) : { ok: false, status: 404 };
    if (u === `${BASE}hartii-cli.tgz.sha256`) return ok({ text: async () => `${sha(tar)}  hartii-cli.tgz\n` });
    if (u === `${BASE}hartii-cli.tgz`) return ok({ arrayBuffer: async () => ab(served) });
    return { ok: false, status: 404 };
  });
  return { fetchFn, tar };
}

const run = async (argv, deps) => {
  const out = []; const err = [];
  const code = await main(argv, { env: { HARTII_HOME: mkdtempSync(join(tmpdir(), 'hartii-upd-home-')) }, write: (s) => out.push(s), writeErr: (s) => err.push(s), interactive: false, ...deps });
  return { code, out: out.join('\n'), err: err.join('\n') };
};

describe('semver + tarball helpers', () => {
  it('compares versions with semver precedence', () => {
    expect(compareSemver('0.2.3', '0.2.2')).toBe(1);
    expect(compareSemver('0.10.0', '0.9.9')).toBe(1);
    expect(compareSemver('0.2.2', '0.2.2')).toBe(0);
    expect(compareSemver('1.0.0-rc.1', '1.0.0')).toBe(-1);
    expect(compareSemver('x', '1.0.0')).toBeNull();
  });
  it('reads the version from inside a tarball and refuses a different package', () => {
    expect(versionFromTarball(tgz('0.2.3'))).toBe('0.2.3');
    expect(() => versionFromTarball(tgz('0.2.3', 'evil'))).toThrow(/not the @hartii\/cli/);
  });
});

describe('hartii update', () => {
  it('already on the latest version', async () => {
    const { fetchFn } = world({ version: '0.0.1' });
    const spawnFn = vi.fn();
    const r = await run(['update', '--json'], { fetchFn, spawnFn });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ updateAvailable: false });
    expect(JSON.parse(r.out).message).toContain("You're on the latest version (");
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('newer: downloads, verifies sha, installs the local file with npm and verifies the new version', async () => {
    const calls = []; const seen = []; let installedBytes = null;
    const { fetchFn, tar } = world({ version: '99.1.0', calls });
    const spawnFn = vi.fn((cmd, args, o) => {
      seen.push([cmd, args, o]);
      if (args.includes('install')) { installedBytes = readFileSync(args.at(-1)); return { status: 0 }; }
      return { status: 0, stdout: '99.1.0\n' };
    });
    const r = await run(['update', '--yes'], { fetchFn, spawnFn });
    expect(r.code).toBe(0);
    expect(r.out).toContain('Updated to 99.1.0');
    expect(r.err).toContain('Update available:');
    const [cmd, args, o] = seen[0];
    if (process.platform === 'win32') expect(args.slice(0, 4)).toEqual(['/d', '/s', '/c', 'npm.cmd']);
    else expect(cmd).toBe('npm');
    expect(args.slice(args.indexOf('install'), args.indexOf('install') + 2)).toEqual(['install', '-g']);
    expect(o.stdio).toBe('inherit');
    expect(installedBytes).toEqual(tar);
    expect(seen[1][1].at(-1)).toBe('--version');
    for (const c of calls) { expect(c.init.redirect).toBe('error'); expect(c.url.startsWith(BASE)).toBe(true); }
    expect(existsSync(args.at(-1))).toBe(false); // temp file cleaned up
  });

  it('accepts a Windows short-name temp path while verifying the downloaded bytes', async () => {
    const parent=mkdtempSync(join(tmpdir(),'hartii-short-path-')),temp=join(parent,'RUNNER~1');mkdirSync(temp);
    const {fetchFn,tar}=world({version:'99.1.0'});let installedBytes;
    const spawnFn=vi.fn((cmd,args)=>{if(args.includes('install'))installedBytes=readFileSync(args.at(-1));return {status:0,stdout:'99.1.0\n'};});
    const result=await runUpdate({yes:true},{tmp:temp,platform:'win32',fetchFn,spawnFn,writeErr:()=>{}});
    expect(result.updated).toBe(true);expect(installedBytes).toEqual(tar);
    expect(spawnFn).toHaveBeenCalledTimes(2);
    expect(spawnFn.mock.calls[0][1].slice(0,4)).toEqual(['/d','/s','/c','npm.cmd']);
  });

  it.each(['unsafe&path','unsafe%path','unsafe!path'])('rejects Windows shell metacharacters in temp path %s before invoking npm', async name => {
    const parent=mkdtempSync(join(tmpdir(),'hartii-unsafe-path-')),temp=join(parent,name);mkdirSync(temp);
    const {fetchFn}=world({version:'99.1.0'}),spawnFn=vi.fn();
    await expect(runUpdate({yes:true},{tmp:temp,platform:'win32',fetchFn,spawnFn,writeErr:()=>{}})).rejects.toThrow(/cannot take safely/);
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('refuses a download whose sha256 does not match the published one', async () => {
    const { fetchFn } = world({ version: '99.1.0', tamper: true });
    const spawnFn = vi.fn();
    const r = await run(['update', '--yes'], { fetchFn, spawnFn });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/Checksum mismatch/);
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('npm failure prints the exact manual command (+ EACCES hint off Windows)', async () => {
    const { fetchFn } = world({ version: '99.1.0' });
    const spawnFn = vi.fn(() => ({ status: 243 }));
    const r = await run(['update', '--yes', '--json'], { fetchFn, spawnFn });
    expect(r.code).toBe(1);
    const j = JSON.parse(r.out);
    expect(j.ok).toBe(false);
    expect(j.message).toContain('npm install -g https://hartiilabs.com/downloads/hartii-cli.tgz');
    if (process.platform !== 'win32') expect(j.message).toMatch(/EACCES[\s\S]*sudo/);
  });

  it('--check only reports and never downloads the tarball or runs npm', async () => {
    const calls = [];
    const { fetchFn } = world({ version: '99.1.0', calls });
    const spawnFn = vi.fn();
    const r = await run(['update', '--check', '--json'], { fetchFn, spawnFn });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ updateAvailable: true, latest: '99.1.0' });
    expect(calls.map((c) => c.url)).toEqual([`${BASE}hartii-cli.json`]);
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('--json (or a non-TTY) without --yes refuses to install', async () => {
    const { fetchFn } = world({ version: '99.1.0' });
    const spawnFn = vi.fn();
    const r = await run(['update', '--json'], { fetchFn, spawnFn });
    expect(r.code).toBe(1);
    expect(r.err + r.out).toMatch(/needs --yes/);
    expect((await run(['upgrade'], { fetchFn, spawnFn })).code).toBe(1);
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('on a TTY it asks first and a "no" installs nothing', async () => {
    const { fetchFn } = world({ version: '99.1.0' });
    const spawnFn = vi.fn();
    const confirmFn = vi.fn(async () => false);
    const r = await run(['update'], { fetchFn, spawnFn, confirmFn, interactive: true });
    expect(confirmFn).toHaveBeenCalled();
    expect(r.code).toBe(0);
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('falls back to the .sha256 file and reads the version from the tarball when the manifest is missing', async () => {
    const { fetchFn } = world({ version: '99.1.0', manifest: false });
    const r = await run(['update', '--check', '--json'], { fetchFn });
    expect(JSON.parse(r.out)).toMatchObject({ updateAvailable: true, latest: '99.1.0', source: 'sha256-file' });
  });

  it('rejects a manifest pointing at another origin and falls back', async () => {
    const tar = tgz('99.1.0');
    const fetchFn = vi.fn(async (u) => {
      u = String(u);
      if (u.endsWith('.json')) return { ok: true, status: 200, json: async () => ({ version: '99.1.0', sha256: sha(tar), url: 'https://evil.example/hartii-cli.tgz' }) };
      if (u.endsWith('.sha256')) return { ok: true, status: 200, text: async () => `${sha(tar)}  x\n` };
      return { ok: true, status: 200, arrayBuffer: async () => ab(tar) };
    });
    const r = await run(['update', '--check', '--json'], { fetchFn });
    expect(JSON.parse(r.out).source).toBe('sha256-file');
    expect(fetchFn.mock.calls.every(([u]) => String(u).startsWith(BASE))).toBe(true);
  });
});
