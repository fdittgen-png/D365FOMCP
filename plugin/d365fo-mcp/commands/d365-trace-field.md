---
description: Traces one D365FO field end-to-end — existence, type/EDT, enum values, AX2012 rename history, read/write usages, and join keys. Use when the user gives a Table.Field reference and wants to verify or understand that field.
argument-hint: <Table.Field>
---

# D365 Field Trace

## Task
Trace `$ARGUMENTS` (parse into tableName and fieldName on the dot) across the D365 ecosystem.
**Done when:** existence and type are confirmed via `d365_check_field_exists` (never asserted from memory), enum/FK details are resolved, and usage is reported.

## Workflow

### Step 1: Validate and gather metadata (parallel)
Run ALL in parallel:
- `d365kb:d365_check_field_exists` with tableName, fieldName — confirms existence, returns type/EDT
- `d365kb:d365_field_renames` with fieldName — AX2012 rename history
- `d365xref:xref_find_field_usages` with tableName, fieldName — who reads/writes this field
- `d365kb:d365_find_referencing_tables` with tableName — tables with FK to the parent table

If the field does not exist, report the similar-name suggestions from the tool and stop — do not analyze a guessed field.

### Step 2: Resolve type details
- **Enum type** → `d365kb:d365_get_enum` for all values with numeric codes
- **EDT type** → note the EDT and its base type
- **FK to another table** → `d365kb:d365_get_join_keys` between the two tables

## Output

**Field: `Table.Field`**

| Property | Value |
|----------|-------|
| Type | (from check_field_exists) |
| EDT | (if applicable) |
| Enum values | (if applicable) |
| Mandatory | Yes/No |
| AX2012 Name | (if renamed) |

Then: **Usage Analysis** (read by / written by, top 10 each) and **Join Keys** (if FK).

## Follow-ups to offer
- View source of a specific caller
- Impact of modifying this field (`/d365-impact`)
- Documentation about the field's purpose (`/d365-research`)
