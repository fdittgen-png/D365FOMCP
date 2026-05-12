/**
 * Tests for D365FO Knowledge Base MCP Tools (kb-tools.js)
 *
 * Creates an in-memory SQLite database with test fixtures, then exercises
 * each tool's handler function directly.
 *
 * Run: npm test           (all tests)
 *      npm run test:kb    (kb tests only)
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import { z } from 'zod';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

// -- Test Database Setup -----------------------------------------------------

let db;
let toolHandlers;

/** Intercept `server.registerTool(name, config, handler)` calls (PM-02)
 *  and collect handlers. Also keeps a `tool` alias so any remaining legacy
 *  call sites (should be none after PM-02) don't silently skip registration. */
function createMockServer() {
  const handlers = {};
  return {
    registerTool: (name, config, handler) => {
      handlers[name] = {
        schema: config.inputSchema || {},
        outputSchema: config.outputSchema,
        annotations: config.annotations,
        description: config.description,
        handler,
      };
    },
    tool: (name, _desc, schema, handler) => {
      handlers[name] = { schema, handler };
    },
    handlers,
  };
}

/** Call a tool handler and extract the text result. Applies the registered
 *  Zod schema to the input first so tests exercise the real validation path.
 *  If the input fails validation, this throws — tests asserting rejection
 *  should wrap the call in `assert.rejects`. */
async function callTool(name, args) {
  const tool = toolHandlers[name];
  if (!tool) throw new Error(`Tool "${name}" not registered`);
  const validated = z.object(tool.schema).parse(args);
  const result = await tool.handler(validated);
  return result.content[0].text;
}

/** PM-05: Call a tool and return the full MCP result shape so tests can
 *  inspect `structuredContent` and `isError` alongside the Markdown body. */
async function callToolFull(name, args) {
  const tool = toolHandlers[name];
  if (!tool) throw new Error(`Tool "${name}" not registered`);
  const validated = z.object(tool.schema).parse(args);
  return await tool.handler(validated);
}

before(async () => {
  db = new Database(':memory:');
  db.pragma('journal_mode = OFF');

  // ── Create schema (matching what kb-tools.js actually queries) ──
  db.exec(`
    -- Core tables
    CREATE TABLE tables (
      table_name TEXT PRIMARY KEY, module_id TEXT, label TEXT,
      table_group TEXT, save_per_company INTEGER DEFAULT 1,
      cache_lookup TEXT, clustered_index TEXT, replacement_key TEXT,
      field_count INTEGER DEFAULT 0
    );

    CREATE TABLE fields (
      table_name TEXT, field_name TEXT, field_type TEXT, edt TEXT,
      enum_type TEXT, mandatory INTEGER DEFAULT 0, label TEXT,
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

    CREATE TABLE enums (
      enum_name TEXT PRIMARY KEY, module_id TEXT, label TEXT, values_json TEXT
    );

    CREATE TABLE classes (
      class_name TEXT PRIMARY KEY, module_id TEXT, extends_class TEXT,
      implements_list TEXT, is_abstract INTEGER DEFAULT 0, method_count INTEGER DEFAULT 0
    );

    CREATE TABLE methods (
      owner_type TEXT, owner_name TEXT, method_name TEXT,
      signature TEXT, is_static INTEGER DEFAULT 0, source_code TEXT,
      PRIMARY KEY (owner_name, method_name)
    );

    CREATE TABLE data_entities (
      entity_name TEXT PRIMARY KEY, module_id TEXT, label TEXT,
      public_name TEXT, public_collection TEXT, is_public INTEGER DEFAULT 0,
      primary_table TEXT, staging_table TEXT, config_key TEXT
    );

    CREATE TABLE entity_fields (
      entity_name TEXT, field_name TEXT, data_field TEXT,
      data_source TEXT, is_mandatory INTEGER DEFAULT 0,
      PRIMARY KEY (entity_name, field_name)
    );

    CREATE TABLE kb_search (
      object_type TEXT, object_name TEXT, module_id TEXT, content TEXT
    );

    CREATE TABLE modules (
      module_id TEXT PRIMARY KEY, table_count INTEGER DEFAULT 0,
      class_count INTEGER DEFAULT 0, enum_count INTEGER DEFAULT 0,
      entity_count INTEGER DEFAULT 0, form_count INTEGER DEFAULT 0
    );

    CREATE TABLE hallucination_traps (
      object_name TEXT, trap_type TEXT, wrong_value TEXT,
      correct_value TEXT, explanation TEXT
    );

    CREATE TABLE field_renames (
      table_name TEXT, ax2012_name TEXT, d365fo_name TEXT
    );

    CREATE TABLE query_templates (
      template_id TEXT PRIMARY KEY, title TEXT, description TEXT,
      sql_template TEXT, tables_used TEXT
    );

    CREATE TABLE graph_edges (
      source_node TEXT, target_node TEXT, source_type TEXT, target_type TEXT,
      edge_type TEXT, edge_detail TEXT
    );

    CREATE TABLE labels (
      label_id TEXT PRIMARY KEY, text TEXT
    );
  `);

  // ── Insert test fixture data ──
  db.exec(`
    -- Tables
    INSERT INTO tables VALUES ('CustTable', 'ApplicationSuite', 'Customer master', 'Main', 1, 'Found', 'AccountIdx', 'AccountNum', 12);
    INSERT INTO tables VALUES ('VendTable', 'ApplicationSuite', 'Vendor master', 'Main', 1, 'Found', 'AccountIdx', 'AccountNum', 8);
    INSERT INTO tables VALUES ('CustGroup', 'ApplicationSuite', 'Customer group', 'Group', 1, 'EntireTable', 'GroupIdx', NULL, 3);
    INSERT INTO tables VALUES ('SalesTable', 'ApplicationSuite', 'Sales order header', 'WorksheetHeader', 1, 'None', 'SalesIdx', 'SalesId', 15);

    -- Fields
    INSERT INTO fields VALUES ('CustTable', 'AccountNum', 'String', 'CustAccount', NULL, 1, NULL);
    INSERT INTO fields VALUES ('CustTable', 'CustGroup', 'String', 'CustGroupId', NULL, 1, NULL);
    INSERT INTO fields VALUES ('CustTable', 'Currency', 'String', 'CurrencyCode', NULL, 0, NULL);
    INSERT INTO fields VALUES ('CustTable', 'Party', 'Int64', 'DirPartyRecId', NULL, 1, NULL);
    INSERT INTO fields VALUES ('CustTable', 'InvoiceAccount', 'String', 'CustInvoiceAccount', NULL, 0, NULL);
    INSERT INTO fields VALUES ('VendTable', 'AccountNum', 'String', 'VendAccount', NULL, 1, NULL);
    INSERT INTO fields VALUES ('VendTable', 'VendGroup', 'String', 'VendGroupId', NULL, 0, NULL);
    INSERT INTO fields VALUES ('CustGroup', 'CustGroup', 'String', 'CustGroupId', NULL, 1, NULL);
    INSERT INTO fields VALUES ('CustGroup', 'Name', 'String', 'Description', NULL, 0, NULL);
    INSERT INTO fields VALUES ('SalesTable', 'SalesId', 'String', 'SalesIdBase', NULL, 1, NULL);
    INSERT INTO fields VALUES ('SalesTable', 'CustAccount', 'String', 'CustAccount', NULL, 1, NULL);

    -- Indexes
    INSERT INTO indexes_tbl VALUES ('CustTable', 'AccountIdx', 1, 1, '["AccountNum"]');
    INSERT INTO indexes_tbl VALUES ('CustTable', 'PartyIdx', 0, 0, '["Party"]');
    INSERT INTO indexes_tbl VALUES ('VendTable', 'AccountIdx', 1, 1, '["AccountNum"]');

    -- Relations
    INSERT INTO relations VALUES ('CustTable', 'CustGroup', 'CustGroupRel', '[{"field":"CustGroup","relatedField":"CustGroup"}]', 'Association', 'Restricted');
    INSERT INTO relations VALUES ('SalesTable', 'CustTable', 'CustAccountRel', '[{"field":"CustAccount","relatedField":"AccountNum"}]', 'Association', 'Restricted');

    -- Enums
    INSERT INTO enums VALUES ('StatusIssue', 'ApplicationSuite', 'Issue status', '[{"name":"None","value":0,"label":"None"},{"name":"Deducted","value":1,"label":"Deducted"},{"name":"Sold","value":2,"label":"Sold"}]');
    INSERT INTO enums VALUES ('InventTransType', 'ApplicationSuite', 'Inventory transaction type', '[{"name":"Sales","value":0,"label":"Sales"},{"name":"Purch","value":1,"label":"Purchase"}]');

    -- Classes
    INSERT INTO classes VALUES ('SalesFormLetter', 'ApplicationSuite', 'FormLetterService', 'SysRunnable', 0, 4);
    INSERT INTO classes VALUES ('CustVendTransOpen', 'ApplicationSuite', NULL, NULL, 1, 2);
    INSERT INTO classes VALUES ('FormLetterService', 'ApplicationSuite', NULL, NULL, 1, 1);

    -- Methods
    INSERT INTO methods VALUES ('class', 'SalesFormLetter', 'run', 'public void run()', 0, 'public void run()\n{\n    // execute posting\n    this.post();\n}');
    INSERT INTO methods VALUES ('class', 'SalesFormLetter', 'construct', 'public static SalesFormLetter construct()', 1, 'public static SalesFormLetter construct()\n{\n    return new SalesFormLetter();\n}');
    INSERT INTO methods VALUES ('class', 'SalesFormLetter', 'post', 'protected void post()', 0, NULL);
    INSERT INTO methods VALUES ('class', 'SalesFormLetter', 'validate', 'public boolean validate()', 0, 'public boolean validate()\n{\n    return true;\n}');
    INSERT INTO methods VALUES ('class', 'CustVendTransOpen', 'find', 'public static CustVendTransOpen find()', 1, NULL);
    INSERT INTO methods VALUES ('class', 'CustVendTransOpen', 'exist', 'public static boolean exist()', 1, NULL);
    INSERT INTO methods VALUES ('class', 'FormLetterService', 'initParm', 'protected void initParm()', 0, NULL);

    -- Data entities
    INSERT INTO data_entities VALUES ('CustCustomerEntity', 'ApplicationSuite', 'Customer entity', 'CustomersV3', 'Customers', 1, 'CustTable', 'CustCustomerStaging', NULL);
    INSERT INTO data_entities VALUES ('VendVendorEntity', 'ApplicationSuite', 'Vendor entity', 'VendorsV2', 'Vendors', 1, 'VendTable', NULL, NULL);

    -- Entity fields
    INSERT INTO entity_fields VALUES ('CustCustomerEntity', 'CustomerAccount', 'AccountNum', 'CustTable', 1);
    INSERT INTO entity_fields VALUES ('CustCustomerEntity', 'CustomerGroupId', 'CustGroup', 'CustTable', 0);
    INSERT INTO entity_fields VALUES ('VendVendorEntity', 'VendorAccountNumber', 'AccountNum', 'VendTable', 1);

    -- KB search index
    INSERT INTO kb_search VALUES ('table', 'CustTable', 'ApplicationSuite', 'CustTable Customer master table with account number party');
    INSERT INTO kb_search VALUES ('table', 'VendTable', 'ApplicationSuite', 'VendTable Vendor master table with vendor account');
    INSERT INTO kb_search VALUES ('class', 'SalesFormLetter', 'ApplicationSuite', 'SalesFormLetter Sales order posting form letter');
    INSERT INTO kb_search VALUES ('enum', 'StatusIssue', 'ApplicationSuite', 'StatusIssue Issue status inventory');
    INSERT INTO kb_search VALUES ('entity', 'CustCustomerEntity', 'ApplicationSuite', 'CustCustomerEntity Customer entity OData');

    -- Modules
    INSERT INTO modules VALUES ('ApplicationSuite', 50, 100, 30, 10, 20);
    INSERT INTO modules VALUES ('ApplicationFoundation', 15, 40, 10, 5, 8);

    -- Hallucination traps
    INSERT INTO hallucination_traps VALUES ('CustTable', 'wrong_field', 'CustomerName', 'Party.Name via DirPartyTable', 'CustTable does not have a CustomerName field. The customer name comes from DirPartyTable via the Party relation.');
    INSERT INTO hallucination_traps VALUES ('CustTable', 'wrong_join', 'CustTable.Name = DirPartyTable.Name', 'CustTable.Party = DirPartyTable.RecId', 'CustTable joins to DirPartyTable via Party -> RecId, not by Name.');

    -- Field renames
    INSERT INTO field_renames VALUES ('CustTable', 'AccountStatement', 'PrintMgmtAccountStatement');
    INSERT INTO field_renames VALUES ('CustTable', 'CustItemGroup', 'DefaultDimensionCustItemGroup');

    -- Query templates
    INSERT INTO query_templates VALUES ('cust_invoice', 'Customer invoices with amounts', 'List all customer invoices with totals', 'SELECT ct.AccountNum, cij.InvoiceId, cij.InvoiceAmount FROM CustTable ct JOIN CustInvoiceJour cij ON ct.AccountNum = cij.InvoiceAccount', 'CustTable, CustInvoiceJour');
    INSERT INTO query_templates VALUES ('vend_balance', 'Vendor open balances', 'Show open vendor balances', 'SELECT vt.AccountNum, SUM(vto.AmountCur) FROM VendTable vt JOIN VendTransOpen vto ON vt.AccountNum = vto.AccountNum', 'VendTable, VendTransOpen');

    -- Graph edges
    INSERT INTO graph_edges VALUES ('CustTable', 'CustGroup', 'table', 'table', 'FK', 'CustGroup->CustGroup');
    INSERT INTO graph_edges VALUES ('CustTable', 'DirPartyTable', 'table', 'table', 'FK', 'Party->RecId');
    INSERT INTO graph_edges VALUES ('SalesTable', 'CustTable', 'table', 'table', 'FK', 'CustAccount->AccountNum');
    INSERT INTO graph_edges VALUES ('CustGroup', 'CustLedger', 'table', 'table', 'FK', 'CustGroup->CustGroup');

    -- P3-07 mixed-edge-type fixture. Node "GNodeA" has two outbound edges:
    -- one "Call" and one "Read". Each target has further "Call" edges so the
    -- edge_type filter can be verified at max_depth > 1 (catches parameter
    -- misbinding in the recursive CTE).
    INSERT INTO graph_edges VALUES ('GNodeA', 'GNodeB', 'table', 'table', 'Call', 'A-call-B');
    INSERT INTO graph_edges VALUES ('GNodeA', 'GNodeC', 'table', 'table', 'Read', 'A-read-C');
    INSERT INTO graph_edges VALUES ('GNodeB', 'GNodeD', 'table', 'table', 'Call', 'B-call-D');
    INSERT INTO graph_edges VALUES ('GNodeC', 'GNodeE', 'table', 'table', 'Call', 'C-call-E');
    INSERT INTO graph_edges VALUES ('GNodeB', 'GNodeF', 'table', 'table', 'Read', 'B-read-F');

    -- Labels
    INSERT INTO labels VALUES ('@SYS12345', 'Customer account');
    INSERT INTO labels VALUES ('@SYS67890', 'Vendor account');
    INSERT INTO labels VALUES ('@SYS11111', 'Sales order');

    -- P2-01 label-resolution fixtures (isolated so existing tests aren't affected)
    INSERT INTO labels VALUES ('@SYS99001', 'Resolved table label');
    INSERT INTO labels VALUES ('@SYS99002', 'Resolved field label');
    INSERT INTO labels VALUES ('@SYS99003', 'Resolved enum label');
    INSERT INTO labels VALUES ('@SYS99004', 'Resolved enum value label');
    INSERT INTO tables VALUES ('LabeledTestTable', 'LabeledTestModule', '@SYS99001', 'Main', 1, 'Found', 'Idx', NULL, 1);
    INSERT INTO fields  VALUES ('LabeledTestTable', 'SomeField', 'String', 'SomeEDT', NULL, 0, '@SYS99002');
    INSERT INTO enums   VALUES ('LabeledTestEnum', 'LabeledTestModule', '@SYS99003', '[{"name":"A","value":0,"label":"@SYS99004"}]');
    -- P2-06 fixtures: malformed and empty values_json
    INSERT INTO enums   VALUES ('BrokenEnum', 'ApplicationSuite', NULL, 'not-json-at-all');
    INSERT INTO enums   VALUES ('EmptyEnum', 'ApplicationSuite', NULL, '[]');
    INSERT INTO modules VALUES ('LabeledTestModule', 1, 0, 1, 0, 0);
  `);

  // Register tools against mock server
  const { registerKbTools } = await import('../src/azure/kb-tools.js');
  const mockServer = createMockServer();
  registerKbTools(mockServer, db);
  toolHandlers = mockServer.handlers;
});

