/**
 * Freshness banner (rule #4, issue #86 base).
 *
 * `_KB snapshot: YYYY-MM-DD_` on the line after the H2 of every DATA response
 * of a snapshot-backed tool — attached centrally on the registration path
 * (tool-sets.js), never on emptyResult / notFoundResult / errorResult, never on
 * a live tool, never on a server with no database.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';

import {
  freshnessBanner, snapshotDate, readBuildDate, withFreshnessBanner,
  structuredResult, emptyResult, notFoundResult, errorResult,
  READ_ONLY_DB_ANNOTATIONS, READ_ONLY_LIVE_ANNOTATIONS,
} from '../src/azure/shared.js';
import { withRegistrationPolicy } from '../src/azure/tool-sets.js';
import { installToolGuards, resetToolGuards, readBuildDate as guardsReadBuildDate } from '../src/azure/tool-guards.js';
import { runWithRequestContext } from '../src/azure/request-context.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const dbs = [];
after(() => { for (const d of dbs) { try { d.close(); } catch { /* closed */ } } });

function dbWith(table, iso) {
  const db = new Database(':memory:');
  dbs.push(db);
  if (table) {
    db.exec(`CREATE TABLE ${table} (key TEXT PRIMARY KEY, value TEXT)`);
    if (iso) db.prepare(`INSERT INTO ${table} VALUES ('build_date', ?)`).run(iso);
  }
  return db;
}

const data = (heading = '## Table CustTable') =>
  structuredResult({ table_name: 'CustTable', field_count: 1 }, `${heading}\n\n| a |\n|---|\n| 1 |`);

describe('freshnessBanner', () => {
  it('formats `_<Service> snapshot: YYYY-MM-DD_` from each service metadata table', () => {
    assert.equal(freshnessBanner(dbWith('kb_metadata', '2026-08-14T09:30:00.000Z'), 'kb'), '_KB snapshot: 2026-08-14_');
    assert.equal(freshnessBanner(dbWith('xref_metadata', '2026-07-01T00:00:00Z'), 'xref'), '_XRef snapshot: 2026-07-01_');
    assert.equal(freshnessBanner(dbWith('sec_metadata', '2026-06-10T00:00:00Z'), 'sec'), '_Sec snapshot: 2026-06-10_');
    assert.match(freshnessBanner(dbWith('kb_metadata', '2026-08-14T09:30:00.000Z'), 'kb'), /^_KB snapshot: \d{4}-\d{2}-\d{2}_$/);
  });

  it('is empty — and never throws — when the snapshot cannot be dated', () => {
    assert.equal(freshnessBanner(dbWith(null), 'kb'), '', 'no metadata table');
    assert.equal(freshnessBanner(dbWith('kb_metadata', null), 'kb'), '', 'no build_date row');
    assert.equal(freshnessBanner(dbWith('kb_metadata', 'not-a-date'), 'kb'), '', 'unparsable date');
    assert.equal(freshnessBanner(null, 'kb'), '');
    assert.equal(freshnessBanner(undefined, 'kb'), '');
    assert.equal(freshnessBanner({ prepare() { throw new Error('closed'); } }, 'kb'), '');
    assert.equal(readBuildDate(dbWith(null)), null);
    assert.equal(guardsReadBuildDate, readBuildDate, 'tool-guards re-exports the shared reader — one implementation');
  });

  it('is cached per database handle', () => {
    const db = dbWith('kb_metadata', '2026-01-01T00:00:00Z');
    assert.equal(snapshotDate(db), '2026-01-01');
    db.prepare("UPDATE kb_metadata SET value = '2030-12-31T00:00:00Z' WHERE key = 'build_date'").run();
    assert.equal(snapshotDate(db), '2026-01-01', 'a read-only snapshot cannot change under an open handle; read once');
    assert.equal(snapshotDate(dbWith('kb_metadata', '2030-12-31T00:00:00Z')), '2030-12-31', 'a new handle is a new key');
  });
});

