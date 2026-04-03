# Functional: Configuration Review

Review D365 configuration for a module or feature area. Identifies setup tables, configuration keys, number sequences, and security requirements. For functional consultants doing implementation reviews or audits.

## Arguments
- $ARGUMENTS: Module or feature area (e.g., "Accounts Payable", "Warehouse Management", "Tax setup", "CustParameters")

## Workflow

### Step 1: Identify configuration objects (parallel)
Run ALL in parallel:
- `d365_search` with "$ARGUMENTS parameters setup" — find parameter tables and setup forms
- `d365_search` with "$ARGUMENTS configuration" — find config keys and related objects
- `rag_search` with "$ARGUMENTS configuration setup" — find setup documentation
- `microsoft_docs_search` with "$ARGUMENTS setup configure" — official setup guides

### Step 2: Analyze parameter tables
For each parameter/setup table found (e.g., CustParameters, VendParameters):
- `d365_lookup_table` — fields, enums, relations
- `d365_get_entity_sources` — check if configurable via data entities (for migration)

For enum fields on parameter tables:
- `d365_get_enum` — list all options with descriptions

### Step 3: Security for configuration
- `sec_permission_trace` with each setup form's menu item — who can modify configuration
- Flag any setup forms accessible to non-admin roles

### Step 4: Documentation cross-reference
- `microsoft_docs_fetch` for the most relevant setup guide URL from Step 1
- `rag_lookup_document` for any internal documentation

### Step 5: Present configuration review

**Configuration Review: $ARGUMENTS**

**1. Parameter Tables**
| Table | Form | Purpose | Key Settings |
|-------|------|---------|-------------|

**2. Critical Settings**
| Setting | Table.Field | Current Options (Enum) | Impact |
|---------|------------|----------------------|--------|

**3. Number Sequences**
| Reference | Scope | Table |
|-----------|-------|-------|
(if applicable)

**4. Configuration Keys**
| Key | Status | Affects |
|-----|--------|---------|
(if applicable)

**5. Data Migration**
| Config Table | Data Entity | Available | Notes |
|-------------|------------|-----------|-------|

**6. Security**
| Setup Form | Required Role | Duty |
|-----------|--------------|------|

**7. Recommendations**
- Critical settings to verify before go-live
- Common misconfiguration pitfalls (from docs)
- Data entity availability for automated setup
