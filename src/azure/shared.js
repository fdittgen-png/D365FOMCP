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

// ── TOON (Token-Oriented Object Notation) ────────────────────────────────────
//
// Compact tabular text for LLM input. Header declares column names once;
// rows list values comma-separated. Lossless round-trip on JSON-primitive
// cells. Used as an opt-in alternative to formatMarkdownTable on tools that
// routinely return large uniform row sets (e.g. *_raw_sql).
//
//   rows[3]{id,name,role}:
//     1,Alice,admin
//     2,Bob,user
//     3,Charlie,user
//
// Quoting rules (RFC 4180-ish): a field is wrapped in double quotes when it
// contains `,` `"` `\n` `\r` or has leading/trailing whitespace. Internal
// quotes are doubled. Numeric/boolean values are stringified as-is.

const TOON_NEEDS_QUOTE = /[",\n\r]|^\s|\s$/;

function toonField(v) {
  const s = v === null || v === undefined ? '' : String(v);
  if (s === '' || !TOON_NEEDS_QUOTE.test(s)) return s;
  return '"' + s.replace(/"/g, '""') + '"';
}

/**
 * Render rows as a TOON block. Returns 'No results found.' for empty input
 * to match formatMarkdownTable's empty-handling.
 *
 * @param {string} arrayName  Logical name (alphanumeric + underscore).
 * @param {object[]} rows
 * @param {string[]} [columns]  Explicit column order; default = keys of rows[0].
 */
export function formatToonBlock(arrayName, rows, columns) {
  if (!rows || rows.length === 0) return 'No results found.';
  const safeName = /^[A-Za-z_][A-Za-z0-9_]*$/.test(arrayName) ? arrayName : 'rows';
  if (!columns) columns = Object.keys(rows[0]);
  const header = `${safeName}[${rows.length}]{${columns.map(toonField).join(',')}}:`;
  const body = rows
    .map(r => '  ' + columns.map(c => toonField(r[c])).join(','))
    .join('\n');
  return `${header}\n${body}`;
}

/**
 * Parse a TOON block emitted by formatToonBlock. Strict about the header
 * shape; stream-decodes the body so quoted fields may contain literal
 * newlines. Returns { arrayName, count, columns, rows }. Throws on
 * malformed input.
 */
export function parseToonBlock(text) {
  if (typeof text !== 'string') throw new Error('parseToonBlock: text must be a string');
  const nl = text.indexOf('\n');
  const headerLine = (nl === -1 ? text : text.slice(0, nl)).replace(/\r$/, '');
  const m = /^([A-Za-z_][A-Za-z0-9_]*)\[(\d+)\]\{(.*)\}:\s*$/.exec(headerLine);
  if (!m) throw new Error(`parseToonBlock: malformed header "${headerLine}"`);
  const arrayName = m[1];
  const count = Number(m[2]);
  const columns = parseToonHeaderColumns(m[3]);

  const body = nl === -1 ? '' : text.slice(nl + 1).replace(/\r\n/g, '\n');
  const rows = [];
  let i = 0;
  const n = body.length;
  while (i < n) {
    if (body[i] === ' ' && body[i + 1] === ' ') i += 2;
    if (i >= n) break;
    if (body[i] === '\n') { i++; continue; }
    const fields = [];
    while (true) {
      let field = '';
      if (body[i] === '"') {
        i++;
        while (i < n) {
          if (body[i] === '"' && body[i + 1] === '"') { field += '"'; i += 2; }
          else if (body[i] === '"') { i++; break; }
          else { field += body[i]; i++; }
        }
      } else {
        while (i < n && body[i] !== ',' && body[i] !== '\n') { field += body[i]; i++; }
      }
      fields.push(field);
      if (i < n && body[i] === ',') { i++; continue; }
      break;
    }
    if (i < n && body[i] === '\n') i++;
    const obj = {};
    for (let j = 0; j < columns.length; j++) {
      obj[columns[j]] = fields[j] === undefined ? '' : fields[j];
    }
    rows.push(obj);
  }
  return { arrayName, count, columns, rows };
}

function parseToonHeaderColumns(s) {
  const out = [];
  let i = 0;
  const n = s.length;
  if (n === 0) return out;
  while (true) {
    let field = '';
    if (s[i] === '"') {
      i++;
      while (i < n) {
        if (s[i] === '"' && s[i + 1] === '"') { field += '"'; i += 2; }
        else if (s[i] === '"') { i++; break; }
        else { field += s[i]; i++; }
      }
    } else {
      while (i < n && s[i] !== ',') { field += s[i]; i++; }
    }
    out.push(field);
    if (i >= n) break;
    if (s[i] === ',') { i++; if (i === n) { out.push(''); break; } continue; }
    break;
  }
  return out;
}

// ── Read-only DB tool annotations ────────────────────────────────────────────
// Frozen so a tool file can't accidentally flip a hint at registration time.
export const READ_ONLY_DB_ANNOTATIONS = Object.freeze({
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: false,
});

// ── Response shape helpers ───────────────────────────────────────────────────

/** Typed payload in structuredContent, Markdown fallback rendered from it. */
export function structuredResult(typed, fallbackText) {
  return {
    content: [{ type: 'text', text: fallbackText }],
    structuredContent: typed,
  };
}

/**
 * Valid query that returned zero rows. Not an error — isError stays undefined.
 *
 * `structured` is the typed payload matching the tool's `outputSchema`, with
 * empty arrays and zeroed counts. It is MANDATORY for any tool that declares an
 * `outputSchema`: the MCP SDK validates every non-error response and throws
 * `-32602 "… has an output schema but no structured content was provided"`
 * when `structuredContent` is absent (see SDK `validateToolOutput` — it skips
 * validation for `isError` results but not for empty success results). Omitting
 * it is only safe on the handful of tools without an output schema.
 */
export function emptyResult(context, structured) {
  const result = {
    content: [{ type: 'text', text: `## No results\n\nNo ${context} found.` }],
  };
  if (structured !== undefined) result.structuredContent = structured;
  return result;
}

/** The named target object does not exist. Sets isError. */
export function notFoundResult(type, name, suggestions) {
  let text = `## ${type} not found\n\n${type} \`${name}\` was not found.`;
  if (Array.isArray(suggestions) && suggestions.length > 0) {
    const list = suggestions.slice(0, 5).map(s => `- \`${s}\``).join('\n');
    text += `\n\n**Did you mean:**\n${list}`;
  }
  // No structuredContent on error responses: the MCP client validates
  // structuredContent against the tool's outputSchema whenever it is present —
  // even on isError results (SDK client/index.js) — so an `{error}`-shaped
  // payload would fail validation for every schema'd tool. isError + text only.
  return {
    content: [{ type: 'text', text }],
    isError: true,
  };
}

const ERROR_CATEGORIES = new Set(['not-found', 'invalid-input', 'db-error', 'parse-error', 'internal']);

/** Tool-level failure. `details` is logged server-side, never echoed to caller. */
export function errorResult(category, hint, details) {
  const cat = ERROR_CATEGORIES.has(category) ? category : 'internal';
  if (details !== undefined) {
    const msg = details instanceof Error ? `${details.name}: ${details.message}` : String(details);
    console.error(`[${cat}] ${hint} -- ${msg}`);
  }
  // isError + text only — see notFoundResult for why no structuredContent.
  return {
    content: [{ type: 'text', text: `## Error\n\n${hint}` }],
    isError: true,
  };
}

/**
 * Markdown footnote describing a truncation.
 *   'user' — caller-supplied limit hit
 *   'cap'  — tool default cap (overridable up to hardMax)
 *   'hard' — non-overridable safety ceiling
 */
export function truncationNote(kind, shown, hardMax) {
  switch (kind) {
    case 'user':
      return `\n\n_Showing first ${shown} results (caller \`limit\`). Pass a higher \`limit\` to see more._\n`;
    case 'cap':
      return `\n\n_Showing first ${shown} results (default cap${hardMax ? `, max ${hardMax}` : ''}). Pass a higher \`limit\` to see more._\n`;
    case 'hard':
      return `\n\n_Showing first ${shown} results (hard safety cap, not configurable)._\n`;
    default:
      return `\n\n_Showing first ${shown} results._\n`;
  }
}

// ── Permission rendering ────────────────────────────────────────────────────

/** Render a sec permission constant as ✓ Grant / ✗ Deny / — None. */
export function formatPermission(type) {
  if (type === null || type === undefined || type === '') return '— None';
  const v = String(type).trim().toLowerCase();
  if (v === 'grant' || v === '1' || v === 'true' || v === 'allow') return '✓ Grant';
  if (v === 'deny'  || v === '0' || v === 'false') return '✗ Deny';
  return '— None';
}

/** Render a CRUD grant flag as Y / N / empty. */
export function formatCrudFlag(v) {
  if (v === null || v === undefined || v === '') return '';
  const s = String(v).trim().toLowerCase();
  if (s === '1' || s === 'true' || s === 'y' || s === 'yes' || s === 'allow' || s === 'grant') return 'Y';
  if (s === '0' || s === 'false' || s === 'n' || s === 'no' || s === 'deny') return 'N';
  return '';
}

// ── Snippet windowing ───────────────────────────────────────────────────────

/**
 * Return a snippet of `text` centred on the first (case-insensitive) match of
 * `term`, with up to `window` chars of context on each side. Ellipses mark
 * unreached string boundaries.
 */
export function contextAround(text, term, window) {
  if (text === null || text === undefined) return '';
  const t = String(text);
  if (!term) return t.length > window * 2 ? t.slice(0, window * 2) + '…' : t;
  const idx = t.toLowerCase().indexOf(String(term).toLowerCase());
  if (idx === -1) {
    return t.length > window * 2 ? t.slice(0, window * 2) + '…' : t;
  }
  const start = Math.max(0, idx - window);
  const end = Math.min(t.length, idx + String(term).length + window);
  let snip = t.slice(start, end);
  if (start > 0) snip = '…' + snip;
  if (end < t.length) snip = snip + '…';
  return snip;
}

// ── Label resolver ──────────────────────────────────────────────────────────

/**
 * Per-call resolver: turns @SYS… IDs into their localized text. Plain strings
 * pass through. Tolerant of DBs without a labels table — degrades to
 * pass-through rather than crashing the tool.
 */
export function makeLabelResolver(db) {
  const cache = new Map();
  let stmt = null;
  let stmtAttempted = false;
  return function resolve(rawLabel) {
    if (rawLabel === null || rawLabel === undefined || rawLabel === '') return rawLabel;
    const s = String(rawLabel);
    if (!s.startsWith('@')) return s;
    if (cache.has(s)) return cache.get(s);
    if (!stmtAttempted) {
      stmtAttempted = true;
      try {
        stmt = db.prepare('SELECT text AS label_text FROM labels WHERE label_id = ? COLLATE NOCASE LIMIT 1');
      } catch {
        stmt = null;
      }
    }
    if (!stmt) {
      cache.set(s, s);
      return s;
    }
    let resolved = s;
    try {
      const row = stmt.get(s);
      if (row && row.label_text) resolved = row.label_text;
    } catch {
      stmt = null;
    }
    cache.set(s, resolved);
    return resolved;
  };
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
  // isError + text only — see notFoundResult for why no structuredContent.
  return {
    content: [{ type: 'text', text: validationResult.error }],
    isError: true,
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
  // isError + text only — see notFoundResult for why no structuredContent.
  return {
    content: [{
      type: 'text',
      text: `Query timeout — try a more specific search. (${err.elapsedMs}ms > ${err.budgetMs}ms budget)`,
    }],
    isError: true,
  };
}
