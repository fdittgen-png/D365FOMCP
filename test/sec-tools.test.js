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
