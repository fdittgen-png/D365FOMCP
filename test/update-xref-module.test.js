/**
 * build/update-xref-module.js — the per-module XRef delta.
 *
 * Exercised against a synthetic SQLite plus an injected source, so the suite
 * needs neither a SQL Server nor the 3.5 GB production database. The shapes
 * mirror the real one: a Microsoft module nobody touches, a custom module that
 * gets recompiled, and a cross-module reference pointing INTO the custom module
 * (the 45 HISOL rows that make the orphan gate necessary).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';

import {
  updateXrefModules,
  assertNoOrphans,
  fingerprintOf,
  MODULE_SYNC_SCHEMA,
} from '../build/update-xref-module.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const MS_MODULE = 1;      // ApplicationSuite — never touched by a delta
const CUSTOM_MODULE = 355; // iExtension

let dir;
let dbPath;

function seedDb() {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE names (id INTEGER PRIMARY KEY, path TEXT NOT NULL, provider_id INTEGER NOT NULL, module_id INTEGER NOT NULL);
    CREATE TABLE modules (id INTEGER PRIMARY KEY, module TEXT NOT NULL);
    CREATE TABLE providers (id INTEGER PRIMARY KEY, provider TEXT NOT NULL);
    CREATE TABLE refs (source_id INTEGER NOT NULL, target_id INTEGER NOT NULL, kind INTEGER NOT NULL, line INTEGER, col INTEGER);
    CREATE TABLE xref_metadata (key TEXT PRIMARY KEY, value TEXT);
  `);
  db.prepare('INSERT INTO providers VALUES (?,?)').run(1, 'Source');
  db.prepare('INSERT INTO modules VALUES (?,?)').run(MS_MODULE, 'ApplicationSuite');
  db.prepare('INSERT INTO modules VALUES (?,?)').run(CUSTOM_MODULE, 'iExtension');

  const n = db.prepare('INSERT INTO names VALUES (?,?,?,?)');
  n.run(10, '/Classes/CustTable', 1, MS_MODULE);
  n.run(11, '/Classes/SalesTable', 1, MS_MODULE);
  n.run(500, '/Classes/TBG_Ext', 1, CUSTOM_MODULE);
  n.run(501, '/Classes/TBG_Old', 1, CUSTOM_MODULE);

  const r = db.prepare('INSERT INTO refs VALUES (?,?,?,?,?)');
  r.run(10, 11, 1, 5, 2);      // Microsoft -> Microsoft: must survive untouched
  r.run(500, 10, 1, 39, 4);    // custom -> Microsoft: replaced by the delta
  r.run(501, 11, 2, 7, 1);     // custom -> Microsoft, from a name about to vanish
  r.run(11, 500, 1, 12, 3);    // Microsoft -> custom: the inbound case
  db.prepare('INSERT INTO xref_metadata VALUES (?,?)').run('build_date', '2020-01-01T00:00:00.000Z');
  db.close();
}

/** A source whose Names/References answers are supplied per test. */
function fakeSource({ names, refs, moduleId = CUSTOM_MODULE, moduleName = 'iExtension' }) {
  return {
    transport: 'fake',
    async close() {},
    async query(sqlText) {
      if (/FROM Modules m LEFT JOIN Names n/.test(sqlText)) {
        if (!sqlText.includes(`'${moduleName}'`)) return [];
        return [{ module_id: moduleId, name_count: names.length, checksum: names.reduce((a, x) => a ^ x.Id, 0) }];
      }
      // Order matters: the References query carries `FROM Names WHERE ModuleId`
      // inside its subquery, so it has to be matched first.
      if (/FROM \[References\]/.test(sqlText)) return refs;
      if (/FROM Names WHERE ModuleId/.test(sqlText)) return names;
      if (/FROM Providers/.test(sqlText)) return [{ Id: 1, Provider: 'Source' }];
      if (/FROM Modules$|FROM Modules\b/.test(sqlText)) {
        return [{ Id: MS_MODULE, Module: 'ApplicationSuite' }, { Id: moduleId, Module: moduleName }];
      }
      throw new Error(`unexpected query: ${sqlText}`);
    },
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'xref-delta-'));
  dbPath = join(dir, 'd365fo_xref.sqlite');
  seedDb();
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('update-xref-module — the delta', () => {
  it('replaces only the named module and leaves every other row untouched', async () => {
    // TBG_Old is gone, TBG_Ext survives with its id, TBG_New appears.
    const source = fakeSource({
      names: [
        { Id: 500, Path: '/Classes/TBG_Ext', ProviderId: 1, ModuleId: CUSTOM_MODULE },
        { Id: 502, Path: '/Classes/TBG_New', ProviderId: 1, ModuleId: CUSTOM_MODULE },
      ],
      refs: [
        { SourceId: 500, TargetId: 10, Kind: 1, Line: 41, Column: 4 },
        { SourceId: 502, TargetId: 11, Kind: 1, Line: 3, Column: 1 },
      ],
    });

    const summary = await updateXrefModules({
      modules: ['iExtension'], dbPath, database: 'XRef_test', source, logger: () => {},
    });
    assert.equal(summary.modules.length, 1);
    assert.equal(summary.modules[0].applied, true);

    const db = new Database(dbPath, { readonly: true });
    // Microsoft names survive.
    assert.deepEqual(
      db.prepare('SELECT id FROM names WHERE module_id = ? ORDER BY id').all(MS_MODULE).map(r => r.id),
      [10, 11],
    );
    // Custom names are exactly what the source said.
    assert.deepEqual(
      db.prepare('SELECT id FROM names WHERE module_id = ? ORDER BY id').all(CUSTOM_MODULE).map(r => r.id),
      [500, 502],
    );
    // The Microsoft->Microsoft reference is untouched...
    assert.equal(db.prepare('SELECT COUNT(*) n FROM refs WHERE source_id = 10 AND target_id = 11').get().n, 1);
    // ...the stale custom reference from the deleted name is gone...
    assert.equal(db.prepare('SELECT COUNT(*) n FROM refs WHERE source_id = 501').get().n, 0);
    // ...and the refreshed one carries the new line number.
    assert.equal(db.prepare('SELECT line FROM refs WHERE source_id = 500').get().line, 41);
    db.close();
  });

  it('keeps an inbound reference from another module valid, because ids are stable', async () => {
    const source = fakeSource({
      names: [{ Id: 500, Path: '/Classes/TBG_Ext', ProviderId: 1, ModuleId: CUSTOM_MODULE }],
      refs: [{ SourceId: 500, TargetId: 10, Kind: 1, Line: 41, Column: 4 }],
    });
    await updateXrefModules({ modules: ['iExtension'], dbPath, database: 'XRef_test', source, logger: () => {} });

    const db = new Database(dbPath, { readonly: true });
    const inbound = db.prepare('SELECT COUNT(*) n FROM refs WHERE source_id = 11 AND target_id = 500').get().n;
    assert.equal(inbound, 1, 'the ApplicationSuite -> iExtension reference must still resolve');
    db.close();
  });

  it('rolls the whole delta back when an inbound reference is orphaned', async () => {
    // TBG_Ext comes back with a NEW id — the one case the design cannot absorb.
    const source = fakeSource({
      names: [{ Id: 900, Path: '/Classes/TBG_Ext', ProviderId: 1, ModuleId: CUSTOM_MODULE }],
      refs: [{ SourceId: 900, TargetId: 10, Kind: 1, Line: 1, Column: 1 }],
    });

    await assert.rejects(
      () => updateXrefModules({ modules: ['iExtension'], dbPath, database: 'XRef_test', source, logger: () => {} }),
      /Orphaned references/,
    );

    // Nothing may have been written — a stale graph beats a corrupt one.
    const db = new Database(dbPath, { readonly: true });
    assert.deepEqual(
      db.prepare('SELECT id FROM names WHERE module_id = ? ORDER BY id').all(CUSTOM_MODULE).map(r => r.id),
      [500, 501],
      'names must be exactly as seeded',
    );
    assert.equal(db.prepare('SELECT COUNT(*) n FROM refs').get().n, 4, 'refs must be exactly as seeded');
    assert.equal(
      db.prepare("SELECT value FROM xref_metadata WHERE key = 'build_date'").get().value,
      '2020-01-01T00:00:00.000Z',
      'the freshness banner must not advance on a rolled-back delta',
    );
    db.close();
  });

  it('moves the freshness banner and re-derives the totals from the tables', async () => {
    const source = fakeSource({
      names: [{ Id: 500, Path: '/Classes/TBG_Ext', ProviderId: 1, ModuleId: CUSTOM_MODULE }],
      refs: [{ SourceId: 500, TargetId: 10, Kind: 1, Line: 41, Column: 4 }],
    });
    await updateXrefModules({ modules: ['iExtension'], dbPath, database: 'XRef_test', source, logger: () => {} });

    const db = new Database(dbPath, { readonly: true });
    const meta = Object.fromEntries(db.prepare('SELECT key, value FROM xref_metadata').all().map(r => [r.key, r.value]));
    assert.notEqual(meta.build_date, '2020-01-01T00:00:00.000Z');
    assert.equal(meta.last_module_delta_modules, 'iExtension');
    assert.equal(Number(meta.name_count), db.prepare('SELECT COUNT(*) n FROM names').get().n);
    assert.equal(Number(meta.ref_count), db.prepare('SELECT COUNT(*) n FROM refs').get().n);
    db.close();
  });
});

