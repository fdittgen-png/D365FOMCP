/**
 * Batching tests (issue #83) and the `include_isv` opt-in (issue #82).
 *
 * The central claim these tests defend is that batching is a *backward
 * compatible superset*: a single-target call must still produce exactly the
 * payload it produced before, so existing callers reading
 * `structuredContent.values` / `.checks` / `.incoming_total` are unaffected.
 *
 * The mock server bypasses Zod, which makes this the enforcement point for the
 * handler-level defensive defaults required by response-contract rule #13.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { registerKbTools } from '../src/azure/kb-tools.js';
import { registerXrefTools } from '../src/azure/xref-tools.js';
import { ensureIsvSchema } from '../src/azure/isv-schema.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

function mockServer() {
  const tools = new Map();
  return {
    registerTool(name, config, handler) { tools.set(name, { config, handler }); },
    tools,
    call(name, args) {
      const t = tools.get(name);
      assert.ok(t, `tool ${name} is not registered`);
      return t.handler(args);
    },
  };
}

function kbDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE tables (table_name TEXT, module_id TEXT, label TEXT, table_group TEXT,
      save_per_company TEXT, cache_lookup TEXT, clustered_index TEXT, replacement_key TEXT);
    CREATE TABLE fields (table_name TEXT, field_name TEXT, field_type TEXT, edt TEXT,
      enum_type TEXT, label TEXT, mandatory TEXT);
    CREATE TABLE enums (enum_name TEXT, module_id TEXT, label TEXT, values_json TEXT);
    CREATE TABLE hallucination_traps (object_name TEXT, trap_type TEXT, wrong_value TEXT,
      correct_value TEXT, explanation TEXT);
    CREATE TABLE labels (label_id TEXT PRIMARY KEY, text TEXT NOT NULL);
    CREATE TABLE indexes_tbl (table_name TEXT, index_name TEXT, is_unique TEXT,
      is_clustered TEXT, fields_json TEXT);
    CREATE TABLE relations (source_table TEXT, related_table TEXT, relation_name TEXT,
      constraints_json TEXT, relationship_type TEXT, on_delete TEXT);

    INSERT INTO tables (table_name) VALUES ('CustTable'), ('SalesTable');
    INSERT INTO fields (table_name, field_name) VALUES
      ('CustTable','AccountNum'), ('CustTable','PaymMode'),
      ('SalesTable','SalesId'),   ('SalesTable','CustAccount');
    INSERT INTO enums (enum_name, module_id, label, values_json) VALUES
      ('SalesStatus','ApplicationSuite','@SYS1','[{"name":"Backorder","value":1},{"name":"Delivered","value":2}]'),
      ('CustVendNegInstStatus','ApplicationSuite',NULL,'[{"name":"None","value":0}]'),
      ('BrokenEnum','ApplicationSuite',NULL,'{not json');
    INSERT INTO labels VALUES ('@SYS1','Sales status');
  `);
  return db;
}

function xrefDb({ withIsv = false } = {}) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE modules (id INTEGER PRIMARY KEY, module TEXT);
    CREATE TABLE names (id INTEGER PRIMARY KEY, path TEXT, module_id INTEGER);
    CREATE TABLE refs (source_id INTEGER, target_id INTEGER, kind INTEGER, line INTEGER, col INTEGER);

    INSERT INTO modules VALUES (1,'ApplicationSuite');
    INSERT INTO names VALUES
      (1,'/Tables/CustTable',1),
      (2,'/Tables/SalesTable',1),
      (3,'/Classes/SalesFormLetter',1),
      (4,'/Classes/SalesFormLetter/Methods/run',1);
    INSERT INTO refs VALUES
      (3,1,1,10,2), (3,2,2,11,4), (4,1,1,20,6), (2,1,2,5,1);
  `);
  if (withIsv) {
    ensureIsvSchema(db, 'xref');
    db.exec(`
      INSERT INTO isv_models (model, publisher, version, layer, source_kind, fidelity, depends_on, root, scanned_at, counts)
      VALUES ('Lasernet','unknown','7.2',NULL,'sealed','metadata','[]','r','2026-08-31T00:00:00.000Z','{}');
      INSERT INTO isv_names (id, path, module) VALUES
        (1,'/Classes/LACRunController/Methods/run','Lasernet'),
        (2,'/Forms/LACTutorial/Methods/init','Lasernet');
      INSERT INTO isv_refs (source_id, target_path, target_module, kind, line, col, tool) VALUES
        (1,'/Tables/CustTable','ApplicationSuite','TypeReference',10,1,'Xppc.exe'),
        (1,'/Tables/CustTable/Fields/PaymMode','ApplicationSuite','MethodCall',11,2,'Xppc.exe'),
        (2,'/Tables/CustTable','ApplicationSuite','TypeReference',12,3,'Xppc.exe');
    `);
  }
  return db;
}

/* ── d365_get_enum ───────────────────────────────────────────────────────── */

