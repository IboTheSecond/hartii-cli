import { describe, it, expect, vi } from 'vitest';
import { gzipSync } from 'node:zlib';
import { createHash, generateKeyPairSync, sign as edSign } from 'node:crypto';
import { releaseMessage, keyIdOf } from '../src/releaseKey.js';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.js';
import { compareSemver, versionFromTarball, runUpdate } from '../src/commands/update.js';

const BASE = 'https://hartiilabs.com/downloads/';
// Throwaway release keys: the CLI trusts exactly one key; tests inject theirs through deps.releaseKey.
const pair = () => { const { publicKey, privateKey } = generateKeyPairSync('ed25519'); const der = publicKey.export({ format: 'der', type: 'spki' }).toString('base64'); return { privateKey, key: { algorithm: 'ed25519', publicKey: der, keyId: keyIdOf(der) } }; };
const TEST = pair(), OTHER = pair();
const signRelease = (sha256, version, who = TEST) => edSign(null, releaseMessage({ sha256, version }), who.privateKey).toString('base64');
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
function world({ version = '0.2.3', manifest = true, tamper = false, calls = [], signer = TEST, signed = true, sigInManifest = true } = {}) {
  const tar = tgz(version);
  const served = tamper ? tgz(version, '@hartii/cli ') : tar;
  const fetchFn = vi.fn(async (url, init) => {
    calls.push({ url: String(url), init });
    const u = String(url);
    const ok = (extra) => ({ ok: true, status: 200, ...extra });
    const signature = signed ? signRelease(sha(tar), version, signer) : undefined;
    if (u === `${BASE}hartii-cli.json`) return manifest ? ok({ json: async () => ({ version, sha256: sha(tar), url: `${BASE}hartii-cli.tgz`, ...(sigInManifest && signed ? { signature, keyId: signer.key.keyId } : {}) }) }) : { ok: false, status: 404 };
    if (u === `${BASE}hartii-cli.tgz.sig`) return signed ? ok({ text: async () => `${signature}\n` }) : { ok: false, status: 404 };
    if (u === `${BASE}hartii-cli.tgz.sha256`) return ok({ text: async () => `${sha(tar)}  hartii-cli.tgz\n` });
    if (u === `${BASE}hartii-cli.tgz`) return ok({ arrayBuffer: async () => ab(served) });
    return { ok: false, status: 404 };
  });
  return { fetchFn, tar };
}

const run = async (argv, deps) => {
  const out = []; const err = [];
  const code = await main(argv, { env: { HARTII_HOME: mkdtempSync(join(tmpdir(), 'hartii-upd-home-')) }, write: (s) => out.push(s), writeErr: (s) => err.push(s), interactive: false, releaseKey: TEST.key, ...deps });
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
  it('keeps actual installer child output off the JSON stdout channel', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hartii-update-json-'));
    const file = join(dir, 'probe.mjs');
    const tar = tgz('99.1.0');
    const lines = [
      'import {runUpdate} from ' + JSON.stringify(new URL('../src/commands/update.js', import.meta.url).href) + ';',
      'import {spawnSync} from "node:child_process";',
      'const tar=Buffer.from(' + JSON.stringify(tar.toString('base64')) + ',"base64");',
      'const digest=' + JSON.stringify(sha(tar)) + ';',
      'const SIG=' + JSON.stringify(signRelease(sha(tar), '99.1.0')) + ';const KEY=' + JSON.stringify(TEST.key) + ';',
      'const fetchFn=async url=>({ok:true,status:200,json:async()=>({version:"99.1.0",sha256:digest,url:"https://hartiilabs.com/downloads/hartii-cli.tgz",signature:SIG,keyId:KEY.keyId}),arrayBuffer:async()=>tar.buffer.slice(tar.byteOffset,tar.byteOffset+tar.length)});',
      'const installerCode=' + JSON.stringify("process.stdout.write('INSTALLER-PROGRESS\\n')") + ';',
      'const spawnFn=(_cmd,args,opts)=>args.includes("install")?spawnSync(process.execPath,["-e",installerCode],opts):{status:0,stdout:"99.1.0\\n"};',
      'const result=await runUpdate({yes:true,json:true},{installed:"0.1.0",fetchFn,spawnFn,releaseKey:KEY});',
      'process.stdout.write(JSON.stringify(result));',
    ];
    writeFileSync(file, lines.join('\n'));
    const result = spawnSync(process.execPath, [file], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ updated: true, latest: '99.1.0' });
    expect(result.stderr).toContain('INSTALLER-PROGRESS');
  });
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
    expect(o.stdio).toEqual(['inherit', 2, 2]);
    expect(installedBytes).toEqual(tar);
    expect(seen[1][1].at(-1)).toBe('--version');
    for (const c of calls) { expect(c.init.redirect).toBe('error'); expect(c.url.startsWith(BASE)).toBe(true); }
    expect(existsSync(args.at(-1))).toBe(false); // temp file cleaned up
  });

  it('accepts a Windows short-name temp path while verifying the downloaded bytes', async () => {
    const parent=mkdtempSync(join(tmpdir(),'hartii-short-path-')),temp=join(parent,'RUNNER~1');mkdirSync(temp);
    const {fetchFn,tar}=world({version:'99.1.0'});let installedBytes;
    const spawnFn=vi.fn((cmd,args)=>{if(args.includes('install'))installedBytes=readFileSync(args.at(-1));return {status:0,stdout:'99.1.0\n'};});
    const result=await runUpdate({yes:true},{tmp:temp,platform:'win32',fetchFn,spawnFn,writeErr:()=>{},releaseKey:TEST.key});
    expect(result.updated).toBe(true);expect(installedBytes).toEqual(tar);
    expect(spawnFn).toHaveBeenCalledTimes(2);
    expect(spawnFn.mock.calls[0][1].slice(0,4)).toEqual(['/d','/s','/c','npm.cmd']);
  });

  it.each(['unsafe&path','unsafe%path','unsafe!path'])('rejects Windows shell metacharacters in temp path %s before invoking npm', async name => {
    const parent=mkdtempSync(join(tmpdir(),'hartii-unsafe-path-')),temp=join(parent,name);mkdirSync(temp);
    const {fetchFn}=world({version:'99.1.0'}),spawnFn=vi.fn();
    await expect(runUpdate({yes:true},{tmp:temp,platform:'win32',fetchFn,spawnFn,writeErr:()=>{},releaseKey:TEST.key})).rejects.toThrow(/cannot take safely/);
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
      if (u.endsWith('.sig')) return { ok: true, status: 200, text: async () => signRelease(sha(tar), '99.1.0') };
      return { ok: true, status: 200, arrayBuffer: async () => ab(tar) };
    });
    const r = await run(['update', '--check', '--json'], { fetchFn });
    expect(JSON.parse(r.out).source).toBe('sha256-file');
    expect(fetchFn.mock.calls.every(([u]) => String(u).startsWith(BASE))).toBe(true);
  });
});

