/**
 * Semantic-layer tools (ADR W7 + W7b, issue #111) — the platform's first write
 * path. Exercises the four tools against an in-memory semantic DB and a small
 * in-memory KB, and replays the response-format static scans on
 * semantic-tools.js with the one documented exception: the two WRITE tools
 * declare WRITE_METADATA_ANNOTATIONS instead of READ_ONLY_DB_ANNOTATIONS.
 *
 * Run: node --test test/semantic-tools.test.js
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { z } from 'zod';

process.env.MCP_INSTALLATION_ID = 'test-tools';

import { registerSemanticTools, WRITE_METADATA_ANNOTATIONS } from '../src/azure/semantic-tools.js';
import { openSemanticDb } from '../src/azure/semantic-store.js';
import { READ_ONLY_DB_ANNOTATIONS } from '../src/azure/shared.js';
import {
  d365MapEntityOutput, d365MapDqRuleOutput, d365EntityMapOutput, d365DqRulesOutput,
} from '../src/azure/output-schemas.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(__dirname, '..', 'src', 'azure', 'semantic-tools.js'), 'utf-8');

let kbDb, semDb, handlers;

function createMockServer() {
  const h = {};
  return {
    registerTool: (name, config, handler) => {
      h[name] = { schema: config.inputSchema || {}, outputSchema: config.outputSchema, annotations: config.annotations, description: config.description, handler };
    },
    handlers: h,
  };
}

/** Full MCP result; Zod-validated input (format defaults to markdown unless given). */
async function call(name, args, { raw = false } = {}) {
  const t = handlers[name];
  if (!t) throw new Error(`Tool ${name} not registered`);
  const input = raw ? args : z.object(t.schema).parse({ format: 'markdown', ...args });
  return t.handler(input);
}

before(() => {
  kbDb = new Database(':memory:');
  kbDb.exec(`
    CREATE TABLE tables (table_name TEXT PRIMARY KEY, module_id TEXT);
    CREATE TABLE classes (class_name TEXT PRIMARY KEY, module_id TEXT);
    CREATE TABLE enums (enum_name TEXT PRIMARY KEY, module_id TEXT);
    CREATE TABLE kb_search (object_type TEXT, object_name TEXT, module_id TEXT, content TEXT);
    INSERT INTO tables VALUES ('SalesTable','ApplicationSuite'),('SalesLine','ApplicationSuite'),('CustTable','ApplicationSuite'),('CustInvoiceJour','ApplicationSuite');
    INSERT INTO classes VALUES ('SalesFormLetter','ApplicationSuite');
    INSERT INTO enums VALUES ('SalesStatus','ApplicationSuite');
    INSERT INTO kb_search VALUES ('Form','SalesTable','ApplicationSuite','...'),('Query','SalesUpdate','ApplicationSuite','...');
  `);
  semDb = openSemanticDb(':memory:');
  const server = createMockServer();
  registerSemanticTools(server, semDb, kbDb);
  handlers = server.handlers;
});

