# Design: D365 Security MCP Service (d365sec)

**Project**: tis-p-mcpd365fo
**Owner**: Trelleborg IT Services (TIS)
**Version**: 1.0 (Draft)
**Date**: 2026-03-25
**Author**: Florian Dittgen
**Status**: Design

---

## 1. Overview

A new MCP service (`d365sec`) exposing the full D365 Finance & Operations security configuration from the **production environment**. Covers the complete security hierarchy: users, roles, sub-roles, duties, privileges, entry points, and CRUD permissions.

**Explicitly out of scope**: Segregation of Duties (SoD) analysis, conflict matrices, violation detection.

### 1.1 Why a Separate Service (Not KB)

The KB database already stores security metadata from the AOT (123 roles, 1,065 duties, 6,403 privileges), but:

| Aspect | KB (current) | d365sec (proposed) |
|---|---|---|
| **Source** | AOT XML files from dev PackagesLocalDirectory | DMF exports from PROD + AOT XML |
| **Roles** | ~123 (only from installed dev packages) | ~382 (all roles in PROD, including ISV/custom) |
| **Users** | None | ~797 users with role assignments |
| **Company scoping** | None | Per-company role restrictions |
| **Sub-roles** | None | Full hierarchy, transitively flattened |
| **Direct permissions** | None | Direct privileges + direct entity CRUD (from SecurityDatabaseCustomizations) |
| **Grant/Deny** | None | Permission type per role and duty |
| **Schema** | JSON blobs (duties_json, privileges_json, entry_points_json) | Fully normalized, relational |

The KB's JSON-blob approach works for quick lookups but prevents efficient querying across the hierarchy (e.g., "which roles grant Delete on CustTable?"). The normalized schema enables these queries natively.

---

## 2. Data Sources

### 2.1 AOT Metadata (PackagesLocalDirectory) — Security Definitions

Already parsed by `build-kb.js`. Provides the **structure** of the security model:

| AOT Object | Provides |
|---|---|
| `AxSecurityRole` | Role definitions, role → duty references |
| `AxSecurityDuty` | Duty definitions, duty → privilege references |
| `AxSecurityPrivilege` | Privilege definitions, privilege → entry point references with CRUD grants |
| `AxSecurityEntryPointReference` | Entry point details: object type, object name, Read/Create/Update/Delete/Correct/Invoke |

### 2.2 DMF Exports (PROD Environment) — Runtime State

Exported from D365 F&O via Data Management Framework. Provides **who has what** in production:

| DMF File | Entity | Provides | Records (approx.) |
|---|---|---|---|
| `System Security Role.xml` | SYSTEMSECURITYROLEENTITY | Role ID, name, description, license type | ~382 |
| `System Security Sub Role V2.xml` | SYSTEMSECURITYSUBROLEENTITYV2 | Parent-child role hierarchy | Variable |
| `System Security Role Duty.xml` | SYSTEMSECURITYROLEDUTYENTITY | Role → duty assignments | ~5,000+ |
| `SystemSecurityUserRoleEntity.xml` | SYSTEMSECURITYUSERROLEENTITY | User → role assignments (enabled/disabled) | ~797 users |
| `SystemSecurityUserRoleOrganizationEntity.xml` | SYSTEMSECURITYUSERROLEORGANIZATIONENTITY | Company-scoped role restrictions | ~36 companies |
| `User information.xml` | SYSTEMUSERENTITY | User name, email, enabled status, default company | ~797 |

### 2.3 SecurityDatabaseCustomizations (PROD) — Direct Permissions

Exported from D365 F&O **Security Configuration** page (not DMF). Contains direct privilege and entity-level CRUD assignments that bypass the normal duty structure.

| Data | Provides |
|---|---|
| `DirectPrivileges` | Privileges assigned directly to a role (skipping duty layer) |
| `DirectAccessPermissions` | CRUD grants (Read/Create/Update/Delete/Correct/Invoke) directly on data entities per role |

### 2.4 Input File Layout

```
input/
├── dmf/                              # DMF exports from PROD (ZIP or folder)
│   ├── System Security Role.xml
│   ├── System Security Sub Role V2.xml
│   ├── System Security Role Duty.xml
│   ├── SystemSecurityUserRoleEntity.xml
│   ├── SystemSecurityUserRoleOrganizationEntity.xml
│   └── User information.xml
├── SecurityDatabaseCustomizations.xml  # Optional — from Security Configuration export
└── aot/                              # Resolved from PackagesLocalDirectory (same as KB build)
    ├── AxSecurityRole/
    ├── AxSecurityDuty/
    └── AxSecurityPrivilege/
```

