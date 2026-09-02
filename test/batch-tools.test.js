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
import { registerSecTools } from '../src/azure/sec-tools.js';
import { ensureIsvSchema } from '../src/azure/isv-schema.js';
import { coverageKeys } from '../src/azure/output-schemas.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

// Coverage-boundary keys (#116) are per-RESPONSE signals that fire on the
// fixture (no ISV scan → `isv_not_scanned`); they are not batch keys, so the
// "single payload is exactly the pre-batching shape" assertions look past them.
const COVERAGE = new Set(Object.keys(coverageKeys));
const dataKeys = (t) => Object.keys(t).filter(k => !COVERAGE.has(k)).sort();

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

    CREATE TABLE kb_search (object_type TEXT, object_name TEXT, module_id TEXT, content TEXT);
    INSERT INTO kb_search VALUES
      ('table','CustTable','ApplicationSuite','Customer master table with payment terms'),
      ('table','VendTable','ApplicationSuite','Vendor master table with payment terms'),
      ('class','SalesFormLetter','ApplicationSuite','Posts sales documents');

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
  // parse_error is emitted ONLY when true — absence is the success case. The
  // visibility that matters (a parse failure must never be silent) is pinned by
  // the malformed-values_json test in kb-tools.test.js.
  assert.ok(!('parse_error' in t), 'parse_error must be absent when nothing failed');
  // No batch keys at all: a single call pays nothing for the feature.
  assert.deepEqual(Object.keys(t).sort(),
    ['enum_name', 'label', 'module_id', 'value_count', 'values'],
    'a single-target payload must carry no batch keys and no dead keys');
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

/* ── d365_search: queries[] (issue #83, W3) ──────────────────────────────── */

test('d365_search: a single-query call is unchanged by batching', async () => {
  const s = mockServer();
  registerKbTools(s, kbDb());
  const r = await s.call('d365_search', { query: 'payment' });
  const t = r.structuredContent;
  assert.equal(t.query, 'payment');
  assert.equal(t.result_count, 2);
  assert.deepEqual(dataKeys(t),
    ['has_more', 'limit', 'modules', 'object_type', 'query', 'result_count', 'results', 'truncated'],
    'a single-query payload must carry no batch keys (has_more is the W5 page key)');
});

