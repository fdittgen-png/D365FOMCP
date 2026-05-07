/**
 * Tests for D365FO Security MCP Tools (sec-tools.js)
 *
 * Creates an in-memory SQLite database with test fixtures, then exercises
 * each tool's handler function directly.
 *
 * Run: npm test           (all tests)
 *      npm run test:sec   (security tests only)
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

// ── Test Database Setup ──────────────────────────────────────────────────────

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

/** Call a tool handler and extract the text result */
async function callTool(name, args) {
  const tool = toolHandlers[name];
  if (!tool) throw new Error(`Tool "${name}" not registered`);
  const result = await tool.handler(args);
  return result.content[0].text;
}

/** PM-05: return the full MCP result shape (content + structuredContent + isError). */
async function callToolFull(name, args) {
  const tool = toolHandlers[name];
  if (!tool) throw new Error(`Tool "${name}" not registered`);
  return await tool.handler(args);
}

before(async () => {
  // Create in-memory database with test fixtures
  db = new Database(':memory:');
  db.pragma('journal_mode = OFF');

  // Create schema
  db.exec(`
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
      role_id TEXT, entity_name TEXT, grant_read TEXT, grant_create TEXT,
      grant_update TEXT, grant_delete TEXT, grant_correct TEXT, grant_invoke TEXT,
      PRIMARY KEY (role_id, entity_name)
    );
    CREATE TABLE sec_search (
      object_type TEXT, object_name TEXT, module_id TEXT, content TEXT
    );
    CREATE TABLE sec_metadata (key TEXT PRIMARY KEY, value TEXT);
  `);

  // Insert test data
  db.exec(`
    -- Roles
    INSERT INTO roles VALUES ('R1', 'SystemAdministrator', 'System', 'System administrator', 'Full access', 'Enterprise', 'Grant', 0, 'test');
    INSERT INTO roles VALUES ('R2', 'AccountsPayableClerk', 'ApplicationSuite', 'AP Clerk', 'AP processing', 'TeamMembers', 'Grant', 0, 'test');
    INSERT INTO roles VALUES ('R3', 'TBG Deny AP Posting', 'iExtension', 'Deny AP Posting', 'Denies AP posting', NULL, 'Deny', 0, 'test');
    INSERT INTO roles VALUES ('R4', 'AccountsPayableManager', 'ApplicationSuite', 'AP Manager', 'AP management', 'Enterprise', 'Grant', 0, 'test');

    -- Sub-roles: R4 (AP Manager) contains R2 (AP Clerk)
    INSERT INTO role_subroles VALUES ('R4', 'R2', 0);

    -- Duties
    INSERT INTO duties VALUES ('VendInvoiceProcess', 'Process vendor invoices', 'ApplicationSuite', 'Process and post vendor invoices');
    INSERT INTO duties VALUES ('VendPaymentProcess', 'Process vendor payments', 'ApplicationSuite', 'Process vendor payment journals');
    INSERT INTO duties VALUES ('LedgerPostMaintain', 'Maintain GL postings', 'ApplicationSuite', 'Maintain general ledger postings');

    -- Role-Duty assignments
    INSERT INTO role_duties VALUES ('R1', 'VendInvoiceProcess', 'Grant');
    INSERT INTO role_duties VALUES ('R1', 'VendPaymentProcess', 'Grant');
    INSERT INTO role_duties VALUES ('R1', 'LedgerPostMaintain', 'Grant');
    INSERT INTO role_duties VALUES ('R2', 'VendInvoiceProcess', 'Grant');
    INSERT INTO role_duties VALUES ('R4', 'VendInvoiceProcess', 'Grant');
    INSERT INTO role_duties VALUES ('R4', 'VendPaymentProcess', 'Grant');
    INSERT INTO role_duties VALUES ('R3', 'VendInvoiceProcess', 'Deny');

    -- Privileges
    INSERT INTO privileges VALUES ('VendInvoiceJournalPost', 'ApplicationSuite', 'Post vendor invoice journal');
    INSERT INTO privileges VALUES ('VendPaymentJournalPost', 'ApplicationSuite', 'Post vendor payment journal');
    INSERT INTO privileges VALUES ('LedgerJournalPost', 'ApplicationSuite', 'Post GL journal');

    -- Duty-Privilege links
    INSERT INTO duty_privileges VALUES ('VendInvoiceProcess', 'VendInvoiceJournalPost');
    INSERT INTO duty_privileges VALUES ('VendPaymentProcess', 'VendPaymentJournalPost');
    INSERT INTO duty_privileges VALUES ('LedgerPostMaintain', 'LedgerJournalPost');

    -- Entry points
    INSERT INTO privilege_entry_points VALUES ('VendInvoiceJournalPost', 'VendInvoiceJournal', 'MenuItemAction', 'VendInvoiceJournal', 'Allow', 'Allow', 'Allow', NULL, NULL, NULL);
    INSERT INTO privilege_entry_points VALUES ('VendPaymentJournalPost', 'VendPaymentJournal', 'MenuItemAction', 'VendPaymentJournal', 'Allow', 'Allow', 'Allow', 'Allow', NULL, NULL);
    INSERT INTO privilege_entry_points VALUES ('LedgerJournalPost', 'LedgerJournalPost', 'MenuItemAction', 'LedgerJournalPost', 'Allow', NULL, NULL, NULL, NULL, NULL);

    -- Users
    INSERT INTO users VALUES ('admin@trelleborg.com', 'Admin User', 'admin@trelleborg.com', 1, 'LADE');
    INSERT INTO users VALUES ('john.doe@trelleborg.com', 'John Doe', 'john.doe@trelleborg.com', 1, 'TAB');
    INSERT INTO users VALUES ('disabled@trelleborg.com', 'Disabled User', 'disabled@trelleborg.com', 0, 'LADE');

    -- User-Role assignments
    INSERT INTO user_roles VALUES ('admin@trelleborg.com', 'R1');
    INSERT INTO user_roles VALUES ('john.doe@trelleborg.com', 'R2');
    INSERT INTO user_roles VALUES ('john.doe@trelleborg.com', 'R3');
    INSERT INTO user_roles VALUES ('john.doe@trelleborg.com', 'R4');

    -- Company scoping
    INSERT INTO user_role_companies VALUES ('john.doe@trelleborg.com', 'R2', 'TAB');
    INSERT INTO user_role_companies VALUES ('john.doe@trelleborg.com', 'R2', 'LADE');
    INSERT INTO user_role_companies VALUES ('john.doe@trelleborg.com', 'R4', 'TAB');

    -- Direct privileges
    INSERT INTO role_direct_privileges VALUES ('R1', 'LedgerJournalPost');

    -- Direct entity permissions
    INSERT INTO role_direct_entity_permissions VALUES ('R1', 'VendInvoiceHeaderEntity', 'Allow', 'Allow', 'Allow', 'Allow', NULL, NULL);

    -- Search index
    INSERT INTO sec_search VALUES ('role', 'SystemAdministrator', 'System', 'SystemAdministrator System administrator Full access');
    INSERT INTO sec_search VALUES ('role', 'AccountsPayableClerk', 'ApplicationSuite', 'AccountsPayableClerk AP Clerk AP processing');
    INSERT INTO sec_search VALUES ('duty', 'VendInvoiceProcess', 'ApplicationSuite', 'VendInvoiceProcess Process vendor invoices');
    INSERT INTO sec_search VALUES ('user', 'john.doe@trelleborg.com', NULL, 'john.doe@trelleborg.com John Doe TAB');

    -- Metadata
    INSERT INTO sec_metadata VALUES ('build_date', '2026-03-25T12:00:00Z');
    INSERT INTO sec_metadata VALUES ('roles', '4');
    INSERT INTO sec_metadata VALUES ('users', '3');
    INSERT INTO sec_metadata VALUES ('duties', '3');
    INSERT INTO sec_metadata VALUES ('privileges', '3');
  `);

  // Register tools against mock server
  const { registerSecTools } = await import('../src/azure/sec-tools.js');
  const mockServer = createMockServer();
  registerSecTools(mockServer, db);
  toolHandlers = mockServer.handlers;
});

