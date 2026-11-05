// packages/hartii-cli/src/openUrl.js
//
// Launches the default browser for a Hartii Gallery link, and ONLY for one: the URL must be on
// https://hartiigallery.com/ and use a conservative character set (no '&', quotes, spaces or shell
// metacharacters), so a hostile name or address can never turn `--open` into a different command.
import { spawn } from 'node:child_process';

const GALLERY_URL = /^https:\/\/hartiigallery\.com\/[A-Za-z0-9/_.\-?=:]*$/;

/**
 * @param {string} url
 * @param {{ spawnFn?: Function, noSpawn?: boolean, platform?: string }} [opts]
 * @returns {boolean} true when a launch was attempted, false when launching is disabled.
 */
export function openGalleryUrl(url, { spawnFn = spawn, noSpawn = false, platform = process.platform } = {}) {
  let ok = typeof url === 'string' && GALLERY_URL.test(url);
  if (ok) { try { ok = new URL(url).origin === 'https://hartiigallery.com'; } catch { ok = false; } }
  if (!ok) throw new Error('Refusing to open a URL outside https://hartiigallery.com/.');
  if (noSpawn) return false;
  const [cmd, args] = platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    const child = spawnFn(cmd, args, { stdio: 'ignore', detached: true });
    child?.on?.('error', () => {}); // no browser opener installed: the URL is printed anyway
    child?.unref?.();
  } catch {
    return false;
  }
  return true;
}
