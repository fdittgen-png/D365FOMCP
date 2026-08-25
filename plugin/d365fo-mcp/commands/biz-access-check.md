---
description: Answers "can user X do Y" and "who can do Y" questions about D365FO access in business language — roles, permissions, and yes/no verdicts without technical jargon. Use for business users or managers reviewing access; for deep security engineering use /d365-security instead.
argument-hint: <UserId> [action] | who can <action>
---

# Business: Check My Access

## Task
Answer the access question in `$ARGUMENTS` in plain business terms.
**Done when:** the question gets a direct Yes/No (or user list) backed by an actual permission trace — never inferred from role names alone — and the answer uses only display names, no AOT identifiers.

## Workflow

**If "who can [action]" pattern:**
1. `d365kb:d365_search` with the action keywords — find the relevant form/menu item
2. `d365sec:sec_permission_trace` with the form or table name — all roles granting access
3. For each role found: `d365sec:sec_find_users_by_role` — list users

Present as a table: Name | Role | Company.

**If user ID provided (with or without action):**
1. `d365sec:sec_lookup_user` with the user ID — profile, roles, companies
2. `d365sec:sec_effective_permissions` with the user ID — flattened permission set
3. If a specific action was named: `d365kb:d365_search` to find the object, then check it against the effective permissions

Present as:

**Access Report for [User Name]**
- **Your roles** table (display names only): Role | Description | Companies
- **What you can do** / **What you cannot do** — grouped by business area, not technical hierarchy
- If an action was asked: "[Action]": **Yes** / **No** — via [Role Name] > [Duty Name]

## Standards
- Display names only — never AOT names or technical role IDs
- Translate CRUD to business language: Create → "create new records", Read → "view", Update → "edit existing records", Delete → "remove records", Full control → "full access including delete"
- If the verdict is "granted" but the user still reports failure, say explicitly that it is not a role gap and name the likely non-security causes (company context, personalization, User→Worker link)
