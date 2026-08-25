---
description: Assesses the downstream impact of modifying a D365FO object (table, class, method, field, or enum) — dependents, extensions at risk, cross-module effects, and a go/no-go recommendation. Use before changing or deprecating any D365 object.
argument-hint: <Object | Class.Method | Table.Field | EnumName>
---

# D365 Impact Analysis

## Task
Analyze the downstream impact of modifying `$ARGUMENTS` before the change is made.
**Done when:** the impact table, consumer list, and a clear recommendation (safe / caution / high risk) are presented, with confirmed data separated from inference.

## Workflow

### Step 1: Identify object type and gather impact data (parallel)
Parse `$ARGUMENTS` to determine if it's a table, class, method (Class.Method), field (Table.Field), or enum.

Run in parallel:
- `d365xref:xref_impact_analysis` with the object name (full downstream dependency tree)
- `d365kb:d365_lookup_table` OR `d365kb:d365_get_class_methods` (depending on type) for current structure
- `d365xref:xref_find_extensions` for existing extensions/customizations on this object
- `d365xref:xref_find_event_handlers` for event handlers attached to this object

### Step 2: If method-level, also get callers
- `d365xref:xref_find_method_callers` with className and methodName
- `d365xref:xref_method_references` to see what the method itself calls

### Step 3: Cross-module analysis
If the impact spans multiple modules: `d365xref:xref_cross_module_deps` to identify boundary crossings; flag impacts that need cross-team coordination.

## Output

**Impact Summary for `$ARGUMENTS`**

| Category | Count | Risk |
|----------|-------|------|
| Direct callers | N | |
| Transitive dependents | N | |
| Extensions/CoC | N | |
| Event handlers | N | |
| Modules affected | N | |

Then: **Direct Consumers** (top 15 with module), **Extensions at Risk**, **Cross-Module Impacts**, and a **Recommendation**: Safe to modify / Proceed with caution / High risk — coordinate with teams. State what evidence drives the rating.

## Follow-ups to offer
- View specific caller source code
- Security access to affected objects (`/d365-security`)
- Documentation for migration guidance (`/d365-research`)
