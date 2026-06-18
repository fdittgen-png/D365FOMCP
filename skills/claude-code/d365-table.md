# D365 Table Deep Dive

Comprehensive analysis of a D365 table: structure, usage, security, and documentation.

## Arguments
- $ARGUMENTS: Table name (e.g., CustTable, SalesTable, InventTable)

## Workflow

Analyze the D365 table `$ARGUMENTS` using all available MCP services in parallel for maximum efficiency.

### Step 1: Gather all metadata (parallel)
Run ALL of these in parallel:
- `d365_lookup_table` with tableName = `$ARGUMENTS` (fields, indexes, relations, properties)
- `xref_object_summary` with objectName = `$ARGUMENTS` (reference counts, top callers)
- `xref_find_extensions` with objectName = `$ARGUMENTS` (CoC extensions and overlayering)
- `d365_find_referencing_tables` with tableName = `$ARGUMENTS` (foreign keys pointing to this table)

### Step 2: Present structured summary
Organize findings into:

1. **Table Overview**: Module, table group, cache lookup, record count context
2. **Key Fields**: List important fields with types and EDTs. Flag enum fields. **Flag customizations:** `d365_lookup_table` reports `is_customized`, `custom_field_count`, and `customization_modules`; each field carries `is_extension`/`source_module`, so call out which fields are added by customization models (e.g. `iExtension`) vs. standard.
3. **Indexes**: Unique and non-unique, clustered index
4. **Relations**: Outgoing FKs (this table references) and incoming FKs (tables referencing this)
5. **Extensions**: Any CoC or event handler extensions found
6. **Usage Hotspots**: Top 10 callers/consumers from xref
7. **Related Entities**: Data entities backed by this table (if found in relations)

### Step 3: Resolve enums (if any enum fields found)
For each enum-type field discovered in Step 1, call `d365_get_enum` to get the value mappings.

### Step 4: Offer next steps
Ask the user if they want to:
- Drill into a specific field's usage (`xref_find_field_usages`)
- Check security access (`sec_permission_trace`)
- See the method source code (`d365_get_class_methods`)
- Get join keys to another table (`d365_get_join_keys`)
