/**
 * #115 (Q2) — actionable not-found and the `functional_context` capture path.
 *
 * Three claims:
 *   1. No not-found ships empty-handed: every notFoundResult call site in the
 *      tool files passes `{ db, kind }`, so a near-miss name is recovered from
 *      the service's own name table even when the caller's fuzzy list is empty.
 *   2. `functional_context` on a SUCCESSFUL call records exactly one
 *      `context_hint` mapping; a repeat bumps `confirmations` (never a second
 *      row); an unknown vocabulary id records nothing; a stronger
 *      (`user_confirmed`) mapping is never downgraded.
 *   3. A semantic-store failure never fails a read tool.
 *
 * Plus item 4: the xref_search_names path-miss note.
 */

import { test, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { registerKbTools } from '../src/azure/kb-tools.js';
import { registerXrefTools } from '../src/azure/xref-tools.js';
import { registerSecTools } from '../src/azure/sec-tools.js';
import { openSemanticDb, loadVocabulary, upsertMapping, mappingsForEntity } from '../src/azure/semantic-store.js';
import { recordContextHint } from '../src/azure/tool-guards.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

function mockServer() {
  const tools = new Map();
  return {
    registerTool(name, config, handler) { tools.set(name, { config, handler }); },
    tools,
    call(name, args) { return tools.get(name).handler(args); },
  };
}

function semDb() {
  const db = openSemanticDb(':memory:');
  loadVocabulary(db, {
    version: '1.0.0',
    entities: [
      { entity_id: 'sales_order', name: 'Sales order', process: 'order_to_cash' },
      { entity_id: 'sales_quotation', name: 'Sales quotation', process: 'order_to_cash' },
      { entity_id: 'customer', name: 'Customer', process: 'master_data' },
    ],
  });
  return db;
}

function kbDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE tables (table_name TEXT, module_id TEXT, label TEXT, table_group TEXT,
      save_per_company TEXT, cache_lookup TEXT, clustered_index TEXT, replacement_key TEXT, is_customized INTEGER DEFAULT 0);
    CREATE TABLE fields (table_name TEXT, field_name TEXT, field_type TEXT, edt TEXT, enum_type TEXT, label TEXT, mandatory TEXT,
      source_module TEXT, is_extension INTEGER DEFAULT 0);
    CREATE TABLE indexes_tbl (table_name TEXT, index_name TEXT, is_unique TEXT, is_clustered TEXT, fields_json TEXT);
    CREATE TABLE relations (source_table TEXT, related_table TEXT, relation_name TEXT, constraints_json TEXT, relationship_type TEXT, on_delete TEXT);
    CREATE TABLE labels (label_id TEXT PRIMARY KEY, text TEXT NOT NULL);
    CREATE TABLE enums (enum_name TEXT, module_id TEXT, label TEXT, values_json TEXT);
    CREATE TABLE classes (class_name TEXT, module_id TEXT, extends_class TEXT, implements_list TEXT, is_abstract INTEGER, method_count INTEGER);
    CREATE TABLE methods (owner_type TEXT, owner_name TEXT, method_name TEXT, signature TEXT, is_static INTEGER, source_code TEXT);
    CREATE TABLE data_entities (entity_name TEXT, module_id TEXT, label TEXT, public_name TEXT, public_collection TEXT, is_public INTEGER,
      primary_table TEXT, staging_table TEXT, config_key TEXT);
    CREATE TABLE entity_fields (entity_name TEXT, field_name TEXT, data_field TEXT, data_source TEXT, is_mandatory INTEGER);
    CREATE TABLE modules (module_id TEXT PRIMARY KEY, table_count INTEGER, class_count INTEGER, enum_count INTEGER, entity_count INTEGER, form_count INTEGER);
    CREATE TABLE kb_search (object_type TEXT, object_name TEXT, module_id TEXT, content TEXT);
    INSERT INTO kb_search VALUES ('table', 'SalesTable', 'ApplicationSuite', 'Sales order header');
    INSERT INTO tables (table_name, module_id) VALUES ('SalesTable', 'ApplicationSuite'), ('SalesLine', 'ApplicationSuite'), ('CustTable', 'ApplicationSuite');
    INSERT INTO fields (table_name, field_name, field_type, source_module, is_extension) VALUES
      ('SalesTable', 'SalesId', 'String', 'ApplicationSuite', 0), ('SalesTable', 'CustAccount', 'String', 'ApplicationSuite', 0),
      ('SalesTable', 'TBG_Flag', 'Enum', 'iExtension', 1);
    INSERT INTO enums VALUES ('SalesStatus', 'ApplicationSuite', NULL, '[{"name":"Backorder","value":1}]');
    INSERT INTO classes VALUES ('SalesFormLetter', 'ApplicationSuite', 'FormLetter', NULL, 1, 2);
    INSERT INTO methods VALUES ('class', 'SalesFormLetter', 'run', 'public void run()', 0, 'public void run()\n{\n}'),
      ('class', 'SalesFormLetter', 'construct', 'public static SalesFormLetter construct()', 1, 'x');
    INSERT INTO data_entities VALUES ('SalesOrderHeaderV2Entity', 'ApplicationSuite', NULL, 'SalesOrderHeaderV2', 'SalesOrderHeadersV2', 1, 'SalesTable', NULL, NULL);
    INSERT INTO entity_fields VALUES ('SalesOrderHeaderV2Entity', 'SalesOrderNumber', 'SalesId', 'SalesTable', 1);
  `);
  return db;
}

function xrefDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE modules (id INTEGER PRIMARY KEY, module TEXT);
    CREATE TABLE names (id INTEGER PRIMARY KEY, path TEXT, module_id INTEGER);
    CREATE TABLE refs (source_id INTEGER, target_id INTEGER, kind INTEGER, line INTEGER, col INTEGER);
    INSERT INTO modules VALUES (1, 'ApplicationSuite');
    INSERT INTO names VALUES (1, '/Tables/CustTable', 1), (2, '/Tables/SalesTable', 1), (3, '/Classes/SalesFormLetter', 1),
      (4, '/Classes/SalesFormLetter/Methods/run', 1);
    INSERT INTO refs VALUES (3, 1, 1, 10, 2), (3, 2, 2, 11, 4), (4, 1, 1, 20, 6);
  `);
  return db;
}

function secDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE roles (role_id TEXT PRIMARY KEY, role_name TEXT, module_id TEXT, label TEXT, description TEXT,
      license_type TEXT, permission_type TEXT DEFAULT 'Grant', is_profile INTEGER DEFAULT 0, source TEXT);
    CREATE TABLE role_subroles (parent_role_id TEXT, child_role_id TEXT, is_transitive INTEGER);
    CREATE TABLE duties (duty_id TEXT PRIMARY KEY, duty_name TEXT, module_id TEXT, description TEXT);
    CREATE TABLE role_duties (role_id TEXT, duty_id TEXT, permission_type TEXT);
    CREATE TABLE privileges (privilege_name TEXT PRIMARY KEY, module_id TEXT, label TEXT);
    CREATE TABLE duty_privileges (duty_id TEXT, privilege_name TEXT);
    CREATE TABLE privilege_entry_points (privilege_name TEXT, entry_point_name TEXT, object_type TEXT, object_name TEXT,
      grant_read TEXT, grant_create TEXT, grant_update TEXT, grant_delete TEXT, grant_correct TEXT, grant_invoke TEXT);
    CREATE TABLE role_direct_privileges (role_id TEXT, privilege_name TEXT);
    CREATE TABLE role_direct_entity_permissions (role_id TEXT, entity_name TEXT, resource_type TEXT, grant_read TEXT,
      grant_create TEXT, grant_update TEXT, grant_delete TEXT, grant_correct TEXT, grant_invoke TEXT);
    CREATE TABLE users (user_id TEXT PRIMARY KEY, person_name TEXT, email TEXT, enabled INTEGER DEFAULT 1, default_company TEXT);
    CREATE TABLE user_roles (user_id TEXT, role_id TEXT);
    CREATE TABLE user_role_companies (user_id TEXT, role_id TEXT, company_id TEXT);
    CREATE TABLE sec_metadata (key TEXT, value TEXT);
    INSERT INTO roles (role_id, role_name, license_type) VALUES ('AccountsPayableClerk', 'Accounts payable clerk', 'Activity');
    INSERT INTO duties VALUES ('CustCustomersMaintain', 'Maintain customers', 'ApplicationSuite', NULL);
    INSERT INTO role_duties VALUES ('AccountsPayableClerk', 'CustCustomersMaintain', 'Grant');
    INSERT INTO privileges VALUES ('CustGroupView', 'ApplicationSuite', 'View customer groups');
    INSERT INTO duty_privileges VALUES ('CustCustomersMaintain', 'CustGroupView');
    INSERT INTO privilege_entry_points VALUES ('CustGroupView', 'CustGroup', 'MenuItemDisplay', 'CustGroup', 'Allow', NULL, NULL, NULL, NULL, NULL);
    INSERT INTO users VALUES ('alice.p', 'Alice P', NULL, 1, 'DAT');
    INSERT INTO user_roles VALUES ('alice.p', 'AccountsPayableClerk');
  `);
  return db;
}

const mappings = (sem, entity) => mappingsForEntity(sem, entity).map(m => ({
  object_type: m.object_type, object_name: m.object_name, role: m.role, source: m.source, confirmations: m.confirmations,
}));

describe('#115 item 3 — exact-name recovery on every not-found site', () => {
  it('d365_lookup_table: a typo with no LIKE hit still lists the real table (closestNames via {db, kind})', async () => {
    const s = mockServer();
    registerKbTools(s, kbDb(), { semanticDb: semDb() });
    const r = await s.call('d365_lookup_table', { table_name: 'SalesTabel' });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /\*\*Did you mean:\*\*\n- `SalesTable`/);
    assert.equal(r.structuredContent, undefined, 'meta-response: no structuredContent');
  });

  it('xref_find_usages / xref_impact_analysis / xref_class_hierarchy / sec_lookup_duty / sec_role_hierarchy recover the name', async () => {
    const x = mockServer();
    registerXrefTools(x, xrefDb());
    for (const [tool, args] of [
      ['xref_find_usages', { object_name: 'custtabel' }],
      ['xref_impact_analysis', { object_name: 'SalesTabl' }],
      ['xref_class_hierarchy', { class_name: 'salesformletter' }],
    ]) {
      const r = await x.call(tool, args);
      assert.equal(r.isError, true, tool);
      assert.match(r.content[0].text, /Did you mean/, `${tool}: no suggestion recovered`);
    }
    const sec = mockServer();
    registerSecTools(sec, secDb());
    const d = await sec.call('sec_lookup_duty', { duty_name: 'Maintain custmers' });
    assert.match(d.content[0].text, /- `Maintain customers`/);
    const h = await sec.call('sec_role_hierarchy', { role_name: 'Accounts payable clrk' });
    assert.match(h.content[0].text, /- `Accounts payable clerk`/);
    const u = await sec.call('sec_lookup_user', { user_id: 'alice' });
    assert.match(u.content[0].text, /- `alice\.p`/);
  });
});

describe('#115 items 1–2 — functional_context records a context_hint and enriches not-found', () => {
  it('d365_lookup_table success → exactly one context_hint mapping; a repeat bumps confirmations, never duplicates', async () => {
    const sem = semDb();
    const s = mockServer();
    registerKbTools(s, kbDb(), { semanticDb: sem });
    const r1 = await s.call('d365_lookup_table', { table_name: 'salestable', functional_context: 'sales_order' });
    assert.ok(!r1.isError);
    assert.deepEqual(mappings(sem, 'sales_order'),
      [{ object_type: 'table', object_name: 'SalesTable', role: 'reference', source: 'context_hint', confirmations: 0 }],
      'canonical casing, role reference, source context_hint');
    const r2 = await s.call('d365_lookup_table', { table_name: 'SalesTable', functional_context: 'sales_order' });
    assert.ok(!r2.isError);
    const after = mappings(sem, 'sales_order');
    assert.equal(after.length, 1, 'no duplicate row');
    assert.equal(after[0].confirmations, 1, 'repeat bumps confirmations');
    const row = mappingsForEntity(sem, 'sales_order')[0];
    assert.equal(row.confidence, 0.23, 'context_hint 0.20 + 0.03 per confirmation');
    // The payload is unchanged by the side channel (no functional_context key).
    assert.equal(r1.structuredContent.functional_context, undefined);
  });

  it('a context_hint never overwrites a user_confirmed mapping on the same key', async () => {
    const sem = semDb();
    upsertMapping(sem, { entity_id: 'sales_order', object_type: 'table', object_name: 'SalesTable', role: 'reference', source: 'user_confirmed' });
    const s = mockServer();
    registerKbTools(s, kbDb(), { semanticDb: sem });
    await s.call('d365_lookup_table', { table_name: 'SalesTable', functional_context: 'sales_order' });
    const rows = mappingsForEntity(sem, 'sales_order');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source, 'user_confirmed');
    assert.equal(rows[0].confirmations, 1, 'user_confirmed confirmations untouched by the hint');
  });

  it('unknown vocabulary id: nothing recorded on success; the miss explains it with the closest ids', async () => {
    const sem = semDb();
    const s = mockServer();
    registerKbTools(s, kbDb(), { semanticDb: sem });
    const ok = await s.call('d365_lookup_table', { table_name: 'SalesTable', functional_context: 'sales_quot' });
    assert.ok(!ok.isError);
    assert.equal(sem.prepare('SELECT COUNT(*) AS n FROM sem_mappings').get().n, 0);
    const miss = await s.call('d365_lookup_table', { table_name: 'SalesTabel', functional_context: 'sales_quot' });
    assert.match(miss.content[0].text, /_Unknown functional_context "sales_quot"; closest: sales_quotation_/);
  });

  it('a miss with a mapped context lists the mapped objects after the did-you-mean (acceptance: SalesTabel + sales_order)', async () => {
    const sem = semDb();
    upsertMapping(sem, { entity_id: 'sales_order', object_type: 'table', object_name: 'SalesTable', role: 'header', source: 'user_confirmed' });
    upsertMapping(sem, { entity_id: 'sales_order', object_type: 'table', object_name: 'SalesLine', role: 'line', source: 'seed' });
    const s = mockServer();
    registerKbTools(s, kbDb(), { semanticDb: sem });
    const r = await s.call('d365_lookup_table', { table_name: 'SalesTabel', functional_context: 'sales_order' });
    assert.equal(r.isError, true);
    const text = r.content[0].text;
    assert.match(text, /- `SalesTable`/, 'name recovery first');
    assert.match(text, /_Objects mapped to Sales order: SalesTable \(header\), SalesLine \(line\)_$/);
  });

  it('every tool that takes functional_context records the resolved object with its semantic type', async () => {
    const sem = semDb();
    const kb = mockServer();
    registerKbTools(kb, kbDb(), { semanticDb: sem });
    const x = mockServer();
    registerXrefTools(x, xrefDb(), { semanticDb: sem });
    const sec = mockServer();
    registerSecTools(sec, secDb(), { semanticDb: sem });

    await kb.call('d365_get_class_methods', { name: 'salesformletter', functional_context: 'sales_order' });
    await kb.call('d365_get_entity_sources', { entity_name: 'SalesOrderHeadersV2', functional_context: 'sales_order' });
    await kb.call('d365_effective_schema', { table_name: 'SalesLine', functional_context: 'sales_order' });
    await x.call('xref_find_references', { object_name: 'CustTable', functional_context: 'customer' });
    await x.call('xref_object_summary', { object_names: ['SalesFormLetter', 'Nope'], functional_context: 'sales_order' });
    await sec.call('sec_lookup_role', { role_name: 'accounts PAYABLE clerk', functional_context: 'customer' });
    await sec.call('sec_object_access', { object_name: 'custgroup', functional_context: 'customer' });
    // A search resolves no single object: accepted, nothing recorded.
    await kb.call('d365_search', { query: 'sales', functional_context: 'sales_order' });

    assert.deepEqual(mappings(sem, 'sales_order').map(m => `${m.object_type}:${m.object_name}`).sort(), [
      'class:SalesFormLetter', 'data_entity:SalesOrderHeaderV2Entity', 'table:SalesLine',
    ]);
    assert.deepEqual(mappings(sem, 'customer').map(m => `${m.object_type}:${m.object_name}`).sort(), [
      'menu_item:CustGroup', 'security_role:Accounts payable clerk', 'table:CustTable',
    ]);
    assert.ok(mappingsForEntity(sem, 'sales_order').every(m => m.source === 'context_hint'));
  });

  it('a semantic store that throws never fails the read tool, and a null store is a no-op', async () => {
    const broken = { prepare() { throw new Error('disk I/O error'); } };
    const s = mockServer();
    registerKbTools(s, kbDb(), { semanticDb: broken });
    const r = await s.call('d365_lookup_table', { table_name: 'SalesTable', functional_context: 'sales_order' });
    assert.ok(!r.isError);
    assert.equal(r.structuredContent.table_name, 'SalesTable');
    const miss = await s.call('d365_lookup_table', { table_name: 'SalesTabel', functional_context: 'sales_order' });
    assert.equal(miss.isError, true);
    assert.match(miss.content[0].text, /- `SalesTable`/, 'name recovery still works without a semantic store');
    assert.equal(recordContextHint(null, { functional_context: 'sales_order', object_type: 'table', object_name: 'X' }), null);
    assert.equal(recordContextHint(broken, { functional_context: 'sales_order', object_type: 'table', object_name: 'X' }), null);
  });

  it('recordContextHint: unknown type falls back to other; blank inputs record nothing', () => {
    const sem = semDb();
    assert.deepEqual(recordContextHint(sem, { functional_context: 'customer', object_type: 'map', object_name: 'CustVendMap' }), { action: 'inserted' });
    assert.equal(mappingsForEntity(sem, 'customer')[0].object_type, 'other');
    assert.equal(recordContextHint(sem, { functional_context: '  ', object_type: 'table', object_name: 'X' }), null);
    assert.equal(recordContextHint(sem, { functional_context: 'customer', object_type: 'table', object_name: '' }), null);
    assert.deepEqual(recordContextHint(sem, { functional_context: 'nope', object_type: 'table', object_name: 'X' }), { action: 'skipped', reason: 'unknown_entity' });
    assert.equal(sem.prepare('SELECT COUNT(*) AS n FROM sem_mappings').get().n, 1);
  });
});

test('#115 item 4 — xref_search_names: 0 rows with a % pattern that has no leading % carries the path-miss note', async () => {
  const s = mockServer();
  registerXrefTools(s, xrefDb());
  const NOTE = '_Pattern matches the object PATH; retry with a leading % to match the bare name._';
  const miss = await s.call('xref_search_names', { pattern: 'Cust%' });
  assert.equal(miss.isError, undefined, 'emptyResult, not an error');
  assert.equal(miss._meta.kind, 'empty', 'still a meta-response');
  assert.ok(miss.content[0].text.endsWith(NOTE), miss.content[0].text);
  assert.equal(miss.structuredContent.result_count, 0);
  // Leading % → the pattern is right; a plain word is auto-wrapped → the note would be false advice.
  const hit = await s.call('xref_search_names', { pattern: '%Cust%' });
  assert.equal(hit.structuredContent.result_count, 1);
  const plain = await s.call('xref_search_names', { pattern: 'Zzz' });
  assert.equal(plain._meta.kind, 'empty');
  assert.ok(!plain.content[0].text.includes('object PATH'), 'no note when a leading % would change nothing');
  // The custom-layer disclosure still comes first when both apply.
  const both = await s.call('xref_search_names', { pattern: 'TBG_%' });
  assert.ok(both.content[0].text.includes('custom prefix') && both.content[0].text.endsWith(NOTE));
});
