/**
 * Issue #40 — Zod schema tightening tests.
 *
 * Contract under test:
 *   1. Every string parameter on a kb / xref / sec / taskrecorder tool
 *      MUST reject empty strings via `.min(1)`.
 *   2. Every `limit` parameter MUST be bounded `.min(1).max(500)` (or
 *      tighter where an existing schema is stricter). Negative values
 *      and zero must be rejected by Zod, not silently coerced by the
 *      handler's defensive default.
 *   3. Every `depth` / `max_depth` parameter MUST be bounded so negative
 *      and out-of-range values are rejected.
 *
 * Why TDD: handlers carry defensive defaults (`limit || N`) that mask
 * invalid inputs at the runtime boundary. Tightening the Zod layer
 * adds a *protocol-level* rejection so unsafe values never reach the
 * handler. These tests build `z.object(tool.schema).parse(...)`
 * directly — the mock server bypasses validation, so this is the only
 * place where the schema contract is actually exercised.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import { z, ZodError } from 'zod';

import { registerKbTools } from '../src/azure/kb-tools.js';
import { registerXrefTools } from '../src/azure/xref-tools.js';
import { registerSecTools } from '../src/azure/sec-tools.js';
import { registerTaskRecorderTools } from '../src/azure/taskrecorder-tools.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

// ── Mock server (matches the legacy `server.tool(name, desc, schema, handler)`
// signature used by the rest of the test suite). The handler is collected
// alongside the raw `schema` so the test can build `z.object(schema).parse(...)`
// directly — bypassing the SDK transport just like the production tests do.

function mockServer() {
  const handlers = {};
  return {
    tool: (name, _desc, schema, handler) => {
      handlers[name] = { schema: schema || {}, handler };
    },
    handlers,
  };
}

// ── Minimal in-memory DBs (these tests never invoke handlers — they only
// run schema parsing — but `registerXxxTools` opens the DB during registration
// in some paths, so we hand each one an empty database to keep the call safe).

function emptyKbDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE _kb_dummy (k TEXT);`);
  return db;
}

function emptyXrefDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE _xref_dummy (k TEXT);`);
  return db;
}

function emptySecDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE _sec_dummy (k TEXT);`);
  return db;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function getTool(server, name) {
  const tool = server.handlers[name];
  assert.ok(tool, `tool "${name}" not registered`);
  return tool;
}

/** Assert that parsing `args` against tool schema throws a ZodError. */
function assertRejected(server, toolName, args, message) {
  const tool = getTool(server, toolName);
  assert.throws(
    () => z.object(tool.schema).parse(args),
    (err) => err instanceof ZodError,
    message ?? `${toolName}: expected ZodError for args ${JSON.stringify(args)}`,
  );
}

/** Assert that parsing `args` against tool schema succeeds. */
function assertAccepted(server, toolName, args, message) {
  const tool = getTool(server, toolName);
  assert.doesNotThrow(
    () => z.object(tool.schema).parse(args),
    message ?? `${toolName}: expected args to validate ${JSON.stringify(args)}`,
  );
}

// ── Suite setup ─────────────────────────────────────────────────────────────

let kbServer, xrefServer, secServer, taskServer;

before(() => {
  kbServer = mockServer();
  registerKbTools(kbServer, emptyKbDb());

  xrefServer = mockServer();
  registerXrefTools(xrefServer, emptyXrefDb());

  secServer = mockServer();
  registerSecTools(secServer, emptySecDb());

  taskServer = mockServer();
  registerTaskRecorderTools(taskServer);
});

// ── KB tools — empty string rejection ───────────────────────────────────────

