/**
 * Trace Insight tools (src/azure/insight-tools.js) — d365_prior_art and
 * d365_entity_insight against a snapshot built from the builder-test fixture,
 * a small in-memory KB and an in-memory Labels store. Also the degradation
 * path (no snapshot on the host) and the miss paths.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { z } from 'zod';
import { buildInsightDb } from '../build/build-insight.js';
import { registerInsightTools, resolveVocabularyEntity, searchTerms, closestEntities, NOT_COVERED } from '../src/azure/insight-tools.js';
import { FIXTURE } from './insight-build.test.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const VOCAB = { version: 'test', entities: [
  { entity_id: 'customer', name: 'Customer', process: 'master_data', description: 'A party the organisation sells to.', aliases: ['client', 'debtor'], d365fo: { module: 'ApplicationSuite', data_entities: ['CustCustomerV3Entity'], primary_tables: ['CustTable'], key_fields: ['CustTable.AccountNum'] } },
  { entity_id: 'vendor', name: 'Vendor', aliases: ['supplier'], d365fo: { data_entities: ['VendVendorV2Entity'], primary_tables: ['VendTable'], key_fields: ['VendTable.AccountNum'] } },
] };

function mockServer() {
  const handlers = {};
  return {
    registerTool: (name, config, handler) => { handlers[name] = { schema: config.inputSchema, outputSchema: config.outputSchema, annotations: config.annotations, description: config.description, handler }; },
    handlers,
    async call(name, args) {
      const t = handlers[name];
      return t.handler(z.object(t.schema).parse({ format: 'markdown', ...args }));
    },
  };
}

let dir, insightDb, kbDb, labelsDb, server, bare;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'insight-tools-'));
  writeFileSync(join(dir, 'hook.ndjson'), FIXTURE.filter((r) => r.source === 'hook').map((r) => JSON.stringify(r)).join('\n'));
  writeFileSync(join(dir, 'kb.ndjson'), FIXTURE.filter((r) => r.source === 'server').map((r) => JSON.stringify(r)).join('\n'));
  const vocabPath = join(dir, 'vocab.json'); writeFileSync(vocabPath, JSON.stringify(VOCAB));
  const out = join(dir, 'insight.sqlite');
  buildInsightDb({ outputPath: out, traceDir: dir, vocabularyPath: vocabPath, semanticDbPath: undefined, log: () => {} });
  insightDb = new Database(out, { readonly: true });

  kbDb = new Database(':memory:');
  kbDb.exec(`
    CREATE TABLE fields (table_name TEXT, field_name TEXT, field_type TEXT, edt TEXT, enum_type TEXT, mandatory TEXT, allow_edit TEXT, label TEXT, source_module TEXT, is_extension INTEGER DEFAULT 0);
    CREATE TABLE labels (label_id TEXT, language TEXT DEFAULT 'en-US', text TEXT, label_file TEXT, module TEXT, PRIMARY KEY(label_id, language));
    CREATE TABLE kb_metadata (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO fields VALUES ('CustTable','AccountNum','String','CustAccount',NULL,'Yes','Yes','@SYS1','ApplicationSuite',0);
    INSERT INTO fields VALUES ('CustTable','CustGroup','String','CustGroupId',NULL,'Yes','Yes','@SYS2','ApplicationSuite',0);
    INSERT INTO fields VALUES ('CustTable','Blocked','Enum',NULL,'CustVendorBlocked','No','Yes','@SYS3','ApplicationSuite',0);
    INSERT INTO labels VALUES ('@SYS1','en-US','Customer account','SYS','ApplicationPlatform');
    INSERT INTO labels VALUES ('@SYS2','en-US','Customer group','SYS','ApplicationPlatform');
    INSERT INTO kb_metadata VALUES ('build_date','2026-08-14T00:00:00Z');
  `);
  labelsDb = new Database(':memory:');
  labelsDb.exec(`CREATE TABLE label_meta (label_id TEXT PRIMARY KEY, label_file TEXT, module TEXT, origin TEXT, description TEXT);
    INSERT INTO label_meta VALUES ('SYS1','SYS','ApplicationPlatform','microsoft','The account number identifying the customer.');`);

  server = mockServer();
  registerInsightTools(server, kbDb, { insightDb, labelsDb, semanticDb: null, vocabulary: VOCAB });
  bare = mockServer();
  registerInsightTools(bare, kbDb, { insightDb: null, labelsDb: null, semanticDb: null, vocabulary: VOCAB });
  // the bare server must not fall back to a real snapshot on this machine
  process.env.INSIGHT_DB_PATH = join(dir, 'does-not-exist.sqlite');
});

after(() => { try { insightDb.close(); kbDb.close(); labelsDb.close(); } catch { /* ignore */ } delete process.env.INSIGHT_DB_PATH; rmSync(dir, { recursive: true, force: true }); });

