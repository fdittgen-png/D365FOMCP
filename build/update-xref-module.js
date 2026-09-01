/**
 * update-xref-module.js — refresh ONE OR MORE modules in the XRef SQLite
 * without rebuilding the other 6.1M names.
 *
 * `npm run build:xref` is a full dump: 6,151,273 names and 27,989,546
 * references, 18-60 minutes. That is the right shape after a platform update and
 * the wrong shape after a developer compiles iExtension. Measured on the
 * reference box, one model is a rounding error of the database:
 *
 *     iExtension   37,466 names   50,723 outbound refs   0 inbound from elsewhere
 *     HISOL        19,479 names   43,035 outbound refs  45 inbound from elsewhere
 *     ------------------------------------------------  0.93% of names, 0.34% of refs
 *
 * WHY DELETE-AND-REINSERT IS SAFE. The obvious objection is that dropping a
 * module's names orphans every reference pointing INTO it. Two facts defuse it:
 *
 *   1. `Names` in the SQL source has a UNIQUE index on (Path, ModuleId). The
 *      compiler upserts by path, so an object that survives a recompile keeps
 *      its identity value. Only genuinely new objects get new ids.
 *   2. Microsoft code does not reference custom code. Inbound references are 0
 *      for iExtension and 45 for HISOL; refreshing both in one call resolves
 *      even those.
 *
 * Neither fact is assumed: `assertNoOrphans()` runs inside the transaction and
 * rolls the whole thing back if a single reference lost its target. A stale
 * cross-reference graph is recoverable; a silently corrupted one is not.
 *
 * References are scoped by SOURCE only. A reference whose source lives in
 * another module is that module's row to own, and rewriting it here would delete
 * data this call has no fresh copy of.
 *
 * Usage:
 *   node build/update-xref-module.js iExtension HISOL
 *   node build/update-xref-module.js --all-custom          (every non-Microsoft module present)
 *   node build/update-xref-module.js iExtension --dry-run  (report the delta, write nothing)
 *
 * Environment (CLI flags win):
 *   XREF_DATABASE   cross-reference DB name  — REQUIRED, and it must be the
 *                   CURRENT one. Six XRef_* databases from past platform
 *                   versions sit in LocalDB; refreshing from a stale one
 *                   silently rewrites a module with two-versions-old data.
 *                   `Refresh-McpData.ps1` reads it from the active XPP
 *                   configuration and passes --database, which is the
 *                   supported path. Bare `.env` use is for manual runs.
 *   XREF_SERVER     default (LocalDB)\MSSQLLocalDB
 *   XREF_DB_PATH    output SQLite (default ~/.claude/d365fo_xref.sqlite)
 */

import { join } from 'path';
import { existsSync } from 'fs';
import { createRequire } from 'module';
import { openXrefSource } from './xref-source.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const DEFAULT_INSTANCE = String.raw`(LocalDB)\MSSQLLocalDB`;

/** Tracks what each module looked like at its last successful refresh. */
export const MODULE_SYNC_SCHEMA = `CREATE TABLE IF NOT EXISTS xref_module_sync (
  module TEXT PRIMARY KEY,
  module_id INTEGER,
  name_count INTEGER,
  ref_count INTEGER,
  fingerprint TEXT,
  synced_at TEXT
)`;

function log(msg) {
  process.stdout.write(`[${new Date().toISOString().slice(11, 19)}] ${msg}\n`);
}

/* ── Fingerprint ──────────────────────────────────────────────────────────────
 * Cheap enough to run on every trigger, specific enough that a recompile that
 * changed nothing is detectable. CHECKSUM_AGG alone would miss a pure rename
 * (ids unchanged); the row count alone would miss an equal-sized swap. Together
 * they are good enough to skip work, and never the thing that decides
 * correctness — a false "unchanged" costs one stale module until the next
 * compile, not a broken database.
 */
export function fingerprintOf(row) {
  if (!row) return null;
  return `${row.name_count ?? 0}:${row.checksum ?? 0}`;
}

