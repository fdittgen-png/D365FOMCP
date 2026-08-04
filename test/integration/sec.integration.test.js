/**
 * Integration test: Security MCP service over the in-process MCP protocol.
 *
 * Stands up a real `McpServer` with `registerSecTools()` against a tiny
 * in-memory SQLite fixture, then drives it through a real `Client` over
 * the SDK's `InMemoryTransport`. Catches contract regressions (registration,
 * schema serialization, JSON-RPC round trip) the existing unit suite skips.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, firstTextContent } from './harness.js';
import { registerSecTools } from '../../src/azure/sec-tools.js';

// ── Minimal schema + fixtures ────────────────────────────────────────────────
//
// Just enough for sec_lookup_role / sec_stats / sec_search to return data.

const SCHEMA = `
  CREATE TABLE roles (
    role_id TEXT PRIMARY KEY, role_name TEXT NOT NULL, module_id TEXT,
    label TEXT, description TEXT, license_type TEXT,
    permission_type TEXT DEFAULT 'Grant', is_profile INTEGER DEFAULT 0,
    source TEXT DEFAULT 'test'
  );
  CREATE TABLE role_subroles (
    parent_role_id TEXT, child_role_id TEXT, is_transitive INTEGER DEFAULT 0,
    PRIMARY KEY (parent_role_id, child_role_id)
  );
  CREATE TABLE duties (
    duty_id TEXT PRIMARY KEY, duty_name TEXT, module_id TEXT, description TEXT
  );
  CREATE TABLE role_duties (
    role_id TEXT, duty_id TEXT, permission_type TEXT DEFAULT 'Grant',
    PRIMARY KEY (role_id, duty_id)
  );
  CREATE TABLE privileges (
    privilege_name TEXT PRIMARY KEY, module_id TEXT, label TEXT
  );
  CREATE TABLE duty_privileges (
    duty_id TEXT, privilege_name TEXT, PRIMARY KEY (duty_id, privilege_name)
  );
  CREATE TABLE privilege_entry_points (
    privilege_name TEXT, entry_point_name TEXT, object_type TEXT, object_name TEXT,
    grant_read TEXT, grant_create TEXT, grant_update TEXT,
    grant_delete TEXT, grant_correct TEXT, grant_invoke TEXT,
    PRIMARY KEY (privilege_name, entry_point_name)
  );
  CREATE TABLE users (
    user_id TEXT PRIMARY KEY, person_name TEXT, email TEXT,
    enabled INTEGER DEFAULT 1, default_company TEXT
  );
  CREATE TABLE user_roles (
    user_id TEXT, role_id TEXT, PRIMARY KEY (user_id, role_id)
  );
  CREATE TABLE user_role_companies (
    user_id TEXT, role_id TEXT, company_id TEXT,
    PRIMARY KEY (user_id, role_id, company_id)
  );
  CREATE TABLE role_direct_privileges (
    role_id TEXT, privilege_name TEXT, PRIMARY KEY (role_id, privilege_name)
  );
  CREATE TABLE role_direct_entity_permissions (
    role_id TEXT, entity_name TEXT, resource_type TEXT, grant_read TEXT, grant_create TEXT,
    grant_update TEXT, grant_delete TEXT, grant_correct TEXT, grant_invoke TEXT,
    PRIMARY KEY (role_id, entity_name)
  );
  CREATE TABLE sec_search (
    object_type TEXT, object_name TEXT, module_id TEXT, content TEXT
  );
  CREATE TABLE sec_metadata (key TEXT PRIMARY KEY, value TEXT);
`;

const FIXTURES = `
  INSERT INTO roles VALUES ('R1', 'SystemAdministrator', 'System', 'Sys admin', 'Full access', 'Enterprise', 'Grant', 0, 'test');

  INSERT INTO duties VALUES ('VendInvoiceProcess', 'Process vendor invoices', 'ApplicationSuite', 'desc');
  INSERT INTO role_duties VALUES ('R1', 'VendInvoiceProcess', 'Grant');

  INSERT INTO privileges VALUES ('VendInvoiceJournalPost', 'ApplicationSuite', 'Post vendor invoice');
  INSERT INTO duty_privileges VALUES ('VendInvoiceProcess', 'VendInvoiceJournalPost');
  INSERT INTO privilege_entry_points VALUES (
    'VendInvoiceJournalPost', 'VendInvoiceJournal', 'MenuItemAction', 'VendInvoiceJournal',
    'Allow', 'Allow', 'Allow', NULL, NULL, NULL
  );

  INSERT INTO sec_search VALUES ('role', 'SystemAdministrator', 'System', 'SystemAdministrator Full access');

  INSERT INTO sec_metadata VALUES ('build_date', '2026-05-07T00:00:00Z');
  INSERT INTO sec_metadata VALUES ('roles', '1');
`;

// ── Suite ────────────────────────────────────────────────────────────────────

let session;

before(async () => {
  session = await startServer({
    register: registerSecTools,
    schema: SCHEMA,
    fixtures: FIXTURES,
  });
});

after(async () => {
  if (session) await session.close();
});

describe('Security MCP service — in-process protocol', () => {
  it('tools/list exposes Security tools and includes representative names', async () => {
    const { tools } = await session.client.listTools();
    assert.ok(Array.isArray(tools));
    assert.ok(tools.length > 0, 'at least one Security tool must be registered');

    for (const t of tools) {
      assert.equal(typeof t.name, 'string');
      assert.equal(typeof t.description, 'string');
      assert.equal(typeof t.inputSchema, 'object');
    }

    const names = new Set(tools.map(t => t.name));
    for (const expected of ['sec_lookup_role', 'sec_stats', 'sec_search']) {
      assert.ok(names.has(expected), `Security service must register ${expected}; got ${[...names].join(', ')}`);
    }
  });

  it('sec_lookup_role returns a well-shaped CallToolResult on valid input', async () => {
    const result = await session.client.callTool({
      name: 'sec_lookup_role',
      arguments: { role_name: 'SystemAdministrator' },
    });
    assert.ok(Array.isArray(result.content));
    assert.equal(result.content[0].type, 'text');
    assert.equal(typeof result.content[0].text, 'string');
    assert.notEqual(result.isError, true);
    const text = firstTextContent(result);
    assert.match(text, /SystemAdministrator/);
  });

  it('sec_stats returns build metadata', async () => {
    const result = await session.client.callTool({
      name: 'sec_stats',
      arguments: {},
    });
    assert.ok(Array.isArray(result.content));
    assert.notEqual(result.isError, true);
    const text = firstTextContent(result);
    assert.match(text, /build_date/);
  });

  it('sec_search finds the seeded role', async () => {
    const result = await session.client.callTool({
      name: 'sec_search',
      arguments: { query: 'administrator' },
    });
    assert.ok(Array.isArray(result.content));
    assert.notEqual(result.isError, true);
    const text = firstTextContent(result);
    assert.match(text, /SystemAdministrator/);
  });

  it('rejects invalid input (wrong type for required string) with an isError result', async () => {
    // SDK v1.27 returns input-validation failures as a CallToolResult with
    // isError=true and the validation message in content[0].text — it does
    // not throw a client-side exception.
    const result = await session.client.callTool({
      name: 'sec_lookup_role',
      arguments: { role_name: 99 },
    });
    assert.equal(result.isError, true, 'invalid input must set isError on the result');
    const text = firstTextContent(result);
    assert.match(
      text,
      /(invalid|validation|params)/i,
      `expected validation-flavored error text, got: ${text}`,
    );
  });

  it('sec_raw_sql rejects non-SELECT statements at the handler level (not isError-throwing)', async () => {
    // The handler short-circuits write attempts and returns a plain textResult,
    // it does not throw. Pin the contract here so any change is intentional.
    const result = await session.client.callTool({
      name: 'sec_raw_sql',
      arguments: { sql: 'DELETE FROM roles' },
    });
    assert.ok(Array.isArray(result.content));
    const text = firstTextContent(result);
    assert.match(text, /Only SELECT/i);
  });
});
