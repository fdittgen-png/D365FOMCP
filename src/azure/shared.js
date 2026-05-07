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
