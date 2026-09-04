/**
 * Cursor pagination (issue #109 part A, W5).
 *
 * What is defended here:
 *   - the cursor is opaque, stateless and tolerant (garbage -> invalid-input);
 *   - page 1 + page 2 cover the set with no overlap and no gap, on every
 *     paginated tool;
 *   - a call WITHOUT `cursor` keeps its shape, plus `has_more` (and `next_cursor`
 *     only when there is more) — rule #14;
 *   - a batch call rejects `cursor` (a page belongs to one target).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { z } from 'zod';

import { encodeCursor, decodeCursor, pageMeta, takePage, probeLimit } from '../src/azure/pagination.js';
import { registerKbTools } from '../src/azure/kb-tools.js';
import { registerXrefTools } from '../src/azure/xref-tools.js';
import { registerSecTools } from '../src/azure/sec-tools.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const pad = (n) => String(n).padStart(3, '0');

function mockServer() {
  const tools = new Map();
  return {
    registerTool(name, config, handler) { tools.set(name, { config, handler }); },
    tools,
    call(name, args) { return tools.get(name).handler({ format: 'markdown', ...args }); },
    schema(name) { return z.object(tools.get(name).config.outputSchema); },
  };
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

test('encodeCursor / decodeCursor round-trip; absent means first page', () => {
  const c = encodeCursor({ offset: 40 });
  assert.match(c, /^[A-Za-z0-9_-]+$/, 'base64url, no padding');
  assert.deepEqual(decodeCursor(c), { ok: true, offset: 40 });
  assert.deepEqual(decodeCursor(undefined), { ok: true, offset: 0 });
  assert.deepEqual(decodeCursor(''), { ok: true, offset: 0 });
  assert.deepEqual(decodeCursor(encodeCursor({ offset: 5, sort_key: 'x' })), { ok: true, offset: 5, sort_key: 'x' });
});

test('decodeCursor is tolerant: garbage, negative and oversized cursors are invalid-input, never a throw', () => {
  for (const bad of ['not-a-cursor', Buffer.from('{"o":-1}').toString('base64url'), Buffer.from('[1]').toString('base64url'), 'x'.repeat(600), 42]) {
    const r = decodeCursor(bad);
    assert.equal(r.ok, false, String(bad).slice(0, 20));
    assert.equal(r.error.isError, true);
    assert.match(r.error.content[0].text, /Invalid `cursor`/);
    assert.equal(r.error.structuredContent, undefined, 'error responses carry no structuredContent');
  }
});

test('pageMeta: next_cursor only when has_more, total_count only when known (rule #14)', () => {
  assert.deepEqual(pageMeta(null, 0, 20, 20, false), { has_more: false });
  const m = pageMeta(null, 0, 20, 20, true);
  assert.equal(m.has_more, true);
  assert.deepEqual(decodeCursor(m.next_cursor), { ok: true, offset: 20 });
  assert.ok(!('total_count' in m));
  assert.deepEqual(pageMeta(45, 40, 5, 20), { has_more: false, total_count: 45 });
  assert.equal(pageMeta(45, 20, 20, 20).has_more, true);
  // Legacy heuristic when nothing better is known.
  assert.equal(pageMeta(null, 0, 20, 20).has_more, true);
  assert.equal(pageMeta(null, 0, 19, 20).has_more, false);
});

test('takePage / probeLimit: the limit+1 probe makes has_more exact on a full last page', () => {
  assert.equal(probeLimit(10), 11);
  assert.deepEqual(takePage([1, 2, 3], 3), { rows: [1, 2, 3], has_more: false });
  assert.deepEqual(takePage([1, 2, 3, 4], 3), { rows: [1, 2, 3], has_more: true });
});

/* ── fixtures ────────────────────────────────────────────────────────────── */

function kbDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE kb_search (object_type TEXT, object_name TEXT, module_id TEXT, content TEXT);
    CREATE TABLE methods (owner_type TEXT, owner_name TEXT, method_name TEXT, signature TEXT, is_static INTEGER DEFAULT 0, source_code TEXT);
    CREATE TABLE classes (class_name TEXT, module_id TEXT, extends_class TEXT, implements_list TEXT, is_abstract INTEGER);
    CREATE TABLE data_entities (entity_name TEXT, module_id TEXT, label TEXT, public_name TEXT, public_collection TEXT, is_public INTEGER, primary_table TEXT, staging_table TEXT, config_key TEXT);
    CREATE TABLE entity_fields (entity_name TEXT, field_name TEXT, data_field TEXT, data_source TEXT, is_mandatory INTEGER);
    CREATE TABLE fields (table_name TEXT, field_name TEXT, field_type TEXT, edt TEXT, enum_type TEXT, mandatory TEXT, label TEXT, source_module TEXT, is_extension INTEGER DEFAULT 0);
    CREATE TABLE tables (table_name TEXT, module_id TEXT);
    CREATE TABLE labels (label_id TEXT PRIMARY KEY, text TEXT);
    CREATE TABLE forms (form_name TEXT PRIMARY KEY, module_id TEXT, label TEXT, data_sources_json TEXT, file_path TEXT, pattern TEXT, pattern_version TEXT, controls_count INTEGER);
    INSERT INTO data_entities VALUES ('PagedEntity','AS','Paged','Paged','Pageds',1,'PagedTable',NULL,NULL);
  `);
  const s = db.prepare('INSERT INTO kb_search VALUES (?,?,?,?)');
  const m = db.prepare('INSERT INTO methods VALUES (?,?,?,?,?,?)');
  const ef = db.prepare('INSERT INTO entity_fields VALUES (?,?,?,?,?)');
  const f = db.prepare('INSERT INTO forms VALUES (?,?,?,?,?,?,?,?)');
  for (let i = 1; i <= 7; i++) {
    s.run('table', `PagedTable${pad(i)}`, 'AS', `PagedTable${pad(i)} paged content`);
    m.run('class', 'PagedClass', `method${pad(i)}`, `void method${pad(i)}()`, 0, 'x');
    // #125: seven owners implementing the same method name
    m.run('class', `PagedOwner${pad(i)}`, 'pagedMethod', 'public void pagedMethod()', 0, 'x\ny');
    ef.run('PagedEntity', `Field${pad(i)}`, `Field${pad(i)}`, 'PagedTable', 0);
    // #124: seven forms sharing one pattern
    f.run(`PagedForm${pad(i)}`, 'AS', null, '["PagedTable"]', null, 'PagedPattern', '1.0', 0);
  }
  return db;
}

function xrefDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE modules (id INTEGER PRIMARY KEY, module TEXT);
    CREATE TABLE names (id INTEGER PRIMARY KEY, path TEXT, module_id INTEGER);
    CREATE TABLE refs (source_id INTEGER, target_id INTEGER, kind INTEGER, line INTEGER, col INTEGER);
    INSERT INTO modules VALUES (1,'AS');
    INSERT INTO names VALUES (1,'/Tables/PagedTable',1);
  `);
  const n = db.prepare('INSERT INTO names VALUES (?,?,?)');
  const r = db.prepare('INSERT INTO refs VALUES (?,?,?,?,?)');
  for (let i = 1; i <= 7; i++) {
    n.run(10 + i, `/Classes/Caller${pad(i)}`, 1);
    r.run(10 + i, 1, 1, i, 1);   // 7 callers of PagedTable (find_references)
    r.run(1, 10 + i, 2, i, 1);   // PagedTable uses 7 classes (find_usages)
  }
  return db;
}

function secDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE roles (role_id TEXT PRIMARY KEY, role_name TEXT, module_id TEXT, label TEXT, description TEXT,
      license_type TEXT, permission_type TEXT DEFAULT 'Grant', is_profile INTEGER DEFAULT 0, source TEXT);
    CREATE TABLE duties (duty_id TEXT PRIMARY KEY, duty_name TEXT);
    CREATE TABLE role_duties (role_id TEXT, duty_id TEXT, permission_type TEXT);
    CREATE TABLE privileges (privilege_name TEXT PRIMARY KEY);
    CREATE TABLE duty_privileges (duty_id TEXT, privilege_name TEXT);
    CREATE TABLE role_direct_privileges (role_id TEXT, privilege_name TEXT);
    CREATE TABLE role_direct_entity_permissions (role_id TEXT, entity_name TEXT, resource_type TEXT, grant_read TEXT,
      grant_create TEXT, grant_update TEXT, grant_delete TEXT, grant_correct TEXT, grant_invoke TEXT);
    CREATE TABLE sec_search (object_type TEXT, object_name TEXT, module_id TEXT, content TEXT);
    CREATE TABLE sec_metadata (key TEXT, value TEXT);
    INSERT INTO duties VALUES ('PagedDuty','Paged duty');
    INSERT INTO privileges VALUES ('PagedPriv');
    INSERT INTO duty_privileges VALUES ('PagedDuty','PagedPriv');
  `);
  const r = db.prepare('INSERT INTO roles (role_id, role_name) VALUES (?,?)');
  const rd = db.prepare('INSERT INTO role_duties VALUES (?,?,?)');
  const s = db.prepare('INSERT INTO sec_search VALUES (?,?,?,?)');
  for (let i = 1; i <= 7; i++) {
    r.run(`R${i}`, `Paged role ${pad(i)}`);
    rd.run(`R${i}`, 'PagedDuty', 'Grant');
    s.run('role', `Paged role ${pad(i)}`, 'AS', `Paged role ${pad(i)} paged`);
  }
  return db;
}

/* ── the eight paginated tools ───────────────────────────────────────────── */

// [service, tool, args, path to the paged array]
const PAGED = [
  ['kb', 'd365_search', { query: 'paged' }, t => t.results.map(x => x.object_name)],
  ['kb', 'd365_get_class_methods', { name: 'PagedClass' }, t => t.methods.map(x => x.method_name)],
  ['kb', 'd365_get_entity_sources', { entity_name: 'PagedEntity' }, t => t.entity_fields.map(x => x.field_name)],
  ['kb', 'd365_find_method_implementations', { method_name: 'pagedMethod' }, t => t.implementations.map(x => x.owner_name)],
  ['kb', 'd365_find_forms', { pattern: 'PagedPattern' }, t => t.forms.map(x => x.form_name)],
  ['xref', 'xref_find_references', { object_name: 'PagedTable' }, t => t.references.map(x => `${x.path}:${x.line}`)],
  ['xref', 'xref_find_usages', { object_name: 'PagedTable' }, t => t.usages.map(x => `${x.path}:${x.line}`)],
  ['sec', 'sec_search', { query: 'paged' }, t => t.results.map(x => x.object_name)],
  ['sec', 'sec_find_roles_by_duty', { duty_name: 'PagedDuty' }, t => t.roles.map(x => x.role_name)],
  ['sec', 'sec_find_roles_by_privilege', { privilege_name: 'PagedPriv' }, t => t.via_chain.map(x => x.role_name)],
];

function servers() {
  const kb = mockServer(); registerKbTools(kb, kbDb());
  const xref = mockServer(); registerXrefTools(xref, xrefDb());
  const sec = mockServer(); registerSecTools(sec, secDb());
  return { kb, xref, sec };
}

for (const [svc, name, args, items] of PAGED) {
  test(`${name}: page 1 + page 2 (limit 4 over 7 rows) cover the set with no overlap; the last page has no next_cursor`, async () => {
    const s = servers()[svc];
    const p1 = await s.call(name, { ...args, limit: 4 });
    assert.ok(!p1.isError, p1.content?.[0]?.text);
    const t1 = p1.structuredContent;
    assert.equal(t1.has_more, true);
    assert.ok(typeof t1.next_cursor === 'string' && t1.next_cursor.length > 0);
    assert.equal(items(t1).length, 4);
    assert.match(p1.content[0].text, /more available — pass `cursor:/, 'the text channel says how to continue, not "raise limit"');
    assert.doesNotThrow(() => s.schema(name).parse(t1));

    const p2 = await s.call(name, { ...args, limit: 4, cursor: t1.next_cursor });
    assert.ok(!p2.isError, p2.content?.[0]?.text);
    const t2 = p2.structuredContent;
    assert.equal(t2.has_more, false);
    assert.ok(!('next_cursor' in t2), 'next_cursor is omitted when there is no next page');
    assert.equal(items(t2).length, 3);
    assert.doesNotThrow(() => s.schema(name).parse(t2));

    const all = [...items(t1), ...items(t2)];
    assert.equal(new Set(all).size, 7, `pages overlap or skip: ${all.join(', ')}`);

    // A page beyond the end is a valid empty result, not an error.
    const p3 = await s.call(name, { ...args, limit: 4, cursor: encodeCursor({ offset: 7 }) });
    assert.ok(!p3.isError);
    assert.equal(p3.structuredContent.has_more, false);
  });

  test(`${name}: no cursor -> single-page shape plus has_more only (rule #14); a bad cursor -> invalid-input`, async () => {
    const s = servers()[svc];
    const r = await s.call(name, { ...args });
    const t = r.structuredContent;
    assert.equal(t.has_more, false, 'seven rows fit the default limit');
    assert.ok(!('next_cursor' in t));
    assert.ok(!('total_count' in t), 'tools carry their own exact count key; total_count is not duplicated');
    const bad = await s.call(name, { ...args, cursor: 'definitely-not-a-cursor' });
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /Invalid `cursor`/);
  });
}

test('a batch call rejects a cursor: a page belongs to one target', async () => {
  const { kb, xref } = servers();
  const c = encodeCursor({ offset: 4 });
  const a = await kb.call('d365_search', { queries: ['paged', 'table'], cursor: c });
  assert.equal(a.isError, true);
  assert.match(a.content[0].text, /cursor/);
  const b = await xref.call('xref_find_references', { objects: ['PagedTable'], cursor: c });
  assert.equal(b.isError, true);
  // The first-page cursor is a no-op and is accepted by a batch.
  const ok = await kb.call('d365_search', { queries: ['paged'], cursor: encodeCursor({ offset: 0 }) });
  assert.ok(!ok.isError);
});

test('d365_get_class_methods: a class with exactly `limit` methods is no longer reported as truncated (probe makes it exact)', async () => {
  const { kb } = servers();
  const r = await kb.call('d365_get_class_methods', { name: 'PagedClass', limit: 7 });
  assert.equal(r.structuredContent.truncated, false);
  assert.equal(r.structuredContent.has_more, false);
});