describe('static contract scan (semantic-tools.js)', () => {
  it('registers 4 tools via registerTool, each with outputSchema and annotations', () => {
    assert.doesNotMatch(SRC, /\bserver\.tool\(/);
    const calls = [...SRC.matchAll(/server\.registerTool\(\s*'([a-z0-9_]+)'/g)].map(m => m[1]);
    assert.deepEqual(calls, ['d365_map_entity', 'd365_map_dq_rule', 'd365_entity_map', 'd365_dq_rules']);
    const ann = (SRC.match(/\bannotations:\s*(READ_ONLY_DB_ANNOTATIONS|WRITE_METADATA_ANNOTATIONS)/g) || []).length;
    assert.equal(ann, calls.length);
    // Documented exception: exactly the two write tools carry the write constant.
    assert.equal((SRC.match(/annotations:\s*WRITE_METADATA_ANNOTATIONS/g) || []).length, 2);
    for (const name of calls) {
      assert.ok(handlers[name].outputSchema, `${name} lacks outputSchema`);
      assert.ok(handlers[name].annotations, `${name} lacks annotations`);
    }
    assert.equal(handlers.d365_map_entity.annotations, WRITE_METADATA_ANNOTATIONS);
    assert.equal(handlers.d365_map_dq_rule.annotations, WRITE_METADATA_ANNOTATIONS);
    assert.equal(handlers.d365_entity_map.annotations, READ_ONLY_DB_ANNOTATIONS);
    assert.equal(handlers.d365_dq_rules.annotations, READ_ONLY_DB_ANNOTATIONS);
    // Same forbidden patterns as test/response-format.test.js.
    assert.doesNotMatch(SRC, /(?:let\s+)?(?:out|text|body|md)\s*(?:=|\+=)\s*`#\s/);
    assert.doesNotMatch(SRC, /⚠️\s*Showing first/);
    assert.doesNotMatch(SRC, /textResult\([^)]*err\.message/);
    assert.doesNotMatch(SRC, /textResult\(\s*[`'"]No (results|rules|mappings)/);
    // format is passed straight through (rule #5), never normalised.
    assert.doesNotMatch(SRC, /format\s*===\s*'markdown'\s*\?/);
    assert.ok(SRC.includes('format: formatTextParam'));
  });

  it('WRITE_METADATA_ANNOTATIONS: not read-only, not destructive, idempotent, closed world, frozen', () => {
    assert.deepEqual({ ...WRITE_METADATA_ANNOTATIONS }, { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    assert.ok(Object.isFrozen(WRITE_METADATA_ANNOTATIONS));
    assert.ok(!SRC.includes("from './shared.js'") || !/export const WRITE_METADATA_ANNOTATIONS/.test(readFileSync(join(__dirname, '..', 'src', 'azure', 'shared.js'), 'utf-8')), 'write constant must not live in shared.js');
  });
});

describe('d365_map_entity (write)', () => {
  it('unknown entity → notFoundResult with suggestions', async () => {
    const r = await call('d365_map_entity', { entity_id: 'sales_odrer', objects: [{ type: 'table', name: 'SalesTable', role: 'header' }] });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /^## Entity not found/);
    assert.equal(r.structuredContent, undefined);
  });

  it('records objects, verifies against the KB, lists unverified ones, typed-first', async () => {
    const r = await call('d365_map_entity', {
      entity_id: 'sales_order',
      objects: [
        { type: 'table', name: 'SalesTable', role: 'header' },
        { type: 'table', name: 'salesline', role: 'line' },
        { type: 'class', name: 'SalesFormLetter', role: 'posting' },
        { type: 'table', name: 'CustInvoiceJour', role: 'posting' },
        { type: 'form', name: 'SalesTable', role: 'ui' },
        { type: 'table', name: 'NoSuchTable', role: 'reference' },
      ],
      note: 'Concluded while analysing the sales posting chain.',
    });
    assert.equal(r.isError, undefined);
    const typed = d365MapEntityOutput.parse(r.structuredContent);
    assert.equal(typed.inserted, 6);
    assert.equal(typed.source, 'assistant_inferred');
    assert.deepEqual(typed.unverified_objects, ['table:NoSuchTable']);
    assert.equal(typed.objects.find(o => o.object_name === 'SalesTable' && o.object_type === 'table').model, 'ApplicationSuite');
    assert.equal(typed.objects.find(o => o.object_type === 'form').verified, true, 'kb_search fallback');
    assert.match(r.content[0].text, /^## Entity map updated: sales_order/);
    assert.match(r.content[0].text, /verified=false/);
  });

  it('a repeat with confirmed_by_user raises confirmations and confidence (idempotent upsert)', async () => {
    const r = await call('d365_map_entity', { entity_id: 'sales_order', objects: [{ type: 'table', name: 'SalesTable', role: 'header' }], confirmed_by_user: true });
    const typed = d365MapEntityOutput.parse(r.structuredContent);
    assert.equal(typed.confirmed, 1);
    assert.equal(typed.objects[0].source, 'user_confirmed');
    assert.equal(typed.objects[0].confirmations, 1);
    assert.ok(typed.objects[0].confidence > 0.9);
    const again = await call('d365_map_entity', { entity_id: 'sales_order', objects: [{ type: 'table', name: 'SalesTable', role: 'header' }] });
    assert.equal(d365MapEntityOutput.parse(again.structuredContent).unchanged, 1);
    assert.equal(semDb.prepare("SELECT COUNT(*) n FROM sem_mappings WHERE object_name = 'SalesTable' AND object_type='table'").get().n, 1);
  });

  it('privacy: a note with an e-mail is rejected; invalid input is an errorResult', async () => {
    const r = await call('d365_map_entity', { entity_id: 'sales_order', objects: [{ type: 'table', name: 'SalesTable', role: 'header' }], note: 'ask someone@example.com' });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /^## Error/);
    const bad = await call('d365_map_entity', { entity_id: 'sales_order', objects: [] }, { raw: true });
    assert.equal(bad.isError, true);
  });

  it('the KB is never written by a mapping call', () => {
    assert.equal(kbDb.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name LIKE 'sem_%'").get().n, 0);
  });
});

describe('d365_map_dq_rule (write)', () => {
  it('rejects a spec with a sample value and a spec of the wrong shape', async () => {
    let r = await call('d365_map_dq_rule', { object_name: 'CustTable', field_name: 'AccountNum', dimension: 'completeness', spec: { type: 'not_null', sample: 'US-001' } });
    assert.equal(r.isError, true); assert.match(r.content[0].text, /literal data/);
    r = await call('d365_map_dq_rule', { object_name: 'CustTable', field_name: 'AccountNum', dimension: 'format', spec: { type: 'length' } });
    assert.equal(r.isError, true); assert.match(r.content[0].text, /format shape/);
    r = await call('d365_map_dq_rule', { dimension: 'completeness', spec: { type: 'not_null' } }, { raw: true });
    assert.equal(r.isError, true, 'needs entity_id or object_name');
    r = await call('d365_map_dq_rule', { entity_id: 'nope', object_name: 'CustTable', dimension: 'completeness', spec: { type: 'not_null' } });
    assert.equal(r.isError, true); assert.match(r.content[0].text, /not found/);
  });

  it('upserts: v1, unchanged on repeat, confirmed by user, v2 on enabled:false', async () => {
    const args = { entity_id: 'sales_order', object_name: 'SalesTable', field_name: 'CustAccount', dimension: 'referential_integrity', spec: { type: 'fk', to: 'CustTable.AccountNum', nullable: false }, severity: 'error' };
    let t = d365MapDqRuleOutput.parse((await call('d365_map_dq_rule', args)).structuredContent);
    assert.equal(t.action, 'inserted'); assert.equal(t.version, 1); assert.match(t.rule_id, /^dq_/);
    const id = t.rule_id;
    t = d365MapDqRuleOutput.parse((await call('d365_map_dq_rule', { ...args, spec: { nullable: false, to: 'CustTable.AccountNum', type: 'fk' } })).structuredContent);
    assert.equal(t.action, 'unchanged'); assert.equal(t.rule_id, id);
    t = d365MapDqRuleOutput.parse((await call('d365_map_dq_rule', { ...args, confirmed_by_user: true })).structuredContent);
    assert.equal(t.action, 'confirmed'); assert.equal(t.source, 'user_confirmed'); assert.equal(t.version, 1);
    const r = await call('d365_map_dq_rule', { ...args, enabled: false });
    t = d365MapDqRuleOutput.parse(r.structuredContent);
    assert.equal(t.action, 'versioned'); assert.equal(t.version, 2); assert.equal(t.enabled, false);
    assert.match(r.content[0].text, /^## DQ rule versioned: referential_integrity on SalesTable\.CustAccount/);
    // Re-enable → v3, still the same id (never a delete).
    t = d365MapDqRuleOutput.parse((await call('d365_map_dq_rule', args)).structuredContent);
    assert.equal(t.version, 3); assert.equal(t.enabled, true);
  });
});

describe('d365_entity_map (read)', () => {
  it('forward: grouped by role with provenance and related entities; TOON default text channel', async () => {
    const r = await call('d365_entity_map', { entity_id: 'sales_order' });
    const t = d365EntityMapOutput.parse(r.structuredContent);
    assert.equal(t.direction, 'forward');
    assert.equal(t.entity_name, 'Sales order');
    assert.ok(t.mapping_count >= 5);
    const header = t.by_role.find(g => g.role === 'header');
    assert.equal(header.objects[0].object_name, 'SalesTable');
    assert.equal(header.objects[0].confirmations, 1);
    assert.ok(t.by_role.some(g => g.role === 'posting' && g.objects.length === 2));
    assert.ok(t.related_entities.some(x => x.entity_id === 'customer' && x.direction === 'out'));
    assert.ok(t.related_entities.some(x => x.entity_id === 'sales_order_line' && x.direction === 'in'));
    assert.deepEqual(t.entities, []);
    assert.match(r.content[0].text, /^## Entity map: sales_order/);
    assert.match(r.content[0].text, /### header/);
    // Default format (undefined from a mock server) → adaptive; heading kept either way.
    const toon = await call('d365_entity_map', { entity_id: 'sales_order' }, { raw: true });
    assert.match(toon.content[0].text, /^## Entity map: sales_order/);
    assert.deepEqual(toon.structuredContent, r.structuredContent);
  });

  it('forward with min_confidence filters; an unmapped entity is an emptyResult WITH typed payload', async () => {
    const r = await call('d365_entity_map', { entity_id: 'sales_order', min_confidence: 0.95 });
    assert.equal(r.isError, undefined);
    assert.match(r.content[0].text, /^## No results/);
    const t = d365EntityMapOutput.parse(r.structuredContent);
    assert.equal(t.mapping_count, 0);
    const e = await call('d365_entity_map', { entity_id: 'fixed_asset' });
    assert.match(e.content[0].text, /^## No results/);
    assert.match(e.content[0].text, /d365_map_entity/);
  });

  it('reverse: object → entities; unknown object → emptyResult; unknown entity → notFound', async () => {
    const r = await call('d365_entity_map', { object_name: 'salestable' });
    const t = d365EntityMapOutput.parse(r.structuredContent);
    assert.equal(t.direction, 'reverse');
    assert.ok(t.entities.length >= 2, 'table + form mapping');
    assert.equal(t.entities[0].entity_id, 'sales_order');
    assert.equal(t.entities[0].entity_name, 'Sales order');
    assert.match(r.content[0].text, /^## Entity map: salestable → entities/);
    const none = await call('d365_entity_map', { object_name: 'InventTable' });
    assert.match(none.content[0].text, /^## No results/);
    assert.equal(none.structuredContent.mapping_count, 0);
    const nf = await call('d365_entity_map', { entity_id: 'sales' });
    assert.equal(nf.isError, true);
    assert.match(nf.content[0].text, /sales_order/);
    const bad = await call('d365_entity_map', {}, { raw: true });
    assert.equal(bad.isError, true);
  });
});

describe('d365_dq_rules (read)', () => {
  it('serves object-bound + entity-linked rules with provenance, filters, truncates with truncationNote', async () => {
    await call('d365_map_dq_rule', { object_name: 'SalesTable', field_name: 'SalesId', dimension: 'format', spec: { type: 'length', max: 20, edt: 'SalesIdBase' }, severity: 'error' });
    await call('d365_map_dq_rule', { entity_id: 'sales_order', dimension: 'timeliness', spec: { type: 'age', field: 'ModifiedDateTime', max_days: 365 }, severity: 'info' });
    const r = await call('d365_dq_rules', { object_name: 'SalesTable' });
    const t = d365DqRulesOutput.parse(r.structuredContent);
    assert.ok(t.rule_count >= 3);
    assert.ok(t.rules.some(x => x.dimension === 'format' && x.binding === 'object'));
    assert.ok(t.rules.some(x => x.dimension === 'timeliness' && x.binding === 'entity:sales_order'));
    assert.ok(t.rules.some(x => x.dimension === 'referential_integrity' && x.version === 3));
    assert.ok(t.by_dimension.length >= 3);
    assert.equal(t.truncated, false);
    assert.match(r.content[0].text, /^## DQ rules for object `SalesTable`/);
    assert.match(r.content[0].text, /served, not executed/);

    const lim = await call('d365_dq_rules', { object_name: 'SalesTable', limit: 1 });
    assert.equal(lim.structuredContent.truncated, true);
    assert.equal(lim.structuredContent.rules.length, 1);
    assert.match(lim.content[0].text, /Showing first 1 results \(caller `limit`\)/);

    const dim = await call('d365_dq_rules', { object_name: 'SalesTable', dimension: 'format' });
    assert.equal(dim.structuredContent.rule_count, 1);
    const sev = await call('d365_dq_rules', { entity_id: 'sales_order', min_severity: 'error' });
    assert.ok(sev.structuredContent.rules.every(x => x.severity === 'error'));
    assert.equal(sev.structuredContent.entity_id, 'sales_order');
  });

  it('empty and not-found paths', async () => {
    const e = await call('d365_dq_rules', { object_name: 'InventTable' });
    assert.equal(e.isError, undefined);
    assert.match(e.content[0].text, /^## No results/);
    assert.equal(d365DqRulesOutput.parse(e.structuredContent).rule_count, 0);
    const nf = await call('d365_dq_rules', { entity_id: 'zzz' });
    assert.equal(nf.isError, true);
    const bad = await call('d365_dq_rules', {}, { raw: true });
    assert.equal(bad.isError, true);
  });
});
