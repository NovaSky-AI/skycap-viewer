// A record directory's index: one summary per document, cached by (mtime, size).
//
// Documents are written once and renamed into place, so a changed mtime or size
// means a new write (e.g. a shutdown record later finished). Sidecars are never
// opened for the index.

import { stat, readdir } from 'node:fs/promises';
import { DOC_SUFFIX, readDocumentAsync, summarize } from './record.js';

export class RecordDirectory {
  /** `summarize(doc, {mtimeMs, size})` makes each cached entry; record.summarize by default. */
  constructor(dir, { concurrency = 32, summarize: summarizer = summarize } = {}) {
    this.dir = dir;
    this.concurrency = concurrency;
    this.summarize = summarizer;
    this.indexed = false;
    this.scannedAt = 0;
    /** id -> {mtimeMs, size, summary} or {mtimeMs, size, error} */
    this.cache = new Map();
    this._refreshing = null;
  }

  /** Rescan the directory, reading only new or changed documents. Concurrent callers share one scan. */
  refresh() {
    this._refreshing ??= this._refresh().finally(() => {
      this._refreshing = null;
    });
    return this._refreshing;
  }

  async _refresh() {
    const names = (await readdir(this.dir)).filter((n) => n.endsWith(DOC_SUFFIX) && !n.startsWith('.'));
    const ids = new Set(names.map((n) => n.slice(0, -DOC_SUFFIX.length)));
    for (const id of this.cache.keys()) if (!ids.has(id)) this.cache.delete(id);
    const queue = [...ids];
    const worker = async () => {
      while (queue.length) {
        const id = queue.pop();
        const path = `${this.dir}/${id}${DOC_SUFFIX}`;
        let st;
        try {
          st = await stat(path);
        } catch {
          this.cache.delete(id);
          continue;
        }
        const cached = this.cache.get(id);
        if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) continue;
        try {
          const summary = this.summarize(await readDocumentAsync(this.dir, id), { mtimeMs: st.mtimeMs, size: st.size });
          this.cache.set(id, { mtimeMs: st.mtimeMs, size: st.size, summary });
        } catch (e) {
          this.cache.set(id, { mtimeMs: st.mtimeMs, size: st.size, error: String(e.message ?? e) });
        }
      }
    };
    await Promise.all(Array.from({ length: this.concurrency }, worker));
    this.indexed = true;
    this.scannedAt = Date.now();
  }

  /** Summaries, newest first, and documents that could not be read. */
  async summaries() {
    await this.refresh();
    const rows = [];
    const errors = [];
    for (const [id, entry] of this.cache) {
      if (entry.summary) rows.push(entry.summary);
      else errors.push({ id, error: entry.error });
    }
    const key = (r) => (typeof r.created_at === 'number' ? r.created_at : r.created_ts ?? 0);
    rows.sort((a, b) => key(b) - key(a) || (a.id < b.id ? -1 : 1));
    return { rows, errors };
  }

  has(id) {
    return /^[A-Za-z0-9_.-]+$/.test(id) && !id.startsWith('.');
  }
}