---

## 3. Database Schema (Normalized)

### 3.1 Core Security Model (from AOT + DMF merge)

```sql
-- ══════════════════════════════════════════════════════════════
-- ROLES
-- ══════════════════════════════════════════════════════════════
CREATE TABLE roles (
  role_id          TEXT PRIMARY KEY,  -- GUID from DMF, or AOT name if DMF-only
  role_name        TEXT NOT NULL,
  module_id        TEXT,              -- AOT module (NULL for DMF-only roles)
  label            TEXT,              -- Resolved label text
  description      TEXT,
  license_type     TEXT,              -- Enterprise, TeamMembers, Activity, etc.
  permission_type  TEXT DEFAULT 'Grant',  -- 'Grant' or 'Deny'
  is_profile       INTEGER DEFAULT 0     -- 1 if this is a job profile role
);
CREATE INDEX idx_roles_name ON roles(role_name);
CREATE INDEX idx_roles_module ON roles(module_id);
CREATE INDEX idx_roles_permission ON roles(permission_type);

-- ══════════════════════════════════════════════════════════════
-- SUB-ROLES (role hierarchy)
-- ══════════════════════════════════════════════════════════════
CREATE TABLE role_subroles (
  parent_role_id   TEXT NOT NULL REFERENCES roles(role_id),
  child_role_id    TEXT NOT NULL REFERENCES roles(role_id),
  is_transitive    INTEGER DEFAULT 0,  -- 1 if inherited via BFS flattening
  PRIMARY KEY (parent_role_id, child_role_id)
);
CREATE INDEX idx_subroles_child ON role_subroles(child_role_id);

-- ══════════════════════════════════════════════════════════════
-- DUTIES
-- ══════════════════════════════════════════════════════════════
CREATE TABLE duties (
  duty_id          TEXT PRIMARY KEY,  -- AOT duty identifier
  duty_name        TEXT,              -- Resolved label
  module_id        TEXT,
  description      TEXT
);
CREATE INDEX idx_duties_module ON duties(module_id);

-- Role → Duty assignments (from DMF Role Duty export + AOT)
CREATE TABLE role_duties (
  role_id          TEXT NOT NULL REFERENCES roles(role_id),
  duty_id          TEXT NOT NULL REFERENCES duties(duty_id),
  permission_type  TEXT DEFAULT 'Grant',  -- 'Grant' or 'Deny'
  PRIMARY KEY (role_id, duty_id)
);
CREATE INDEX idx_role_duties_duty ON role_duties(duty_id);
CREATE INDEX idx_role_duties_perm ON role_duties(permission_type);

-- ══════════════════════════════════════════════════════════════
-- PRIVILEGES
-- ══════════════════════════════════════════════════════════════
CREATE TABLE privileges (
  privilege_name   TEXT PRIMARY KEY,
  module_id        TEXT,
  label            TEXT
);
CREATE INDEX idx_privileges_module ON privileges(module_id);

-- Duty → Privilege assignments (from AOT AxSecurityDuty)
CREATE TABLE duty_privileges (
  duty_id          TEXT NOT NULL REFERENCES duties(duty_id),
  privilege_name   TEXT NOT NULL REFERENCES privileges(privilege_name),
  PRIMARY KEY (duty_id, privilege_name)
);
CREATE INDEX idx_duty_privs_priv ON duty_privileges(privilege_name);

-- ══════════════════════════════════════════════════════════════
-- ENTRY POINTS (privilege → menu item / service operation with CRUD)
-- ══════════════════════════════════════════════════════════════
CREATE TABLE privilege_entry_points (
  privilege_name   TEXT NOT NULL REFERENCES privileges(privilege_name),
  entry_point_name TEXT NOT NULL,
  object_type      TEXT,    -- MenuItemDisplay, MenuItemAction, MenuItemOutput, ServiceOperation, WebContent
  object_name      TEXT,    -- Target object
  grant_read       TEXT,    -- 'Allow', 'Unset', or NULL
  grant_create     TEXT,
  grant_update     TEXT,
  grant_delete     TEXT,
  grant_correct    TEXT,
  grant_invoke     TEXT,
  PRIMARY KEY (privilege_name, entry_point_name)
);
CREATE INDEX idx_ep_object ON privilege_entry_points(object_name);
CREATE INDEX idx_ep_type ON privilege_entry_points(object_type);
```

### 3.2 Runtime / PROD State (from DMF)