export async function readModuleFingerprint(source, moduleName) {
  const rows = await source.query(
    `SET NOCOUNT ON; SELECT m.Id AS module_id, COUNT_BIG(n.Id) AS name_count,
            ISNULL(CHECKSUM_AGG(n.Id), 0) AS checksum
       FROM Modules m LEFT JOIN Names n ON n.ModuleId = m.Id
      WHERE m.Module = '${moduleName.replace(/'/g, "''")}'
      GROUP BY m.Id`,
    ['module_id', 'name_count', 'checksum'],
  );
  if (!rows.length) return null;
  const r = rows[0];
  return {
    module_id: Number(r.module_id),
    name_count: Number(r.name_count),
    checksum: String(r.checksum),
  };
}

/* ── Integrity gate ───────────────────────────────────────────────────────── */

/**
 * Every reference must still resolve to a name on both ends. Runs INSIDE the
 * transaction: a non-zero count throws, better-sqlite3 rolls back, and the
 * caller falls back to a full rebuild. Scoped to the refs we just touched plus
 * anything pointing at the module, so it stays a bounded query on a 28M-row
 * table rather than a full scan.
 */
export function assertNoOrphans(db, moduleIds) {
  const placeholders = moduleIds.map(() => '?').join(',');
  const orphans = db.prepare(
    `SELECT COUNT(*) AS n FROM refs r
      WHERE (r.source_id IN (SELECT id FROM names WHERE module_id IN (${placeholders}))
         OR  r.target_id IN (SELECT id FROM names WHERE module_id IN (${placeholders})))
        AND (NOT EXISTS (SELECT 1 FROM names n WHERE n.id = r.source_id)
          OR NOT EXISTS (SELECT 1 FROM names n WHERE n.id = r.target_id))`,
  ).get(...moduleIds, ...moduleIds).n;

  // Inbound references from OTHER modules whose target we just replaced. These
  // are the 45 HISOL rows the header describes; they only break if a custom
  // object was deleted and re-created with a fresh identity value.
  const dangling = db.prepare(
    `SELECT COUNT(*) AS n FROM refs r
      WHERE NOT EXISTS (SELECT 1 FROM names n WHERE n.id = r.target_id)`,
  ).get().n;

  if (orphans > 0 || dangling > 0) {
    throw new Error(
      `Orphaned references after the delta (${orphans} in scope, ${dangling} total dangling targets). `
      + 'Rolled back — an object was almost certainly deleted and re-created with a new id. '
      + 'Run a full `npm run build:xref` to resynchronise.',
    );
  }
}

/* ── The delta ────────────────────────────────────────────────────────────── */

