# Support: Diagnose Issue

Investigate a reported D365 issue by checking configuration, security, data flow, and code paths. For support engineers troubleshooting tickets.

## Arguments
- $ARGUMENTS: Issue description (e.g., "user cannot post sales invoice", "journal approval failing for company DEMF", "missing field on vendor form")

## Workflow

### Step 0 — Verify the ticket's stated facts BEFORE forming a hypothesis

**This is the most important step.** ~30% of "lost access" tickets on this project have wrong premises. The user's stated role list, current configuration, or recent error is often based on a stale source.

**For ANY ticket mentioning a user:**

1. Pull the user's **current** role assignment from the live Azure DB (not the local stale snapshot):
   ```
   sec_raw_sql: SELECT r.role_name FROM users u
                JOIN user_roles ur ON u.user_id = ur.user_id
                JOIN roles r ON ur.role_id = r.role_id
                WHERE LOWER(u.user_id) LIKE '%<username>%' COLLATE NOCASE
                ORDER BY r.role_name
   ```
2. Compare against any role list in the ticket. If they differ, **the role assignment changed** — that IS the issue, or at minimum the cause changed. Investigate the change, not the supposedly-broken roles.
3. Check the database `build_date`:
   ```
   sec_raw_sql: SELECT value FROM sec_metadata WHERE key = 'build_date'
   ```
   If older than 24 h and the issue is recent, request a fresh DMF refresh first.

**If the ticket claims "the chain looks correct but it's broken":** that's a strong signal that the actual root cause is NOT what they think. Be skeptical. Verify each link of the chain independently before accepting the framing.

### Step 1: Identify the area (parallel)
Parse $ARGUMENTS to extract key objects (form names, table names, field names, error messages, user IDs).

Run in parallel:
- `d365_search` with keywords from the issue — find relevant tables, forms, classes
- `rag_search` with the issue description — find known solutions or documentation
- `microsoft_docs_search` with the issue topic — official troubleshooting

### Step 2: Check security (if user-related)
If a user ID or role is mentioned:
- `sec_lookup_user` — check assigned roles and companies
- `sec_effective_permissions` with the relevant object — does user have access?
- `sec_permission_trace` — trace the full permission chain

If "access denied" or "privilege" in the description:
- Identify the menu item or form from Step 1
- `sec_permission_trace` with the object name — show all roles that grant access
- Compare with user's actual roles (from Step 0)

**ALSO CHECK** for an iExtension override on the menu item:
```
sec_raw_sql: SELECT privilege_name, entry_point_name, grant_create, grant_update
             FROM privilege_entry_points
             WHERE object_name = '<MenuItem>'
```
If `TOC_ReadOnlyPrivilege` is among the privileges, it may be making the item read-only regardless of role assignment. The fix is in `iExtension` X++ code, not in security configuration.

### Step 3: Check data model (if data-related)
If a specific table or field is involved:
- `d365_lookup_table` — table structure, required fields, relations
- `d365_check_field_exists` — verify field exists and get its type
- `d365_get_enum` — if issue involves a status field, show all valid values

### Step 4: Check code (if logic-related)
If the issue involves a specific action (posting, approval, workflow):
- `d365_get_class_methods` for the processing class — find the relevant method
- `xref_find_method_callers` — understand the call chain
- `xref_find_extensions` — check for customizations that may cause the issue

### Step 5: Present diagnosis

**Diagnosis Report for: "$ARGUMENTS"**

| Check | Finding |
|-------|---------|
| Live data (Step 0) | [Matches ticket / DIFFERS — investigate change] |
| Security | [OK / Issue found] |
| Configuration | [OK / Issue found] |
| Customization | [None / Extensions found / iExtension override found] |
| Documentation | [Known issue / No match] |

**Root Cause Analysis:**
- Most likely cause based on findings (not the ticket's hypothesis if it conflicts with Step 0)
- Supporting evidence from checks
- **If the ticket's stated facts don't match live data**, lead with that — it usually IS the answer.

**Resolution Steps:**
1. [Ordered steps to resolve]

**Escalation Notes** (if unresolved):
- Objects involved (tables, classes, forms)
- Extensions found
- Suggested next investigation
