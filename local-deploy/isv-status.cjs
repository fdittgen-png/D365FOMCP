/**
 * isv-status.cjs — report the sealed-ISV content of a KB or XRef SQLite file.
 *
 * Deploy.ps1 calls this during preflight and again after an upload, so the
 * operator can see whether the databases about to reach (or already on) Azure
 * actually carry ISV data. Without it the ISV tools deploy silently dormant:
 * they answer "no sealed-ISV data scanned", which is correct but easy to
 * mistake for "this environment has no ISVs".
 *
 * Usage:  node local-deploy/isv-status.cjs <db.sqlite> [kb|xref]
 * Output: one line of JSON on stdout. Never throws — a missing file, a
 *         pre-ISV database and a corrupt one are all reported as data.
 */

const path = require('path');
const fs = require('fs');

function out(o) {
  process.stdout.write(JSON.stringify(o) + '\n');
  process.exit(0);
}

const dbPath = process.argv[2];
const kind = (process.argv[3] || '').toLowerCase();

if (!dbPath || !fs.existsSync(dbPath)) {
  out({ present: false, reason: 'file-not-found', path: dbPath || null });
}

let Database;
try {
  Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));
} catch (err) {
  out({ present: false, reason: 'better-sqlite3-unavailable', detail: err.message });
}

let db;
try {
  db = new Database(dbPath, { readonly: true, fileMustExist: true });
} catch (err) {
  out({ present: false, reason: 'open-failed', detail: err.message });
}

try {
  const hasRegistry = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='isv_models'")
    .get();
  if (!hasRegistry) {
    out({ present: false, reason: 'no-isv-tables', path: dbPath });
  }

  const models = db.prepare('SELECT COUNT(*) c FROM isv_models').get().c;
  const scannedAt = db.prepare('SELECT MAX(scanned_at) t FROM isv_models').get().t || null;

  // Count whichever ISV tables this database is supposed to carry. A KB file
  // has no isv_refs and an XRef file has no isv_labels, so a missing table is
  // expected rather than an error — report 0 and move on.
  const count = (table) => {
    try {
      return db.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c;
    } catch {
      return 0;
    }
  };

  const counts = kind === 'xref'
    ? { refs: count('isv_refs'), names: count('isv_names'), deps: count('isv_module_deps') }
    : {
      elements: count('isv_elements'),
      labels: count('isv_labels'),
      coc: count('isv_coc'),
      events: count('isv_event_handlers'),
    };

  out({ present: true, models, scanned_at: scannedAt, counts, path: dbPath });
} catch (err) {
  out({ present: false, reason: 'query-failed', detail: err.message });
} finally {
  try { db.close(); } catch { /* already closed or never opened */ }
}