```sql
-- ══════════════════════════════════════════════════════════════
-- USERS
-- ══════════════════════════════════════════════════════════════
CREATE TABLE users (
  user_id          TEXT PRIMARY KEY,
  person_name      TEXT,
  email            TEXT,
  enabled          INTEGER DEFAULT 1,  -- 1 = enabled, 0 = disabled
  default_company  TEXT
);
CREATE INDEX idx_users_enabled ON users(enabled);
CREATE INDEX idx_users_company ON users(default_company);

-- User → Role assignments (enabled only — disabled are excluded)
CREATE TABLE user_roles (
  user_id          TEXT NOT NULL REFERENCES users(user_id),
  role_id          TEXT NOT NULL REFERENCES roles(role_id),
  PRIMARY KEY (user_id, role_id)
);
CREATE INDEX idx_user_roles_role ON user_roles(role_id);

-- Company-scoped role restrictions
-- If a user_role has entries here, the role applies ONLY in these companies.
-- If no entries, the role is global (all companies).
CREATE TABLE user_role_companies (
  user_id          TEXT NOT NULL,
  role_id          TEXT NOT NULL,
  company_id       TEXT NOT NULL,
  PRIMARY KEY (user_id, role_id, company_id),
  FOREIGN KEY (user_id, role_id) REFERENCES user_roles(user_id, role_id)
);
CREATE INDEX idx_urc_company ON user_role_companies(company_id);
CREATE INDEX idx_urc_role ON user_role_companies(role_id);
```

### 3.3 Direct Permissions (from SecurityDatabaseCustomizations)

```sql
-- Privileges assigned directly to a role (bypassing duty layer)
CREATE TABLE role_direct_privileges (
  role_id          TEXT NOT NULL REFERENCES roles(role_id),
  privilege_name   TEXT NOT NULL,
  PRIMARY KEY (role_id, privilege_name)
);

-- CRUD grants directly on data entities per role (bypassing duty+privilege layers)
CREATE TABLE role_direct_entity_permissions (
  role_id          TEXT NOT NULL REFERENCES roles(role_id),
  entity_name      TEXT NOT NULL,
  grant_read       TEXT,
  grant_create     TEXT,
  grant_update     TEXT,
  grant_delete     TEXT,
  grant_correct    TEXT,
  grant_invoke     TEXT,
  PRIMARY KEY (role_id, entity_name)
);
CREATE INDEX idx_rdep_entity ON role_direct_entity_permissions(entity_name);
```

### 3.4 Metadata & Search

```sql
-- Build metadata
CREATE TABLE sec_metadata (
  key              TEXT PRIMARY KEY,
  value            TEXT
);
-- Expected keys: build_date, dmf_export_date, aot_source_path, role_count,
-- duty_count, privilege_count, user_count, company_count

-- Full-text search index
CREATE TABLE sec_search (
  object_type      TEXT,    -- 'role', 'duty', 'privilege', 'user'
  object_name      TEXT,
  module_id        TEXT,
  content          TEXT     -- Concatenated searchable text
);
CREATE INDEX idx_sec_search_type ON sec_search(object_type);
CREATE INDEX idx_sec_search_name ON sec_search(object_name);
```

### 3.5 Estimated Database Size

| Table | Est. Rows | Notes |
|---|---|---|
| roles | ~382 | DMF + AOT merged |
| role_subroles | ~500-800 | Including transitive |
| duties | ~1,065+ | From AOT |
| role_duties | ~5,000+ | From DMF |
| privileges | ~6,403 | From AOT |
| duty_privileges | ~10,000+ | From AOT |
| privilege_entry_points | ~15,000-25,000 | From AOT (multiple entry points per privilege) |
| users | ~797 | From DMF (enabled only) |
| user_roles | ~2,000-3,000 | Enabled assignments |
| user_role_companies | ~3,000-5,000 | Company scoping |
| role_direct_privileges | ~200-500 | From SecurityDatabaseCustomizations |
| role_direct_entity_permissions | ~100-300 | From SecurityDatabaseCustomizations |

**Estimated total database size**: 30-60 MB (significantly smaller than KB or XRef)

---

## 4. Build Script Design

### 4.1 File: `build/build-sec.js`

Follows the same patterns as `build-kb.js` and `build-xref-db.js`.

```
Inputs:
  1. PackagesLocalDirectory path(s) — for AOT security XML files
  2. DMF export directory path   — for PROD runtime XML files
  3. Output SQLite path          — default: %USERPROFILE%\.claude\d365fo_sec.sqlite

Usage:
  npm run build:sec
  node build/build-sec.js [packagesPath] [dmfInputDir] [outputPath]
```

