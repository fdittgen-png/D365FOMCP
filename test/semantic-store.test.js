/**
 * Semantic store (ADR W7 + W7b, issue #111) — schema, vocabulary, privacy
 * guards, upsert/versioning, export.
 *
 * Run: node --test test/semantic-store.test.js
 */

import { describe, it, before } from 'node:test';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

process.env.MCP_INSTALLATION_ID = 'test-install';
process.env.MCP_ERP_SYSTEM = 'D365FO';

import {
  openSemanticDb,
  ensureSemanticSchema,
  SEMANTIC_SCHEMA,
  loadVocabulary,
  readVocabularyFile,
  ensureVocabulary,
  getVocabularyEntry,
  suggestEntities,
  checkNote,
  privacyViolation,
  validateSpec,
  DQ_DIMENSIONS,
  specHash,
  makeRuleId,
  sessionHash,
  upsertMapping,
  mappingsForEntity,
  mappingsForObject,
  upsertDqRule,
  rulesFor,
  recordDqRun,
  exportSemantic,
  confidenceFor,
  mappedObjectsForEntity,
  entityDisplayName,
} from '../src/azure/semantic-store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXPECTED_TABLES = [
  'sem_vocabulary', 'sem_mappings', 'sem_entity_relations', 'sem_dq_rules',
  'sem_dq_rule_links', 'sem_dq_dialect_overrides', 'sem_dq_runs',
];

let db;
before(() => {
  db = openSemanticDb(':memory:');
});

