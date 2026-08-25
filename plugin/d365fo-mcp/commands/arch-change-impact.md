---
description: Produces a full architectural impact assessment for a proposed D365FO change — dependency blast radius, breaking changes, data model and security effects, integration risk, and a go/no-go recommendation. Use before approving change requests; for a quick single-object check use /d365-impact.
argument-hint: <change description, e.g. "add field to SalesTable">
---

# Architect: Change Impact Assessment

## Task
Assess the architectural impact of the change described in `$ARGUMENTS` for a solution architect deciding whether to approve it.
**Done when:** the report quantifies the blast radius from xref data (not estimates), lists concrete breaking changes, and closes with a defensible risk rating and prerequisite actions. Numbers you could not obtain from the tools are marked "not measured", never guessed.

## Workflow
Parse `$ARGUMENTS` to extract object names (tables, classes, fields, enums), then investigate each dimension — run independent calls in parallel:

**Code dependencies**
- `d365kb:d365_search` (related objects), `d365xref:xref_impact_analysis` (dependency tree), `d365xref:xref_find_extensions` (existing customizations), `d365kb:d365_lookup_table` / `d365kb:d365_get_class_methods` (current structure)

**Cross-module**
- `d365xref:xref_cross_module_deps` per affected object, `d365xref:xref_find_event_handlers` — map every module boundary the change crosses

**Data model** (if table/field change)
- `d365kb:d365_get_join_keys` (join paths at risk), `d365kb:d365_find_referencing_tables` (FKs), `d365kb:d365_get_entity_sources` (data entities exposing the table), `d365kb:d365_check_field_exists` (verify every field assumption — never from memory)

**Security**
- `d365sec:sec_permission_trace` for affected objects; assess whether permission requirements change; flag new privileges/duties needed

**Integration surface**
- Data entities at risk, batch jobs, workflows, external integrations touching the objects

## Output

**Change Impact Assessment** — Change: $ARGUMENTS, Date: [today]

1. **Blast Radius** table: direct dependents, transitive dependents, modules affected, extensions at risk, event handlers at risk, data entities affected, users impacted (via roles)
2. **Module Impact Map**: Module | Objects Affected | Risk Level
3. **Breaking Changes**: Object | Type | Impact | Migration Required
4. **Data Model Effects**: Table | Change | FK Impact | Entity Impact
5. **Security Implications**: new privileges required, roles affected, SoD considerations
6. **Integration Risk**: Integration Point | Type | Risk | Action
7. **Recommendation** table: Risk Level (Low/Medium/High/Critical), Approach (Proceed / Proceed with caution / Needs redesign), Testing Scope, Coordination, Rollback Plan
8. **Required Actions Before Change** — ordered prerequisites
9. **Suggested Test Cases** — key scenarios to validate

Adapt sections to the change type — drop irrelevant ones rather than filling them with "N/A".
