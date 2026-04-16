# D365 Security Analysis

Comprehensive security analysis for a user, role, or object.

## Arguments
- $ARGUMENTS: User ID, role name, or "access to <object>" (e.g., "FDittgen", "SystemAdministrator", "access to CustTable")

## Workflow

### Step 0 — ALWAYS verify the data source first

Before any analysis:

```sql
sec_raw_sql: SELECT key, value FROM sec_metadata WHERE key IN ('build_date','build_mode','dutyPrivileges','privileges','entryPoints','duties','roles','users')
```

Check the `build_date` is recent. If you're investigating a "lost access" ticket and the build is more than 24 h old, **stop and request a fresh DMF refresh first** — stale data is the #1 cause of wrong root-cause hypotheses on this project.

> **Critical pitfall**: The local stdio MCP at `C:\Users\...\.claude\d365fo_sec.sqlite` is usually a **stale snapshot**. The Azure-deployed MCP at `https://tis-d-mcpd365fo-func.azurewebsites.net/api/d365sec` is the live source. When in doubt, query Azure directly via `curl` (see `mcp-db-admin` skill).

### Detect analysis type from $ARGUMENTS

**If user ID**:
Run in parallel:
- `sec_lookup_user` with userId — get assigned roles and companies
- `sec_effective_permissions` with userId — get flattened permission set

Then present:
- User profile (name, companies, status)
- Roles assigned (with duty breakdown)
- Effective permissions summary
- Offer: "Check access to a specific object?" → `sec_effective_permissions(userId, objectName)`

**If role name**:
Run in parallel:
- `sec_lookup_role` with roleName — duties and privileges
- `sec_role_hierarchy` with roleName — parent/child roles
- `sec_find_users_by_role` with roleName — who has this role

Then present:
- Role structure (duties → privileges → permissions)
- User count and list
- Hierarchy (sub-roles, parent roles)
- Offer: "Compare with another role?" → `sec_compare_roles`

**If "access to <object>"**:
- `sec_permission_trace` with objectName — which roles/duties grant access
- `d365_lookup_table` with objectName — table context (if table)

Then present:
- All paths that grant access (role → duty → privilege → permission)
- Users who have access (via those roles)
- Offer: "Audit a specific user's access?" → drill into user

---

## Critical data quirks (memorize these)

These cause wrong conclusions in ~30% of investigations if not accounted for:

### 1. Case mismatch between AOT and DMF identifiers

The same duty/privilege exists in **two casings** in the database:

| Source | Casing example |
|--------|----------------|
| AOT (`AxSecurityDuty/*.xml`) | `CollectionLetterCollectionsTransMaintai` (mixed case) |
| DMF (`System Security Duty.xml`) | `COLLECTIONLETTERCOLLECTIONSTRANSMAINTAI` (UPPERCASE) |

They are stored as **separate primary-key rows**. A naive `JOIN duty_privileges dp ON rd.duty_id = dp.duty_id` (default BINARY collation) will silently miss data.

**When writing `sec_raw_sql` queries that join on `duty_id` or `privilege_name`:**

✅ **Fast and correct:**
```sql
WHERE col = 'value' COLLATE NOCASE       -- uses idx_*_nocase
WHERE col IN ('CamelCase', 'UPPERCASE')  -- uses BINARY index, both casings
```

❌ **Slow or wrong:**
```sql
WHERE LOWER(col) = LOWER('value')        -- bypasses ALL indexes; 16+ s on 34M-row tables
ON rd.duty_id = dp.duty_id               -- BINARY collation, misses rows when sources differ
```

### 2. iExtension `TOC_ReadOnlyPrivilege` overrides

The Trelleborg custom `iExtension` module contains `TOC_ReadOnlyPrivilege` that explicitly defines certain menu items as read-only entry points (notably `CustCollectionLetter*`, possibly others). When investigating "user lost write access" tickets in finance/AR, **always check whether the menu item is defined in `TOC_ReadOnlyPrivilege`** before blaming role assignments:

```sql
sec_raw_sql: SELECT pe.privilege_name, pe.entry_point_name, pe.grant_create, pe.grant_update
             FROM privilege_entry_points pe
             WHERE pe.object_name = '<MenuItem>'
             ORDER BY pe.privilege_name
```

If `TOC_ReadOnlyPrivilege` is the **only** privilege defining the menu item, no role can ever get write access to it — the fix lives in the `iExtension` X++ code, not in role assignments.

### 3. The DMF effective view inflates duty_privileges to 34M rows

`duty_privileges` contains the **expanded effective privilege set** for every (duty, privilege) pair, not just direct AOT assignments. A single duty can have 9000+ effective privileges through hierarchy expansion. When counting "how many privileges does duty X have", expect thousands, not dozens.

---

### Always end with
- Summary table of findings
- Security recommendations if any gaps or over-provisioning detected
- **For "lost access" tickets**: explicit before/after comparison if a recent role change is detected

---

## Related tools (new)

These tools extend the analysis when needed:

- **`sec_licence_assessment`** — assess a user's minimum required licence tier from their roles. Use when investigating cost optimization or over-provisioning. See also `/d365-licence-audit`.
- **`sec_sod_check`** — check for Segregation of Duties violations using external rules. Use when auditing a user or investigating compliance. Requires `SOD_RULES_FILE`. See also `/d365-sod`.
- **`sec_what_if`** — simulate role add/remove and see licence tier + SoD impact before making changes. Use when recommending remediation. See also `/d365-what-if`.
- **`sec_object_access`** — reverse permission chain: given an object, find all roles and users that can access it. Use when answering "who can access X?" questions.