describe('issue #40 — KB tools reject empty strings', () => {
  it('d365_lookup_table.table_name empty rejected', () => {
    assertRejected(kbServer, 'd365_lookup_table', { table_name: '' });
  });
  it('d365_lookup_table.table_name single char accepted', () => {
    assertAccepted(kbServer, 'd365_lookup_table', { table_name: 'X' });
  });

  it('d365_get_join_keys empty rejected', () => {
    assertRejected(kbServer, 'd365_get_join_keys', { table1: '', table2: 'CustTable' });
    assertRejected(kbServer, 'd365_get_join_keys', { table1: 'CustTable', table2: '' });
  });

  it('d365_search.query empty rejected', () => {
    assertRejected(kbServer, 'd365_search', { query: '' });
  });
  it('d365_search.object_type empty rejected when provided', () => {
    assertRejected(kbServer, 'd365_search', { query: 'foo', object_type: '' });
  });

  it('d365_get_enum.enum_name empty rejected', () => {
    assertRejected(kbServer, 'd365_get_enum', { enum_name: '' });
  });

  it('d365_check_field_exists empty rejected', () => {
    assertRejected(kbServer, 'd365_check_field_exists', { table_name: '', field_names: ['x'] });
    assertRejected(kbServer, 'd365_check_field_exists', { table_name: 'CustTable', field_names: [''] });
  });

  it('d365_get_class_methods.name empty rejected', () => {
    assertRejected(kbServer, 'd365_get_class_methods', { name: '' });
  });
  it('d365_get_class_methods.filter empty rejected when provided', () => {
    assertRejected(kbServer, 'd365_get_class_methods', { name: 'X', filter: '' });
  });

  it('d365_get_method_source empty rejected', () => {
    assertRejected(kbServer, 'd365_get_method_source', { owner_name: '', method_name: 'm' });
    assertRejected(kbServer, 'd365_get_method_source', { owner_name: 'C', method_name: '' });
  });

  it('d365_find_referencing_tables empty rejected', () => {
    assertRejected(kbServer, 'd365_find_referencing_tables', { table_name: '' });
  });

  it('d365_get_module_summary empty rejected', () => {
    assertRejected(kbServer, 'd365_get_module_summary', { module_name: '' });
  });

  it('d365_get_entity_sources empty rejected', () => {
    assertRejected(kbServer, 'd365_get_entity_sources', { entity_name: '' });
  });

  // NOTE: d365_sql_template.scenario is intentionally NOT bounded by .min(1).
  // The tool description explicitly says "Leave empty to list all" — it is
  // the documented search-pattern exception. Listed in PR body.
  it('d365_sql_template accepts no scenario (lists all)', () => {
    assertAccepted(kbServer, 'd365_sql_template', {});
  });

  it('d365_hallucination_check empty rejected', () => {
    assertRejected(kbServer, 'd365_hallucination_check', { table_name: '' });
  });

  it('d365_raw_sql.sql empty rejected', () => {
    assertRejected(kbServer, 'd365_raw_sql', { sql: '' });
  });

  it('d365_graph_traverse.start_node empty rejected', () => {
    assertRejected(kbServer, 'd365_graph_traverse', { start_node: '' });
  });
  it('d365_graph_traverse.edge_type empty rejected when provided', () => {
    assertRejected(kbServer, 'd365_graph_traverse', { start_node: 'X', edge_type: '' });
  });

  it('d365_field_renames empty rejected', () => {
    assertRejected(kbServer, 'd365_field_renames', { table_name: '' });
  });

  it('d365_resolve_label rejects empty string members', () => {
    assertRejected(kbServer, 'd365_resolve_label', { label_ids: [''] });
  });
});

describe('issue #40 — KB tools reject invalid limit/depth', () => {
  it('d365_search: limit=0 rejected', () => {
    assertRejected(kbServer, 'd365_search', { query: 'foo', limit: 0 });
  });
  it('d365_search: limit=-1 rejected', () => {
    assertRejected(kbServer, 'd365_search', { query: 'foo', limit: -1 });
  });
  it('d365_search: limit=501 rejected (above max)', () => {
    assertRejected(kbServer, 'd365_search', { query: 'foo', limit: 501 });
  });
  it('d365_search: limit=1 accepted', () => {
    assertAccepted(kbServer, 'd365_search', { query: 'foo', limit: 1 });
  });
  it('d365_search: limit=500 accepted', () => {
    assertAccepted(kbServer, 'd365_search', { query: 'foo', limit: 500 });
  });

  it('d365_get_class_methods: limit=0 rejected', () => {
    assertRejected(kbServer, 'd365_get_class_methods', { name: 'X', limit: 0 });
  });
  it('d365_get_class_methods: limit=-5 rejected', () => {
    assertRejected(kbServer, 'd365_get_class_methods', { name: 'X', limit: -5 });
  });

  it('d365_graph_traverse: max_depth=-1 rejected', () => {
    assertRejected(kbServer, 'd365_graph_traverse', { start_node: 'X', max_depth: -1 });
  });
  it('d365_graph_traverse: max_depth=11 rejected (above max=10)', () => {
    assertRejected(kbServer, 'd365_graph_traverse', { start_node: 'X', max_depth: 11 });
  });
  it('d365_graph_traverse: max_depth=0 accepted (lower bound)', () => {
    assertAccepted(kbServer, 'd365_graph_traverse', { start_node: 'X', max_depth: 0 });
  });
  it('d365_graph_traverse: max_depth=10 accepted (upper bound)', () => {
    assertAccepted(kbServer, 'd365_graph_traverse', { start_node: 'X', max_depth: 10 });
  });
});

