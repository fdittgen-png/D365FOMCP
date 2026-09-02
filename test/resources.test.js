/**
 * MCP resources + tool titles (W5.B, #109 part B).
 *
 * `d365://snapshot` and `d365://modules` are registered on the registration
 * path for every service; every tool carries a `title`. Measured over a real
 * McpServer and SDK Client — the shapes here are what a client receives.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { registerResources, snapshotInfo, modulesInfo, RESOURCE_URIS } from '../src/azure/resources.js';
import { registerServiceTools, deriveToolTitle, TOOL_SETS } from '../src/azure/tool-sets.js';
import { serverInfo, serverOptions } from '../src/azure/server-metadata.js';
import { MODEL_VERSIONS_SCHEMA } from '../src/azure/model-descriptors.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

delete process.env.MCP_TOOL_PROFILE;

const dbs = [];
after(() => { for (const d of dbs) { try { d.close(); } catch { /* closed */ } } });

function kbDb({ withModels = true, withMeta = true } = {}) {
  const db = new Database(':memory:');
  dbs.push(db);
  if (withMeta) {
    db.exec('CREATE TABLE kb_metadata (key TEXT PRIMARY KEY, value TEXT)');
    db.prepare('INSERT INTO kb_metadata VALUES (?,?)').run('build_date', '2026-08-14T09:30:00.000Z');
    db.prepare('INSERT INTO kb_metadata VALUES (?,?)').run('schema_version', '1.1');
  }
  if (withModels) {
    db.exec(MODEL_VERSIONS_SCHEMA);
    const ins = db.prepare('INSERT INTO model_versions (model_name, module_id, display_name, publisher, layer, origin, version, source_root) VALUES (?,?,?,?,?,?,?,?)');
    ins.run('ApplicationSuite', 'ApplicationSuite', 'Application Suite', 'Microsoft Corporation', 'SYS', 'microsoft', '10.0.2263.172', 'C:\\Packages');
    ins.run('iExtension', 'iExtension', 'iExtension', 'Trelleborg', 'ISV', 'custom', '1.0.0.0', 'C:\\Workspace');
  }
  return db;
}

