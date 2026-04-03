# D365 Security Analysis

Comprehensive security analysis for a user, role, or object.

## Arguments
- $ARGUMENTS: User ID, role name, or "access to <object>" (e.g., "FDittgen", "SystemAdministrator", "access to CustTable")

## Workflow

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

### Always end with
- Summary table of findings
- Security recommendations if any gaps or over-provisioning detected
