/**
 * kb-indexes.js (#125): the KB self-heal index pass — creates what is missing,
 * skips what the snapshot cannot carry, is idempotent, and mirrors build-kb.js.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { KB_INDEXES, ensureKbIndexes } from '../src/azure/kb-indexes.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const here = dirname(fileURLToPath(import.meta.url));

function tempDb(ddl) {
  const dir = mkdtempSync(join(tmpdir(), 'kbidx-'));
  const path = join(dir, 'kb.sqlite');
  const db = new Database(path);
  db.exec(ddl);
  db.close();
  return { dir, path };
}

test('ensureKbIndexes creates the methods index on a pre-#125 snapshot and skips tables the snapshot lacks', () => {
  const { dir, path } = tempDb(`CREATE TABLE methods (owner_type TEXT, owner_name TEXT, method_name TEXT, signature TEXT, is_static INTEGER, source_code TEXT);
                              CREATE TABLE forms (form_name TEXT PRIMARY KEY, module_id TEXT);`);
  try {
    const r = ensureKbIndexes(path);
    assert.deepEqual(r.created, ['idx_methods_name_nocase']);
    // form_controls / objects_meta absent; forms has no `pattern` column → skipped, not thrown
    assert.ok(r.skipped.includes('idx_form_controls_form'));
    assert.ok(r.skipped.includes('idx_forms_pattern'));
    assert.ok(r.skipped.includes('idx_objects_meta_name'));
    const again = ensureKbIndexes(path);
    assert.deepEqual(again.created, [], 'idempotent');
    assert.ok(again.present.includes('idx_methods_name_nocase'));
    const db = new Database(path, { readonly: true });
    const plan = db.prepare("EXPLAIN QUERY PLAN SELECT owner_name FROM methods WHERE method_name = ? COLLATE NOCASE").all('x').map(r => r.detail).join(' ');
    db.close();
    assert.match(plan, /idx_methods_name_nocase/, 'the equality lookup uses the NOCASE index');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('ensureKbIndexes creates every index on a schema-1.2 snapshot', () => {
  const { dir, path } = tempDb(`CREATE TABLE methods (owner_type TEXT, owner_name TEXT, method_name TEXT);
    CREATE TABLE forms (form_name TEXT PRIMARY KEY, pattern TEXT);
    CREATE TABLE form_controls (form_name TEXT, control_name TEXT, data_source TEXT, data_field TEXT);
    CREATE TABLE objects_meta (object_type TEXT, object_name TEXT);`);
  try {
    const r = ensureKbIndexes(path);
    assert.deepEqual([...r.created].sort(), KB_INDEXES.map(i => i.name).sort());
    assert.deepEqual(r.skipped, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('ensureKbIndexes on a missing file is a no-op, never a throw', () => {
  const r = ensureKbIndexes(join(tmpdir(), 'definitely-not-here-kb.sqlite'));
  assert.deepEqual(r, { created: [], skipped: [], present: [], ms: r.ms });
});

test('every KB_INDEXES statement is also in build/build-kb.js (fresh builds and self-heal agree)', () => {
  const src = readFileSync(join(here, '..', 'build', 'build-kb.js'), 'utf8');
  for (const ix of KB_INDEXES) {
    assert.ok(src.includes(`CREATE INDEX IF NOT EXISTS ${ix.name} `), `build-kb.js lacks ${ix.name}`);
  }
});
