/**
 * Tests for D365FO Cross-Reference MCP Tools (xref-tools.js)
 *
 * Creates an in-memory SQLite database with test fixtures, then exercises
 * each tool's handler function directly.
 *
 * Run: npm test             (all tests)
 *      npm run test:xref    (xref tests only)
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

// -- Test Database Setup -----------------------------------------------------

let db;
let toolHandlers;

/** Intercept registerTool() (and the legacy tool() overload) to collect handlers */
function createMockServer() {
  const handlers = {};
  return {
    registerTool: (name, config, handler) => {
      handlers[name] = {
        schema: config.inputSchema || {},
        outputSchema: config.outputSchema,
        handler,
      };
    },
    tool: (name, _desc, schema, handler) => {
      handlers[name] = { schema, handler };
    },
    handlers,
  };
}

// Default the text channel to Markdown for renderer assertions; tests that
// exercise the TOON default pass format:'toon' explicitly (args wins).
const withFormat = (args) => ({ format: 'markdown', ...args });

/** Call a tool handler and extract the text result */
async function callTool(name, args) {
  const tool = toolHandlers[name];
  if (!tool) throw new Error(`Tool "${name}" not registered`);
  const result = await tool.handler(withFormat(args));
  return result.content[0].text;
}

/** Call a tool handler and return the full MCP result (content + structuredContent + isError). */
async function callToolFull(name, args) {
  const tool = toolHandlers[name];
  if (!tool) throw new Error(`Tool "${name}" not registered`);
  return await tool.handler(withFormat(args));
}

