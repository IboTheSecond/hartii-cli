import { spawn } from 'node:child_process';
import { win32 } from 'node:path';

const SYSTEM_ENV = new Set([
  'PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE',
  'LOCALAPPDATA', 'APPDATA', 'SESSIONNAME', 'DISPLAY', 'WAYLAND_DISPLAY',
  'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'LANG', 'LC_ALL', 'LC_CTYPE',
]);
const POWERSHELL_COPY = "$ErrorActionPreference='Stop'; Set-Clipboard -Value ([Console]::In.ReadToEnd())";

/** Copy public receiving text only; never read the clipboard, invoke a shell or echo payloads. */
export async function copyPublicText(text, { platform = process.platform, spawnFn = spawn, env = process.env, signal, timeoutMs = 3000 } = {}) {
  if (typeof text !== 'string' || !text || text.length > 2200 || /[^\x20-\x7e]/.test(text)) return { ok: false, reason: 'invalid' };
  if (signal?.aborted) return { ok: false, reason: 'cancelled' };
  const childEnv = Object.fromEntries(Object.entries(env).filter(([key]) => SYSTEM_ENV.has(key.toUpperCase())));
  const commands = platform === 'win32'
    ? [[win32.join(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-STA', '-WindowStyle', 'Hidden', '-Command', POWERSHELL_COPY]]]
    : platform === 'darwin'
      ? [['/usr/bin/pbcopy', []]]
      : platform === 'linux'
        ? [['wl-copy', ['--type', 'text/plain']], ['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]]
        : [];
  if (!commands.length) return { ok: false, reason: 'unavailable' };
  for (const [command, args] of commands) {
    const result = await new Promise(resolve => {
      let child, timer, finished = false, inputFailed = false;
      const finish = result => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        resolve(result);
      };
      const stop = reason => {
        finish({ ok: false, reason });
        try { child?.kill(); } catch { /* only this owned clipboard child */ }
      };
      const abort = () => stop('cancelled');
      try {
        child = spawnFn(command, args, { shell: false, windowsHide: true, env: childEnv, stdio: ['pipe', 'ignore', 'ignore'] });
        child.on('error', () => finish({ ok: false, reason: 'unavailable' }));
        child.on('close', code => finish(code === 0 && !inputFailed ? { ok: true } : { ok: false, reason: 'failed' }));
        child.stdin.on('error', () => { inputFailed = true; });
        signal?.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => stop('timeout'), timeoutMs);
        if (signal?.aborted) abort();
        else child.stdin.end(text);
      } catch {
        stop('unavailable');
      }
    });
    if (result.ok || result.reason === 'cancelled' || result.reason === 'timeout') return result;
  }
  return { ok: false, reason: 'unavailable' };
}