test('d365_get_enum: a single-target call is unchanged by batching', async () => {
  const s = mockServer();
  registerKbTools(s, kbDb());
  const r = await s.call('d365_get_enum', { enum_name: 'SalesStatus' });
  const t = r.structuredContent;

  assert.equal(t.enum_name, 'SalesStatus');
  assert.equal(t.value_count, 2);
  assert.equal(t.values[0].name, 'Backorder');
  assert.equal(t.label, 'Sales status', 'label resolution still runs');
  assert.equal(t.parse_error, false);
  // No batch keys at all: a single call pays nothing for the feature.
  assert.deepEqual(Object.keys(t).sort(),
    ['enum_name', 'label', 'module_id', 'parse_error', 'value_count', 'values'],
    'a single-target payload must be exactly what it was before batching existed');
});

test('d365_get_enum: batch mode resolves several enums in one call', async () => {
  const s = mockServer();
  registerKbTools(s, kbDb());
  const r = await s.call('d365_get_enum', {
    enum_names: ['SalesStatus', 'CustVendNegInstStatus'],
  });
  const t = r.structuredContent;

  assert.equal(t.requested_count, 2);
  assert.equal(t.resolved_count, 2);
  assert.deepEqual(t.enums.map(e => e.enum_name), ['SalesStatus', 'CustVendNegInstStatus'],
    'caller order is preserved, not SQLite order');
  assert.equal(t.enum_name, undefined,
    'single-target fields are omitted in batch mode, not sent as nulls');
});

test('d365_get_enum: a missing enum is data in batch mode and an error singly', async () => {
  const s = mockServer();
  registerKbTools(s, kbDb());

  const batch = await s.call('d365_get_enum', { enum_names: ['SalesStatus', 'NoSuchEnum'] });
  assert.ok(!batch.isError, 'a partial batch is a success with per-item outcomes');
  assert.deepEqual(batch.structuredContent.not_found, ['NoSuchEnum']);
  assert.equal(batch.structuredContent.resolved_count, 1);

  const single = await s.call('d365_get_enum', { enum_name: 'NoSuchEnum' });
  assert.equal(single.isError, true, 'single-target not-found behaviour is unchanged');
});

test('d365_get_enum: a broken values_json surfaces as parse_error, not as silence', async () => {
  const s = mockServer();
  registerKbTools(s, kbDb());
  const r = await s.call('d365_get_enum', { enum_names: ['BrokenEnum'] });
  assert.equal(r.structuredContent.enums[0].parse_error, true);
});

test('d365_get_enum: singular and plural are unioned and deduped', async () => {
  const s = mockServer();
  registerKbTools(s, kbDb());
  const r = await s.call('d365_get_enum', {
    enum_name: 'SalesStatus',
    enum_names: ['SalesStatus', 'CustVendNegInstStatus'],
  });
  assert.equal(r.structuredContent.requested_count, 2, 'the duplicate is collapsed');
});

test('d365_get_enum: rejects a call with neither parameter', async () => {
  const s = mockServer();
  registerKbTools(s, kbDb());
  assert.equal((await s.call('d365_get_enum', {})).isError, true);
});

