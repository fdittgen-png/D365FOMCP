/**
 * Add performance indexes to the existing sec database.
 * Index definitions live in src/azure/sec-indexes.js (shared with the Azure
 * self-healing path in src/azure/shared.js getSecDb()).
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
import { SEC_INDEXES as indexes } from '../src/azure/sec-indexes.js';
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
