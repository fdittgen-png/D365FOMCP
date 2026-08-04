/**
 * Tests for mergeCustomKb (build/merge-kb-custom.js).
 *
 * Proves the custom-delta merge is ADDITIVE: Microsoft rows survive, extension
 * fields land on their base table, enum values are unioned (not replaced), and
 * net-new custom objects are added. Both DBs use an identical minimal schema so
 * the merge's `SELECT *` column counts line up, exactly as two real v1.1 builds.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const { mergeCustomKb } = await import('../build/merge-kb-custom.js');

// Minimal schema covering exactly the tables the merge touches, column order
// identical in both DBs (mirrors build-kb.js v1.1 column ordering).
const SCHEMA = `
CREATE TABLE kb_metadata (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE tables (table_name TEXT PRIMARY KEY, module_id TEXT, label TEXT, table_group TEXT, save_per_company TEXT, cache_lookup TEXT, clustered_index TEXT, replacement_key TEXT, config_key TEXT, field_count INTEGER, has_methods INTEGER, developer_doc TEXT, file_path TEXT, is_customized INTEGER DEFAULT 0);
CREATE TABLE fields (table_name TEXT, field_name TEXT, field_type TEXT, edt TEXT, enum_type TEXT, mandatory TEXT, allow_edit TEXT, label TEXT, source_module TEXT, is_extension INTEGER DEFAULT 0, PRIMARY KEY(table_name, field_name));
CREATE TABLE enums (enum_name TEXT PRIMARY KEY, module_id TEXT, label TEXT, values_json TEXT);
CREATE TABLE classes (class_name TEXT PRIMARY KEY, module_id TEXT, extends_class TEXT, implements_list TEXT, is_abstract INTEGER, method_count INTEGER, file_path TEXT);
CREATE TABLE edts (edt_name TEXT PRIMARY KEY, base_type TEXT, extends_edt TEXT, label TEXT, string_size INTEGER, table_ref TEXT, module_id TEXT);
CREATE TABLE data_entities (entity_name TEXT PRIMARY KEY, module_id TEXT, label TEXT, public_name TEXT, public_collection TEXT, is_public INTEGER, primary_table TEXT, staging_table TEXT, config_key TEXT, file_path TEXT);
CREATE TABLE entity_fields (entity_name TEXT, field_name TEXT, data_field TEXT, data_source TEXT, is_mandatory INTEGER, PRIMARY KEY(entity_name, field_name));
CREATE TABLE forms (form_name TEXT PRIMARY KEY, module_id TEXT, label TEXT, data_sources_json TEXT, file_path TEXT);
CREATE TABLE views (view_name TEXT PRIMARY KEY, module_id TEXT, label TEXT, config_key TEXT, field_count INTEGER, file_path TEXT);
CREATE TABLE menu_items (menu_item_name TEXT, menu_item_type TEXT, module_id TEXT, label TEXT, object_name TEXT, object_type TEXT, config_key TEXT, PRIMARY KEY(menu_item_name, menu_item_type));
CREATE TABLE methods (owner_type TEXT, owner_name TEXT, method_name TEXT, signature TEXT, is_static INTEGER, source_code TEXT, PRIMARY KEY(owner_type, owner_name, method_name));
CREATE TABLE indexes_tbl (table_name TEXT, index_name TEXT, is_unique INTEGER, is_clustered INTEGER, fields_json TEXT, PRIMARY KEY(table_name, index_name));
CREATE TABLE relations (source_table TEXT, relation_name TEXT, related_table TEXT, cardinality TEXT, related_cardinality TEXT, on_delete TEXT, relationship_type TEXT, constraints_json TEXT, PRIMARY KEY(source_table, relation_name));
CREATE TABLE labels (label_id TEXT PRIMARY KEY, text TEXT NOT NULL);
CREATE TABLE object_paths (object_type TEXT, object_name TEXT, file_path TEXT, file_size INTEGER, PRIMARY KEY(object_type, object_name));
CREATE TABLE graph_edges (source_node TEXT, source_type TEXT, target_node TEXT, target_type TEXT, edge_type TEXT, edge_detail TEXT, PRIMARY KEY(source_node, target_node, edge_type, edge_detail));
CREATE TABLE kb_search (object_type TEXT, object_name TEXT, module_id TEXT, content TEXT);
`;

let dir, livePath, custPath;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'kb-merge-test-'));
  livePath = join(dir, 'live.sqlite');
  custPath = join(dir, 'cust.sqlite');

  // ── Live (Microsoft base) ──
  const live = new Database(livePath);
  live.exec(SCHEMA);
  live.prepare('INSERT INTO kb_metadata VALUES (?,?)').run('build_date', '2026-01-01T00:00:00.000Z');
  live.prepare('INSERT INTO kb_metadata VALUES (?,?)').run('has_customizations', '0');
  live.prepare('INSERT INTO kb_metadata VALUES (?,?)').run('custom_packages_paths', '');
  // Base table CustTable with two MS fields.
  live.prepare('INSERT INTO tables (table_name,module_id,field_count,is_customized) VALUES (?,?,?,?)').run('CustTable', 'ApplicationSuite', 2, 0);
  live.prepare('INSERT INTO fields (table_name,field_name,field_type,source_module,is_extension) VALUES (?,?,?,?,?)').run('CustTable', 'AccountNum', 'String', 'ApplicationSuite', 0);
  live.prepare('INSERT INTO fields (table_name,field_name,field_type,source_module,is_extension) VALUES (?,?,?,?,?)').run('CustTable', 'CustGroup', 'String', 'ApplicationSuite', 0);
  // MS enum with two values.
  live.prepare('INSERT INTO enums VALUES (?,?,?,?)').run('CustVendorBlocked', 'ApplicationSuite', null, JSON.stringify([{ name: 'No', value: 0 }, { name: 'All', value: 1 }]));
  live.prepare('INSERT INTO kb_search VALUES (?,?,?,?)').run('table', 'CustTable', 'ApplicationSuite', 'CustTable AccountNum CustGroup');
  live.close();

  // ── Custom delta (as a custom-only build would produce) ──
  const cust = new Database(custPath);
  cust.exec(SCHEMA);
  cust.prepare('INSERT INTO kb_metadata VALUES (?,?)').run('custom_packages_paths', 'C:\\Workspace\\DEV\\Metadata');
  // Net-new custom table.
  cust.prepare('INSERT INTO tables (table_name,module_id,field_count,is_customized) VALUES (?,?,?,?)').run('TIS_CrmLink', 'iExtension', 1, 0);
  cust.prepare('INSERT INTO fields (table_name,field_name,field_type,source_module,is_extension) VALUES (?,?,?,?,?)').run('TIS_CrmLink', 'ExternalId', 'String', 'iExtension', 0);
  // Extension fields onto the MS base table (keyed by base table, is_extension=1).
  cust.prepare('INSERT INTO fields (table_name,field_name,field_type,source_module,is_extension) VALUES (?,?,?,?,?)').run('CustTable', 'TBG_CrmRef', 'String', 'iExtension', 1);
  cust.prepare('INSERT INTO fields (table_name,field_name,field_type,source_module,is_extension) VALUES (?,?,?,?,?)').run('CustTable', 'TBG_Hide', 'Enum', 'iExtension', 1);
  // Enum extension: custom-only build has NO base values, only the added one.
  cust.prepare('INSERT INTO enums VALUES (?,?,?,?)').run('CustVendorBlocked', 'iExtension', null, JSON.stringify([{ name: 'TBG_Custom', value: 99, custom: true, source_module: 'iExtension' }]));
  cust.prepare('INSERT INTO kb_search VALUES (?,?,?,?)').run('table', 'TIS_CrmLink', 'iExtension', 'TIS_CrmLink ExternalId');
  cust.close();
});

after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('mergeCustomKb', () => {
  it('merges additively without destroying Microsoft data', () => {
    const summary = mergeCustomKb(livePath, custPath, () => {});
    const db = new Database(livePath, { readonly: true });

    // Net-new custom table added; MS table still present.
    assert.ok(db.prepare("SELECT 1 FROM tables WHERE table_name='TIS_CrmLink'").get());
    assert.ok(db.prepare("SELECT 1 FROM tables WHERE table_name='CustTable'").get());

    // MS fields preserved; extension fields added; base table flagged + recounted.
    const custFields = db.prepare("SELECT field_name, is_extension FROM fields WHERE table_name='CustTable' ORDER BY field_name").all();
    const names = custFields.map(f => f.field_name);
    assert.ok(names.includes('AccountNum') && names.includes('CustGroup'), 'MS fields survive');
    assert.ok(names.includes('TBG_CrmRef') && names.includes('TBG_Hide'), 'extension fields added');
    const custRow = db.prepare("SELECT is_customized, field_count FROM tables WHERE table_name='CustTable'").get();
    assert.equal(custRow.is_customized, 1);
    assert.equal(custRow.field_count, 4);

    // Enum values UNIONED — MS values kept, custom value appended.
    const vals = JSON.parse(db.prepare("SELECT values_json FROM enums WHERE enum_name='CustVendorBlocked'").get().values_json);
    const valNames = vals.map(v => v.name);
    assert.ok(valNames.includes('No') && valNames.includes('All'), 'MS enum values survive');
    assert.ok(valNames.includes('TBG_Custom'), 'custom enum value appended');

    // Metadata flips to customized.
    assert.equal(db.prepare("SELECT value FROM kb_metadata WHERE key='has_customizations'").get().value, '1');
    assert.match(db.prepare("SELECT value FROM kb_metadata WHERE key='custom_packages_paths'").get().value, /Metadata/);

    db.close();
    assert.equal(summary.customizedTables, 1);
    assert.equal(summary.added.tables, 1);
  });

  it('reindexes kb_search for base objects that received custom members', () => {
    // A custom-only delta carries no kb_search row for a Microsoft object it
    // merely EXTENDS, so copying cust.kb_search leaves those rows stale and
    // d365_search never surfaces the merged members. Covers tables, enums and
    // entities. Regression: TBG_EstimatedChargesAmount was invisible to
    // d365_search after a delta merge even though the field row existed.
    const dir2 = mkdtempSync(join(tmpdir(), 'kb-merge-reindex-'));
    const liveP = join(dir2, 'live.sqlite');
    const custP = join(dir2, 'cust.sqlite');

    const live = new Database(liveP);
    live.exec(SCHEMA);
    live.prepare('INSERT INTO kb_metadata VALUES (?,?)').run('custom_packages_paths', '');
    live.prepare('INSERT INTO tables (table_name,module_id,label,developer_doc,field_count) VALUES (?,?,?,?,?)').run('WHSShipmentTable', 'ApplicationSuite', 'Shipments', 'Warehouse', 1);
    live.prepare('INSERT INTO fields (table_name,field_name,field_type,source_module,is_extension) VALUES (?,?,?,?,?)').run('WHSShipmentTable', 'ShipmentId', 'String', 'ApplicationSuite', 0);
    live.prepare('INSERT INTO enums VALUES (?,?,?,?)').run('WHSWorkType', 'ApplicationSuite', 'Work type', JSON.stringify([{ name: 'Pick', value: 0 }]));
    live.prepare('INSERT INTO data_entities (entity_name,module_id,label,public_name) VALUES (?,?,?,?)').run('CustCustomerV3Entity', 'ApplicationSuite', 'Customers', 'Customers');
    live.prepare('INSERT INTO entity_fields VALUES (?,?,?,?,?)').run('CustCustomerV3Entity', 'CustomerAccount', null, null, 0);
    // Pre-merge index rows — the state that used to survive the merge unchanged.
    live.prepare('INSERT INTO kb_search VALUES (?,?,?,?)').run('table', 'WHSShipmentTable', 'ApplicationSuite', 'Shipments Warehouse ShipmentId');
    live.prepare('INSERT INTO kb_search VALUES (?,?,?,?)').run('enum', 'WHSWorkType', 'ApplicationSuite', 'Work type Pick');
    live.prepare('INSERT INTO kb_search VALUES (?,?,?,?)').run('entity', 'CustCustomerV3Entity', 'ApplicationSuite', 'Customers Customers CustomerAccount');
    live.close();

    const cust = new Database(custP);
    cust.exec(SCHEMA);
    cust.prepare('INSERT INTO kb_metadata VALUES (?,?)').run('custom_packages_paths', 'C:\\Workspace\\DEV\\Metadata\\iExtension');
    // Extension field onto the base table, carrying a custom EDT.
    cust.prepare('INSERT INTO fields (table_name,field_name,field_type,edt,label,source_module,is_extension) VALUES (?,?,?,?,?,?,?)').run('WHSShipmentTable', 'TBG_EstimatedChargesAmount', 'Real', 'TBG_EstimatedChargesAmount', 'Estimated charges amount', 'iExtension', 1);
    // Enum value added to the MS enum.
    cust.prepare('INSERT INTO enums VALUES (?,?,?,?)').run('WHSWorkType', 'iExtension', null, JSON.stringify([{ name: 'TBG_Rework', value: 99 }]));
    // Entity extension: fields + a method, with NO data_entities row of its own.
    cust.prepare('INSERT INTO entity_fields VALUES (?,?,?,?,?)').run('CustCustomerV3Entity', 'TBG_CrmRef', null, null, 0);
    cust.prepare('INSERT INTO methods VALUES (?,?,?,?,?,?)').run('entity', 'CustCustomerV3Entity', 'tbgValidate', null, 0, 'public boolean tbgValidate() {}');
    cust.close();

    const summary = mergeCustomKb(liveP, custP, () => {});
    const db = new Database(liveP, { readonly: true });
    const contentOf = (type, name) => db.prepare('SELECT content FROM kb_search WHERE object_type=? AND object_name=?').get(type, name).content;

    const tbl = contentOf('table', 'WHSShipmentTable');
    assert.match(tbl, /TBG_EstimatedChargesAmount/, 'merged extension field is searchable');
    assert.match(tbl, /ShipmentId/, 'base field still indexed');
    assert.match(tbl, /Shipments/, 'table label still indexed');
    assert.match(tbl, /Estimated charges amount/, 'extension field label indexed');

    const enm = contentOf('enum', 'WHSWorkType');
    assert.match(enm, /TBG_Rework/, 'merged enum value is searchable');
    assert.match(enm, /Pick/, 'base enum value still indexed');

    const ent = contentOf('entity', 'CustCustomerV3Entity');
    assert.match(ent, /TBG_CrmRef/, 'merged entity field is searchable');
    assert.match(ent, /tbgValidate/, 'merged entity method is searchable');
    assert.match(ent, /CustomerAccount/, 'base entity field still indexed');

    // Exactly one row per object — reindex replaces, never duplicates.
    for (const [t, n] of [['table', 'WHSShipmentTable'], ['enum', 'WHSWorkType'], ['entity', 'CustCustomerV3Entity']]) {
      assert.equal(db.prepare('SELECT COUNT(*) n FROM kb_search WHERE object_type=? AND object_name=?').get(t, n).n, 1, `${t} ${n} not duplicated`);
    }

    assert.deepEqual(summary.reindexed, { tables: 1, enums: 1, entities: 1 });
    db.close();
    try { rmSync(dir2, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('does not invent kb_search rows for objects absent from the live KB', () => {
    // A delta may carry members for an object the base build never saw.
    const dir3 = mkdtempSync(join(tmpdir(), 'kb-merge-absent-'));
    const liveP = join(dir3, 'live.sqlite');
    const custP = join(dir3, 'cust.sqlite');

    const live = new Database(liveP);
    live.exec(SCHEMA);
    live.prepare('INSERT INTO kb_metadata VALUES (?,?)').run('custom_packages_paths', '');
    live.close();

    const cust = new Database(custP);
    cust.exec(SCHEMA);
    cust.prepare('INSERT INTO fields (table_name,field_name,field_type,source_module,is_extension) VALUES (?,?,?,?,?)').run('NeverBuiltTable', 'TBG_Orphan', 'String', 'iExtension', 1);
    cust.prepare('INSERT INTO entity_fields VALUES (?,?,?,?,?)').run('NeverBuiltEntity', 'TBG_Orphan', null, null, 0);
    cust.close();

    const summary = mergeCustomKb(liveP, custP, () => {});
    const db = new Database(liveP, { readonly: true });
    assert.equal(db.prepare("SELECT COUNT(*) n FROM kb_search WHERE object_name LIKE 'NeverBuilt%'").get().n, 0);
    assert.deepEqual(summary.reindexed, { tables: 0, enums: 0, entities: 0 });
    db.close();
    try { rmSync(dir3, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('refuses to merge into a pre-customization (older schema) KB', () => {
    const oldPath = join(dir, 'old.sqlite');
    const old = new Database(oldPath);
    old.exec('CREATE TABLE kb_metadata (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE tables (table_name TEXT PRIMARY KEY); CREATE TABLE fields (table_name TEXT, field_name TEXT);');
    old.close();
    assert.throws(() => mergeCustomKb(oldPath, custPath, () => {}), /predates customization|older schema|full KB/i);
  });
});