export async function updateXrefModules({
  modules,
  dbPath,
  serverInstance = DEFAULT_INSTANCE,
  database,
  dryRun = false,
  force = false,
  logger = log,
  // Test seam: an object with the same shape openXrefSource() returns. Lets the
  // delta and its rollback be exercised against a synthetic source without a
  // SQL Server on the machine running the suite.
  source: injectedSource = null,
} = {}) {
  if (!existsSync(dbPath)) {
    throw new Error(`XRef SQLite not found: ${dbPath}. Run a full \`npm run build:xref\` first — the delta refreshes an existing database, it does not create one.`);
  }

  const source = injectedSource || await openXrefSource({ serverInstance, database, log: logger });
  const db = new Database(dbPath);
  const summary = { database, modules: [], skipped: [], missing: [], dryRun };

  try {
    // DELETE journalling, not OFF: the whole design rests on being able to roll
    // this transaction back when the orphan gate fires.
    db.pragma('journal_mode = DELETE');
    db.pragma('synchronous = NORMAL');
    db.exec(MODULE_SYNC_SCHEMA);

    const wanted = modules.includes('--all-custom')
      ? db.prepare(`SELECT module FROM xref_module_sync ORDER BY module`).all().map(r => r.module)
      : modules;
    if (!wanted.length) throw new Error('No modules named, and xref_module_sync is empty — name the modules explicitly on the first run.');

    // ── Plan: what actually changed ──────────────────────────────────────────
    const plan = [];
    const readSync = db.prepare('SELECT * FROM xref_module_sync WHERE module = ? COLLATE NOCASE');
    for (const name of wanted) {
      const fp = await readModuleFingerprint(source, name);
      if (!fp) {
        logger(`  ${name}: not present in ${database} — skipped (compile it with cross-references first)`);
        summary.missing.push(name);
        continue;
      }
      const previous = readSync.get(name);
      const current = fingerprintOf(fp);
      if (!force && previous && previous.fingerprint === current) {
        logger(`  ${name}: unchanged (${fp.name_count.toLocaleString()} names) — skipped`);
        summary.skipped.push(name);
        continue;
      }
      plan.push({ name, ...fp, fingerprint: current });
    }

    if (!plan.length) {
      logger('Nothing to do.');
      return summary;
    }

    // ── Pull ─────────────────────────────────────────────────────────────────
    // Outside the transaction: the network round-trip is the slow part and there
    // is no reason to hold a write lock on a 3.5 GB file while it runs.
    for (const m of plan) {
      logger(`  ${m.name}: pulling ${m.name_count.toLocaleString()} names...`);
      m.names = await source.query(
        `SET NOCOUNT ON; SELECT Id, Path, ProviderId, ModuleId FROM Names WHERE ModuleId = ${m.module_id}`,
        ['Id', 'Path', 'ProviderId', 'ModuleId'],
      );
      m.refs = await source.query(
        `SET NOCOUNT ON; SELECT r.SourceId, r.TargetId, r.Kind, r.Line, r.[Column]
           FROM [References] r
          WHERE r.SourceId IN (SELECT Id FROM Names WHERE ModuleId = ${m.module_id})`,
        ['SourceId', 'TargetId', 'Kind', 'Line', 'Column'],
      );
      logger(`  ${m.name}: ${m.names.length.toLocaleString()} names, ${m.refs.length.toLocaleString()} outbound refs`);
    }

    // Providers and modules can both gain rows when a model is compiled for the
    // first time; without this the name inserts below reference nothing.
    const providers = await source.query('SET NOCOUNT ON; SELECT Id, Provider FROM Providers', ['Id', 'Provider']);
    const moduleRows = await source.query('SET NOCOUNT ON; SELECT Id, Module FROM Modules', ['Id', 'Module']);

    if (dryRun) {
      for (const m of plan) {
        summary.modules.push({ module: m.name, module_id: m.module_id, names: m.names.length, refs: m.refs.length, applied: false });
        logger(`  [dry-run] ${m.name}: would replace ${m.names.length.toLocaleString()} names / ${m.refs.length.toLocaleString()} refs`);
      }
      return summary;
    }

    // ── Apply ────────────────────────────────────────────────────────────────
    const upsertProvider = db.prepare('INSERT OR REPLACE INTO providers (id, provider) VALUES (?, ?)');
    const upsertModule = db.prepare('INSERT OR REPLACE INTO modules (id, module) VALUES (?, ?)');
    const delRefs = db.prepare('DELETE FROM refs WHERE source_id IN (SELECT id FROM names WHERE module_id = ?)');
    const delNames = db.prepare('DELETE FROM names WHERE module_id = ?');
    const insName = db.prepare('INSERT INTO names (id, path, provider_id, module_id) VALUES (?, ?, ?, ?)');
    const insRef = db.prepare('INSERT INTO refs (source_id, target_id, kind, line, col) VALUES (?, ?, ?, ?, ?)');
    const upsertSync = db.prepare(
      `INSERT OR REPLACE INTO xref_module_sync (module, module_id, name_count, ref_count, fingerprint, synced_at)
       VALUES (?, ?, ?, ?, ?, ?)`);
    const setMeta = db.prepare('INSERT OR REPLACE INTO xref_metadata (key, value) VALUES (?, ?)');

    const apply = db.transaction(() => {
      for (const p of providers) upsertProvider.run(Number(p.Id), p.Provider);
      for (const m of moduleRows) upsertModule.run(Number(m.Id), m.Module);

      for (const m of plan) {
        const removedRefs = delRefs.run(m.module_id).changes;
        const removedNames = delNames.run(m.module_id).changes;
        for (const n of m.names) insName.run(Number(n.Id), n.Path, Number(n.ProviderId), Number(n.ModuleId));
        for (const r of m.refs) {
          insRef.run(
            Number(r.SourceId), Number(r.TargetId), Number(r.Kind),
            r.Line == null ? null : Number(r.Line),
            r.Column == null ? null : Number(r.Column),
          );
        }
        upsertSync.run(m.name, m.module_id, m.names.length, m.refs.length, m.fingerprint, new Date().toISOString());
        summary.modules.push({
          module: m.name, module_id: m.module_id,
          names: m.names.length, refs: m.refs.length,
          removed_names: removedNames, removed_refs: removedRefs,
          applied: true,
        });
      }

      assertNoOrphans(db, plan.map(m => m.module_id));

      // The freshness banner must move, or a caller cannot tell a refreshed
      // snapshot from a stale one. name_count/ref_count are re-derived rather
      // than adjusted, so they cannot drift away from the table contents.
      const now = new Date().toISOString();
      setMeta.run('build_date', now);
      setMeta.run('last_module_delta', now);
      setMeta.run('last_module_delta_modules', plan.map(m => m.name).join(','));
      setMeta.run('name_count', String(db.prepare('SELECT COUNT(*) AS n FROM names').get().n));
      setMeta.run('ref_count', String(db.prepare('SELECT COUNT(*) AS n FROM refs').get().n));
    });

    apply();
    for (const m of summary.modules) {
      logger(`  ${m.module}: ${m.removed_names.toLocaleString()} -> ${m.names.toLocaleString()} names, `
        + `${m.removed_refs.toLocaleString()} -> ${m.refs.toLocaleString()} refs`);
    }
    logger(`Delta applied to ${dbPath}`);
    return summary;
  } finally {
    db.close();
    await source.close();
  }
}

