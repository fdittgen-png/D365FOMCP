# D365 Impact Analysis

Analyze the downstream impact of modifying a D365 object before making changes.

## Arguments
- $ARGUMENTS: Object to analyze (e.g., "CustTable", "SalesFormLetter.confirm", "StatusUpdate enum")

## Workflow

### Step 1: Identify object type and gather impact data (parallel)
Parse `$ARGUMENTS` to determine if it's a table, class, method (Class.Method), field (Table.Field), or enum.

Run in parallel:
- `xref_impact_analysis` with the object name (full downstream dependency tree)
- `d365_lookup_table` OR `d365_get_class_methods` (depending on type) for current structure
- `xref_find_extensions` for existing extensions/customizations on this object
- `xref_find_event_handlers` for event handlers attached to this object

### Step 2: If method-level, also get callers
- `xref_find_method_callers` with className and methodName
- `xref_method_references` to see what the method itself calls

### Step 3: Cross-module analysis
If the impact spans multiple modules:
- `xref_cross_module_deps` to identify module boundary crossings
- Flag any cross-module impacts that may require coordination

### Step 4: Present impact report

Format as:

**Impact Summary for `$ARGUMENTS`**

| Category | Count | Risk |
|----------|-------|------|
| Direct callers | N | |
| Transitive dependents | N | |
| Extensions/CoC | N | |
| Event handlers | N | |
| Modules affected | N | |

**Direct Consumers** (list top 15 with module)

**Extensions at Risk** (any CoC or event handlers that may break)

**Cross-Module Impacts** (objects in other modules that depend on this)

**Recommendation**: Safe to modify / Proceed with caution / High risk - coordinate with teams

### Step 5: Offer drill-down
- View specific caller source code
- Check who has security access to affected objects
- Search documentation for migration guidance
