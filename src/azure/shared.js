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

/** Valid query that returned zero rows. Not an error — isError stays undefined. */
export function emptyResult(context) {
  return {
    content: [{ type: 'text', text: `## No results\n\nNo ${context} found.` }],
  };
}

/** The named target object does not exist. Sets isError. */
export function notFoundResult(type, name, suggestions) {
  let text = `## ${type} not found\n\n${type} \`${name}\` was not found.`;
  if (Array.isArray(suggestions) && suggestions.length > 0) {
    const list = suggestions.slice(0, 5).map(s => `- \`${s}\``).join('\n');
    text += `\n\n**Closest matches:**\n${list}`;
  }
  return {
    content: [{ type: 'text', text }],
    isError: true,
    structuredContent: { error: { category: 'not-found', type, name, suggestions: suggestions || [] } },
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
  return {
    content: [{ type: 'text', text: `## Error\n\n${hint}` }],
    isError: true,
    structuredContent: { error: { category: cat, hint } },
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
        stmt = db.prepare('SELECT label_text FROM labels WHERE label_id = ? COLLATE NOCASE LIMIT 1');
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