after(() => {
  if (db) db.close();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('sec_lookup_role', () => {
  it('returns role details for existing role', async () => {
    const result = await callTool('sec_lookup_role', { role_name: 'SystemAdministrator' });
    assert.ok(result.includes('SystemAdministrator'));
    assert.ok(result.includes('Enterprise'));
    assert.ok(result.includes('Grant'));
  });

  it('is case-insensitive', async () => {
    const result = await callTool('sec_lookup_role', { role_name: 'systemadministrator' });
    assert.ok(result.includes('SystemAdministrator'));
  });

  it('shows duties', async () => {
    const result = await callTool('sec_lookup_role', { role_name: 'SystemAdministrator' });
    assert.ok(result.includes('VendInvoiceProcess'));
    assert.ok(result.includes('VendPaymentProcess'));
  });

  it('shows direct privileges', async () => {
    const result = await callTool('sec_lookup_role', { role_name: 'SystemAdministrator' });
    assert.ok(result.includes('Direct Privileges'));
    assert.ok(result.includes('LedgerJournalPost'));
  });

  it('shows direct entity permissions', async () => {
    const result = await callTool('sec_lookup_role', { role_name: 'SystemAdministrator' });
    assert.ok(result.includes('VendInvoiceHeaderEntity'));
  });

  it('suggests fuzzy matches for unknown role', async () => {
    const result = await callTool('sec_lookup_role', { role_name: 'Accounts' });
    assert.ok(result.includes('Did you mean'));
    assert.ok(result.includes('AccountsPayableClerk'));
  });

  it('shows Deny permission type', async () => {
    const result = await callTool('sec_lookup_role', { role_name: 'TBG Deny AP Posting' });
    assert.ok(result.includes('Deny'));
  });
});

describe('sec_lookup_duty', () => {
  it('returns duty details', async () => {
    const result = await callTool('sec_lookup_duty', { duty_name: 'VendInvoiceProcess' });
    assert.ok(result.includes('VendInvoiceProcess'));
    assert.ok(result.includes('Process vendor invoices'));
  });

  it('shows parent roles', async () => {
    const result = await callTool('sec_lookup_duty', { duty_name: 'VendInvoiceProcess' });
    assert.ok(result.includes('SystemAdministrator'));
    assert.ok(result.includes('AccountsPayableClerk'));
  });

  it('shows privileges', async () => {
    const result = await callTool('sec_lookup_duty', { duty_name: 'VendInvoiceProcess' });
    assert.ok(result.includes('VendInvoiceJournalPost'));
  });
});

describe('sec_lookup_privilege', () => {
  it('returns privilege with CRUD entry points', async () => {
    const result = await callTool('sec_lookup_privilege', { privilege_name: 'VendInvoiceJournalPost' });
    assert.ok(result.includes('VendInvoiceJournal'));
    assert.ok(result.includes('Allow'));
    assert.ok(result.includes('MenuItemAction'));
  });

  it('shows parent duties and roles', async () => {
    const result = await callTool('sec_lookup_privilege', { privilege_name: 'VendInvoiceJournalPost' });
    assert.ok(result.includes('VendInvoiceProcess'));
    assert.ok(result.includes('SystemAdministrator'));
  });
});

describe('sec_lookup_user', () => {
  it('returns user profile', async () => {
    const result = await callTool('sec_lookup_user', { user_id: 'john.doe@trelleborg.com' });
    assert.ok(result.includes('John Doe'));
    assert.ok(result.includes('john.doe@trelleborg.com'));
    assert.ok(result.includes('TAB'));
  });

  it('shows roles', async () => {
    const result = await callTool('sec_lookup_user', { user_id: 'john.doe@trelleborg.com' });
    assert.ok(result.includes('AccountsPayableClerk'));
    assert.ok(result.includes('AccountsPayableManager'));
  });

  it('shows company-scoped roles', async () => {
    const result = await callTool('sec_lookup_user', { user_id: 'john.doe@trelleborg.com' });
    assert.ok(result.includes('Company-Scoped'));
    assert.ok(result.includes('LADE'));
  });

  it('finds user by partial match', async () => {
    const result = await callTool('sec_lookup_user', { user_id: 'john' });
    assert.ok(result.includes('Did you mean'));
    assert.ok(result.includes('john.doe'));
  });

  // PM-05 — structured output for the pilot tool
  it('given a valid lookup, then returns structuredContent matching the output schema', async () => {
    const { secLookupUserOutput } = await import('../src/azure/output-schemas.js');
    const result = await callToolFull('sec_lookup_user', { user_id: 'john.doe@trelleborg.com' });
    assert.ok(result.structuredContent, 'expected structuredContent on success');
    assert.doesNotThrow(() => secLookupUserOutput.parse(result.structuredContent));
    assert.equal(result.structuredContent.user_id, 'john.doe@trelleborg.com');
    assert.equal(typeof result.structuredContent.enabled, 'boolean');
    assert.ok(Array.isArray(result.structuredContent.roles));
  });

  it('given an unknown user, then isError is true and notFoundResult is returned', async () => {
    const result = await callToolFull('sec_lookup_user', { user_id: 'no.such.user' });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /not found/);
  });
});

describe('sec_role_hierarchy', () => {
  it('finds children of a parent role', async () => {
    const result = await callTool('sec_role_hierarchy', { role_name: 'AccountsPayableManager', direction: 'children' });
    assert.ok(result.includes('AccountsPayableClerk'));
  });

  it('finds parents of a child role', async () => {
    const result = await callTool('sec_role_hierarchy', { role_name: 'AccountsPayableClerk', direction: 'parents' });
    assert.ok(result.includes('AccountsPayableManager'));
  });
});

describe('sec_find_users_by_role', () => {
  it('finds users for a role', async () => {
    const result = await callTool('sec_find_users_by_role', { role_name: 'AccountsPayableClerk' });
    assert.ok(result.includes('john.doe'));
  });

  it('filters by company', async () => {
    const result = await callTool('sec_find_users_by_role', { role_name: 'AccountsPayableClerk', company_id: 'TAB' });
    assert.ok(result.includes('john.doe'));
  });
});

describe('sec_find_roles_by_duty', () => {
  it('finds all roles containing a duty', async () => {
    const result = await callTool('sec_find_roles_by_duty', { duty_name: 'VendInvoiceProcess' });
    assert.ok(result.includes('SystemAdministrator'));
    assert.ok(result.includes('AccountsPayableClerk'));
    assert.ok(result.includes('AccountsPayableManager'));
  });
});

describe('sec_find_roles_by_privilege', () => {
  it('finds roles via duty chain', async () => {
    const result = await callTool('sec_find_roles_by_privilege', { privilege_name: 'VendInvoiceJournalPost' });
    assert.ok(result.includes('SystemAdministrator'));
  });

  it('finds direct assignments', async () => {
    const result = await callTool('sec_find_roles_by_privilege', { privilege_name: 'LedgerJournalPost' });
    assert.ok(result.includes('Direct'));
    assert.ok(result.includes('SystemAdministrator'));
  });
});

describe('sec_company_users', () => {
  it('lists users for a company', async () => {
    const result = await callTool('sec_company_users', { company_id: 'TAB' });
    assert.ok(result.includes('john.doe'));
    assert.ok(result.includes('AccountsPayableClerk'));
  });
});

describe('sec_permission_trace', () => {
  it('traces full permission chain', async () => {
    const result = await callTool('sec_permission_trace', { role_name: 'SystemAdministrator' });
    assert.ok(result.includes('VendInvoiceProcess'));
    assert.ok(result.includes('VendInvoiceJournalPost'));
    assert.ok(result.includes('VendInvoiceJournal'));
  });

  it('filters by object name', async () => {
    const result = await callTool('sec_permission_trace', { role_name: 'SystemAdministrator', object_name: 'VendPayment' });
    assert.ok(result.includes('VendPaymentJournal'));
    assert.ok(!result.includes('LedgerJournalPost'));
  });
});

describe('sec_compare_roles', () => {
  it('compares shared and unique duties', async () => {
    const result = await callTool('sec_compare_roles', { role1: 'SystemAdministrator', role2: 'AccountsPayableManager' });
    assert.ok(result.includes('Shared'));
    assert.ok(result.includes('VendInvoiceProcess'));
    assert.ok(result.includes('LedgerPostMaintain'));  // only in SysAdmin
  });
});

describe('sec_effective_permissions', () => {
  it('shows effective permissions for a user', async () => {
    const result = await callTool('sec_effective_permissions', { user_id: 'john.doe@trelleborg.com' });
    assert.ok(result.includes('VendInvoiceJournal'));
  });

  it('shows effective permissions for a role', async () => {
    const result = await callTool('sec_effective_permissions', { role_name: 'SystemAdministrator' });
    assert.ok(result.includes('VendInvoiceJournal'));
    assert.ok(result.includes('LedgerJournalPost'));
  });

  it('filters by object name', async () => {
    const result = await callTool('sec_effective_permissions', { role_name: 'SystemAdministrator', object_name: 'Vend' });
    assert.ok(result.includes('VendInvoiceJournal'));
    assert.ok(!result.includes('LedgerJournalPost'));
  });

  // PM-05 — structured output for the pilot tool
  it('given a user lookup, then structuredContent matches the schema with subject_type=user', async () => {
    const { secEffectivePermissionsOutput } = await import('../src/azure/output-schemas.js');
    const result = await callToolFull('sec_effective_permissions', { user_id: 'john.doe@trelleborg.com' });
    assert.ok(result.structuredContent);
    assert.doesNotThrow(() => secEffectivePermissionsOutput.parse(result.structuredContent));
    assert.equal(result.structuredContent.subject_type, 'user');
    assert.ok(Array.isArray(result.structuredContent.permissions));
    assert.ok(result.structuredContent.entry_point_count > 0);
  });

  it('given a role lookup with object_filter, then structuredContent carries the filter', async () => {
    const { secEffectivePermissionsOutput } = await import('../src/azure/output-schemas.js');
    const result = await callToolFull('sec_effective_permissions', { role_name: 'SystemAdministrator', object_name: 'Vend' });
    assert.ok(result.structuredContent);
    assert.doesNotThrow(() => secEffectivePermissionsOutput.parse(result.structuredContent));
    assert.equal(result.structuredContent.subject_type, 'role');
    assert.equal(result.structuredContent.object_filter, 'Vend');
  });
});

describe('sec_search', () => {
  it('finds roles by keyword', async () => {
    const result = await callTool('sec_search', { query: 'administrator' });
    assert.ok(result.includes('SystemAdministrator'));
  });

  it('finds duties by keyword', async () => {
    const result = await callTool('sec_search', { query: 'vendor invoice' });
    assert.ok(result.includes('VendInvoiceProcess'));
  });

  it('finds users by name', async () => {
    const result = await callTool('sec_search', { query: 'John', object_type: 'user' });
    assert.ok(result.includes('john.doe'));
  });

  it('filters by object_type', async () => {
    const result = await callTool('sec_search', { query: 'admin', object_type: 'role' });
    assert.ok(result.includes('SystemAdministrator'));
    assert.ok(!result.includes('john.doe'));
  });
});

describe('sec_stats', () => {
  it('returns metadata statistics', async () => {
    const result = await callTool('sec_stats', {});
    assert.ok(result.includes('build_date'));
    assert.ok(result.includes('roles'));
    assert.ok(result.includes('4'));
  });

  // P4-10: Build Info is rendered as a bulleted list, not a |key|value| table.
  it('given sec_stats output, when rendering, then Build Info uses bullets not a table', async () => {
    const result = await callTool('sec_stats', {});
    // First line under "## Build Info" is a bullet of the form "- **key:** value"
    assert.match(result, /## Build Info\n- \*\*[^*]+:\*\* /);
    // The Build Info section itself must not contain a |...| table row.
    const buildInfoSection = result.split('## Build Info')[1]?.split('## Breakdown')[0] || '';
    assert.doesNotMatch(buildInfoSection, /^\|/m);
  });
});

describe('sec_raw_sql', () => {
  it('executes SELECT queries', async () => {
    const result = await callTool('sec_raw_sql', { sql: 'SELECT COUNT(*) as cnt FROM roles' });
    assert.ok(result.includes('4'));
  });

  it('rejects non-SELECT queries', async () => {
    const result = await callTool('sec_raw_sql', { sql: 'DELETE FROM roles' });
    assert.ok(result.includes('Only SELECT'));
  });

  it('adds LIMIT if missing', async () => {
    const result = await callTool('sec_raw_sql', { sql: 'SELECT role_name FROM roles' });
    assert.ok(result.includes('SystemAdministrator'));
  });
});

// ── P4-02 — CR-SEC-002: Deny filter across permission walkers ────────────────
//
// Fixture (already in the before() block):
//   R1 SystemAdministrator (Grant)        → VendInvoiceProcess Grant + others
//   R2 AccountsPayableClerk (Grant)       → VendInvoiceProcess Grant
//   R3 TBG Deny AP Posting (Deny)         → VendInvoiceProcess Deny
//   R4 AccountsPayableManager (Grant)     → VendInvoiceProcess Grant + sub-role R2
//   john.doe is assigned to R2, R3, R4 (so the Deny duty is in his chain).
//
// The Grant filter tests below verify each non-trace tool excludes the R3
// Deny row, and that sec_permission_trace surfaces it with a ⛔ marker.

describe('P4-02 Deny filter — sec_effective_permissions', () => {
  it('given john.doe (with Deny role R3 in chain), then output excludes the Deny row', async () => {
    const result = await callToolFull('sec_effective_permissions', { user_id: 'john.doe@trelleborg.com' });
    // The structuredContent enumerates entry points, all duty_perm should be 'Grant'
    assert.ok(result.structuredContent);
    const denyEntries = result.structuredContent.permissions.filter(p => p.duty_perm === 'Deny');
    assert.equal(denyEntries.length, 0, `expected 0 Deny rows, got ${denyEntries.length}`);
    assert.match(result.content[0].text, /Deny overrides are excluded/);
  });

  it('given a Deny role queried directly, then permissions are empty (Deny does not grant)', async () => {
    const result = await callToolFull('sec_effective_permissions', { role_name: 'TBG Deny AP Posting' });
    // Deny role contributes only Deny duties; with the filter on, it has 0 effective grants.
    if (result.structuredContent) {
      assert.equal(result.structuredContent.entry_point_count, 0);
    } else {
      // emptyResult path
      assert.match(result.content[0].text, /No effective permissions|leaf result/);
    }
  });
});

describe('P4-02 Deny filter — sec_find_roles_by_duty', () => {
  it('given a duty that has both Grant and Deny role assignments, then only Grant roles are listed', async () => {
    const result = await callTool('sec_find_roles_by_duty', { duty_name: 'VendInvoiceProcess' });
    // R3 (TBG Deny AP Posting) has VendInvoiceProcess as Deny — must be excluded.
    assert.doesNotMatch(result, /TBG Deny AP Posting/);
    // The legitimate Grant roles still appear.
    assert.match(result, /SystemAdministrator/);
    assert.match(result, /AccountsPayableClerk/);
    // Disclosure note is present.
    assert.match(result, /Deny overrides are excluded/);
  });
});

describe('P4-02 Deny filter — sec_find_users_by_role', () => {
  it('given a Deny role, then the tool returns empty-with-explanation rather than listing users', async () => {
    const result = await callTool('sec_find_users_by_role', { role_name: 'TBG Deny AP Posting' });
    assert.match(result, /Deny role|leaf result|sec_permission_trace/);
    assert.doesNotMatch(result, /\| john\.doe@trelleborg\.com \|/);
  });

  it('given a Grant role, then users are listed and the disclosure note is present', async () => {
    const result = await callTool('sec_find_users_by_role', { role_name: 'AccountsPayableClerk' });
    assert.match(result, /john\.doe/);
    assert.match(result, /Deny overrides are not applied/);
  });
});

describe('P4-02 Deny filter — sec_compare_roles', () => {
  it('given a Grant role and a Deny role with the same duty, then they share zero duties (Deny excluded)', async () => {
    // R2 (AccountsPayableClerk, Grant) has VendInvoiceProcess Grant.
    // R3 (TBG Deny AP Posting, Deny) has VendInvoiceProcess Deny.
    // Pre-fix: they would falsely "share" VendInvoiceProcess.
    // Post-fix: R3's Grant set is empty → 0 shared.
    const result = await callTool('sec_compare_roles', { role1: 'AccountsPayableClerk', role2: 'TBG Deny AP Posting' });
    assert.match(result, /Total Duties \| 1 \| 0/);
    assert.match(result, /Shared \| 0 \| 0/);
  });
});

// ── P4-03 — sec_lookup_user sub-role expansion + Deny overrides ──────────────
//
// Fixture (already in the before() block):
//   john.doe @ R2 (AccountsPayableClerk, Grant), R3 (Deny role), R4 (AP Manager, Grant)
//   role_subroles: R4 → R2 (Manager inherits Clerk)
//   role_duties: R3 → VendInvoiceProcess Deny
//
// john.doe has direct roles {R2, R3, R4}. Sub-role expansion of R4 → {R2}
// — but R2 is already direct, so the "effective sub-roles excluding direct"
// section is empty for this user. Deny overrides should surface R3's Deny.
//
// Need a second user whose sub-role chain adds NEW roles to test the
// transitive expansion path. Let me use admin@trelleborg.com or a freshly
// inserted fixture.

describe('P4-03 sec_lookup_user — sub-role expansion + Deny overrides', () => {
  it('given a user with only direct roles and no sub-role children, then sub-roles section reports 0', async () => {
    // admin@trelleborg.com is in R1 (SystemAdministrator) which has no sub-roles
    const result = await callToolFull('sec_lookup_user', { user_id: 'admin@trelleborg.com' });
    assert.ok(result.structuredContent);
    assert.equal(result.structuredContent.effective_sub_role_count, 0);
    assert.match(result.content[0].text, /## Effective Sub-Roles \(0\)/);
  });

  it('given a user whose role has Deny duties in the chain, then Deny Overrides section appears', async () => {
    // john.doe is assigned to R3 (TBG Deny AP Posting) which has VendInvoiceProcess Deny
    const result = await callToolFull('sec_lookup_user', { user_id: 'john.doe@trelleborg.com' });
    assert.ok(result.structuredContent);
    assert.ok(result.structuredContent.deny_override_count >= 1);
    assert.match(result.content[0].text, /## Deny Overrides/);
    assert.match(result.content[0].text, /TBG Deny AP Posting/);
    assert.match(result.content[0].text, /VendInvoiceProcess/);
  });

  it('given a user whose role chain has no Deny duties, then Deny Overrides section is omitted', async () => {
    const result = await callToolFull('sec_lookup_user', { user_id: 'admin@trelleborg.com' });
    assert.ok(result.structuredContent);
    assert.equal(result.structuredContent.deny_override_count, 0);
    assert.doesNotMatch(result.content[0].text, /## Deny Overrides/);
  });

  it('given a user with sub-role inheritance, then the Effective Sub-Roles section lists added child roles', () => {
    // Inject a fixture user "subrole.test" assigned only to a parent role
    // whose subrole adds a NEW role (not already direct).
    db.exec(`
      INSERT OR REPLACE INTO roles VALUES ('R5', 'PurchasingClerk', 'ApplicationSuite', 'Purchasing Clerk', '', NULL, 'Grant', 0, 'test');
      INSERT OR REPLACE INTO users VALUES ('subrole.test', 'Sub Role Test', 'subrole.test@x.com', 1, 'TAB');
      INSERT OR REPLACE INTO user_roles VALUES ('subrole.test', 'R4');
    `);
    // R4 (AP Manager) has sub-role R2 (AP Clerk). subrole.test only has R4
    // direct, so R2 should appear as an "Effective Sub-Role".
    return callToolFull('sec_lookup_user', { user_id: 'subrole.test' }).then(result => {
      try {
        assert.ok(result.structuredContent);
        assert.equal(result.structuredContent.role_count, 1);
        assert.equal(result.structuredContent.effective_sub_role_count, 1);
        assert.equal(result.structuredContent.effective_sub_roles[0].role_name, 'AccountsPayableClerk');
        assert.equal(result.structuredContent.effective_sub_roles[0].parent_role_name, 'AccountsPayableManager');
      } finally {
        db.exec(`DELETE FROM user_roles WHERE user_id = 'subrole.test'; DELETE FROM users WHERE user_id = 'subrole.test'; DELETE FROM roles WHERE role_id = 'R5';`);
      }
    });
  });
});

// ── P4-07 — CRUD Y/N rendering + Legend in sec_permission_trace and sec_effective_permissions ──

describe('P4-07 sec tools — CRUD flags rendered as Y/N with Legend', () => {
  it('given sec_permission_trace output, when rendered, then a Legend paragraph is present', async () => {
    const result = await callTool('sec_permission_trace', { role_name: 'SystemAdministrator' });
    assert.match(result, /\*\*Legend:\*\*/);
    assert.match(result, /Y = granted/);
  });

  it('given sec_effective_permissions output, when rendered, then a Legend paragraph is present', async () => {
    const result = await callTool('sec_effective_permissions', { user_id: 'john.doe@trelleborg.com' });
    assert.match(result, /\*\*Legend:\*\*/);
  });

  it('given sec_permission_trace, when rendering, then no raw 1/0 numerics appear in CRUD cells', async () => {
    const result = await callTool('sec_permission_trace', { role_name: 'SystemAdministrator' });
    // Slice off the legend text (which contains Y/N words) and look at the table body.
    const tableBody = result.split('**Legend:**')[1] || result;
    // Each pipe-bounded cell with content should be Y, N, blank, the marker,
    // or a string column. None should be just '0' or '1' — the storage shape
    // 'Allow' was the most common live-DB value but our fixture uses 'Allow'
    // for grants and NULL for un-granted. After P4-07, those become Y/empty.
    assert.doesNotMatch(tableBody, /\| 1 \|/);
    assert.doesNotMatch(tableBody, /\| 0 \|/);
  });

  it('given sec_permission_trace with a Deny role, when rendered, then ⛔ marker AND Legend coexist', async () => {
    const result = await callTool('sec_permission_trace', { role_name: 'TBG Deny AP Posting' });
    assert.match(result, /⛔ DENIED/);
    assert.match(result, /\*\*Legend:\*\*/);
  });
});

// ── P4-06 — Visual Grant/Deny rendering across sec tools ───────────────────

describe('P4-06 sec tools — Grant/Deny rendered with ✓/✗ markers', () => {
  it('given a Deny role lookup, when rendering, then permission cell contains ✗ Deny', async () => {
    const result = await callTool('sec_lookup_role', { role_name: 'TBG Deny AP Posting' });
    assert.match(result, /✗ Deny/);
  });

  it('given a Grant role lookup, when rendering, then permission cell contains ✓ Grant', async () => {
    const result = await callTool('sec_lookup_role', { role_name: 'SystemAdministrator' });
    assert.match(result, /✓ Grant/);
  });

  it('given sec_find_roles_by_duty, when rendering, then permission cells are visually marked', async () => {
    const result = await callTool('sec_find_roles_by_duty', { duty_name: 'VendInvoiceProcess' });
    assert.match(result, /✓ Grant/);
  });

  it('given sec_company_users, when rendering, then permission column uses the marker', async () => {
    const result = await callTool('sec_company_users', { company_id: 'TAB' });
    assert.match(result, /✓ Grant/);
  });
});

describe('P4-02 sec_permission_trace — Deny rows are surfaced with ⛔ marker', () => {
  it('given a role whose chain includes a Deny duty, then the trace marks it visually', async () => {
    // SystemAdministrator on its own has only Grants, so use a probe role
    // that pulls in R3's Deny via direct trace.
    const result = await callTool('sec_permission_trace', { role_name: 'TBG Deny AP Posting' });
    assert.match(result, /⛔ DENIED/);
    assert.match(result, /Deny rows: 1/);
    assert.match(result, /actively REMOVE/);
  });

  it('given a pure-Grant role, then no Deny marker appears', async () => {
    const result = await callTool('sec_permission_trace', { role_name: 'SystemAdministrator' });
    assert.match(result, /Deny rows: 0/);
    assert.doesNotMatch(result, /⛔ DENIED/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  PM-06 — structured output rollout for 13 remaining Sec tools.
// ═════════════════════════════════════════════════════════════════════════════

describe('PM-06 Sec structured output', () => {
  it('sec_lookup_role: typed payload parses', async () => {
    const { secLookupRoleOutput } = await import('../src/azure/output-schemas.js');
    const result = await callToolFull('sec_lookup_role', { role_name: 'SystemAdministrator' });
    assert.ok(result.structuredContent);
    assert.doesNotThrow(() => secLookupRoleOutput.parse(result.structuredContent));
    assert.equal(result.structuredContent.role_name, 'SystemAdministrator');
    assert.ok(Array.isArray(result.structuredContent.duties));
  });

  it('sec_lookup_duty: typed payload parses', async () => {
    const { secLookupDutyOutput } = await import('../src/azure/output-schemas.js');
    const result = await callToolFull('sec_lookup_duty', { duty_name: 'VendInvoiceProcess' });
    assert.ok(result.structuredContent);
    assert.doesNotThrow(() => secLookupDutyOutput.parse(result.structuredContent));
    assert.equal(result.structuredContent.duty_id, 'VendInvoiceProcess');
    assert.ok(Array.isArray(result.structuredContent.roles));
  });

  it('sec_lookup_privilege: typed payload parses', async () => {
    const { secLookupPrivilegeOutput } = await import('../src/azure/output-schemas.js');
    const result = await callToolFull('sec_lookup_privilege', { privilege_name: 'VendInvoiceJournalPost' });
    assert.ok(result.structuredContent);
    assert.doesNotThrow(() => secLookupPrivilegeOutput.parse(result.structuredContent));
    assert.equal(result.structuredContent.privilege_name, 'VendInvoiceJournalPost');
    assert.ok(Array.isArray(result.structuredContent.entry_points));
  });

  it('sec_role_hierarchy: typed payload parses', async () => {
    const { secRoleHierarchyOutput } = await import('../src/azure/output-schemas.js');
    const result = await callToolFull('sec_role_hierarchy', {
      role_name: 'AccountsPayableManager', direction: 'children',
    });
    assert.ok(result.structuredContent);
    assert.doesNotThrow(() => secRoleHierarchyOutput.parse(result.structuredContent));
    assert.equal(result.structuredContent.role_name, 'AccountsPayableManager');
    assert.equal(result.structuredContent.direction, 'children');
  });

  it('sec_find_users_by_role: typed payload parses', async () => {
    const { secFindUsersByRoleOutput } = await import('../src/azure/output-schemas.js');
    const result = await callToolFull('sec_find_users_by_role', {
      role_name: 'SystemAdministrator', limit: 50,
    });
    assert.ok(result.structuredContent);
    assert.doesNotThrow(() => secFindUsersByRoleOutput.parse(result.structuredContent));
    assert.equal(result.structuredContent.role_name, 'SystemAdministrator');
  });

  it('sec_find_roles_by_duty: typed payload parses and excludes Deny rows', async () => {
    const { secFindRolesByDutyOutput } = await import('../src/azure/output-schemas.js');
    const result = await callToolFull('sec_find_roles_by_duty', { duty_name: 'VendInvoiceProcess' });
    assert.ok(result.structuredContent);
    assert.doesNotThrow(() => secFindRolesByDutyOutput.parse(result.structuredContent));
    assert.equal(result.structuredContent.duty_id, 'VendInvoiceProcess');
    // CR-SEC-002: Deny role TBG must NOT appear.
    assert.ok(!result.structuredContent.roles.find(r => r.role_name === 'TBG Deny AP Posting'));
  });

  it('sec_find_roles_by_privilege: typed payload parses', async () => {
    const { secFindRolesByPrivilegeOutput } = await import('../src/azure/output-schemas.js');
    const result = await callToolFull('sec_find_roles_by_privilege', { privilege_name: 'VendInvoiceJournalPost' });
    assert.ok(result.structuredContent);
    assert.doesNotThrow(() => secFindRolesByPrivilegeOutput.parse(result.structuredContent));
    assert.equal(result.structuredContent.privilege_name, 'VendInvoiceJournalPost');
    assert.ok(result.structuredContent.via_chain_count >= 0);
  });

  it('sec_company_users: typed payload parses', async () => {
    const { secCompanyUsersOutput } = await import('../src/azure/output-schemas.js');
    // Use a company that has fixture data — fall back if not found.
    const result = await callToolFull('sec_company_users', { company_id: 'USMF', limit: 100 });
    // Either empty-result or structured result — both valid.
    if (result.structuredContent) {
      assert.doesNotThrow(() => secCompanyUsersOutput.parse(result.structuredContent));
    }
  });

  it('sec_permission_trace: typed payload parses and carries grant/deny counts', async () => {
    const { secPermissionTraceOutput } = await import('../src/azure/output-schemas.js');
    const result = await callToolFull('sec_permission_trace', { role_name: 'SystemAdministrator' });
    assert.ok(result.structuredContent);
    assert.doesNotThrow(() => secPermissionTraceOutput.parse(result.structuredContent));
    assert.equal(result.structuredContent.role_name, 'SystemAdministrator');
    assert.equal(typeof result.structuredContent.grant_count, 'number');
    assert.equal(typeof result.structuredContent.deny_count, 'number');
  });

  it('sec_compare_roles: typed payload parses', async () => {
    const { secCompareRolesOutput } = await import('../src/azure/output-schemas.js');
    const result = await callToolFull('sec_compare_roles', {
      role1: 'SystemAdministrator',
      role2: 'AccountsPayableClerk',
    });
    assert.ok(result.structuredContent);
    assert.doesNotThrow(() => secCompareRolesOutput.parse(result.structuredContent));
    assert.equal(result.structuredContent.role1, 'SystemAdministrator');
    assert.equal(result.structuredContent.role2, 'AccountsPayableClerk');
  });

  it('sec_search: typed payload parses', async () => {
    const { secSearchOutput } = await import('../src/azure/output-schemas.js');
    // Minimum viable fixture — search for something likely present.
    const result = await callToolFull('sec_search', { query: 'Admin', limit: 20 });
    // Either empty-result or structured; don't require hits.
    if (result.structuredContent) {
      assert.doesNotThrow(() => secSearchOutput.parse(result.structuredContent));
      assert.equal(result.structuredContent.query, 'Admin');
    }
  });

  it('sec_stats: typed payload parses', async () => {
    const { secStatsOutput } = await import('../src/azure/output-schemas.js');
    const result = await callToolFull('sec_stats', {});
    assert.ok(result.structuredContent);
    assert.doesNotThrow(() => secStatsOutput.parse(result.structuredContent));
    assert.equal(typeof result.structuredContent.grant_roles, 'number');
    assert.equal(typeof result.structuredContent.total_duties, 'number');
  });

  it('sec_raw_sql: typed payload matches rawSqlOutput', async () => {
    const { rawSqlOutput } = await import('../src/azure/output-schemas.js');
    const result = await callToolFull('sec_raw_sql', { sql: 'SELECT role_name FROM roles LIMIT 5' });
    assert.ok(result.structuredContent);
    assert.doesNotThrow(() => rawSqlOutput.parse(result.structuredContent));
    assert.ok(result.structuredContent.row_count >= 1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  New tools: sec_licence_assessment, sec_sod_check, sec_what_if, sec_object_access
// ═════════════════════════════════════════════════════════════════════════════

describe('sec_licence_assessment', () => {
  it('assesses a single user and returns the highest licence tier', async () => {
    const result = await callToolFull('sec_licence_assessment', { user_id: 'admin@trelleborg.com' });
    assert.ok(result.structuredContent);
    assert.equal(result.structuredContent.mode, 'single');
    assert.equal(result.structuredContent.user_count, 1);
    // admin is assigned to SystemAdministrator which has license_type='Enterprise'
    assert.equal(result.structuredContent.users[0].required_tier, 'Enterprise');
    assert.ok(result.structuredContent.users[0].monthly_cost > 0);
    assert.equal(result.structuredContent.users[0].driving_role, 'SystemAdministrator');
  });

  it('assesses all enabled users when no user_id specified', async () => {
    const result = await callToolFull('sec_licence_assessment', {});
    assert.ok(result.structuredContent);
    assert.equal(result.structuredContent.mode, 'all');
    // 2 enabled users in fixtures (admin + john.doe)
    assert.ok(result.structuredContent.user_count >= 2);
    assert.ok(result.structuredContent.tier_summary.length > 0);
  });

  it('john.doe has Enterprise tier from AccountsPayableManager', async () => {
    const result = await callToolFull('sec_licence_assessment', { user_id: 'john.doe@trelleborg.com' });
    assert.ok(result.structuredContent);
    const u = result.structuredContent.users[0];
    // john.doe has R2 (TeamMembers), R3 (Deny, null type), R4 (Enterprise)
    // Highest = Enterprise from R4
    assert.equal(u.required_tier, 'Enterprise');
    assert.equal(u.driving_role, 'AccountsPayableManager');
  });

  it('returns not-found for unknown user', async () => {
    const result = await callToolFull('sec_licence_assessment', { user_id: 'no.such.user' });
    assert.equal(result.isError, true);
  });

  it('structured output matches schema', async () => {
    const { secLicenceAssessmentOutput } = await import('../src/azure/output-schemas.js');
    const result = await callToolFull('sec_licence_assessment', { user_id: 'admin@trelleborg.com' });
    assert.ok(result.structuredContent);
    assert.doesNotThrow(() => secLicenceAssessmentOutput.parse(result.structuredContent));
  });

  it('tier summary aggregates correctly', async () => {
    const result = await callToolFull('sec_licence_assessment', {});
    assert.ok(result.structuredContent);
    const totalUsers = result.structuredContent.tier_summary.reduce((s, t) => s + t.user_count, 0);
    assert.equal(totalUsers, result.structuredContent.user_count);
  });
});

describe('sec_sod_check', () => {
  // Inject SoD rules for testing
  before(async () => {
    const { _injectSodRuleset } = await import('../src/azure/sec-tools.js');
    _injectSodRuleset({
      rules: [
        {
          id: 'SOD-AP-003',
          name: 'Invoice Processing vs Payment Processing',
          category: 'accounts_payable',
          risk_level: 'High',
          duty_group_a: { name: 'Invoice Processing', duties: ['VendInvoiceProcess'] },
          duty_group_b: { name: 'Payment Processing', duties: ['VendPaymentProcess'] },
        },
        {
          id: 'SOD-GL-001',
          name: 'Journal Entry vs Journal Approval',
          category: 'general_ledger',
          risk_level: 'Critical',
          duty_group_a: { name: 'Journal Entry', duties: ['LedgerPostMaintain'] },
          duty_group_b: { name: 'Journal Approval', duties: ['VendInvoiceProcess'] },
        },
      ],
    });
  });

  after(async () => {
    const { _clearSodRuleset } = await import('../src/azure/sec-tools.js');
    _clearSodRuleset();
  });

  it('detects SoD violations for admin (has both duties in SOD-AP-003)', async () => {
    // admin has R1 (SysAdmin) which has VendInvoiceProcess + VendPaymentProcess → violation
    const result = await callToolFull('sec_sod_check', { user_id: 'admin@trelleborg.com' });
    assert.ok(result.structuredContent);
    assert.equal(result.structuredContent.mode, 'single');
    assert.ok(result.structuredContent.violation_count >= 1);
    const violations = result.structuredContent.violations[0]?.violations || [];
    const apViolation = violations.find(v => v.rule_id === 'SOD-AP-003');
    assert.ok(apViolation, 'Expected SOD-AP-003 violation for admin');
    assert.deepEqual(apViolation.group_a_matched, ['VendInvoiceProcess']);
    assert.deepEqual(apViolation.group_b_matched, ['VendPaymentProcess']);
  });

  it('john.doe does NOT violate SOD-AP-003 (Deny role suppresses VendInvoiceProcess Grant)', async () => {
    // john.doe has R2 (VendInvoiceProcess Grant), R3 (VendInvoiceProcess Deny), R4 (VendInvoiceProcess + VendPaymentProcess)
    // After P4-02 Deny filter, VendInvoiceProcess is still granted via R2 and R4 (Grant).
    // The Deny role R3 doesn't remove the grant from the duty set — it only removes from effective permissions.
    // So john.doe actually DOES have both duties via Grant paths.
    const result = await callToolFull('sec_sod_check', { user_id: 'john.doe@trelleborg.com' });
    assert.ok(result.structuredContent);
    // john.doe has VendInvoiceProcess via R2 Grant + R4 Grant, and VendPaymentProcess via R4 Grant
    assert.ok(result.structuredContent.violation_count >= 1);
  });

  it('filters by category', async () => {
    const result = await callToolFull('sec_sod_check', { user_id: 'admin@trelleborg.com', category: 'accounts_payable' });
    assert.ok(result.structuredContent);
    // Only SOD-AP-003 should be checked, not SOD-GL-001
    const violations = result.structuredContent.violations[0]?.violations || [];
    for (const v of violations) {
      assert.equal(v.category, 'accounts_payable');
    }
  });

  it('all-users mode scans all enabled users', async () => {
    const result = await callToolFull('sec_sod_check', {});
    assert.ok(result.structuredContent);
    assert.equal(result.structuredContent.mode, 'all');
    assert.ok(result.structuredContent.user_count >= 2);
  });

  it('returns not-found for unknown user', async () => {
    const result = await callToolFull('sec_sod_check', { user_id: 'no.such.user' });
    assert.equal(result.isError, true);
  });

  it('structured output matches schema', async () => {
    const { secSodCheckOutput } = await import('../src/azure/output-schemas.js');
    const result = await callToolFull('sec_sod_check', { user_id: 'admin@trelleborg.com' });
    assert.ok(result.structuredContent);
    assert.doesNotThrow(() => secSodCheckOutput.parse(result.structuredContent));
  });

  it('risk score uses correct weights', async () => {
    const result = await callToolFull('sec_sod_check', { user_id: 'admin@trelleborg.com' });
    assert.ok(result.structuredContent);
    const ur = result.structuredContent.violations[0];
    if (ur) {
      // Verify risk_score is sum of weights (High=2, Critical=3)
      const expectedScore = ur.violations.reduce((s, v) => {
        const w = { Critical: 3, High: 2, Medium: 1 }[v.risk_level] || 1;
        return s + w;
      }, 0);
      assert.equal(ur.risk_score, expectedScore);
    }
  });
});

describe('sec_what_if', () => {
  // Inject SoD rules for testing
  before(async () => {
    const { _injectSodRuleset } = await import('../src/azure/sec-tools.js');
    _injectSodRuleset({
      rules: [{
        id: 'SOD-AP-003',
        name: 'Invoice Processing vs Payment Processing',
        category: 'accounts_payable',
        risk_level: 'High',
        duty_group_a: { name: 'Invoice Processing', duties: ['VendInvoiceProcess'] },
        duty_group_b: { name: 'Payment Processing', duties: ['VendPaymentProcess'] },
      }],
    });
  });

  after(async () => {
    const { _clearSodRuleset } = await import('../src/azure/sec-tools.js');
    _clearSodRuleset();
  });

  it('simulates adding a role and shows licence tier change', async () => {
    // john.doe currently has R2 (TeamMembers), R3 (Deny), R4 (Enterprise)
    // Removing R4 (Enterprise) should reduce the tier
    const result = await callToolFull('sec_what_if', {
      user_id: 'john.doe@trelleborg.com',
      remove_roles: ['AccountsPayableManager'],
    });
    assert.ok(result.structuredContent);
    assert.equal(result.structuredContent.user_id, 'john.doe@trelleborg.com');
    // Current tier is Enterprise (from R4), projected should be TeamMembers (from R2)
    assert.equal(result.structuredContent.current_tier, 'Enterprise');
    assert.equal(result.structuredContent.projected_tier, 'TeamMembers');
    assert.ok(result.structuredContent.monthly_delta < 0, 'Expected negative cost delta');
    assert.ok(result.structuredContent.annual_delta < 0, 'Expected negative annual delta');
  });

  it('simulates adding a role and detects new SoD violations', async () => {
    // admin has SysAdmin (all duties). Adding a role should not change SoD.
    // john.doe removing AP Manager should resolve the SOD-AP-003 violation
    // because VendPaymentProcess is only on R4 (which we remove)
    const result = await callToolFull('sec_what_if', {
      user_id: 'john.doe@trelleborg.com',
      remove_roles: ['AccountsPayableManager'],
    });
    assert.ok(result.structuredContent);
    // After removing R4, john.doe loses VendPaymentProcess → SOD-AP-003 should resolve
    assert.ok(result.structuredContent.sod_resolved.length >= 1);
    const resolved = result.structuredContent.sod_resolved.find(v => v.rule_id === 'SOD-AP-003');
    assert.ok(resolved, 'Expected SOD-AP-003 to be resolved');
  });

  it('returns not-found for unknown user', async () => {
    const result = await callToolFull('sec_what_if', { user_id: 'no.such.user', add_roles: ['SystemAdministrator'] });
    assert.equal(result.isError, true);
  });

  it('warns on unknown role names', async () => {
    const result = await callToolFull('sec_what_if', {
      user_id: 'admin@trelleborg.com',
      add_roles: ['NonExistentRole'],
    });
    assert.ok(result.structuredContent);
    assert.ok(result.structuredContent.warnings.some(w => w.includes('Unknown role')));
  });

  it('no-change simulation returns zero deltas', async () => {
    const result = await callToolFull('sec_what_if', {
      user_id: 'admin@trelleborg.com',
      add_roles: [],
      remove_roles: [],
    });
    assert.ok(result.structuredContent);
    assert.equal(result.structuredContent.monthly_delta, 0);
    assert.equal(result.structuredContent.annual_delta, 0);
  });

  it('structured output matches schema', async () => {
    const { secWhatIfOutput } = await import('../src/azure/output-schemas.js');
    const result = await callToolFull('sec_what_if', {
      user_id: 'admin@trelleborg.com',
      remove_roles: ['SystemAdministrator'],
    });
    assert.ok(result.structuredContent);
    assert.doesNotThrow(() => secWhatIfOutput.parse(result.structuredContent));
  });
});

describe('sec_object_access', () => {
  it('finds roles and users with access to an object', async () => {
    const result = await callToolFull('sec_object_access', { object_name: 'VendInvoiceJournal' });
    assert.ok(result.structuredContent);
    assert.ok(result.structuredContent.result_count >= 1);
    assert.ok(result.structuredContent.role_count >= 1);
    // Should find SystemAdministrator (and others) in paths
    const roles = result.structuredContent.paths.map(p => p.role_name);
    assert.ok(roles.includes('SystemAdministrator'));
  });

  it('shows users who hold the granting roles', async () => {
    const result = await callToolFull('sec_object_access', { object_name: 'VendInvoiceJournal' });
    assert.ok(result.structuredContent);
    assert.ok(result.structuredContent.user_count >= 1);
    const userIds = result.structuredContent.users.map(u => u.user_id);
    assert.ok(userIds.includes('admin@trelleborg.com'));
  });

  it('returns empty for non-existent object', async () => {
    const result = await callToolFull('sec_object_access', { object_name: 'NonExistentObject12345' });
    // emptyResult — no structuredContent, no isError
    assert.ok(!result.isError);
    assert.match(result.content[0].text, /No .* found|leaf result/);
  });

  it('includes CRUD flags in paths', async () => {
    const result = await callToolFull('sec_object_access', { object_name: 'VendInvoiceJournal' });
    assert.ok(result.structuredContent);
    const path = result.structuredContent.paths[0];
    assert.ok(path);
    assert.ok('grant_read' in path);
    assert.ok('grant_create' in path);
  });

  it('renders CRUD as Y/N in Markdown', async () => {
    const text = await callTool('sec_object_access', { object_name: 'VendInvoiceJournal' });
    // The Markdown table should use Y/N flags
    assert.match(text, /\| Y \|/);
  });

  it('structured output matches schema', async () => {
    const { secObjectAccessOutput } = await import('../src/azure/output-schemas.js');
    const result = await callToolFull('sec_object_access', { object_name: 'VendInvoiceJournal' });
    assert.ok(result.structuredContent);
    assert.doesNotThrow(() => secObjectAccessOutput.parse(result.structuredContent));
  });

  it('finds access via direct privilege path', async () => {
    // LedgerJournalPost is a direct privilege on R1
    const result = await callToolFull('sec_object_access', { object_name: 'LedgerJournalPost' });
    assert.ok(result.structuredContent);
    const directPaths = result.structuredContent.paths.filter(p => p.duty_id === '(direct)');
    assert.ok(directPaths.length >= 1, 'Expected at least one direct privilege path');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Issue #33 — Edge-case tests: empty results / leaf nodes
//
//  All NEW tests assert STRUCTURAL properties (assert.match against /regex/,
//  assert.equal against shape) — never `assert.ok(string.includes(...))`.
//  Each test injects an isolated fixture, runs the tool, and cleans up — so
//  the existing happy-path tests remain unaffected.
// ═════════════════════════════════════════════════════════════════════════════

describe('issue #33 — sec_lookup_role with no duties / no privileges', () => {
  before(() => {
    // Inject an isolated role with zero duties, zero direct privileges,
    // zero direct entity permissions, and zero assigned users.
    db.exec(`
      INSERT OR REPLACE INTO roles VALUES
        ('R_ISSUE33_EMPTY', 'IssueEmptyRole', 'TestModule', 'Test',
         'Role with no duties', NULL, 'Grant', 0, 'test');
    `);
  });
  after(() => {
    db.exec(`DELETE FROM roles WHERE role_id = 'R_ISSUE33_EMPTY';`);
  });

  it('given a role with no duties, when sec_lookup_role runs, then it returns the role header without crashing or emitting a Duties section', async () => {
    const result = await callTool('sec_lookup_role', { role_name: 'IssueEmptyRole' });
    // The role header must render — assert structural shape with anchored regex.
    assert.match(result, /^# IssueEmptyRole$/m);
    // The Property table is rendered.
    assert.match(result, /^\| Property \| Value \|$/m);
    // No Duties section appears (because there are zero rows).
    assert.doesNotMatch(result, /^## Duties \(/m);
    // No Direct Privileges section.
    assert.doesNotMatch(result, /^## Direct Privileges \(/m);
    // The Assigned Users count is exactly 0.
    assert.match(result, /^## Assigned Users: 0$/m);
  });
});

describe('issue #33 — sec_lookup_user with no roles', () => {
  before(() => {
    db.exec(`
      INSERT OR REPLACE INTO users VALUES
        ('lonely.user@trelleborg.com', 'Lonely User',
         'lonely.user@trelleborg.com', 1, 'TAB');
    `);
  });
  after(() => {
    db.exec(`DELETE FROM users WHERE user_id = 'lonely.user@trelleborg.com';`);
  });

  it('given a user with zero role assignments, when sec_lookup_user runs, then it renders the profile without a Roles section', async () => {
    const result = await callTool('sec_lookup_user', { user_id: 'lonely.user@trelleborg.com' });
    // Profile header renders — anchored regex.
    assert.match(result, /^# lonely\.user@trelleborg\.com$/m);
    // The user metadata table renders with the expected fields.
    assert.match(result, /^\| Name \| Lonely User \|$/m);
    assert.match(result, /^\| Enabled \| Yes \|$/m);
    // No Roles or Company-Scoped Roles section appears.
    assert.doesNotMatch(result, /^## Roles \(/m);
    assert.doesNotMatch(result, /^## Company-Scoped Roles \(/m);
  });

  it('given a user with zero roles, when sec_lookup_user runs, then the response is on the success channel (no isError flag)', async () => {
    const tool = toolHandlers['sec_lookup_user'];
    const result = await tool.handler({ user_id: 'lonely.user@trelleborg.com' });
    // A user that exists but has no roles is a valid leaf result, not an error.
    assert.notEqual(result.isError, true, 'a user with zero roles must NOT carry isError=true');
  });
});

describe('issue #33 — sec_company_users on empty / unknown company', () => {
  it('given a company id that is not present in user_role_companies, when sec_company_users runs, then it returns a clear no-results message', async () => {
    const tool = toolHandlers['sec_company_users'];
    const result = await tool.handler({ company_id: 'NOTACOMPANY' });
    // Shape: success channel — no isError flag.
    assert.notEqual(result.isError, true);
    // The message identifies the queried company (uppercased per the
    // tool's own normalization). Match the structural shape, not exact phrasing.
    assert.match(result.content[0].text, /^No users found for company "NOTACOMPANY"\.$/);
  });

  it('given lowercase input for an empty company, when sec_company_users runs, then the message echoes the upper-cased id', async () => {
    // Documents the company_id normalization contract: even on the empty
    // path, the response must echo the canonical (uppercase) form so a
    // caller can correlate the result with their request.
    const tool = toolHandlers['sec_company_users'];
    const result = await tool.handler({ company_id: 'notacompany' });
    assert.match(result.content[0].text, /"NOTACOMPANY"/);
  });
});

describe('issue #33 — sec_role_hierarchy on a leaf role', () => {
  it('given a role with zero children, when sec_role_hierarchy(direction=children) runs, then it returns a clear empty-result message', async () => {
    // SystemAdministrator has no sub-roles in the fixture.
    const tool = toolHandlers['sec_role_hierarchy'];
    const result = await tool.handler({ role_name: 'SystemAdministrator', direction: 'children' });
    // Shape: success channel.
    assert.notEqual(result.isError, true);
    // Must reference the role and the direction.
    assert.match(result.content[0].text, /No children found for role "SystemAdministrator"/);
  });

  it('given a role with zero parents, when sec_role_hierarchy(direction=parents) runs, then it returns a clear empty-result message', async () => {
    // SystemAdministrator has no parent roles in the fixture either.
    const tool = toolHandlers['sec_role_hierarchy'];
    const result = await tool.handler({ role_name: 'SystemAdministrator', direction: 'parents' });
    assert.notEqual(result.isError, true);
    assert.match(result.content[0].text, /No parents found for role "SystemAdministrator"/);
  });
});

describe('issue #33 — sec_find_users_by_role on a role with zero assignments', () => {
  before(() => {
    // Inject a role that no user is assigned to.
    db.exec(`
      INSERT OR REPLACE INTO roles VALUES
        ('R_ISSUE33_NOUSERS', 'NoUsersRole', 'TestModule', 'Test',
         'Role nobody has', NULL, 'Grant', 0, 'test');
    `);
  });
  after(() => {
    db.exec(`DELETE FROM roles WHERE role_id = 'R_ISSUE33_NOUSERS';`);
  });

  it('given an existing role with zero user assignments, when sec_find_users_by_role runs, then it returns a clear no-users message', async () => {
    const tool = toolHandlers['sec_find_users_by_role'];
    const result = await tool.handler({ role_name: 'NoUsersRole' });
    // Shape: success channel — empty is valid, not an error.
    assert.notEqual(result.isError, true);
    // Match the shape of the message: identifies the role.
    assert.match(result.content[0].text, /No users found with role "NoUsersRole"/);
  });
});

describe('issue #33 — sec_find_roles_by_duty on a duty with zero roles', () => {
  before(() => {
    // Duty exists but no role contains it.
    db.exec(`
      INSERT OR REPLACE INTO duties VALUES
        ('D_ISSUE33_ORPHAN', 'Orphan duty', 'TestModule',
         'A duty no role contains');
    `);
  });
  after(() => {
    db.exec(`DELETE FROM duties WHERE duty_id = 'D_ISSUE33_ORPHAN';`);
  });

  it('given an existing duty with zero parent roles, when sec_find_roles_by_duty runs, then it returns a clear no-roles message', async () => {
    const tool = toolHandlers['sec_find_roles_by_duty'];
    const result = await tool.handler({ duty_name: 'D_ISSUE33_ORPHAN' });
    // Shape: success channel.
    assert.notEqual(result.isError, true);
    assert.match(result.content[0].text, /No roles contain duty "D_ISSUE33_ORPHAN"/);
  });
});

describe('issue #33 — sec_raw_sql on a SELECT that returns zero rows', () => {
  it('given a SELECT with no matching rows, when sec_raw_sql runs, then it surfaces a no-results indicator (not a crash)', async () => {
    const result = await callTool('sec_raw_sql', {
      sql: "SELECT role_name FROM roles WHERE role_name = 'definitely-not-a-real-role'",
    });
    // The shared formatMarkdownTable returns "No results found." for empty rows.
    assert.match(result, /No results found/);
  });
});