describe('withFreshnessBanner', () => {
  const db = () => dbWith('kb_metadata', '2026-08-14T00:00:00Z');

  it('puts the banner on the line directly after the H2, so rule #3 still holds', () => {
    const r = withFreshnessBanner(data(), db(), 'kb');
    const lines = r.content[0].text.split('\n');
    assert.equal(lines[0], '## Table CustTable');
    assert.equal(lines[1], '_KB snapshot: 2026-08-14_');
    assert.equal(lines[2], '', 'the original blank line follows the banner');
    assert.deepEqual(r.structuredContent, { table_name: 'CustTable', field_count: 1 }, 'payload untouched');
    assert.equal(r.isError, undefined);
  });

  it('is idempotent and prepends when there is no heading', () => {
    const once = withFreshnessBanner(data(), db(), 'kb');
    assert.deepEqual(withFreshnessBanner(once, db(), 'kb'), once);
    const plain = withFreshnessBanner({ content: [{ type: 'text', text: 'rows: 1' }], structuredContent: { n: 1 } }, db(), 'kb');
    assert.equal(plain.content[0].text, '_KB snapshot: 2026-08-14_\n\nrows: 1');
  });

  it('never touches emptyResult / notFoundResult / errorResult — they stamp themselves with _meta.kind', () => {
    const empty = emptyResult('tables', { tables: [], count: 0 });
    const missing = notFoundResult('Table', 'Foo', ['Bar']);
    const failed = errorResult('db-error', 'hint');
    assert.equal(empty._meta.kind, 'empty');
    assert.equal(missing._meta.kind, 'not-found');
    assert.equal(failed._meta.kind, 'error');
    for (const meta of [empty, missing, failed]) {
      const out = withFreshnessBanner(meta, db(), 'kb');
      assert.equal(out, meta, 'returned as-is (same object)');
      assert.ok(!out.content[0].text.includes('snapshot:'), `no banner on ${meta._meta.kind}`);
    }
    // Belt and braces: an isError result without _meta, and a text-only result.
    assert.ok(!withFreshnessBanner({ isError: true, content: [{ type: 'text', text: '## Error' }] }, db(), 'kb').content[0].text.includes('snapshot'));
    assert.ok(!withFreshnessBanner({ content: [{ type: 'text', text: '## Doc' }] }, db(), 'kb').content[0].text.includes('snapshot'));
  });

  it('leaves the response alone when the snapshot is undatable', () => {
    const r = data();
    assert.equal(withFreshnessBanner(r, dbWith(null), 'kb'), r);
  });

  it('goes into the summary text channel too (it is ~30 B and the one thing the summary cannot say)', async () => {
    await runWithRequestContext({ profile: 'full', textChannel: 'summary' }, () => {
      const r = withFreshnessBanner(data(), db(), 'kb');
      const lines = r.content[0].text.split('\n');
      assert.equal(lines[0], '## Table CustTable');
      assert.equal(lines[1], '_KB snapshot: 2026-08-14_');
      assert.match(lines[3], /^_Payload in structuredContent/);
      assert.ok(Buffer.byteLength(r.content[0].text) <= 330);
    });
  });
});

