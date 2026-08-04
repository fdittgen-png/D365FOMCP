# Technical: Security Audit

Comprehensive security audit of a D365 area: over-provisioning, privilege escalation paths, and compliance gaps. For security architects and technical security reviewers.

## Arguments
- $ARGUMENTS: Audit scope (e.g., "Accounts Payable", "SalesTable access", "role SystemAdministrator", "user FDittgen vs JSmith", "all roles with Delete on CustTable")

## Workflow

### Detect audit type from $ARGUMENTS

**If module/area audit** (e.g., "Accounts Payable"):
Go to Full Module Audit workflow.

**If role audit** (e.g., "role SystemAdministrator"):
Go to Role Deep Dive workflow.

**If object audit** (e.g., "SalesTable access"):
Go to Object Access Audit workflow.

**If user comparison** (e.g., "user X vs Y"):
Go to User Comparison workflow.

---

### Full Module Audit
1. `d365_search` with module keywords — find all forms, tables, menu items in the module
2. For top tables: `sec_permission_trace` — who has access to each
3. `sec_raw_sql` — query for roles with Delete/Full control on module tables:
   ```sql
   SELECT DISTINCT r.role_name, ep.object_name, ep.grant_delete
   FROM roles r JOIN role_duties rd ON ... WHERE ep.object_name LIKE '%keyword%' AND ep.grant_delete = 1
   ```

### Role Deep Dive
1. `sec_lookup_role` — full role structure (duties, privileges, sub-roles)
2. `sec_role_hierarchy` direction=children — sub-role tree
3. `sec_find_users_by_role` — all users with this role
4. `sec_permission_trace` — full CRUD matrix
5. `xref_find_references` for the role AOT object — where it's referenced in code

### Object Access Audit
1. `d365_lookup_table` for the object — understand what data it holds
2. `sec_permission_trace` with objectName — all paths granting access
3. For each role found: `sec_find_users_by_role` — who actually has it
4. Group by access level (View vs Full control vs Delete)

### User Comparison
1. `sec_lookup_user` for each user — roles and companies
2. `sec_compare_roles` between their primary roles — shared vs unique duties
3. `sec_effective_permissions` for each — diff their permission sets

---

### Present audit report

**Security Audit: $ARGUMENTS**

**1. Access Matrix**
| Object | View | Create | Update | Delete | Roles |
|--------|------|--------|--------|--------|-------|

**2. Privilege Escalation Paths**
- Roles that grant indirect access through duty chains
- Sub-roles that inherit sensitive permissions

**3. Over-Provisioning**
- Users with roles broader than their job requires
- Roles with unused Delete/Full control grants

**4. Compliance Findings**
| Finding | Severity | Recommendation |
|---------|----------|----------------|

**5. Recommendations**
- Roles to split or restrict
- Users to review
- Duties to reassign
