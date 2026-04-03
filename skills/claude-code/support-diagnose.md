# Support: Diagnose Issue

Investigate a reported D365 issue by checking configuration, security, data flow, and code paths. For support engineers troubleshooting tickets.

## Arguments
- $ARGUMENTS: Issue description (e.g., "user cannot post sales invoice", "journal approval failing for company DEMF", "missing field on vendor form")

## Workflow

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
- Compare with user's actual roles

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
| Security | [OK / Issue found] |
| Configuration | [OK / Issue found] |
| Customization | [None / Extensions found] |
| Documentation | [Known issue / No match] |

**Root Cause Analysis:**
- Most likely cause based on findings
- Supporting evidence from checks

**Resolution Steps:**
1. [Ordered steps to resolve]

**Escalation Notes** (if unresolved):
- Objects involved (tables, classes, forms)
- Extensions found
- Suggested next investigation
