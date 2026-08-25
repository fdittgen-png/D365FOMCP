/**
 * ensureSecIndexes() — the Azure self-healing path for Security DB indexes.
 * Works on a throwaway SQLite file with the real table shapes (no data needed):
 * first call creates every listed index, second call creates none, and an
 * unusable file yields { error } instead of throwing (the server must keep
 * serving even when /home/data is read-only or locked).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

import { SEC_INDEXES, ensureSecIndexes } from '../src/azure/sec-indexes.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const SCHEMA = `
CREATE TABLE roles (role_id TEXT PRIMARY KEY, role_name TEXT NOT NULL, module_id TEXT, label TEXT, description TEXT, license_type TEXT, permission_type TEXT);
CREATE TABLE duties (duty_id TEXT PRIMARY KEY, duty_name TEXT, module_id TEXT, label TEXT, description TEXT);
CREATE TABLE privileges (privilege_name TEXT PRIMARY KEY, module_id TEXT, label TEXT, description TEXT);
CREATE TABLE users (user_id TEXT PRIMARY KEY, person_name TEXT, email TEXT, enabled INTEGER);
CREATE TABLE role_duties (role_id TEXT NOT NULL, duty_id TEXT NOT NULL, permission_type TEXT DEFAULT 'Grant', PRIMARY KEY (role_id, duty_id));
CREATE TABLE duty_privileges (duty_id TEXT NOT NULL, privilege_name TEXT NOT NULL, PRIMARY KEY (duty_id, privilege_name));
CREATE TABLE privilege_entry_points (privilege_name TEXT NOT NULL, entry_point_name TEXT NOT NULL, object_type TEXT, object_name TEXT, grant_read TEXT, grant_create TEXT, grant_update TEXT, grant_delete TEXT, grant_correct TEXT, grant_invoke TEXT, PRIMARY KEY (privilege_name, entry_point_name));
CREATE TABLE role_direct_privileges (role_id TEXT NOT NULL, privilege_name TEXT NOT NULL, PRIMARY KEY (role_id, privilege_name));
CREATE TABLE role_direct_entity_permissions (role_id TEXT NOT NULL, entity_name TEXT NOT NULL, resource_type TEXT, grant_read TEXT, grant_create TEXT, grant_update TEXT, grant_delete TEXT, grant_correct TEXT, grant_invoke TEXT, PRIMARY KEY (role_id, entity_name));
CREATE TABLE user_roles (user_id TEXT NOT NULL, role_id TEXT NOT NULL, PRIMARY KEY (user_id, role_id));
CREATE TABLE user_role_companies (user_id TEXT NOT NULL, role_id TEXT NOT NULL, company_id TEXT NOT NULL, PRIMARY KEY (user_id, role_id, company_id));
CREATE TABLE role_subroles (parent_role_id TEXT NOT NULL, child_role_id TEXT NOT NULL, PRIMARY KEY (parent_role_id, child_role_id));
CREATE TABLE sec_search (object_type TEXT, object_name TEXT, content TEXT);
`;

describe('ensureSecIndexes', () => {
  let dir, dbPath;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'sec-idx-'));
    dbPath = join(dir, 'sec.sqlite');
    const db = new Database(dbPath);
    db.exec(SCHEMA);
    db.close();
  });
  after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('SEC_INDEXES is a non-empty list of unique CREATE INDEX IF NOT EXISTS statements', () => {
    assert.ok(SEC_INDEXES.length >= 20);
    const names = new Set(SEC_INDEXES.map(i => i.name));
    assert.equal(names.size, SEC_INDEXES.length, 'index names unique');
    for (const ix of SEC_INDEXES) {
      assert.ok(ix.sql.startsWith(`CREATE INDEX IF NOT EXISTS ${ix.name} ON `), ix.name);
      assert.ok(typeof ix.why === 'string' && ix.why.length > 10, `${ix.name} has a justification`);
    }
  });

  it('first run creates every index, second run is a no-op', () => {
    const logs = [];
    const first = ensureSecIndexes(dbPath, { log: (m) => logs.push(m) });
    assert.equal(first.error, undefined);
    assert.equal(first.created.length, SEC_INDEXES.length, 'all created on a fresh DB');
    assert.equal(first.present.length, 0);
    assert.ok(logs.length === SEC_INDEXES.length, 'one log line per created index');

    const second = ensureSecIndexes(dbPath);
    assert.equal(second.created.length, 0);
    assert.equal(second.present.length, SEC_INDEXES.length);
    assert.ok(second.ms < 2000, 'no-op path is cheap');

    const db = new Database(dbPath, { readonly: true });
    const onDisk = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map(r => r.name));
    db.close();
    for (const ix of SEC_INDEXES) assert.ok(onDisk.has(ix.name), `${ix.name} exists on disk`);
  });

  it('the NOCASE join indexes that fix sec_object_access are in the list', () => {
    const names = new Set(SEC_INDEXES.map(i => i.name));
    for (const n of ['idx_dp_priv_nocase', 'idx_dp_duty_nocase', 'idx_rd_duty_nocase', 'idx_rdp_priv_nocase', 'idx_ep_priv_nocase']) {
      assert.ok(names.has(n), n);
    }
  });

  it('an unusable file returns { error } and never throws', () => {
    const missing = join(dir, 'does-not-exist.sqlite');
    const r1 = ensureSecIndexes(missing);
    assert.ok(r1.error, 'missing file → error');
    assert.equal(r1.created.length, 0);

    const garbage = join(dir, 'garbage.sqlite');
    writeFileSync(garbage, 'this is not a sqlite database, just text padding to exceed the header size ....................');
    const r2 = ensureSecIndexes(garbage);
    assert.ok(r2.error, 'non-sqlite file → error');
  });
});
