/**
 * Add performance indexes to the existing sec database.
 * Safe to run multiple times (uses IF NOT EXISTS).
 *
 * Usage:
 *   node build/add-sec-indexes.js [dbPath]
 *
 * Default dbPath: /home/data/d365fo_sec.sqlite (Azure) or %USERPROFILE%/.claude/d365fo_sec.sqlite
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbPath = process.argv[2] || (
  process.platform === 'linux'
    ? '/home/data/d365fo_sec.sqlite'
    : path.join(process.env.USERPROFILE || process.env.HOME, '.claude', 'd365fo_sec.sqlite')
);

if (!fs.existsSync(dbPath)) {
  console.error(`Database not found: ${dbPath}`);
  process.exit(1);
}

console.log(`Opening: ${dbPath}`);
const fileSize = (fs.statSync(dbPath).size / (1024 * 1024)).toFixed(1);
console.log(`Size: ${fileSize} MB`);

const db = new Database(dbPath);
db.pragma('journal_mode = DELETE');
db.pragma('synchronous = NORMAL');

// All indexes designed to speed up the most common sec-tools.js queries.
// Each carries a brief justification.
const indexes = [
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
];

console.log(`\nCreating ${indexes.length} indexes...`);
const t0 = Date.now();

for (const ix of indexes) {
  const exists = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='index' AND name=?`).get(ix.name);
  if (exists) {
    console.log(`  [skip] ${ix.name} (already exists)`);
    continue;
  }
  const t1 = Date.now();
  process.stdout.write(`  [creating] ${ix.name} ...`);
  db.exec(ix.sql);
  const dt = ((Date.now() - t1) / 1000).toFixed(1);
  console.log(` done in ${dt}s — ${ix.why}`);
}

console.log(`\nRunning ANALYZE so the query planner has fresh stats...`);
const ta = Date.now();
db.exec('ANALYZE');
console.log(`  done in ${((Date.now() - ta) / 1000).toFixed(1)}s`);

const totalTime = ((Date.now() - t0) / 1000).toFixed(1);
const newSize = (fs.statSync(dbPath).size / (1024 * 1024)).toFixed(1);
console.log(`\nTotal: ${totalTime}s  |  Size: ${fileSize} MB → ${newSize} MB`);

// Show all indexes for verification
const allIdx = db.prepare(`SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY tbl_name, name`).all();
console.log(`\nAll indexes (${allIdx.length}):`);
for (const i of allIdx) console.log(`  ${i.tbl_name.padEnd(35)} ${i.name}`);

db.close();
console.log('\nDone.');
