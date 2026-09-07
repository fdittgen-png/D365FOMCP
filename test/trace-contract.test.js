/**
 * ERP trace contract v1 (ERP-Trace-Capture-TDD §5/§6, WI-01/02/06) — identifiers,
 * privacy parity with semantic-store, sanitize OK/KO, argument policies,
 * vocabulary matching, schema validation of sanitized output, isolation scans.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import * as T from '../src/trace/index.js';
import { privacyViolation } from '../src/azure/semantic-store.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const ctx = () => ({
  erp: { system: 'D365FO', installation_id: 'local', version: 'v10.0.2645.90' },
  mcp: { service: 'kb', version: 'v1.0.0', snapshot_date: '2026-08-14' },
  investigation_id: 'inv-abc-123',
  session_key: T.sessionKey('session-1'),
  seq: 0,
  source: 'hook',
});

describe('identifiers', () => {
  it('grammar: starts with a letter, wildcards allowed, RecIds and accounts rejected', () => {
    for (const ok of ['VendTable', 'VendVendorV2Entity', '%Vend%', '*Vend*', 'req.vendor_structure', 'SalesTable.SalesId', 'a', 'X'.repeat(128)]) assert.ok(T.isIdentifier(ok), ok);
    for (const ko of ['5637144576', '1000', '', ' Vend', 'a b', '%5637', 'X'.repeat(129), 'me@x.com']) assert.ok(!T.isIdentifier(ko), ko);
  });
  it('makeId / ulid are stream-prefixed, 26 chars, time-ordered', () => {
    const a = T.makeId('mcp', 1000);
    const b = T.makeId('claude', 2000);
    assert.match(a, /^mcp_[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.match(b, /^claude_[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.ok(a.slice(4, 14) < b.slice(7, 17));
    assert.throws(() => T.makeId('other'));
  });
  it('investigationId and requestKey are grammar-valid and stable', () => {
    assert.equal(T.investigationId('c3f2a9e1-0b7d-4f2e-9a1c-123456789abc'), 'inv-c3f2a9e1-0b7d-4f2e-9a1c-123456789abc');
    assert.ok(T.isIdentifier(T.investigationId(null)));
    assert.equal(T.requestKey('Explain the logical structure of the Vendor entity!'), 'req.explain_the_logical_structure_of_the_vendor_entity');
    assert.ok(T.requestKey('x'.repeat(200)).length <= 64);
    assert.equal(T.requestKey(''), 'req.unspecified');
  });
});

describe('privacy', () => {
  const samples = ['contact someone@example.com', 'iban DE89370400440532013000', 'vat FR12345678901', 'call +33 6 12 34 56 78', 'CustAccount', 'SalesTable.SalesId', 'RecId 5637144576'];
  it('party-data verdicts are identical to semantic-store.privacyViolation (copied regexes)', () => {
    for (const s of samples) assert.equal(T.partyDataViolation(s), privacyViolation(s), s);
  });
  it('prose: digit runs ≥ 7 are masked, URLs with query strings rejected', () => {
    assert.deepEqual(T.maskDigitRuns('RecId 5637144576 and 123456'), { text: 'RecId # and 123456', masked: 1 });
    assert.equal(T.proseViolation('see https://x.example/path?token=abc'), 'contains a URL with a query string');
    assert.equal(T.proseViolation('see https://x.example/path'), null);
  });
  it('term policy: ≤100 chars, denylist, no digit run ≥ 5', () => {
    assert.equal(T.termViolation('vendor invoice posting'), null);
    assert.ok(T.termViolation('order 12345'));
    assert.ok(T.termViolation('x'.repeat(101)));
  });
});

describe('argument policies', () => {
  it('policyFor: name overrides win over type; unknown types get no policy', () => {
    assert.equal(T.policyFor('sql', 'string'), 'sql_shape');
    assert.equal(T.policyFor('query', 'string'), 'term');
    assert.equal(T.policyFor('user_id', 'string'), 'redacted');
    assert.equal(T.policyFor('recording_xml', 'string'), 'payload_ref');
    assert.equal(T.policyFor('table_name', 'string'), 'identifier');
    assert.equal(T.policyFor('tables', 'string[]'), 'identifier[]');
    assert.equal(T.policyFor('limit', 'number'), 'number');
    assert.equal(T.policyFor('objects', 'other'), null);
    assert.equal(T.policyFor('objects', 'object[]'), 'name_list');
  });
  it('argPolicies derives the table from a Zod 4 raw shape, unwrapping optional/default/enum/array', () => {
    const p = T.argPolicies({
      table_name: z.string().min(1), field_limit: z.number().int().optional(), custom_only: z.boolean().default(false),
      tables: z.array(z.string()).optional(), format: z.enum(['auto', 'toon']).optional(), sql: z.string(), query: z.string(),
      objects: z.array(z.object({ a: z.string() })), targets: z.array(z.object({ name: z.string(), type: z.enum(['table', 'class']).optional() })),
    });
    assert.deepEqual(p, { table_name: 'identifier', field_limit: 'number', custom_only: 'boolean', tables: 'identifier[]', format: 'identifier', sql: 'sql_shape', query: 'term', objects: null, targets: 'name_list' });
  });
  it('applyArgPolicies keeps replayable values, masks SQL literals, redacts persons, drops and counts the rest', () => {
    const { args, coverage } = T.applyArgPolicies(
      { table_name: 'VendTable', field_limit: 40, tables: ['CustTable', '5637144576'], sql: "SELECT a FROM t WHERE x = 'V' AND n = 42", user_id: 'someone', query: 'vendor bank account 1234567', sections: ['indexes', 'relations_out'], blob: { nested: true } },
      { table_name: 'identifier', field_limit: 'number', tables: 'identifier[]', sql: 'sql_shape', user_id: 'redacted', query: 'term', sections: 'identifier[]' },
    );
    assert.deepEqual(args, { table_name: 'VendTable', field_limit: 40, tables: ['CustTable'], sql: 'SELECT a FROM t WHERE x = ? AND n = ?', user_id: '<redacted>', sections: ['indexes', 'relations_out'] });
    assert.deepEqual(coverage, ['args_partial', 'args_redacted']);
  });
  it('name_list keeps batch targets as `type:Name` and touched picks the kind up; term accepts arrays', () => {
    const { args, coverage } = T.applyArgPolicies({ objects: [{ name: 'VendTable', type: 'table' }, { name: 'VendVendorV2Entity', type: 'data_entity' }, { name: '5637144576' }], queries: ['vendor bank', 'acct 12345'] }, { objects: 'name_list', queries: 'term' });
    assert.deepEqual(args, { objects: ['table:VendTable', 'data_entity:VendVendorV2Entity'], queries: ['vendor bank'] });
    assert.deepEqual(coverage, ['args_redacted']);
    assert.deepEqual(T.touchedFromArgs(args), [{ kind: 'table', name: 'VendTable' }, { kind: 'data_entity', name: 'VendVendorV2Entity' }]);
  });

  it('payload_ref fingerprints, never carries the text', () => {
    const r = T.payloadRef('<Recording><Step annotation="Enter 12345678 for account someone@example.com"/></Recording>');
    assert.match(r.sha256, /^[0-9a-f]{64}$/);
    assert.ok(r.bytes > 0);
    assert.ok(!JSON.stringify(r).includes('example.com'));
  });
  it('touchedFromArgs names objects by kind, skips wildcards, owners fields by their table', () => {
    assert.deepEqual(T.touchedFromArgs({ table_name: 'VendTable', field_names: ['AccountNum', 'Party'], entity_name: 'VendVendorV2Entity', pattern: '%Vend%', module: 'ApplicationSuite' }), [
      { kind: 'table', name: 'VendTable' },
      { kind: 'field', name: 'AccountNum', owner: 'VendTable' },
      { kind: 'field', name: 'Party', owner: 'VendTable' },
      { kind: 'data_entity', name: 'VendVendorV2Entity' },
      { kind: 'model', name: 'ApplicationSuite' },
    ]);
  });
  it('parseToolName maps stdio, connector and plugin aliases to the service; other tools are null', () => {
    assert.deepEqual(T.parseToolName('mcp__d365kb__d365_lookup_table'), { service: 'kb', tool: 'd365_lookup_table' });
    assert.deepEqual(T.parseToolName('mcp__claude_ai_D365_xRef__xref_find_references'), { service: 'xref', tool: 'xref_find_references' });
    assert.deepEqual(T.parseToolName('mcp__claude_ai_D365_KB__d365_search'), { service: 'kb', tool: 'd365_search' });
    assert.equal(T.parseToolName('Skill'), null);
    assert.equal(T.parseToolName('mcp__claude_ai_Microsoft_Learn__microsoft_docs_search'), null);
  });
});

describe('vocabulary matching', () => {
  const vocab = { entities: [{ entity_id: 'customer', name: 'Customer' }, { entity_id: 'vendor', name: 'Vendor', aliases: ['supplier'] }, { entity_id: 'address', name: 'Address', aliases: ['postal address'] }, { entity_id: 'sales_order', name: 'Sales order', aliases: ['customer order'] }] };
  it('whole words, aliases, plurals, longest phrase first, text order, no substring hits', () => {
    assert.deepEqual(T.matchEntities('customer and vendor postal address for suppliers; vendorsitedesc', vocab), ['customer', 'vendor', 'address']);
    assert.deepEqual(T.matchEntities('the customer order lines', vocab), ['sales_order']);
    assert.deepEqual(T.matchEntities('nothing here', vocab), []);
    assert.deepEqual(T.matchEntities('', vocab), []);
  });
  it('parseDeclaredEntities accepts known ids only, dedupes, ignores none', () => {
    assert.deepEqual(T.parseDeclaredEntities('vendor, address, vendor, none, unknown_thing', vocab), ['vendor', 'address']);
  });
});

describe('sanitize + schema', () => {
  it('a call record round-trips: sanitized output validates against trace-record.v1', () => {
    const rec = T.callRecord(ctx(), { tool: 'd365_lookup_table', rawArgs: { table_name: 'VendTable', field_limit: 40, functional_context: 'vendor' }, policies: { table_name: 'identifier', field_limit: 'number', functional_context: 'identifier' }, result: { kind: 'data', bytes: 26165, has_more: true, duration_ms: 173, rows: 40 }, launch_seq: 2 });
    const s = T.sanitize(rec);
    assert.ok(s.ok, JSON.stringify(s));
    assert.ok(T.isSanitized(s.record));
    assert.ok(Object.isFrozen(s.record));
    assert.deepEqual(T.validateRecord(s.record), { ok: true });
    assert.deepEqual(s.record.touched, [{ kind: 'table', name: 'VendTable' }]);
    assert.equal(s.record.functional_context, 'vendor');
    assert.equal(s.record.launch_seq, 2);
    assert.equal(s.record.result.duration_ms, 173);
  });
  it('every claude phase validates; digit runs in prose are masked; the raw record is never frozen', () => {
    const c = ctx();
    const recs = [
      T.claudeRecord(c, 'open', { request: { key: 'req.vendor_structure', interpreted: 'Explain the vendor entity. RecId 5637144576.', approach: 'KB then XRef', source: 'declared' }, expected_entities: ['vendor'], entities_from: 'declared' }),
      T.claudeRecord(c, 'step', { n: 1, intent: 'Now querying the KB for the vendor data entity.' }),
      T.claudeRecord(c, 'annotate', { entities: [{ kind: 'table', name: 'VendTable', role: 'source', level: 'physical', functional_entity: 'vendor', counterpart: { erp: 'M3', name: 'CIDMAS' } }], note: 'ok' }),
      T.claudeRecord(c, 'close', { conclusion: { summary: 'The vendor is VendTable + DirPartyTable.', outcome: 'answered', differences: [{ aspect: 'structure', statement: 'M3 has no party table.' }] }, calls: 3 }),
    ];
    for (const r of recs) {
      const s = T.sanitize(r);
      assert.ok(s.ok, JSON.stringify(s));
      assert.deepEqual(T.validateRecord(s.record), { ok: true }, r.phase);
      assert.ok(!Object.isFrozen(r));
    }
    assert.equal(T.sanitize(recs[0]).record.request.interpreted, 'Explain the vendor entity. RecId #.');
  });
  it('KO: party data in prose rejects the record naming the field, never the text', () => {
    const r = T.sanitize(T.claudeRecord(ctx(), 'close', { conclusion: { summary: 'mail someone@example.com', outcome: 'answered' } }));
    assert.deepEqual(r, { ok: false, reason: 'contains an e-mail address', field: 'conclusion.summary' });
    assert.ok(!JSON.stringify(r).includes('example.com'));
  });
  it('KO: claude record without investigation_id, bad phase, bad enum, ragged identifiers', () => {
    const c = ctx();
    assert.equal(T.sanitize(T.claudeRecord({ ...c, investigation_id: undefined }, 'step', { n: 1, intent: 'x' })).field, 'investigation_id');
    assert.equal(T.sanitize({ ...T.claudeRecord(c, 'step', { n: 1, intent: 'x' }), phase: 'think' }).field, 'phase');
    assert.equal(T.sanitize(T.claudeRecord(c, 'open', { request: { key: 'req.a', interpreted: 'a' }, expected_entities: ['vendor'], entities_from: 'guess' })).field, 'entities_from');
    assert.equal(T.sanitize(T.claudeRecord(c, 'open', { request: { key: 'req.a', interpreted: 'a' }, expected_entities: ['5637144576'], entities_from: 'none' })).field, 'expected_entities');
  });
  it('KO: forbidden and person-level keys anywhere; Stream 1 drops invalid touched names silently', () => {
    const rec = T.callRecord(ctx(), { tool: 'd365_search', rawArgs: { query: 'vendor' }, policies: { query: 'term' }, result: { kind: 'data', bytes: 10 } });
    rec.touched = [{ kind: 'table', name: '5637144576' }, { kind: 'table', name: 'VendTable' }, { kind: 'planet', name: 'Mars' }];
    const s = T.sanitize(rec);
    assert.ok(s.ok);
    assert.deepEqual(s.record.touched, [{ kind: 'table', name: 'VendTable' }]);
    // the output is a WHITELIST copy: keys the contract does not name never survive, whatever they carry
    const withData = { ...rec, result: { ...rec.result, sample: 'x' }, erp: { ...rec.erp, user: 'x' }, note: 'y' };
    const out = T.sanitize(withData);
    assert.ok(out.ok);
    assert.ok(!('sample' in out.record.result) && !('user' in out.record.erp) && !('note' in out.record));
    assert.deepEqual(T.validateRecord(out.record), { ok: true });
  });
  it('KO envelope: id/stream mismatch, bad session key, bad source', () => {
    const rec = T.callRecord(ctx(), { tool: 'd365_search', rawArgs: {}, policies: {}, result: { kind: 'data', bytes: 1 } });
    assert.equal(T.sanitize({ ...rec, id: rec.id.replace(/^mcp_/, 'claude_') }).field, 'id');
    assert.equal(T.sanitize({ ...rec, session_key: 'abc' }).field, 'session_key');
    assert.equal(T.sanitize({ ...rec, source: 'model' }).field, 'source');
  });
  it('schema rejects a record that mixes streams', () => {
    const rec = T.sanitize(T.callRecord(ctx(), { tool: 'd365_search', rawArgs: {}, policies: {}, result: { kind: 'data', bytes: 1 } })).record;
    const v = T.validateRecord({ ...rec, phase: 'open' });
    assert.equal(v.ok, false);
  });
});

describe('isolation', () => {
  function walk(dir, acc = []) {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p, acc);
      else if (p.endsWith('.js') || p.endsWith('.mjs')) acc.push(p);
    }
    return acc;
  }
  it('src/azure imports the trace module only through src/trace/index.js', () => {
    const bad = [];
    for (const f of walk(join(ROOT, 'src', 'azure'))) {
      for (const m of readFileSync(f, 'utf8').matchAll(/from\s+['"]([^'"]*\/trace\/[^'"]*)['"]/g)) {
        if (!m[1].endsWith('/trace/index.js')) bad.push(`${relative(ROOT, f)} → ${m[1]}`);
      }
    }
    assert.deepEqual(bad, []);
  });
  it('the sanitized brand is created in sanitize.js only (plugin copy excepted)', () => {
    const hits = walk(join(ROOT, 'src')).filter((f) => readFileSync(f, 'utf8').includes("Symbol.for('mcp.trace.sanitized')")).map((f) => relative(ROOT, f).replace(/\\/g, '/'));
    assert.deepEqual(hits, ['src/trace/contract/sanitize.js']);
  });
  it('contract modules copied into the hook import Node built-ins and siblings only', () => {
    for (const f of ['identifiers.js', 'privacy.js', 'arg-policies.js', 'vocabulary-match.js', 'sanitize.js', 'record.js']) {
      for (const m of readFileSync(join(ROOT, 'src', 'trace', 'contract', f), 'utf8').matchAll(/from\s+['"]([^'"]+)['"]/g)) {
        assert.ok(m[1].startsWith('node:') || m[1].startsWith('./'), `${f} imports ${m[1]}`);
      }
    }
  });
});