async function connect(server) {
  const client = new Client({ name: 'resources-test', version: '0.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, close: async () => { try { await client.close(); } catch { /* noop */ } try { await server.close(); } catch { /* noop */ } } };
}

describe('resources — documents', () => {
  it('snapshotInfo reports build date, schema version, model count, tool count and ISV state', () => {
    const s = snapshotInfo({ db: kbDb(), service: 'kb', toolCount: () => 21 });
    assert.deepEqual(s, {
      service: 'kb',
      build_date: '2026-08-14T09:30:00.000Z',
      snapshot_date: '2026-08-14',
      schema_version: '1.1',
      model_count: 2,
      tool_count: 21,
      isv_scanned: false,
    });
  });

  it('degrades to nulls / zeros on a database that predates the tables, and on no database', () => {
    const empty = new Database(':memory:'); dbs.push(empty);
    assert.deepEqual(snapshotInfo({ db: empty, service: 'xref', toolCount: 3 }),
      { service: 'xref', build_date: null, snapshot_date: null, schema_version: null, model_count: 0, tool_count: 3, isv_scanned: false });
    assert.deepEqual(snapshotInfo({ db: null, service: 'taskrecorder', toolCount: 2 }),
      { service: 'taskrecorder', build_date: null, snapshot_date: null, schema_version: null, model_count: 0, tool_count: 2, isv_scanned: false });
    assert.deepEqual(modulesInfo({ db: empty, service: 'xref' }), { service: 'xref', snapshot_date: null, model_count: 0, models: [] });
  });

  it('modulesInfo is the model_versions list a client would otherwise pay d365_list_modules for', () => {
    const m = modulesInfo({ db: kbDb(), service: 'kb' });
    assert.equal(m.model_count, 2);
    assert.deepEqual(m.models.map(r => r.model_name), ['ApplicationSuite', 'iExtension']);
    assert.deepEqual(Object.keys(m.models[0]).sort(), ['display_name', 'layer', 'model_name', 'module_id', 'origin', 'publisher', 'version']);
  });

  it('is a silent no-op on a server without registerResource (the test mocks)', () => {
    assert.deepEqual(registerResources({ registerTool() {} }, { db: kbDb(), service: 'kb' }), []);
    assert.deepEqual(registerResources(null, { service: 'kb' }), []);
  });
});

describe('resources — over the wire, registered by registerServiceTools', () => {
  it('KB lists snapshot + modules and reads both as application/json', async () => {
    const db = kbDb();
    const server = new McpServer(serverInfo('kb'), serverOptions('kb'));
    const stats = registerServiceTools('kb', server, db);
    const { client, close } = await connect(server);
    try {
      const list = await client.listResources();
      assert.deepEqual(list.resources.map(r => r.uri).sort(), [RESOURCE_URIS.modules, RESOURCE_URIS.snapshot]);
      for (const r of list.resources) {
        assert.equal(r.mimeType, 'application/json');
        assert.ok(r.title && r.description, `${r.uri} carries title + description`);
      }

      const snap = await client.readResource({ uri: RESOURCE_URIS.snapshot });
      assert.equal(snap.contents[0].uri, RESOURCE_URIS.snapshot);
      assert.equal(snap.contents[0].mimeType, 'application/json');
      const s = JSON.parse(snap.contents[0].text);
      assert.equal(s.service, 'kb');
      assert.equal(s.snapshot_date, '2026-08-14');
      assert.equal(s.schema_version, '1.1');
      assert.equal(s.model_count, 2);
      assert.equal(s.tool_count, stats.registered, 'tool_count is what this registration actually registered');
      assert.equal(s.tool_count, 21);
      assert.equal(s.isv_scanned, false);

      const mods = JSON.parse((await client.readResource({ uri: RESOURCE_URIS.modules })).contents[0].text);
      assert.equal(mods.model_count, 2);
      assert.equal(mods.models[1].origin, 'custom');
    } finally { await close(); }
  });

  it('Task Recorder (no database) exposes the snapshot resource only', async () => {
    const server = new McpServer(serverInfo('taskrecorder'), serverOptions('taskrecorder'));
    registerServiceTools('taskrecorder', server);
    const { client, close } = await connect(server);
    try {
      const list = await client.listResources();
      assert.deepEqual(list.resources.map(r => r.uri), [RESOURCE_URIS.snapshot]);
      const s = JSON.parse((await client.readResource({ uri: RESOURCE_URIS.snapshot })).contents[0].text);
      assert.equal(s.service, 'taskrecorder');
      assert.equal(s.build_date, null);
      assert.equal(s.tool_count, 2);
    } finally { await close(); }
  });

  it('the snapshot resource is never a protocol error, even when the database is closed under it', async () => {
    const db = kbDb();
    const server = new McpServer(serverInfo('xref'), serverOptions('xref'));
    registerServiceTools('xref', server, db);
    const { client, close } = await connect(server);
    try {
      db.close();
      const s = JSON.parse((await client.readResource({ uri: RESOURCE_URIS.snapshot })).contents[0].text);
      assert.ok(s.service === 'xref' || s.error, 'either the document (dates cached) or an error document — never a thrown -32603');
    } finally { await close(); }
  });
});

describe('tool titles', () => {
  it('derives a sentence-case display name, dropping the service prefix and keeping acronyms', () => {
    assert.equal(deriveToolTitle('d365_lookup_table'), 'Lookup table');
    assert.equal(deriveToolTitle('xref_find_references'), 'Find references');
    assert.equal(deriveToolTitle('sec_lookup_role'), 'Lookup role');
    assert.equal(deriveToolTitle('d365_raw_sql'), 'Raw SQL');
    assert.equal(deriveToolTitle('d365_isv_extension_points'), 'ISV extension points');
    assert.equal(deriveToolTitle('xref_isv_find_usages'), 'ISV find usages');
    assert.equal(deriveToolTitle('taskrecorder_to_markdown'), 'To markdown');
    assert.equal(deriveToolTitle('search'), 'Search', 'a bare name is not a prefix');
  });

  it('every tool of every server carries a title; a title set by the tool file wins', async () => {
    for (const svc of Object.keys(TOOL_SETS)) {
      const db = new Database(':memory:'); dbs.push(db);
      const server = new McpServer(serverInfo(svc), serverOptions(svc));
      registerServiceTools(svc, server, db);
      const { client, close } = await connect(server);
      try {
        const { tools } = await client.listTools();
        const untitled = tools.filter(t => !t.title || !t.title.trim()).map(t => t.name);
        assert.deepEqual(untitled, [], `${svc}: tools without a title`);
        for (const t of tools) {
          assert.ok(t.title.length <= 40, `${t.name}: title "${t.title}" is a display name, not a description`);
          assert.notEqual(t.title, t.name);
        }
      } finally { await close(); }
    }

    const own = { registered: {}, registerTool(name, cfg) { this.registered[name] = cfg; } };
    const { withRegistrationPolicy } = await import('../src/azure/tool-sets.js');
    const view = withRegistrationPolicy(own, { service: 'kb', db: null, profile: 'full' });
    view.registerTool('d365_search', { title: 'Search the AOT' }, async () => ({}));
    view.registerTool('d365_lookup_table', {}, async () => ({}));
    assert.equal(own.registered.d365_search.title, 'Search the AOT');
    assert.equal(own.registered.d365_lookup_table.title, 'Lookup table');
  });
});