/* ── CLI ──────────────────────────────────────────────────────────────────── */

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());

if (isMain) {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const hit = argv.find(a => a === `--${name}` || a.startsWith(`--${name}=`));
    if (!hit) return undefined;
    return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : true;
  };
  const modules = argv.filter(a => !a.startsWith('--') || a === '--all-custom');

  const opts = {
    modules,
    dbPath: flag('db') || process.env.XREF_DB_PATH
      || join(process.env.USERPROFILE || process.env.HOME || '.', '.claude', 'd365fo_xref.sqlite'),
    serverInstance: flag('server') || process.env.XREF_SERVER || DEFAULT_INSTANCE,
    database: flag('database') || process.env.XREF_DATABASE || '',
    dryRun: flag('dry-run') === true,
    force: flag('force') === true,
  };

  if (!modules.length) {
    console.error('Usage: node build/update-xref-module.js <Module> [Module...] [--database=<XRef_db>] [--db=<sqlite>] [--dry-run] [--force]');
    process.exit(2);
  }
  if (!opts.database) {
    console.error('ERROR: no cross-reference database. Pass --database=<name> or set XREF_DATABASE.');
    console.error('       Read the CURRENT name from Visual Studio > Dynamics 365 > Manage local XPP configurations —');
    console.error('       several XRef_* databases from earlier platform versions sit in LocalDB and look equally valid.');
    process.exit(2);
  }

  log(`XRef module delta -> ${opts.dbPath}`);
  log(`Source: ${opts.serverInstance} / ${opts.database}`);
  updateXrefModules(opts)
    .then((s) => {
      const applied = s.modules.filter(m => m.applied).length;
      log(`Done. ${applied} module(s) refreshed, ${s.skipped.length} unchanged, ${s.missing.length} not in source.`);
      process.exit(0);
    })
    .catch((err) => {
      console.error(`FAILED: ${err.message}`);
      process.exit(1);
    });
}
