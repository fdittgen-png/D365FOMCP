# KB Completeness Backlog

Tracks which D365FO metadata object types the Knowledge Base builder
(`build/build-kb.js`) captures vs. what Visual Studio exposes. Goal: the
`d365kb` MCP service should be able to answer anything visible in the AOT.

Counts below are from the customization models in `C:\Workspace\DEV\Metadata`
(a representative sample); the Microsoft base contains the same object types at
much larger scale.

## Captured

| Object type | Notes |
|---|---|
| AxTable | fields, indexes, relations, **methods** |
| AxTableExtension | added fields (flagged `is_extension`/`source_module`), relations; base table flagged `is_customized` |
| AxClass | + methods |
| AxEnum / AxEnumExtension | values; extension values unioned into the base enum |
| AxEdt | — |
| AxDataEntityView | fields, **entity methods** (`owner_type='entity'`), `method_count` |
| AxDataEntityViewExtension | extension fields + methods merged into the base entity |
| AxForm / AxFormExtension | form: label + datasources (shallow); extension: path only |
| AxView | header only (shallow) |
| AxMenuItem{Display,Action,Output} | — |
| AxSecurityRole / Duty / Privilege | also in the dedicated `d365sec` service (deeper) |
| Labels | en-US resolved |

## Partial (shallow capture — candidates to deepen)

- **AxForm** — no form methods or control tree; only label + data sources.
- **AxView** — no field detail or methods.
- **AxFormExtension** — recorded as object_path + graph edge only (no added controls/methods).

## Missing (prioritized)

### Tranche 1 — recommended next (high value, fits existing patterns)
- **AxQuery** (24) — queries: data sources, ranges, joins. New `queries` table + extractor; surface via a `d365_lookup_query` tool or `d365_get_entity_sources`-style.
- **AxCompositeDataEntityView** (9) — composite entities (sub-entities). Extends the entity model already in place.
- **Remaining `*Extension`s** for customization completeness:
  - AxQuerySimpleExtension (13)
  - AxEdtExtension (7)
  - AxViewExtension (2)
  - AxMenuExtension (10)
  - AxSecurityDutyExtension (1) — note: security extensions belong to the `d365sec` builder, not KB.

### Tranche 2 — larger, separate efforts
- **AxReport** (19) — SSRS reports + datasets/parameters.
- **AxMap / AxMapExtension** — shared field maps.
- **AxService / AxServiceGroup** — service endpoints/operations.
- **AxWorkflow\*** (templates, approvals, tasks, providers).
- **AxAggregate\*** (measurements, dimensions, calculated measures) — analytics.
- UI parts: **AxKPI, AxTile, AxPage, AxFormPart, AxInfoPart, AxPartCue**.
- **AxConfigurationKey / AxLicenseCode** — referenced by `config_key` columns today but not captured as objects.
- **AxSecurityPolicy** (XDS) / **AxSecurityDirectAccessPermission** — security (relevant to the `d365sec` service; tracked in the sec completeness concept).
- **AxEventSubscription**, **AxTableCollection**, **AxMacroDictionary**, **AxReference**, **AxMenu**.

## Implementation checklist for each new object type
1. Schema table(s) in `SCHEMA_SQL` (+ indexes).
2. `extractXxx()` + prepared statements (both `prepareStatements` and `prepareStatementsForSqlJs`).
3. `processAxType('AxXxx', extractXxx)` pass in `main()`.
4. FTS enrichment in `buildFtsIndex()`; `object_paths` row.
5. Extension variants: parse `<Name>` as `Base.suffix`, merge into the base object (see `extractTableExtension` / `extractDataEntityExtension`).
6. A `d365_*` tool (typed-first, response-format contract) + tests.
7. Bump `kb_metadata.schema_version`.
8. Rebuild + upload (see `docs/` / the KB upload backoffice).
