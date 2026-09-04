---
topic: form-extension-rules
title: Form extensions — controls, data sources and nested CoC
aliases: form-extension, add-control, form-datasource, form-pattern
tags: extensibility, form, controls, coc, pattern
sources: https://learn.microsoft.com/dynamics365/fin-ops-core/dev-itpro/extensibility/method-wrapping-coc
---
- An `AxFormExtension` is named `<Form>.<Suffix>`. You may add controls (into an existing container, respecting its pattern), data sources (+ ranges, fields), and change extensible properties (label, visible, allow edit) of existing controls. You cannot remove controls or change the form's design pattern.
- Form methods: CoC on the form class itself is limited to ROOT-level methods (`[ExtensionOf(formStr(F))]`, e.g. `init`, `run`, `close`). Methods of nested concepts need one extension class each: `formDataSourceStr(F, DS)` for data-source methods (`init`, `validateWrite`, `write`...), `formDataFieldStr(F, DS, Field)` for field methods (`validate`, `modified`), `formControlStr(F, Control)` for control methods (`clicked`, `modified`). Purely X++ methods declared on nested types compile as CoC but are NOT invoked at runtime.
- Alternative without CoC: `[FormEventHandler]`, `[FormDataSourceEventHandler]`, `[FormControlEventHandler]` static handlers; obtain the form run via `sender.formRun()` and other data sources via `formRun.dataSource(formDataSourceStr(F, DS))`.
- Patterns: every container carries a design pattern (`DetailsMaster`, `SimpleList`, `ListPage`, `TableOfContents`, `Dialog`, `CustomAndQuickFilters` groups...). Adding a control into a patterned container must satisfy that pattern's allowed children or the compiler reports a pattern error. `d365_lookup_form(include_controls: true)` shows the container types and patterns; `d365_find_forms(pattern, table)` finds standard forms to model on.
- Menu items: a new form needs a Display menu item and a privilege granting it — check `d365_lookup_form.menu_items` and `sec_object_access` for the existing entry points.