### 4.2 Build Phases

```
Phase 1 — Parse AOT security metadata (from PackagesLocalDirectory)
  ├── AxSecurityRole     → roles (AOT-level definitions)
  ├── AxSecurityDuty     → duties, duty_privileges
  └── AxSecurityPrivilege → privileges, privilege_entry_points

Phase 2 — Parse DMF exports (from PROD export directory)
  ├── System Security Role.xml            → roles (merge: DMF overrides/augments AOT)
  ├── System Security Sub Role V2.xml     → role_subroles (+ transitive flattening via BFS)
  ├── System Security Role Duty.xml       → role_duties (with Grant/Deny detection)
  ├── SystemSecurityUserRoleEntity.xml    → user_roles (enabled only)
  ├── SystemSecurityUserRoleOrganizationEntity.xml → user_role_companies
  └── User information.xml                → users

Phase 3 — Parse SecurityDatabaseCustomizations.xml (optional)
  ├── DirectPrivileges              → role_direct_privileges
  └── DirectAccessPermissions       → role_direct_entity_permissions (with CRUD parsing)

Phase 4 — Build search index + metadata
  ├── sec_search (FTS across roles, duties, privileges, users)
  └── sec_metadata (build stats, timestamps)

Phase 5 — Create indexes, VACUUM, finalize
```

### 4.3 Merge Strategy (AOT + DMF)

Roles exist in both AOT and DMF with different identifiers:
- **AOT**: uses `role_name` as the identifier (e.g., `SystemAdministrator`)
- **DMF**: uses `SECURITYROLEIDENTIFIER` (a GUID) as the primary key, with `SECURITYROLENAME` as the display name

Merge approach:
1. Load AOT roles first (keyed by `role_name`)
2. Load DMF roles (keyed by GUID `role_id`)
3. Match DMF to AOT by name: if a DMF role's `SECURITYROLENAME` matches an AOT `role_name`, merge the records (AOT provides module_id, label; DMF provides role_id GUID, license_type, permission_type)
4. DMF-only roles (no AOT match) are inserted with `module_id = NULL`
5. AOT-only roles (no DMF match) are kept but flagged — they exist in code but aren't in PROD

### 4.4 Sub-Role Flattening (from SoDSecAnalysis)

Port the BFS transitive flattening logic from `Merge-SecurityModel-Refactored.ps1` (lines 334-369):

```javascript
// BFS: if Role A → Sub-Role B → Sub-Role C, then A also gets C
for (const role of roles) {
  const visited = new Set();
  const queue = [...role.directSubRoles];
  while (queue.length > 0) {
    const srId = queue.shift();
    if (visited.has(srId)) continue;  // cycle detection
    visited.add(srId);
    const subRole = rolesById.get(srId);
    if (subRole) {
      for (const nested of subRole.directSubRoles) {
        if (!visited.has(nested)) queue.push(nested);
      }
    }
  }
  // Insert transitive sub-roles not already in direct list
  for (const transId of visited) {
    if (!role.directSubRoleIds.has(transId)) {
      insertSubRole(role.id, transId, /* is_transitive */ 1);
    }
  }
}
```

### 4.5 Grant/Deny Detection (from SoDSecAnalysis)

Port the naming convention logic from `Merge-SecurityModel-Refactored.ps1` (lines 288-293):

```javascript
function detectPermissionType(name, parentPermission = 'Grant') {
  if (/^(TBG[\s_])?Deny[\s_]/i.test(name) || parentPermission === 'Deny') {
    return 'Deny';
  }
  return 'Grant';
}
```

---

## 5. MCP Tools Specification

### 5.1 File: `src/azure/sec-tools.js`

Follows the `registerXTools(server, db)` pattern.

### 5.2 Tool Catalog (18 tools)

> **Update (CR-SEC-007 / commit 86bdb56):** The original design shipped with the 15 tools below. Three governance tools were added subsequently in `sec-tools.js`. They are listed at the end of this section under "Governance Tools".

#### Lookup Tools

| # | Tool | Parameters | Description |
|---|---|---|---|
| 1 | `sec_lookup_role` | `role_name` | Full role details: sub-roles, duties, direct privileges, license type, Grant/Deny |
| 2 | `sec_lookup_duty` | `duty_name` | Duty details: which roles contain it, privileges it grants |
| 3 | `sec_lookup_privilege` | `privilege_name` | Privilege details: entry points with CRUD grants, parent duties, parent roles |
| 4 | `sec_lookup_user` | `user_id` | User's profile: roles, company scoping, enabled status |

