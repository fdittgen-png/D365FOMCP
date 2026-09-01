/**
 * Agent guardrails: loop detection + the one-shot staleness note.
 *
 * These are OFF unless MCP_TOOL_GUARDS says otherwise, so this file turns them
 * on explicitly — which is also the only honest way to test them, since the
 * whole point of the default is that a repeated call from a script is not a
 * loop.
 */

import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

process.env.MCP_TOOL_GUARDS = 'on';

const {
  installToolGuards, recordCall, callKey, resetToolGuards, guardsEnabled,
  stalenessNote, readBuildDate, LOOP_REPEAT_THRESHOLD, LOOP_WINDOW, DEFAULT_STALE_DAYS,
  activeProfile, CORE_TOOLS,
} = await import('../src/azure/tool-guards.js');

/** Minimal server that records handlers, like the other suites' mock. */
function mockServer() {
  const handlers = {};
  return {
    handlers,
    registerTool(name, _cfg, handler) { handlers[name] = handler; },
  };
}

function dbWithBuildDate(iso) {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE kb_metadata (key TEXT PRIMARY KEY, value TEXT)');
  if (iso) db.prepare('INSERT INTO kb_metadata VALUES (?,?)').run('build_date', iso);
  return db;
}

const okResult = (text = '## Result\n\nrows: 1') => ({ content: [{ type: 'text', text }] , structuredContent: { n: 1 } });

beforeEach(() => resetToolGuards());

describe('loop detection', () => {
  it('is enabled here and off by default elsewhere', () => {
    assert.equal(guardsEnabled(), true);
  });

  it('passes the first calls through untouched, then suppresses the payload', () => {
    let calls = 0;
    const s = mockServer();
    const g = installToolGuards(s, { service: 'kb', db: null });
    g.registerTool('d365_lookup_table', {}, async () => { calls++; return okResult(); });
    const h = s.handlers['d365_lookup_table'];

    const args = { table_name: 'CustTable' };
    for (let i = 1; i < LOOP_REPEAT_THRESHOLD; i++) {
      const r = h(args);
      assert.ok(r, `call ${i} must return a result`);
    }
    assert.equal(calls, LOOP_REPEAT_THRESHOLD - 1, 'the handler ran for every call before the threshold');
  });

  it('the suppressed response is short, explains itself, and carries no structuredContent', async () => {
    const s = mockServer();
    const g = installToolGuards(s, { service: 'kb', db: null });
    const big = 'x'.repeat(40_000);
    g.registerTool('d365_get_class_methods', {}, async () => okResult(`## Methods\n\n${big}`));
    const h = s.handlers['d365_get_class_methods'];

    const args = { name: 'CustTable' };
    let last;
    for (let i = 0; i < LOOP_REPEAT_THRESHOLD; i++) last = await h(args);

    assert.match(last.content[0].text, /Repeated call suppressed/);
    assert.match(last.content[0].text, /d365_get_class_methods/);
    assert.ok(last.content[0].text.length < 1_000,
      'the whole point is that the loop stops costing tokens');
    // A meta-response must not be validated against the tool's outputSchema.
    assert.ok(!('structuredContent' in last), 'loop result must not carry structuredContent');
  });

  it('different arguments are not a loop', async () => {
    let calls = 0;
    const s = mockServer();
    const g = installToolGuards(s, { service: 'kb', db: null });
    g.registerTool('d365_lookup_table', {}, async () => { calls++; return okResult(); });
    const h = s.handlers['d365_lookup_table'];

    for (const t of ['CustTable', 'SalesTable', 'InventTable', 'VendTable', 'LedgerJournalTable']) {
      await h({ table_name: t });
    }
    assert.equal(calls, 5, 'five distinct lookups must all run');
  });

  it('argument order does not disguise a repeat', () => {
    assert.equal(
      callKey('t', { a: 1, b: { c: 2, d: 3 } }),
      callKey('t', { b: { d: 3, c: 2 }, a: 1 }),
    );
    assert.notEqual(callKey('t', { a: 1 }), callKey('t', { a: 2 }));
    assert.notEqual(callKey('t', { a: 1 }), callKey('u', { a: 1 }));
  });

  it('a repeat that falls out of the window is not a loop', () => {
    const key = callKey('t', { a: 1 });
    assert.equal(recordCall(key).loop, false);
    // Push the window full of distinct calls; the first occurrence ages out.
    for (let i = 0; i < LOOP_WINDOW; i++) recordCall(callKey('t', { a: `filler${i}` }));
    assert.equal(recordCall(key).loop, false, 'an old identical call must not count toward the threshold');
  });

  it('does not double-count when a server is wrapped twice', async () => {
    // Both registerKbTools and registerIsvKbTools install guards on the SAME
    // McpServer. If installToolGuards mutated it, every call would be recorded
    // once per wrap and the threshold would trip at half the intended count.
    let calls = 0;
    const s = mockServer();
    const g1 = installToolGuards(s, { service: 'kb', db: null });
    const g2 = installToolGuards(g1, { service: 'kb', db: null });
    g2.registerTool('t', {}, async () => { calls++; return okResult(); });
    const h = s.handlers['t'];
    await h({ a: 1 });
    await h({ a: 1 });
    assert.equal(calls, 2, 'two identical calls are below the threshold and must both run');
  });
});