describe('update-xref-module — the fingerprint guard', () => {
  const stableSource = () => fakeSource({
    names: [{ Id: 500, Path: '/Classes/TBG_Ext', ProviderId: 1, ModuleId: CUSTOM_MODULE }],
    refs: [{ SourceId: 500, TargetId: 10, Kind: 1, Line: 41, Column: 4 }],
  });

  it('a second run over an unchanged module does no work', async () => {
    const opts = { modules: ['iExtension'], dbPath, database: 'XRef_test', logger: () => {} };
    const first = await updateXrefModules({ ...opts, source: stableSource() });
    assert.equal(first.modules.length, 1);

    const second = await updateXrefModules({ ...opts, source: stableSource() });
    assert.deepEqual(second.skipped, ['iExtension']);
    assert.equal(second.modules.length, 0, 'an unchanged module must not be rewritten');
  });

  it('--force overrides the guard', async () => {
    const opts = { modules: ['iExtension'], dbPath, database: 'XRef_test', logger: () => {} };
    await updateXrefModules({ ...opts, source: stableSource() });
    const forced = await updateXrefModules({ ...opts, source: stableSource(), force: true });
    assert.equal(forced.modules.length, 1);
    assert.deepEqual(forced.skipped, []);
  });

  it('the fingerprint changes when the name set changes', () => {
    assert.notEqual(
      fingerprintOf({ name_count: 2, checksum: '7' }),
      fingerprintOf({ name_count: 2, checksum: '9' }),
    );
    assert.notEqual(
      fingerprintOf({ name_count: 2, checksum: '7' }),
      fingerprintOf({ name_count: 3, checksum: '7' }),
    );
    assert.equal(fingerprintOf(null), null);
  });

  it('a module absent from the source is reported, not invented', async () => {
    const source = fakeSource({ names: [], refs: [], moduleName: 'iExtension' });
    const summary = await updateXrefModules({
      modules: ['NotCompiledYet'], dbPath, database: 'XRef_test', source, logger: () => {},
    });
    assert.deepEqual(summary.missing, ['NotCompiledYet']);
    assert.equal(summary.modules.length, 0);
  });
});

