/**
 * Stream duty-privilege pairs from stdin (piped from ZIP) directly into
 * a SQLite database. Uses INSERT OR IGNORE for disk-based deduplication
 * — handles millions of pairs with constant memory.
 *
 * Usage:
 *   powershell -Command "stream zip entry to stdout" | \
 *     node build/inject-duty-privs.js <sqlitePath>
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const dbPath = process.argv[2];
if (!dbPath) { console.error('Usage: ... | node build/inject-duty-privs.js <sqlitePath>'); process.exit(1); }

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('cache_size = -200000');

const insertDutyPriv = db.prepare('INSERT OR IGNORE INTO duty_privileges (duty_id, privilege_name) VALUES (?, ?)');
const insertDuty = db.prepare('INSERT OR IGNORE INTO duties (duty_id, duty_name, module_id, description) VALUES (?, ?, NULL, NULL)');
const insertPriv = db.prepare('INSERT OR IGNORE INTO privileges (privilege_name, module_id, label) VALUES (?, NULL, ?)');

let buffer = '';
let count = 0;
let inserted = 0;
const OPEN = '<SYSTEMSECURITYDUTYENTITY>';
const CLOSE = '</SYSTEMSECURITYDUTYENTITY>';
const BATCH = 10000;
let batch = [];

function extractField(xml, tag) {
  const open = `<${tag}>`;
  const s = xml.indexOf(open);
  if (s === -1) return '';
  const vs = s + open.length;
  const e = xml.indexOf(`</${tag}>`, vs);
  return e === -1 ? '' : xml.substring(vs, e);
}

function flushBatch() {
  if (batch.length === 0) return;
  const tx = db.transaction(() => {
    for (const b of batch) {
      insertDuty.run(b.dutyId, b.dutyName);
      insertPriv.run(b.privId, b.privName);
      const r = insertDutyPriv.run(b.dutyId, b.privId);
      if (r.changes > 0) inserted++;
    }
  });
  tx();
  batch = [];
}

process.stdin.setEncoding('utf-8');

process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let pos = 0;
  while (true) {
    const start = buffer.indexOf(OPEN, pos);
    if (start === -1) break;
    const end = buffer.indexOf(CLOSE, start);
    if (end === -1) { buffer = buffer.substring(start); return; }

    const inner = buffer.substring(start + OPEN.length, end);
    const dutyId = extractField(inner, 'SECURITYDUTYIDENTIFIER');
    const privId = extractField(inner, 'SECURITYPRIVILEGEIDENTIFIER');
    if (dutyId && privId) {
      batch.push({
        dutyId, privId,
        dutyName: extractField(inner, 'SECURITYDUTYNAME'),
        privName: extractField(inner, 'SECURITYPRIVILEGENAME'),
      });
      if (batch.length >= BATCH) flushBatch();
    }
    count++;
    pos = end + CLOSE.length;
  }
  if (pos > 0) buffer = buffer.substring(pos);

  if (count % 1000000 === 0) process.stderr.write(`  ${(count/1e6).toFixed(0)}M entities processed, ${inserted} new pairs inserted\n`);
});

process.stdin.on('end', () => {
  flushBatch();

  const dpCount = db.prepare('SELECT COUNT(*) as n FROM duty_privileges').get().n;
  const dutyCount = db.prepare('SELECT COUNT(*) as n FROM duties').get().n;
  const privCount = db.prepare('SELECT COUNT(*) as n FROM privileges').get().n;

  // Update metadata
  db.prepare("INSERT OR REPLACE INTO sec_metadata VALUES ('dutyPrivileges', ?)").run(String(dpCount));
  db.prepare("INSERT OR REPLACE INTO sec_metadata VALUES ('duties', ?)").run(String(dutyCount));
  db.prepare("INSERT OR REPLACE INTO sec_metadata VALUES ('privileges', ?)").run(String(privCount));
  db.prepare("INSERT OR REPLACE INTO sec_metadata VALUES ('build_date', ?)").run(new Date().toISOString());

  db.pragma('journal_mode = DELETE');
  db.exec('VACUUM');
  db.close();

  const sizeMB = (require('fs').statSync(dbPath).size / (1024 * 1024)).toFixed(1);
  process.stderr.write(`\nDone: ${count.toLocaleString()} entities → ${inserted.toLocaleString()} new duty-privilege pairs\n`);
  process.stderr.write(`Database: ${dpCount} duty-privileges, ${dutyCount} duties, ${privCount} privileges\n`);
  process.stderr.write(`Size: ${sizeMB} MB\n`);
});