// ── XRef tools — empty string rejection ─────────────────────────────────────

describe('issue #40 — XRef tools reject empty strings', () => {
  it('xref_find_references empty rejected', () => {
    assertRejected(xrefServer, 'xref_find_references', { object_name: '' });
  });

  it('xref_find_usages empty rejected', () => {
    assertRejected(xrefServer, 'xref_find_usages', { object_name: '' });
  });

  it('xref_find_method_callers empty rejected', () => {
    assertRejected(xrefServer, 'xref_find_method_callers', { object_name: '', method_name: 'm' });
    assertRejected(xrefServer, 'xref_find_method_callers', { object_name: 'C', method_name: '' });
  });

  it('xref_class_hierarchy.class_name empty rejected', () => {
    assertRejected(xrefServer, 'xref_class_hierarchy', { class_name: '' });
  });

  it('xref_interface_implementors empty rejected', () => {
    assertRejected(xrefServer, 'xref_interface_implementors', { interface_name: '' });
  });

  it('xref_search_names.pattern empty rejected', () => {
    assertRejected(xrefServer, 'xref_search_names', { pattern: '' });
  });

  it('xref_method_references empty rejected', () => {
    assertRejected(xrefServer, 'xref_method_references', { object_name: '', method_name: 'm' });
    assertRejected(xrefServer, 'xref_method_references', { object_name: 'C', method_name: '' });
  });

  it('xref_module_objects empty rejected', () => {
    assertRejected(xrefServer, 'xref_module_objects', { module_name: '' });
  });

  it('xref_cross_module_deps empty rejected', () => {
    assertRejected(xrefServer, 'xref_cross_module_deps', { module_name: '' });
  });

  it('xref_raw_sql.sql empty rejected', () => {
    assertRejected(xrefServer, 'xref_raw_sql', { sql: '' });
  });

  it('xref_impact_analysis.object_name empty rejected', () => {
    assertRejected(xrefServer, 'xref_impact_analysis', { object_name: '' });
  });

  it('xref_object_summary.object_name empty rejected', () => {
    assertRejected(xrefServer, 'xref_object_summary', { object_name: '' });
  });

  it('xref_find_extensions.object_name empty rejected', () => {
    assertRejected(xrefServer, 'xref_find_extensions', { object_name: '' });
  });

  it('xref_find_field_usages empty rejected', () => {
    assertRejected(xrefServer, 'xref_find_field_usages', { table_name: '', field_name: 'f' });
    assertRejected(xrefServer, 'xref_find_field_usages', { table_name: 'T', field_name: '' });
  });

  it('xref_find_event_handlers empty rejected', () => {
    assertRejected(xrefServer, 'xref_find_event_handlers', { object_name: '' });
    // method_name is optional; empty string when provided must also be rejected
    assertRejected(xrefServer, 'xref_find_event_handlers', { object_name: 'X', method_name: '' });
  });
});

describe('issue #40 — XRef tools reject invalid limit', () => {
  it('xref_find_references: limit=0 rejected', () => {
    assertRejected(xrefServer, 'xref_find_references', { object_name: 'X', limit: 0 });
  });
  it('xref_find_references: limit=-1 rejected', () => {
    assertRejected(xrefServer, 'xref_find_references', { object_name: 'X', limit: -1 });
  });
  it('xref_find_references: limit=501 rejected', () => {
    assertRejected(xrefServer, 'xref_find_references', { object_name: 'X', limit: 501 });
  });

  it('xref_find_usages: limit=-100 rejected', () => {
    assertRejected(xrefServer, 'xref_find_usages', { object_name: 'X', limit: -100 });
  });

  it('xref_search_names: limit=0 rejected', () => {
    assertRejected(xrefServer, 'xref_search_names', { pattern: 'foo', limit: 0 });
  });

  it('xref_module_objects: limit=501 rejected', () => {
    assertRejected(xrefServer, 'xref_module_objects', { module_name: 'X', limit: 501 });
  });

  it('xref_cross_module_deps: limit=-1 rejected', () => {
    assertRejected(xrefServer, 'xref_cross_module_deps', { module_name: 'X', limit: -1 });
  });
});

// ── Sec tools — empty string rejection ──────────────────────────────────────