before(async () => {
  db = new Database(':memory:');
  db.pragma('journal_mode = OFF');

  // ── Create schema matching what xref-tools.js queries ──
  db.exec(`
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

    CREATE TABLE model_versions (
      model_name TEXT PRIMARY KEY, module_id TEXT, display_name TEXT,
      publisher TEXT, layer TEXT, origin TEXT, version TEXT, source_root TEXT
    );
  `);

  // ── Insert test fixture data ──
  // Kind values: 1=Call, 2=Read, 3=Implements, 4=Extends, 6=Delegate, 7=Attribute, 10=Override

  db.exec(`
    -- Modules
    INSERT INTO modules VALUES (1, 'ApplicationSuite');
    INSERT INTO modules VALUES (2, 'ApplicationFoundation');
    INSERT INTO modules VALUES (3, 'ApplicationPlatform');

    -- Providers
    INSERT INTO providers VALUES (1, 'Microsoft');
    INSERT INTO providers VALUES (2, 'ISV_Custom');

    -- Model build provenance (Descriptor XML capture)
    INSERT INTO model_versions VALUES ('Foundation', 'ApplicationSuite', 'Application Suite', 'Microsoft Corporation', 'SYS', 'microsoft', '10.0.2263.172', 'C:\\pkg');
    INSERT INTO model_versions VALUES ('ApplicationPlatform', 'ApplicationPlatform', 'Application Platform', 'Microsoft Corporation', 'SYS', 'microsoft', '7.0.7521.60', 'C:\\pkg');

    -- Names: Tables
    INSERT INTO names VALUES (100, '/Tables/CustTable', 'CustTable', 0, 1, 1);
    INSERT INTO names VALUES (101, '/Tables/CustTable/Fields/AccountNum', 'AccountNum', 0, 1, 1);
    INSERT INTO names VALUES (102, '/Tables/CustTable/Fields/CustGroup', 'CustGroup', 0, 1, 1);
    INSERT INTO names VALUES (103, '/Tables/CustTable/Methods/find', 'find', 0, 1, 1);
    INSERT INTO names VALUES (104, '/Tables/CustTable/Methods/insert', 'insert', 0, 1, 1);

    INSERT INTO names VALUES (110, '/Tables/VendTable', 'VendTable', 0, 1, 1);
    INSERT INTO names VALUES (111, '/Tables/VendTable/Fields/AccountNum', 'AccountNum', 0, 1, 1);
    INSERT INTO names VALUES (112, '/Tables/VendTable/Methods/find', 'find', 0, 1, 1);

    INSERT INTO names VALUES (120, '/Tables/SalesTable', 'SalesTable', 0, 1, 1);
    INSERT INTO names VALUES (121, '/Tables/SalesTable/Fields/SalesId', 'SalesId', 0, 1, 1);
    INSERT INTO names VALUES (122, '/Tables/SalesTable/Fields/CustAccount', 'CustAccount', 0, 1, 1);

    -- Names: Classes
    INSERT INTO names VALUES (200, '/Classes/SalesFormLetter', 'SalesFormLetter', 0, 1, 1);
    INSERT INTO names VALUES (201, '/Classes/SalesFormLetter/Methods/run', 'run', 0, 1, 1);
    INSERT INTO names VALUES (202, '/Classes/SalesFormLetter/Methods/construct', 'construct', 0, 1, 1);
    INSERT INTO names VALUES (203, '/Classes/SalesFormLetter/Methods/post', 'post', 0, 1, 1);

    INSERT INTO names VALUES (210, '/Classes/FormLetterService', 'FormLetterService', 0, 1, 1);
    INSERT INTO names VALUES (211, '/Classes/FormLetterService/Methods/initParm', 'initParm', 0, 1, 1);

    INSERT INTO names VALUES (220, '/Classes/SalesFormLetter_Invoice', 'SalesFormLetter_Invoice', 0, 1, 1);
    INSERT INTO names VALUES (221, '/Classes/SalesFormLetter_Invoice/Methods/run', 'run', 0, 1, 1);

    INSERT INTO names VALUES (230, '/Classes/SalesFormLetter_PackingSlip', 'SalesFormLetter_PackingSlip', 0, 1, 1);
    INSERT INTO names VALUES (231, '/Classes/SalesFormLetter_PackingSlip/Methods/run', 'run', 0, 1, 1);

    INSERT INTO names VALUES (240, '/Classes/PurchFormLetter', 'PurchFormLetter', 0, 1, 1);
    INSERT INTO names VALUES (241, '/Classes/PurchFormLetter/Methods/run', 'run', 0, 1, 1);

    -- Interface
    INSERT INTO names VALUES (250, '/Classes/SysRunnable', 'SysRunnable', 0, 1, 3);
    INSERT INTO names VALUES (260, '/Classes/SysPackable', 'SysPackable', 0, 1, 3);

    -- Extension classes
    INSERT INTO names VALUES (300, '/Classes/CustTable_Extension', 'CustTable_Extension', 0, 2, 1);
    INSERT INTO names VALUES (301, '/Classes/CustTable_Extension/Methods/validateWrite', 'validateWrite', 0, 2, 1);
    INSERT INTO names VALUES (310, '/Classes/CustTableEventExtension', 'CustTableEventExtension', 0, 2, 1);
    INSERT INTO names VALUES (320, '/Tables/CustTable.Extension1', 'CustTable.Extension1', 0, 2, 2);

    -- Event handler related
    INSERT INTO names VALUES (400, '/Classes/SubscribesTo', 'SubscribesTo', 0, 1, 3);
    INSERT INTO names VALUES (401, '/Classes/DataEventHandlerAttribute', 'DataEventHandlerAttribute', 0, 1, 3);
    INSERT INTO names VALUES (410, '/Classes/CustTableEventHandler', 'CustTableEventHandler', 0, 2, 1);
    INSERT INTO names VALUES (411, '/Classes/CustTableEventHandler/Methods/onInserted', 'onInserted', 0, 2, 1);

    -- Another module class
    INSERT INTO names VALUES (500, '/Classes/InventTransferLine', 'InventTransferLine', 0, 1, 2);
    INSERT INTO names VALUES (501, '/Classes/InventTransferLine/Methods/update', 'update', 0, 1, 2);

    -- Enum
    INSERT INTO names VALUES (600, '/Enums/StatusIssue', 'StatusIssue', 0, 1, 1);

    -- Form
    INSERT INTO names VALUES (700, '/Forms/CustTable', 'CustTable', 0, 1, 1);

    -- DataEntityView
    INSERT INTO names VALUES (800, '/DataEntityViews/CustCustomerEntity', 'CustCustomerEntity', 0, 1, 1);

    -- ── Refs ──
    -- SalesFormLetter extends FormLetterService (kind=4)
    INSERT INTO refs VALUES (200, 210, 4, NULL, NULL);
    -- SalesFormLetter_Invoice extends SalesFormLetter (kind=4)
    INSERT INTO refs VALUES (220, 200, 4, NULL, NULL);
    -- SalesFormLetter_PackingSlip extends SalesFormLetter (kind=4)
    INSERT INTO refs VALUES (230, 200, 4, NULL, NULL);

    -- SalesFormLetter implements SysRunnable (kind=3)
    INSERT INTO refs VALUES (200, 250, 3, NULL, NULL);
    -- PurchFormLetter implements SysRunnable (kind=3)
    INSERT INTO refs VALUES (240, 250, 3, NULL, NULL);

    -- SalesFormLetter.run calls CustTable.find (kind=1)
    INSERT INTO refs VALUES (201, 103, 1, 10, 5);
    INSERT INTO refs VALUES (201, 104, 1, 15, 5);
    -- SalesFormLetter.run reads CustTable.AccountNum (kind=2)
    INSERT INTO refs VALUES (201, 101, 2, 12, 10);
    -- SalesFormLetter.construct calls SalesFormLetter (kind=1)
    INSERT INTO refs VALUES (202, 200, 1, 5, 3);

    -- InventTransferLine.update calls CustTable.find (kind=1, cross-module)
    INSERT INTO refs VALUES (501, 103, 1, 20, 8);
    -- InventTransferLine.update reads SalesTable.SalesId (kind=2)
    INSERT INTO refs VALUES (501, 121, 2, 22, 3);

    -- SalesFormLetter_Invoice.run calls SalesFormLetter.post (kind=1)
    INSERT INTO refs VALUES (221, 203, 1, 8, 5);
    -- SalesFormLetter_PackingSlip.run calls SalesFormLetter.post (kind=1)
    INSERT INTO refs VALUES (231, 203, 1, 7, 5);

    -- SalesFormLetter.run reads SalesTable.CustAccount (kind=2)
    INSERT INTO refs VALUES (201, 122, 2, 14, 10);

    -- Override: SalesFormLetter_Invoice.run overrides SalesFormLetter.run (kind=10)
    INSERT INTO refs VALUES (221, 201, 10, NULL, NULL);

    -- Delegate: SalesFormLetter.post has a delegate reference (kind=6)
    INSERT INTO refs VALUES (203, 100, 6, NULL, NULL);

    -- Event handler: CustTableEventHandler.onInserted has Attribute ref (kind=7) to DataEventHandlerAttribute
    INSERT INTO refs VALUES (411, 401, 7, NULL, NULL);
    -- CustTableEventHandler.onInserted references CustTable (kind=2)
    INSERT INTO refs VALUES (411, 100, 2, 5, 1);

    -- CustTable_Extension references CustTable (kind=2)
    INSERT INTO refs VALUES (300, 100, 2, NULL, NULL);

    -- Write ref to CustTable.AccountNum field (kind=1)
    INSERT INTO refs VALUES (301, 101, 1, 10, 5);
  `);

  // Register tools against mock server
  const { registerXrefTools } = await import('../src/azure/xref-tools.js');
  const mockServer = createMockServer();
  registerXrefTools(mockServer, db);
  toolHandlers = mockServer.handlers;
});

