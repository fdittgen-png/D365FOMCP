# Change Request: D365 Security MCP Service — Data Accuracy Fixes

**Date**: 2026-04-09
**Requested by**: Florian Dittgen
**Service**: `tis-d-mcpd365fo-func` (D365 F&O MCP Security Module)
**Priority**: High
**Related ticket**: Martin Ellhoff (LADE) collection letter access issue — discovered during root cause analysis

---

## Background

During a comparative analysis of the MCP security service (`sec_lookup_user`, `sec_effective_permissions`) against the live D365 F&O system, several data accuracy gaps were identified. These gaps cause the MCP to return incomplete or misleading results, impacting security auditing and support troubleshooting.

---

## Issues

### Issue 1: `sec_lookup_user` does not expand sub-roles

**Severity**: High
**File**: `src/azure/sec-tools.js`, lines 232–238

**Current behavior**: The user lookup query only joins `user_roles` directly. For a user with 11 direct role assignments (e.g., TIS Buyer, TIS AR clerk), it returns those 11 roles. It does NOT expand composite roles into their sub-roles.

**Expected behavior**: The query should expand the role hierarchy using `role_subroles` (which already has transitive entries computed via BFS during import). A user with TIS Buyer (which has 9 sub-roles like Buying agent, Deny vendor invoices, etc.) should show both the parent role AND the effective sub-roles, clearly distinguished.

**Impact**: When troubleshooting "user X can't do Y", the analyst sees only top-level role names and must manually look up each role's sub-roles. The flattened view hides which sub-role actually grants or denies a specific duty.

**Root cause**: The query uses a simple join:
```sql
SELECT r.role_name, r.permission_type, r.license_type
FROM user_roles ur JOIN roles r ON r.role_id = ur.role_id
WHERE ur.user_id = ?
```

**Fix**: Add an `effective_roles` section to the response that expands via `role_subroles`:
```sql
-- Direct assignments (what the user is assigned)
SELECT r.role_name, r.permission_type, 'direct' as assignment_type
FROM user_roles ur JOIN roles r ON r.role_id = ur.role_id
WHERE ur.user_id = ?

UNION ALL

-- Inherited sub-roles (what the user effectively has)
SELECT r2.role_name, r2.permission_type, 
       CASE WHEN rs.is_transitive = 0 THEN 'subrole' ELSE 'transitive' END
FROM user_roles ur
JOIN role_subroles rs ON rs.parent_role_id = ur.role_id
JOIN roles r2 ON r2.role_id = rs.child_role_id
WHERE ur.user_id = ?
```

Display as two sections: "Assigned Roles (N)" and "Effective Sub-Roles (M)" to preserve the hierarchy visibility.

---

### Issue 2: Deny duties included in effective permissions

**Severity**: High
**File**: `src/azure/sec-tools.js`, lines 644–663 (`sec_effective_permissions`) and multiple other tools

**Current behavior**: All queries that join `role_duties` include both Grant and Deny duties in results. The `permission_type` column is selected but never filtered. `sec_effective_permissions` returns Deny duties as if they grant access.

**Expected behavior**: Deny duties should be excluded from effective permission results (they revoke access, not grant it). They should only appear in dedicated Deny analysis views.

**Impact**: When checking "does user X have permission to do Y?", Deny duties inflate the results with permissions the user does NOT actually have. This is misleading for security audits and troubleshooting.

**Affected functions** (all in `src/azure/sec-tools.js`):