test('registration: two tools, read-only annotations, output schemas present, short descriptions', () => {
  assert.deepEqual(Object.keys(server.handlers).sort(), ['d365_entity_insight', 'd365_prior_art']);
  for (const t of Object.values(server.handlers)) {
    assert.equal(t.annotations.readOnlyHint, true); assert.equal(t.annotations.openWorldHint, false);
    assert.ok(t.outputSchema); assert.ok(t.description.length <= 300, `description ${t.description.length} > 300`);
  }
});

test('helpers: vocabulary resolution by id/name/alias, search terms, closest ids', () => {
  assert.equal(resolveVocabularyEntity(VOCAB, 'Debtor').entity.entity_id, 'customer');
  assert.equal(resolveVocabularyEntity(VOCAB, 'customer').matched_by, 'entity_id');
  assert.equal(resolveVocabularyEntity(VOCAB, 'Vendor').matched_by, 'entity_id', 'id wins over name when they coincide');
  assert.equal(resolveVocabularyEntity(VOCAB, 'Supplier').matched_by, 'alias');
  assert.equal(resolveVocabularyEntity(VOCAB, 'nope'), null);
  assert.deepEqual(searchTerms('Which fields identify the customer account?'), ['fields', 'identify', 'customer', 'account']);
  assert.deepEqual(closestEntities(VOCAB, 'custom'), ['customer']);
  assert.ok(NOT_COVERED.some((s) => /Security/.test(s)) && NOT_COVERED.some((s) => /Task Recorder/.test(s)));
});

test('d365_prior_art by request_key: the recipe of the answered run with args, waste and touched objects; typed validates', async () => {
  const r = await server.call('d365_prior_art', { request_key: 'REQ.CUSTOMER_KEYS' });
  assert.ok(!r.isError, r.content?.[0]?.text);
  const t = r.structuredContent;
  z.object(server.handlers.d365_prior_art.outputSchema).parse(t);
  assert.equal(t.hit_count, 1);
  const h = t.hits[0];
  assert.equal(h.request_key, 'req.customer_keys'); assert.equal(h.match, 'request_key');
  assert.equal(h.best.calls, 5); assert.equal(h.best.est_tokens, Math.round(h.best.bytes / 4));
  assert.equal(h.recipe.length, 5); assert.deepEqual(h.recipe[0].args, { table_name: 'CustTable', sections: ['summary'], field_limit: 50 });
  assert.equal(h.recipe[0].step_intent, 'Look up the customer table and its keys');
  assert.ok(!JSON.stringify(h.recipe).includes('SELECT'), 'sql text never served');
  assert.deepEqual(h.waste, { repeat: 1, 'not-found': 1, unfollowed_page: 1, unreplayable: 1 });
  assert.deepEqual(h.entities, ['customer']);
  assert.ok(h.touched.some((x) => x.kind === 'field' && x.name === 'AccountNum' && x.functional_entity === 'customer'));
  assert.deepEqual(t.insight_snapshot.not_covered, [...NOT_COVERED]);
  const md = r.content[0].text;
  assert.ok(md.startsWith('## Prior art'), md.split('\n')[0]);
  assert.ok(md.includes('Not covered by the traces:'));
});

