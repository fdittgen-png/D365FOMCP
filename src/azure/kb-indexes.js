/**
 * Performance indexes for the KB database — single source of truth (#125).
 *
 * Same self-heal pattern as sec-indexes.js: `getKbDb()` (shared.js) and the
 * local stdio server run `ensureKbIndexes()` before opening the read-only
 * connection, so a code deploy alone brings an existing KB file up to date at
 * first request. `CREATE INDEX IF NOT EXISTS` is a no-op when present (~ms);
 * the first request after a deploy that introduced an index pays once.
 * build/build-kb.js carries the same statements for fresh builds.
 *
 * Why it matters: better-sqlite3 is synchronous and the Function App has one
 * Node worker — an un-indexed equality scan over the 867k-row `methods` table
 * (with its source_code blobs) blocks every MCP endpoint while it runs.
 *
 * Set KB_AUTO_INDEX=false to disable (read-only mount, or a deliberately
 * frozen snapshot).
 */

import { createRequire } from 'module';
import { existsSync } from 'fs';
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

export const KB_INDEXES = [
  {
    name: 'idx_methods_name_nocase',
    table: 'methods',
    sql: `CREATE INDEX IF NOT EXISTS idx_methods_name_nocase ON methods(method_name COLLATE NOCASE)`,
    why: 'd365_find_method_implementations / WHERE method_name = ? COLLATE NOCASE (#125)',
  },
  {
    name: 'idx_form_controls_form',
    table: 'form_controls',
    sql: `CREATE INDEX IF NOT EXISTS idx_form_controls_form ON form_controls(form_name COLLATE NOCASE)`,
    why: 'd365_lookup_form include_controls (#124)',
  },
  {
    name: 'idx_form_controls_binding',
    table: 'form_controls',
    sql: `CREATE INDEX IF NOT EXISTS idx_form_controls_binding ON form_controls(data_source COLLATE NOCASE, data_field COLLATE NOCASE)`,
    why: 'd365_lookup_form controls bound to a table field (#124)',
  },
  {
    name: 'idx_forms_pattern',
    table: 'forms',
    column: 'pattern',
    sql: `CREATE INDEX IF NOT EXISTS idx_forms_pattern ON forms(pattern COLLATE NOCASE)`,
    why: 'd365_find_forms by pattern (#124)',
  },
  {
    name: 'idx_objects_meta_name',
    table: 'objects_meta',
    sql: `CREATE INDEX IF NOT EXISTS idx_objects_meta_name ON objects_meta(object_name COLLATE NOCASE)`,
    why: 'd365_lookup_object / d365_preflight collision check (#123, #126)',
  },
];

/**
 * Create any missing KB indexes in place. Indexes whose table (or column) is
 * not in this snapshot are skipped — a pre-#123 database has no
 * `form_controls`, and that is a coverage fact, not an error.
 *
 * @param {string} dbPath
 * @param {{ log?: (msg: string) => void }} [opts]
 * @returns {{ created: string[], skipped: string[], present: string[], ms: number }}
 */
export function ensureKbIndexes(dbPath, { log = () => {} } = {}) {
  const t0 = Date.now();
  const result = { created: [], skipped: [], present: [], ms: 0 };
  if (!existsSync(dbPath)) { result.ms = Date.now() - t0; return result; }
  let db;
  try {
    db = new Database(dbPath);
    db.pragma('busy_timeout = 30000');
    /** @type {any[]} */
    const tableRows = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    /** @type {any[]} */
    const indexRows = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all();
    const tables = new Set(tableRows.map(r => String(r.name).toLowerCase()));
    const indexes = new Set(indexRows.map(r => String(r.name).toLowerCase()));
    for (const ix of KB_INDEXES) {
      if (indexes.has(ix.name.toLowerCase())) { result.present.push(ix.name); continue; }
      if (!tables.has(ix.table.toLowerCase())) { result.skipped.push(ix.name); continue; }
      if (ix.column) {
        /** @type {any[]} */
        const colRows = db.prepare(`PRAGMA table_info(${ix.table})`).all();
        const cols = colRows.map(c => String(c.name).toLowerCase());
        if (!cols.includes(ix.column.toLowerCase())) { result.skipped.push(ix.name); continue; }
      }
      try {
        db.exec(ix.sql);
        result.created.push(ix.name);
        log(`kb DB: created ${ix.name} (${ix.why})`);
      } catch (err) {
        // Read-only file or locked writer: the tool still works, just slower.
        result.skipped.push(ix.name);
        log(`kb DB: could not create ${ix.name}: ${err.message}`);
      }
    }
  } catch (err) {
    log(`kb DB: index check skipped: ${err.message}`);
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
  result.ms = Date.now() - t0;
  return result;
}