describe('hartii update - signed releases', () => {
  const attempt = async (worldOpts, deps = {}) => {
    const { fetchFn } = world({ version: '99.1.0', ...worldOpts });
    const spawnFn = vi.fn(() => ({ status: 0, stdout: '99.1.0' }));
    const promise = runUpdate({ yes: true, json: true }, { installed: '0.1.0', fetchFn, spawnFn, releaseKey: TEST.key, tmp: mkdtempSync(join(tmpdir(), 'hartii-sigtest-')), ...deps });
    return { promise, spawnFn };
  };
  it('installs a release signed by the embedded key', async () => {
    const { promise, spawnFn } = await attempt({});
    expect(await promise).toMatchObject({ ok: true, updated: true });
    expect(spawnFn).toHaveBeenCalled();
  });
  it('accepts the signature from the .sig file when the manifest carries none', async () => {
    const { promise } = await attempt({ sigInManifest: false });
    expect(await promise).toMatchObject({ ok: true, updated: true });
  });
  it('refuses an unsigned release and never runs npm', async () => {
    const { promise, spawnFn } = await attempt({ signed: false });
    await expect(promise).rejects.toThrow(/not signed/);
    expect(spawnFn).not.toHaveBeenCalled();
  });
  it('refuses a release signed by a different key and never runs npm', async () => {
    const { promise, spawnFn } = await attempt({ signer: OTHER });
    await expect(promise).rejects.toThrow(/does not match the Hartii release key/);
    expect(spawnFn).not.toHaveBeenCalled();
  });
  it('refuses a good-looking sha256 on a tarball the signature was not made for', async () => {
    // Same key, signature over a different version statement: the hash matches the file but the signature does not.
    const { fetchFn } = world({ version: '99.1.0' });
    const wrap = vi.fn(async (url, init) => {
      const res = await fetchFn(url, init);
      if (String(url).endsWith('hartii-cli.json')) { const m = await res.json(); return { ...res, json: async () => ({ ...m, signature: signRelease(m.sha256, '99.9.9') }) }; }
      return res;
    });
    const spawnFn = vi.fn();
    await expect(runUpdate({ yes: true }, { installed: '0.1.0', fetchFn: wrap, spawnFn, releaseKey: TEST.key, tmp: mkdtempSync(join(tmpdir(), 'hartii-sigtest-')) })).rejects.toThrow(/does not match/);
    expect(spawnFn).not.toHaveBeenCalled();
  });
  it('the production key is the embedded one: a test-key signature is refused by default', async () => {
    const { fetchFn } = world({ version: '99.1.0' });
    const spawnFn = vi.fn();
    await expect(runUpdate({ yes: true }, { installed: '0.1.0', fetchFn, spawnFn, tmp: mkdtempSync(join(tmpdir(), 'hartii-sigtest-')) })).rejects.toThrow(/does not match the Hartii release key/);
    expect(spawnFn).not.toHaveBeenCalled();
  });
});