/* ── d365_check_field_exists ─────────────────────────────────────────────── */

test('d365_check_field_exists: a single-table call is unchanged by batching', async () => {
  const s = mockServer();
  registerKbTools(s, kbDb());
  const r = await s.call('d365_check_field_exists', {
    table_name: 'custtable', field_names: ['AccountNum', 'NotAField'],
  });
  const t = r.structuredContent;

  assert.equal(t.table_name, 'CustTable', 'the real cased name is returned');
  assert.equal(t.check_count, 2);
  assert.equal(t.checks[0].exists, true);
  assert.equal(t.checks[1].exists, false);
  assert.deepEqual(Object.keys(t).sort(), ['check_count', 'checks', 'table_name'],
    'a single-table payload must be exactly what it was before batching existed');
});

test('d365_check_field_exists: batch mode checks several tables in one call', async () => {
  const s = mockServer();
  registerKbTools(s, kbDb());
  const r = await s.call('d365_check_field_exists', {
    tables: [
      { table_name: 'CustTable', field_names: ['AccountNum'] },
      { table_name: 'SalesTable', field_names: ['SalesId', 'Nope'] },
    ],
  });
  const t = r.structuredContent;

  assert.equal(t.requested_count, 2);
  assert.equal(t.tables.length, 2);
  assert.equal(t.tables[1].checks.find(c => c.field_name === 'Nope').exists, false);
  assert.equal(t.table_name, undefined);
});

test('d365_check_field_exists: a missing table does not fail the whole batch', async () => {
  const s = mockServer();
  registerKbTools(s, kbDb());
  const r = await s.call('d365_check_field_exists', {
    tables: [
      { table_name: 'CustTable', field_names: ['AccountNum'] },
      { table_name: 'GhostTable', field_names: ['X'] },
    ],
  });

  assert.ok(!r.isError);
  assert.deepEqual(r.structuredContent.not_found, ['GhostTable']);
  assert.equal(r.structuredContent.tables.length, 1);
});

test('d365_check_field_exists: a missing table singly is still a not-found error', async () => {
  const s = mockServer();
  registerKbTools(s, kbDb());
  const r = await s.call('d365_check_field_exists', {
    table_name: 'GhostTable', field_names: ['X'],
  });
  assert.equal(r.isError, true);
});

test('d365_check_field_exists: rejects malformed input rather than guessing', async () => {
  const s = mockServer();
  registerKbTools(s, kbDb());
  assert.equal((await s.call('d365_check_field_exists', {})).isError, true);
  assert.equal((await s.call('d365_check_field_exists',
    { table_name: 'CustTable' })).isError, true, 'a table with no fields to check is not a request');
  assert.equal((await s.call('d365_check_field_exists',
    { tables: [{ table_name: '  ', field_names: ['X'] }] })).isError, true);
});

/* ── xref_object_summary ─────────────────────────────────────────────────── */

test('xref_object_summary: a single-target call is unchanged by batching', async () => {
  const s = mockServer();
  registerXrefTools(s, xrefDb());
  const r = await s.call('xref_object_summary', { object_name: 'CustTable' });
  const t = r.structuredContent;

  assert.equal(t.object_path, '/Tables/CustTable');
  assert.equal(t.module, 'ApplicationSuite');
  assert.equal(t.incoming_total, 3);
  assert.equal(t.objects, undefined, 'no batch keys on a single-target call');
  assert.equal(t.requested_count, undefined);
});

test('xref_object_summary: batch mode summarises several objects in one call', async () => {
  const s = mockServer();
  registerXrefTools(s, xrefDb());
  const r = await s.call('xref_object_summary', {
    object_names: ['CustTable', 'SalesFormLetter'],
  });
  const t = r.structuredContent;

  assert.equal(t.requested_count, 2);
  assert.deepEqual(t.objects.map(o => o.object_path),
    ['/Tables/CustTable', '/Classes/SalesFormLetter']);
  assert.equal(t.object_path, undefined);
  assert.ok(t.objects[1].methods.includes('run'), 'sub-object methods still resolve per object');
});

