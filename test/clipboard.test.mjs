import { it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';

const ADDRESS = '0x0011111111111111111111111111111111111111';
async function copy(text, options) {
  const module = await import('../src/clipboard.js').catch(() => null);
  // Missing functionality should fail the behavior assertion, not module loading.
  return module?.copyPublicText ? module.copyPublicText(text, options) : { ok: false, reason: 'missing-feature' };
}
function fakeSpawn({ code = 0, error = false, hang = false } = {}) {
  const children = [], inputs = [];
  const spawnFn = vi.fn(() => {
    const child = new EventEmitter(); child.kill = vi.fn(() => { child.emit('close', null); return true; });
    child.stdin = new Writable({ write(chunk, _encoding, done) { inputs.push(String(chunk)); done(); } });
    child.stdin.on('finish', () => { if (!hang) queueMicrotask(() => error ? child.emit('error', new Error('not available')) : child.emit('close', code)); });
    children.push(child); return child;
  });
  return { spawnFn, inputs, children };
}

it('writes the address through stdin to hidden PowerShell, without a shell or credentials', async () => {
  const fake = fakeSpawn();
  expect(await copy(ADDRESS, { platform: 'win32', spawnFn: fake.spawnFn, env: { SystemRoot: 'C:\\Windows', PATH: 'fixture', HARTII_PASSWORD: 'synthetic-password', OPENAI_API_KEY: 'synthetic-key' } })).toEqual({ ok: true });
  expect(fake.inputs.join('')).toBe(ADDRESS);
  const [command, args, options] = fake.spawnFn.mock.calls[0];
  expect(command.replaceAll('\\', '/')).toBe('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe');
  expect(args).toEqual(expect.arrayContaining(['-NoProfile', '-NonInteractive', '-STA', '-WindowStyle', 'Hidden']));
  expect(args.join(' ')).not.toContain(ADDRESS);
  expect(args.join(' ')).toContain("$ErrorActionPreference='Stop'");
  expect(options).toMatchObject({ shell: false, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
  expect(options.env).not.toHaveProperty('HARTII_PASSWORD');
  expect(options.env).not.toHaveProperty('OPENAI_API_KEY');
});
it('uses stdin for a paylink, never interpolating its text into shell code', async () => {
  const fake = fakeSpawn();
  const value = `https://hartiibiome.com/pay.html?to=${ADDRESS}&memo=%24%28test%29&chain=9&v=1`;
  expect(await copy(value, { platform: 'darwin', spawnFn: fake.spawnFn, env: {} })).toEqual({ ok: true });
  expect(fake.spawnFn.mock.calls[0][0]).toBe('/usr/bin/pbcopy');
  expect(fake.spawnFn.mock.calls[0][1]).toEqual([]);
  expect(fake.inputs.join('')).toBe(value);
});
it('does not claim success on a nonzero setter exit', async () => {
  const fake = fakeSpawn({ code: 1 });
  expect((await copy(ADDRESS, { platform: 'win32', spawnFn: fake.spawnFn, env: {} })).ok).toBe(false);
});
it('handles an unavailable clipboard utility without throwing', async () => {
  const fake = fakeSpawn({ error: true });
  expect((await copy(ADDRESS, { platform: 'darwin', spawnFn: fake.spawnFn, env: {} })).ok).toBe(false);
});
it('bounds a stalled clipboard process and kills only its own child', async () => {
  const fake = fakeSpawn({ hang: true });
  expect(await copy(ADDRESS, { platform: 'win32', spawnFn: fake.spawnFn, timeoutMs: 10, env: {} })).toEqual({ ok: false, reason: 'timeout' });
  expect(fake.children[0].kill).toHaveBeenCalledOnce();
});
it('cancels a started clipboard attempt when the receive pane closes', async () => {
  const fake = fakeSpawn({ hang: true }); const controller = new AbortController();
  const promise = copy(ADDRESS, { platform: 'win32', spawnFn: fake.spawnFn, signal: controller.signal, env: {} });
  await new Promise(resolve => setTimeout(resolve, 0)); controller.abort();
  expect(await promise).toEqual({ ok: false, reason: 'cancelled' });
  expect(fake.children[0].kill).toHaveBeenCalledOnce();
});
it.each(['', 'x\n', 'x\u001b]52;c;data\u0007', 'x'.repeat(2201), null])('refuses empty, control-bearing or oversized data before spawning', async text => {
  const fake = fakeSpawn();
  expect(await copy(text, { platform: 'win32', spawnFn: fake.spawnFn, env: {} })).toEqual({ ok: false, reason: 'invalid' });
  expect(fake.spawnFn).not.toHaveBeenCalled();
});
it('does not start a subprocess after cancellation', async () => {
  const fake = fakeSpawn(); const controller = new AbortController(); controller.abort();
  expect(await copy(ADDRESS, { platform: 'win32', spawnFn: fake.spawnFn, signal: controller.signal, env: {} })).toEqual({ ok: false, reason: 'cancelled' });
  expect(fake.spawnFn).not.toHaveBeenCalled();
});