after(() => {
  if (db) db.close();
});

// -- Tests -------------------------------------------------------------------

describe('xref_find_references', () => {
  it('finds incoming references to an object', async () => {
    const result = await callTool('xref_find_references', { object_name: 'CustTable', kind: 'All', limit: 100 });
    assert.ok(result.includes('References to'));
    assert.ok(result.includes('/Tables/CustTable'));
  });

  it('filters by kind', async () => {
    const result = await callTool('xref_find_references', { object_name: 'CustTable', kind: 'Read', limit: 100 });
    assert.ok(result.includes('Read') || result.includes('References TO'));
  });

  it('returns not found for unknown object', async () => {
    const result = await callTool('xref_find_references', { object_name: 'CompletelyFakeObject', kind: 'All', limit: 100 });
    assert.ok(result.includes('not found'));
  });

  it('accepts full path', async () => {
    const result = await callTool('xref_find_references', { object_name: '/Tables/CustTable', kind: 'All', limit: 100 });
    assert.ok(result.includes('References to'));
    assert.ok(result.includes('/Tables/CustTable'));
  });
});

describe('xref_find_usages', () => {
  it('finds outgoing references from an object', async () => {
    const result = await callTool('xref_find_usages', { object_name: 'SalesFormLetter', kind: 'All', limit: 100 });
    assert.ok(result.includes('Outgoing references from'));
    assert.ok(result.includes('/Classes/SalesFormLetter'));
  });

  it('shows targets of outgoing references', async () => {
    // SalesFormLetter extends FormLetterService and implements SysRunnable
    const result = await callTool('xref_find_usages', { object_name: 'SalesFormLetter', kind: 'All', limit: 100 });
    assert.ok(result.includes('FormLetterService') || result.includes('SysRunnable'));
  });

  it('returns not found for unknown object', async () => {
    const result = await callTool('xref_find_usages', { object_name: 'FakeClass', kind: 'All', limit: 100 });
    assert.ok(result.includes('not found'));
  });
});

