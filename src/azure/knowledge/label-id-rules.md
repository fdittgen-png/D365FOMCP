---
topic: label-id-rules
title: Label ids — @SYS, @Prefix:Key, label files and languages
aliases: labels, label-file, translations, sys-labels
tags: labels, localization, naming
---
- Two id shapes: legacy numbered `@SYS12345` (`@` + label-file id + number, Microsoft and old ISV files) and the current `@<LabelFileId>:<Key>` (e.g. `@LAC:InvoiceDate`). Both resolve through `d365_resolve_label`; the sealed-ISV files (`@LAC*`, `@ABA*`) are in the KB since the ISV scan.
- Never edit a Microsoft label file. Create your OWN label file per model (`AxLabelFile`, one `.label.txt` per language under `LabelResources/<lang>/`), give it a short id distinct from the model name, and reference labels as `@<Id>:<Key>`.
- A label file id is global across the metadata store: two models with the same label-file id collide at deploy time. Check with `d365_preflight(proposed_names: ['MyLabelFileId'])` against `object_paths`/`isv_elements` and with `d365_search(object_type: 'label')` before choosing a key.
- Every language you ship needs the same keys; a missing translation falls back to the raw id at runtime (the `@ABC:Key` you see on a form). Reverse lookup ("which label says *Search string*") is `d365_search(query, object_type: 'label')`; the language allow-list of the KB build is `KB_LABEL_LANGUAGES`.
- Where-used for a label id is the XRef: `xref_find_references('@SYS9694')` lists every form control, report field, menu item and X++ literal that references it.
- Labels in X++: `"@SYS12345"` literals are resolved at runtime with `SysLabel::labelId2String(literalStr("@SYS12345"))`; prefer `literalStr` so the compiler cross-references the label.