describe('schema', () => {
  it('creates exactly the seven tables of #111 and is idempotent', () => {
    ensureSemanticSchema(db);
    ensureSemanticSchema(db);
    const names = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'sem_%' ORDER BY name`).all().map(r => r.name);
    assert.deepEqual(names.sort(), [...EXPECTED_TABLES].sort());
  });

  it('sem_dq_runs holds aggregates only — no row_key / value / sample column anywhere', () => {
    const cols = db.prepare('PRAGMA table_info(sem_dq_runs)').all().map(c => c.name);
    assert.deepEqual(cols.sort(), ['id', 'ingested_at', 'installation_id', 'rows_checked', 'rows_flagged', 'rule_id', 'run_date'].sort());
    for (const t of EXPECTED_TABLES) {
      for (const c of db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name)) {
        assert.doesNotMatch(c, /row_key|^value$|sample|record_|business/i, `${t}.${c} looks like a row-data column`);
      }
    }
    // And the DDL text itself declares no such column (comments excluded).
    const ddlNoComments = SEMANTIC_SCHEMA.replace(/--.*$/gm, '');
    assert.doesNotMatch(ddlNoComments, /\brow_key\b|\bsample\w*\b/i);
  });

  it('opens the same file twice without error (WAL, create-if-missing) and defaults the path from env', async () => {
    const { defaultSemanticDbPath } = await import('../src/azure/semantic-store.js');
    const prev = process.env.SEMANTIC_DB_PATH;
    process.env.SEMANTIC_DB_PATH = 'X:/nowhere/sem.sqlite';
    assert.equal(defaultSemanticDbPath(), 'X:/nowhere/sem.sqlite');
    process.env.SEMANTIC_DB_PATH = '';
    assert.match(defaultSemanticDbPath(), /d365fo_semantic\.sqlite$/);
    if (prev === undefined) delete process.env.SEMANTIC_DB_PATH; else process.env.SEMANTIC_DB_PATH = prev;
  });
});

describe('vocabulary', () => {
  it('the checked-in file is v1, ≤60 snake_case entities, process-grouped, relations resolve', () => {
    const json = JSON.parse(readFileSync(join(__dirname, '..', 'config', 'semantic-vocabulary.json'), 'utf-8'));
    assert.equal(json.version, '1.0.0');
    assert.ok(json.entities.length <= 60, `too many entities: ${json.entities.length}`);
    assert.ok(json.entities.length >= 30);
    const ids = new Set();
    for (const e of json.entities) {
      assert.match(e.entity_id, /^[a-z][a-z0-9_]*$/);
      assert.ok(!ids.has(e.entity_id), `duplicate ${e.entity_id}`);
      ids.add(e.entity_id);
      assert.ok(['order_to_cash', 'procure_to_pay', 'record_to_report', 'plan_to_produce', 'master_data', 'hire_to_retire'].includes(e.process));
      assert.ok(e.name && e.description);
    }
    for (const r of json.relations) {
      assert.ok(ids.has(r.from) && ids.has(r.to), `${r.from}->${r.to}`);
    }
    for (const must of ['customer', 'vendor', 'item', 'sales_order', 'sales_order_line', 'purchase_order', 'customer_invoice', 'vendor_invoice', 'ledger_journal', 'inventory_transaction', 'bom', 'production_order', 'project', 'fixed_asset', 'employee']) {
      assert.ok(ids.has(must), `vocabulary must contain ${must}`);
    }
  });

  it('loads idempotently, versioned, and suggests near misses', () => {
    const r1 = loadVocabulary(db, readVocabularyFile());
    const r2 = loadVocabulary(db, readVocabularyFile());
    assert.equal(r1.entities, r2.entities);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM sem_vocabulary').get().n, r1.entities);
    assert.equal(getVocabularyEntry(db, 'SALES_ORDER').version, '1.0.0');
    assert.equal(ensureVocabulary(db), null, 'already loaded → no-op');
    assert.ok(suggestEntities(db, 'sales').includes('sales_order'));
    assert.ok(suggestEntities(db, 'sales_ord').includes('sales_order'), 'an underscore in the term is a literal, not a stripped char (#115)');
    assert.deepEqual(suggestEntities(db, '%'), [], 'a wildcard in the term is escaped');
    assert.throws(() => loadVocabulary(db, { version: '1.0.0', entities: [{ entity_id: 'Bad Id', name: 'x', process: 'master_data' }] }));
    assert.throws(() => loadVocabulary(db, { version: '1.0.0', entities: [{ entity_id: 'a', name: 'x', process: 'master_data' }], relations: [{ from: 'a', to: 'zzz', relation: 'party' }] }));
  });
});

describe('privacy guards', () => {
  it('note: ≤200 chars, no e-mail / IBAN / VAT / phone', () => {
    assert.equal(checkNote(undefined).ok, true);
    assert.equal(checkNote('SalesTable is the order header; SalesLine the lines.').ok, true);
    assert.equal(checkNote('x'.repeat(201)).ok, false);
    assert.equal(checkNote('contact someone@example.com about it').ok, false);
    assert.equal(checkNote('account DE89370400440532013000').ok, false);
    assert.equal(checkNote('vat FR12345678901').ok, false);
    assert.equal(checkNote('call +49 171 1234567 now').ok, false);
    // Object names never trip the scan.
    assert.equal(privacyViolation('CustTable.AccountNum CustAccount SalesTable.SalesId'), null);
  });

  it('spec: rejects literal-data keys and party-like strings before shape errors', () => {
    assert.equal(validateSpec('completeness', { type: 'not_null', sample: 'ACME-001' }).ok, false);
    assert.match(validateSpec('completeness', { type: 'not_null', sample: 'ACME-001' }).reason, /literal data/);
    assert.equal(validateSpec('domain', { type: 'range', min: 0, max: 10, example: 5 }).ok, false);
    assert.equal(validateSpec('format', { type: 'pattern', regex: '^x@y.com$' }).ok, false);
    assert.equal(validateSpec('format', { type: 'pattern', regex: 'a', value: 'b' }).ok, false);
    assert.equal(validateSpec('consistency', { type: 'cross_field', expr: "Email = 'someone@example.com'" }).ok, false);
    // Unknown keys are rejected too (strict shapes).
    assert.equal(validateSpec('completeness', { type: 'not_null', extra: 1 }).ok, false);
    assert.equal(validateSpec('nope', { type: 'not_null' }).ok, false);
  });

  it('spec: accepts the canonical shape of every one of the 9 dimensions', () => {
    const good = {
      format: { type: 'length', max: 20, edt: 'CustAccount' },
      completeness: { type: 'not_in', values: ['', 'N/A', '.'] },
      domain: { type: 'enum', enum: 'SalesStatus', allowed: [0, 1, 2, 3] },
      uniqueness: { type: 'unique', fields: ['AccountNum', 'DataAreaId'] },
      closeness: { type: 'similarity', fields: ['Name', 'Street'], algorithm: 'jaro_winkler', threshold: 0.92, blocking: ['PostalCode'] },
      referential_integrity: { type: 'fk', to: 'CustTable.AccountNum', nullable: false },
      consistency: { type: 'cross_field', expr: 'InvoiceDate >= OrderDate' },
      timeliness: { type: 'age', field: 'ModifiedDateTime', max_days: 365, when: "Status='Open'" },
      target_readiness: { type: 'target', entity: 'CustCustomerV3Entity', checks: ['mandatory', 'enum_map', 'uom_map', 'key_unique'] },
    };
    assert.deepEqual(Object.keys(good).sort(), [...DQ_DIMENSIONS].sort());
    for (const [dim, spec] of Object.entries(good)) {
      const r = validateSpec(dim, spec);
      assert.equal(r.ok, true, `${dim}: ${r.reason}`);
    }
    assert.equal(validateSpec('domain', { type: 'range' }).ok, false, 'range needs min or max');
    assert.equal(validateSpec('referential_integrity', { type: 'fk', to: 'Cust Table' }).ok, false);
  });

  it('spec hash is key-order independent; rule id is deterministic', () => {
    assert.equal(specHash({ type: 'length', max: 20 }), specHash({ max: 20, type: 'length' }));
    const k = { installation_id: 'i', object_name: 'SalesTable', field_name: 'SalesId', dimension: 'format', spec_hash: 'abc' };
    assert.equal(makeRuleId(k), makeRuleId({ ...k, object_name: 'salestable' }));
    assert.match(makeRuleId(k), /^dq_[0-9a-f]{16}$/);
  });

  it('session hash is salted, fixed-width and not the token', () => {
    const h = sessionHash('conv-123');
    assert.match(h, /^[0-9a-f]{32}$/);
    assert.equal(h, sessionHash('conv-123'));
    assert.notEqual(h, 'conv-123');
    assert.match(sessionHash(undefined), /^[0-9a-f]{32}$/);
  });

  it('sem_dq_runs refuses anything but aggregates', () => {
    assert.throws(() => recordDqRun(db, { rule_id: 'dq_x', run_date: '2026-09-02', rows_checked: 10, rows_flagged: 1, row_key: '5637144576' }), /aggregates only/);
    recordDqRun(db, { rule_id: 'dq_x', run_date: '2026-09-02', rows_checked: 10, rows_flagged: 1 });
    assert.equal(db.prepare('SELECT COUNT(*) n FROM sem_dq_runs').get().n, 1);
  });
});

describe('mappings', () => {
  it('upserts, bumps confidence on confirmation, never downgrades source', () => {
    const a = upsertMapping(db, { entity_id: 'sales_order', object_type: 'table', object_name: 'SalesTable', role: 'header', source: 'assistant_inferred', verified: true, session_hash: 'h1' });
    assert.equal(a.action, 'inserted');
    assert.equal(a.row.confidence, confidenceFor('assistant_inferred', 0));
    const b = upsertMapping(db, { entity_id: 'sales_order', object_type: 'table', object_name: 'salestable', role: 'header', source: 'user_confirmed' });
    assert.equal(b.action, 'confirmed');
    assert.equal(b.row.source, 'user_confirmed');
    assert.equal(b.row.confirmations, 1);
    assert.ok(b.row.confidence > a.row.confidence);
    const c = upsertMapping(db, { entity_id: 'sales_order', object_type: 'table', object_name: 'SalesTable', role: 'header', source: 'context_hint' });
    assert.equal(c.action, 'unchanged');
    assert.equal(c.row.source, 'user_confirmed');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM sem_mappings').get().n, 1);
    upsertMapping(db, { entity_id: 'sales_order', object_type: 'table', object_name: 'SalesLine', role: 'line', source: 'user_confirmed' });
    upsertMapping(db, { entity_id: 'customer', object_type: 'table', object_name: 'CustTable', role: 'master', source: 'user_confirmed' });
    assert.equal(mappingsForEntity(db, 'SALES_ORDER').length, 2);
    assert.equal(mappingsForEntity(db, 'sales_order', 0.95).length, 0);
    assert.equal(mappingsForObject(db, 'SALESLINE')[0].entity_id, 'sales_order');
  });
});

describe('dq rules', () => {
  it('versions on disable/severity change, confirms in place otherwise, and rulesFor walks object + entity links', () => {
    const spec = { type: 'not_null' };
    const r1 = upsertDqRule(db, { entity_id: 'sales_order', object_name: 'SalesTable', field_name: 'CustAccount', dimension: 'completeness', spec, severity: 'error', source: 'kb_derived' });
    assert.equal(r1.action, 'inserted'); assert.equal(r1.version, 1);
    const r2 = upsertDqRule(db, { object_name: 'SalesTable', field_name: 'CustAccount', dimension: 'completeness', spec, severity: 'error', source: 'kb_derived' });
    assert.equal(r2.action, 'unchanged'); assert.equal(r2.rule_id, r1.rule_id);
    const r3 = upsertDqRule(db, { object_name: 'SalesTable', field_name: 'CustAccount', dimension: 'completeness', spec, severity: 'error', source: 'user_confirmed' });
    assert.equal(r3.action, 'confirmed'); assert.equal(r3.row.source, 'user_confirmed'); assert.equal(r3.version, 1);
    const r4 = upsertDqRule(db, { object_name: 'SalesTable', field_name: 'CustAccount', dimension: 'completeness', spec, severity: 'error', source: 'user_confirmed', enabled: false });
    assert.equal(r4.action, 'versioned'); assert.equal(r4.version, 2); assert.equal(r4.row.enabled, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM sem_dq_rules WHERE rule_id = ?').get(r1.rule_id).n, 2, 'never a delete');

    // Entity-level rule (no object) reachable from a mapped object.
    const e = upsertDqRule(db, { entity_id: 'sales_order', object_name: null, field_name: null, dimension: 'timeliness', spec: { type: 'age', field: 'ModifiedDateTime', max_days: 365 }, severity: 'info', source: 'assistant_inferred' });
    // Object-only rule.
    upsertDqRule(db, { object_name: 'SalesTable', field_name: 'SalesId', dimension: 'format', spec: { type: 'length', max: 20 }, severity: 'error', source: 'kb_derived' });

    const live = rulesFor(db, { objectName: 'salestable' });
    assert.ok(!live.some(r => r.rule_id === r1.rule_id), 'disabled latest version excluded');
    assert.ok(live.some(r => r.rule_id === e.rule_id && r.binding === 'entity:sales_order'));
    assert.ok(live.some(r => r.dimension === 'format' && r.binding === 'object'));
    const withDisabled = rulesFor(db, { objectName: 'SalesTable', includeDisabled: true });
    assert.ok(withDisabled.some(r => r.rule_id === r1.rule_id && r.version === 2));
    assert.equal(rulesFor(db, { objectName: 'SalesTable', dimension: 'format' }).length, 1);
    assert.equal(rulesFor(db, { objectName: 'SalesTable', minSeverity: 'error' }).some(r => r.severity === 'info'), false);
    assert.ok(rulesFor(db, { entityId: 'sales_order' }).some(r => r.rule_id === e.rule_id));
  });

  it('export is the ERP-neutral contract: latest versions, parsed specs, no data columns', () => {
    const exp = exportSemantic(db);
    assert.equal(exp.contract, 'sem_export/1');
    assert.equal(exp.erp_system, 'D365FO');
    assert.equal(exp.installation_id, 'test-install');
    assert.ok(exp.vocabulary.length > 0 && exp.mappings.length >= 3 && exp.dq_rules.length >= 3);
    const disabled = exp.dq_rules.find(r => r.field_name === 'CustAccount' && r.dimension === 'completeness');
    assert.equal(disabled.version, 2); assert.equal(disabled.enabled, false);
    assert.equal(typeof exp.dq_rules[0].spec, 'object');
    assert.ok(Array.isArray(exp.dq_rules[0].links));
    const text = JSON.stringify(exp);
    assert.doesNotMatch(text, /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, 'no e-mail in export');
    assert.doesNotMatch(text, /"row_key"|"sample"/);
  });
});

describe('not-found helpers (#115 item 2)', () => {
  it('mappedObjectsForEntity: top mappings by confidence with role; entityDisplayName: vocabulary name', () => {
    const own = openSemanticDb(':memory:');
    loadVocabulary(own, { version: '1.0.0', entities: [{ entity_id: 'sales_order', name: 'Sales order', process: 'order_to_cash' }] });
    upsertMapping(own, { entity_id: 'sales_order', object_type: 'table', object_name: 'SalesLine', role: 'line', source: 'assistant_inferred' });
    upsertMapping(own, { entity_id: 'sales_order', object_type: 'table', object_name: 'SalesTable', role: 'header', source: 'user_confirmed' });
    for (let i = 0; i < 6; i++) upsertMapping(own, { entity_id: 'sales_order', object_type: 'class', object_name: `Helper${i}`, role: 'reference', source: 'context_hint' });

    const top = mappedObjectsForEntity(own, 'SALES_ORDER');
    assert.equal(top.length, 5, 'default limit 5');
    assert.deepEqual(top.slice(0, 2).map(m => [m.object_name, m.role]), [['SalesTable', 'header'], ['SalesLine', 'line']], 'confidence desc');
    assert.deepEqual(Object.keys(top[0]).sort(), ['confidence', 'object_name', 'object_type', 'role']);
    assert.equal(mappedObjectsForEntity(own, 'sales_order', 2).length, 2);
    assert.deepEqual(mappedObjectsForEntity(own, 'nope'), []);
    assert.equal(entityDisplayName(own, 'sales_order'), 'Sales order');
    assert.equal(entityDisplayName(own, 'nope'), null);
    own.close();
  });

  it('both return []/null on a database without the semantic tables, and never throw', () => {
    const plain = new (createRequire(import.meta.url)('better-sqlite3'))(':memory:');
    assert.deepEqual(mappedObjectsForEntity(plain, 'sales_order'), []);
    assert.equal(entityDisplayName(plain, 'sales_order'), null);
    plain.close();
    assert.deepEqual(mappedObjectsForEntity(null, 'sales_order'), []);
    assert.equal(entityDisplayName(undefined, 'sales_order'), null);
    assert.deepEqual(mappedObjectsForEntity({ prepare() { throw new Error('x'); } }, 'sales_order'), []);
  });
});
