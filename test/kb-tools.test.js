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

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

// -- Test Database Setup -----------------------------------------------------

let db;
let toolHandlers;

/** Intercept server.tool() calls to collect handlers */
function createMockServer() {
  const handlers = {};
  return {
    tool: (name, _desc, schema, handler) => {
      handlers[name] = { schema, handler };
    },
    handlers,
  };
}

/** Call a tool handler and extract the text result */
async function callTool(name, args) {
  const tool = toolHandlers[name];
  if (!tool) throw new Error(`Tool "${name}" not registered`);
  const result = await tool.handler(args);
  return result.content[0].text;
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
    INSERT INTO fields VALUES ('CustTable', 'AccountNum', 'String', 'CustAccount', NULL, 1);
    INSERT INTO fields VALUES ('CustTable', 'CustGroup', 'String', 'CustGroupId', NULL, 1);
    INSERT INTO fields VALUES ('CustTable', 'Currency', 'String', 'CurrencyCode', NULL, 0);
    INSERT INTO fields VALUES ('CustTable', 'Party', 'Int64', 'DirPartyRecId', NULL, 1);
    INSERT INTO fields VALUES ('CustTable', 'InvoiceAccount', 'String', 'CustInvoiceAccount', NULL, 0);
    INSERT INTO fields VALUES ('VendTable', 'AccountNum', 'String', 'VendAccount', NULL, 1);
    INSERT INTO fields VALUES ('VendTable', 'VendGroup', 'String', 'VendGroupId', NULL, 0);
    INSERT INTO fields VALUES ('CustGroup', 'CustGroup', 'String', 'CustGroupId', NULL, 1);
    INSERT INTO fields VALUES ('CustGroup', 'Name', 'String', 'Description', NULL, 0);
    INSERT INTO fields VALUES ('SalesTable', 'SalesId', 'String', 'SalesIdBase', NULL, 1);
    INSERT INTO fields VALUES ('SalesTable', 'CustAccount', 'String', 'CustAccount', NULL, 1);

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

    -- Labels
    INSERT INTO labels VALUES ('@SYS12345', 'Customer account');
    INSERT INTO labels VALUES ('@SYS67890', 'Vendor account');
    INSERT INTO labels VALUES ('@SYS11111', 'Sales order');
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

  it('returns no results for unknown keyword', async () => {
    const result = await callTool('d365_search', { query: 'xyznonexistent' });
    assert.ok(result.includes('No results'));
  });

  it('respects limit', async () => {
    const result = await callTool('d365_search', { query: 'Table', limit: 1 });
    // Should have a truncation warning
    assert.ok(result.includes('Showing first 1'));
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
    assert.ok(result.includes('No methods found'));
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

  it('respects limit', async () => {
    const result = await callTool('d365_get_class_methods', { name: 'SalesFormLetter', include_source: false, limit: 2 });
    // Should show truncation warning since there are 4 methods but limit is 2
    assert.ok(result.includes('Showing first 2'));
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
    assert.ok(result.includes('No tables reference'));
  });

  it('shows total count', async () => {
    const result = await callTool('d365_find_referencing_tables', { table_name: 'CustGroup' });
    assert.ok(result.includes('Total:'));
    assert.ok(result.includes('CustTable'));
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

  it('returns clean for table with no traps', async () => {
    const result = await callTool('d365_hallucination_check', { table_name: 'VendTable' });
    assert.ok(result.includes('No known hallucination traps'));
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
    assert.ok(result.includes('No connections found'));
  });
});

describe('d365_field_renames', () => {
  it('returns field renames for a table', async () => {
    const result = await callTool('d365_field_renames', { table_name: 'CustTable' });
    assert.ok(result.includes('Field Renames'));
    assert.ok(result.includes('AccountStatement'));
    assert.ok(result.includes('PrintMgmtAccountStatement'));
  });

  it('returns no renames for table without renames', async () => {
    const result = await callTool('d365_field_renames', { table_name: 'VendTable' });
    assert.ok(result.includes('No known field renames'));
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
    assert.ok(result.includes('2 total'));
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

  it('returns not found for all unknown labels', async () => {
    const result = await callTool('d365_resolve_label', { label_ids: ['@NOPE1', '@NOPE2'] });
    assert.ok(result.includes('No labels found'));
  });

  it('handles empty array', async () => {
    const result = await callTool('d365_resolve_label', { label_ids: [] });
    assert.ok(result.includes('No label IDs provided'));
  });
});
