import { createHash } from 'node:crypto';
import { open, mkdir, lstat, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { canonicalJson, exactObject, invariant, timestamp, TraderError } from './validation.mjs';
const digest = data => createHash('sha256').update(canonicalJson(data)).digest('hex');
function record(previous, entry) {
  exactObject(entry, ['type', 'at', 'data']); timestamp(entry.at);
  invariant(typeof entry.type === 'string' && /^[a-z][a-z.-]{0,63}$/.test(entry.type), 'invalid-journal-type');
  const body = { schemaVersion: 1, seq: previous ? previous.seq + 1 : 1, previousHash: previous?.hash ?? null, ...structuredClone(entry) };
  return { ...body, hash: digest(body) };
}
function validate(records) {
  let previous = null;
  for (const r of records) {
    exactObject(r, ['schemaVersion', 'seq', 'previousHash', 'type', 'at', 'data', 'hash'], 'journal-corrupt');
    const expected = record(previous, { type: r.type, at: r.at, data: r.data });
    invariant(canonicalJson(expected) === canonicalJson(r), 'journal-corrupt'); previous = r;
  }
  return records;
}
export class MemoryJournal {
  #records = [];
  get durable() { return false; }
  async read() { return structuredClone(validate(this.#records)); }
  async append(entry) { const next = record(this.#records.at(-1), entry); this.#records.push(next); return structuredClone(next); }
  async close() {}
}
async function rejectLinks(path) {
  let cursor = resolve(path);
  while (true) {
    try { invariant(!(await lstat(cursor)).isSymbolicLink(), 'journal-linked-path'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
}
/** Single writer, no expiring lock. A crash leaves a lock requiring deliberate local recovery. */
export class FileJournal {
  #file; #lock; #path; #records; #queue = Promise.resolve(); #closed = false; #failed = false;
  get durable() { return true; }
  static async open(path) {
    const journal = new FileJournal(); journal.#path = resolve(path);
    await rejectLinks(journal.#path); await mkdir(dirname(journal.#path), { recursive: true, mode: 0o700 });
    await rejectLinks(`${journal.#path}.lock`);
    try { journal.#lock = await open(`${journal.#path}.lock`, 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') throw new TraderError('journal-locked'); throw error; }
    try {
      await journal.#lock.writeFile('hartii-trader-exclusive-writer-v1\n'); await journal.#lock.sync();
      journal.#file = await open(journal.#path, 'a+', 0o600);
      const text = await journal.#file.readFile('utf8');
      invariant(text === '' || text.endsWith('\n'), 'journal-corrupt');
      try { journal.#records = validate(text.split('\n').filter(Boolean).map(line => JSON.parse(line))); }
      catch { throw new TraderError('journal-corrupt'); }
      return journal;
    } catch (error) { await journal.close(); throw error; }
  }
  async read() { invariant(!this.#closed && !this.#failed, 'journal-unavailable'); return structuredClone(this.#records); }
  append(entry) {
    const operation = this.#queue.then(async () => {
      invariant(!this.#closed && !this.#failed, 'journal-unavailable');
      const next = record(this.#records.at(-1), entry);
      try { await this.#file.writeFile(`${canonicalJson(next)}\n`); await this.#file.sync(); }
      catch (error) { this.#failed = true; throw error; }
      this.#records.push(next); return structuredClone(next);
    });
    this.#queue = operation.catch(() => {}); return operation;
  }
  async close() {
    await this.#queue;
    if (this.#closed) return;
    this.#closed = true; await this.#file?.close(); await this.#lock?.close();
    if (this.#lock) await unlink(`${this.#path}.lock`);
  }
}
