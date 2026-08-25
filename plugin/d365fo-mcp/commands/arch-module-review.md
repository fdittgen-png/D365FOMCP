---
description: Architectural health review of a D365FO module or model — object inventory, dependency map, extension surface, security model, and upgrade risk. Use when evaluating module health, planning upgrades, or assessing ISV/custom models.
argument-hint: <ModuleName, e.g. ApplicationSuite>
---

# Architect: Module Review

## Task
Review the architecture of module/model `$ARGUMENTS`.
**Done when:** the review presents measured inventory and dependency data (from the MCP services, not estimates), an extension-surface breakdown by source model, and upgrade-risk ratings each justified by a stated observation.

## Workflow

### Step 1: Module overview (parallel)
- `d365kb:d365_get_module_summary` — object counts by type
- `d365xref:xref_module_objects` — top-level objects list
- `d365xref:xref_list_modules` — verify the module exists and see its position among all modules
- `d365xref:xref_cross_module_deps` — inbound and outbound dependencies

### Step 2: Dependency analysis
From cross_module_deps: identify upstream modules (this depends on) and downstream modules (depend on this); drill into the heaviest crossings with a second `xref_cross_module_deps` pass.

### Step 3: Extension & customization surface
- `d365xref:xref_find_extensions` on key objects — CoC and extensions, counted BY source model (which ISV/custom models extend this module)
- `d365xref:xref_find_event_handlers` for key classes

### Step 4: Security and data model statistics
Use `d365sec:sec_raw_sql` and `d365kb:d365_raw_sql` to count roles/duties/privileges scoped to the module and to rank its largest tables. Check the actual schema before writing these queries (column names differ between service builds); aggregate — never enumerate role×privilege combinations.

## Output

**Module Architecture Review: $ARGUMENTS**

1. **Module Summary** table: tables, classes, forms, data entities, enums, security roles/duties
2. **Dependency Map**: upstream/downstream diagram + table (Direction | Module | Objects Crossing | Risk)
3. **Top Tables** by complexity: Table | Fields | Group | Relations | Key Purpose
4. **Extension Surface**: Extending Model | Extensions | Event Handlers | Risk
5. **Security Model**: Tier | Role | Duties | Access Level
6. **Upgrade Risk Assessment**: rating per factor (upstream deps, downstream consumers, extension density, custom model coupling) — each with the observation that justifies it
7. **Recommendations**: health observations, dependency risks, decoupling opportunities, extension governance

Mark any metric the tools could not produce as "not measured" rather than estimating it.
