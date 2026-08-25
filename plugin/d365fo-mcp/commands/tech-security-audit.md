---
description: Audits D365FO security for a module, role, object, or user pair — segregation of duties, over-provisioning, escalation paths, compliance gaps. Use for security audits and access reviews; for single access questions use /d365-security.
argument-hint: <module | role <name> | <object> access | user <A> vs <B>>
---

# Technical: Security Audit

## Task
Audit the security scope described in `$ARGUMENTS`.
**Done when:** every finding in the report is traceable to a permission path the tools returned (role → duty → privilege → entry point), findings that rest on the known-unreliable `duty_privileges` mapping are flagged for UI verification, and each recommendation names the specific role/user/duty it applies to.

## Workflow — detect audit type

**Module/area audit** (e.g. "Accounts Payable"):
1. `d365kb:d365_search` with module keywords — forms, tables, menu items in scope
2. `d365sec:sec_permission_trace` on the top tables — who has access
3. `d365sec:sec_raw_sql` to find roles with Delete/Full control on module tables — check the actual schema first, aggregate per role (never enumerate role×privilege rows)
4. `d365sec:sec_what_if` / `d365sec:sec_compare_roles` on critical role pairs — SoD conflicts

**Role deep dive** (e.g. "role SystemAdministrator"):
1. `d365sec:sec_lookup_role` — duties, privileges, sub-roles
2. `d365sec:sec_role_hierarchy` (children) — sub-role tree
3. `d365sec:sec_find_users_by_role` — all holders
4. `d365sec:sec_permission_trace` — CRUD matrix
5. `d365xref:xref_find_references` on the role AOT object — code references

**Object access audit** (e.g. "SalesTable access"):
1. `d365kb:d365_lookup_table` — what data it holds
2. `d365sec:sec_object_access` — all grant AND deny paths (primary); `sec_permission_trace` as cross-check only
3. Per role found: `sec_find_users_by_role`; group by access level (View / Full control / Delete)

**User comparison**:
1. `d365sec:sec_lookup_user` each — roles and companies
2. `d365sec:sec_compare_roles` between primary roles — shared vs unique duties
3. `d365sec:sec_effective_permissions` each — diff the permission sets

## Output

**Security Audit: $ARGUMENTS**

1. **Access Matrix**: Object | View | Create | Update | Delete | Roles
2. **Privilege Escalation Paths** — indirect access through duty chains, sub-roles inheriting sensitive permissions
3. **Segregation of Duties**: Conflict | Role 1 | Role 2 | Risk | Users Affected
4. **Over-Provisioning** — users with broader roles than needed, unused Delete/Full grants
5. **Compliance Findings**: Finding | Severity | Recommendation
6. **Recommendations** — roles to split/restrict, users to review, duties to reassign

## Boundaries
- Findings derived from duty→privilege joins must carry a "verify in UI Security diagnostics" flag — that mapping is not reliably importable
- Recommend sandbox verification before any production security change
