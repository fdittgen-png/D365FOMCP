/**
 * Shared utilities for Azure-hosted MCP servers.
 * - SQLite database singletons (better-sqlite3, read-only)
 * - Query helper with positional parameters
 * - Markdown formatting
 */

import { createRequire } from 'module';
// resolve not needed — paths come from env vars or default mount path

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

// ── Singleton databases ─────────────────────────────────────────────────────

let kbDb;
let xrefDb;
let secDb;

function openDb(filePath, mmapSize = 3221225472) {
  const db = new Database(filePath, { readonly: true });
  db.pragma('journal_mode = OFF');
  db.pragma(`cache_size = -50000`);   // 50 MB cache
  db.pragma(`mmap_size = ${mmapSize}`);
  db.pragma(`busy_timeout = 30000`);  // 30 s — issue #50: bound lock-contention waits
  return db;
}

export function getKbDb() {
  if (!kbDb) {
    const dbPath = process.env.KB_DB_PATH || '/home/data/d365fo_kb.sqlite';
    kbDb = openDb(dbPath, 1100000000);
  }
  return kbDb;
}

export function getXrefDb() {
  if (!xrefDb) {
    const dbPath = process.env.XREF_DB_PATH || '/home/data/d365fo_xref.sqlite';
    xrefDb = openDb(dbPath);
  }
  return xrefDb;
}

export function getSecDb() {
  if (!secDb) {
    const dbPath = process.env.SEC_DB_PATH || '/home/data/d365fo_sec.sqlite';
    secDb = openDb(dbPath, 67108864);
  }
  return secDb;
}

/** Close and discard the sec DB singleton so the next getSecDb() opens a fresh connection. */
export function reloadSecDb() {
  if (secDb) {
    try { secDb.close(); } catch (e) { console.warn('Warning closing sec DB:', e.message); }
    secDb = null;
  }
}

// ── Query helper ─────────────────────────────────────────────────────────────

/**
 * Execute a parameterized query. Returns array of row objects.
 * Usage: query(db, 'SELECT * FROM tables WHERE table_name = ?', ['CustTable'])
 */
export function query(db, sql, params = []) {
  const stmt = db.prepare(sql);
  return stmt.all(...params);
}

// ── Formatting helpers ───────────────────────────────────────────────────────

/**
 * Format an array of row objects as a Markdown table.
 * @param {object[]} rows - Array of row objects
 * @param {string[]} [columns] - Optional column names to display (default: all keys from first row)
 */
export function formatMarkdownTable(rows, columns) {
  if (!rows || rows.length === 0) return 'No results found.';
  if (!columns) columns = Object.keys(rows[0]);

  const header = '| ' + columns.join(' | ') + ' |';
  const sep = '| ' + columns.map(() => '---').join(' | ') + ' |';
  const body = rows
    .map(row => '| ' + columns.map(c => row[c] == null ? '' : String(row[c])).join(' | ') + ' |')
    .join('\n');

  return `${header}\n${sep}\n${body}`;
}

export function textResult(text) {
  return { content: [{ type: 'text', text }] };
}

// ── Wildcard pattern validation (issue #42) ──────────────────────────────────

/**
 * Maximum allowed length for any user-supplied string that becomes a SQL `LIKE`
 * pattern in kb-tools / xref-tools. Above this, full-table scans burn excessive
 * memory and CPU on Azure Functions. Validation must happen before the DB query.
 */
export const MAX_LIKE_PATTERN_LENGTH = 100;

/**
 * Validate that a user-supplied wildcard pattern is within the allowed length.
 * Returns null when valid (or when the input is not a string — Zod handles type errors).
 * Returns `{ error: '...' }` when oversized; the caller decides how to surface it.
 */
export function validateLikePattern(value, max = MAX_LIKE_PATTERN_LENGTH) {
  if (typeof value !== 'string') return null;
  if (value.length > max) {
    return { error: `Search pattern too long (max ${max} chars)` };
  }
  return null;
}

/**
 * Wrap a `validateLikePattern` failure in the MCP error response shape used
 * across kb-tools and xref-tools (text + isError flag, structured object retained
 * so future structured-output handlers can pass it through unchanged).
 */
export function patternErrorResult(validationResult) {
  return {
    content: [{ type: 'text', text: validationResult.error }],
    isError: true,
    structuredContent: validationResult,
  };
}

// ── Query budget enforcement (issue #50) ─────────────────────────────────────

/**
 * Wall-clock budget for a single SQLite call. Configurable via the
 * QUERY_TIMEOUT_MS env var; defaults to 25 s (well under the Azure Functions
 * Premium 60-min ceiling, but high enough for legitimate large traversals).
 *
 * Note: better-sqlite3 is synchronous, so this CANNOT preempt an in-flight
 * query. The check runs after the call returns and converts a budget overrun
 * into a typed error the caller can map to HTTP 504 / a tool-level timeout.
 * Companion measure: the busy_timeout pragma above bounds *lock* waits to 30 s.
 */
export const QUERY_TIMEOUT_MS = Number(process.env.QUERY_TIMEOUT_MS) || 25000;

export class QueryBudgetExceededError extends Error {
  constructor(label, elapsedMs, budgetMs) {
    super(`Query "${label}" exceeded budget: ${elapsedMs}ms > ${budgetMs}ms`);
    this.name = 'QueryBudgetExceededError';
    this.label = label;
    this.elapsedMs = elapsedMs;
    this.budgetMs = budgetMs;
  }
}

/**
 * Run a synchronous DB call and throw QueryBudgetExceededError if it exceeded
 * the wall-clock budget. The injectable `now` clock is for tests.
 */
export function runWithBudget(label, fn, budgetMs = QUERY_TIMEOUT_MS, now = Date.now) {
  const start = now();
  const result = fn();
  const elapsed = now() - start;
  if (elapsed > budgetMs) {
    throw new QueryBudgetExceededError(label, elapsed, budgetMs);
  }
  return result;
}

/**
 * Render a QueryBudgetExceededError as an MCP tool error response. Tools that
 * wrap raw SQL in runWithBudget() should catch the error and return this so
 * the user sees a clean "Query timeout" message rather than an internal trace.
 */
export function timeoutErrorResult(err) {
  return {
    content: [{
      type: 'text',
      text: `Query timeout — try a more specific search. (${err.elapsedMs}ms > ${err.budgetMs}ms budget)`,
    }],
    isError: true,
    structuredContent: {
      error: 'query-timeout',
      label: err.label,
      elapsedMs: err.elapsedMs,
      budgetMs: err.budgetMs,
    },
  };
}