describe('xref_find_method_callers', () => {
  it('finds callers of a method', async () => {
    const result = await callTool('xref_find_method_callers', {
      object_name: 'CustTable', method_name: 'find', limit: 100,
    });
    assert.ok(result.includes('Callers of'));
    assert.ok(result.includes('/Classes/SalesFormLetter/Methods/run'));
    assert.ok(result.includes('/Classes/InventTransferLine/Methods/update'));
  });

  it('shows line numbers', async () => {
    const result = await callTool('xref_find_method_callers', {
      object_name: 'CustTable', method_name: 'find', limit: 100,
    });
    assert.ok(result.includes('10'));
  });

  it('returns not found for unknown method', async () => {
    const result = await callTool('xref_find_method_callers', {
      object_name: 'CustTable', method_name: 'nonExistentMethod', limit: 100,
    });
    assert.ok(result.includes('not found'));
  });

  it('finds callers for class method', async () => {
    const result = await callTool('xref_find_method_callers', {
      object_name: 'SalesFormLetter', method_name: 'post', limit: 100,
    });
    assert.ok(result.includes('SalesFormLetter_Invoice'));
    assert.ok(result.includes('SalesFormLetter_PackingSlip'));
  });
});

describe('xref_class_hierarchy', () => {
  it('finds subclasses', async () => {
    const result = await callTool('xref_class_hierarchy', {
      class_name: 'SalesFormLetter', direction: 'subclasses',
    });
    assert.ok(result.includes('Subclasses of'));
    assert.ok(result.includes('SalesFormLetter_Invoice'));
    assert.ok(result.includes('SalesFormLetter_PackingSlip'));
  });

  it('finds parent chain', async () => {
    const result = await callTool('xref_class_hierarchy', {
      class_name: 'SalesFormLetter', direction: 'parents',
    });
    assert.ok(result.includes('Inheritance chain'));
    assert.ok(result.includes('SalesFormLetter'));
    assert.ok(result.includes('FormLetterService'));
  });

  it('returns not found for unknown class', async () => {
    const result = await callTool('xref_class_hierarchy', {
      class_name: 'NonExistentClass', direction: 'subclasses',
    });
    assert.ok(result.includes('not found'));
  });

  it('finds multi-level hierarchy', async () => {
    // FormLetterService -> SalesFormLetter -> SalesFormLetter_Invoice
    const result = await callTool('xref_class_hierarchy', {
      class_name: 'FormLetterService', direction: 'subclasses',
    });
    assert.ok(result.includes('SalesFormLetter'));
    assert.ok(result.includes('SalesFormLetter_Invoice'));
  });
});

describe('xref_interface_implementors', () => {
  it('finds direct implementors', async () => {
    const result = await callTool('xref_interface_implementors', { interface_name: 'SysRunnable' });
    assert.ok(result.includes('Implementors of'));
    assert.ok(result.includes('SalesFormLetter'));
    assert.ok(result.includes('PurchFormLetter'));
  });

  it('finds inherited implementors', async () => {
    // SalesFormLetter_Invoice extends SalesFormLetter which implements SysRunnable
    const result = await callTool('xref_interface_implementors', { interface_name: 'SysRunnable' });
    assert.ok(result.includes('SalesFormLetter_Invoice'));
    assert.ok(result.includes('Inherited'));
  });

  it('returns not found for unknown interface', async () => {
    const result = await callTool('xref_interface_implementors', { interface_name: 'NonExistentInterface' });
    assert.ok(result.includes('not found'));
  });
});