| Function | Lines | Issue |
|---|---|---|
| `sec_effective_permissions` | 644–663 | Returns Deny duties in effective permission set |
| `sec_permission_trace` | 457–487 | Traces through Deny duties without flagging them |
| `sec_compare_roles` | 520–525 | Compares duties without distinguishing Grant/Deny |
| `sec_find_roles_by_duty` | ~350 | Returns Deny roles alongside Grant roles |
| `sec_find_users_by_role` | ~380 | No issue (doesn't touch duties) |

**Fix**: Add `AND rd.permission_type = 'Grant'` to all `role_duties` joins in permission-related queries. For `sec_permission_trace`, include Deny duties but annotate them clearly:

```sql
-- In sec_effective_permissions: only Grant duties
WHERE rd.permission_type = 'Grant'

-- In sec_permission_trace: include Deny but annotate
SELECT ..., rd.permission_type as duty_permission
-- And in the output, flag Deny entries: "⛔ DENIED by role X"
```

---

### Issue 3: Missing role in import — TBG Ledger Calendar Security Role

**Severity**: Medium
**File**: `src/azure/sec-builder.js`, Phase 1 (role import)

**Current behavior**: The role "TBG Ledger Calendar Security Role" exists in the live D365 system and is assigned to users, but is missing from the MCP database after import.

**Likely root cause**: The DMF export may not include this role, OR the role name matching during AOT+DMF merge is dropping it. The merge logic (sec-builder.js, lines 390–440) matches by `role_id` — if the DMF export uses a different identifier (GUID vs AOT name) for this role, the merge may skip it.

**Investigation needed**:
1. Check if the role exists in the raw DMF export XML (`System Security Role.xml`)
2. Check the merge log for dropped/unmatched roles
3. If it's a GUID-referenced custom role, ensure the GUID-to-name mapping works

**Fix**: Add diagnostic logging during import that reports:
- Total roles in DMF export
- Roles successfully imported
- Roles skipped (with reason: duplicate, missing ID, etc.)

This will help identify similar gaps in future imports.

---

### Issue 4: `sec_lookup_user` doesn't show per-role Deny duties

**Severity**: Medium
**File**: `src/azure/sec-tools.js`, lines 203–253

**Current behavior**: The user lookup shows role assignments with the role-level `permission_type` (Grant/Deny from the `roles` table). But it does NOT show which specific duties within a Grant role have Deny permission. For example, TIS Buyer is a Grant role, but it has a sub-role "Deny vendor invoices" which denies specific duties.

**Expected behavior**: For each role assigned to the user, show a summary of Deny duties:
```
Role: TIS Buyer (Grant, Enterprise)
  Sub-roles: 9 (incl. Deny vendor invoices)
  Deny duties: D40 (Maintain vendor recurring invoices) via "Deny vendor invoices"
```

**Fix**: After retrieving the user's roles, query the deny duties per role:
```sql
SELECT r.role_name as parent_role, rd.duty_id, d.duty_name, rd.permission_type
FROM user_roles ur
JOIN role_subroles rs ON rs.parent_role_id = ur.role_id
JOIN role_duties rd ON rd.role_id = rs.child_role_id
JOIN duties d ON d.duty_id = rd.duty_id
WHERE ur.user_id = ? AND rd.permission_type = 'Deny'
```

Add a "Deny Overrides" section to the `sec_lookup_user` output.

---

### Issue 5: Grant/Deny detection relies solely on naming convention

**Severity**: Low (works for current data, fragile long-term)
**File**: `src/azure/sec-builder.js`, lines 271–276

**Current behavior**: The `detectPermissionType()` function uses a regex to detect Deny roles/duties:
```javascript
if (/^(TBG[\s_])?Deny[\s_]/i.test(name)) return 'Deny';
```

This works for standard Microsoft naming ("Deny vendor invoices") and TBG custom naming ("TBG Deny Ledger Calendar"). But it would miss:
- Non-English Deny role names
- Custom roles that don't follow the `Deny_` prefix convention
- Roles where the parent role is Deny but the name doesn't start with "Deny"

**Expected behavior**: The DMF export (`System Security Role.xml`) should contain a `PermissionType` or `GrantDeny` attribute/element on the role entity. Use that authoritative field instead of name-based detection.

**Fix**: Check if the DMF entity `SystemSecurityRoleEntity` exports a permission type field. If so, use it as primary detection with the regex as fallback:
```javascript
function detectPermissionType(name, dmfPermType) {
  if (dmfPermType) return dmfPermType; // Authoritative from DMF
  if (/^(TBG[\s_])?Deny[\s_]/i.test(name)) return 'Deny'; // Fallback
  return 'Grant';
}
```

---

### Issue 6: `duty_privileges` not populated from DMF export

**Severity**: High
**File**: `src/azure/sec-builder.js`, Phase 3 (lines 565–592)

**Current behavior**: The `duty_privileges` table is ONLY populated from AOT metadata (`AxSecurityDuty` XML files, lines 422–432). When no AOT data is uploaded (DMF-only import), `duty_privileges` remains empty for all duties. This affects ALL downstream privilege queries.

**Evidence**: All 6 `COLLECTIONLETTER*` duties have 0 privileges in the MCP, while production shows 23 privileges for "Enable collections process" alone. The `duty_privileges` table has 6,300 entries (all from AOT) but zero for any duty that only exists in DMF.

**Root cause**: The DMF file `System Security Duty V2.xml` (`SystemSecurityDutyV2Entity`) contains **Role + Duty + Privilege** triples:
```xml
<SYSTEMSECURITYDUTYV2ENTITY>
  <SECURITYROLEIDENTIFIER>...</SECURITYROLEIDENTIFIER>
  <SECURITYDUTYIDENTIFIER>COLLECTIONLETTERCOLLECTIONSPROCESSENABLE</SECURITYDUTYIDENTIFIER>
  <SECURITYPRIVILEGEIDENTIFIER>CustInterestMaintain</SECURITYPRIVILEGEIDENTIFIER>
  <SECURITYPRIVILEGENAME>Interest and fine</SECURITYPRIVILEGENAME>
</SYSTEMSECURITYDUTYV2ENTITY>
```

The builder reads `System Security Role Duty.xml` for role→duty mappings but **never reads `System Security Duty V2.xml`** for duty→privilege mappings.

**Fix**: In Phase 3, after processing `System Security Role Duty.xml`, add parsing of `System Security Duty V2.xml`:

```javascript
// 2c-bis: Duty-Privilege mappings from DutyV2 entity
const dutyV2File = findDmfFile(dmfInputDir,
  'System Security Duty V2.xml', 'SystemSecurityDutyV2.xml');
if (dutyV2File) {
  const entities = parseDmfXml(xmlParser, dutyV2File, 'SYSTEMSECURITYDUTYV2ENTITY', log);
  const seen = new Set();
  for (const e of entities) {
    const dutyId = e.SECURITYDUTYIDENTIFIER;
    const privId = e.SECURITYPRIVILEGEIDENTIFIER;
    if (!dutyId || !privId) continue;
    const key = `${dutyId}|${privId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // Resolve duty ID casing to match existing entries
    const resolvedDutyId = aotDutyUpper.get(dutyId.toUpperCase()) || dutyId;
    stmts.insertDutyPriv.run(resolvedDutyId, privId);
    // Also ensure the privilege exists in the privileges table
    if (!db.prepare('SELECT 1 FROM privileges WHERE privilege_name = ?').get(privId)) {
      const privName = e.SECURITYPRIVILEGENAME || null;
      stmts.insertPrivilege.run(privId, null, privName);
    }
    stats.dmfDutyPrivileges = (stats.dmfDutyPrivileges || 0) + 1;
  }
  log(`    Duty-privilege mappings (DMF): ${stats.dmfDutyPrivileges || 0}`);
}
```

This gives duty→privilege mappings from DMF when AOT data is unavailable, and supplements AOT data when both are present.

---

## Implementation Plan

| # | Issue | Effort | Risk | Dependencies |
|---|---|---|---|---|
| 6 | `duty_privileges` not populated from DMF | Small (add DutyV2 parsing in sec-builder) | Low | None |
| 2 | Deny filtering in permission queries | Small (add WHERE clause to 5 functions) | Medium (changes query results) | Tests must be updated |
| 1 | Sub-role expansion in `sec_lookup_user` | Small (SQL change + output formatting) | Low | None |
| 4 | Per-role Deny duties in user lookup | Medium (new query + output section) | Low | Depends on #1 |
| 3 | Missing role diagnostics | Small (add logging) | Low | None |
| 5 | DMF-based Grant/Deny detection | Medium (schema change + DMF parsing) | Low | Check DMF entity fields |

**Suggested order**: 6 → 2 → 1 → 4 → 3 → 5

Issue 6 is the highest priority — it causes ALL privilege queries to return empty results for DMF-only duties, directly impacting the collection letter investigation.

Issue 2 (Deny filtering) is the most impactful bug — it causes `sec_effective_permissions` to return permissions users don't actually have. Fix this first.

---

## Testing

### Existing test suite
- `test/sec-tools.test.js` — 150+ unit tests covering all tools
- Tests must be updated to validate:
  - `sec_lookup_user` returns both direct and sub-role assignments
  - `sec_effective_permissions` excludes Deny duties
  - `sec_permission_trace` annotates Deny entries
  - `sec_compare_roles` distinguishes Grant/Deny duties

### Regression test cases
1. **TIS Buyer lookup**: Should show 11 direct roles + 9+ effective sub-roles (incl. "Deny vendor invoices")
2. **Martin Ellhoff lookup**: Should show all direct roles + sub-roles + company scoping + Deny overrides
3. **Effective permissions for role with Deny sub-role**: Deny duties must NOT appear in granted permissions
4. **Permission trace for denied duty**: Should show the trace path ends at a Deny, with clear annotation

---

## Acceptance Criteria

1. `sec_lookup_user` for Martin Ellhoff shows the same role set as the live D365 system (11 direct + sub-roles)
2. `sec_effective_permissions` for TIS Buyer does NOT include permissions revoked by "Deny vendor invoices"
3. `sec_lookup_user` for TIS Buyer shows a "Deny Overrides" section listing D40 mitigation
4. Import log reports total/imported/skipped roles, with "TBG Ledger Calendar Security Role" successfully imported
5. All 150+ existing tests pass + new tests for the above scenarios
