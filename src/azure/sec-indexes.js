/**
 * Performance indexes for the Security DB — single source of truth.
 *
 * Consumed by:
 *   - build/add-sec-indexes.js   one-off migration for an existing DB file
 *   - src/azure/shared.js        ensureSecIndexes() at first request on Azure,
 *                                so a code deploy alone brings /home/data up to date
 *   - test/sec-join-collation.test.js  every COLLATE NOCASE join predicate in
 *                                sec-tools.js must be backed by one of these
 *
 * src/azure/sec-builder.js carries the same CREATE INDEX statements inline
 * for fresh builds (the test keeps both lists in sync).
 *
 * Why NOCASE indexes matter here: better-sqlite3 is synchronous and the Azure
 * Function App has one Node worker, so a single un-indexed join
 * (privilege_entry_points 41k × duty_privileges 27k) blocks EVERY MCP endpoint
 * on the host for >90 s. Seen 2026-08-25.
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

export const SEC_INDEXES = [
  // ── NOCASE indexes for case-insensitive lookups (used everywhere) ──────────
  {
    name: 'idx_roles_name_nocase',
    sql: `CREATE INDEX IF NOT EXISTS idx_roles_name_nocase ON roles(role_name COLLATE NOCASE)`,
    why: 'sec_lookup_role / WHERE role_name = ? COLLATE NOCASE',
  },
  {
    name: 'idx_duties_id_nocase',
    sql: `CREATE INDEX IF NOT EXISTS idx_duties_id_nocase ON duties(duty_id COLLATE NOCASE)`,
    why: 'sec_lookup_duty / case-insensitive joins on duty_id',
  },
  {
    name: 'idx_duties_name_nocase',
    sql: `CREATE INDEX IF NOT EXISTS idx_duties_name_nocase ON duties(duty_name COLLATE NOCASE)`,
    why: 'sec_lookup_duty WHERE duty_name = ?',
  },
  {
    name: 'idx_privs_name_nocase',
    sql: `CREATE INDEX IF NOT EXISTS idx_privs_name_nocase ON privileges(privilege_name COLLATE NOCASE)`,
    why: 'sec_lookup_privilege WHERE privilege_name = ?',
  },
  {
    name: 'idx_users_id_nocase',
    sql: `CREATE INDEX IF NOT EXISTS idx_users_id_nocase ON users(user_id COLLATE NOCASE)`,
    why: 'sec_lookup_user / partial-match user lookups',
  },
  {
    name: 'idx_users_email_nocase',
    sql: `CREATE INDEX IF NOT EXISTS idx_users_email_nocase ON users(email COLLATE NOCASE)`,
    why: 'user lookup by email',
  },
  {
    name: 'idx_users_person_nocase',
    sql: `CREATE INDEX IF NOT EXISTS idx_users_person_nocase ON users(person_name COLLATE NOCASE)`,
    why: 'sec_lookup_user fuzzy match on person_name',
  },

  // ── Covering composite for the 34M-row duty_privileges join ────────────────
  {
    name: 'idx_dp_priv_duty',
    sql: `CREATE INDEX IF NOT EXISTS idx_dp_priv_duty ON duty_privileges(privilege_name, duty_id)`,
    why: 'Covering index for "find duties granting privilege X" + reverse joins. The biggest perf win for the slow chain queries.',
  },

  // ── role_direct_privileges reverse lookup ──────────────────────────────────
  {
    name: 'idx_rdp_priv',
    sql: `CREATE INDEX IF NOT EXISTS idx_rdp_priv ON role_direct_privileges(privilege_name)`,
    why: 'sec_find_roles_by_privilege direct-priv branch',
  },

  // ── role_direct_entity_permissions reverse lookup ──────────────────────────
  {
    name: 'idx_rdep_role',
    sql: `CREATE INDEX IF NOT EXISTS idx_rdep_role ON role_direct_entity_permissions(role_id)`,
    why: 'sec_lookup_role / sec_effective_permissions',
  },

  // ── user_role_companies reverse lookups ────────────────────────────────────
  {
    name: 'idx_urc_role_id',
    sql: `CREATE INDEX IF NOT EXISTS idx_urc_role_id ON user_role_companies(role_id)`,
    why: 'sec_find_users_by_role with company filter',
  },

  // ── privilege_entry_points object_name with case-insensitive ───────────────
  {
    name: 'idx_ep_object_nocase',
    sql: `CREATE INDEX IF NOT EXISTS idx_ep_object_nocase ON privilege_entry_points(object_name COLLATE NOCASE)`,
    why: 'sec_permission_trace object filter',
  },

  // ── role_subroles parent for hierarchy traversal ───────────────────────────
  {
    name: 'idx_subroles_parent',
    sql: `CREATE INDEX IF NOT EXISTS idx_subroles_parent ON role_subroles(parent_role_id)`,
    why: 'sec_role_hierarchy walking down (children of a role)',
  },

  // ── search content (for sec_search LIKE queries) ───────────────────────────
  {
    name: 'idx_sec_search_content_nocase',
    sql: `CREATE INDEX IF NOT EXISTS idx_sec_search_content_nocase ON sec_search(content COLLATE NOCASE)`,
    why: 'sec_search LIKE ?',
  },
  // ── NOCASE indexes on JOIN columns (2026-08-25) ──────────────────────────
  // Every `a.col = b.col COLLATE NOCASE` join predicate in sec-tools.js needs a
  // NOCASE-collated index on at least one side or SQLite cannot use ANY index
  // for it. test/sec-join-collation.test.js enforces the pairing.
  {
    name: 'idx_dp_priv_nocase',
    sql: `CREATE INDEX IF NOT EXISTS idx_dp_priv_nocase ON duty_privileges(privilege_name COLLATE NOCASE, duty_id)`,
    why: 'sec_object_access / effective_permissions join dp.privilege_name = ep.privilege_name COLLATE NOCASE — without a NOCASE index SQLite nested-loop-scans 41k×27k rows (>90 s per call, blocks the whole stdio server)',
  },
  {
    name: 'idx_dp_duty_nocase',
    sql: `CREATE INDEX IF NOT EXISTS idx_dp_duty_nocase ON duty_privileges(duty_id COLLATE NOCASE, privilege_name)`,
    why: 'join rd.duty_id = dp.duty_id COLLATE NOCASE (role→duty→privilege walk)',
  },
  {
    name: 'idx_rd_duty_nocase',
    sql: `CREATE INDEX IF NOT EXISTS idx_rd_duty_nocase ON role_duties(duty_id COLLATE NOCASE, role_id)`,
    why: 'reverse walk privilege→duty→role with NOCASE duty ids (DMF upper-case vs AOT mixed-case)',
  },
  {
    name: 'idx_rd_role_nocase',
    sql: `CREATE INDEX IF NOT EXISTS idx_rd_role_nocase ON role_duties(role_id COLLATE NOCASE, duty_id)`,
    why: 'role_id joins written with COLLATE NOCASE in sec_role_hierarchy / lookup_role',
  },
  {
    name: 'idx_rdp_priv_nocase',
    sql: `CREATE INDEX IF NOT EXISTS idx_rdp_priv_nocase ON role_direct_privileges(privilege_name COLLATE NOCASE, role_id)`,
    why: 'direct-privilege branch of sec_object_access / effective_permissions',
  },
  {
    name: 'idx_ep_priv_nocase',
    sql: `CREATE INDEX IF NOT EXISTS idx_ep_priv_nocase ON privilege_entry_points(privilege_name COLLATE NOCASE)`,
    why: 'ep.privilege_name = dp.privilege_name COLLATE NOCASE (privilege→entry points)',
  },
  {
    name: 'idx_roles_id_nocase',
    sql: `CREATE INDEX IF NOT EXISTS idx_roles_id_nocase ON roles(role_id COLLATE NOCASE)`,
    why: 'roles joined on role_id COLLATE NOCASE from user_roles / user_role_companies / role_duties',
  },
  {
    name: 'idx_ur_role_nocase',
    sql: `CREATE INDEX IF NOT EXISTS idx_ur_role_nocase ON user_roles(role_id COLLATE NOCASE)`,
    why: 'sec_find_users_by_role / lookup_user role joins',
  },
  {
    name: 'idx_urc_role_nocase',
    sql: `CREATE INDEX IF NOT EXISTS idx_urc_role_nocase ON user_role_companies(role_id COLLATE NOCASE)`,
    why: 'company-scoped role joins',
  },
  {
    name: 'idx_subroles_child_nocase',
    sql: `CREATE INDEX IF NOT EXISTS idx_subroles_child_nocase ON role_subroles(child_role_id COLLATE NOCASE)`,
    why: 'recursive sub-role CTE joins',
  },
  {
    name: 'idx_subroles_parent_nocase',
    sql: `CREATE INDEX IF NOT EXISTS idx_subroles_parent_nocase ON role_subroles(parent_role_id COLLATE NOCASE)`,
    why: 'recursive sub-role CTE joins',
  },

];


/**
 * Idempotently create any missing index on the DB file at `dbPath`.
 * Opens its own read-write connection (the serving connection is read-only),
 * runs ANALYZE only when something was created, and never throws — a
 * read-only mount or a locked file yields `{ error }` and the caller keeps
 * serving with whatever indexes exist.
 *
 * @param {string} dbPath
 * @param {{ log?: (msg: string) => void }} [opts]
 * @returns {{ created: string[], present: string[], error?: string, ms: number }}
 */
export function ensureSecIndexes(dbPath, opts = {}) {
  const log = opts.log || (() => {});
  const t0 = Date.now();
  const result = { created: [], present: [], ms: 0 };
  let db = null;
  try {
    db = new Database(dbPath, { fileMustExist: true, timeout: 5000 });
    const existing = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map(r => r.name),
    );
    for (const ix of SEC_INDEXES) {
      if (existing.has(ix.name)) { result.present.push(ix.name); continue; }
      const t = Date.now();
      db.exec(ix.sql);
      result.created.push(ix.name);
      log(`sec index created: ${ix.name} (${Date.now() - t} ms) — ${ix.why}`);
    }
    if (result.created.length) db.exec('ANALYZE');
  } catch (err) {
    result.error = err && err.message ? err.message : String(err);
    log(`sec index check skipped: ${result.error}`);
  } finally {
    try { db && db.close(); } catch { /* ignore */ }
  }
  result.ms = Date.now() - t0;
  return result;
}
