/**
 * Authoring-loop read tools (#123–#128, src/azure/authoring-tools.js).
 * In-memory schema-1.2 fixture + a pre-1.2 fixture for the degradation paths.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import { z } from 'zod';
import { registerAuthoringTools, analyzeSignature, parseKnowledgeFile, loadKnowledge, OBJECT_META_TYPES } from '../src/azure/authoring-tools.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

function mockServer() {
  const handlers = {};
  return {
    registerTool: (name, config, handler) => { handlers[name] = { schema: config.inputSchema, outputSchema: config.outputSchema, annotations: config.annotations, handler }; },
    handlers,
    async call(name, args) {
      const t = handlers[name];
      if (!t) throw new Error(`not registered: ${name}`);
      return t.handler(z.object(t.schema).parse({ format: 'markdown', ...args }));
    },
  };
}

const SCHEMA_12 = `
  CREATE TABLE tables (table_name TEXT PRIMARY KEY, module_id TEXT, label TEXT);
  CREATE TABLE fields (table_name TEXT, field_name TEXT, field_type TEXT, edt TEXT, enum_type TEXT, mandatory INTEGER, label TEXT, is_extension INTEGER DEFAULT 0, source_module TEXT);
  CREATE TABLE classes (class_name TEXT PRIMARY KEY, module_id TEXT, extends_class TEXT, implements_list TEXT, is_abstract INTEGER, method_count INTEGER, file_path TEXT);
  CREATE TABLE methods (owner_type TEXT, owner_name TEXT, method_name TEXT, signature TEXT, is_static INTEGER, source_code TEXT, PRIMARY KEY(owner_type, owner_name, method_name));
  CREATE TABLE data_entities (entity_name TEXT PRIMARY KEY, module_id TEXT, label TEXT);
  CREATE TABLE enums (enum_name TEXT PRIMARY KEY, module_id TEXT, label TEXT, values_json TEXT);
  CREATE TABLE edts (edt_name TEXT PRIMARY KEY, module_id TEXT, label TEXT);
  CREATE TABLE views (view_name TEXT PRIMARY KEY, module_id TEXT, label TEXT);
  CREATE TABLE forms (form_name TEXT PRIMARY KEY, module_id TEXT, label TEXT, data_sources_json TEXT, file_path TEXT, pattern TEXT, pattern_version TEXT, controls_count INTEGER);
  CREATE TABLE form_controls (form_name TEXT, control_name TEXT, control_type TEXT, pattern TEXT, pattern_version TEXT, data_source TEXT, data_field TEXT, parent_control TEXT, PRIMARY KEY(form_name, control_name));
  CREATE TABLE objects_meta (object_type TEXT, object_name TEXT, module_id TEXT, label TEXT, properties_json TEXT, file_path TEXT, PRIMARY KEY(object_type, object_name));
  CREATE TABLE object_paths (object_type TEXT, object_name TEXT, file_path TEXT, file_size INTEGER, PRIMARY KEY(object_type, object_name));
  CREATE TABLE menu_items (menu_item_name TEXT, menu_item_type TEXT, module_id TEXT, label TEXT, object_name TEXT, object_type TEXT, config_key TEXT, PRIMARY KEY(menu_item_name, menu_item_type));
  CREATE TABLE labels (label_id TEXT, language TEXT DEFAULT 'en-US', text TEXT, label_file TEXT, module TEXT, PRIMARY KEY(label_id, language));
  CREATE TABLE model_versions (model_name TEXT PRIMARY KEY, module_id TEXT, display_name TEXT, publisher TEXT, layer TEXT, origin TEXT, version TEXT, source_root TEXT);
  CREATE TABLE kb_metadata (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE isv_models (module TEXT PRIMARY KEY, publisher TEXT, version TEXT, scanned_at TEXT);
  CREATE TABLE isv_elements (id INTEGER PRIMARY KEY, module TEXT, element_type TEXT, name TEXT, blob_size INTEGER, fidelity TEXT DEFAULT 'metadata');
  CREATE TABLE isv_coc (module TEXT, extension_class TEXT, target TEXT, target_type TEXT, method TEXT, is_static INTEGER);

  INSERT INTO model_versions VALUES ('Foundation','ApplicationSuite','Application Suite','Microsoft Corporation','SYS','microsoft','10.0.2645.90',NULL);
  INSERT INTO model_versions VALUES ('iExtension','iExtension','iExtension','Trelleborg','ISV','custom','1.0.0.0',NULL);
  INSERT INTO kb_metadata VALUES ('build_date','2026-09-03T00:00:00Z');
  INSERT INTO kb_metadata VALUES ('schema_version','1.2');

  INSERT INTO tables VALUES ('CustTable','ApplicationSuite','@SYS1');
  INSERT INTO tables VALUES ('SalesTable','ApplicationSuite','@SYS2');
  INSERT INTO fields VALUES ('CustTable','AccountNum','String','CustAccount',NULL,1,NULL,0,NULL);
  INSERT INTO fields VALUES ('CustTable','TRBRating','String',NULL,NULL,0,NULL,1,'iExtension');
  INSERT INTO classes VALUES ('SalesFormLetter','ApplicationSuite','RunBaseBatch',NULL,1,3,NULL);
  INSERT INTO classes VALUES ('SalesFormLetter_iExt_Extension','iExtension',NULL,NULL,0,1,NULL);
  INSERT INTO classes VALUES ('CustVendTable','ApplicationSuite',NULL,NULL,0,1,NULL);
  INSERT INTO data_entities VALUES ('CustCustomerV3Entity','ApplicationSuite','@SYS3');
  INSERT INTO methods VALUES ('class','SalesFormLetter','run','public void run()',0,'{\n  super();\n}');
  INSERT INTO methods VALUES ('class','SalesFormLetter','validateWrite','protected boolean validateWrite()',0,'{\n return true;\n}');
  INSERT INTO methods VALUES ('class','SalesFormLetter','secret','private void secret()',0,'{}');
  INSERT INTO methods VALUES ('class','SalesFormLetter','locked','[Hookable(false)] public void locked()',0,'{}');
  INSERT INTO methods VALUES ('class','SalesFormLetter','construct','public static SalesFormLetter construct(DocumentStatus _s)',1,'{}');
  INSERT INTO methods VALUES ('class','SalesFormLetter_iExt_Extension','validateWrite','public boolean validateWrite()',0,'{ next validateWrite(); }');
  INSERT INTO methods VALUES ('table','CustTable','validateWrite','public boolean validateWrite()',0,'{\n boolean ret = super();\n return ret;\n}');
  INSERT INTO methods VALUES ('entity','CustCustomerV3Entity','validateWrite','public boolean validateWrite()',0,'{ return super(); }');
  INSERT INTO forms VALUES ('CustTable','ApplicationSuite','@SYS1','["CustTable","DirPartyTable"]',NULL,'DetailsMaster','1.3',3);
  INSERT INTO forms VALUES ('CustGroup','ApplicationSuite',NULL,'["CustGroup"]',NULL,'SimpleList','1.1',1);
  INSERT INTO forms VALUES ('CustTableListPage','ApplicationSuite',NULL,'["CustTable"]',NULL,'ListPage','1.0',0);
  INSERT INTO form_controls VALUES ('CustTable','Tab','AxFormTabControl',NULL,NULL,NULL,NULL,NULL);
  INSERT INTO form_controls VALUES ('CustTable','GeneralTab','AxFormTabPageControl','FieldsFieldGroups','1.0',NULL,NULL,'Tab');
  INSERT INTO form_controls VALUES ('CustTable','CustTable_AccountNum','AxFormStringControl',NULL,NULL,'CustTable','AccountNum','GeneralTab');
  INSERT INTO form_controls VALUES ('CustGroup','Grid','AxFormGridControl',NULL,NULL,'CustGroup',NULL,NULL);
  INSERT INTO menu_items VALUES ('CustTable','Display','ApplicationSuite','@SYS1','CustTable','Form',NULL);
  INSERT INTO menu_items VALUES ('CustTableListPage','Display','ApplicationSuite',NULL,'CustTableListPage','Form',NULL);
  INSERT INTO menu_items VALUES ('CustBalance','Output','ApplicationSuite',NULL,'CustBalance','SSRSReport',NULL);
  INSERT INTO objects_meta VALUES ('query','CustTableListPage','ApplicationSuite',NULL,'{"tables":["CustTable"],"data_source_count":1}',NULL);
  INSERT INTO objects_meta VALUES ('report','CustBalance','ApplicationSuite',NULL,'{"data_sets":[{"name":"DS","query":"CustBalanceDP","type":"Report data provider"}],"designs":["Report"],"design_count":1}',NULL);
  INSERT INTO objects_meta VALUES ('security_policy','CustTableByCompany','ApplicationSuite','@SYS4','{"primary_table":"CustTable","constrained_tables":["CustTrans"]}',NULL);
  INSERT INTO object_paths VALUES ('table','CustTable','x',1);
  INSERT INTO object_paths VALUES ('class','SalesFormLetter','x',1);
  INSERT INTO labels VALUES ('@SYS1','en-US','Customers','SYS','ApplicationSuite');
  INSERT INTO labels VALUES ('@SYS1','de','Debitoren','SYS','ApplicationSuite');
  INSERT INTO labels VALUES ('@SYS4','en-US','Customers by company','SYS','ApplicationSuite');
  INSERT INTO isv_models VALUES ('Lasernet','Formpipe','7.2','2026-09-01');
  INSERT INTO isv_elements VALUES (1,'Lasernet','AxClass','LACPrintService',10,'metadata');
  INSERT INTO isv_coc VALUES ('Lasernet','LAC_SalesFormLetter_Extension','SalesFormLetter','class','run',0);
`;

const SCHEMA_11 = `
  CREATE TABLE tables (table_name TEXT PRIMARY KEY, module_id TEXT, label TEXT);
  CREATE TABLE fields (table_name TEXT, field_name TEXT, field_type TEXT, edt TEXT, enum_type TEXT, mandatory INTEGER, label TEXT);
  CREATE TABLE classes (class_name TEXT PRIMARY KEY, module_id TEXT, extends_class TEXT, implements_list TEXT, is_abstract INTEGER, method_count INTEGER, file_path TEXT);
  CREATE TABLE methods (owner_type TEXT, owner_name TEXT, method_name TEXT, signature TEXT, is_static INTEGER, source_code TEXT, PRIMARY KEY(owner_type, owner_name, method_name));
  CREATE TABLE data_entities (entity_name TEXT PRIMARY KEY, module_id TEXT, label TEXT);
  CREATE TABLE forms (form_name TEXT PRIMARY KEY, module_id TEXT, label TEXT, data_sources_json TEXT, file_path TEXT);
  CREATE TABLE menu_items (menu_item_name TEXT, menu_item_type TEXT, module_id TEXT, label TEXT, object_name TEXT, object_type TEXT, config_key TEXT, PRIMARY KEY(menu_item_name, menu_item_type));
  CREATE TABLE labels (label_id TEXT PRIMARY KEY, text TEXT);
  CREATE TABLE kb_metadata (key TEXT PRIMARY KEY, value TEXT);
  INSERT INTO forms VALUES ('CustTable','ApplicationSuite',NULL,'["CustTable"]',NULL);
  INSERT INTO methods VALUES ('table','CustTable','validateWrite','public boolean validateWrite()',0,'{}');
`;

let s12, s11;
before(() => {
  const db12 = new Database(':memory:'); db12.exec(SCHEMA_12);
  s12 = mockServer(); registerAuthoringTools(s12, db12);
  const db11 = new Database(':memory:'); db11.exec(SCHEMA_11);
  s11 = mockServer(); registerAuthoringTools(s11, db11);
});

describe('registration contract', () => {
  it('registers the six tools with outputSchema + read-only annotations', () => {
    const names = Object.keys(s12.handlers).sort();
    assert.deepEqual(names, ['d365_find_forms', 'd365_find_method_implementations', 'd365_knowledge', 'd365_lookup_form', 'd365_lookup_object', 'd365_preflight']);
    for (const t of Object.values(s12.handlers)) {
      assert.ok(t.outputSchema, 'outputSchema');
      assert.equal(t.annotations.readOnlyHint, true);
    }
  });
});

describe('d365_find_method_implementations (#125)', () => {
  it('lists every owner of the method with module, origin and line count — no source', async () => {
    const r = await s12.call('d365_find_method_implementations', { method_name: 'validatewrite' });
    const t = r.structuredContent;
    assert.equal(t.owner_count, 4);
    assert.deepEqual(t.implementations.map(i => `${i.owner_type}:${i.owner_name}`),
      ['class:SalesFormLetter', 'class:SalesFormLetter_iExt_Extension', 'entity:CustCustomerV3Entity', 'table:CustTable']);
    const ct = t.implementations.find(i => i.owner_name === 'CustTable');
    assert.equal(ct.module_id, 'ApplicationSuite');
    assert.equal(ct.model_origin, 'microsoft');
    assert.equal(ct.source_lines, 4);
    assert.equal(t.implementations.find(i => i.owner_name === 'SalesFormLetter_iExt_Extension').model_origin, 'custom');
    assert.ok(!JSON.stringify(t).includes('super();'), 'tier 1 carries no source');
    assert.match(r.content[0].text, /^## Implementations of validatewrite \(4\)/);
  });
  it('exclude_extensions drops *_Extension owners; owner_type and modules scope', async () => {
    const a = await s12.call('d365_find_method_implementations', { method_name: 'validateWrite', exclude_extensions: true });
    assert.equal(a.structuredContent.owner_count, 3);
    const b = await s12.call('d365_find_method_implementations', { method_name: 'validateWrite', owner_type: 'table' });
    assert.deepEqual(b.structuredContent.implementations.map(i => i.owner_name), ['CustTable']);
    const c = await s12.call('d365_find_method_implementations', { method_name: 'validateWrite', modules: ['iExtension'] });
    assert.deepEqual(c.structuredContent.implementations.map(i => i.owner_name), ['SalesFormLetter_iExt_Extension']);
  });
  it('paginates with has_more/next_cursor and returns emptyResult for an unknown method', async () => {
    const p1 = await s12.call('d365_find_method_implementations', { method_name: 'validateWrite', limit: 3 });
    assert.equal(p1.structuredContent.has_more, true);
    const p2 = await s12.call('d365_find_method_implementations', { method_name: 'validateWrite', limit: 3, cursor: p1.structuredContent.next_cursor });
    assert.equal(p2.structuredContent.has_more, false);
    assert.equal(p2.structuredContent.implementations.length, 1);
    const e = await s12.call('d365_find_method_implementations', { method_name: 'noSuchMethod' });
    assert.equal(e._meta.kind, 'empty');
    assert.equal(e.structuredContent.owner_count, 0);
  });
});

describe('d365_lookup_object (#123)', () => {
  it('returns type-specific properties and the menu items pointing at the object', async () => {
    const r = await s12.call('d365_lookup_object', { object_type: 'report', object_name: 'custbalance' });
    const t = r.structuredContent;
    assert.equal(t.object_name, 'CustBalance');
    assert.equal(t.properties.data_sets[0].query, 'CustBalanceDP');
    assert.deepEqual(t.menu_items, [{ menu_item_name: 'CustBalance', menu_item_type: 'Output' }]);
    assert.match(r.content[0].text, /^## report: CustBalance/);
  });
  it('resolves labels and reports origin; misses are notFoundResult with near names', async () => {
    const r = await s12.call('d365_lookup_object', { object_type: 'security_policy', object_name: 'CustTableByCompany' });
    assert.equal(r.structuredContent.label, 'Customers by company');
    assert.equal(r.structuredContent.model_origin, 'microsoft');
    const miss = await s12.call('d365_lookup_object', { object_type: 'security_policy', object_name: 'CustTableByCompani' });
    assert.equal(miss.isError, true);
    assert.match(miss.content[0].text, /CustTableByCompany/);
  });
  it('names the rebuild on a pre-1.2 snapshot instead of crashing', async () => {
    const r = await s11.call('d365_lookup_object', { object_type: 'query', object_name: 'X' });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /objects_meta/);
  });
  it('OBJECT_META_TYPES is the enum the builder writes', () => {
    assert.deepEqual([...OBJECT_META_TYPES].sort(), ['config_key', 'macro', 'map', 'menu', 'query', 'report', 'security_policy', 'service', 'service_group']);
  });
});

describe('d365_lookup_form (#124)', () => {
  it('returns pattern, data sources, menu items and — on request — the control tree', async () => {
    const r = await s12.call('d365_lookup_form', { form_name: 'custtable' });
    const t = r.structuredContent;
    assert.equal(t.pattern, 'DetailsMaster');
    assert.equal(t.pattern_version, '1.3');
    assert.equal(t.patterns_indexed, true);
    assert.deepEqual(t.data_sources, ['CustTable', 'DirPartyTable']);
    assert.equal(t.controls_count, 3);
    assert.equal(t.menu_items.length, 1);
    assert.equal('controls' in t, false, 'controls only on request (rule #14)');
    const c = await s12.call('d365_lookup_form', { form_name: 'CustTable', include_controls: true });
    assert.equal(c.structuredContent.controls.length, 3);
    assert.equal(c.structuredContent.controls[2].data_field, 'AccountNum');
    assert.equal(c.structuredContent.controls[2].parent, 'GeneralTab');
  });
  it('controls_like filters by control name or bound field and implies include_controls', async () => {
    const r = await s12.call('d365_lookup_form', { form_name: 'CustTable', controls_like: 'accountnum' });
    assert.deepEqual(r.structuredContent.controls.map(c => c.name), ['CustTable_AccountNum']);
  });
  it('degrades on a pre-1.2 snapshot: patterns_indexed false, no crash; unknown form is notFound', async () => {
    const r = await s11.call('d365_lookup_form', { form_name: 'CustTable', include_controls: true });
    assert.equal(r.structuredContent.patterns_indexed, false);
    assert.equal(r.structuredContent.pattern, null);
    assert.equal(r.structuredContent.controls_count, null);
    const miss = await s12.call('d365_lookup_form', { form_name: 'NoSuchForm' });
    assert.equal(miss.isError, true);
  });
});

describe('d365_find_forms (#124)', () => {
  it('with no filter returns the pattern catalogue with counts and an example', async () => {
    const r = await s12.call('d365_find_forms', {});
    const t = r.structuredContent;
    assert.equal(t.mode, 'patterns');
    assert.deepEqual(t.patterns.map(p => [p.pattern, p.form_count]), [['DetailsMaster', 1], ['ListPage', 1], ['SimpleList', 1]]);
    assert.equal(t.patterns[0].example_form, 'CustTable');
  });
  it('filters by pattern and by table (JSON data-source match, case-insensitive)', async () => {
    const byTable = await s12.call('d365_find_forms', { table: 'custtable' });
    assert.deepEqual(byTable.structuredContent.forms.map(f => f.form_name), ['CustTable', 'CustTableListPage']);
    const both = await s12.call('d365_find_forms', { table: 'CustTable', pattern: 'ListPage' });
    assert.deepEqual(both.structuredContent.forms.map(f => f.form_name), ['CustTableListPage']);
    assert.equal(both.structuredContent.has_more, false);
    const none = await s12.call('d365_find_forms', { pattern: 'Dialog' });
    assert.equal(none._meta.kind, 'empty');
  });
  it('on a pre-1.2 snapshot the pattern axis is refused with the rebuild hint; table filter still works', async () => {
    const p = await s11.call('d365_find_forms', { pattern: 'DetailsMaster' });
    assert.equal(p.isError, true);
    const t = await s11.call('d365_find_forms', { table: 'CustTable' });
    assert.equal(t.structuredContent.forms.length, 1);
    assert.equal(t.structuredContent.forms[0].pattern, null);
  });
});

describe('analyzeSignature — the Microsoft wrappability table', () => {
  const cases = [
    ['public void run()', 'public', true],
    ['protected boolean validateWrite()', 'protected', true],
    ['private void secret()', 'private', false],
    ['internal static boolean exist(Id _id)', 'internal', false],
    ['[Hookable(false)] public void locked()', 'public', false],
    ['[Wrappable(false)] public void doSomething(str m)', 'public', false],
    ['public final void sealed()', 'public', false],
    ['[Wrappable(true)] protected final container regulate(Amount _a)', 'protected', true],
    ['protected internal void pu25()', 'protected internal', true],
    ['void noModifier()', null, true],
  ];
  for (const [sig, vis, wrappable] of cases) {
    it(`${sig} → ${vis ?? 'default'} / coc ${wrappable}`, () => {
      const a = analyzeSignature(sig);
      assert.equal(a.visibility, vis);
      assert.equal(a.coc_wrappable, wrappable, a.coc_reason);
    });
  }
  it('flags static, abstract, Replaceable and the attribute values', () => {
    const a = analyzeSignature('[Replaceable, Hookable(true)] public static abstract void x()');
    assert.equal(a.is_static, true); assert.equal(a.is_abstract, true); assert.equal(a.replaceable, true); assert.equal(a.hookable, true);
  });
});

describe('d365_preflight (#126)', () => {
  it('object + method: existence, origin, CoC verdict, existing wrappers incl. sealed ISV', async () => {
    const r = await s12.call('d365_preflight', { object_name: 'salesformletter', method_name: 'run' });
    const t = r.structuredContent;
    assert.equal(t.object.exists, true);
    assert.equal(t.object.object_type, 'class');
    assert.equal(t.object.object_name, 'SalesFormLetter');
    assert.equal(t.object.model_origin, 'microsoft');
    assert.equal(t.method.coc_wrappable, true);
    assert.deepEqual(t.existing_extensions.classes.map(c => c.class_name), ['SalesFormLetter_iExt_Extension']);
    assert.deepEqual(t.existing_extensions.sealed_isv_coc, [{ module: 'Lasernet', extension_class: 'LAC_SalesFormLetter_Extension', method: 'run' }]);
    assert.match(t.verdict, /CoC-wrappable/);
    assert.match(r.content[0].text, /^## Preflight: salesformletter\.run/);
  });
  it('private and [Hookable(false)] methods are reported NOT wrappable with the reason', async () => {
    const a = await s12.call('d365_preflight', { object_name: 'SalesFormLetter', method_name: 'secret' });
    assert.equal(a.structuredContent.method.coc_wrappable, false);
    assert.match(a.structuredContent.method.coc_reason, /private/);
    const b = await s12.call('d365_preflight', { object_name: 'SalesFormLetter', method_name: 'locked' });
    assert.match(b.structuredContent.method.coc_reason, /Hookable\(false\)/);
    const c = await s12.call('d365_preflight', { object_name: 'SalesFormLetter', method_name: 'runn' });
    assert.equal(c.structuredContent.method.exists, false);
    assert.deepEqual(c.structuredContent.method.suggestions, ['run']);
  });
  it('a table reports its extension models; a sealed-ISV-only object is named as such; an unknown object gets suggestions', async () => {
    const t = await s12.call('d365_preflight', { object_type: 'table', object_name: 'CustTable' });
    assert.deepEqual(t.structuredContent.existing_extensions.table_extension_models, ['iExtension']);
    const isv = await s12.call('d365_preflight', { object_name: 'LACPrintService' });
    assert.equal(isv.structuredContent.object.exists, false);
    assert.deepEqual(isv.structuredContent.object.sealed_isv, [{ module: 'Lasernet', element_type: 'AxClass' }]);
    assert.match(isv.structuredContent.verdict, /sealed ISV/);
    const miss = await s12.call('d365_preflight', { object_name: 'CustTabel' });
    assert.equal(miss.structuredContent.object.exists, false);
    assert.ok(miss.structuredContent.object.suggestions.includes('CustTable'));
  });
  it('proposed_names: collisions across KB, menu items, catalogue and sealed ISV; prefix rule from KB_NAMING_PREFIXES', async () => {
    const prev = process.env.KB_NAMING_PREFIXES;
    process.env.KB_NAMING_PREFIXES = 'TRB,iExt';
    try {
      const r = await s12.call('d365_preflight', { proposed_names: ['CustTable', 'TRBNewTable', 'LACPrintService', 'custbalance', '9Bad', 'TRBNewTable'] });
      const t = r.structuredContent;
      assert.equal('object' in t, false);
      assert.deepEqual(t.naming_prefixes, ['TRB', 'iExt']);
      const by = Object.fromEntries(t.proposed_names.map(p => [p.name, p]));
      assert.equal(Object.keys(by).length, 5, 'deduped');
      assert.deepEqual(by.CustTable.collisions.map(c => c.object_type).sort(), ['menu_item_display', 'table']);
      assert.equal(by.CustTable.prefix_ok, false);
      assert.deepEqual(by.TRBNewTable.collisions, []);
      assert.equal(by.TRBNewTable.prefix_ok, true);
      assert.equal(by.LACPrintService.collisions[0].source, 'sealed-isv');
      assert.ok(by.custbalance.collisions.some(c => c.object_type === 'report'));
      assert.equal(by['9Bad'].valid_identifier, false);
      assert.match(t.verdict, /4 of 5 proposed name\(s\) need attention/);
    } finally {
      if (prev === undefined) delete process.env.KB_NAMING_PREFIXES; else process.env.KB_NAMING_PREFIXES = prev;
    }
  });
  it('without KB_NAMING_PREFIXES the prefix verdict is null, and no input at all is invalid-input', async () => {
    const prev = process.env.KB_NAMING_PREFIXES;
    delete process.env.KB_NAMING_PREFIXES;
    try {
      const r = await s12.call('d365_preflight', { proposed_names: ['Anything'] });
      assert.equal(r.structuredContent.proposed_names[0].prefix_ok, null);
      assert.equal(r.structuredContent.naming_prefixes, null);
    } finally { if (prev !== undefined) process.env.KB_NAMING_PREFIXES = prev; }
    const e = await s12.call('d365_preflight', {});
    assert.equal(e.isError, true);
  });
});

describe('d365_knowledge (#128)', () => {
  it('parses frontmatter + body; the repo rulebook loads with ≥ 10 topics', () => {
    const k = parseKnowledgeFile('---\ntopic: x\ntitle: The X\naliases: a, b\ntags: t1,t2\n---\nBody here', 'fallback');
    assert.deepEqual(k, { topic: 'x', title: 'The X', aliases: ['a', 'b'], tags: ['t1', 't2'], sources: [], body: 'Body here' });
    const all = loadKnowledge();
    assert.ok(all.length >= 10, `${all.length} topics`);
    assert.ok(all.every(e => e.topic && e.title && e.body.length > 100));
  });
  it('lists topics, resolves an exact topic and an alias, ranks keyword hits, misses with emptyResult', async () => {
    const list = await s12.call('d365_knowledge', {});
    assert.ok(list.structuredContent.topic_count >= 10);
    assert.equal('body' in list.structuredContent, false);
    const exact = await s12.call('d365_knowledge', { topic: 'coc-rules' });
    assert.equal(exact.structuredContent.topic, 'coc-rules');
    assert.match(exact.structuredContent.body, /next/);
    assert.match(exact.content[0].text, /^## Chain of Command/);
    const alias = await s12.call('d365_knowledge', { topic: 'Wrappable' });
    assert.equal(alias.structuredContent.topic, 'extensibility-attributes');
    const kw = await s12.call('d365_knowledge', { topic: 'crossCompany changecompany' });
    assert.equal(kw.structuredContent.topics[0].topic, 'crosscompany-select');
    assert.ok(kw.structuredContent.topics[0].score > 0);
    const miss = await s12.call('d365_knowledge', { topic: 'zzqx' });
    assert.equal(miss._meta.kind, 'empty');
  });
  it('a test seam directory with no files lists zero topics (emptyResult), never throws', async () => {
    const s = mockServer();
    registerAuthoringTools(s, new Database(':memory:'), { knowledgeDir: 'C:/definitely/not/here' });
    const r = await s.call('d365_knowledge', {});
    assert.equal(r._meta.kind, 'empty');
  });
});
