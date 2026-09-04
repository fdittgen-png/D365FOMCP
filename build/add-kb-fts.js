/**
 * Post-build FTS5 finalizer for the KB database (issue #17).
 *
 * build-kb.js constructs the KB with sql.js, whose WASM build does not
 * include the FTS5 module — so the kb_search_fts virtual table can only be
 * created once the file is on disk, by reopening it with better-sqlite3
 * (which bundles FTS5 and is the runtime driver locally and on Azure).
 *
 * build-kb.js calls ensureKbFtsIndex() automatically after saving. This
 * file is also CLI-runnable to retrofit the index onto an already-built KB
 * without redoing the full build:
 *
 *   node --env-file-if-exists=.env build/add-kb-fts.js [path\to\d365fo_kb.sqlite]
 *
 * Path resolution: CLI arg > KB_DB_PATH env var > ~/.claude/d365fo_kb.sqlite.
 */

import { createRequire } from 'module';
import { existsSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';

const require = createRequire(import.meta.url);

/**
 * Create (if needed) and rebuild the kb_search_fts index on an existing KB.
 * The table is content-external — it references kb_search via rowid, so the
 * 'rebuild' command fully re-derives it and is safe to run repeatedly.
 * @param {string} dbPath  Path to a built d365fo_kb.sqlite.
 * @returns {number} Number of rows indexed.
 */
export function ensureKbFtsIndex(dbPath) {
  const Database = require('better-sqlite3');
  const db = new Database(dbPath);
  try {
    const hasBase = db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='kb_search'`)
      .get();
    if (!hasBase) {
      throw new Error(`kb_search table missing in ${dbPath} — not a built KB database?`);
    }
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS kb_search_fts USING fts5(
      object_name, content,
      content='kb_search', content_rowid='rowid'
    )`);
    db.exec(`INSERT INTO kb_search_fts(kb_search_fts) VALUES('rebuild')`);
    return db.prepare(`SELECT COUNT(*) AS n FROM kb_search_fts`).get().n;
  } finally {
    db.close();
  }
}

/**
 * Labels v2 (#84/#127): create (if needed) and rebuild the labels_fts index —
 * reverse label search (`d365_search(object_type: 'label')`). Content-external
 * on `labels` via rowid, so 'rebuild' is idempotent. Returns 0 when the labels
 * table has no `language` column (pre-v2 snapshot: nothing to index).
 * @param {string} dbPath
 * @returns {number} rows indexed
 */
export function ensureLabelsFtsIndex(dbPath) {
  const Database = require('better-sqlite3');
  const db = new Database(dbPath);
  try {
    /** @type {any[]} */
    const colRows = db.prepare(`PRAGMA table_info(labels)`).all();
    if (!colRows.map(c => String(c.name)).includes('language')) return 0;
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS labels_fts USING fts5(
      text,
      content='labels', content_rowid='rowid'
    )`);
    db.exec(`INSERT INTO labels_fts(labels_fts) VALUES('rebuild')`);
    /** @type {any} */
    const row = db.prepare(`SELECT COUNT(*) AS n FROM labels_fts`).get();
    return Number(row.n);
  } finally {
    db.close();
  }
}

const invokedDirectly = process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const userHome = process.env.USERPROFILE || process.env.HOME;
  const dbPath = process.argv[2]
    || process.env.KB_DB_PATH
    || (userHome ? join(userHome, '.claude', 'd365fo_kb.sqlite') : './output/d365fo_kb.sqlite');

  if (!existsSync(dbPath)) {
    console.error(`KB database not found: ${dbPath}`);
    process.exit(1);
  }

  console.log(`Finalizing kb_search_fts on ${dbPath} ...`);
  const t0 = Date.now();
  try {
    const n = ensureKbFtsIndex(dbPath);
    console.log(`  kb_search_fts rebuilt: ${n} rows indexed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } catch (err) {
    console.error(`FTS finalize failed: ${err.message}`);
    process.exit(1);
  }
}
