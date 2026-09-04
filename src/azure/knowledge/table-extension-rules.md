---
topic: table-extension-rules
title: Table extensions — what you may add and change
aliases: table-extension, extension-field, add-field, add-index, add-relation
tags: extensibility, table, fields, index, relation, naming
---
- An `AxTableExtension` is named `<Table>.<Suffix>` (e.g. `CustTable.iExtension`); the suffix identifies the model. The KB merges its fields into the base table flagged `is_extension = 1` with `source_module` — `d365_effective_schema` shows the merged shape, `d365_lookup_table(custom_only: true)` only the added surface.
- You may ADD: fields, field groups, indexes (non-clustered), relations, delete actions, table methods (via CoC / static extension methods), and EDT-based fields. Prefix every new element with the model prefix (`d365_preflight(proposed_names, KB_NAMING_PREFIXES)`).
- You may CHANGE only extensible properties of existing elements — typically label, help text, visibility of the field group placement, `Extended Data Type` on fields that still have none, enum extension values. Core properties (type, mandatory, string size beyond the EDT, the primary index, `SaveDataPerCompany`, `TableGroup`) belong to the base model.
- You may NOT remove or rename base fields, indexes or relations, and you cannot change the clustered index or the replacement key.
- A new unique index on a base table is a data risk: existing rows may violate it. A new relation with `Validate = Yes` changes lookup and validation behaviour on the base form.
- Fields on a table extension are still a compile-time customisation. Runtime "custom fields" created in System administration > Custom fields (`*_Custom` suffix) are NOT in any model — read them with `d365_custom_fields`.
- Check first: `d365_check_field_exists` (also catches `_Custom` runtime fields), `xref_find_field_usages` for the fields you touch, `d365_get_join_keys` before adding a relation.
