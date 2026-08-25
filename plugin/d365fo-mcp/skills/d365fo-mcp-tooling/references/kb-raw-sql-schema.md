# `d365_raw_sql` — the real KB schema

_Reference for the `d365fo-mcp-tooling` skill. Read before writing any `d365_raw_sql` query._

**The tool description advertises a schema that does not exist.** It documents `kb_tables(...)`, `kb_fields(...)`, `kb_methods(class_name, method_name, source_code, ...)`, `kb_classes(...)`, `kb_enums(...)`. Queries against those names fail with a generic `"Check your SQL syntax and table/column names. Only read-only SELECT queries are supported."` — which reads like a SQL error but is actually a missing-table error.

**Always discover the schema first:**

```sql
SELECT name FROM sqlite_master WHERE type='table'
```

**Actual tables:** `modules`, `tables`, `fields`, `indexes_tbl`, `relations`, `enums`, `edts`, `classes`, `methods`, `data_entities`, `entity_fields`, `forms`, `views`, `security_roles`, `security_duties`, `security_privileges`, `menu_items`, `graph_edges`, `hallucination_traps`, `field_renames`, `query_templates`, `object_paths`, `labels`, `kb_search`, `kb_metadata`.

**Key column layouts (these differ from the documented ones):**

| Table | Columns |
|---|---|
| `methods` | `owner_type` (`class`/`table`/`entity`), `owner_name`, `method_name`, `signature`, `is_static`, `source_code` |
| `classes` | `class_name`, `module_id`, `extends_class`, `implements_list`, `is_abstract`, `method_count`, `file_path` |
| `kb_metadata` | `key`, `value` |

Note `methods` keys on **`owner_name`**, not `class_name` — that single difference accounts for most failed queries.

### `kb_metadata` — provenance for "verified against source" claims

```sql
SELECT * FROM kb_metadata
```

Returns `d365fo_version` (e.g. `10.0.2645.90` since 2026-08-14), `build_date`, `packages_path`, `custom_packages_paths` (the merged custom models, e.g. `iExtension`, `HISOL`), `has_customizations`, `last_custom_merge`, `schema_version`.

Use it for two things:
1. **Check the KB isn't stale** before quoting source code in a customer-facing deliverable.
2. **Cite the exact build** in the deliverable — "verified against D365FO 10.0.2527.130" is a materially stronger statement than "verified against source", and it tells a future reader when the claim expires.

### Practical notes

- A generic syntax error from this tool is almost always a **wrong table or column name**, not malformed SQL. Check `sqlite_master` before rewriting the query.
- The KB is a **single-version snapshot**. It can prove an object exists in build X; it can never tell you when an object was introduced. Do not attempt version archaeology with it (and note that local `PackagesLocalDirectory` folders for older versions are empty shells, so there is nothing to diff either).
- Custom packages are merged in, so `WHERE module_id IN ('iExtension','HISOL')` is an effective way to inventory Trelleborg customisations — e.g. finding every custom class touching a given area before an impact assessment.

### Part 9 additions (2026-08-18, ODJP reservation-entity session)

- **`d365_raw_sql` works** on the current deploy (the v1.3 "confirmed broken" note is obsolete). The generic error message still means *wrong table/column name* 9 times out of 10.
- **`PRAGMA table_info` / `pragma_table_info('x')` silently returns 0 rows** — no error, just empty. To get a table's columns use `SELECT sql FROM sqlite_master WHERE type='table' AND name='<table>'` (returns the full CREATE TABLE).
- **Entity-catalog columns** (for "is there a standard entity for X?" feasibility checks):
  - `data_entities(entity_name, module_id, label, public_name, public_collection, is_public, primary_table, staging_table, config_key, file_path, method_count)`
  - `entity_fields(entity_name, field_name, data_field, data_source, is_mandatory)`
  - Search **name AND label** (`entity_name LIKE '%Reserv%' OR label LIKE '%reserv%'`) — the label match is what surfaces entities whose AOT name doesn't contain the business term (e.g. "Order-committed reservations per license plate"). `is_mandatory` gives the Excel-add-in required-column list without opening the AOT.
- `forms` has a `form_name` column — quick existence check for "which form is this page?" (e.g. the Reservation page = `InventOnhandReserve`).
