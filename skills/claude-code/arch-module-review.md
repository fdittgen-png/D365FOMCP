# Architect: Module Review

Architectural review of a D365 module or model: object inventory, dependencies, extension surface, security model, and integration points. For architects evaluating module health, planning upgrades, or assessing ISV models.

## Arguments
- $ARGUMENTS: Module or model name (e.g., "ApplicationSuite", "CostManagement", "TIS_CustomModule", "Retail")

## Workflow

### Step 1: Module overview (parallel)
Run ALL in parallel:
- `d365_get_module_summary` with moduleName = $ARGUMENTS — object counts by type
- `xref_module_objects` with moduleName = $ARGUMENTS — top-level objects list
- `xref_list_modules` — verify module exists and see its position among all modules
- `xref_cross_module_deps` with moduleName = $ARGUMENTS — inbound and outbound dependencies

### Step 2: Dependency analysis
From cross_module_deps results:
- Identify modules this depends ON (upstream)
- Identify modules that depend on THIS (downstream)
- `xref_cross_module_deps` for the heaviest dependencies — drill into specific object crossings

### Step 3: Extension & customization surface
- `xref_find_extensions` with broad object names from the module — find CoC and extensions
- Count extensions BY source model — identify which ISV/custom models extend this module
- `xref_find_event_handlers` for key classes — event handler attachment points

### Step 4: Security model
- `sec_raw_sql` to query roles and duties scoped to this module:
  ```sql
  SELECT role_name, duty_id, permission_type FROM roles r JOIN role_duties rd ON ... WHERE r.module_id = '$ARGUMENTS'
  ```
- Count roles, duties, privileges defined in this module

### Step 5: Data model overview
- `d365_raw_sql` to get table statistics for the module:
  ```sql
  SELECT table_name, field_count, table_group FROM tables WHERE module = '$ARGUMENTS' ORDER BY field_count DESC LIMIT 20
  ```

### Step 6: Present module review

**Module Architecture Review: $ARGUMENTS**

**1. Module Summary**
| Metric | Count |
|--------|-------|
| Tables | N |
| Classes | N |
| Forms | N |
| Data Entities | N |
| Enums | N |
| Security Roles | N |
| Security Duties | N |

**2. Dependency Map**
```
[Upstream Module 1] ──┐
[Upstream Module 2] ──┤
                      ├── [$ARGUMENTS] ──┬── [Downstream 1]
[Upstream Module 3] ──┤                  ├── [Downstream 2]
                      └──                └── [Downstream 3]
```
| Direction | Module | Objects Crossing | Risk |
|-----------|--------|-----------------|------|

**3. Top Tables** (by field count / complexity)
| Table | Fields | Group | Relations | Key Purpose |
|-------|--------|-------|-----------|-------------|

**4. Extension Surface**
| Extending Model | Extensions | Event Handlers | Risk |
|----------------|------------|----------------|------|

**5. Security Model**
| Tier | Role | Duties | Access Level |
|------|------|--------|-------------|

**6. Upgrade Risk Assessment**
| Factor | Rating | Notes |
|--------|--------|-------|
| Upstream dependencies | Low/Med/High | |
| Downstream consumers | Low/Med/High | |
| Extension density | Low/Med/High | |
| Custom model coupling | Low/Med/High | |

**7. Recommendations**
- Module health observations
- Dependency risks for upgrades
- Suggested decoupling opportunities
- Extension governance recommendations
