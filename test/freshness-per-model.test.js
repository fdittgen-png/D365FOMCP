/**
 * Per-model freshness (issue #86 items 1 and 4).
 *
 * `model_versions.indexed_at` says when each model's row was last written —
 * a full build stamps every model with one instant, a delta moves only the
 * compiled models forward. The tools expose it as a key that is present on
 * EVERY row of a response or on NONE (rule #14): the column's existence
 * decides, so a pre-#86 snapshot serves the byte-identical old payload.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { queryModelVersions, hasIndexedAt, latestIndexedAt, query } from '../src/azure/shared.js';
import { MODEL_VERSIONS_SCHEMA } from '../src/azure/model-descriptors.js';
import { modelVersionRowSchema, d365ModuleRowSchema, xrefListModuleRowSchema } from '../src/azure/output-schemas.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const LEGACY_MODEL_VERSIONS = `CREATE TABLE model_versions (model_name TEXT PRIMARY KEY, module_id TEXT, display_name TEXT,
  publisher TEXT, layer TEXT, origin TEXT, version TEXT, source_root TEXT)`;

function mockServer() {
  const handlers = {};
  return {
    handlers,
    registerTool(name, _config, handler) { handlers[name] = handler; },
    tool(name, _desc, _schema, handler) { handlers[name] = handler; },
    registerResource() {},
    resource() {},
  };
}

const q = (db) => (sql, params = []) => query(db, sql, params);

describe('queryModelVersions / hasIndexedAt / latestIndexedAt', () => {
  it('serves indexed_at on a current snapshot and the old shape on a legacy one', () => {
    const current = new Database(':memory:');
    current.exec(MODEL_VERSIONS_SCHEMA);
    current.prepare("INSERT INTO model_versions VALUES ('Foundation','ApplicationSuite','Application Suite','Microsoft Corporation','SYS','microsoft','10.0.2263.172','C:\\pkg','2026-08-14T00:00:00.000Z')").run();
    current.prepare("INSERT INTO model_versions VALUES ('iExtension','iExtension','iExtension','Trelleborg','USR','custom','10.0.32.7','C:\\custom','2026-09-09T07:00:00.000Z')").run();
    current.prepare("INSERT INTO model_versions VALUES ('HISOL','HISOL','HISOL','HiSol AG','ISV','isv','1.4.0.0','C:\\isv',NULL)").run();
    const rows = queryModelVersions(q(current));
    assert.equal(rows.length, 3);
    assert.ok(hasIndexedAt(rows));
    assert.ok(rows.every(r => 'indexed_at' in r), 'the key is on every row, null where unknown');
    assert.equal(rows.find(r => r.model_name === 'HISOL').indexed_at, null);
    assert.equal(latestIndexedAt(rows), '2026-09-09T07:00:00.000Z');
    assert.deepEqual(queryModelVersions(q(current), 'IEXTENSION').map(r => r.indexed_at), ['2026-09-09T07:00:00.000Z'], 'NOCASE module scope');
    current.close();

    const legacy = new Database(':memory:');
    legacy.exec(LEGACY_MODEL_VERSIONS);
    legacy.prepare("INSERT INTO model_versions VALUES ('Foundation','ApplicationSuite','Application Suite','Microsoft Corporation','SYS','microsoft','10.0.2263.172','C:\\pkg')").run();
    const old = queryModelVersions(q(legacy));
    assert.equal(old.length, 1);
    assert.ok(!hasIndexedAt(old), 'pre-#86 snapshot: no key at all');
    assert.deepEqual(Object.keys(old[0]).sort(), ['display_name', 'layer', 'model_name', 'module_id', 'origin', 'publisher', 'version']);
    assert.equal(latestIndexedAt(old), null);
    legacy.close();

    const none = new Database(':memory:');
    assert.deepEqual(queryModelVersions(q(none)), [], 'no table: [] as before');
    assert.ok(!hasIndexedAt([]));
    none.close();
  });

  it('the shared row schema and both list-module row schemas accept the key as optional/null', () => {
    for (const s of [modelVersionRowSchema, d365ModuleRowSchema, xrefListModuleRowSchema]) {
      const shape = s.shape;
      assert.ok(shape.indexed_at, `${Object.keys(shape).slice(0, 2).join(',')}… carries indexed_at`);
      assert.ok(shape.indexed_at.safeParse(undefined).success);
      assert.ok(shape.indexed_at.safeParse(null).success);
      assert.ok(shape.indexed_at.safeParse('2026-09-09T07:00:00.000Z').success);
    }
  });
});

describe('d365_list_modules / d365_get_module_summary expose indexed_at (#86 item 4)', () => {
  let current, legacy, curTools, legTools;

  const KB_TABLES = `
    CREATE TABLE modules (module_id TEXT PRIMARY KEY, table_count INTEGER, class_count INTEGER,
      enum_count INTEGER, entity_count INTEGER, form_count INTEGER);
    CREATE TABLE tables (table_name TEXT PRIMARY KEY, module_id TEXT, label TEXT, table_group TEXT, save_per_company INTEGER,
      cache_lookup TEXT, clustered_index TEXT, primary_index TEXT, field_count INTEGER, is_customized INTEGER);
    CREATE TABLE classes (class_name TEXT PRIMARY KEY, module_id TEXT, extends_class TEXT, method_count INTEGER);
    CREATE TABLE labels (label_id TEXT PRIMARY KEY, text TEXT);
    INSERT INTO modules VALUES ('ApplicationSuite', 1, 1, 0, 0, 0);
    INSERT INTO modules VALUES ('iExtension', 0, 0, 0, 0, 0);
    INSERT INTO tables VALUES ('CustTable','ApplicationSuite',NULL,'Main',1,'Found',NULL,NULL,10,0);
    INSERT INTO classes VALUES ('CustTableType','ApplicationSuite',NULL,3);
  `;
  const ROWS_CURRENT = `
    INSERT INTO model_versions VALUES ('Foundation','ApplicationSuite','Application Suite','Microsoft Corporation','SYS','microsoft','10.0.2263.172','C:\\pkg','2026-08-14T00:00:00.000Z');
    INSERT INTO model_versions VALUES ('Directory','ApplicationSuite','Directory','Microsoft Corporation','SYS','microsoft','10.0.2263.172','C:\\pkg','2026-08-20T00:00:00.000Z');
    INSERT INTO model_versions VALUES ('iExtension','iExtension','iExtension','Trelleborg','USR','custom','10.0.32.7','C:\\custom',NULL);
  `;
  const ROWS_LEGACY = `
    INSERT INTO model_versions VALUES ('Foundation','ApplicationSuite','Application Suite','Microsoft Corporation','SYS','microsoft','10.0.2263.172','C:\\pkg');
    INSERT INTO model_versions VALUES ('iExtension','iExtension','iExtension','Trelleborg','USR','custom','10.0.32.7','C:\\custom');
  `;

  before(async () => {
    const { registerKbTools } = await import('../src/azure/kb-tools.js');
    current = new Database(':memory:');
    current.exec(KB_TABLES + MODEL_VERSIONS_SCHEMA + ROWS_CURRENT);
    legacy = new Database(':memory:');
    legacy.exec(KB_TABLES + LEGACY_MODEL_VERSIONS + ';' + ROWS_LEGACY);
    const a = mockServer(); registerKbTools(a, current); curTools = a.handlers;
    const b = mockServer(); registerKbTools(b, legacy); legTools = b.handlers;
  });
  after(() => { current?.close(); legacy?.close(); });

  it('list_modules: a package is as fresh as its newest model; null when none of its models is stamped; key absent on a legacy snapshot', async () => {
    const r = await curTools.d365_list_modules({ format: 'markdown' });
    const rows = Object.fromEntries(r.structuredContent.modules.map(m => [m.module_id, m]));
    assert.equal(rows.ApplicationSuite.indexed_at, '2026-08-20T00:00:00.000Z', 'max over Foundation + Directory');
    assert.equal(rows.iExtension.indexed_at, null);
    assert.ok(r.structuredContent.modules.every(m => 'indexed_at' in m), 'every row carries the key');

    const legacyRes = await legTools.d365_list_modules({ format: 'markdown' });
    assert.ok(legacyRes.structuredContent.modules.every(m => !('indexed_at' in m)), 'pre-#86 snapshot: byte-identical old payload');
  });

  it('get_module_summary: every model row carries indexed_at (null where unknown), none on a legacy snapshot', async () => {
    const r = await curTools.d365_get_module_summary({ module_name: 'ApplicationSuite', format: 'markdown' });
    assert.deepEqual(r.structuredContent.models.map(m => [m.model_name, m.indexed_at]),
      [['Directory', '2026-08-20T00:00:00.000Z'], ['Foundation', '2026-08-14T00:00:00.000Z']]);
    const ext = await curTools.d365_get_module_summary({ module_name: 'iExtension', format: 'markdown' });
    assert.deepEqual(ext.structuredContent.models.map(m => m.indexed_at), [null]);

    const legacyRes = await legTools.d365_get_module_summary({ module_name: 'ApplicationSuite', format: 'markdown' });
    assert.ok(legacyRes.structuredContent.models.every(m => !('indexed_at' in m)));
  });
});

describe('xref_list_modules exposes indexed_at (#86 item 4 / #129)', () => {
  let db, tools;
  before(async () => {
    const { registerXrefTools } = await import('../src/azure/xref-tools.js');
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE names (id INTEGER PRIMARY KEY, path TEXT NOT NULL, name TEXT, kind INTEGER, provider_id INTEGER, module_id INTEGER);
      CREATE TABLE refs (source_id INTEGER, target_id INTEGER, kind INTEGER, line INTEGER, col INTEGER);
      CREATE TABLE modules (id INTEGER PRIMARY KEY, module TEXT NOT NULL);
      CREATE TABLE providers (id INTEGER PRIMARY KEY, provider TEXT NOT NULL);
      ${MODEL_VERSIONS_SCHEMA}
      INSERT INTO modules VALUES (1, 'ApplicationSuite');
      INSERT INTO modules VALUES (355, 'iExtension');
      INSERT INTO names VALUES (10, '/Classes/CustTable', 'CustTable', 1, 1, 1);
      INSERT INTO names VALUES (500, '/Classes/TBG_Ext', 'TBG_Ext', 1, 1, 355);
      INSERT INTO model_versions VALUES ('Foundation','ApplicationSuite','Application Suite','Microsoft Corporation','SYS','microsoft','10.0.2263.172','C:\\pkg','2026-08-14T00:00:00.000Z');
      INSERT INTO model_versions VALUES ('iExtension','iExtension','iExtension','Trelleborg','USR','custom','10.0.32.7','C:\\custom','2026-09-09T07:00:00.000Z');
    `);
    const s = mockServer(); registerXrefTools(s, db); tools = s.handlers;
  });
  after(() => db?.close());

  it('the delta-refreshed module reports its own stamp, the untouched one the full-build stamp', async () => {
    const r = await tools.xref_list_modules({ format: 'markdown' });
    const rows = Object.fromEntries(r.structuredContent.modules.map(m => [m.module, m.indexed_at]));
    assert.equal(rows.iExtension, '2026-09-09T07:00:00.000Z');
    assert.equal(rows.ApplicationSuite, '2026-08-14T00:00:00.000Z');
  });
});