describe('issue #40 — Sec tools reject empty strings', () => {
  it('sec_lookup_role empty rejected', () => {
    assertRejected(secServer, 'sec_lookup_role', { role_name: '' });
  });

  it('sec_lookup_duty empty rejected', () => {
    assertRejected(secServer, 'sec_lookup_duty', { duty_name: '' });
  });

  it('sec_lookup_privilege empty rejected', () => {
    assertRejected(secServer, 'sec_lookup_privilege', { privilege_name: '' });
  });

  it('sec_lookup_user empty rejected', () => {
    assertRejected(secServer, 'sec_lookup_user', { user_id: '' });
  });

  it('sec_role_hierarchy empty rejected', () => {
    assertRejected(secServer, 'sec_role_hierarchy', { role_name: '' });
  });

  it('sec_find_users_by_role empty rejected', () => {
    assertRejected(secServer, 'sec_find_users_by_role', { role_name: '' });
  });
  it('sec_find_users_by_role.company_id empty rejected when provided', () => {
    assertRejected(secServer, 'sec_find_users_by_role', { role_name: 'X', company_id: '' });
  });

  it('sec_find_roles_by_duty empty rejected', () => {
    assertRejected(secServer, 'sec_find_roles_by_duty', { duty_name: '' });
  });

  it('sec_find_roles_by_privilege empty rejected', () => {
    assertRejected(secServer, 'sec_find_roles_by_privilege', { privilege_name: '' });
  });

  it('sec_company_users empty rejected', () => {
    assertRejected(secServer, 'sec_company_users', { company_id: '' });
  });

  it('sec_permission_trace empty rejected', () => {
    assertRejected(secServer, 'sec_permission_trace', { role_name: '' });
    assertRejected(secServer, 'sec_permission_trace', { role_name: 'X', object_name: '' });
  });

  it('sec_compare_roles empty rejected', () => {
    assertRejected(secServer, 'sec_compare_roles', { role1: '', role2: 'X' });
    assertRejected(secServer, 'sec_compare_roles', { role1: 'X', role2: '' });
  });

  it('sec_effective_permissions empty rejected when provided', () => {
    assertRejected(secServer, 'sec_effective_permissions', { user_id: '' });
    assertRejected(secServer, 'sec_effective_permissions', { role_name: '' });
    assertRejected(secServer, 'sec_effective_permissions', { user_id: 'u', object_name: '' });
  });

  it('sec_search.query empty rejected', () => {
    assertRejected(secServer, 'sec_search', { query: '' });
  });

  it('sec_raw_sql.sql empty rejected', () => {
    assertRejected(secServer, 'sec_raw_sql', { sql: '' });
  });
});

describe('issue #40 — Sec tools reject invalid limit', () => {
  it('sec_find_users_by_role: limit=0 rejected', () => {
    assertRejected(secServer, 'sec_find_users_by_role', { role_name: 'X', limit: 0 });
  });
  it('sec_find_users_by_role: limit=-1 rejected', () => {
    assertRejected(secServer, 'sec_find_users_by_role', { role_name: 'X', limit: -1 });
  });
  it('sec_find_users_by_role: limit=501 rejected', () => {
    assertRejected(secServer, 'sec_find_users_by_role', { role_name: 'X', limit: 501 });
  });

  it('sec_company_users: limit=-1 rejected', () => {
    assertRejected(secServer, 'sec_company_users', { company_id: 'C', limit: -1 });
  });

  it('sec_permission_trace: limit=0 rejected', () => {
    assertRejected(secServer, 'sec_permission_trace', { role_name: 'X', limit: 0 });
  });

  it('sec_effective_permissions: limit=-100 rejected', () => {
    assertRejected(secServer, 'sec_effective_permissions', { user_id: 'u', limit: -100 });
  });

  it('sec_search: limit=0 rejected', () => {
    assertRejected(secServer, 'sec_search', { query: 'foo', limit: 0 });
  });
});

// ── Task Recorder tool ──────────────────────────────────────────────────────

describe('issue #40 — Task Recorder rejects empty strings', () => {
  it('taskrecorder_to_markdown.file_url empty rejected when provided', () => {
    assertRejected(taskServer, 'taskrecorder_to_markdown', { file_url: '' });
  });
  it('taskrecorder_to_markdown.file_content empty rejected when provided', () => {
    assertRejected(taskServer, 'taskrecorder_to_markdown', { file_content: '' });
  });
  it('taskrecorder_to_markdown.file_name empty rejected when provided', () => {
    assertRejected(taskServer, 'taskrecorder_to_markdown', { file_url: 'http://x', file_name: '' });
  });
  it('taskrecorder_to_markdown.file_name omitted accepts default', () => {
    assertAccepted(taskServer, 'taskrecorder_to_markdown', { file_url: 'http://x' });
  });
});