test('xref_object_summary: an unresolvable name is data in batch mode, an error singly', async () => {
  const s = mockServer();
  registerXrefTools(s, xrefDb());

  const batch = await s.call('xref_object_summary', { object_names: ['CustTable', 'Nope'] });
  assert.ok(!batch.isError);
  assert.deepEqual(batch.structuredContent.not_found, ['Nope']);

  const single = await s.call('xref_object_summary', { object_name: 'Nope' });
  assert.equal(single.isError, true);
});

test('xref_object_summary: the batch rendering keeps exactly one H2 (contract rule #3)', async () => {
  const s = mockServer();
  registerXrefTools(s, xrefDb());
  const r = await s.call('xref_object_summary', {
    object_names: ['CustTable', 'SalesFormLetter'], format: 'markdown',
  });
  const h2 = r.content[0].text.split('\n').filter(l => /^## /.test(l));
  assert.equal(h2.length, 1, `expected one H2, got ${h2.length}`);
});

test('xref_object_summary: rejects a call with neither parameter', async () => {
  const s = mockServer();
  registerXrefTools(s, xrefDb());
  assert.equal((await s.call('xref_object_summary', {})).isError, true);
});

/* ── include_isv on xref_find_references (issue #82) ─────────────────────── */

test('xref_find_references: include_isv is off by default and changes nothing', async () => {
  const s = mockServer();
  registerXrefTools(s, xrefDb({ withIsv: true }));
  const r = await s.call('xref_find_references', { object_name: 'CustTable' });

  assert.equal(r.structuredContent.isv, null,
    'the default answer is byte-identical to before the ISV work');
  assert.equal(r.structuredContent.result_count, 3);
});

test('xref_find_references: include_isv adds the callers the main tables lack', async () => {
  const s = mockServer();
  registerXrefTools(s, xrefDb({ withIsv: true }));
  const r = await s.call('xref_find_references', { object_name: 'CustTable', include_isv: true });
  const isv = r.structuredContent.isv;

  assert.equal(isv.reference_count, 3);
  assert.deepEqual(isv.module_summary, [{ module: 'Lasernet', reference_count: 3 }]);
  assert.match(isv.note, /no X\+\+ source/);
  // The main results must not gain ISV rows — separation is by block, not filter.
  assert.equal(r.structuredContent.result_count, 3);
  assert.ok(r.structuredContent.references.every(x => x.module === 'ApplicationSuite'));
});

test('xref_find_references: include_isv on a pre-ISV database emits no block at all', async () => {
  const s = mockServer();
  registerXrefTools(s, xrefDb({ withIsv: false }));
  const r = await s.call('xref_find_references', { object_name: 'CustTable', include_isv: true });

  assert.equal(r.structuredContent.isv, null,
    'an un-scanned database must not report "no ISV references" — it does not know');
});

test('xref_find_references: an object with only ISV callers is not reported as empty', async () => {
  const db = xrefDb({ withIsv: true });
  // A standard object nothing in the snapshot references, but an ISV does.
  db.exec(`INSERT INTO names VALUES (5,'/Tables/OnlyIsvUses',1);
           INSERT INTO isv_refs (source_id, target_path, target_module, kind, line, col, tool)
           VALUES (1,'/Tables/OnlyIsvUses','ApplicationSuite','MethodCall',1,1,'Xppc.exe');`);
  const s = mockServer();
  registerXrefTools(s, db);
  const r = await s.call('xref_find_references',
    { object_name: 'OnlyIsvUses', include_isv: true, format: 'markdown' });

  assert.equal(r.structuredContent.result_count, 0);
  assert.equal(r.structuredContent.isv.reference_count, 1);
  assert.ok(!r.isError, 'this is not an emptyResult — there *are* references, just not indexed ones');
  assert.match(r.content[0].text, /Sealed ISV models/,
    'reporting "no references" here would be exactly the wrong answer');
});
