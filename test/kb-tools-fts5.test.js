/**
 * Tests for d365_search FTS5 + LIKE fallback (issue #17).
 *
 * Two fixtures are exercised:
 *   1. A KB DB WITHOUT kb_search_fts — exercises the LIKE fallback path
 *      (the existing, pre-issue-#17 behaviour for already-built KBs).
 *   2. A KB DB WITH kb_search_fts populated — exercises the FTS5 MATCH
 *      path (mirrors the sec_search FTS5+LIKE-fallback pattern).
 *
 * Both fixtures share the same kb_search rows so the two paths can be
 * compared. The FTS5 path is also performance-checked against the
 * <10ms target stated in the issue.
 *
 * Run: npm test
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

// -- Shared fixture rows ----------------------------------------------------

const KB_SEARCH_ROWS = [
  ['table', 'CustTable', 'ApplicationSuite', 'CustTable Customer master table with account number party'],
  ['table', 'VendTable', 'ApplicationSuite', 'VendTable Vendor master table with vendor account'],
  ['class', 'SalesFormLetter', 'ApplicationSuite', 'SalesFormLetter Sales order posting form letter'],
  ['enum',  'StatusIssue',     'ApplicationSuite', 'StatusIssue Issue status inventory'],
  ['entity','CustCustomerEntity','ApplicationSuite','CustCustomerEntity Customer entity OData'],
];

/** Mock server matching the kb-tools test harness. */
function createMockServer() {
  const handlers = {};
  return {
    tool: (name, _desc, schema, handler) => {
      handlers[name] = { schema, handler };
    },
    registerTool: (name, config, handler) => {
      handlers[name] = {
        schema: config.inputSchema || {},
        handler,
      };
    },
    handlers,
  };
}

async function callTool(handlers, name, args) {
  const tool = handlers[name];
  if (!tool) throw new Error(`Tool "${name}" not registered`);
  // Default to Markdown for renderer assertions (TOON tests pass format:'toon').
  const result = await tool.handler({ format: 'markdown', ...args });
  return { text: result.content[0].text, full: result };
}

function buildKbSchema(db) {
  // Minimum schema d365_search references plus the kb_search index table.
  db.exec(`
    CREATE TABLE kb_search (
      object_type TEXT, object_name TEXT, module_id TEXT, content TEXT
    );
  `);
  const ins = db.prepare('INSERT INTO kb_search VALUES (?,?,?,?)');
  for (const row of KB_SEARCH_ROWS) ins.run(...row);
}

// -- Suite 1: LIKE fallback (no kb_search_fts) ------------------------------