#### Query Tools

| # | Tool | Parameters | Description |
|---|---|---|---|
| 5 | `sec_role_hierarchy` | `role_name`, `direction?` (up/down) | Sub-role tree traversal (parent or child direction) |
| 6 | `sec_find_users_by_role` | `role_name`, `company_id?` | All users assigned to a role, optionally filtered by company |
| 7 | `sec_find_roles_by_duty` | `duty_name` | All roles that contain this duty |
| 8 | `sec_find_roles_by_privilege` | `privilege_name` | All roles that grant this privilege (via duty chain) |
| 9 | `sec_company_users` | `company_id` | All users and their roles scoped to a specific company |
| 10 | `sec_permission_trace` | `role_name`, `object_name?` | Full permission chain: role → duties → privileges → entry points (with CRUD). Optionally filtered to a specific target object. |

#### Analysis Tools

| # | Tool | Parameters | Description |
|---|---|---|---|
| 11 | `sec_compare_roles` | `role1`, `role2` | Side-by-side comparison: shared vs unique duties and privileges |
| 12 | `sec_effective_permissions` | `user_id` or `role_name`, `company_id?` | Flattened permission set: all entry points with effective CRUD grants, considering sub-roles and Grant/Deny |

#### Discovery Tools

| # | Tool | Parameters | Description |
|---|---|---|---|
| 13 | `sec_search` | `query`, `object_type?`, `limit?` | Full-text search across roles, duties, privileges, users |
| 14 | `sec_stats` | (none) | Summary statistics: role counts (Grant/Deny), user counts (enabled/disabled), company count, duty/privilege counts |
| 15 | `sec_raw_sql` | `sql` | Read-only ad-hoc SQL against the security database (500-row limit) |

#### Governance Tools (added post-design)

| # | Tool | Parameters | Description |
|---|---|---|---|
| 16 | `sec_licence_assessment` | `user_id?` | Per-user licence-type assessment from assigned roles |
| 17 | `sec_what_if` | `user_id`, `add_roles?`, `remove_roles?` | Licence-tier / cost-delta of adding/removing roles |
| 18 | `sec_object_access` | `object_name` | Reverse lookup: which roles/users can read/write an object |

### 5.3 Tool Implementation Examples

#### `sec_lookup_role`

