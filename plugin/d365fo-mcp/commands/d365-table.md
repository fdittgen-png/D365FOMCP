---
description: Produces a full structural analysis of one D365FO table — fields, indexes, relations, extensions, usage hotspots, enums. Use when the user names a table (e.g. CustTable, SalesTable) and wants to understand its structure, dependencies, or customization surface.
argument-hint: <TableName>
---

# D365 Table Deep Dive

## Task
Analyze the D365 table `$ARGUMENTS` across structure, usage, security, and customizations.
**Done when:** the report covers every section below with data from the MCP services, all enum fields are resolved to values, and anything the tools could not confirm is explicitly flagged as unverified.

## Workflow

### Step 1: Gather all metadata (parallel)
Run ALL of these in parallel:
- `d365kb:d365_lookup_table` with tableName = `$ARGUMENTS` (fields, indexes, relations, properties)
- `d365xref:xref_object_summary` with objectName = `$ARGUMENTS` (reference counts, top callers)
- `d365xref:xref_find_extensions` with objectName = `$ARGUMENTS` (CoC extensions and overlayering)
- `d365kb:d365_find_referencing_tables` with tableName = `$ARGUMENTS` (foreign keys pointing to this table)

### Step 2: Resolve enums
For each enum-type field discovered in Step 1, call `d365kb:d365_get_enum` to get the value mappings.

## Output
Organize findings into (adapt sections to what the data shows — drop empty ones, don't pad):

1. **Table Overview**: Module, table group, cache lookup
2. **Key Fields**: important fields with types and EDTs; flag enum fields
3. **Indexes**: unique and non-unique, clustered index
4. **Relations**: outgoing FKs (this table references) and incoming FKs (tables referencing this)
5. **Extensions**: any CoC or event handler extensions found
6. **Usage Hotspots**: top 10 callers/consumers from xref
7. **Related Entities**: data entities backed by this table (if found in relations)

Separate what the tools confirmed from what you inferred; label inferences.

## Follow-ups to offer
- Drill into a specific field's usage (`d365xref:xref_find_field_usages`)
- Check security access (`d365sec:sec_permission_trace`)
- Get join keys to another table (`d365kb:d365_get_join_keys`)