describe('d365_search — LIKE fallback (kb_search_fts absent)', () => {
  let db;
  let handlers;

  before(async () => {
    db = new Database(':memory:');
    db.pragma('journal_mode = OFF');
    buildKbSchema(db);
    // Note: kb_search_fts intentionally NOT created — exercises the fallback.

    const { registerKbTools } = await import('../src/azure/kb-tools.js');
    const server = createMockServer();
    registerKbTools(server, db);
    handlers = server.handlers;
  });

  after(() => { if (db) db.close(); });

  it('confirms the FTS5 table is absent in this fixture', () => {
    const rows = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='kb_search_fts'`
    ).all();
    assert.equal(rows.length, 0, 'kb_search_fts should not exist in the fallback fixture');
  });

  it('finds tables by single keyword via LIKE', async () => {
    const { text } = await callTool(handlers, 'd365_search', { query: 'Customer' });
    assert.match(text, /CustTable/);
  });

  it('finds objects by multi-word query (AND semantics) via LIKE', async () => {
    const { text } = await callTool(handlers, 'd365_search', { query: 'posting form letter' });
    assert.match(text, /SalesFormLetter/);
  });

  it('object_type filter applies on the fallback path', async () => {
    const { text } = await callTool(handlers, 'd365_search', { query: 'Customer', object_type: 'table' });
    assert.match(text, /CustTable/);
    assert.doesNotMatch(text, /CustCustomerEntity/);
  });

  it('returns no-results message for unknown keyword on fallback', async () => {
    const { text } = await callTool(handlers, 'd365_search', { query: 'xyznonexistent' });
    assert.match(text, /No matches for "xyznonexistent" found/);
  });
});

// -- Suite 2: FTS5 path (kb_search_fts present) -----------------------------

describe('d365_search — FTS5 path (kb_search_fts present)', () => {
  let db;
  let handlers;

  before(async () => {
    db = new Database(':memory:');
    db.pragma('journal_mode = OFF');
    buildKbSchema(db);

    // Create kb_search_fts virtual table mirroring the build-kb.js definition.
    // Content-external — references kb_search via rowid.
    db.exec(`
      CREATE VIRTUAL TABLE kb_search_fts USING fts5(
        object_name, content,
        content='kb_search', content_rowid='rowid'
      );
    `);
    // Populate FTS index from kb_search rows (same 'rebuild' command the
    // builder uses).
    db.exec(`INSERT INTO kb_search_fts(kb_search_fts) VALUES('rebuild')`);

    const { registerKbTools } = await import('../src/azure/kb-tools.js');
    const server = createMockServer();
    registerKbTools(server, db);
    handlers = server.handlers;
  });

  after(() => { if (db) db.close(); });

  it('confirms the FTS5 table is present and populated in this fixture', () => {
    const rows = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='kb_search_fts'`
    ).all();
    assert.equal(rows.length, 1, 'kb_search_fts should exist in the FTS5 fixture');
    const count = db.prepare(`SELECT COUNT(*) AS n FROM kb_search_fts`).get().n;
    assert.ok(count >= KB_SEARCH_ROWS.length, 'kb_search_fts should be populated');
  });

  it('finds tables by single keyword via MATCH', async () => {
    const { text } = await callTool(handlers, 'd365_search', { query: 'Customer' });
    assert.match(text, /CustTable/);
  });

  it('supports prefix matching (Cust matches CustTable and CustCustomerEntity)', async () => {
    const { text } = await callTool(handlers, 'd365_search', { query: 'Cust' });
    assert.match(text, /CustTable/);
    assert.match(text, /CustCustomerEntity/);
  });

  it('multi-term query uses AND semantics via MATCH', async () => {
    const { text } = await callTool(handlers, 'd365_search', { query: 'posting form letter' });
    assert.match(text, /SalesFormLetter/);
    // CustTable's content does not contain all three terms.
    assert.doesNotMatch(text, /CustTable/);
  });

  it('object_type filter applies on the FTS5 path', async () => {
    const { text } = await callTool(handlers, 'd365_search', { query: 'Customer', object_type: 'table' });
    assert.match(text, /CustTable/);
    assert.doesNotMatch(text, /CustCustomerEntity/);
  });

  it('FTS5 path responds in under 10ms for typical queries', async () => {
    // Issue #17 acceptance criterion 4. With ~5 rows in :memory: this is
    // a generous ceiling; the real prod gain is on a 1 GB DB.
    const t0 = process.hrtime.bigint();
    await callTool(handlers, 'd365_search', { query: 'Customer' });
    const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(elapsedMs < 10, `FTS5 search took ${elapsedMs.toFixed(2)}ms (>10ms)`);
  });

  it('returns no-results message for unknown keyword on FTS5 path', async () => {
    const { text } = await callTool(handlers, 'd365_search', { query: 'xyznonexistent' });
    assert.match(text, /No matches for "xyznonexistent" found/);
  });

  it('quoted-term escaping: terms with FTS5 operator chars do not blow up', async () => {
    // A user-supplied term like `customer-master` contains a `-`, which is
    // an FTS5 operator. The handler must quote-escape so the query does
    // not throw. We accept either a hit or a no-result, but not an error.
    const { text } = await callTool(handlers, 'd365_search', { query: 'customer-master' });
    assert.ok(typeof text === 'string', 'must return a string body, not throw');
  });
});