```javascript
server.tool(
  'sec_lookup_role',
  'Get complete security role details: sub-roles, duties, direct privileges, ' +
  'license type, and Grant/Deny status.',
  { role_name: z.string().describe('Role name (case-insensitive)') },
  async ({ role_name }) => {
    const rn = role_name.trim();
    const role = q(`SELECT * FROM roles WHERE role_name = ? COLLATE NOCASE`, [rn]);

    if (!role.length) {
      const fuzzy = q(`SELECT role_name FROM roles WHERE role_name LIKE ? LIMIT 10`, [`%${rn}%`]);
      if (fuzzy.length) {
        return textResult(`Role "${rn}" not found. Did you mean:\n` +
          fuzzy.map(r => `- ${r.role_name}`).join('\n'));
      }
      return textResult(`Role "${rn}" not found.`);
    }

    const r = role[0];
    let out = `# ${r.role_name}\n`;
    out += `| Property | Value |\n|---|---|\n`;
    out += `| Module | ${r.module_id || 'N/A'} |\n`;
    out += `| License Type | ${r.license_type || 'N/A'} |\n`;
    out += `| Permission | ${r.permission_type} |\n`;
    out += `| Description | ${r.description || 'N/A'} |\n\n`;

    // Sub-roles
    const subs = q(`SELECT r.role_name, rs.is_transitive
      FROM role_subroles rs JOIN roles r ON r.role_id = rs.child_role_id
      WHERE rs.parent_role_id = ?`, [r.role_id]);
    if (subs.length) {
      out += `## Sub-Roles (${subs.length})\n`;
      out += formatMarkdownTable(subs, ['role_name', 'is_transitive']);
      out += '\n\n';
    }

    // Duties
    const duties = q(`SELECT d.duty_id, d.duty_name, rd.permission_type
      FROM role_duties rd JOIN duties d ON d.duty_id = rd.duty_id
      WHERE rd.role_id = ? ORDER BY d.duty_name`, [r.role_id]);
    if (duties.length) {
      out += `## Duties (${duties.length})\n`;
      out += formatMarkdownTable(duties, ['duty_id', 'duty_name', 'permission_type']);
      out += '\n\n';
    }

    // Direct privileges (bypassing duties)
    const dirPrivs = q(`SELECT privilege_name FROM role_direct_privileges
      WHERE role_id = ? ORDER BY privilege_name`, [r.role_id]);
    if (dirPrivs.length) {
      out += `## Direct Privileges (${dirPrivs.length})\n`;
      out += dirPrivs.map(p => `- ${p.privilege_name}`).join('\n');
      out += '\n\n';
    }

    // Direct entity permissions
    const dirPerms = q(`SELECT * FROM role_direct_entity_permissions
      WHERE role_id = ? ORDER BY entity_name`, [r.role_id]);
    if (dirPerms.length) {
      out += `## Direct Entity Permissions (${dirPerms.length})\n`;
      out += formatMarkdownTable(dirPerms,
        ['entity_name', 'grant_read', 'grant_create', 'grant_update', 'grant_delete']);
      out += '\n\n';
    }

    return textResult(out);
  }
);
```

#### `sec_permission_trace`

```javascript
server.tool(
  'sec_permission_trace',
  'Trace the full permission chain for a role: role → duties → privileges → ' +
  'entry points with CRUD grants. Optionally filter to a specific target object.',
  {
    role_name: z.string().describe('Role name'),
    object_name: z.string().optional().describe('Filter to entry points targeting this object'),
  },
  async ({ role_name, object_name }) => {
    const role = q(`SELECT role_id, role_name FROM roles
      WHERE role_name = ? COLLATE NOCASE`, [role_name.trim()]);
    if (!role.length) return textResult(`Role "${role_name}" not found.`);

    let objectFilter = '';
    const params = [role[0].role_id];
    if (object_name) {
      objectFilter = ' AND ep.object_name LIKE ?';
      params.push(`%${object_name}%`);
    }

    const trace = q(`
      SELECT rd.permission_type, d.duty_id, d.duty_name,
             dp.privilege_name, p.label as priv_label,
             ep.entry_point_name, ep.object_type, ep.object_name,
             ep.grant_read, ep.grant_create, ep.grant_update,
             ep.grant_delete, ep.grant_correct, ep.grant_invoke
      FROM role_duties rd
      JOIN duties d ON d.duty_id = rd.duty_id
      JOIN duty_privileges dp ON dp.duty_id = d.duty_id
      JOIN privileges p ON p.privilege_name = dp.privilege_name
      JOIN privilege_entry_points ep ON ep.privilege_name = p.privilege_name
      WHERE rd.role_id = ? ${objectFilter}
      ORDER BY d.duty_name, dp.privilege_name, ep.entry_point_name
    `, params);

    if (!trace.length) {
      return textResult(`No permission chain found for role "${role_name}"` +
        (object_name ? ` targeting "${object_name}"` : '') + '.');
    }

    let out = `# Permission Trace: ${role[0].role_name}\n`;
    out += `${trace.length} entry points found\n\n`;
    out += formatMarkdownTable(trace, [
      'duty_name', 'privilege_name', 'object_type', 'object_name',
      'grant_read', 'grant_create', 'grant_update', 'grant_delete',
    ]);

    return textResult(out);
  }
);
```

#### `sec_effective_permissions`

```javascript
server.tool(
  'sec_effective_permissions',
  'Compute the effective (flattened) permissions for a user or role. ' +
  'Considers sub-role inheritance and Grant/Deny resolution. ' +
  'Optionally scope to a specific company.',
  {
    user_id: z.string().optional().describe('User ID (provide this OR role_name)'),
    role_name: z.string().optional().describe('Role name (provide this OR user_id)'),
    company_id: z.string().optional().describe('Limit to roles scoped to this company'),
  },
  async ({ user_id, role_name, company_id }) => {
    // 1. Resolve role IDs (either from user's assignments or a single role + sub-roles)
    // 2. Walk role → duty → privilege → entry point chain
    // 3. Accumulate CRUD grants per object
    // 4. Apply Deny overrides (Deny permission_type negates matching grants)
    // 5. Return flattened permission matrix
    // ...
  }
);
```

---

## 6. Integration into Existing Project

### 6.1 New Files

```
build/
  build-sec.js                     # SQLite builder (AOT + DMF → d365fo_sec.sqlite)

src/azure/
  sec-tools.js                     # 15 security tools (registerSecTools export)

src/functions/
  d365sec.js                       # Azure Function HTTP endpoint

src/local/
  mcp-server-sec.js                # Local stdio server for development