describe('xref_search_names', () => {
  it('finds objects by name pattern', async () => {
    const result = await callTool('xref_search_names', { pattern: 'CustTable', object_type: 'All', limit: 50 });
    assert.ok(result.includes('/Tables/CustTable'));
  });

  it('filters by object type', async () => {
    const result = await callTool('xref_search_names', { pattern: 'CustTable', object_type: 'Tables', limit: 50 });
    assert.ok(result.includes('/Tables/CustTable'));
    assert.ok(!result.includes('/Classes/'));
  });

  it('excludes methods/fields/controls', async () => {
    const result = await callTool('xref_search_names', { pattern: 'AccountNum', object_type: 'All', limit: 50 });
    // Fields paths like /Tables/CustTable/Fields/AccountNum should be excluded
    assert.ok(!result.includes('/Fields/'));
  });

  it('supports SQL LIKE wildcards', async () => {
    const result = await callTool('xref_search_names', { pattern: '%Sales%Letter%', object_type: 'All', limit: 50 });
    assert.ok(result.includes('SalesFormLetter'));
  });

  it('shows truncation warning when limit hit', async () => {
    const result = await callTool('xref_search_names', { pattern: '%', object_type: 'All', limit: 1 });
    assert.ok(result.includes('Showing first 1'));
  });

  it('discloses the custom-layer coverage gap on an empty custom-prefix search', async () => {
    const result = await callTool('xref_search_names', { pattern: 'TBG_NoSuchCustomObject', object_type: 'All', limit: 50 });
    assert.ok(result.includes('No results'));
    assert.match(result, /custom overlayer|custom prefix/i);
  });

  it('does NOT add the custom-layer note to a standard empty search', async () => {
    const result = await callTool('xref_search_names', { pattern: 'ZzzDefinitelyNotARealObject', object_type: 'All', limit: 50 });
    assert.ok(result.includes('No results'));
    assert.doesNotMatch(result, /custom overlayer|custom prefix/i);
  });
});

describe('xref_method_references', () => {
  it('finds outgoing references from a method', async () => {
    const result = await callTool('xref_method_references', {
      object_name: 'SalesFormLetter', method_name: 'run', kind: 'All', limit: 100,
    });
    assert.ok(result.includes('Outgoing references from'));
    assert.ok(result.includes('/Tables/CustTable/Methods/find'));
    assert.ok(result.includes('/Tables/CustTable/Fields/AccountNum'));
  });

  it('filters by Call kind', async () => {
    const result = await callTool('xref_method_references', {
      object_name: 'SalesFormLetter', method_name: 'run', kind: 'Call', limit: 100,
    });
    assert.ok(result.includes('find'));
    // Should not include field reads
    assert.ok(!result.includes('AccountNum'));
  });

  it('filters by Read kind', async () => {
    const result = await callTool('xref_method_references', {
      object_name: 'SalesFormLetter', method_name: 'run', kind: 'Read', limit: 100,
    });
    assert.ok(result.includes('AccountNum'));
    // Should not include method calls
    assert.ok(!result.includes('/Methods/find'));
  });

  it('returns not found for unknown method', async () => {
    const result = await callTool('xref_method_references', {
      object_name: 'SalesFormLetter', method_name: 'nonExistent', kind: 'All', limit: 100,
    });
    assert.ok(result.includes('not found'));
  });
});

describe('xref_module_objects', () => {
  it('lists objects in a module', async () => {
    const result = await callTool('xref_module_objects', {
      module_name: 'ApplicationSuite', object_type: 'All', limit: 200,
    });
    assert.ok(result.includes('Objects in'));
    assert.ok(result.includes('/Tables/CustTable'));
    assert.ok(result.includes('/Classes/SalesFormLetter'));
  });

  it('filters by object type', async () => {
    const result = await callTool('xref_module_objects', {
      module_name: 'ApplicationSuite', object_type: 'Tables', limit: 200,
    });
    assert.ok(result.includes('/Tables/'));
    assert.ok(!result.includes('/Classes/SalesFormLetter'));
  });

  it('excludes sub-paths (methods/fields)', async () => {
    const result = await callTool('xref_module_objects', {
      module_name: 'ApplicationSuite', object_type: 'All', limit: 200,
    });
    assert.ok(!result.includes('/Methods/'));
    assert.ok(!result.includes('/Fields/'));
  });
});

