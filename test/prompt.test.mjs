import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { readHiddenInput, readVisibleInput, confirm } from '../src/prompt.js';

function terminal(raw = false) {
  const stdin = new EventEmitter();
  Object.assign(stdin, { isTTY: true, isRaw: raw, setRawMode: vi.fn(), resume: vi.fn(), pause: vi.fn(), setEncoding: vi.fn() });
  return { stdin, stdout: { write: vi.fn() } };
}

async function settled(promise) {
  return Promise.race([
    promise.then(value => ({ value }), error => ({ error: error.message })),
    new Promise(resolve => setImmediate(() => resolve({ pending: true }))),
  ]);
}

describe('hidden terminal input', () => {
  it.each(['\r', '\n', '\r\n'])('accepts a whole pasted line with %j without embedding its terminator', async (ending) => {
    const io = terminal();
    const result = readHiddenInput('Password: ', io);
    io.stdin.emit('data', `paste-sentinel${ending}`);
    expect(await settled(result)).toEqual({ value: 'paste-sentinel' });
    expect(io.stdout.write.mock.calls.flat().join('')).not.toContain('paste-sentinel');
    expect(io.stdin.listenerCount('data')).toBe(0);
  });

  it('handles edits within a chunk and restores an already-raw terminal', async () => {
    const io = terminal(true);
    const result = readHiddenInput('Password: ', io);
    io.stdin.emit('data', 'ab\bcd\u007fZ\r');
    expect(await settled(result)).toEqual({ value: 'acZ' });
    expect(io.stdin.setRawMode).toHaveBeenLastCalledWith(true);
  });

  it('handles embedded Ctrl-C and restores cooked terminal state', async () => {
    const io = terminal();
    const result = readHiddenInput('Password: ', io);
    io.stdin.emit('data', 'sentinel\u0003');
    expect(await settled(result)).toEqual({ error: 'Aborted.' });
    expect(io.stdin.setRawMode).toHaveBeenLastCalledWith(false);
    expect(io.stdin.listenerCount('data')).toBe(0);
  });

  it('rejects terminal EOF and releases listeners', async () => {
    const io = terminal();
    const result = readHiddenInput('Password: ', io);
    io.stdin.emit('end');
    expect(await settled(result)).toEqual({ error: 'Input closed before an answer.' });
    expect(io.stdin.listenerCount('data')).toBe(0);
  });
});

describe('non-interactive prompts', () => {
  it.each([readHiddenInput, readVisibleInput, confirm])('rejects empty EOF instead of hanging', async (prompt) => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const result = prompt('Answer: ', { stdin, stdout, allowPipedSecret: true });
    stdin.end();
    expect(await settled(result)).toEqual({ error: 'Input closed before an answer.' });
  });

  it.each([readHiddenInput, readVisibleInput, confirm])('writes its prompt to stderr by default', async (prompt) => {
    const stdin = new PassThrough();
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const result = prompt('Answer: ', { stdin, allowPipedSecret: true });
      stdin.end('yes\n');
      await result;
      expect(err).toHaveBeenCalledWith(expect.stringContaining('Answer: '));
      expect(out).not.toHaveBeenCalled();
    } finally {
      err.mockRestore();
      out.mockRestore();
    }
  });
});
