# KB / XRef response-size optimisation — implementation record

**Status:** implemented, tested (1205/1205 green), pending deploy
**Date:** 2026-08-28
**Source analysis:** `IMPL_KB_Response_Optimisation.md`, raised from the SUP product-export exercise
**Services touched:** `d365kb` (7 tools), `d365xref` (4 tools)

---

## 1. What the analysis measured

Exporting the product master from SUP via OData, with and without the KB:

| Metric | Without MCP | With MCP |
|---|---:|---:|
| Metadata-discovery tokens | ~5,700 | ~24,000 |
| Metadata-discovery latency | 280.3 s | 1.7 s |
| Custom fields found | 0 of 2 | 2 of 2 |

The latency and correctness case was never in doubt. The token case was bad for one avoidable reason: **two tools returned unfiltered full-table dumps** — `d365_get_entity_sources` (~10,400 tokens, of which 48 unused method signatures) and `d365_list_modules` (~9,300 tokens for all 173 models when 4 were wanted). Together, 82% of the KB token bill for that task.

---

## 2. Two premises in the source analysis that did not hold

Both were checked before implementing, and neither blocks the work.

**P0 "the deployed service is not built from this repo" — no drift.** The analysis inspected a second, older clone of this repository (HEAD `ce4c50d`), which predates the TOON / structured-output / provenance work. The live service is built from this repo, where `format`, `structuredContent`, `encodeToon` and the `model_versions` provenance join are all present. Nothing to reconcile. The useful part of that finding survives: **pin the deployed build to a commit SHA and surface it** — still open, tracked below.

**OPT-4 "`format` is a no-op" — TOON is implemented and does differ.** `structuredResult()` renders the text channel through `encodeToon()`; `toon` and `markdown` are not byte-identical. The observation is explained by `structuredContent` being *deliberately* format-independent — the typed JSON is identical either way; only the text channel changes. Measured honestly on a 284-field entity response: TOON is **5.4% smaller** than the Markdown table (17,334 vs 18,327 chars). TOON's large win is against key-repeating JSON, not against an already-columnar Markdown table — so the advertised "45–60%" does not apply to these shapes. No code change; the claim in the tool descriptions ("token-efficient") stays true but modest, and the real savings come from the filters below.

---

## 3. What was implemented

### d365kb

| Tool | Change | Effect |
|---|---|---|
| `d365_get_entity_sources` | Resolves the **OData collection name and public name** as well as the AOT name (`ReleasedProductsV2` / `ReleasedProductV2` / `EcoResReleasedProductV2Entity` all land on the same entity), in both the exact and the "did you mean" branch | Removes a wasted call and a misleading *not-found* (OPT-3) |
| `d365_get_entity_sources` | `include_methods` defaults to **false**; `method_count` is always returned and the Markdown says how to ask for the list. Without it only a `COUNT(*)` is issued | ~40% off the default response |
| `d365_get_entity_sources` | `custom_only`, `computed_only`, `fields_like`, `limit`; every field row now carries `source_module` + `is_extension` | `custom_only: true` turns a 10k-token dump into a handful of rows (OPT-2) |
| `d365_list_modules` | `origin` (`microsoft`/`isv`/`custom`), `layer`, `publisher` (substring), `include_counts`, `limit`; `returned_count` next to `module_count` | `origin: "custom"` returns the customisation surface instead of ~170 models (OPT-1) |
| `d365_lookup_table` | `fields_like`, `custom_only` (counts, indexes and relations stay whole-table), `fields_shown` | A 400-field table can be inspected for one thing |
| `d365_find_referencing_tables` | `limit` (default 200) + `returned_count` | Bounded |
| `d365_raw_sql` | **Schema in the description corrected.** It advertised `kb_tables`, `kb_fields`, `kb_enums`, `kb_classes`, `kb_methods`, `kb_relations`, `kb_entities` — none of which exist. The real names are `tables`, `fields`, `enums` (+`enum_values`), `classes`, `methods`, `relations`, `data_entities`, `entity_fields`, `modules`, `model_versions`, `labels`, and `kb_search` | Anyone following the old description wrote SQL that could only fail |

### d365xref (OPT-6 sweep — the tools that returned unbounded sets)