describe('xref_cross_module_deps', () => {
  it('finds modules this module depends on', async () => {
    // ApplicationFoundation (InventTransferLine) calls CustTable.find in ApplicationSuite
    const result = await callTool('xref_cross_module_deps', {
      module_name: 'ApplicationFoundation', direction: 'depends_on', limit: 50,
    });
    assert.ok(result.includes('depends on'));
    assert.ok(result.includes('ApplicationSuite'));
  });

  it('finds modules that depend on this module', async () => {
    const result = await callTool('xref_cross_module_deps', {
      module_name: 'ApplicationSuite', direction: 'depended_by', limit: 50,
    });
    assert.ok(result.includes('depended on by'));
    assert.ok(result.includes('ApplicationFoundation'));
  });

  it('shows reference counts', async () => {
    const result = await callTool('xref_cross_module_deps', {
      module_name: 'ApplicationFoundation', direction: 'depends_on', limit: 50,
    });
    assert.ok(result.includes('Reference Count'));
  });
});

describe('xref_raw_sql', () => {
  it('executes valid SELECT queries', async () => {
    const result = await callTool('xref_raw_sql', { sql: 'SELECT path FROM names WHERE id = 100', limit: 100 });
    assert.ok(result.includes('/Tables/CustTable'));
  });

  it('rejects INSERT statements', async () => {
    const result = await callTool('xref_raw_sql', { sql: "INSERT INTO names VALUES (999, '/test', 'test', 0, 1, 1)", limit: 100 });
    assert.ok(result.includes('Error'));
    assert.ok(result.includes('Only SELECT'));
  });

  it('rejects DELETE statements', async () => {
    const result = await callTool('xref_raw_sql', { sql: 'DELETE FROM names', limit: 100 });
    assert.ok(result.includes('Error'));
  });

  it('blocks DROP keyword embedded in SELECT', async () => {
    const result = await callTool('xref_raw_sql', { sql: "SELECT * FROM names; DROP TABLE names", limit: 100 });
    assert.ok(result.includes('Forbidden') || result.includes('not allowed') || result.includes('Error'));
  });

  it('allows WITH (CTE) queries', async () => {
    const result = await callTool('xref_raw_sql', {
      sql: 'WITH t AS (SELECT path FROM names WHERE id = 100) SELECT * FROM t',
      limit: 100,
    });
    assert.ok(result.includes('/Tables/CustTable'));
  });

  it('adds LIMIT if missing', async () => {
    const result = await callTool('xref_raw_sql', { sql: 'SELECT path FROM names WHERE id = 100', limit: 100 });
    assert.ok(result.includes('CustTable'));
  });

  it('reports SQL errors gracefully', async () => {
    const result = await callTool('xref_raw_sql', { sql: 'SELECT nonexistent FROM names', limit: 100 });
    assert.ok(result.includes('Error'));
  });

  it('TOON: format="toon" renders the text channel as a TOON block', async () => {
    const md = await callTool('xref_raw_sql', { sql: 'SELECT path FROM names WHERE id = 100', limit: 100, format: 'markdown' });
    const toon = await callTool('xref_raw_sql', { sql: 'SELECT path FROM names WHERE id = 100', limit: 100, format: 'toon' });
    assert.match(md, /^\| path \|/m);
    assert.match(toon, /^rows\[\d+\]\{path\}:/m);
    assert.doesNotMatch(toon, /^\| path \|/m);
  });
});

describe('xref_impact_analysis', () => {
  it('shows impact of changing an object', async () => {
    const result = await callTool('xref_impact_analysis', { object_name: 'CustTable' });
    assert.ok(result.includes('Impact analysis'));
    assert.ok(result.includes('/Tables/CustTable'));
    assert.ok(result.includes('Total references'));
  });

  it('groups by reference kind', async () => {
    const result = await callTool('xref_impact_analysis', { object_name: 'CustTable' });
    assert.ok(result.includes('By reference kind'));
  });

  it('groups by module', async () => {
    const result = await callTool('xref_impact_analysis', { object_name: 'CustTable' });
    assert.ok(result.includes('By module'));
  });

  it('includes sub-paths in analysis', async () => {
    // References to CustTable's methods and fields should be included
    const result = await callTool('xref_impact_analysis', { object_name: 'CustTable' });
    // SalesFormLetter.run calls CustTable.find and reads CustTable.AccountNum
    assert.ok(result.includes('SalesFormLetter'));
  });

  it('returns not found for unknown object', async () => {
    const result = await callTool('xref_impact_analysis', { object_name: 'CompletelyFakeObject' });
    assert.ok(result.includes('not found'));
  });
});

