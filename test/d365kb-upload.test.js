/**
 * Tests for the KB database upload validator (d365kb-upload.js).
 *
 * validateKbDatabase is the safety gate: it must accept a well-formed KB
 * database and REJECT anything else, so a broken upload never replaces the
 * live KB. We build real temp SQLite files and assert accept/reject.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const { validateKbDatabase } = await import('../src/functions/d365kb-upload.js');

let dir;
before(() => { dir = mkdtempSync(join(tmpdir(), 'kb-upload-test-')); });
after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

/** Build a KB-shaped SQLite file. opts: {tables, buildDate, custom} */
function makeKbDb(name, { tables = 1, buildDate = '2026-06-16T00:00:00.000Z', custom = false, withMeta = true } = {}) {
  const path = join(dir, name);
  const db = new Database(path);
  db.exec('CREATE TABLE kb_metadata (key TEXT PRIMARY KEY, value TEXT);');
  db.exec('CREATE TABLE tables (table_name TEXT PRIMARY KEY);');
  if (withMeta && buildDate) db.prepare('INSERT INTO kb_metadata VALUES (?,?)').run('build_date', buildDate);
  if (withMeta) {
    db.prepare('INSERT INTO kb_metadata VALUES (?,?)').run('d365fo_version', '10.0.2263.172');
    db.prepare('INSERT INTO kb_metadata VALUES (?,?)').run('has_customizations', custom ? '1' : '0');
    db.prepare('INSERT INTO kb_metadata VALUES (?,?)').run('custom_packages_paths', custom ? 'C:\\Workspace\\DEV\\Metadata' : '');
  }
  const ins = db.prepare('INSERT INTO tables VALUES (?)');
  for (let i = 0; i < tables; i++) ins.run('T' + i);
  db.close();
  // Pad the file so it clears the 1 MB sanity floor.
  const fd = require('fs').openSync(path, 'r+');
  require('fs').ftruncateSync(fd, 2 * 1024 * 1024);
  require('fs').closeSync(fd);
  return path;
}

describe('validateKbDatabase', () => {
  it('accepts a well-formed KB database and reports customization status', () => {
    const p = makeKbDb('good-custom.sqlite', { tables: 5, custom: true });
    const summary = validateKbDatabase(p);
    assert.equal(summary.tables, 5);
    assert.equal(summary.hasCustomizations, true);
    assert.equal(summary.d365foVersion, '10.0.2263.172');
    assert.ok(summary.sizeMB >= 1);
  });

  it('accepts a standard (no-customization) KB database', () => {
    const p = makeKbDb('good-plain.sqlite', { tables: 3, custom: false });
    const summary = validateKbDatabase(p);
    assert.equal(summary.hasCustomizations, false);
  });

  it('rejects a file that is not a SQLite database', () => {
    const p = join(dir, 'garbage.sqlite');
    writeFileSync(p, Buffer.alloc(2 * 1024 * 1024, 7));
    assert.throws(() => validateKbDatabase(p), /not a valid KB database|not a database|readable SQLite/i);
  });

  it('rejects a KB database with zero tables', () => {
    const p = makeKbDb('empty.sqlite', { tables: 0 });
    assert.throws(() => validateKbDatabase(p), /zero tables/i);
  });

  it('rejects a database missing kb_metadata.build_date', () => {
    const p = makeKbDb('no-builddate.sqlite', { buildDate: null });
    assert.throws(() => validateKbDatabase(p), /build_date/i);
  });

  it('rejects a missing file', () => {
    assert.throws(() => validateKbDatabase(join(dir, 'does-not-exist.sqlite')), /not found|too small|readable/i);
  });
});
