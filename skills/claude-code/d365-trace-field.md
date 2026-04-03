# D365 Field Trace

Trace a field across the entire D365 ecosystem: existence, type, usage, renames, and enum values.

## Arguments
- $ARGUMENTS: Table.Field (e.g., "CustTable.CustGroup", "SalesTable.SalesStatus", "InventTable.ItemId")

## Workflow

Parse $ARGUMENTS into tableName and fieldName (split on dot).

### Step 1: Validate and gather metadata (parallel)
Run ALL in parallel:
- `d365_check_field_exists` with tableName, fieldName — confirms existence, returns type/EDT
- `d365_field_renames` with fieldName — check AX2012 rename history
- `xref_find_field_usages` with tableName, fieldName — who reads/writes this field
- `d365_find_referencing_tables` with tableName — tables with FK to parent table

### Step 2: Resolve type details
Based on Step 1 results:
- If field is **enum type**: `d365_get_enum` to get all values with numeric codes
- If field is **EDT type**: note the EDT and its base type
- If field is **FK to another table**: `d365_get_join_keys` between the two tables

### Step 3: Present field report

**Field: `tableName`.`fieldName`**

| Property | Value |
|----------|-------|
| Type | (from check_field_exists) |
| EDT | (if applicable) |
| Enum | (if applicable, with values) |
| Mandatory | Yes/No |
| AX2012 Name | (if renamed) |

**Usage Analysis**
- Read by: N objects (top 10 listed)
- Written by: N objects (top 10 listed)

**Enum Values** (if applicable)
| Value | Name |
|-------|------|
| 0 | ... |
| 1 | ... |

**Join Keys** (if FK field)
- Joins to: TargetTable via field1 = field2

### Step 4: Offer next steps
- View source code of a specific caller
- Check impact of modifying this field
- Search documentation about this field's purpose