```

### 6.2 Modified Files

```
src/azure/shared.js                # Add getSecDb() singleton
src/functions/index.js             # Add import './d365sec.js'
package.json                       # Add build:sec script + start:sec script
azure-pipelines.yml                # Add sec database build + deploy steps
host.json                          # No changes needed (route auto-discovered)
```

### 6.3 shared.js Addition

```javascript
let secDb;
export function getSecDb() {
  if (!secDb) {
    const dbPath = process.env.SEC_DB_PATH || '/home/data/d365fo_sec.sqlite';
    secDb = openDb(dbPath);
  }
  return secDb;
}
```

### 6.4 Azure Function Endpoint: `src/functions/d365sec.js`

Identical pattern to `d365kb.js` and `d365xref.js`:

```javascript
import { app } from '@azure/functions';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport }
  from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { getSecDb } from '../azure/shared.js';
import { registerSecTools } from '../azure/sec-tools.js';

app.http('d365sec', {
  methods: ['GET', 'POST', 'DELETE'],
  route: 'd365sec',
  authLevel: 'anonymous',
  handler: async (request, context) => {
    if (request.method === 'GET' &&
        !request.headers.get('accept')?.includes('text/event-stream')) {
      return {
        status: 200,
        jsonBody: { name: 'd365fo-sec', version: '1.0.0', status: 'ok' },
      };
    }

    try {
      const db = getSecDb();
      const server = new McpServer({
        name: 'd365fo-sec',
        version: '1.0.0',
        description: 'D365FO Security Configuration — roles, duties, privileges, ' +
          'permissions, and user assignments from the production environment.',
      });
      registerSecTools(server, db);

      const transport = new WebStandardStreamableHTTPServerTransport({
        enableJsonResponse: true,
      });
      await server.connect(transport);
      const response = await transport.handleRequest(
        request, { parsedBody: await request.json() }
      );
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body: await response.text(),
      };
    } catch (err) {
      context.error('d365sec MCP error:', err);
      return {
        status: 500,
        jsonBody: { jsonrpc: '2.0', error: { code: -32603, message: err.message } },
      };
    }
  },
});
```

### 6.5 Endpoints

| Environment | URL |
|---|---|
| Development | `https://tis-d-mcpd365fo-func.azurewebsites.net/api/d365sec` |
| Production | `https://tis-p-mcpd365fo-func.azurewebsites.net/api/d365sec` |
| Local | `node src/local/mcp-server-sec.js` (stdio) |

### 6.6 Environment Variables

```
SEC_DB_PATH=/home/data/d365fo_sec.sqlite    # Azure
```

### 6.7 package.json Scripts

```json
{
  "scripts": {
    "build:sec": "node build/build-sec.js",
    "start:sec": "node src/local/mcp-server-sec.js"
  }
}
```

---

## 7. Build Script: DMF XML Parsing

The DMF XML files use a flat entity-export format. Key parsing patterns (adapted from `Merge-SecurityModel-Refactored.ps1`):

### 7.1 XML Structure

```xml
<!-- System Security Role.xml -->
<Document>
  <SYSTEMSECURITYROLEENTITY>
    <SECURITYROLEIDENTIFIER>374e...</SECURITYROLEIDENTIFIER>
    <SECURITYROLENAME>System administrator</SECURITYROLENAME>
    <DESCRIPTION>Has full access...</DESCRIPTION>
    <USERLICENSETYPE>Enterprise</USERLICENSETYPE>
    <ACCESSTOSENSITIVEDATA>0</ACCESSTOSENSITIVEDATA>
  </SYSTEMSECURITYROLEENTITY>
  <!-- ... more entities ... -->
</Document>
```

### 7.2 Parsing with fast-xml-parser

```javascript
import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
  ignoreAttributes: false,
  isArray: (name) => ['SYSTEMSECURITYROLEENTITY', ...].includes(name),
});

const xml = readFileSync(filePath, 'utf-8');
const parsed = parser.parse(xml);
const entities = parsed.Document?.SYSTEMSECURITYROLEENTITY || [];
```

### 7.3 Large File Handling

DMF exports can be 50-100 MB. For memory efficiency, consider streaming with `sax` or chunked `XmlReader`-style parsing if fast-xml-parser struggles. The SoDSecAnalysis uses `System.Xml.XmlReader` in PowerShell for this reason.

---

## 8. Data Refresh Strategy

### 8.1 When to Rebuild

