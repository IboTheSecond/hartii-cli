import { lstatSync, realpathSync, mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, linkSync, unlinkSync } from 'node:fs';
import { resolve, parse, sep, dirname, join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';

export class SecureFileError extends Error {}
const samePath = (a, b) => process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);

/** Every existing ancestor must be real; reject aliases and multiply linked files before I/O. */
export function securePath(path, { regularFile = false } = {}) {
  if (typeof path !== 'string' || !path) throw new SecureFileError('A valid local storage path is required.');
  const target = resolve(path); let current = parse(target).root; let last = null;
  for (const part of target.slice(current.length).split(sep).filter(Boolean)) {
    current = resolve(current, part);
    try {
      last = lstatSync(current);
      if (last.isSymbolicLink() || !samePath(realpathSync(current), current)) throw new SecureFileError('Unsafe linked or redirected wallet storage path.');
      if (last.isFile() && last.nlink !== 1) throw new SecureFileError('Unsafe hardlinked wallet storage file.');
    } catch (error) {
      if (error.code === 'ENOENT') return { path: target, stat: null };
      if (error instanceof SecureFileError) throw error;
      throw new SecureFileError('Could not inspect local wallet storage safely.');
    }
  }
  if (regularFile && last && !last.isFile()) throw new SecureFileError('Wallet storage requires a regular file.');
  return { path: target, stat: last };
}

export function secureDirectory(path) {
  const checked = securePath(path);
  if (checked.stat && !checked.stat.isDirectory()) throw new SecureFileError('Wallet storage requires a directory.');
  if (!checked.stat) mkdirSync(checked.path, { recursive: true, mode: 0o700 });
  securePath(checked.path);
  return checked.path;
}

const unchanged = (a, b) => a && b && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

/** Publish a fully flushed private file. New files use atomic no-replace linking; replacement
 * uses rename after checking the original identity, so an old key/config is never truncated. */
export function atomicPrivateWrite(path, data, { replace = false } = {}) {
  const initial = securePath(path, { regularFile: true });
  if (initial.stat && !replace) throw new SecureFileError('Storage file already exists.');
  const dir = secureDirectory(dirname(initial.path));
  const temp = join(dir, `.${basename(initial.path)}-${randomUUID()}.tmp`);
  let fd = null, owned = false;
  try {
    fd = openSync(temp, 'wx', 0o600); owned = true;
    writeFileSync(fd, data, 'utf8'); fsyncSync(fd); closeSync(fd); fd = null;
    const current = securePath(initial.path, { regularFile: true });
    if (initial.stat) {
      if (!unchanged(initial.stat, current.stat)) throw new SecureFileError('Storage changed during write; original file preserved.');
      renameSync(temp, initial.path); owned = false;
    } else {
      // EEXIST is authoritative even if another process created the target after our checks.
      linkSync(temp, initial.path); unlinkSync(temp); owned = false;
    }
  } catch (error) {
    if (error instanceof SecureFileError) throw error;
    if (error.code === 'EEXIST') throw new SecureFileError('Storage file already exists; it was not overwritten.');
    throw new SecureFileError('Could not commit wallet storage safely; the original file was not truncated.');
  } finally {
    if (fd !== null) closeSync(fd);
    if (owned) { try { unlinkSync(temp); } catch { /* retain our incomplete private temp file for recovery */ } }
  }
}

/** Rename with atomic no-replace semantics. A concurrent destination cannot be overwritten. */
export function renamePrivateFile(oldPath, newPath) {
  const old = securePath(oldPath, { regularFile: true });
  const next = securePath(newPath, { regularFile: true });
  if (!old.stat) throw new SecureFileError('Source wallet file does not exist.');
  if (next.stat) throw new SecureFileError('Destination wallet file already exists.');
  let linked = false;
  try {
    linkSync(old.path, next.path); linked = true;
    const source = lstatSync(old.path), destination = lstatSync(next.path);
    if (source.isSymbolicLink() || destination.isSymbolicLink() || source.dev !== old.stat.dev || source.ino !== old.stat.ino || destination.ino !== old.stat.ino || source.nlink !== 2) throw new SecureFileError('Wallet file changed during rename.');
    unlinkSync(old.path); linked = false;
  } catch (error) {
    if (linked) { try { unlinkSync(next.path); } catch { /* leave encrypted recovery copies */ } }
    if (error instanceof SecureFileError) throw error;
    throw new SecureFileError('Could not rename wallet safely; a destination was not overwritten.');
  }
}