describe('update-xref-module — guard rails', () => {
  it('dry-run reports the delta and writes nothing', async () => {
    const source = fakeSource({
      names: [{ Id: 502, Path: '/Classes/TBG_New', ProviderId: 1, ModuleId: CUSTOM_MODULE }],
      refs: [],
    });
    const summary = await updateXrefModules({
      modules: ['iExtension'], dbPath, database: 'XRef_test', source, dryRun: true, logger: () => {},
    });
    assert.equal(summary.modules[0].applied, false);

    const db = new Database(dbPath, { readonly: true });
    assert.deepEqual(
      db.prepare('SELECT id FROM names WHERE module_id = ? ORDER BY id').all(CUSTOM_MODULE).map(r => r.id),
      [500, 501],
    );
    db.close();
  });

  it('refuses to create a database — the delta refreshes, it does not build', async () => {
    await assert.rejects(
      () => updateXrefModules({ modules: ['iExtension'], dbPath: join(dir, 'nope.sqlite'), database: 'XRef_test', logger: () => {} }),
      /not found/i,
    );
    assert.equal(existsSync(join(dir, 'nope.sqlite')), false);
  });

  it('assertNoOrphans is silent on a consistent graph and throws on a broken one', () => {
    const db = new Database(dbPath);
    db.exec(MODULE_SYNC_SCHEMA);
    assert.doesNotThrow(() => assertNoOrphans(db, [CUSTOM_MODULE]));
    db.prepare('DELETE FROM names WHERE id = ?').run(500);
    assert.throws(() => assertNoOrphans(db, [CUSTOM_MODULE]), /Orphaned references/);
    db.close();
  });
});
