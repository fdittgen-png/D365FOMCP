/**
 * Integration test: KB MCP service over the in-process MCP protocol.
 *
 * This test does NOT call tool handlers directly — it stands up a real
 * `McpServer`, registers `registerKbTools()` against an in-memory SQLite
 * fixture, and drives it through a real `Client` connected by the SDK's
 * `InMemoryTransport`. That covers what the existing kb-tools.test.js
 * deliberately skips: tool registration, schema serialization, and the
 * JSON-RPC round trip (initialize → tools/list → tools/call).
 *
 * Per acceptance criteria for issue #31:
 *  - tools/list returns at least one tool
 *  - representative tools return well-shaped CallToolResult on valid input
 *  - invalid input is rejected with an MCP error (or isError result)
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, firstTextContent } from './harness.js';
import { registerKbTools } from '../../src/azure/kb-tools.js';

// ── Minimal schema + fixtures ─────────────────────────────────────────────────
//
// Only what the representative tools (`d365_lookup_table`, `d365_search`,
// `d365_list_modules`) actually read. The full kb-tools.test.js suite covers
// every column; this file stays minimal on purpose.

const SCHEMA = `
  CREATE TABLE tables (
    table_name TEXT PRIMARY KEY, module_id TEXT, label TEXT,
    table_group TEXT, save_per_company INTEGER DEFAULT 1,
    cache_lookup TEXT, clustered_index TEXT, replacement_key TEXT,
    field_count INTEGER DEFAULT 0
  );
  CREATE TABLE fields (
    table_name TEXT, field_name TEXT, field_type TEXT, edt TEXT,
    enum_type TEXT, mandatory INTEGER DEFAULT 0,
    PRIMARY KEY (table_name, field_name)
  );
  CREATE TABLE indexes_tbl (
    table_name TEXT, index_name TEXT, is_unique INTEGER DEFAULT 0,
    is_clustered INTEGER DEFAULT 0, fields_json TEXT,
    PRIMARY KEY (table_name, index_name)
  );
  CREATE TABLE relations (
    source_table TEXT, related_table TEXT, relation_name TEXT,
    constraints_json TEXT, relationship_type TEXT, on_delete TEXT
  );
  CREATE TABLE kb_search (
    object_type TEXT, object_name TEXT, module_id TEXT, content TEXT
  );
  CREATE TABLE modules (
    module_id TEXT PRIMARY KEY, table_count INTEGER DEFAULT 0,
    class_count INTEGER DEFAULT 0, enum_count INTEGER DEFAULT 0,
    entity_count INTEGER DEFAULT 0, form_count INTEGER DEFAULT 0
  );
`;

const FIXTURES = `
  INSERT INTO tables VALUES ('CustTable', 'ApplicationSuite', 'Customer master', 'Main', 1, 'Found', 'AccountIdx', 'AccountNum', 2);
  INSERT INTO fields VALUES ('CustTable', 'AccountNum', 'String', 'CustAccount', NULL, 1);
  INSERT INTO fields VALUES ('CustTable', 'CustGroup', 'String', 'CustGroupId', NULL, 0);
  INSERT INTO indexes_tbl VALUES ('CustTable', 'AccountIdx', 1, 1, '["AccountNum"]');
  INSERT INTO kb_search VALUES ('table', 'CustTable', 'ApplicationSuite', 'CustTable Customer master');
  INSERT INTO modules VALUES ('ApplicationSuite', 50, 100, 30, 10, 20);
`;

// ── Suite ────────────────────────────────────────────────────────────────────

let session;

before(async () => {
  session = await startServer({
    register: registerKbTools,
    schema: SCHEMA,
    fixtures: FIXTURES,
  });
});

after(async () => {
  if (session) await session.close();
});

describe('KB MCP service — in-process protocol', () => {
  it('tools/list exposes KB tools and includes representative names', async () => {
    const { tools } = await session.client.listTools();
    assert.ok(Array.isArray(tools), 'listTools must return a tools array');
    assert.ok(tools.length > 0, 'at least one KB tool must be registered');

    // Every tool entry must have name, description, and inputSchema (per MCP spec).
    for (const t of tools) {
      assert.equal(typeof t.name, 'string', `tool entry missing string name: ${JSON.stringify(t)}`);
      assert.equal(typeof t.description, 'string', `tool ${t.name} missing description`);
      assert.equal(typeof t.inputSchema, 'object', `tool ${t.name} missing inputSchema`);
    }

    const names = new Set(tools.map(t => t.name));
    for (const expected of ['d365_lookup_table', 'd365_search', 'd365_list_modules']) {
      assert.ok(names.has(expected), `KB service must register ${expected}; got ${[...names].join(', ')}`);
    }
  });

  it('d365_lookup_table returns a well-shaped CallToolResult on valid input', async () => {
    const result = await session.client.callTool({
      name: 'd365_lookup_table',
      arguments: { table_name: 'CustTable' },
    });
    // Structural assertions, not substring assertions.
    assert.ok(Array.isArray(result.content), 'CallToolResult.content must be an array');
    assert.equal(result.content[0].type, 'text', 'first content item must be type=text');
    assert.equal(typeof result.content[0].text, 'string', 'text must be a string');
    assert.notEqual(result.isError, true, 'valid lookup must not set isError');
    // The tool's contract is "compact Markdown summary" — it must mention the table somewhere.
    const text = firstTextContent(result);
    assert.ok(text.length > 0, 'lookup must return non-empty markdown');
    assert.match(text, /CustTable/, 'lookup output must reference the table name');
  });

  it('d365_search returns rows for a known fixture term', async () => {
    const result = await session.client.callTool({
      name: 'd365_search',
      arguments: { query: 'Customer', limit: 5 },
    });
    assert.ok(Array.isArray(result.content));
    assert.notEqual(result.isError, true);
    const text = firstTextContent(result);
    assert.match(text, /CustTable/, 'search must surface the seeded CustTable row');
  });

  it('d365_list_modules works with no arguments', async () => {
    const result = await session.client.callTool({
      name: 'd365_list_modules',
      arguments: {},
    });
    assert.ok(Array.isArray(result.content));
    assert.notEqual(result.isError, true);
    const text = firstTextContent(result);
    assert.match(text, /ApplicationSuite/);
  });

  it('rejects invalid input (wrong type for required string) with an isError result', async () => {
    // d365_lookup_table requires `table_name: z.string()`. Passing a number
    // must trip the SDK's input validation. SDK v1.27 surfaces this as an
    // isError CallToolResult (not a thrown exception): the server throws an
    // McpError, the SDK serializes it back as a JSON-RPC error embedded in a
    // CallToolResult with isError=true.
    const result = await session.client.callTool({
      name: 'd365_lookup_table',
      arguments: { table_name: 12345 },
    });
    assert.equal(result.isError, true, 'invalid input must set isError on the result');
    const text = firstTextContent(result);
    assert.match(
      text,
      /(invalid|validation|params)/i,
      `expected validation-flavored error text, got: ${text}`,
    );
  });

  it('rejects oversized LIKE pattern via the project guard (issue #42)', async () => {
    // The handler uses validateLikePattern() from shared.js; oversize input
    // must come back as isError + a clean message, not a DB exception.
    const result = await session.client.callTool({
      name: 'd365_search',
      arguments: { query: 'x'.repeat(200) },
    });
    assert.equal(result.isError, true, 'oversized pattern must set isError');
    const text = firstTextContent(result);
    assert.match(text, /too long/i);
  });
});
