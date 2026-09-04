---
topic: naming-conventions
title: Naming conventions for custom and extension objects
aliases: naming, prefix, suffix, object-names
tags: naming, extensibility, best-practice
---
- **Prefix every new object** (tables, classes, enums, EDTs, forms, menu items, security objects, label files) with the model prefix so names never collide with Microsoft or ISV objects added later. The KB enforces it when `KB_NAMING_PREFIXES` is set (`d365_preflight(proposed_names)` → `prefix_ok`).
- **Extension objects** carry the base name plus a dot and a model-specific suffix: `CustTable.ABC` (table/form/enum/EDT/menu/menu-item extensions). The suffix identifies the model, not the change.
- **Extension classes** (CoC) are conventionally `<Base>_<Prefix>_Extension` or `<Base><Prefix>_Extension`; keep the `_Extension` suffix — `xref_find_extensions` and `d365_preflight.existing_extensions` find wrappers by that convention.
- **Event handler classes** group subscribers per target: `<Base>_<Prefix>EventHandler`.
- **New fields on extensions** are prefixed too (`ABCContractRef`), because they share the base table's namespace with fields Microsoft may add.
- Identifiers: letters, digits, underscore, not starting with a digit; case-insensitive uniqueness (`CustTable` and `custTable` are the same object). Avoid names differing from an existing object only by case or by an underscore.
- Before naming anything: `d365_preflight(proposed_names: [...])` checks `object_paths`, menu items, the object catalogue and the sealed-ISV element inventory in one call; `xref_check_exists` confirms against the compiler cross-reference.