test('d365_search: batch mode hoists the shared scope and carries one entry per query, caller order', async () => {
  const s = mockServer();
  registerKbTools(s, kbDb());
  const r = await s.call('d365_search', { queries: ['sales', 'payment', 'nothing-matches'], object_type: 'table' });
  const t = r.structuredContent;
  assert.equal(t.requested_count, 3);
  assert.equal(t.object_type, 'table', 'the filter is carried once, in the envelope');
  assert.deepEqual(t.queries.map(x => x.query), ['sales', 'payment', 'nothing-matches']);
  assert.equal(t.queries[0].result_count, 0, 'object_type applies to every query (SalesFormLetter is a class)');
  assert.equal(t.queries[1].result_count, 2);
  assert.equal(t.queries[2].result_count, 0, 'a search with no hits is data, not a failure');
  assert.ok(!r.isError);
  assert.equal(t.query, undefined, 'no single-mode keys in a batch');
  assert.ok(!('object_type' in t.queries[0]), 'entries do not repeat what the envelope carries');
  const h2 = (await s.call('d365_search', { queries: ['sales', 'payment'], format: 'markdown' }))
    .content[0].text.split('\n').filter(l => /^## /.test(l));
  assert.equal(h2.length, 1, 'exactly one H2 (rule #3)');
});

test('d365_search: singular and plural are unioned and deduped; neither is an error', async () => {
  const s = mockServer();
  registerKbTools(s, kbDb());
  const r = await s.call('d365_search', { query: 'payment', queries: ['payment', 'sales'] });
  assert.equal(r.structuredContent.requested_count, 2);
  assert.equal((await s.call('d365_search', {})).isError, true);
});

/* ── xref_find_references: objects[] (issue #83, W3) ─────────────────────── */

test('xref_find_references: a single-object call is unchanged by batching', async () => {
  const s = mockServer();
  registerXrefTools(s, xrefDb());
  const r = await s.call('xref_find_references', { object_name: 'CustTable' });
  const t = r.structuredContent;
  assert.equal(t.target_path, '/Tables/CustTable');
  assert.equal(t.result_count, 3);
  assert.deepEqual(dataKeys(t),
    ['has_more', 'isv', 'kind_filter', 'limit', 'references', 'result_count', 'target_path', 'truncated'],
    'a single-object payload must be exactly the pre-batching shape (has_more is the W5 page key)');
});

test('xref_find_references: batch mode hoists kind/limit, one entry per object, misses in not_found', async () => {
  const s = mockServer();
  registerXrefTools(s, xrefDb());
  const r = await s.call('xref_find_references', { objects: ['CustTable', 'SalesTable', 'Nope'], kind: 'Call' });
  const t = r.structuredContent;
  assert.ok(!r.isError, 'a partial batch is a success');
  assert.equal(t.requested_count, 3);
  assert.equal(t.resolved_count, 2);
  assert.deepEqual(t.not_found, ['Nope']);
  assert.equal(t.kind_filter, 'Call');
  assert.deepEqual(t.objects.map(o => o.target_path), ['/Tables/CustTable', '/Tables/SalesTable']);
  assert.equal(t.objects[0].result_count, 2, 'kind applies to every object');
  assert.equal(t.target_path, undefined);
  assert.ok(t.objects.every(o => !('isv' in o)), 'without include_isv no object carries an isv key');
});

test('xref_find_references: batch include_isv hoists the note once and puts counts on every object (rule #14)', async () => {
  const s = mockServer();
  registerXrefTools(s, xrefDb({ withIsv: true }));
  const r = await s.call('xref_find_references', { objects: ['CustTable', 'SalesTable'], include_isv: true });
  const t = r.structuredContent;
  assert.match(t.isv_note, /no X\+\+ source/);
  assert.equal(t.objects[0].isv.reference_count, 3);
  assert.deepEqual(t.objects[1].isv, { reference_count: 0, module_summary: [] },
    'an object with no ISV callers still carries the key, so rows stay uniform');
  assert.ok(t.objects.every(o => !('note' in o.isv)), 'the note is not repeated per object');
  // On a pre-ISV database the block is absent everywhere, never "0 references".
  const s2 = mockServer();
  registerXrefTools(s2, xrefDb());
  const r2 = await s2.call('xref_find_references', { objects: ['CustTable'], include_isv: true });
  assert.ok(!('isv_note' in r2.structuredContent));
  assert.ok(!('isv' in r2.structuredContent.objects[0]));
});

test('xref_find_references: an unresolvable name singly is still a not-found error', async () => {
  const s = mockServer();
  registerXrefTools(s, xrefDb());
  assert.equal((await s.call('xref_find_references', { object_name: 'Nope' })).isError, true);
  assert.equal((await s.call('xref_find_references', {})).isError, true);
});

/* ── sec_lookup_role: role_names[] (issue #83, W3) ───────────────────────── */

function secDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE roles (role_id TEXT PRIMARY KEY, role_name TEXT, module_id TEXT, label TEXT, description TEXT,
      license_type TEXT, permission_type TEXT DEFAULT 'Grant', is_profile INTEGER DEFAULT 0, source TEXT);
    CREATE TABLE role_subroles (parent_role_id TEXT, child_role_id TEXT, is_transitive INTEGER);
    CREATE TABLE duties (duty_id TEXT PRIMARY KEY, duty_name TEXT);
    CREATE TABLE role_duties (role_id TEXT, duty_id TEXT, permission_type TEXT);
    CREATE TABLE role_direct_privileges (role_id TEXT, privilege_name TEXT);
    CREATE TABLE role_direct_entity_permissions (role_id TEXT, entity_name TEXT, resource_type TEXT, grant_read TEXT,
      grant_create TEXT, grant_update TEXT, grant_delete TEXT, grant_correct TEXT, grant_invoke TEXT);
    CREATE TABLE user_roles (user_id TEXT, role_id TEXT);
    CREATE TABLE sec_metadata (key TEXT, value TEXT);
    INSERT INTO roles (role_id, role_name, license_type) VALUES ('R1', 'AP clerk', 'Activity'), ('R2', 'AP manager', 'Enterprise');
    INSERT INTO duties VALUES ('D1', 'Duty one');
    INSERT INTO role_duties VALUES ('R1', 'D1', 'Grant'), ('R2', 'D1', 'Grant');
    INSERT INTO role_direct_entity_permissions VALUES ('R1', 'VendEntity', 'DataEntity', 'Allow', NULL, NULL, NULL, NULL, NULL);
  `);
  return db;
}

test('sec_lookup_role: a single-role call is unchanged by batching', async () => {
  const s = mockServer();
  registerSecTools(s, secDb());
  const r = await s.call('sec_lookup_role', { role_name: 'AP clerk' });
  const t = r.structuredContent;
  assert.equal(t.role_name, 'AP clerk');
  assert.equal(t.duty_count, 1);
  assert.ok(!('roles' in t) && !('requested_count' in t), 'no batch keys on a single call');
});

test('sec_lookup_role: batch mode returns one summary payload per role, misses in not_found', async () => {
  const s = mockServer();
  registerSecTools(s, secDb());
  const r = await s.call('sec_lookup_role', { role_names: ['AP manager', 'AP clerk', 'Ghost'], format: 'markdown' });
  const t = r.structuredContent;
  assert.ok(!r.isError);
  assert.equal(t.requested_count, 3);
  assert.equal(t.resolved_count, 2);
  assert.deepEqual(t.not_found, ['Ghost']);
  assert.deepEqual(t.roles.map(x => x.role_name), ['AP manager', 'AP clerk'], 'caller order');
  assert.equal(t.roles[1].direct_entity_permission_count, 1);
  assert.equal(t.role_name, undefined);
  const h2 = r.content[0].text.split('\n').filter(l => /^## /.test(l));
  assert.equal(h2.length, 1, 'exactly one H2 (rule #3)');
  assert.equal((await s.call('sec_lookup_role', { role_name: 'Ghost' })).isError, true, 'single miss stays an error');
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

/* ── xref_check_exists / sec_check_exists (issue #118, Q5) ───────────────── */
//
// Batch is the ONLY shape: one target is a batch of one, a miss is data in
// `not_found` (rule 2), never notFoundResult. Path-vs-name aware on XRef,
// casing-tolerant with canonical spelling on Sec.

test('xref_check_exists: acceptance — one miss with SalesTable suggested, one table, one method', async () => {
  const s = mockServer();
  registerXrefTools(s, xrefDb());
  const r = await s.call('xref_check_exists', { objects: [{ name: 'SalesTabel' }, { name: 'SalesTable' }, { name: 'SalesFormLetter.run' }] });
  assert.ok(!r.isError, 'a partial batch is a success');
  const t = r.structuredContent;
  assert.equal(t.requested_count, 3);
  assert.equal(t.found_count, 2);
  assert.deepEqual(t.objects, [
    { name: 'SalesTable', exists: true, type: 'table', module: 'ApplicationSuite', path: '/Tables/SalesTable' },
    { name: 'SalesFormLetter.run', exists: true, type: 'method', module: 'ApplicationSuite', path: '/Classes/SalesFormLetter/Methods/run' },
  ]);
  assert.deepEqual(t.not_found, [{ name: 'SalesTabel', suggestions: ['SalesTable'] }]);
  const h2 = r.content[0].text.split('\n').filter(l => /^## /.test(l));
  assert.equal(h2.length, 1, 'exactly one H2 (rule #3)');
  assert.match(r.content[0].text, /did you mean `SalesTable`/);
});

test('xref_check_exists: case-only spelling is a hit with the canonical path; paths, typed lookups and method near-misses', async () => {
  const s = mockServer();
  registerXrefTools(s, xrefDb());
  const r = await s.call('xref_check_exists', { objects: [
    { name: 'custtable' },                       // case-only → exists, canonical path
    { name: '/Classes/SalesFormLetter' },        // explicit path
    { name: 'SalesFormLetter', type: 'table' },  // wrong node → miss
    { name: 'SalesFormLetter.runn' },            // method near-miss → owner.method suggestion
    { name: 'Nothing' },                         // no suggestion at all → empty list, still data
  ] });
  const t = r.structuredContent;
  assert.equal(t.found_count, 2);
  assert.deepEqual(t.objects.map(o => [o.name, o.type, o.path]), [
    ['custtable', 'table', '/Tables/CustTable'],
    ['/Classes/SalesFormLetter', 'class', '/Classes/SalesFormLetter'],
  ]);
  assert.deepEqual(t.not_found, [
    { name: 'SalesFormLetter', suggestions: [] },
    { name: 'SalesFormLetter.runn', suggestions: ['SalesFormLetter.run'] },
    { name: 'Nothing', suggestions: [] },
  ]);
  assert.equal((await s.call('xref_check_exists', { objects: [] })).isError, true, 'no names is invalid input');
  assert.equal((await s.call('xref_check_exists', { objects: [{ name: 'Ghost' }] })).isError, undefined, 'a batch of one miss is still a success');
});

function secCheckDb() {
  const db = secDb();
  db.exec(`
    CREATE TABLE privileges (privilege_name TEXT PRIMARY KEY, module_id TEXT, label TEXT);
    CREATE TABLE privilege_entry_points (privilege_name TEXT, entry_point_name TEXT, object_type TEXT, object_name TEXT,
      grant_read TEXT, grant_create TEXT, grant_update TEXT, grant_delete TEXT, grant_correct TEXT, grant_invoke TEXT);
    INSERT INTO roles (role_id, role_name, license_type) VALUES ('AccountsPayableClerk', 'Accounts payable clerk', 'Activity');
    INSERT INTO privileges VALUES ('CustGroupView', 'ApplicationSuite', 'View customer groups');
    INSERT INTO privilege_entry_points VALUES ('CustGroupView', 'CustGroup', 'MenuItemDisplay', 'CustGroup', 'Allow', NULL, NULL, NULL, NULL, NULL);
  `);
  return db;
}

test('sec_check_exists: acceptance — DMF-UPPERCASE role id and a privilege both exist, canonical AOT casing returned', async () => {
  const s = mockServer();
  registerSecTools(s, secCheckDb());
  const r = await s.call('sec_check_exists', { roles: ['ACCOUNTSPAYABLECLERK'], privileges: ['custgroupview'] });
  assert.ok(!r.isError);
  const t = r.structuredContent;
  assert.equal(t.requested_count, 2);
  assert.equal(t.found_count, 2);
  assert.deepEqual(t.artefacts, [
    { name: 'ACCOUNTSPAYABLECLERK', exists: true, kind: 'role', label: 'Accounts payable clerk', canonical_name: 'AccountsPayableClerk' },
    { name: 'custgroupview', exists: true, kind: 'privilege', label: 'View customer groups', canonical_name: 'CustGroupView' },
  ]);
  assert.deepEqual(t.not_found, []);
  const h2 = r.content[0].text.split('\n').filter(l => /^## /.test(l));
  assert.equal(h2.length, 1, 'exactly one H2 (rule #3)');
});

test('sec_check_exists: display names, duties, entry points; misses are data with suggestions; a partial batch is a success', async () => {
  const s = mockServer();
  registerSecTools(s, secCheckDb());
  const r = await s.call('sec_check_exists', {
    roles: ['ap CLERK', 'AP clerkk', 'Ghost'], duties: ['duty ONE', 'D1'], entry_points: ['custgroup', 'Nope'],
  });
  assert.ok(!r.isError);
  const t = r.structuredContent;
  assert.equal(t.requested_count, 7);
  assert.equal(t.found_count, 4);
  assert.deepEqual(t.artefacts.map(a => [a.kind, a.canonical_name, a.label]), [
    ['role', 'AP clerk', 'AP clerk'],            // matched on the display name → its stored spelling
    ['duty', 'Duty one', 'Duty one'],
    ['duty', 'D1', 'Duty one'],                  // matched on the id → the id
    ['entry_point', 'CustGroup', 'MenuItemDisplay'],
  ]);
  assert.deepEqual(t.not_found, [
    { name: 'AP clerkk', kind: 'role', suggestions: ['AP clerk'] },
    { name: 'Ghost', kind: 'role', suggestions: [] },
    { name: 'Nope', kind: 'entry_point', suggestions: [] },
  ]);
  assert.equal((await s.call('sec_check_exists', {})).isError, true, 'no names is invalid input');
  assert.equal((await s.call('sec_check_exists', { roles: ['Ghost'] })).isError, undefined, 'a batch of one miss is still a success');
});