test('d365_prior_art by text: terms and aliases find the run; a miss is an emptyResult carrying the typed payload', async () => {
  const r = await server.call('d365_prior_art', { text: 'which debtor fields identify the account' });
  assert.ok(!r.isError); assert.equal(r.structuredContent.hit_count, 1); assert.ok(['text', 'entity'].includes(r.structuredContent.hits[0].match));
  const miss = await server.call('d365_prior_art', { text: 'warehouse picking waves' });
  assert.equal(miss._meta?.kind, 'empty'); assert.equal(miss.structuredContent.hit_count, 0);
  z.object(server.handlers.d365_prior_art.outputSchema).parse(miss.structuredContent);
  const bad = await server.call('d365_prior_art', {});
  assert.equal(bad.isError, true);
});

test('d365_entity_insight default sections: summary + keys (KB type, label, Labels description, usage) + usage rows; typed validates', async () => {
  const r = await server.call('d365_entity_insight', { entity: 'debtor' });
  assert.ok(!r.isError, r.content?.[0]?.text);
  const t = r.structuredContent;
  z.object(server.handlers.d365_entity_insight.outputSchema).parse(t);
  assert.equal(t.entity_id, 'customer'); assert.equal(t.matched_by, 'alias');
  assert.deepEqual(t.sections, ['summary', 'keys', 'usage']);
  assert.equal(t.usage_totals.investigations, 1); assert.equal(t.usage_totals.fields_touched, 2);
  assert.equal(t.fields.length, 1, 'keys section fills fields with the key fields only');
  const k = t.fields[0];
  assert.equal(k.field_name, 'AccountNum'); assert.equal(k.edt, 'CustAccount'); assert.equal(k.label, 'Customer account');
  assert.equal(k.description, 'The account number identifying the customer.'); assert.equal(k.is_key, true); assert.equal(k.usage_calls, 1);
  assert.ok(t.usage.some((u) => u.field_name === 'CustGroup' && u.calls === 1 && u.contexts.includes('req.customer_keys')));
  assert.equal(t.never_touched_count, undefined, 'never-touched count only with the fields section');
  assert.ok(r.content[0].text.startsWith('## Entity insight: Customer (customer)'));
});

test('d365_entity_insight fields + recipes: never-touched count, usage ordering, request keys; unknown entity → not-found with vocabulary suggestions', async () => {
  const r = await server.call('d365_entity_insight', { entity: 'customer', sections: ['fields', 'recipes'], limit: 2 });
  const t = r.structuredContent;
  assert.equal(t.fields.length, 2); assert.equal(t.truncated, true);
  assert.equal(t.never_touched_count, 1, 'Blocked was never touched');
  assert.equal(t.fields[0].is_key, true, 'keys first'); assert.equal(t.fields[0].usage_calls, 1);
  assert.deepEqual(t.recipes.map((x) => x.request_key), ['req.customer_keys']);
  assert.equal(t.usage, undefined);
  const nf = await server.call('d365_entity_insight', { entity: 'custom' });
  assert.equal(nf.isError, true); assert.equal(nf._meta?.kind, 'not-found'); assert.ok(nf.content[0].text.includes('customer'));
});

test('no snapshot on the host: both tools return errorResult(db-error) naming the build, never throw', async () => {
  for (const [name, args] of [['d365_prior_art', { request_key: 'x.y' }], ['d365_entity_insight', { entity: 'customer' }]]) {
    const r = await bare.call(name, args);
    assert.equal(r.isError, true); assert.equal(r._meta?.kind, 'error');
    assert.ok(r.content[0].text.includes('build:insight'), r.content[0].text);
  }
});