| Tool | Change |
|---|---|
| `xref_list_modules` | `origin` / `layer` / `publisher` / `limit` + `returned_count`, mirroring `d365_list_modules` |
| `xref_class_hierarchy` | `limit` (default 200) + `returned_count` / `truncated` — framework base classes have thousands of subclasses |
| `xref_interface_implementors` | `limit` (default 200) + `returned_count` / `truncated` |
| `xref_impact_analysis` | `limit` sizes the listed sample; the `by_kind` / `by_module` counts still cover the full result set |

### Field attribution — how `custom_only` works without a build change

`entity_fields` has no owning-model column. Rather than adding one at build time (which would force a KB rebuild), the field rows are joined to `fields` on `(data_source, data_field)` — the `fields` primary key, so the join cannot multiply rows — and `source_module` / `is_extension` come along. An entity data source that is an alias rather than a table name simply yields a null attribution, and pre-attribution KB builds fall back to the plain query. Open question 2 of the source analysis is therefore answered: **no build-time column needed.**

### Compatibility

- Additive everywhere except one deliberate default change: `d365_get_entity_sources` no longer lists method signatures. `method_count` is always present and the response says how to get them.
- A no-argument `d365_list_modules` / `xref_list_modules` / `d365_lookup_table` call returns exactly what it did before (default limits sit above the current data volumes). Regression tests assert this.
- Output schemas gained `fields_matched` / `fields_returned` / `fields_shown` / `returned_count` / `truncated`. `structuredContent` remains format-independent.

---

## 4. OPT-5 — reclassified, not a scanner bug

The analysis read two missing fields as one scanner gap. They are two different things, and neither is fixable by rescanning:

| Case | Why it is not in the KB |
|---|---|
| `TBGPrintableText_Custom` | The `_Custom` suffix marks a **D365 UI custom field** (System administration › Custom fields). These live in the database, in no metadata model at all — no scanner of any model directory can see them. |
| `LACTransRefRecId`, `LAC*` / `PRN*` | **Binary-only ISV model** (Lasernet). No source metadata to scan. |

What was implemented instead is the honest answer: when a field filter matches nothing, `d365_get_entity_sources` now says both classes exist and that the environment is the place to verify — the tooling skill already carried the same rule for `d365_check_field_exists`. "Not in the metadata snapshot" is the correct claim; "does not exist" never was.

Still worth doing, unchanged from the analysis: **populate `model_versions.version` with the real deployed model version** (`iExtension` currently reports the placeholder `1.0.0.0`), and the **KB-vs-live reconciliation test** (§5 of the source doc) — it needs an OData `$metadata` pull from a nominated environment, so it is a build-pipeline item, not a tool change.

---

## 5. Expected effect on the reference task

| Call | Before | After |
|---|---:|---|
| `d365_get_entity_sources('ReleasedProductsV2')` | not-found, then ~10,400 tokens on the AOT name | resolves first time; ~6,300 default, ~150 with `custom_only: true` |
| `d365_list_modules()` | ~9,263 tokens | ~200 tokens with `origin: "custom"` |

KB discovery for that task lands at roughly **6–8k tokens** — at or below the no-MCP path — while keeping the 165× latency advantage and the correctness advantage. The savings are only realised if the caller passes the filters, which is why the `d365fo-mcp-tooling` skill was updated in the same change ("ask for the slice you need").

---

## 6. Verification

- `npm test` — 1205 tests, 0 failures. New coverage: OData-name resolution, method omission/inclusion, `custom_only` / `computed_only` / `fields_like` / `limit`, both module-filter tools, `d365_lookup_table` narrowing, the bounded xref hierarchies, and the back-compat no-argument calls.
- `npm run gen:plugin-refs` regenerated `skills/d365fo-mcp-tooling/references/{kb,xref}-tools.md`; `test/plugin.test.js` verifies they match the registrations.

## 7. Open items

1. Pin the deployed build to a commit SHA and surface it (e.g. via `kb_metadata`) — the drift question was a false alarm this time, but nothing currently makes it answerable from the outside.
2. Real model versions in `model_versions.version` for custom models.
3. KB-vs-live OData reconciliation test on every KB rebuild.
4. Extend the same "summary by default, detail on request" posture to the sec tools with unbounded shapes (`sec_lookup_role`, `sec_role_hierarchy`, `sec_compare_roles`).