The security database should be rebuilt when:
- A new DMF export is taken from PROD (recommended: monthly or after major role changes)
- New ISV/custom security objects are deployed to PROD
- The AOT PackagesLocalDirectory is updated

### 8.2 DMF Export Automation

The DMF exports are automated via a D365 recurring data export project named **`secMCP_Repository`**:

1. **Data Project `secMCP_Repository`** in D365 F&O (Data Management workspace) — owned by the D365 development team
2. Contains the 6 required entities (see Section 2.2)
3. Format: **XML**
4. Scheduled export (daily) triggered by PowerAutomate — see `PowerAutomate-SecDatabase-Update.md`
5. Export package is streamed directly to the MCP async build endpoint via `source_url`
6. No intermediate Blob/SharePoint storage required — the MCP function downloads the package from the D365-issued SAS URL

### 8.3 Pipeline Addition to azure-pipelines.yml

```yaml
- job: BuildSecDb
  displayName: 'Build Security Database'
  pool: { vmImage: 'ubuntu-latest' }
  steps:
    - task: NodeTool@0
      inputs: { versionSpec: '20.x' }
    - script: npm ci --omit=dev
    - script: |
        node build/build-sec.js \
          "$(Build.SourcesDirectory)/data/packages" \
          "$(Build.SourcesDirectory)/data/dmf-export" \
          "$(Build.ArtifactStagingDirectory)/d365fo_sec.sqlite"
    - publish: $(Build.ArtifactStagingDirectory)/d365fo_sec.sqlite
      artifact: sec-database
```

---

## 9. AI Client Configuration

### 9.1 Claude Code

```json
{
  "mcpServers": {
    "d365sec": {
      "type": "url",
      "url": "https://tis-d-mcpd365fo-func.azurewebsites.net/api/d365sec"
    }
  }
}
```

### 9.2 GitHub Copilot (VS Code)

```json
{
  "github.copilot.chat.experimental.mcpServers": {
    "d365sec": {
      "type": "http",
      "url": "https://tis-d-mcpd365fo-func.azurewebsites.net/api/d365sec"
    }
  }
}
```

### 9.3 Copilot Studio

Add as MCP connection. Populate `knownTools` with all 15 tool names (see Copilot-Studio-Guide.md for the `knownTools` pattern):

```
sec_lookup_role
sec_lookup_duty
sec_lookup_privilege
sec_lookup_user
sec_role_hierarchy
sec_find_users_by_role
sec_find_roles_by_duty
sec_find_roles_by_privilege
sec_company_users
sec_permission_trace
sec_compare_roles
sec_effective_permissions
sec_search
sec_stats
sec_raw_sql
```

---

## 10. Example Queries the Service Enables

| Question | Tool(s) |
|---|---|
| "What roles does user john.doe@trelleborg.com have?" | `sec_lookup_user` |
| "Which users have the System Administrator role in company LADE?" | `sec_find_users_by_role` (role + company filter) |
| "What can the Accounts Payable Clerk role actually do?" | `sec_permission_trace` |
| "Does any role grant Delete access on VendTable?" | `sec_raw_sql` (query privilege_entry_points) |
| "Compare TIS AP Manager vs standard AP Manager" | `sec_compare_roles` |
| "Show all users and roles for company TAB" | `sec_company_users` |
| "Which roles contain the CustCustomerMasterInquire duty?" | `sec_find_roles_by_duty` |
| "What is the effective permission set for user X in company Y?" | `sec_effective_permissions` |
| "Find all Deny roles" | `sec_search` or `sec_raw_sql` |
| "Which roles grant the VendInvoiceRegisterMaintain privilege?" | `sec_find_roles_by_privilege` |

---

## 11. Implementation Plan

| Phase | Scope | Effort |
|---|---|---|
| **Phase 1** | Build script (`build-sec.js`): parse AOT + DMF → SQLite | Core work |
| **Phase 2** | Tool implementations (`sec-tools.js`): 15 tools | Follows established patterns |
| **Phase 3** | Azure Function endpoint + local stdio server | Boilerplate from existing servers |
| **Phase 4** | Pipeline integration (azure-pipelines.yml) | Config changes |
| **Phase 5** | Documentation update (AI-Configuration.md, README) | Docs |
| **Phase 6** | Copilot Studio integration (knownTools) | Follow Copilot-Studio-Guide.md |

### Dependencies

- DMF export package from PROD (6 XML files + SecurityDatabaseCustomizations)
- Access to PackagesLocalDirectory (same as KB build)
- No new Azure resources needed — deploys to the same Function App alongside KB and XRef
