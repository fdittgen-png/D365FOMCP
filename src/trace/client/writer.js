/**
 * Non-blocking trace writer (TDD §7.1) and its sinks (§7.2).
 *
 * `enqueue()` is synchronous and O(1); it accepts SANITIZED records only.
 * Bounded ring of 500 (drop-oldest, counted), flush coalesced on setImmediate
 * or every 2 s (unref'd timer), batches ≤ 100 records, sink timeout 3 s, one
 * retry on network / 5xx / 429, none on 4xx. Never awaited on a response path.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { isSanitized } from '../contract/sanitize.js';

export class TraceWriter {
  /** @param {(batch: object[]) => Promise<void>} sink */
  constructor(sink, { ring = 500, batch = 100, intervalMs = 2000, retry = true } = {}) {
    this.sink = sink;
    this.ring = ring;
    this.batchSize = batch;
    this.retry = retry;
    this.queue = [];
    this.stats = { enqueued: 0, sent: 0, dropped_ring: 0, dropped_invalid: 0, failed: 0, retried: 0 };
    this.flushing = false;
    this.scheduled = false;
    /** @type {string|null} */
    this.sinkKind = null;
    this.timer = setInterval(() => this.flush(), intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  enqueue(record) {
    if (!isSanitized(record)) throw new Error('TraceWriter.enqueue: record is not sanitized');
    this.stats.enqueued += 1;
    if (this.queue.length >= this.ring) { this.queue.shift(); this.stats.dropped_ring += 1; }
    this.queue.push(record);
    if (!this.scheduled) {
      this.scheduled = true;
      setImmediate(() => { this.scheduled = false; this.flush(); });
    }
  }

  async flush() {
    if (this.flushing || this.queue.length === 0) return;
    this.flushing = true;
    try {
      while (this.queue.length) {
        const batch = this.queue.splice(0, this.batchSize);
        await this.send(batch);
      }
    } finally {
      this.flushing = false;
    }
  }

  async send(batch) {
    try {
      await this.sink(batch);
      this.stats.sent += batch.length;
    } catch (err) {
      const e = /** @type {any} */ (err);
      if (this.retry && e?.retryable !== false) {
        this.stats.retried += 1;
        try {
          await this.sink(batch);
          this.stats.sent += batch.length;
          return;
        } catch { /* fall through */ }
      }
      this.stats.failed += batch.length;
    }
  }

  close() {
    clearInterval(this.timer);
    return this.flush();
  }
}

/* ── sinks ─────────────────────────────────────────────────────────────────── */

export function nullSink() {
  return async () => {};
}

export function memorySink(target = []) {
  const sink = async (batch) => { target.push(...batch); };
  sink.records = target;
  return sink;
}

/** NDJSON append. Synchronous append is fine: batches are small and the caller never awaits the writer. */
export function fileSink(filePath) {
  let ensured = false;
  return async (batch) => {
    if (!ensured) { mkdirSync(dirname(filePath), { recursive: true }); ensured = true; }
    appendFileSync(filePath, batch.map((r) => JSON.stringify(r)).join('\n') + '\n');
  };
}

/** POST the batch as a JSON array. 4xx → not retryable (`dropped_invalid`). */
export function httpSink({ url, key = '', bearer = '', timeoutMs = 3000, fetchImpl = globalThis.fetch }) {
  return async (batch) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const headers = { 'content-type': 'application/json' };
      if (key) headers['x-functions-key'] = key;
      if (bearer) headers.authorization = `Bearer ${bearer}`;
      const res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(batch), signal: ctrl.signal });
      if (res.status >= 500 || res.status === 429) throw Object.assign(new Error(`HTTP ${res.status}`), { retryable: true });
      if (res.status >= 400) throw Object.assign(new Error(`HTTP ${res.status}`), { retryable: false });
    } finally {
      clearTimeout(t);
    }
  };
}

/* ── process singleton from the environment ───────────────────────────────── */

let singleton = null;

export function traceEnabled(env = process.env) {
  return env.MCP_TRACE === 'on';
}

/** `TRACE_SINK` = file (default on stdio) | http | memory | null. Lazy: a dry run creates no file. */
export function traceWriter(service, env = process.env) {
  if (singleton) return singleton;
  const kind = env.TRACE_SINK || 'file';
  let sink;
  if (kind === 'http' && env.TRACE_INGEST_URL) sink = httpSink({ url: env.TRACE_INGEST_URL, key: env.TRACE_INGEST_KEY || '' });
  else if (kind === 'memory') sink = memorySink();
  else if (kind === 'null') sink = nullSink();
  else {
    const home = env.TRACE_HOME || env.USERPROFILE || env.HOME || '.';
    const dir = env.TRACE_FILE_DIR || `${home}/.claude/mcp-trace`;
    sink = fileSink(`${dir}/${service}.ndjson`);
  }
  singleton = new TraceWriter(sink);
  singleton.sinkKind = kind;
  return singleton;
}

/** Tests only. */
export function resetTraceWriter() {
  if (singleton) clearInterval(singleton.timer);
  singleton = null;
}