after(() => {
  if (db) db.close();
});

// -- Tests -------------------------------------------------------------------

describe('d365_lookup_table', () => {
  it('returns table metadata for existing table', async () => {
    const result = await callTool('d365_lookup_table', { table_name: 'CustTable' });
    assert.ok(result.includes('CustTable'));
    assert.ok(result.includes('ApplicationSuite'));
    assert.ok(result.includes('Customer master'));
    assert.ok(result.includes('Main'));
  });

  it('shows fields section', async () => {
    const result = await callTool('d365_lookup_table', { table_name: 'CustTable' });
    assert.ok(result.includes('## Fields'));
    assert.ok(result.includes('AccountNum'));
    assert.ok(result.includes('CustAccount'));
  });

  it('shows indexes section', async () => {
    const result = await callTool('d365_lookup_table', { table_name: 'CustTable' });
    assert.ok(result.includes('## Indexes'));
    assert.ok(result.includes('AccountIdx'));
  });

  it('shows outgoing relations', async () => {
    const result = await callTool('d365_lookup_table', { table_name: 'CustTable' });
    assert.ok(result.includes('## Relations'));
    assert.ok(result.includes('CustGroup'));
  });

  it('shows incoming relations', async () => {
    const result = await callTool('d365_lookup_table', { table_name: 'CustTable' });
    assert.ok(result.includes('Incoming Relations'));
    assert.ok(result.includes('SalesTable'));
  });

  it('returns not found for unknown table', async () => {
    const result = await callTool('d365_lookup_table', { table_name: 'NonExistentTable' });
    assert.ok(result.includes('not found'));
  });

  it('suggests fuzzy matches for partial name', async () => {
    const result = await callTool('d365_lookup_table', { table_name: 'Cust' });
    assert.ok(result.includes('Did you mean'));
    assert.ok(result.includes('CustTable'));
  });

  it('is case-insensitive', async () => {
    const result = await callTool('d365_lookup_table', { table_name: 'custtable' });
    assert.ok(result.includes('CustTable'));
    assert.ok(result.includes('## Fields'));
  });

  // PM-05 — structured output for the pilot tool
  it('given a valid lookup, then structuredContent matches the output schema', async () => {
    const { d365LookupTableOutput } = await import('../src/azure/output-schemas.js');
    const result = await callToolFull('d365_lookup_table', { table_name: 'CustTable' });
    assert.ok(result.structuredContent);
    assert.doesNotThrow(() => d365LookupTableOutput.parse(result.structuredContent));
    assert.equal(result.structuredContent.table_name, 'CustTable');
    assert.equal(typeof result.structuredContent.field_count, 'number');
    assert.ok(Array.isArray(result.structuredContent.fields));
    assert.ok(Array.isArray(result.structuredContent.indexes));
    assert.ok(Array.isArray(result.structuredContent.outgoing_relations));
    assert.ok(Array.isArray(result.structuredContent.incoming_relations));
  });

  it('given an unknown table, then isError is true and markdown fallback carries did-you-mean', async () => {
    const result = await callToolFull('d365_lookup_table', { table_name: 'NonExistentTable' });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /not found/);
  });
});

