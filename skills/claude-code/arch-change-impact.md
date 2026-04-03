# Architect: Change Impact Assessment

Full architectural impact assessment before approving a change: code dependencies, security implications, data model effects, integration risks, and cross-module coordination needs. For solution architects and tech leads reviewing change requests.

## Arguments
- $ARGUMENTS: Change description (e.g., "add field to SalesTable", "deprecate CustPostInvoice", "change PurchStatus enum", "migrate from CustInvoiceJour to new table")

## Workflow

### Step 1: Identify objects affected
Parse $ARGUMENTS to extract object names (tables, classes, fields, enums).

Run in parallel:
- `d365_search` with keywords — find all related objects
- `xref_impact_analysis` for each object — full dependency tree
- `xref_find_extensions` for each object — existing customizations
- `d365_lookup_table` or `d365_get_class_methods` — current structure

### Step 2: Cross-module dependency analysis
- `xref_cross_module_deps` for each affected object — which modules depend on this
- `xref_find_event_handlers` — event handlers that will be affected
- Map all module boundaries that the change crosses

### Step 3: Data model impact (if table/field change)
- `d365_get_join_keys` between affected table and its relations — join paths at risk
- `d365_find_referencing_tables` — FK relationships that reference the table
- `d365_get_entity_sources` — data entities/integrations that expose the table
- `d365_check_field_exists` — verify field assumptions

### Step 4: Security impact
- `sec_permission_trace` for affected objects — who has access currently
- Assess if the change alters permission requirements
- Flag if new privileges or duties need to be created

### Step 5: Integration surface
- `d365_get_entity_sources` for affected tables — OData entities at risk
- Check for batch jobs, workflows, or external integrations

### Step 6: Present impact assessment

**Change Impact Assessment**
**Change:** $ARGUMENTS
**Assessed by:** [Architect]
**Date:** [today]

**1. Blast Radius**
| Metric | Count |
|--------|-------|
| Direct dependents | N |
| Transitive dependents | N |
| Modules affected | N (list) |
| Extensions at risk | N |
| Event handlers at risk | N |
| Data entities affected | N |
| Users impacted | N (via security roles) |

**2. Module Impact Map**
| Module | Objects Affected | Risk Level |
|--------|-----------------|------------|

**3. Breaking Changes**
| Object | Type | Impact | Migration Required |
|--------|------|--------|-------------------|

**4. Data Model Effects**
| Table | Change | FK Impact | Entity Impact |
|-------|--------|-----------|---------------|

**5. Security Implications**
- New privileges required: [list or "none"]
- Roles affected: [list]
- SoD considerations: [any]

**6. Integration Risk**
| Integration Point | Type | Risk | Action |
|-------------------|------|------|--------|

**7. Recommendation**

| Aspect | Assessment |
|--------|-----------|
| **Risk Level** | Low / Medium / High / Critical |
| **Approach** | Proceed / Proceed with caution / Needs redesign |
| **Testing Scope** | Unit / Integration / Full regression |
| **Coordination** | None / Within team / Cross-team |
| **Rollback Plan** | Simple / Complex / Not possible |

**8. Required Actions Before Change**
1. [Ordered prerequisite steps]

**9. Suggested Test Cases**
- [Key scenarios to validate]
