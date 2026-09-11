/**
 * Trace Insight builder (build/build-insight.js) — the pure model on a fixture that
 * carries every record shape the sinks produce: hook lifecycle (open/step/annotate/
 * close), hook-side and server-side call records of one call (twins), a Sec server
 * record without investigation, a raw_sql call, a repeat, an unfollowed page and
 * a not-found. Then the file writer on the same fixture.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import {
  analyzeTraces, sameCall, pairCalls, classifyWaste, replayArgs, listTraceFiles, readRecords, buildInsightDb, vocabularyIndex,
} from '../build/build-insight.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const INV = 'inv-aaaa';
const base = (ts, extra) => ({ id: `r${Math.random()}`, contract_version: '1.0.0', ts, erp: { system: 'D365FO', installation_id: 'local' }, session_key: 's1', seq: 0, ...extra });
const hook = (ts, phase, extra) => base(ts, { stream: 'claude', source: 'hook', phase, mcp: { service: 'kb' }, investigation: { id: INV }, investigation_id: INV, ...extra });
const hookCall = (ts, tool, args, kind = 'data', bytes = 100) => base(ts, { stream: 'mcp', source: 'hook', mcp: { service: 'kb' }, tool: { name: tool, args }, result: { kind, bytes, duration_ms: 50 }, investigation_id: INV });
const srvCall = (ts, tool, args, extra = {}) => base(ts, { stream: 'mcp', source: 'server', mcp: { service: 'kb', version: 'v1', snapshot_date: '2026-08-14' }, tool: { name: tool, args }, result: { kind: 'data', bytes: 120, duration_ms: 40, ...(extra.result ?? {}) }, touched: extra.touched ?? [], investigation_id: extra.noInv ? undefined : INV });

export const FIXTURE = [
  hook('2026-09-10T10:00:00.000Z', 'open', { request: { key: 'req.customer_keys', interpreted: 'Which fields identify a customer account', source: 'declared' }, expected_entities: ['customer'], entities_from: 'declared' }),
  hook('2026-09-10T10:00:01.000Z', 'step', { n: 1, intent: 'Look up the customer table and its keys' }),
  // twin pair: hook (no defaults) + server (Zod defaults) of the same call
  hookCall('2026-09-10T10:00:02.000Z', 'd365_lookup_table', { table_name: 'CustTable' }),
  srvCall('2026-09-10T10:00:02.300Z', 'd365_lookup_table', { table_name: 'CustTable', sections: ['summary'], field_limit: 50, format: 'auto' }, { touched: [{ kind: 'table', name: 'CustTable' }, { kind: 'field', name: 'AccountNum', owner: 'CustTable' }, { kind: 'field', name: 'CustGroup', owner: 'CustTable' }] }),
  // repeat of the same call
  srvCall('2026-09-10T10:00:05.000Z', 'd365_lookup_table', { table_name: 'CustTable', sections: ['summary'], field_limit: 50, format: 'auto' }, { touched: [{ kind: 'table', name: 'CustTable' }] }),
  // not-found
  srvCall('2026-09-10T10:00:06.000Z', 'd365_lookup_table', { table_name: 'CustTabel', format: 'auto' }, { result: { kind: 'not-found', bytes: 60 } }),
  // unfollowed page
  srvCall('2026-09-10T10:00:07.000Z', 'd365_search', { query: 'customer', limit: 10, format: 'auto' }, { result: { has_more: true } }),
  // raw sql — sql text must be dropped
  srvCall('2026-09-10T10:00:08.000Z', 'd365_raw_sql', { sql: 'SELECT ? FROM fields WHERE table_name = ?', limit: 5, format: 'auto' }),
  hook('2026-09-10T10:00:09.000Z', 'annotate', { entities: [{ kind: 'table', name: 'CustTable', role: 'source', functional_entity: 'customer' }] }),
  hook('2026-09-10T10:00:10.000Z', 'close', { conclusion: { summary: 'AccountNum identifies the account.', outcome: 'answered' }, calls: 5 }),
  // a Sec server record with no investigation (hook never captures Sec)
  base('2026-09-10T11:00:00.000Z', { stream: 'mcp', source: 'server', mcp: { service: 'sec', snapshot_date: '2026-06-10' }, session_key: 's2', tool: { name: 'sec_lookup_role', args: { role_names: ['Accountant'], format: 'auto' } }, result: { kind: 'data', bytes: 900, duration_ms: 20 }, touched: [{ kind: 'role', name: 'Accountant' }] }),
];

const VOCAB = { version: 'test', entities: [
  { entity_id: 'customer', name: 'Customer', aliases: ['client', 'debtor'], d365fo: { module: 'ApplicationSuite', data_entities: ['CustCustomerV3Entity'], primary_tables: ['CustTable'], key_fields: ['CustTable.AccountNum'] } },
  { entity_id: 'vendor', name: 'Vendor', aliases: ['supplier'], d365fo: { data_entities: ['VendVendorV2Entity'], primary_tables: ['VendTable'], key_fields: ['VendTable.AccountNum'] } },
] };

test('sameCall: argument subset, format ignored; pairCalls pairs hook+server inside the window and keeps the server as primary', () => {
  const h = FIXTURE[2]; const s = FIXTURE[3];
  assert.ok(sameCall(h, s));
  assert.ok(!sameCall(h, FIXTURE[5]), 'different table_name is a different call');
  const groups = pairCalls([h, s, FIXTURE[4]]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].primary.source, 'server');
  assert.equal(groups[0].also.length, 1);
});

test('classifyWaste names repeat, not-found, unfollowed_page and unreplayable; replayArgs drops sql and format', () => {
  const views = [
    { tool: 'd365_lookup_table', args: { table_name: 'CustTable' }, kind: 'data', has_more: false },
    { tool: 'd365_lookup_table', args: { table_name: 'CustTable' }, kind: 'data', has_more: false },
    { tool: 'd365_lookup_table', args: { table_name: 'X' }, kind: 'not-found', has_more: false },
    { tool: 'd365_search', args: { query: 'a' }, kind: 'data', has_more: true },
    { tool: 'd365_search', args: { query: 'b' }, kind: 'data', has_more: true },
    { tool: 'd365_search', args: { query: 'b', cursor: 'eyJvIjoxMH0' }, kind: 'data', has_more: false },
    { tool: 'd365_raw_sql', args: { limit: 5 }, kind: 'data', has_more: false },
  ];
  classifyWaste(views);
  assert.deepEqual(views.map((v) => v.waste_class), [null, 'repeat', 'not-found', 'unfollowed_page', null, null, 'unreplayable']);
  assert.deepEqual(replayArgs('d365_raw_sql', { sql: 'SELECT 1', limit: 5, format: 'toon' }), { limit: 5 });
});

test('analyzeTraces: one investigation, paired twin counted once, steps attached, entities resolved, recipe = the answered run, Sec call kept without dossier', () => {
  const m = analyzeTraces(FIXTURE, { vocabulary: VOCAB });
  assert.equal(m.investigations.length, 1);
  const inv = m.investigations[0];
  assert.equal(inv.request_key, 'req.customer_keys');
  assert.equal(inv.outcome, 'answered');
  assert.equal(inv.calls, 5, 'hook+server twin is ONE call');
  assert.equal(inv.steps, 1);
  assert.equal(inv.calls_under_step, 5, 'every call after the step carries its intent');
  assert.deepEqual(JSON.parse(inv.hit_entities_json), ['customer']);
  assert.deepEqual(JSON.parse(inv.expected_json), ['customer']);

  const calls = m.calls.filter((c) => c.investigation_id === 'inv-aaaa');
  assert.equal(calls[0].paired, 1);
  assert.equal(calls[0].bytes, 120, 'server twin is primary');
  assert.deepEqual(calls.map((c) => c.waste_class), [null, 'repeat', 'not-found', 'unfollowed_page', 'unreplayable']);
  assert.ok(!calls[4].args_json.includes('SELECT'), 'sql text never enters the snapshot');

  const sec = m.calls.find((c) => c.service === 'sec');
  assert.ok(sec); assert.equal(sec.investigation_id, null); assert.equal(m.counters.session_only_calls, 1);

  const fields = m.touched.filter((t) => t.kind === 'field');
  assert.equal(fields.length, 2);
  assert.ok(fields.every((t) => t.functional_entity === 'customer' && t.owner === 'CustTable'));
  const u = m.entity_usage.find((r) => r.field_name === 'AccountNum');
  assert.ok(u); assert.equal(u.functional_entity, 'customer'); assert.equal(u.calls, 1); assert.equal(u.investigations, 1);
  assert.deepEqual(JSON.parse(u.contexts_json), ['req.customer_keys']);

  assert.equal(m.recipes.length, 1);
  const r = m.recipes[0];
  assert.equal(r.best_investigation, 'inv-aaaa'); assert.equal(r.best_calls, 5); assert.equal(r.runs, 1);
  const recipe = JSON.parse(r.recipe_json);
  assert.equal(recipe.length, 5); assert.equal(recipe[0].tool, 'd365_lookup_table'); assert.deepEqual(recipe[0].args, { table_name: 'CustTable', sections: ['summary'], field_limit: 50 });
  assert.deepEqual(JSON.parse(r.waste_json), { repeat: 1, 'not-found': 1, unfollowed_page: 1, unreplayable: 1 });
  assert.deepEqual(JSON.parse(r.entities_json), ['customer']);
  assert.equal(m.counters.paired_twins, 1);
});

test('vocabularyIndex resolves aliases, tables and data entities case-insensitively', () => {
  const idx = vocabularyIndex(VOCAB);
  assert.equal(idx.byAlias.get('debtor'), 'customer');
  assert.equal(idx.byTable.get('vendtable'), 'vendor');
  assert.equal(idx.byDataEntity.get('custcustomerv3entity'), 'customer');
});

test('listTraceFiles takes pending and .sent files, skips probe; buildInsightDb writes every table and the metadata', () => {
  const dir = mkdtempSync(join(tmpdir(), 'insight-'));
  try {
    const ndjson = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
    writeFileSync(join(dir, 'hook.ndjson'), ndjson(FIXTURE.filter((r) => r.source === 'hook')));
    writeFileSync(join(dir, 'kb.ndjson.20260910-104621.sent'), ndjson(FIXTURE.filter((r) => r.source === 'server' && r.mcp.service === 'kb')));
    writeFileSync(join(dir, 'sec.ndjson'), ndjson(FIXTURE.filter((r) => r.mcp.service === 'sec')) + 'not json\n');
    writeFileSync(join(dir, 'probe.ndjson'), ndjson([FIXTURE[3]]));
    const files = listTraceFiles(dir);
    assert.deepEqual(files.map((f) => f.split(/[\\/]/).pop()), ['hook.ndjson', 'kb.ndjson.20260910-104621.sent', 'sec.ndjson']);
    assert.equal(readRecords(files).bad, 1);

    const vocabPath = join(dir, 'vocab.json'); writeFileSync(vocabPath, JSON.stringify(VOCAB));
    const out = join(dir, 'insight.sqlite');
    const r = buildInsightDb({ outputPath: out, traceDir: dir, vocabularyPath: vocabPath, semanticDbPath: undefined, log: () => {} });
    assert.equal(r.investigations, 1); assert.equal(r.calls, 6); assert.equal(r.malformed, 1);
    const db = new Database(out, { readonly: true });
    assert.equal(db.prepare('SELECT COUNT(*) n FROM calls').get().n, 6);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM recipes').get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM entity_usage').get().n, 3);
    assert.equal(db.prepare("SELECT value FROM insight_metadata WHERE key='records'").get().value, '11');
    assert.ok(db.prepare("SELECT value FROM insight_metadata WHERE key='build_date'").get().value);
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
