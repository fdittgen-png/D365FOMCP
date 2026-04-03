# Business: Check My Access

Check what a user can access in D365, explained in business terms. For business users wondering "can I do X?" or managers reviewing team access.

## Arguments
- $ARGUMENTS: User ID and optional action (e.g., "FDittgen", "FDittgen post invoices", "who can approve purchase orders")

## Workflow

### Detect query type from $ARGUMENTS

**If "who can [action]" pattern:**
1. `d365_search` with the action keywords — find the relevant form/menu item
2. `sec_permission_trace` with the form or table name — find all roles granting access
3. For each role found: `sec_find_users_by_role` — list users

Present as:
**Users who can [action]:**
| Name | Role | Company |
|------|------|---------|

**If user ID provided (with or without action):**
1. `sec_lookup_user` with the user ID — get profile, roles, companies
2. `sec_effective_permissions` with the user ID — flattened permission set

**If specific action mentioned** (e.g., "post invoices"):
3. `d365_search` with action keywords — find the relevant table/form
4. Check if user's effective permissions include that object

Present as:

**Access Report for [User Name]**

**Your roles:**
| Role | Description | Companies |
|------|-------------|-----------|
(use display names only, not technical IDs)

**What you can do:**
- Create/edit [objects] (from effective permissions)
- View [objects]
- Approve [if workflow permissions found]

**What you cannot do:**
- (areas not covered by assigned roles)

**If action was asked:**
- "[Action]": **Yes** / **No** — via [Role Name] > [Duty Name]

### Important
- Always use display names (not AOT names) for roles, duties, privileges
- Group permissions by business area, not technical hierarchy
- Translate CRUD permissions to business language:
  - Create → "create new records"
  - Read → "view"
  - Update → "edit existing records"
  - Delete → "remove records"
  - Full control → "full access including delete"
