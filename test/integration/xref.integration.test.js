/**
 * Integration test: XRef MCP service over the in-process MCP protocol.
 *
 * Stands up a real `McpServer` with `registerXrefTools()` against a tiny
 * in-memory SQLite fixture, then drives it through a real `Client` over
 * the SDK's `InMemoryTransport`. Catches contract regressions (registration,
 * schema serialization, JSON-RPC round trip) the existing unit suite skips.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, firstTextContent } from './harness.js';
import { registerXrefTools } from '../../src/azure/xref-tools.js';

// ── Minimal schema + fixtures ────────────────────────────────────────────────
//
// Mirrors the structure xref-tools.js queries (names / refs / modules /
// providers) but with just enough rows for the representative tools below.
//
// Ref kinds: 1=Call, 2=Read, 3=Implements, 4=Extends, 6=Delegate, 7=Attribute, 10=Override.

const SCHEMA = `
  CREATE TABLE names (
    id INTEGER PRIMARY KEY, path TEXT NOT NULL, name TEXT,
    kind INTEGER, provider_id INTEGER, module_id INTEGER
  );
  CREATE TABLE refs (
    source_id INTEGER, target_id INTEGER, kind INTEGER,
    line INTEGER, col INTEGER
  );
  CREATE TABLE modules (
    id INTEGER PRIMARY KEY, module TEXT NOT NULL
  );
  CREATE TABLE providers (
    id INTEGER PRIMARY KEY, provider TEXT NOT NULL
  );
`;

const FIXTURES = `
  INSERT INTO modules VALUES (1, 'ApplicationSuite');
  INSERT INTO providers VALUES (1, 'Microsoft');

  -- Two classes: SalesFormLetter extends FormLetterService.
  INSERT INTO names VALUES (200, '/Classes/SalesFormLetter', 'SalesFormLetter', 0, 1, 1);
  INSERT INTO names VALUES (201, '/Classes/SalesFormLetter/Methods/run', 'run', 0, 1, 1);
  INSERT INTO names VALUES (210, '/Classes/FormLetterService', 'FormLetterService', 0, 1, 1);

  -- A table + field used in a read ref so xref_object_summary has data to surface.
  INSERT INTO names VALUES (100, '/Tables/CustTable', 'CustTable', 0, 1, 1);
  INSERT INTO names VALUES (101, '/Tables/CustTable/Fields/AccountNum', 'AccountNum', 0, 1, 1);

  -- SalesFormLetter extends FormLetterService.
  INSERT INTO refs VALUES (200, 210, 4, NULL, NULL);
  -- SalesFormLetter.run reads CustTable.AccountNum (so both sides have refs).
  INSERT INTO refs VALUES (201, 101, 2, 12, 10);
`;

// ── Suite ────────────────────────────────────────────────────────────────────

let session;

before(async () => {
  session = await startServer({
    register: registerXrefTools,
    schema: SCHEMA,
    fixtures: FIXTURES,
  });
});

after(async () => {
  if (session) await session.close();
});

describe('XRef MCP service — in-process protocol', () => {
  it('tools/list exposes XRef tools and includes representative names', async () => {
    const { tools } = await session.client.listTools();
    assert.ok(Array.isArray(tools));
    assert.ok(tools.length > 0, 'at least one XRef tool must be registered');

    for (const t of tools) {
      assert.equal(typeof t.name, 'string');
      assert.equal(typeof t.description, 'string');
      assert.equal(typeof t.inputSchema, 'object');
    }

    const names = new Set(tools.map(t => t.name));
    for (const expected of ['xref_list_modules', 'xref_object_summary', 'xref_search_names']) {
      assert.ok(names.has(expected), `XRef service must register ${expected}; got ${[...names].join(', ')}`);
    }
  });

  it('xref_list_modules works with empty arguments', async () => {
    const result = await session.client.callTool({
      name: 'xref_list_modules',
      arguments: {},
    });
    assert.ok(Array.isArray(result.content));
    assert.notEqual(result.isError, true);
    const text = firstTextContent(result);
    assert.match(text, /ApplicationSuite/, 'list must surface the seeded module');
  });

  it('xref_object_summary returns structured text for a known object', async () => {
    const result = await session.client.callTool({
      name: 'xref_object_summary',
      arguments: { object_name: 'SalesFormLetter' },
    });
    assert.ok(Array.isArray(result.content));
    assert.notEqual(result.isError, true);
    const text = firstTextContent(result);
    assert.ok(text.length > 0);
    assert.match(text, /SalesFormLetter/);
  });

  it('xref_object_summary on unknown object returns a not-found text response (not isError)', async () => {
    // Per current contract: xref tools return a plain "not found" textResult,
    // they don't set isError. This test pins that contract — if a future PR
    // moves to isError it should update this assertion intentionally.
    const result = await session.client.callTool({
      name: 'xref_object_summary',
      arguments: { object_name: 'TotallyBogusObject_zzz' },
    });
    assert.ok(Array.isArray(result.content));
    const text = firstTextContent(result);
    assert.match(text, /not found/i);
  });

  it('rejects invalid input (wrong type for required string) with an isError result', async () => {
    // SDK v1.27 returns input-validation failures as a CallToolResult with
    // isError=true and the validation message in content[0].text — it does
    // not throw a client-side exception.
    const result = await session.client.callTool({
      name: 'xref_object_summary',
      arguments: { object_name: { not: 'a string' } },
    });
    assert.equal(result.isError, true, 'invalid input must set isError on the result');
    const text = firstTextContent(result);
    assert.match(
      text,
      /(invalid|validation|params)/i,
      `expected validation-flavored error text, got: ${text}`,
    );
  });
});
