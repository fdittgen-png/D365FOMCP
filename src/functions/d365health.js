/**
 * Azure Function: /api/health — admin dashboard backend.
 *
 * Returns DB-level health metadata for each of the three SQLite databases
 * (KB, XRef, Security). Used by the admin HTML pages in `www/`.
 *
 * Authentication: Easy Auth required (fail-closed via decideAdminAccess).
 * Privacy: emits service NAME only, never the on-disk file path. Sizes
 * are bytes; record counts come from the *_metadata tables, never a
 * full COUNT(*) on row tables (the xref DB has multi-billion-row tables).
 *
 * Response shape:
 *   {
 *     server_time: "<ISO>",
 *     databases: [
 *       {
 *         name: "kb" | "xref" | "sec",
 *         healthy: boolean,
 *         size_bytes: number | null,
 *         record_count: number | null,
 *         last_modified: "<ISO>" | null,
 *         note: string | undefined        // present when healthy === false
 *       }, ...
 *     ]
 *   }
 */

import { app } from '@azure/functions';
import { statSync } from 'fs';
import { getKbDb, getXrefDb, getSecDb, query } from '../azure/shared.js';
import { decideAdminAccess, getAuthUser, isEasyAuthEnabled } from '../azure/admin-auth.js';

// ── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * Service name → metadata table name. The build scripts use `<service>_metadata`
 * for KB / XRef / Security databases (see build/build-kb.js, build-xref-db.js,
 * sec-builder.js).
 */
const META_TABLE = {
  kb: 'kb_metadata',
  xref: 'xref_metadata',
  sec: 'sec_metadata',
};

/**
 * The metadata `key` whose value, summed across all metadata rows, gives a
 * representative record count for the service. We pick the largest "real" entity
 * that's already cached in metadata — no full-table scans.
 */
const RECORD_COUNT_KEYS = {
  kb: ['tables', 'records', 'row_count'],
  xref: ['references', 'objects', 'records', 'row_count'],
  sec: ['privileges', 'roles', 'records', 'row_count'],
};

/**
 * Read the `build_date` value from a service metadata table.
 * Returns ISO string or null. Pure(-ish): uses an injected `runQuery` so
 * this is testable without a real DB.
 */
export function readBuildDate(runQuery, table) {
  try {
    const rows = runQuery(`SELECT value FROM ${table} WHERE key = 'build_date' LIMIT 1`);
    return rows?.[0]?.value || null;
  } catch {
    return null;
  }
}

/**
 * Read a representative record count from the metadata table — never via
 * COUNT(*) on a base table (the xref DB has tables with > 100M rows).
 * Returns the first numeric value found among the candidate keys, or null.
 */
export function readRecordCount(runQuery, table, candidateKeys) {
  try {
    for (const key of candidateKeys) {
      const rows = runQuery(`SELECT value FROM ${table} WHERE key = ? LIMIT 1`, [key]);
      const v = rows?.[0]?.value;
      if (v == null || v === '') continue;
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * stat() the on-disk file. Returns `{ size_bytes, mtime_iso }` or null on
 * failure. We deliberately do NOT include `dbPath` in the return — callers
 * must not expose paths to the UI (privacy / attack-surface reduction).
 */
export function safeStat(statFn, dbPath) {
  try {
    const s = statFn(dbPath);
    return {
      size_bytes: s.size,
      mtime_iso: new Date(s.mtimeMs).toISOString(),
    };
  } catch {
    return null;
  }
}

/**
 * Build one entry of the `databases[]` array from injectable IO. Pure logic —
 * the unit tests pass fakes for `getDb`, `runQuery`, and `statFn`.
 */
export function inspectDatabase({ name, dbPath, getDb, statFn = statSync }) {
  const stats = dbPath ? safeStat(statFn, dbPath) : null;

  let recordCount = null;
  let buildDate = null;
  let healthy = false;

  try {
    const db = getDb();
    const runQuery = (sql, params) => query(db, sql, params);
    buildDate = readBuildDate(runQuery, META_TABLE[name]);
    recordCount = readRecordCount(runQuery, META_TABLE[name], RECORD_COUNT_KEYS[name]);
    healthy = stats != null && buildDate != null;
  } catch {
    healthy = false;
  }

  const entry = {
    name,
    healthy,
    size_bytes: stats?.size_bytes ?? null,
    record_count: recordCount,
    last_modified: buildDate || stats?.mtime_iso || null,
  };
  if (!healthy) entry.note = 'Database not available.';
  return entry;
}

/** Build the full /api/health response body. */
export function buildHealthReport({ env = process.env, getDbs, statFn = statSync, now = () => new Date() } = {}) {
  const dbs = getDbs ?? {
    kb: getKbDb,
    xref: getXrefDb,
    sec: getSecDb,
  };
  const databases = [
    inspectDatabase({
      name: 'kb',
      dbPath: env.KB_DB_PATH || '/home/data/d365fo_kb.sqlite',
      getDb: dbs.kb,
      statFn,
    }),
    inspectDatabase({
      name: 'xref',
      dbPath: env.XREF_DB_PATH || '/home/data/d365fo_xref.sqlite',
      getDb: dbs.xref,
      statFn,
    }),
    inspectDatabase({
      name: 'sec',
      dbPath: env.SEC_DB_PATH || '/home/data/d365fo_sec.sqlite',
      getDb: dbs.sec,
      statFn,
    }),
  ];
  return {
    server_time: now().toISOString(),
    databases,
  };
}

// ── Azure Function ──────────────────────────────────────────────────────────

app.http('d365health', {
  methods: ['GET'],
  route: 'health',
  authLevel: 'anonymous',
  handler: async (request, context) => {
    const user = getAuthUser(request);
    const easyAuth = isEasyAuthEnabled();

    // Fail-closed gate: Easy Auth on + no principal → 401.
    const rejection = decideAdminAccess({ user, easyAuth, wantsHtml: false, redirectTarget: '/api/health' });
    if (rejection) return rejection;

    try {
      const report = buildHealthReport();
      return {
        status: 200,
        headers: { 'Cache-Control': 'no-store' },
        jsonBody: report,
      };
    } catch (err) {
      context.error('d365health error:', err);
      return {
        status: 500,
        jsonBody: { error: 'Internal error building health report.' },
      };
    }
  },
});