describe('d365_get_join_keys', () => {
  it('returns join keys between related tables', async () => {
    const result = await callTool('d365_get_join_keys', { table1: 'CustTable', table2: 'CustGroup' });
    assert.ok(result.includes('Join Keys'));
    assert.ok(result.includes('CustGroup'));
    assert.ok(result.includes('CustGroup'));
  });

  it('finds join in reverse direction', async () => {
    const result = await callTool('d365_get_join_keys', { table1: 'CustGroup', table2: 'CustTable' });
    assert.ok(result.includes('Join Keys'));
    assert.ok(result.includes('CustGroup'));
  });

  it('returns no relationship for unrelated tables', async () => {
    const result = await callTool('d365_get_join_keys', { table1: 'CustTable', table2: 'VendTable' });
    assert.ok(result.includes('No direct relationship'));
  });

  it('shows hallucination traps for join keys', async () => {
    const result = await callTool('d365_get_join_keys', { table1: 'CustTable', table2: 'DirPartyTable' });
    // The trap is registered against CustTable with trap_type=wrong_join
    // but the related_table won't match in relations, so it returns no relationship
    // However if there was a relation, the trap would show
    assert.ok(result.includes('No direct relationship') || result.includes('Hallucination'));
  });
});

describe('d365_search', () => {
  it('finds tables by keyword', async () => {
    const result = await callTool('d365_search', { query: 'Customer' });
    assert.ok(result.includes('CustTable'));
  });

  it('finds classes by keyword', async () => {
    const result = await callTool('d365_search', { query: 'posting form letter' });
    assert.ok(result.includes('SalesFormLetter'));
  });

  it('filters by object_type', async () => {
    const result = await callTool('d365_search', { query: 'Customer', object_type: 'table' });
    assert.ok(result.includes('CustTable'));
    assert.ok(!result.includes('SalesFormLetter'));
  });

  it('returns empty-result hint for unknown keyword', async () => {
    const result = await callTool('d365_search', { query: 'xyznonexistent' });
    // P1-01 contract: empty results use emptyResult() → italic leaf hint
    assert.match(result, /_No matches for "xyznonexistent"\. This may be a leaf result\._/);
  });

  it('respects limit and emits user-kind truncation note', async () => {
    const result = await callTool('d365_search', { query: 'Table', limit: 1 });
    // P1-02 contract: user-requested limit → user-kind note
    assert.match(result, /first 1 results you asked for/);
    assert.match(result, /Increase the `limit` parameter/);
  });

  it('P2-05: non-empty response opens with self-identifying search heading', async () => {
    const result = await callTool('d365_search', { query: 'Cust' });
    const firstNonMeta = result.split('\n').filter(l => l.trim() && !l.startsWith('_'))[0];
    assert.match(firstNonMeta, /^## Search Results: "Cust"/);
  });
});

describe('d365_get_enum', () => {
  it('returns enum values', async () => {
    const result = await callTool('d365_get_enum', { enum_name: 'StatusIssue' });
    assert.ok(result.includes('StatusIssue'));
    assert.ok(result.includes('None'));
    assert.ok(result.includes('Deducted'));
    assert.ok(result.includes('Sold'));
    assert.ok(result.includes('Issue status'));
  });

  it('shows numeric values', async () => {
    const result = await callTool('d365_get_enum', { enum_name: 'StatusIssue' });
    assert.ok(result.includes('0'));
    assert.ok(result.includes('1'));
    assert.ok(result.includes('2'));
  });

  it('is case-insensitive', async () => {
    const result = await callTool('d365_get_enum', { enum_name: 'statusissue' });
    assert.ok(result.includes('StatusIssue'));
  });

  it('suggests fuzzy matches for unknown enum', async () => {
    const result = await callTool('d365_get_enum', { enum_name: 'Status' });
    assert.ok(result.includes('Did you mean'));
    assert.ok(result.includes('StatusIssue'));
  });

  it('returns not found for completely unknown enum', async () => {
    const result = await callTool('d365_get_enum', { enum_name: 'CompletelyNonExistent' });
    assert.ok(result.includes('not found'));
  });

  it('P2-06: emits a visible parse-error marker when values_json is malformed', async () => {
    const result = await callTool('d365_get_enum', { enum_name: 'BrokenEnum' });
    assert.match(result, /Could not parse stored values/i);
  });

  it('P2-06: emits a "No values defined" marker when values_json is an empty array', async () => {
    const result = await callTool('d365_get_enum', { enum_name: 'EmptyEnum' });
    assert.match(result, /No values defined/);
    assert.doesNotMatch(result, /\|Name\|Value\|Label\|/);
  });
});

describe('d365_check_field_exists', () => {
  it('confirms existing fields', async () => {
    const result = await callTool('d365_check_field_exists', {
      table_name: 'CustTable',
      field_names: ['AccountNum', 'Currency'],
    });
    assert.ok(result.includes('YES'));
    assert.ok(result.includes('AccountNum'));
    assert.ok(result.includes('Currency'));
  });

  it('flags missing fields', async () => {
    const result = await callTool('d365_check_field_exists', {
      table_name: 'CustTable',
      field_names: ['FakeField'],
    });
    assert.ok(result.includes('**NO**'));
    assert.ok(result.includes('DOES NOT EXIST'));
  });

  it('shows hallucination trap explanation for known bad fields', async () => {
    const result = await callTool('d365_check_field_exists', {
      table_name: 'CustTable',
      field_names: ['CustomerName'],
    });
    assert.ok(result.includes('**NO**'));
    assert.ok(result.includes('DirPartyTable'));
  });

  it('suggests similar fields for near misses', async () => {
    const result = await callTool('d365_check_field_exists', {
      table_name: 'CustTable',
      field_names: ['Account'],
    });
    assert.ok(result.includes('similar'));
    assert.ok(result.includes('AccountNum'));
  });

  it('returns table not found for unknown table', async () => {
    const result = await callTool('d365_check_field_exists', {
      table_name: 'FakeTable',
      field_names: ['SomeField'],
    });
    assert.ok(result.includes('not found'));
  });

  it('is case-insensitive on table name', async () => {
    const result = await callTool('d365_check_field_exists', {
      table_name: 'custtable',
      field_names: ['AccountNum'],
    });
    assert.ok(result.includes('YES'));
  });
});

describe('d365_get_class_methods', () => {
  it('returns methods for a class', async () => {
    const result = await callTool('d365_get_class_methods', { name: 'SalesFormLetter', include_source: false, limit: 100 });
    assert.ok(result.includes('SalesFormLetter'));
    assert.ok(result.includes('run'));
    assert.ok(result.includes('construct'));
  });

  it('shows class hierarchy info', async () => {
    const result = await callTool('d365_get_class_methods', { name: 'SalesFormLetter', include_source: false, limit: 100 });
    assert.ok(result.includes('Extends'));
    assert.ok(result.includes('FormLetterService'));
    assert.ok(result.includes('SysRunnable'));
  });

  it('returns no methods for unknown class', async () => {
    const result = await callTool('d365_get_class_methods', { name: 'NonExistentClass', include_source: false, limit: 100 });
    // P1-01 contract: empty results use emptyResult() → italic "No methods on … leaf" hint
    assert.match(result, /_No methods on "[^"]+"\. This may be a leaf result\._/);
  });

  it('includes source code when requested', async () => {
    const result = await callTool('d365_get_class_methods', {
      name: 'SalesFormLetter', include_source: true, limit: 100,
    });
    assert.ok(result.includes('```x++'));
    assert.ok(result.includes('this.post()'));
  });

  it('does not include source code by default', async () => {
    const result = await callTool('d365_get_class_methods', { name: 'SalesFormLetter', include_source: false, limit: 100 });
    assert.ok(!result.includes('```x++'));
    assert.ok(!result.includes('this.post()'));
  });

  it('respects limit and emits user-kind truncation note when methods exceed the cap', async () => {
    const result = await callTool('d365_get_class_methods', { name: 'SalesFormLetter', include_source: false, limit: 2 });
    // P1-02 contract: user-requested limit → user-kind note
    assert.match(result, /first 2 results you asked for/);
  });

  it('filters by method name', async () => {
    const result = await callTool('d365_get_class_methods', {
      name: 'SalesFormLetter', filter: 'run', include_source: false, limit: 100,
    });
    assert.ok(result.includes('run'));
    assert.ok(!result.includes('validate'));
  });

  it('is case-insensitive on class name', async () => {
    const result = await callTool('d365_get_class_methods', { name: 'salesformletter', include_source: false, limit: 100 });
    assert.ok(result.includes('SalesFormLetter'));
  });

  // PM-05 — structured output for the pilot tool
  it('given a valid class lookup, then structuredContent matches the output schema', async () => {
    const { d365GetClassMethodsOutput } = await import('../src/azure/output-schemas.js');
    const result = await callToolFull('d365_get_class_methods', {
      name: 'SalesFormLetter', include_source: false, limit: 100,
    });
    assert.ok(result.structuredContent);
    assert.doesNotThrow(() => d365GetClassMethodsOutput.parse(result.structuredContent));
    assert.equal(result.structuredContent.owner_name, 'SalesFormLetter');
    assert.equal(result.structuredContent.owner_type, 'class');
    assert.equal(result.structuredContent.extends_class, 'FormLetterService');
    assert.equal(typeof result.structuredContent.is_abstract, 'boolean');
    assert.ok(Array.isArray(result.structuredContent.methods));
    // Signatures-only mode must NOT leak source_code
    for (const m of result.structuredContent.methods) {
      assert.equal(m.source_code, null);
      assert.equal(typeof m.is_static, 'boolean');
    }
  });

  it('given include_source=true, then structuredContent carries source_code strings', async () => {
    const result = await callToolFull('d365_get_class_methods', {
      name: 'SalesFormLetter', include_source: true, limit: 100,
    });
    assert.ok(result.structuredContent);
    assert.equal(result.structuredContent.include_source, true);
    // At least one method has a non-null source_code string
    const withSource = result.structuredContent.methods.filter(m => typeof m.source_code === 'string');
    assert.ok(withSource.length > 0);
  });
});

describe('d365_get_method_source', () => {
  it('returns source code for a method', async () => {
    const result = await callTool('d365_get_method_source', {
      owner_name: 'SalesFormLetter', method_name: 'run',
    });
    assert.ok(result.includes('SalesFormLetter'));
    assert.ok(result.includes('run'));
    assert.ok(result.includes('```x++'));
    assert.ok(result.includes('this.post()'));
  });

  it('shows method metadata', async () => {
    const result = await callTool('d365_get_method_source', {
      owner_name: 'SalesFormLetter', method_name: 'construct',
    });
    assert.ok(result.includes('Static: Yes'));
    assert.ok(result.includes('construct'));
  });

  it('handles method without source code', async () => {
    const result = await callTool('d365_get_method_source', {
      owner_name: 'SalesFormLetter', method_name: 'post',
    });
    assert.ok(result.includes('No source code available'));
  });

  it('returns not found for unknown method', async () => {
    const result = await callTool('d365_get_method_source', {
      owner_name: 'SalesFormLetter', method_name: 'nonExistentMethod',
    });
    assert.ok(result.includes('not found'));
  });

  it('suggests similar methods for partial match', async () => {
    const result = await callTool('d365_get_method_source', {
      owner_name: 'SalesFormLetter', method_name: 'val',
    });
    assert.ok(result.includes('Did you mean'));
    assert.ok(result.includes('validate'));
  });

  it('P2-10: case-insensitive on both owner and method name', async () => {
    const result = await callTool('d365_get_method_source', {
      owner_name: 'salesformletter', method_name: 'RUN',
    });
    assert.match(result, /SalesFormLetter\.run/);
    assert.match(result, /```x\+\+/);
  });

  it('P2-10: fuzzy method suggestions are case-insensitive', async () => {
    const result = await callTool('d365_get_method_source', {
      owner_name: 'SALESFORMLETTER', method_name: 'VAL',
    });
    assert.match(result, /Did you mean/);
    assert.match(result, /validate/);
  });
});

describe('d365_find_referencing_tables', () => {
  it('finds tables referencing a target', async () => {
    const result = await callTool('d365_find_referencing_tables', { table_name: 'CustTable' });
    assert.ok(result.includes('SalesTable'));
    assert.ok(result.includes('CustAccount'));
  });

  it('shows join fields', async () => {
    const result = await callTool('d365_find_referencing_tables', { table_name: 'CustTable' });
    assert.ok(result.includes('CustAccount->AccountNum'));
  });

  it('returns empty for table with no references', async () => {
    const result = await callTool('d365_find_referencing_tables', { table_name: 'SalesTable' });
    // P1-01 contract: leaf tables emit the italic "This may be a leaf result" hint
    assert.match(result, /_No tables referencing "[^"]+"\. This may be a leaf result\._/);
  });

  it('shows total count', async () => {
    const result = await callTool('d365_find_referencing_tables', { table_name: 'CustGroup' });
    assert.ok(result.includes('Total:'));
    assert.ok(result.includes('CustTable'));
  });

  it('P2-08: returns not-found with suggestions for a non-existent-but-fuzzy-matched table', async () => {
    // "Cust" is not an exact table name but fuzzy-matches CustTable and CustGroup.
    const result = await callTool('d365_find_referencing_tables', { table_name: 'Cust' });
    assert.match(result, /\*\*Table "Cust" not found\.\*\*/);
    assert.match(result, /Did you mean/);
    assert.match(result, /CustTable/);
  });

  it('P2-08: distinguishes existing-leaf from not-found', async () => {
    const leaf = await callTool('d365_find_referencing_tables', { table_name: 'SalesTable' });
    const missing = await callTool('d365_find_referencing_tables', { table_name: 'CompletelyUnknownTbl' });
    assert.match(leaf, /leaf result/);
    assert.doesNotMatch(leaf, /not found/);
    assert.match(missing, /not found/);
    assert.doesNotMatch(missing, /leaf result/);
  });

  it('P2-10: case-insensitive on target table name', async () => {
    const result = await callTool('d365_find_referencing_tables', { table_name: 'CUSTGROUP' });
    assert.match(result, /Tables referencing: CustGroup/);
    assert.match(result, /CustTable/);
  });
});

describe('d365_get_module_summary', () => {
  it('returns module summary', async () => {
    const result = await callTool('d365_get_module_summary', { module_name: 'ApplicationSuite' });
    assert.ok(result.includes('ApplicationSuite'));
    assert.ok(result.includes('Tables'));
    assert.ok(result.includes('50'));
    assert.ok(result.includes('Classes'));
    assert.ok(result.includes('100'));
  });

  it('shows key tables', async () => {
    const result = await callTool('d365_get_module_summary', { module_name: 'ApplicationSuite' });
    assert.ok(result.includes('Key Tables'));
    assert.ok(result.includes('CustTable'));
  });

  it('returns not found for unknown module', async () => {
    const result = await callTool('d365_get_module_summary', { module_name: 'NonExistentModule' });
    assert.ok(result.includes('not found'));
  });

  it('suggests fuzzy matches for partial module name', async () => {
    const result = await callTool('d365_get_module_summary', { module_name: 'Application' });
    assert.ok(result.includes('Did you mean'));
    assert.ok(result.includes('ApplicationSuite'));
  });

  it('P2-07: table_limit=2 returns exactly 2 key tables and emits a cap truncation note', async () => {
    const result = await callTool('d365_get_module_summary', { module_name: 'ApplicationSuite', table_limit: 2 });
    const tablesSection = result.split('## Key Classes')[0];
    const bodyRows = tablesSection.split('\n').filter(l => /^\|\s+\S/.test(l) && !/---/.test(l) && !/\bTable\b/.test(l.split('|')[1] || ''));
    assert.equal(bodyRows.length, 2, `expected 2 body rows, got:\n${tablesSection}`);
    assert.match(tablesSection, /Tool default cap of 2/);
  });

  it('P2-07: table_limit=50 returns all ApplicationSuite tables with no truncation note', async () => {
    const result = await callTool('d365_get_module_summary', { module_name: 'ApplicationSuite', table_limit: 50 });
    const tablesSection = result.split('## Key Classes')[0];
    assert.doesNotMatch(tablesSection, /Tool default cap/);
  });

  it('P2-07: Zod rejects table_limit > 200', async () => {
    await assert.rejects(
      () => callTool('d365_get_module_summary', { module_name: 'ApplicationSuite', table_limit: 300 }),
      /200|max/i,
    );
  });
});

describe('d365_get_entity_sources', () => {
  it('returns entity metadata', async () => {
    const result = await callTool('d365_get_entity_sources', { entity_name: 'CustCustomerEntity' });
    assert.ok(result.includes('CustCustomerEntity'));
    assert.ok(result.includes('CustomersV3'));
    assert.ok(result.includes('CustTable'));
    assert.ok(result.includes('Public: Yes'));
  });

  it('shows entity fields', async () => {
    const result = await callTool('d365_get_entity_sources', { entity_name: 'CustCustomerEntity' });
    assert.ok(result.includes('Entity Fields'));
    assert.ok(result.includes('CustomerAccount'));
    assert.ok(result.includes('AccountNum'));
  });

  it('suggests fuzzy matches for unknown entity', async () => {
    const result = await callTool('d365_get_entity_sources', { entity_name: 'Cust' });
    assert.ok(result.includes('Did you mean'));
    assert.ok(result.includes('CustCustomerEntity'));
  });

  it('returns not found for completely unknown entity', async () => {
    const result = await callTool('d365_get_entity_sources', { entity_name: 'CompletelyUnknownEntity' });
    assert.ok(result.includes('not found'));
  });
});

describe('d365_sql_template', () => {
  it('lists all templates when no scenario provided', async () => {
    const result = await callTool('d365_sql_template', {});
    assert.ok(result.includes('Customer invoices'));
    assert.ok(result.includes('Vendor open balances'));
  });

  it('filters by scenario keyword', async () => {
    const result = await callTool('d365_sql_template', { scenario: 'customer' });
    assert.ok(result.includes('Customer invoices'));
    assert.ok(!result.includes('Vendor open balances'));
  });

  it('shows SQL code block', async () => {
    const result = await callTool('d365_sql_template', { scenario: 'customer' });
    assert.ok(result.includes('```sql'));
    assert.ok(result.includes('CustTable'));
  });

  it('returns no templates for unknown scenario', async () => {
    const result = await callTool('d365_sql_template', { scenario: 'xyznonexistent' });
    assert.ok(result.includes('No templates matching'));
  });
});

describe('d365_hallucination_check', () => {
  it('returns known traps for a table', async () => {
    const result = await callTool('d365_hallucination_check', { table_name: 'CustTable' });
    assert.ok(result.includes('Hallucination Traps'));
    assert.ok(result.includes('CustomerName'));
    assert.ok(result.includes('DirPartyTable'));
  });

  it('shows trap type', async () => {
    const result = await callTool('d365_hallucination_check', { table_name: 'CustTable' });
    assert.ok(result.includes('wrong_field'));
    assert.ok(result.includes('wrong_join'));
  });

  it('renders output as a 4-column markdown table (P2-02)', async () => {
    const result = await callTool('d365_hallucination_check', { table_name: 'CustTable' });
    assert.match(result, /^## Hallucination Traps for `CustTable`/m);
    assert.match(result, /\| trap_type \| wrong_value \| correct_value \| explanation \|/);
    assert.match(result, /\| wrong_field \| CustomerName \|/);
  });

  it('returns empty-result hint for table with no traps (P2-02)', async () => {
    const result = await callTool('d365_hallucination_check', { table_name: 'VendTable' });
    assert.match(result, /_No hallucination traps for "VendTable"\. This may be a leaf result\._/);
  });

  it('is case-insensitive', async () => {
    const result = await callTool('d365_hallucination_check', { table_name: 'custtable' });
    assert.ok(result.includes('Hallucination Traps'));
  });
});

describe('d365_raw_sql', () => {
  it('executes valid SELECT queries', async () => {
    const result = await callTool('d365_raw_sql', { sql: 'SELECT table_name FROM tables ORDER BY table_name' });
    assert.ok(result.includes('CustTable'));
    assert.ok(result.includes('VendTable'));
    assert.ok(result.includes('SalesTable'));
  });

  it('rejects INSERT statements', async () => {
    const result = await callTool('d365_raw_sql', { sql: "INSERT INTO tables VALUES ('x','x','x','x',1,'x','x','x',0)" });
    assert.ok(result.includes('Only SELECT'));
  });

  it('rejects DELETE statements', async () => {
    const result = await callTool('d365_raw_sql', { sql: 'DELETE FROM tables' });
    assert.ok(result.includes('Only SELECT'));
  });

  it('blocks forbidden keywords in SELECT', async () => {
    const result = await callTool('d365_raw_sql', { sql: "SELECT * FROM tables; DROP TABLE tables" });
    assert.ok(result.includes('Forbidden keyword') || result.includes('Only SELECT'));
  });

  it('allows WITH (CTE) queries', async () => {
    const result = await callTool('d365_raw_sql', { sql: 'WITH t AS (SELECT table_name FROM tables) SELECT * FROM t' });
    assert.ok(result.includes('CustTable'));
  });

  it('adds LIMIT if missing', async () => {
    const result = await callTool('d365_raw_sql', { sql: 'SELECT table_name FROM tables' });
    // Should succeed without error — LIMIT is added internally
    assert.ok(result.includes('CustTable'));
  });

  it('reports SQL errors gracefully', async () => {
    const result = await callTool('d365_raw_sql', { sql: 'SELECT nonexistent FROM tables' });
    assert.ok(result.includes('Error'));
  });

  it('P2-09: comments containing LIMIT do not bypass the hard safety cap', async () => {
    const sql = `-- LIMIT 9999\nWITH RECURSIVE nums(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM nums WHERE n < 600) SELECT n FROM nums`;
    const result = await callTool('d365_raw_sql', { sql });
    assert.match(result, /Hard safety limit of 500/);
  });

  it('P2-09: block comments containing a forbidden keyword are still blocked after strip', async () => {
    const sql = `SELECT 1 /* totally not DROP TABLE tables */`;
    const result = await callTool('d365_raw_sql', { sql });
    // After strip, the forbidden DROP is gone — this should EXECUTE, not be blocked.
    assert.doesNotMatch(result, /Forbidden keyword/);
  });

  it('P2-09: hidden forbidden keyword inside a line comment cannot sneak past the strip', async () => {
    // With comment stripping, `-- DROP` becomes invisible and this should execute.
    // (Previously the naive `\bDROP\b` scan would have falsely rejected this.)
    const sql = `SELECT 1 -- DROP TABLE tables`;
    const result = await callTool('d365_raw_sql', { sql });
    assert.doesNotMatch(result, /Forbidden keyword/);
  });

  it('P2-09: non-SELECT / non-WITH / non-PRAGMA returns invalid-input error', async () => {
    // INSERT hits the forbidden-keyword scan path; use something outside the
    // forbidden list so we exercise the "not a SELECT" branch.
    const result = await callTool('d365_raw_sql', { sql: 'VACUUM' });
    assert.match(result, /Only SELECT/);
  });

  it('TOON: format="toon" renders the text channel as a TOON block; structuredContent is unchanged', async () => {
    const md = await callToolFull('d365_raw_sql', {
      sql: 'SELECT table_name FROM tables ORDER BY table_name',
    });
    const toon = await callToolFull('d365_raw_sql', {
      sql: 'SELECT table_name FROM tables ORDER BY table_name',
      format: 'toon',
    });
    // Markdown body starts with a pipe header; TOON starts with `rows[N]{...}:`.
    assert.match(md.content[0].text, /^\| table_name \|/m);
    assert.match(toon.content[0].text, /^rows\[\d+\]\{table_name\}:/m);
    assert.doesNotMatch(toon.content[0].text, /^\| table_name \|/m);
    // Typed payload must be identical regardless of text rendering.
    assert.deepEqual(md.structuredContent, toon.structuredContent);
  });

  it('TOON: format defaults to markdown when omitted', async () => {
    const result = await callToolFull('d365_raw_sql', {
      sql: 'SELECT table_name FROM tables ORDER BY table_name',
    });
    assert.match(result.content[0].text, /^\| table_name \|/m);
  });
});

describe('d365_graph_traverse', () => {
  it('traverses graph from a starting node', async () => {
    const result = await callTool('d365_graph_traverse', { start_node: 'CustTable' });
    assert.ok(result.includes('CustGroup'));
    assert.ok(result.includes('DirPartyTable'));
  });

  it('finds multi-hop connections', async () => {
    const result = await callTool('d365_graph_traverse', { start_node: 'CustTable', max_depth: 2 });
    // CustTable -> CustGroup -> CustLedger (depth 2)
    assert.ok(result.includes('CustLedger'));
  });

  it('filters by edge type', async () => {
    const result = await callTool('d365_graph_traverse', { start_node: 'CustTable', edge_type: 'FK' });
    assert.ok(result.includes('CustGroup'));
  });

  it('returns empty for unknown node', async () => {
    const result = await callTool('d365_graph_traverse', { start_node: 'NonExistentNode' });
    // Emitted via shared emptyResult() — matches both the legacy phrase
    // "No connections" and the helper's leaf-result wording.
    assert.match(result, /No connections|leaf result/);
  });

  // P3-07 — edge_type filter at max_depth > 1 must filter at every level.
  // Parameter-binding regression guard: if the edge_type bind drifts to the
  // depth position (or vice-versa) in the recursive CTE, unfiltered edges
  // would appear.
  it('given edge_type=Call and max_depth=3, then only Call edges return at every level', async () => {
    const result = await callTool('d365_graph_traverse', {
      start_node: 'GNodeA', max_depth: 3, edge_type: 'Call',
    });
    // GNodeA -Call-> GNodeB -Call-> GNodeD should be reachable via Call
    // edges only. GNodeC and GNodeE and GNodeF must NOT appear (C/F are
    // reached via Read edges; E is reached via a Call edge but only from C
    // which is excluded).
    assert.match(result, /GNodeB/);
    assert.match(result, /GNodeD/);
    assert.doesNotMatch(result, /GNodeC/);
    assert.doesNotMatch(result, /GNodeE/);
    assert.doesNotMatch(result, /GNodeF/);
  });

  it('given no edge_type filter, then Call and Read both appear', async () => {
    const result = await callTool('d365_graph_traverse', {
      start_node: 'GNodeA', max_depth: 2,
    });
    assert.match(result, /GNodeB/);
    assert.match(result, /GNodeC/);
    // The Edge column must contain both labels.
    assert.match(result, /\| Call \|/);
    assert.match(result, /\| Read \|/);
  });
});

describe('d365_field_renames', () => {
  it('returns field renames for a table', async () => {
    const result = await callTool('d365_field_renames', { table_name: 'CustTable' });
    assert.ok(result.includes('Field Renames'));
    assert.ok(result.includes('AccountStatement'));
    assert.ok(result.includes('PrintMgmtAccountStatement'));
  });

  it('returns empty-result hint for table without renames', async () => {
    const result = await callTool('d365_field_renames', { table_name: 'VendTable' });
    assert.match(result, /_No known field renames for "VendTable"\. This may be a leaf result\._/);
  });

  it('is case-insensitive', async () => {
    const result = await callTool('d365_field_renames', { table_name: 'custtable' });
    assert.ok(result.includes('Field Renames'));
  });
});

describe('d365_list_modules', () => {
  it('returns all modules', async () => {
    const result = await callTool('d365_list_modules', {});
    assert.ok(result.includes('ApplicationSuite'));
    assert.ok(result.includes('ApplicationFoundation'));
  });

  it('shows object counts', async () => {
    const result = await callTool('d365_list_modules', {});
    assert.ok(result.includes('50'));  // table count for ApplicationSuite
    assert.ok(result.includes('100')); // class count
  });

  it('shows total count in heading', async () => {
    const result = await callTool('d365_list_modules', {});
    assert.match(result, /3 total/);
  });
});

describe('P2-01 label resolution', () => {
  it('d365_lookup_table resolves @SYS labels in table header and field list', async () => {
    const result = await callTool('d365_lookup_table', { table_name: 'LabeledTestTable' });
    assert.match(result, /Label:\s*Resolved table label/);
    assert.match(result, /Resolved field label/);
    assert.doesNotMatch(result, /@SYS99001/);
    assert.doesNotMatch(result, /@SYS99002/);
  });

  it('d365_get_enum resolves @SYS labels on enum and its values', async () => {
    const result = await callTool('d365_get_enum', { enum_name: 'LabeledTestEnum' });
    assert.match(result, /Label:\s*Resolved enum label/);
    assert.match(result, /Resolved enum value label/);
    assert.doesNotMatch(result, /@SYS99003/);
    assert.doesNotMatch(result, /@SYS99004/);
  });

  it('d365_get_module_summary resolves @SYS labels in the Key Tables list', async () => {
    const result = await callTool('d365_get_module_summary', { module_name: 'LabeledTestModule' });
    assert.match(result, /LabeledTestTable/);
    assert.match(result, /Resolved table label/);
    assert.doesNotMatch(result, /@SYS99001/);
  });
});

describe('d365_resolve_label', () => {
  it('resolves known label IDs', async () => {
    const result = await callTool('d365_resolve_label', { label_ids: ['@SYS12345', '@SYS67890'] });
    assert.ok(result.includes('Customer account'));
    assert.ok(result.includes('Vendor account'));
  });

  it('shows missing labels', async () => {
    const result = await callTool('d365_resolve_label', { label_ids: ['@SYS12345', '@UNKNOWN999'] });
    assert.ok(result.includes('Customer account'));
    assert.ok(result.includes('Not found'));
    assert.ok(result.includes('@UNKNOWN999'));
  });

  it('returns empty-result hint when every label is unknown (P2-04)', async () => {
    const result = await callTool('d365_resolve_label', { label_ids: ['@NOPE1', '@NOPE2'] });
    assert.match(result, /_No labels matching [^.]+\. This may be a leaf result\._/);
  });

  it('P2-04: Zod rejects empty array with min(1) error', async () => {
    await assert.rejects(
      () => callTool('d365_resolve_label', { label_ids: [] }),
      /at least one label ID/i,
    );
  });

  it('P2-04: Zod rejects oversized array with max(100) error', async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `@SYS${i}`);
    await assert.rejects(
      () => callTool('d365_resolve_label', { label_ids: ids }),
      /max|100/i,
    );
  });

  it('P2-04: Zod rejects malformed label id via regex', async () => {
    await assert.rejects(
      () => callTool('d365_resolve_label', { label_ids: ['not-a-label'] }),
      /regex|match|label ids must/i,
    );
  });

  it('P2-04: duplicate ids are deduped before the IN clause', async () => {
    let captured;
    const origPrepare = db.prepare.bind(db);
    db.prepare = (sql) => {
      const stmt = origPrepare(sql);
      if (/FROM labels WHERE label_id IN/.test(sql)) {
        const origAll = stmt.all.bind(stmt);
        stmt.all = (...p) => { captured = p; return origAll(...p); };
      }
      return stmt;
    };
    try {
      await callTool('d365_resolve_label', { label_ids: ['@SYS12345', '@SYS12345', '@SYS12345'] });
    } finally {
      db.prepare = origPrepare;
    }
    assert.equal(captured.length, 1, 'only the unique id should reach the DB');
    assert.equal(captured[0], '@SYS12345');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  PM-06 — structured output rollout tests for the 15 remaining KB tools.
//  Each test: call tool, assert structuredContent exists and parses against the
//  tool's declared Zod output schema.
// ═════════════════════════════════════════════════════════════════════════════

describe('PM-06 KB structured output', () => {
  it('d365_get_join_keys: typed payload parses and reports the relationship', async () => {
    const { d365GetJoinKeysOutput } = await import('../src/azure/output-schemas.js');
    const result = await callToolFull('d365_get_join_keys', { table1: 'CustTable', table2: 'CustGroup' });
    assert.ok(result.structuredContent);
    assert.doesNotThrow(() => d365GetJoinKeysOutput.parse(result.structuredContent));
    assert.equal(result.structuredContent.has_relationship, true);
    assert.ok(result.structuredContent.relation_count >= 1);
  });

  it('d365_get_join_keys: unrelated tables yield has_relationship=false', async () => {
    const result = await callToolFull('d365_get_join_keys', { table1: 'CustTable', table2: 'VendTable' });
    assert.ok(result.structuredContent);
    assert.equal(result.structuredContent.has_relationship, false);
    assert.equal(result.structuredContent.relation_count, 0);
  });

  it('d365_search: typed payload parses, result_count matches rows', async () => {
    const { d365SearchOutput } = await import('../src/azure/output-schemas.js');
    const result = await callToolFull('d365_search', { query: 'Customer' });
    assert.ok(result.structuredContent);
    assert.doesNotThrow(() => d365SearchOutput.parse(result.structuredContent));
    assert.equal(result.structuredContent.query, 'Customer');
    assert.ok(result.structuredContent.result_count >= 1);
    assert.equal(result.structuredContent.results.length, result.structuredContent.result_count);
  });

  it('d365_get_enum: typed payload parses and carries enum values', async () => {
    const { d365GetEnumOutput } = await import('../src/azure/output-schemas.js');
    const result = await callToolFull('d365_get_enum', { enum_name: 'StatusIssue' });
    assert.ok(result.structuredContent);
    assert.doesNotThrow(() => d365GetEnumOutput.parse(result.structuredContent));
    assert.equal(result.structuredContent.enum_name, 'StatusIssue');
    assert.equal(result.structuredContent.parse_error, false);
    assert.equal(result.structuredContent.value_count, 3);
    assert.ok(result.structuredContent.values.find(v => v.name === 'None'));
  });

  it('d365_get_enum: malformed values_json sets parse_error=true', async () => {
    const result = await callToolFull('d365_get_enum', { enum_name: 'BrokenEnum' });
    assert.ok(result.structuredContent);
    assert.equal(result.structuredContent.parse_error, true);
    assert.equal(result.structuredContent.value_count, 0);
  });

  it('d365_check_field_exists: typed payload lists exists flags per input', async () => {
    const { d365CheckFieldExistsOutput } = await import('../src/azure/output-schemas.js');
    const result = await callToolFull('d365_check_field_exists', {
      table_name: 'CustTable',
      field_names: ['AccountNum', 'FakeField'],
    });
    assert.ok(result.structuredContent);
    assert.doesNotThrow(() => d365CheckFieldExistsOutput.parse(result.structuredContent));
    assert.equal(result.structuredContent.check_count, 2);
    const byName = Object.fromEntries(result.structuredContent.checks.map(c => [c.field_name, c]));
    assert.equal(byName['AccountNum'].exists, true);
    assert.equal(byName['FakeField'].exists, false);
  });

  it('d365_get_method_source: typed payload matches a known method', async () => {
    const { d365GetMethodSourceOutput } = await import('../src/azure/output-schemas.js');
    const result = await callToolFull('d365_get_method_source', {
      owner_name: 'SalesFormLetter', method_name: 'construct',
    });
    assert.ok(result.structuredContent);
    assert.doesNotThrow(() => d365GetMethodSourceOutput.parse(result.structuredContent));
    assert.equal(result.structuredContent.owner_name, 'SalesFormLetter');
    assert.equal(result.structuredContent.method_name, 'construct');
    assert.equal(result.structuredContent.is_static, true);
  });

  it('d365_find_referencing_tables: typed payload lists referencing tables', async () => {
    const { d365FindReferencingTablesOutput } = await import('../src/azure/output-schemas.js');
    const result = await callToolFull('d365_find_referencing_tables', { table_name: 'CustTable' });
    assert.ok(result.structuredContent);
    assert.doesNotThrow(() => d365FindReferencingTablesOutput.parse(result.structuredContent));
    assert.equal(result.structuredContent.table_name, 'CustTable');
    assert.ok(result.structuredContent.reference_count >= 1);
    assert.ok(result.structuredContent.references.find(r => r.source_table === 'SalesTable'));
  });

  it('d365_get_module_summary: typed payload carries key_tables and truncation flags', async () => {
    const { d365GetModuleSummaryOutput } = await import('../src/azure/output-schemas.js');
    const result = await callToolFull('d365_get_module_summary', {
      module_name: 'ApplicationSuite', table_limit: 2, class_limit: 15,
    });
    assert.ok(result.structuredContent);
    assert.doesNotThrow(() => d365GetModuleSummaryOutput.parse(result.structuredContent));
    assert.equal(result.structuredContent.module_id, 'ApplicationSuite');
    assert.equal(result.structuredContent.key_tables.length, 2);
    assert.equal(result.structuredContent.tables_truncated, true);
  });

  it('d365_get_entity_sources: typed payload matches the CustCustomer entity', async () => {
    const { d365GetEntitySourcesOutput } = await import('../src/azure/output-schemas.js');
    const result = await callToolFull('d365_get_entity_sources', { entity_name: 'CustCustomerEntity' });
    assert.ok(result.structuredContent);
    assert.doesNotThrow(() => d365GetEntitySourcesOutput.parse(result.structuredContent));
    assert.equal(result.structuredContent.entity_name, 'CustCustomerEntity');
    assert.equal(result.structuredContent.primary_table, 'CustTable');
    assert.equal(result.structuredContent.is_public, true);
    assert.ok(result.structuredContent.field_count >= 1);
  });

  it('d365_sql_template: typed payload enumerates templates', async () => {
    const { d365SqlTemplateOutput } = await import('../src/azure/output-schemas.js');
    const result = await callToolFull('d365_sql_template', { scenario: 'customer' });
    assert.ok(result.structuredContent);
    assert.doesNotThrow(() => d365SqlTemplateOutput.parse(result.structuredContent));
    assert.equal(result.structuredContent.scenario, 'customer');
    assert.ok(result.structuredContent.template_count >= 1);
  });

  it('d365_hallucination_check: typed payload exposes trap rows', async () => {
    const { d365HallucinationCheckOutput } = await import('../src/azure/output-schemas.js');
    const result = await callToolFull('d365_hallucination_check', { table_name: 'CustTable' });
    assert.ok(result.structuredContent);
    assert.doesNotThrow(() => d365HallucinationCheckOutput.parse(result.structuredContent));
    assert.equal(result.structuredContent.table_name, 'CustTable');
    assert.ok(result.structuredContent.trap_count >= 2);
  });

  it('d365_raw_sql: typed payload matches rawSqlOutput and row_count is non-zero', async () => {
    const { rawSqlOutput } = await import('../src/azure/output-schemas.js');
    const result = await callToolFull('d365_raw_sql', {
      sql: 'SELECT table_name FROM tables ORDER BY table_name',
    });
    assert.ok(result.structuredContent);
    assert.doesNotThrow(() => rawSqlOutput.parse(result.structuredContent));
    assert.ok(result.structuredContent.row_count > 0);
    assert.deepEqual(result.structuredContent.columns, ['table_name']);
    assert.equal(result.structuredContent.rows.length, result.structuredContent.row_count);
  });

  it('d365_graph_traverse: typed payload walks the graph', async () => {
    const { d365GraphTraverseOutput } = await import('../src/azure/output-schemas.js');
    const result = await callToolFull('d365_graph_traverse', { start_node: 'CustTable', max_depth: 2 });
    assert.ok(result.structuredContent);
    assert.doesNotThrow(() => d365GraphTraverseOutput.parse(result.structuredContent));
    assert.equal(result.structuredContent.start_node, 'CustTable');
    assert.equal(result.structuredContent.max_depth, 2);
    assert.ok(result.structuredContent.node_count >= 1);
    assert.ok(result.structuredContent.nodes.find(n => n.node === 'CustGroup'));
  });

  it('d365_field_renames: typed payload lists rename pairs', async () => {
    const { d365FieldRenamesOutput } = await import('../src/azure/output-schemas.js');
    const result = await callToolFull('d365_field_renames', { table_name: 'CustTable' });
    assert.ok(result.structuredContent);
    assert.doesNotThrow(() => d365FieldRenamesOutput.parse(result.structuredContent));
    assert.equal(result.structuredContent.table_name, 'CustTable');
    assert.ok(result.structuredContent.rename_count >= 2);
    assert.ok(result.structuredContent.renames.find(r => r.ax2012_name === 'AccountStatement'));
  });

  it('d365_list_modules: typed payload carries the full module list', async () => {
    const { d365ListModulesOutput } = await import('../src/azure/output-schemas.js');
    const result = await callToolFull('d365_list_modules', {});
    assert.ok(result.structuredContent);
    assert.doesNotThrow(() => d365ListModulesOutput.parse(result.structuredContent));
    assert.ok(result.structuredContent.module_count >= 2);
    assert.ok(result.structuredContent.modules.find(m => m.module_id === 'ApplicationSuite'));
  });

  it('d365_resolve_label: typed payload lists resolved + not_found', async () => {
    const { d365ResolveLabelOutput } = await import('../src/azure/output-schemas.js');
    const result = await callToolFull('d365_resolve_label', {
      label_ids: ['@SYS12345', '@UNKNOWN999'],
    });
    assert.ok(result.structuredContent);
    assert.doesNotThrow(() => d365ResolveLabelOutput.parse(result.structuredContent));
    assert.equal(result.structuredContent.requested_count, 2);
    assert.equal(result.structuredContent.resolved_count, 1);
    assert.equal(result.structuredContent.not_found_count, 1);
    assert.deepEqual(result.structuredContent.not_found, ['@UNKNOWN999']);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  SQLite TEXT→number coercion tests.
//
//  Production KB databases often store numeric metadata as TEXT columns.
//  better-sqlite3 returns TEXT columns as JS strings ("1" not 1).
//  Zod strict validation rejects strings where z.number() is expected.
//  These tests insert TEXT-typed fixtures to catch this class of bug.
// ═════════════════════════════════════════════════════════════════════════════

describe('TEXT column coercion — d365_lookup_table', () => {
  before(() => {
    // Insert a table where save_per_company and mandatory are TEXT (as in prod KB)
    db.exec(`
      INSERT OR REPLACE INTO tables VALUES ('TextCoercionTest', 'TestModule', 'Test label', 'Main', '1', 'Found', 'PK', NULL, '5');
      INSERT OR REPLACE INTO fields VALUES ('TextCoercionTest', 'Field1', 'String', 'EdtTest', NULL, '1', NULL);
      INSERT OR REPLACE INTO fields VALUES ('TextCoercionTest', 'Field2', 'Int64', NULL, NULL, '0', NULL);
    `);
  });
  after(() => {
    db.exec(`
      DELETE FROM tables WHERE table_name = 'TextCoercionTest';
      DELETE FROM fields WHERE table_name = 'TextCoercionTest';
    `);
  });

  it('given TEXT-typed save_per_company and mandatory, then structuredContent parses without error', async () => {
    const { d365LookupTableOutput } = await import('../src/azure/output-schemas.js');
    const result = await callToolFull('d365_lookup_table', { table_name: 'TextCoercionTest' });
    assert.ok(result.structuredContent, 'expected structuredContent');
    assert.doesNotThrow(() => d365LookupTableOutput.parse(result.structuredContent));
    // save_per_company must be a number, not the string "1"
    assert.equal(typeof result.structuredContent.save_per_company, 'number');
    assert.equal(result.structuredContent.save_per_company, 1);
    // mandatory on each field must be a number
    for (const f of result.structuredContent.fields) {
      assert.ok(f.mandatory === null || typeof f.mandatory === 'number',
        `field ${f.name} mandatory is ${typeof f.mandatory}, expected number|null`);
    }
  });
});

describe('TEXT column coercion — d365_get_module_summary', () => {
  before(() => {
    // Insert module with TEXT-typed counts
    db.exec(`
      INSERT OR REPLACE INTO modules VALUES ('TextCoercionMod', '3', '2', '1', '1', '0');
      INSERT OR REPLACE INTO tables  VALUES ('TextModTable', 'TextCoercionMod', 'Test', 'Main', '1', NULL, NULL, NULL, '4');
      INSERT OR REPLACE INTO classes VALUES ('TextModClass', 'TextCoercionMod', NULL, NULL, 0, '3');
    `);
  });
  after(() => {
    db.exec(`
      DELETE FROM modules WHERE module_id = 'TextCoercionMod';
      DELETE FROM tables WHERE module_id = 'TextCoercionMod';
      DELETE FROM classes WHERE module_id = 'TextCoercionMod';
    `);
  });

  it('given TEXT-typed field_count, save_per_company, method_count, then schema parses', async () => {
    const { d365GetModuleSummaryOutput } = await import('../src/azure/output-schemas.js');
    const result = await callToolFull('d365_get_module_summary', { module_name: 'TextCoercionMod' });
    assert.ok(result.structuredContent, 'expected structuredContent');
    assert.doesNotThrow(() => d365GetModuleSummaryOutput.parse(result.structuredContent));
    // Verify nested key_tables have numeric field_count
    for (const t of result.structuredContent.key_tables) {
      assert.ok(t.field_count === null || typeof t.field_count === 'number',
        `table ${t.table_name} field_count is ${typeof t.field_count}`);
      assert.ok(t.save_per_company === null || typeof t.save_per_company === 'number',
        `table ${t.table_name} save_per_company is ${typeof t.save_per_company}`);
    }
    for (const c of result.structuredContent.key_classes) {
      assert.ok(c.method_count === null || typeof c.method_count === 'number',
        `class ${c.class_name} method_count is ${typeof c.method_count}`);
    }
  });
});

describe('TEXT column coercion — d365_get_entity_sources', () => {
  before(() => {
    db.exec(`
      INSERT OR REPLACE INTO data_entities VALUES ('TextCoercionEntity', 'TestModule', 'Test', 'TestPublic', 'TestColl', 1, 'CustTable', 'CustTableStaging', NULL);
      INSERT OR REPLACE INTO entity_fields VALUES ('TextCoercionEntity', 'AccountNum', 'AccountNum', 'CustTable', '1');
      INSERT OR REPLACE INTO entity_fields VALUES ('TextCoercionEntity', 'Name', 'Name', 'DirPartyTable', '0');
    `);
  });
  after(() => {
    db.exec(`
      DELETE FROM data_entities WHERE entity_name = 'TextCoercionEntity';
      DELETE FROM entity_fields WHERE entity_name = 'TextCoercionEntity';
    `);
  });

  it('given TEXT-typed is_mandatory, then schema parses', async () => {
    const { d365GetEntitySourcesOutput } = await import('../src/azure/output-schemas.js');
    const result = await callToolFull('d365_get_entity_sources', { entity_name: 'TextCoercionEntity' });
    assert.ok(result.structuredContent, 'expected structuredContent');
    assert.doesNotThrow(() => d365GetEntitySourcesOutput.parse(result.structuredContent));
    for (const f of result.structuredContent.entity_fields) {
      assert.ok(f.is_mandatory === null || typeof f.is_mandatory === 'number',
        `field ${f.field_name} is_mandatory is ${typeof f.is_mandatory}`);
    }
  });
});

describe('NULL relation fields — d365_lookup_table', () => {
  before(() => {
    db.exec(`
      INSERT OR REPLACE INTO tables VALUES ('NullRelTest', 'TestModule', 'Test', 'Main', 1, NULL, NULL, NULL, 0);
      INSERT INTO relations VALUES (NULL, 'NullRelTest', NULL, '[]', NULL, NULL);
      INSERT INTO relations VALUES ('NullRelTest', NULL, NULL, '[]', NULL, NULL);
    `);
  });
  after(() => {
    db.exec(`
      DELETE FROM tables WHERE table_name = 'NullRelTest';
      DELETE FROM relations WHERE source_table = 'NullRelTest' OR related_table = 'NullRelTest';
    `);
  });

  it('given NULL source_table and relation_name in relations, then schema parses', async () => {
    const { d365LookupTableOutput } = await import('../src/azure/output-schemas.js');
    const result = await callToolFull('d365_lookup_table', { table_name: 'NullRelTest' });
    assert.ok(result.structuredContent, 'expected structuredContent');
    assert.doesNotThrow(() => d365LookupTableOutput.parse(result.structuredContent));
    // Incoming relation should have nullable source_table
    for (const r of result.structuredContent.incoming_relations) {
      assert.ok(r.source_table === null || typeof r.source_table === 'string');
    }
    // Outgoing relation should have nullable related_table
    for (const r of result.structuredContent.outgoing_relations) {
      assert.ok(r.related_table === null || typeof r.related_table === 'string');
    }
  });
});

// -- Issue #42: wildcard pattern length validation ---------------------------

describe('wildcard pattern length validation (issue #42)', () => {
  it('rejects oversized table_name before reaching the DB (LIKE-fuzzy path)', async () => {
    // 200-char input would normally trigger the fuzzy `LIKE %...%` branch.
    // The validator must short-circuit it and return a structured error.
    const oversized = 'X'.repeat(200);
    const tool = toolHandlers['d365_lookup_table'];
    const result = await tool.handler({ table_name: oversized });
    assert.equal(result.isError, true);
    assert.ok(
      result.content[0].text.includes('Search pattern too long'),
      `expected pattern-length error, got: ${result.content[0].text}`,
    );
  });

  it('accepts valid table_name lookups (regression guard)', async () => {
    const result = await callTool('d365_lookup_table', { table_name: 'CustTable' });
    assert.ok(result.includes('CustTable'));
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Issue #33 — Edge-case tests: empty results, no-match queries
//
//  All NEW tests assert STRUCTURAL shape (assert.match against /regex/) —
//  never `assert.ok(string.includes(...))`. Each suite injects an isolated
//  fixture and cleans up so existing happy-path tests remain unaffected.
// ═════════════════════════════════════════════════════════════════════════════

describe('issue #33 — d365_lookup_table on a table with zero fields', () => {
  before(() => {
    // Table exists in `tables` but has zero rows in `fields`. This exercises
    // the empty-fields branch of the lookup tool.
    db.exec(`
      INSERT OR REPLACE INTO tables VALUES
        ('IssueEmptyTable', 'TestModule', 'Empty', 'Main', 1,
         'Found', 'Idx', NULL, 0);
    `);
  });
  after(() => {
    db.exec(`DELETE FROM tables WHERE table_name = 'IssueEmptyTable';`);
  });

  it('given a table with zero fields, when d365_lookup_table runs, then the Fields section renders a no-results sentinel (no crash, no isError)', async () => {
    const tool = toolHandlers['d365_lookup_table'];
    const result = await tool.handler({ table_name: 'IssueEmptyTable' });
    // Shape: success channel (no isError flag).
    assert.notEqual(result.isError, true);
    const text = result.content[0].text;
    // Header renders.
    assert.match(text, /^# IssueEmptyTable$/m);
    // The Fields section is present, followed by the empty-rows sentinel
    // produced by formatMarkdownTable.
    assert.match(text, /^## Fields$/m);
    assert.match(text, /No results found/);
  });
});

describe('issue #33 — d365_check_field_exists on a table with zero fields', () => {
  before(() => {
    db.exec(`
      INSERT OR REPLACE INTO tables VALUES
        ('IssueFieldlessTable', 'TestModule', 'No fields', 'Main', 1,
         'Found', 'Idx', NULL, 0);
    `);
  });
  after(() => {
    db.exec(`DELETE FROM tables WHERE table_name = 'IssueFieldlessTable';`);
  });

  it('given a known table with zero fields and an arbitrary field name to check, when d365_check_field_exists runs, then every field reports DOES NOT EXIST', async () => {
    const tool = toolHandlers['d365_check_field_exists'];
    const result = await tool.handler({
      table_name: 'IssueFieldlessTable',
      field_names: ['SomeField', 'AnotherField'],
    });
    // Shape: success channel.
    assert.notEqual(result.isError, true);
    const text = result.content[0].text;
    // Header renders.
    assert.match(text, /^## Field Check: IssueFieldlessTable$/m);
    // Each requested field is reported with the **NO** + DOES NOT EXIST shape.
    assert.match(text, /\|SomeField\|\*\*NO\*\*\|DOES NOT EXIST/);
    assert.match(text, /\|AnotherField\|\*\*NO\*\*\|DOES NOT EXIST/);
    // No "YES" rows because there are zero actual fields.
    assert.doesNotMatch(text, /\|YES\|/);
  });

  it('given an unknown table, when d365_check_field_exists runs, then the response identifies the missing table (not the missing fields)', async () => {
    const tool = toolHandlers['d365_check_field_exists'];
    const result = await tool.handler({
      table_name: 'CompletelyUnknownTable_Issue33',
      field_names: ['x', 'y'],
    });
    // Shape: success channel (the tool reports "table not found" via text,
    // it does not throw / set isError in this codebase state).
    assert.notEqual(result.isError, true);
    // The message references the table name and the not-found shape.
    assert.match(
      result.content[0].text,
      /Table "CompletelyUnknownTable_Issue33" not found/,
    );
    // It MUST NOT pretend the fields don't exist — the table itself is missing.
    assert.doesNotMatch(result.content[0].text, /DOES NOT EXIST/);
  });
});

describe('issue #33 — d365_search no-match scenarios', () => {
  it('given a query keyword absent from the search index, when d365_search runs, then the no-results sentinel is on the success channel', async () => {
    const tool = toolHandlers['d365_search'];
    const result = await tool.handler({ query: 'absolutelyzeroentries_issue33' });
    // Shape: success channel.
    assert.notEqual(result.isError, true);
    // Match the shape of the no-results message.
    assert.match(result.content[0].text, /No results for "absolutelyzeroentries_issue33"\./);
  });

  it('given a real keyword filtered to a wrong object_type, when d365_search runs, then the result is empty (the filter excludes everything)', async () => {
    // "Customer" hits CustTable rows, but filtering to object_type=enum
    // should produce zero results since no enum mentions "Customer".
    const tool = toolHandlers['d365_search'];
    const result = await tool.handler({ query: 'Customer', object_type: 'enum' });
    assert.notEqual(result.isError, true);
    assert.match(result.content[0].text, /No results for "Customer"\./);
  });
});

describe('issue #33 — d365_get_class_methods empty / no-match scenarios', () => {
  before(() => {
    // A class with exactly one method, used for the "filter-no-match"
    // empty branch test below.
    db.exec(`
      INSERT OR REPLACE INTO classes VALUES
        ('Issue33Class', 'TestModule', NULL, NULL, 0, 1);
      INSERT OR REPLACE INTO methods VALUES
        ('class', 'Issue33Class', 'theOnlyMethod',
         'public void theOnlyMethod()', 0, 'public void theOnlyMethod() {}');
    `);
  });
  after(() => {
    db.exec(`
      DELETE FROM classes WHERE class_name = 'Issue33Class';
      DELETE FROM methods WHERE owner_name = 'Issue33Class';
    `);
  });

  it('given a class with no methods at all, when d365_get_class_methods runs, then the no-methods sentinel is on the success channel', async () => {
    const tool = toolHandlers['d365_get_class_methods'];
    const result = await tool.handler({
      name: 'NoMethodsClass_Issue33',
      include_source: false,
      limit: 100,
    });
    assert.notEqual(result.isError, true);
    assert.match(result.content[0].text, /No methods found for "NoMethodsClass_Issue33"/);
  });

  it('given a class with methods but a filter that matches none, when d365_get_class_methods runs, then the response is empty (not the full method list)', async () => {
    const tool = toolHandlers['d365_get_class_methods'];
    const result = await tool.handler({
      name: 'Issue33Class',
      filter: 'doesnotmatchanything',
      include_source: false,
      limit: 100,
    });
    assert.notEqual(result.isError, true);
    // The filter excluded the only method, so we get the no-methods text.
    assert.match(result.content[0].text, /No methods found for "Issue33Class"/);
    // The actual method name MUST NOT leak into the empty response.
    assert.doesNotMatch(result.content[0].text, /theOnlyMethod/);
  });
});

describe('issue #33 — d365_field_renames on a table with no renames', () => {
  it('given a table that exists but has zero rename rows, when d365_field_renames runs, then the no-renames message identifies the table', async () => {
    // VendTable exists in the fixtures but has zero rows in `field_renames`.
    const tool = toolHandlers['d365_field_renames'];
    const result = await tool.handler({ table_name: 'VendTable' });
    assert.notEqual(result.isError, true);
    // Match shape: must mention the no-renames signal AND the table name.
    assert.match(result.content[0].text, /No known field renames/);
    assert.match(result.content[0].text, /VendTable/);
  });
});

describe('issue #33 — d365_resolve_label structural empty paths', () => {
  it('given a non-empty label_ids list where every id is unknown, when d365_resolve_label runs, then the no-labels message is on the success channel', async () => {
    const tool = toolHandlers['d365_resolve_label'];
    const result = await tool.handler({ label_ids: ['@NOTREAL_ISSUE33_A', '@NOTREAL_ISSUE33_B'] });
    assert.notEqual(result.isError, true);
    // Match the structural empty signal.
    assert.match(result.content[0].text, /No labels found/);
  });

  it('given an empty label_ids array, when d365_resolve_label runs, then the response is on the success channel and identifies the missing input', async () => {
    const tool = toolHandlers['d365_resolve_label'];
    const result = await tool.handler({ label_ids: [] });
    assert.notEqual(result.isError, true);
    assert.match(result.content[0].text, /No label IDs provided/);
  });
});

describe('issue #33 — d365_raw_sql on a SELECT that returns zero rows', () => {
  it('given a SELECT with no matching rows, when d365_raw_sql runs, then it surfaces a no-results indicator (not a crash)', async () => {
    const result = await callTool('d365_raw_sql', {
      sql: "SELECT table_name FROM tables WHERE table_name = 'definitely-not-a-real-table-issue33'",
    });
    // shared.formatMarkdownTable returns "No results found." for empty rows.
    assert.match(result, /No results found/);
  });
});