describe('staleness note', () => {
  const dbs = [];
  after(() => { for (const d of dbs) { try { d.close(); } catch { /* already closed */ } } });
  const track = (d) => { dbs.push(d); return d; };

  it('warns once when the snapshot is older than the threshold', () => {
    const old = new Date(Date.now() - (DEFAULT_STALE_DAYS + 20) * 86_400_000).toISOString();
    const db = track(dbWithBuildDate(old));
    const first = stalenessNote(db, 'kb');
    assert.match(first, /snapshot was built \d+ days ago/);
    assert.match(first, /not yet scanned/);
    // Once per process — repeating it on every response is its own waste.
    resetToolGuards.name; // (no-op, keeps intent explicit)
    assert.equal(stalenessNote(db, 'kb'), '', 'the note must be emitted at most once');
  });

  it('says nothing about a fresh snapshot', () => {
    const db = track(dbWithBuildDate(new Date().toISOString()));
    assert.equal(stalenessNote(db, 'kb'), '');
  });

  it('says nothing when the snapshot cannot be dated', () => {
    assert.equal(stalenessNote(track(dbWithBuildDate(null)), 'kb'), '');
    assert.equal(stalenessNote(null, 'kb'), '');
    assert.equal(readBuildDate(track(new Database(':memory:'))), null,
      'a database with no metadata table must not throw');
  });

  it('is appended to a normal response but never to an error', async () => {
    const old = new Date(Date.now() - (DEFAULT_STALE_DAYS + 5) * 86_400_000).toISOString();

    const s1 = mockServer();
    installToolGuards(s1, { service: 'kb', db: track(dbWithBuildDate(old)) })
      .registerTool('ok', {}, async () => okResult());
    const good = await s1.handlers.ok({});
    assert.match(good.content[0].text, /snapshot was built/);
    assert.deepEqual(good.structuredContent, { n: 1 }, 'the payload itself is untouched');

    resetToolGuards();
    const s2 = mockServer();
    installToolGuards(s2, { service: 'kb', db: track(dbWithBuildDate(old)) })
      .registerTool('bad', {}, async () => ({ isError: true, content: [{ type: 'text', text: '## Error' }] }));
    const bad = await s2.handlers.bad({});
    assert.equal(bad.content[0].text, '## Error',
      'an error explains itself; a snapshot-age footnote only muddies it');
  });
});

describe('tool profile', () => {
  after(() => { delete process.env.MCP_TOOL_PROFILE; });

  const registerThree = (server) => {
    const g = installToolGuards(server, { service: 'kb', db: null });
    g.registerTool('d365_search', {}, async () => okResult());        // core
    g.registerTool('d365_raw_sql', {}, async () => okResult());       // not core
    g.registerTool('sec_what_if', {}, async () => okResult());        // not core
    return server;
  };

  it('registers everything by default', () => {
    delete process.env.MCP_TOOL_PROFILE;
    assert.equal(activeProfile(), 'full');
    const s = registerThree(mockServer());
    assert.deepEqual(Object.keys(s.handlers).sort(), ['d365_raw_sql', 'd365_search', 'sec_what_if']);
  });

  it('core drops the specialised tools and keeps the common ones', () => {
    process.env.MCP_TOOL_PROFILE = 'core';
    assert.equal(activeProfile(), 'core');
    const s = registerThree(mockServer());
    assert.deepEqual(Object.keys(s.handlers), ['d365_search'],
      'only the core tool is registered');
  });

  it('filters even when the guards themselves are off', () => {
    process.env.MCP_TOOL_PROFILE = 'core';
    process.env.MCP_TOOL_GUARDS = 'off';
    try {
      const s = registerThree(mockServer());
      assert.deepEqual(Object.keys(s.handlers), ['d365_search'],
        'trimming the tool list is useful without loop detection, so it must not be gated behind it');
    } finally {
      process.env.MCP_TOOL_GUARDS = 'on';
    }
  });

  it('an unknown profile value means full, not empty', () => {
    process.env.MCP_TOOL_PROFILE = 'minimal-typo';
    assert.equal(activeProfile(), 'full');
    const s = registerThree(mockServer());
    assert.equal(Object.keys(s.handlers).length, 3,
      'a typo must not silently strip the server down to nothing');
  });

  it('every core tool name is one that actually exists', async () => {
    delete process.env.MCP_TOOL_PROFILE;
    const registered = new Set();
    const collect = { registerTool(name) { registered.add(name); } };
    const { registerKbTools } = await import('../src/azure/kb-tools.js');
    const { registerXrefTools } = await import('../src/azure/xref-tools.js');
    const { registerSecTools } = await import('../src/azure/sec-tools.js');
    for (const fn of [registerKbTools, registerXrefTools, registerSecTools]) {
      const db = new Database(':memory:');
      fn(collect, db);
      db.close();
    }
    const ghosts = [...CORE_TOOLS].filter(n => !registered.has(n));
    assert.deepEqual(ghosts, [],
      'CORE_TOOLS names a tool that no longer exists — renaming a tool silently shrinks the core profile');
  });
});

describe('guards are inert when switched off', () => {
  before(() => { process.env.MCP_TOOL_GUARDS = 'off'; });
  after(() => { process.env.MCP_TOOL_GUARDS = 'on'; });

  it('installToolGuards returns the server unchanged and nothing is suppressed', async () => {
    let calls = 0;
    const s = mockServer();
    const g = installToolGuards(s, { service: 'kb', db: null });
    assert.equal(g, s, 'no wrapper at all when disabled');
    g.registerTool('t', {}, async () => { calls++; return okResult(); });
    for (let i = 0; i < LOOP_REPEAT_THRESHOLD + 3; i++) await s.handlers.t({ a: 1 });
    assert.equal(calls, LOOP_REPEAT_THRESHOLD + 3, 'every call runs when guards are off');
  });
});
