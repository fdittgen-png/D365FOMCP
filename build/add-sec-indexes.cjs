/**
 * Add performance indexes to the existing sec database. CommonJS for Kudu execution.
 * Safe to re-run.
 */
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const dbPath = process.argv[2] || (
  process.platform === 'linux'
    ? '/home/data/d365fo_sec.sqlite'
    : path.join(process.env.USERPROFILE || process.env.HOME, '.claude', 'd365fo_sec.sqlite')
);

if (!fs.existsSync(dbPath)) {
  console.error('Database not found: ' + dbPath);
  process.exit(1);
}

console.log('Opening: ' + dbPath);
const fileSize = (fs.statSync(dbPath).size / (1024 * 1024)).toFixed(1);
console.log('Size: ' + fileSize + ' MB');

const db = new Database(dbPath);
db.pragma('journal_mode = DELETE');
db.pragma('synchronous = NORMAL');

const indexes = [
  // NOCASE indexes for case-insensitive lookups
  { name: 'idx_roles_name_nocase', sql: 'CREATE INDEX IF NOT EXISTS idx_roles_name_nocase ON roles(role_name COLLATE NOCASE)', why: 'sec_lookup_role' },
  { name: 'idx_duties_id_nocase', sql: 'CREATE INDEX IF NOT EXISTS idx_duties_id_nocase ON duties(duty_id COLLATE NOCASE)', why: 'duty case-insensitive joins' },
  { name: 'idx_duties_name_nocase', sql: 'CREATE INDEX IF NOT EXISTS idx_duties_name_nocase ON duties(duty_name COLLATE NOCASE)', why: 'sec_lookup_duty by name' },
  { name: 'idx_privs_name_nocase', sql: 'CREATE INDEX IF NOT EXISTS idx_privs_name_nocase ON privileges(privilege_name COLLATE NOCASE)', why: 'sec_lookup_privilege' },
  { name: 'idx_users_id_nocase', sql: 'CREATE INDEX IF NOT EXISTS idx_users_id_nocase ON users(user_id COLLATE NOCASE)', why: 'sec_lookup_user' },
  { name: 'idx_users_email_nocase', sql: 'CREATE INDEX IF NOT EXISTS idx_users_email_nocase ON users(email COLLATE NOCASE)', why: 'user lookup by email' },
  { name: 'idx_users_person_nocase', sql: 'CREATE INDEX IF NOT EXISTS idx_users_person_nocase ON users(person_name COLLATE NOCASE)', why: 'fuzzy person_name match' },
  // Covering composite — biggest perf win for the 34M-row joins
  { name: 'idx_dp_priv_duty', sql: 'CREATE INDEX IF NOT EXISTS idx_dp_priv_duty ON duty_privileges(privilege_name, duty_id)', why: 'covering index for find-duty-by-privilege joins' },
  // Reverse lookups
  { name: 'idx_rdp_priv', sql: 'CREATE INDEX IF NOT EXISTS idx_rdp_priv ON role_direct_privileges(privilege_name)', why: 'sec_find_roles_by_privilege' },
  { name: 'idx_rdep_role', sql: 'CREATE INDEX IF NOT EXISTS idx_rdep_role ON role_direct_entity_permissions(role_id)', why: 'sec_lookup_role direct perms' },
  { name: 'idx_urc_role_id', sql: 'CREATE INDEX IF NOT EXISTS idx_urc_role_id ON user_role_companies(role_id)', why: 'sec_find_users_by_role with company filter' },
  { name: 'idx_ep_object_nocase', sql: 'CREATE INDEX IF NOT EXISTS idx_ep_object_nocase ON privilege_entry_points(object_name COLLATE NOCASE)', why: 'sec_permission_trace object filter' },
  { name: 'idx_subroles_parent', sql: 'CREATE INDEX IF NOT EXISTS idx_subroles_parent ON role_subroles(parent_role_id)', why: 'sec_role_hierarchy children' },
  { name: 'idx_sec_search_content_nocase', sql: 'CREATE INDEX IF NOT EXISTS idx_sec_search_content_nocase ON sec_search(content COLLATE NOCASE)', why: 'sec_search LIKE' },
];

console.log('\nCreating ' + indexes.length + ' indexes...');
const t0 = Date.now();

for (const ix of indexes) {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(ix.name);
  if (exists) {
    console.log('  [skip] ' + ix.name + ' (already exists)');
    continue;
  }
  const t1 = Date.now();
  process.stdout.write('  [creating] ' + ix.name + ' ...');
  try {
    db.exec(ix.sql);
    const dt = ((Date.now() - t1) / 1000).toFixed(1);
    console.log(' done in ' + dt + 's — ' + ix.why);
  } catch (e) {
    console.log(' FAILED: ' + e.message);
  }
}

console.log('\nRunning ANALYZE...');
const ta = Date.now();
db.exec('ANALYZE');
console.log('  done in ' + ((Date.now() - ta) / 1000).toFixed(1) + 's');

const totalTime = ((Date.now() - t0) / 1000).toFixed(1);
const newSize = (fs.statSync(dbPath).size / (1024 * 1024)).toFixed(1);
console.log('\nTotal: ' + totalTime + 's  |  Size: ' + fileSize + ' MB -> ' + newSize + ' MB');

const allIdx = db.prepare("SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY tbl_name, name").all();
console.log('\nAll indexes (' + allIdx.length + '):');
for (const i of allIdx) console.log('  ' + i.tbl_name.padEnd(35) + ' ' + i.name);

db.close();
console.log('\nDone.');