describe('xref_list_modules', () => {
  it('returns all modules with object counts', async () => {
    const result = await callTool('xref_list_modules', {});
    assert.ok(result.includes('ApplicationSuite'));
    assert.ok(result.includes('ApplicationFoundation'));
    assert.ok(result.includes('ApplicationPlatform'));
  });

  it('shows object count column', async () => {
    const result = await callTool('xref_list_modules', {});
    assert.ok(result.includes('Object Count'));
  });

  it('shows the scanned build version and origin per module', async () => {
    const full = await callToolFull('xref_list_modules', {});
    const suite = full.structuredContent.modules.find(m => m.module === 'ApplicationSuite');
    assert.equal(suite.version, '10.0.2263.172');
    assert.equal(suite.origin, 'microsoft');
    // Module without a captured descriptor degrades to nulls, not an error.
    const found = full.structuredContent.modules.find(m => m.module === 'ApplicationFoundation');
    assert.equal(found.version, null);
    assert.ok(full.content[0].text.includes('10.0.2263.172'));
  });
});

describe('xref_search_names modules filter', () => {
  it('limits results to the given modules (case-insensitive)', async () => {
    const full = await callToolFull('xref_search_names', {
      pattern: 'CustTable', object_type: 'All', limit: 50, modules: ['applicationfoundation'],
    });
    assert.equal(full.structuredContent.result_count, 1);
    assert.equal(full.structuredContent.results[0].path, '/Tables/CustTable.Extension1');
    assert.deepEqual(full.structuredContent.modules, ['applicationfoundation']);
    assert.match(full.content[0].text, /Scope: modules applicationfoundation/);
  });

  it('reports modules: null when unfiltered and returns rows from all modules', async () => {
    const full = await callToolFull('xref_search_names', {
      pattern: 'CustTable', object_type: 'All', limit: 50,
    });
    assert.equal(full.structuredContent.modules, null);
    assert.ok(full.structuredContent.result_count > 1);
  });
});

describe('xref_object_summary', () => {
  it('returns summary with ref counts', async () => {
    const result = await callTool('xref_object_summary', { object_name: 'CustTable' });
    assert.ok(result.includes('Object summary'));
    assert.ok(result.includes('/Tables/CustTable'));
    assert.ok(result.includes('Module'));
    assert.ok(result.includes('ApplicationSuite'));
  });

  it('shows sub-objects', async () => {
    const result = await callTool('xref_object_summary', { object_name: 'CustTable' });
    assert.ok(result.includes('Sub-objects'));
  });

  it('shows methods list', async () => {
    const result = await callTool('xref_object_summary', { object_name: 'CustTable' });
    assert.ok(result.includes('Methods'));
    assert.ok(result.includes('find'));
    assert.ok(result.includes('insert'));
  });

  it('shows incoming and outgoing ref counts', async () => {
    const result = await callTool('xref_object_summary', { object_name: 'CustTable' });
    assert.ok(result.includes('Incoming references'));
    assert.ok(result.includes('Outgoing references'));
    assert.ok(result.includes('total'));
  });

  it('returns not found for unknown object', async () => {
    const result = await callTool('xref_object_summary', { object_name: 'FakeObject' });
    assert.ok(result.includes('not found'));
  });
});

describe('xref_find_extensions', () => {
  it('finds CoC extension classes', async () => {
    const result = await callTool('xref_find_extensions', {
      object_name: 'CustTable', object_type: 'All', limit: 100,
    });
    assert.ok(result.includes('Extensions for'));
    assert.ok(result.includes('CustTable_Extension'));
  });

  it('finds table extensions', async () => {
    const result = await callTool('xref_find_extensions', {
      object_name: 'CustTable', object_type: 'All', limit: 100,
    });
    assert.ok(result.includes('CustTable.Extension1'));
  });

  it('returns no extensions for object without them', async () => {
    const result = await callTool('xref_find_extensions', {
      object_name: 'VendTable', object_type: 'All', limit: 100,
    });
    assert.ok(result.includes('No extensions for'));
  });

  it('filters by object type', async () => {
    const result = await callTool('xref_find_extensions', {
      object_name: 'CustTable', object_type: 'Tables', limit: 100,
    });
    // Should find table extensions
    assert.ok(result.includes('CustTable'));
  });

  it('shows total count', async () => {
    const result = await callTool('xref_find_extensions', {
      object_name: 'CustTable', object_type: 'All', limit: 100,
    });
    assert.ok(result.includes('Total:'));
  });
});

