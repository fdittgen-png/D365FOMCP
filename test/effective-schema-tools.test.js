/**
 * d365_effective_schema (issue #85): the merged base + extension view of a
 * table, every field attributed, sealed-ISV extensions reported by name.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { z } from 'zod';

import { registerKbTools } from '../src/azure/kb-tools.js';
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
      return t.handler({ format: 'markdown', ...args });
    },
  };
}

function kbDb({ withIsv = true } = {}) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE tables (table_name TEXT PRIMARY KEY, module_id TEXT, label TEXT, table_group TEXT,
      save_per_company INTEGER, cache_lookup TEXT, clustered_index TEXT, replacement_key TEXT, field_count INTEGER, is_customized INTEGER DEFAULT 0);
    CREATE TABLE fields (table_name TEXT, field_name TEXT, field_type TEXT, edt TEXT, enum_type TEXT, mandatory TEXT,
      label TEXT, source_module TEXT, is_extension INTEGER DEFAULT 0, PRIMARY KEY (table_name, field_name));
    CREATE TABLE indexes_tbl (table_name TEXT, index_name TEXT, is_unique INTEGER, is_clustered INTEGER, fields_json TEXT);
    CREATE TABLE relations (source_table TEXT, related_table TEXT, relation_name TEXT, constraints_json TEXT, relationship_type TEXT, on_delete TEXT);
    CREATE TABLE labels (label_id TEXT PRIMARY KEY, text TEXT);
    CREATE TABLE model_versions (model_name TEXT PRIMARY KEY, module_id TEXT, display_name TEXT, publisher TEXT, layer TEXT, origin TEXT, version TEXT, source_root TEXT);

    INSERT INTO tables VALUES ('CustTable','ApplicationSuite','@SYS1','Main',1,'Found','AccountIdx','AccountNum',4,1);
    INSERT INTO labels VALUES ('@SYS1','Customers');
    INSERT INTO fields VALUES ('CustTable','AccountNum','String','CustAccount',NULL,'1',NULL,'Foundation',0);
    INSERT INTO fields VALUES ('CustTable','CustGroup','String','CustGroupId',NULL,'0',NULL,'Foundation',0);
    INSERT INTO fields VALUES ('CustTable','TBG_CrmRef','String','TIS_CrmRef',NULL,'0',NULL,'iExtension',1);
    INSERT INTO fields VALUES ('CustTable','HIS_Region','Enum',NULL,'HIS_Region','0',NULL,'HISOL',1);
    INSERT INTO indexes_tbl VALUES ('CustTable','AccountIdx',1,1,'["AccountNum"]');
    INSERT INTO relations VALUES ('CustTable','CustGroup','CustGroupRel','[{"field":"CustGroup","relatedField":"CustGroup"}]','Association','Restricted');
    INSERT INTO model_versions VALUES ('Foundation','ApplicationSuite','Application Suite','Microsoft Corporation','SYS','microsoft','10.0.2263.172','C:\\pkg');
    INSERT INTO model_versions VALUES ('iExtension','iExtension','iExtension','Trelleborg','USR','custom','10.0.32.7','C:\\custom');
    INSERT INTO model_versions VALUES ('HISOL','HISOL','HISOL','HiSol','ISV','isv','1.0.0.1','C:\\hisol');
  `);
  if (withIsv) {
    ensureIsvSchema(db, 'kb');
    db.exec(`
      INSERT INTO isv_models (model, publisher, version, layer, source_kind, fidelity, depends_on, root, scanned_at, counts)
      VALUES ('Lasernet','Formpipe','7.2',NULL,'sealed','metadata','[]','r','2026-08-31T00:00:00.000Z','{}');
      INSERT INTO isv_extends (module, kind, child, parent) VALUES
        ('Lasernet','table','CustTable_LAC','CustTable'),
        ('Lasernet','class','LACQueryItem_Query','LACQueryItem');
      INSERT INTO isv_elements (module, element_type, name, blob_size) VALUES
        ('Lasernet','AxTableExtension','CustTable.LACExtension',120),
        ('Lasernet','AxTableExtension','SalesTable.LACExtension',80);
      INSERT INTO isv_delete_actions (module, table_name, target, relation, action)
      VALUES ('Lasernet','CustTable','LACCustSetup','CustTable','Cascade');
    `);
  }
  return db;
}

describe('d365_effective_schema', () => {
  let s, db;
  before(() => { db = kbDb(); s = mockServer(); registerKbTools(s, db); });
  after(() => db.close());

  it('is registered through registerKbTools (tool-sets.js untouched)', () => {
    assert.ok(s.tools.has('d365_effective_schema'));
    assert.ok(s.tools.has('d365_lookup_table'), 'the existing KB tools are still registered');
  });

  it('merges base + custom + ISV-source extension fields, each row attributed (origin / module / model_origin on EVERY row)', async () => {
    const r = await s.call('d365_effective_schema', { table_name: 'custtable' });
    const t = r.structuredContent;
    assert.equal(t.table_name, 'CustTable');
    assert.equal(t.label, 'Customers', 'labels are resolved');
    assert.equal(t.model_origin, 'microsoft');
    assert.equal(t.field_count, 4);
    assert.equal(t.base_field_count, 2);
    assert.equal(t.extension_field_count, 2);
    for (const f of t.fields) {
      assert.ok(['base', 'extension'].includes(f.origin));
      assert.ok('module' in f && 'model_origin' in f, `${f.name}: attribution keys on every row`);
    }
    const crm = t.fields.find(f => f.name === 'TBG_CrmRef');
    assert.deepEqual([crm.origin, crm.module, crm.model_origin], ['extension', 'iExtension', 'custom']);
    const his = t.fields.find(f => f.name === 'HIS_Region');
    assert.deepEqual([his.origin, his.module, his.model_origin], ['extension', 'HISOL', 'isv']);
    const base = t.fields.find(f => f.name === 'AccountNum');
    assert.deepEqual([base.origin, base.module, base.model_origin], ['base', 'Foundation', 'microsoft']);
    assert.deepEqual(t.contributing_models.map(m => [m.module, m.field_count]),
      [['Foundation', 2], ['HISOL', 1], ['iExtension', 1]]);
    assert.equal(t.indexes.length, 1);
    assert.equal(t.relations[0].on_delete, 'Restricted');
    assert.doesNotThrow(() => z.object(s.tools.get('d365_effective_schema').config.outputSchema).parse(t));
  });

  it('reports sealed-ISV table extensions by name (union of .runtime descriptors and the element inventory) with provenance', async () => {
    const r = await s.call('d365_effective_schema', { table_name: 'CustTable' });
    const t = r.structuredContent;
    assert.deepEqual(t.isv_extensions, [
      { module: 'Lasernet', extension_name: 'CustTable_LAC' },
      { module: 'Lasernet', extension_name: 'CustTable.LACExtension' },
    ], 'the SalesTable extension and the class row are not included');
    assert.equal(t.isv_delete_actions.length, 1);
    assert.equal(t.isv_provenance.fidelity, 'metadata');
    assert.match(r.content[0].text, /Sealed ISV table extensions \(2\)/);
    assert.match(r.content[0].text, /not a field list/);
  });

  it('include_isv=false omits the isv keys entirely (not empty arrays)', async () => {
    const r = await s.call('d365_effective_schema', { table_name: 'CustTable', include_isv: false });
    const t = r.structuredContent;
    assert.ok(!('isv_extensions' in t) && !('isv_delete_actions' in t) && !('isv_provenance' in t));
    assert.equal(t.field_count, 4, 'the KB-source extension fields (custom AND source-shipping ISV) stay');
    assert.doesNotMatch(r.content[0].text, /Sealed ISV/);
  });

  it('modules scopes the extension surface; base fields always stay', async () => {
    const r = await s.call('d365_effective_schema', { table_name: 'CustTable', modules: ['iExtension'] });
    const t = r.structuredContent;
    assert.deepEqual(t.fields.map(f => f.name), ['AccountNum', 'CustGroup', 'TBG_CrmRef']);
    assert.equal(t.extension_field_count, 1);
    assert.deepEqual(t.isv_extensions, [], 'Lasernet is out of scope');
  });

  it('field_limit caps the list; counts stay whole-table; defensive default without Zod', async () => {
    const r = await s.call('d365_effective_schema', { table_name: 'CustTable', field_limit: 2 });
    assert.equal(r.structuredContent.fields.length, 2);
    assert.equal(r.structuredContent.field_count, 4);
    assert.equal(r.structuredContent.fields_truncated, true);
    assert.match(r.content[0].text, /Showing first 2 results/);
    const bad = await s.call('d365_effective_schema', { table_name: 'CustTable', field_limit: 0 });
    assert.equal(bad.structuredContent.fields.length, 4);
  });

  it('an unknown table is a not-found error with suggestions', async () => {
    const r = await s.call('d365_effective_schema', { table_name: 'Cust' });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /CustTable/);
  });

  it('opens with exactly one H2 (rule #3)', async () => {
    const r = await s.call('d365_effective_schema', { table_name: 'CustTable' });
    assert.match(r.content[0].text, /^## Effective schema: CustTable\n/);
  });
});

describe('d365_effective_schema on a pre-ISV database', () => {
  it('answers from the KB alone and emits no isv keys, no error', async () => {
    const db = kbDb({ withIsv: false });
    const s = mockServer();
    registerKbTools(s, db);
    const r = await s.call('d365_effective_schema', { table_name: 'CustTable' });
    assert.ok(!r.isError);
    assert.equal(r.structuredContent.field_count, 4);
    assert.ok(!('isv_extensions' in r.structuredContent));
    assert.doesNotThrow(() => z.object(s.tools.get('d365_effective_schema').config.outputSchema).parse(r.structuredContent));
    db.close();
  });
});
