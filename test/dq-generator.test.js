/**
 * KB-derived DQ seed + dq_indicator SQL generator (ADR W7b, issue #111).
 *
 * A small in-memory KB fixture (CustTable / SalesTable / SalesLine with EDTs,
 * enums, unique indexes, relations and a data entity) is seeded into an
 * in-memory semantic DB; the export is rendered for both dialects; every
 * SQLite statement is executed against a data fixture to prove it parses and
 * yields the fixed contract columns.
 *
 * Run: node --test test/dq-generator.test.js
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

process.env.MCP_INSTALLATION_ID = 'test-gen';
process.env.MCP_ERP_SYSTEM = 'D365FO';

import { openSemanticDb, upsertMapping, upsertDqRule, rulesFor, exportSemantic, DQ_DIMENSIONS } from '../src/azure/semantic-store.js';
import { seedDqRules, toNum } from '../build/seed-dq-rules.js';
import { renderRule, renderExport, rowKeyFieldsFor, DIALECTS } from '../build/gen-dq-sql.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const CONTRACT = ['row_key', 'object_name', 'rule_id', 'dimension', 'severity', 'detail'];

let kbDb, semDb, exp;

before(() => {
  kbDb = new Database(':memory:');
  kbDb.exec(`
    CREATE TABLE tables (table_name TEXT PRIMARY KEY, module_id TEXT, label TEXT);
    CREATE TABLE fields (table_name TEXT, field_name TEXT, field_type TEXT, edt TEXT, enum_type TEXT, mandatory TEXT DEFAULT 'No', label TEXT, PRIMARY KEY (table_name, field_name));
    CREATE TABLE indexes_tbl (table_name TEXT, index_name TEXT, is_unique INTEGER, is_clustered INTEGER, fields_json TEXT);
    CREATE TABLE relations (source_table TEXT, relation_name TEXT, related_table TEXT, cardinality TEXT, related_cardinality TEXT, on_delete TEXT, relationship_type TEXT, constraints_json TEXT);
    CREATE TABLE enums (enum_name TEXT PRIMARY KEY, module_id TEXT, label TEXT, values_json TEXT);
    CREATE TABLE edts (edt_name TEXT PRIMARY KEY, base_type TEXT, extends_edt TEXT, label TEXT, string_size TEXT, table_ref TEXT, module_id TEXT);
    CREATE TABLE data_entities (entity_name TEXT PRIMARY KEY, module_id TEXT, label TEXT, public_name TEXT, primary_table TEXT, staging_table TEXT);
    CREATE TABLE entity_fields (entity_name TEXT, field_name TEXT, data_field TEXT, data_source TEXT, is_mandatory TEXT);

    INSERT INTO tables VALUES ('CustTable','ApplicationSuite',NULL),('SalesTable','ApplicationSuite',NULL),('SalesLine','ApplicationSuite',NULL),('CustGroup','ApplicationSuite',NULL);
    INSERT INTO edts VALUES ('CustAccount','String','AccountNum',NULL,NULL,'CustTable','AS'),('AccountNum','String',NULL,NULL,'20',NULL,'AS'),
      ('SalesIdBase','String','Num',NULL,NULL,NULL,'AS'),('Num','String',NULL,NULL,'20',NULL,'AS'),('Name','String',NULL,NULL,'100',NULL,'AS'),
      ('CustGroupId','String',NULL,NULL,'10',NULL,'AS'),('ItemId','String',NULL,NULL,'20',NULL,'AS'),('Qty','Real',NULL,NULL,NULL,NULL,'AS');
    INSERT INTO enums VALUES ('SalesStatus','AS',NULL,'[{"name":"None","value":0,"label":null},{"name":"Backorder","value":1,"label":null},{"name":"Delivered","value":2,"label":null},{"name":"Invoiced","value":3,"label":null}]'),
      ('CustVendorBlocked','AS',NULL,'[{"name":"No","value":0},{"name":"Invoice","value":1},{"name":"All","value":2}]');

    INSERT INTO fields VALUES ('CustTable','AccountNum','String','CustAccount',NULL,'Yes',NULL),('CustTable','CustGroup','String','CustGroupId',NULL,'Yes',NULL),
      ('CustTable','Blocked','Enum',NULL,'CustVendorBlocked','No',NULL),('CustTable','Name','String','Name',NULL,'No',NULL);
    INSERT INTO fields VALUES ('SalesTable','SalesId','String','SalesIdBase',NULL,'Yes',NULL),('SalesTable','CustAccount','String','CustAccount',NULL,'Yes',NULL),
      ('SalesTable','SalesStatus','Enum',NULL,'SalesStatus','No',NULL),('SalesTable','SalesQty','Real','Qty',NULL,'No',NULL);
    INSERT INTO fields VALUES ('SalesLine','SalesId','String','SalesIdBase',NULL,'Yes',NULL),('SalesLine','ItemId','String','ItemId',NULL,'Yes',NULL),('SalesLine','DataAreaId','String',NULL,NULL,'No',NULL);
    INSERT INTO fields VALUES ('CustGroup','CustGroup','String','CustGroupId',NULL,'Yes',NULL);

    INSERT INTO indexes_tbl VALUES ('CustTable','AccountIdx',1,0,'["AccountNum"]'),('CustTable','NameIdx',0,0,'["Name"]'),
      ('SalesTable','SalesIdx',1,1,'["SalesId"]'),('SalesLine','SalesLineIdx',1,0,'["SalesId","LineNum"]');
    INSERT INTO relations VALUES ('CustTable','CustGroup','CustGroup',NULL,NULL,NULL,'Association','[{"field":"CustGroup","relatedField":"CustGroup","type":"Field","fixedValue":null}]'),
      ('SalesTable','CustTable','CustTable',NULL,NULL,NULL,'Association','[{"field":"CustAccount","relatedField":"AccountNum","type":"Field","fixedValue":null}]'),
      ('SalesLine','SalesTable','SalesTable',NULL,NULL,NULL,'Composition','[{"field":"SalesId","relatedField":"SalesId","type":"Field","fixedValue":null},{"field":"DataAreaId","relatedField":"DataAreaId","type":"Field","fixedValue":null}]'),
      ('SalesLine','FixedOnly','InventTable',NULL,NULL,NULL,'Association','[{"field":"1","relatedField":null,"type":"RelatedFixed","fixedValue":"1"}]');
    INSERT INTO data_entities VALUES ('CustCustomerV3Entity','AS',NULL,'CustomerV3','CustTable','CustCustomerV3Staging');
    INSERT INTO entity_fields VALUES ('CustCustomerV3Entity','CustomerAccount','AccountNum','CustTable','1'),('CustCustomerV3Entity','CustomerGroupId','CustGroup','CustTable','1'),('CustCustomerV3Entity','OrganizationName','Name','CustTable','0');
  `);

  semDb = openSemanticDb(':memory:');
  // Map SalesTable before seeding so seeded rules get linked to sales_order.
  upsertMapping(semDb, { entity_id: 'sales_order', object_type: 'table', object_name: 'SalesTable', role: 'header', source: 'user_confirmed', verified: true });
  upsertMapping(semDb, { entity_id: 'customer', object_type: 'table', object_name: 'CustTable', role: 'master', source: 'user_confirmed', verified: true });
});

describe('seed-dq-rules', () => {
  it('yields kb_derived rules for ≥5 dimensions on CustTable/SalesTable/SalesLine, idempotently', () => {
    const r1 = seedDqRules(kbDb, semDb, { tables: ['custtable', 'SalesTable', 'SalesLine', 'NoSuchTable'] });
    assert.equal(r1.tables, 3);
    const dims = Object.keys(r1.by_dimension);
    assert.ok(dims.length >= 5, `dimensions: ${dims}`);
    for (const d of ['format', 'completeness', 'domain', 'uniqueness', 'referential_integrity', 'target_readiness']) {
      assert.ok(r1.by_dimension[d]?.inserted > 0, `no ${d} rules`);
    }
    assert.equal(r1.by_dimension.format.inserted, 7, 'EDT length via extends chain (CustAccount->AccountNum), Real EDT skipped');
    assert.equal(r1.by_dimension.uniqueness.inserted, 3);
    assert.equal(r1.by_dimension.referential_integrity.inserted, 3, 'fixed-value relation skipped');
    const r2 = seedDqRules(kbDb, semDb, { tables: ['CustTable', 'SalesTable', 'SalesLine'] });
    for (const [d, c] of Object.entries(r2.by_dimension)) {
      assert.equal(c.inserted, 0, `${d} re-inserted`);
      assert.equal(c.unchanged, r1.by_dimension[d].inserted, `${d} not unchanged`);
    }
    assert.equal(semDb.prepare('SELECT COUNT(*) n FROM sem_dq_rules WHERE source = ?').get('kb_derived').n,
      Object.values(r1.by_dimension).reduce((a, c) => a + c.inserted, 0));
    // The KB itself is untouched.
    assert.equal(kbDb.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name LIKE 'sem_%'").get().n, 0);
    assert.equal(toNum('20'), 20); assert.equal(toNum('Yes'), null); assert.equal(toNum(null), null);
  });

  it('seeded rules are linked to the mapped entity so d365_dq_rules(sales_order) sees them', () => {
    const rules = rulesFor(semDb, { entityId: 'sales_order' });
    assert.ok(rules.some(r => r.object_name === 'SalesTable' && r.dimension === 'completeness' && r.source === 'kb_derived'));
    const fk = rules.find(r => r.dimension === 'referential_integrity' && r.object_name === 'SalesTable');
    assert.deepEqual(JSON.parse(fk.spec), { nullable: true, to: 'CustTable.AccountNum', type: 'fk' });
    const dom = rulesFor(semDb, { objectName: 'SalesTable', dimension: 'domain' })[0];
    assert.deepEqual(JSON.parse(dom.spec).allowed, [0, 1, 2, 3]);
    const target = rulesFor(semDb, { objectName: 'CustTable', dimension: 'target_readiness' })[0];
    assert.deepEqual(JSON.parse(target.spec).mandatory_fields, ['AccountNum', 'CustGroup']);
    const compound = rulesFor(semDb, { objectName: 'SalesLine', dimension: 'referential_integrity' })[0];
    assert.equal(JSON.parse(compound.spec).pairs.length, 2);
  });
});

describe('gen-dq-sql', () => {
  before(() => {
    // Analyst rules for the three non-seedable dimensions + overrides.
    upsertDqRule(semDb, { entity_id: 'customer', object_name: 'CustTable', dimension: 'closeness', severity: 'warning', source: 'user_confirmed',
      spec: { type: 'similarity', fields: ['Name'], algorithm: 'jaro_winkler', threshold: 0.92, blocking: ['CustGroup'] } });
    const cons = upsertDqRule(semDb, { entity_id: 'sales_order', object_name: 'SalesTable', dimension: 'consistency', severity: 'error', source: 'user_confirmed',
      spec: { type: 'cross_field', expr: 'SalesQty >= 0' } });
    semDb.prepare('INSERT INTO sem_dq_dialect_overrides (rule_id, dialect, sql_fragment) VALUES (?, ?, ?)').run(cons.rule_id, 'tsql', 't.[SalesQty] < 0');
    upsertDqRule(semDb, { entity_id: 'sales_order', object_name: 'SalesTable', dimension: 'timeliness', severity: 'info', source: 'assistant_inferred',
      spec: { type: 'age', field: 'ModifiedDateTime', max_days: 365, when: 'SalesStatus = 1' } });
    upsertDqRule(semDb, { object_name: 'CustTable', field_name: 'AccountNum', dimension: 'format', severity: 'warning', source: 'user_confirmed',
      spec: { type: 'pattern', regex: '^[A-Z]{2}-[0-9]{3}$' } });
    upsertDqRule(semDb, { object_name: 'CustTable', field_name: 'Name', dimension: 'completeness', severity: 'warning', source: 'user_confirmed',
      spec: { type: 'not_in', values: ['', 'N/A', '.'] } });
    upsertDqRule(semDb, { object_name: 'SalesTable', field_name: 'SalesQty', dimension: 'domain', severity: 'warning', source: 'user_confirmed',
      spec: { type: 'range', min: 0, max: 1000000 } });
    upsertDqRule(semDb, { object_name: 'CustTable', dimension: 'target_readiness', severity: 'warning', source: 'user_confirmed',
      spec: { type: 'target', entity: 'CustCustomerV3Entity', checks: ['mandatory', 'key_unique', 'enum_map'], mandatory_fields: ['AccountNum'], key_fields: ['AccountNum'] } });
    exp = exportSemantic(semDb);
  });

  it('renders every one of the 9 dimensions for both dialects with the fixed contract columns', () => {
    for (const dialect of DIALECTS) {
      const { rendered, errors } = renderExport(exp, dialect);
      assert.deepEqual(errors, [], `${dialect}: ${JSON.stringify(errors)}`);
      const dims = new Set(rendered.map(r => r.dimension));
      assert.deepEqual([...dims].sort(), [...DQ_DIMENSIONS].sort(), `${dialect} misses a dimension`);
      for (const r of rendered) for (const s of r.statements) {
        for (const c of CONTRACT) assert.ok(s.sql.includes(` AS ${c}`), `${dialect} ${r.rule_id} lacks ${c}`);
        assert.ok(s.sql.startsWith('-- dq_indicator · rule dq_'));
        assert.ok(s.sql.trimEnd().endsWith(';'));
      }
    }
  });

  it('closeness degrades explicitly; consistency uses the override on tsql and expr verbatim on sqlite', () => {
    const close = renderExport(exp, 'tsql').rendered.find(r => r.dimension === 'closeness').statements[0];
    assert.equal(close.degraded, true);
    assert.match(close.sql, /-- degraded: jaro_winkler not available/);
    assert.match(close.sql, /DIFFERENCE\(d\.\[Name\], t\.\[Name\]\) >= 3/);
    assert.match(close.sql, /d\.\[CustGroup\] = t\.\[CustGroup\]/, 'blocking');
    const consT = renderExport(exp, 'tsql').rendered.find(r => r.dimension === 'consistency').statements[0];
    assert.match(consT.sql, /WHERE \(t\.\[SalesQty\] < 0\)/);
    assert.match(consT.sql, /consistency:cross_field:override/);
    const consS = renderExport(exp, 'sqlite').rendered.find(r => r.dimension === 'consistency').statements[0];
    assert.match(consS.sql, /WHERE NOT \(SalesQty >= 0\)/);
    const pat = renderExport(exp, 'tsql').rendered.find(r => r.dimension === 'format' && r.statements[0].sql.includes('RegexIsMatch'));
    assert.equal(pat.statements[0].degraded, true);
  });

  it('target_readiness renders one statement per check; unmappable checks are degraded, never silent', () => {
    const t = renderExport(exp, 'tsql').rendered.find(r => r.dimension === 'target_readiness' && r.statements.length === 3);
    assert.ok(t, 'analyst target rule with 3 checks');
    const details = t.statements.map(s => s.sql.match(/'(target_readiness:[^']+)' AS detail/)[1]);
    assert.deepEqual(details, ['target_readiness:target:CustCustomerV3Entity:mandatory', 'target_readiness:target:CustCustomerV3Entity:key_unique', 'target_readiness:target:CustCustomerV3Entity:enum_map']);
    assert.equal(t.statements[2].degraded, true);
    assert.match(t.statements[2].sql, /-- degraded: enum_map needs the target mapping table/);
    assert.equal(t.statements[0].degraded, false);
  });

  it('row_key: RecId for D365FO, unique-index columns for another ERP, NULL + degraded when none', () => {
    const rule = exp.dq_rules.find(r => r.object_name === 'CustTable' && r.dimension === 'completeness');
    assert.deepEqual(rowKeyFieldsFor(rule, exp), ['RecId']);
    assert.match(renderRule(rule, 'tsql', { export: exp }).statements[0].sql, /SELECT CAST\(t\.\[RecId\] AS NVARCHAR\(200\)\) AS row_key/);
    const m3 = { ...exp, erp_system: 'M3', dq_rules: exp.dq_rules.map(r => ({ ...r, erp_system: 'M3' })) };
    const m3rule = m3.dq_rules.find(r => r.object_name === 'SalesLine' && r.dimension === 'completeness');
    assert.deepEqual(rowKeyFieldsFor(m3rule, m3), ['SalesId', 'LineNum']);
    assert.match(renderRule(m3rule, 'sqlite', { export: m3 }).statements[0].sql, /SELECT t\."SalesId" \|\| '\|' \|\| t\."LineNum" AS row_key/);
    const none = renderRule({ ...m3rule, object_name: 'Orphan' }, 'sqlite', { export: m3 }).statements[0];
    assert.equal(none.degraded, true);
    assert.match(none.sql, /SELECT NULL AS row_key/);
  });

  it('a target_readiness rule for a D365 entity renders against an M3 object (cross-ERP contract)', () => {
    const rule = { rule_id: 'dq_m3target', version: 1, erp_system: 'M3', object_name: 'OCUSMA', dimension: 'target_readiness', severity: 'warning', source: 'user_confirmed',
      spec: { type: 'target', entity: 'CustCustomerV3Entity', checks: ['mandatory'], mandatory_fields: ['OKCUNO', 'OKCUCL'] } };
    const sql = renderRule(rule, 'tsql', { row_key_fields: ['OKCUNO'] }).statements[0].sql;
    assert.match(sql, /FROM \[OCUSMA\] t/);
    assert.match(sql, /\(t\.\[OKCUNO\] IS NULL OR LTRIM\(RTRIM\(t\.\[OKCUNO\]\)\) = ''\) OR \(t\.\[OKCUCL\] IS NULL/);
    assert.match(sql, /'target_readiness:target:CustCustomerV3Entity:mandatory' AS detail/);
  });

  it('refuses non-identifier names (no SQL injection through a spec) and reports per-rule errors', () => {
    assert.throws(() => renderRule({ rule_id: 'x', object_name: 'Cust]; DROP TABLE t; --', dimension: 'completeness', field_name: 'A', severity: 'error', spec: { type: 'not_null' } }, 'tsql'), /invalid object name/);
    assert.throws(() => renderRule({ rule_id: 'x', object_name: 'CustTable', dimension: 'uniqueness', severity: 'error', spec: { type: 'unique', fields: ['A"B'] } }, 'sqlite'), /invalid field/);
    assert.throws(() => renderRule({ rule_id: 'x', object_name: 'CustTable', dimension: 'completeness', severity: 'error', spec: { type: 'not_null' } }, 'sqlite'), /needs field_name/);
    const bad = { ...exp, dq_rules: [{ rule_id: 'dq_bad', object_name: 'Bad Name', dimension: 'completeness', field_name: 'A', severity: 'error', spec: { type: 'not_null' }, enabled: true }] };
    const { rendered, errors } = renderExport(bad, 'sqlite');
    assert.equal(rendered.length, 0); assert.equal(errors.length, 1);
    assert.throws(() => renderRule(exp.dq_rules[0], 'oracle'), /unknown dialect/);
  });

  it('every SQLite statement parses and executes against a data fixture, yielding the contract columns', () => {
    const data = new Database(':memory:');
    data.function('regexp', { deterministic: true }, (rx, v) => (v == null ? 0 : (new RegExp(rx).test(String(v)) ? 1 : 0)));
    data.exec(`
      CREATE TABLE CustTable (RecId INTEGER, AccountNum TEXT, CustGroup TEXT, Blocked INTEGER, Name TEXT, ModifiedDateTime TEXT);
      CREATE TABLE CustGroup (RecId INTEGER, CustGroup TEXT);
      CREATE TABLE SalesTable (RecId INTEGER, SalesId TEXT, CustAccount TEXT, SalesStatus INTEGER, SalesQty REAL, ModifiedDateTime TEXT, DataAreaId TEXT);
      CREATE TABLE SalesLine (RecId INTEGER, SalesId TEXT, ItemId TEXT, DataAreaId TEXT, LineNum REAL);
      INSERT INTO CustGroup VALUES (1,'10');
      INSERT INTO CustTable VALUES (1,'US-001','10',0,'Acme','2020-01-01'),(2,'US-002','10',7,' acme ','2026-09-01'),(3,'US-002','10',1,NULL,'2026-09-01'),(4,'THIS-ACCOUNT-IS-FAR-TOO-LONG-1234567890','10',1,'N/A','2026-09-01');
      INSERT INTO SalesTable VALUES (1,'SO-1','US-001',1,5,'2020-01-01','dat'),(2,'SO-2','NOPE',9,-1,'2026-09-01','dat'),(3,NULL,'US-001',2,1,'2026-09-01','dat');
      INSERT INTO SalesLine VALUES (1,'SO-1','A',  'dat',1),(2,'SO-1','A','dat',1),(3,'SO-9','B','dat',1),(4,'SO-2',NULL,'dat',2);
    `);
    const { rendered, errors } = renderExport(exp, 'sqlite');
    assert.deepEqual(errors, []);
    let executed = 0, flagged = 0;
    const seenDetail = new Set();
    for (const r of rendered) for (const s of r.statements) {
      const stmt = data.prepare(s.sql);
      assert.deepEqual(stmt.columns().map(c => c.name), CONTRACT, `${r.rule_id}: ${s.sql}`);
      const rows = stmt.all();
      executed++; flagged += rows.length;
      for (const row of rows) { assert.equal(row.rule_id, r.rule_id); assert.equal(row.dimension, r.dimension); seenDetail.add(row.detail.split(':')[0]); }
    }
    assert.ok(executed >= 25, `only ${executed} statements`);
    assert.ok(flagged > 0, 'fixture has deliberate violations');
    // Deliberate violations are caught: length, not_null, enum, unique, fk, range, cross_field, not_in, pattern, target mandatory, closeness.
    for (const d of ['format', 'completeness', 'domain', 'uniqueness', 'referential_integrity', 'consistency', 'target_readiness', 'closeness']) {
      assert.ok(seenDetail.has(d), `no row flagged for ${d}`);
    }
    // Specific expectations.
    const one = (dim, pred) => rendered.filter(r => r.dimension === dim && pred(r)).flatMap(r => r.statements).flatMap(s => data.prepare(s.sql).all());
    assert.deepEqual(one('uniqueness', r => r.object_name === 'CustTable').map(x => x.row_key).sort(), ['2', '3'], 'duplicate AccountNum US-002');
    assert.deepEqual(one('referential_integrity', r => r.object_name === 'SalesTable').map(x => x.row_key), ['2'], 'orphan CustAccount NOPE');
    assert.deepEqual(one('referential_integrity', r => r.object_name === 'SalesLine').map(x => x.row_key), ['3'], 'compound fk orphan SO-9');
    assert.deepEqual(one('domain', r => r.object_name === 'SalesTable' && r.statements[0].sql.includes('NOT IN')).map(x => x.row_key), ['2'], 'SalesStatus 9 not in enum');
    assert.deepEqual(one('closeness', () => true).map(x => x.row_key).sort(), ['1', '2'], 'Acme / " acme " in the same CustGroup block');
  });
});