describe('xref_find_field_usages', () => {
  it('finds read usages of a field', async () => {
    const result = await callTool('xref_find_field_usages', {
      table_name: 'CustTable', field_name: 'AccountNum', kind: 'All', limit: 100,
    });
    assert.ok(result.includes('Field usages'));
    assert.ok(result.includes('CustTable.AccountNum'));
  });

  it('separates reads and writes', async () => {
    const result = await callTool('xref_find_field_usages', {
      table_name: 'CustTable', field_name: 'AccountNum', kind: 'All', limit: 100,
    });
    // We have both Read (kind=2) and Write/Call (kind=1) refs to AccountNum
    assert.ok(result.includes('Reads'));
    assert.ok(result.includes('Writes'));
  });

  it('filters by Read kind', async () => {
    const result = await callTool('xref_find_field_usages', {
      table_name: 'CustTable', field_name: 'AccountNum', kind: 'Read', limit: 100,
    });
    assert.ok(result.includes('Reads'));
  });

  it('returns not found for unknown field', async () => {
    const result = await callTool('xref_find_field_usages', {
      table_name: 'CustTable', field_name: 'NonExistentField', kind: 'All', limit: 100,
    });
    assert.ok(result.includes('not found'));
  });

  it('shows line numbers', async () => {
    const result = await callTool('xref_find_field_usages', {
      table_name: 'CustTable', field_name: 'AccountNum', kind: 'All', limit: 100,
    });
    assert.ok(result.includes('12') || result.includes('10'));
  });
});

describe('xref_find_event_handlers', () => {
  it('finds delegate methods on an object', async () => {
    const result = await callTool('xref_find_event_handlers', {
      object_name: 'SalesFormLetter', limit: 100,
    });
    assert.ok(result.includes('Delegates defined on'));
    assert.ok(result.includes('post'));
  });

  it('finds override handlers', async () => {
    const result = await callTool('xref_find_event_handlers', {
      object_name: 'SalesFormLetter', limit: 100,
    });
    assert.ok(result.includes('Method overrides'));
    assert.ok(result.includes('SalesFormLetter_Invoice'));
  });

  it('returns not found for object with no handlers', async () => {
    const result = await callTool('xref_find_event_handlers', {
      object_name: 'PurchFormLetter', limit: 100,
    });
    assert.ok(result.includes('No event handlers') || result.includes('PurchFormLetter'));
  });

  it('finds data event handlers', async () => {
    const result = await callTool('xref_find_event_handlers', {
      object_name: 'CustTable', limit: 100,
    });
    // CustTableEventHandler.onInserted has DataEventHandlerAttribute and references CustTable
    assert.ok(result.includes('CustTableEventHandler') || result.includes('event handler'));
  });
});

// -- Issue #42: wildcard pattern length validation ---------------------------

describe('wildcard pattern length validation (issue #42)', () => {
  it('rejects oversized object_name before reaching the DB (LIKE-fuzzy path)', async () => {
    // Path-form input to exercise the LIKE branch in resolveNameId().
    const oversized = '/Classes/' + 'X'.repeat(200);
    const tool = toolHandlers['xref_find_references'];
    const result = await tool.handler({ object_name: oversized, limit: 50 });
    assert.equal(result.isError, true);
    assert.ok(
      result.content[0].text.includes('Search pattern too long'),
      `expected pattern-length error, got: ${result.content[0].text}`,
    );
  });

  it('accepts valid object_name lookups (regression guard)', async () => {
    const result = await callTool('xref_find_references', { object_name: 'CustTable', limit: 10 });
    // Should produce a real response (either references or a not-found / empty message), never an error.
    assert.ok(typeof result === 'string');
  });
});