describe('central wiring on the registration path (tool-sets.js)', () => {
  const mock = () => { const handlers = {}; return { handlers, registerTool(n, _c, h) { handlers[n] = h; } }; };
  const db = () => dbWith('sec_metadata', '2026-06-10T00:00:00Z');

  it('a snapshot tool gets the banner; a live tool (openWorldHint) and a db-less server do not', async () => {
    const s = mock();
    const view = withRegistrationPolicy(s, { service: 'sec', db: db(), profile: 'full' });
    view.registerTool('sec_stats', { annotations: READ_ONLY_DB_ANNOTATIONS }, async () => data('## Security stats'));
    view.registerTool('d365_custom_fields', { annotations: READ_ONLY_LIVE_ANNOTATIONS }, async () => data('## Custom fields (live)'));
    view.registerTool('sec_lookup_role', { annotations: READ_ONLY_DB_ANNOTATIONS }, async () => notFoundResult('Role', 'Nope'));
    view.registerTool('sec_search', { annotations: READ_ONLY_DB_ANNOTATIONS }, async () => emptyResult('roles', { roles: [] }));

    const stats = await s.handlers.sec_stats({});
    assert.equal(stats.content[0].text.split('\n')[1], '_Sec snapshot: 2026-06-10_');
    const live = await s.handlers.d365_custom_fields({});
    assert.ok(!live.content[0].text.includes('snapshot:'), 'live rows are not stamped with a build date they do not have');
    assert.ok(!(await s.handlers.sec_lookup_role({})).content[0].text.includes('snapshot:'));
    assert.ok(!(await s.handlers.sec_search({})).content[0].text.includes('snapshot:'));

    const noDb = mock();
    withRegistrationPolicy(noDb, { service: 'taskrecorder', db: null, profile: 'full' })
      .registerTool('taskrecorder_to_markdown', {}, async () => data('## Recording'));
    assert.ok(!(await noDb.handlers.taskrecorder_to_markdown({})).content[0].text.includes('snapshot:'));
  });

  it('layers with the guards the way kb/xref/sec-tools do: banner after the H2, staleness note at the end', async () => {
    process.env.MCP_TOOL_GUARDS = 'on';
    resetToolGuards();
    try {
      const old = dbWith('kb_metadata', new Date(Date.now() - 400 * 86_400_000).toISOString());
      const s = mock();
      const guarded = installToolGuards(withRegistrationPolicy(s, { service: 'kb', db: old, profile: 'full' }), { service: 'kb', db: old });
      guarded.registerTool('d365_lookup_table', { annotations: READ_ONLY_DB_ANNOTATIONS }, async () => data());
      const r = await s.handlers.d365_lookup_table({ table_name: 'CustTable' });
      const lines = r.content[0].text.split('\n');
      assert.equal(lines[0], '## Table CustTable');
      assert.match(lines[1], /^_KB snapshot: \d{4}-\d{2}-\d{2}_$/);
      assert.match(r.content[0].text, /snapshot was built \d+ days ago/, 'the one-shot staleness note still lands');
      assert.deepEqual(r.structuredContent, { table_name: 'CustTable', field_count: 1 });
    } finally {
      delete process.env.MCP_TOOL_GUARDS;
      resetToolGuards();
    }
  });

  it('end to end over a real McpServer: the client sees the banner on data and _meta.kind on meta-responses', async () => {
    const server = new McpServer({ name: 'freshness-test', version: '0.0.0' });
    const view = withRegistrationPolicy(server, { service: 'xref', db: dbWith('xref_metadata', '2026-07-01T00:00:00Z'), profile: 'full' });
    const out = z.object({ n: z.number() });
    view.registerTool('xref_object_summary', { inputSchema: { name: z.string() }, outputSchema: out.shape, annotations: READ_ONLY_DB_ANNOTATIONS },
      async ({ name }) => name === 'missing'
        ? emptyResult('objects', { n: 0 })
        : structuredResult({ n: 1 }, `## Summary ${name}\n\n| n |\n|---|\n| 1 |`));

    const client = new Client({ name: 't', version: '0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    try {
      const hit = await client.callTool({ name: 'xref_object_summary', arguments: { name: 'CustTable' } });
      assert.equal(hit.content[0].text.split('\n')[1], '_XRef snapshot: 2026-07-01_');
      assert.deepEqual(hit.structuredContent, { n: 1 });
      const miss = await client.callTool({ name: 'xref_object_summary', arguments: { name: 'missing' } });
      assert.ok(!miss.content[0].text.includes('snapshot:'));
      assert.equal(miss._meta?.kind, 'empty', '_meta survives the wire (it is part of the MCP Result type)');
    } finally {
      await client.close(); await server.close();
    }
  });
});
