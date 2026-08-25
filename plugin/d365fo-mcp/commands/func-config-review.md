---
description: Reviews D365FO configuration for a module or feature area — parameter tables, critical settings with enum options, number sequences, config keys, data-entity availability, and who can change setup. Use for implementation reviews, go-live checks, or configuration audits.
argument-hint: <module or feature area, e.g. "Accounts Payable">
---

# Functional: Configuration Review

## Task
Review the configuration surface of `$ARGUMENTS`.
**Done when:** parameter tables and their critical settings are listed with actual enum options (resolved via tools, not recalled), setup-form access is traced, and recommendations distinguish documented pitfalls (with source) from your own inferences.

## Workflow

### Step 1: Identify configuration objects (parallel)
- `d365kb:d365_search` with "[area] parameters setup" and "[area] configuration"
- `d365rag:rag_search` with configuration keywords — internal setup documentation _(if the d365rag MCP is connected)_
- `Microsoft Learn:microsoft_docs_search` with "[area] setup configure"

### Step 2: Analyze parameter tables
For each parameter/setup table found (e.g. CustParameters, VendParameters):
- `d365kb:d365_lookup_table` — fields, enums, relations
- `d365kb:d365_get_entity_sources` — configurable via data entities? (migration path)
- `d365kb:d365_get_enum` for enum fields — all options

### Step 3: Security for configuration
- `d365sec:sec_permission_trace` on each setup form's menu item — who can modify configuration; flag setup forms accessible to non-admin roles

### Step 4: Documentation depth
- `microsoft_docs_fetch` on the best setup-guide URL; `d365rag:rag_lookup_document` for internal docs

## Output

**Configuration Review: $ARGUMENTS**

1. **Parameter Tables**: Table | Form | Purpose | Key Settings
2. **Critical Settings**: Setting | Table.Field | Options (Enum) | Impact
3. **Number Sequences** (if applicable): Reference | Scope | Table
4. **Configuration Keys** (if applicable): Key | Status | Affects
5. **Data Migration**: Config Table | Data Entity | Available | Notes
6. **Security**: Setup Form | Required Role | Duty
7. **Recommendations**: settings to verify before go-live, misconfiguration pitfalls (cite the doc), data-entity availability for automated setup

Drop sections that don't apply rather than padding them.
