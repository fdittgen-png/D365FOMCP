# Concept: D365 Labels MCP service (`d365fo-labels`)

A fifth MCP service that answers "what does label `@SYS154828` say, in every language,
and what is it for" — the label text per language **always paired with the developer
description** (the ` ;` comment line under each label, e.g. `Duty`, `[SecurityDuty FIM]`),
because the description is the only hint in the label file about where a label is meant
to be used. It joins the KB (which object carries the label) and XRef (where the label is
referenced, on which property). Written 2026-09-08 from an investigation of the repo,
the local snapshots and the label files on disk. **Status 2026-09-08: implemented on
branch `feat/labels-service` (PR #143) — builder, four tools, fifth server, pipeline hooks,
deploy scripts; first real build measured in §4.** Plan: `docs/superpowers/plans/2026-09-08-labels-service.md`.

## 1. What exists today (measured)

| Fact | Value | Source |
|---|---|---|
| Label files on disk, Microsoft packages | 76 language folders, ~330 `.label.txt` per language, 22 MB en-US, 2.9 GB all languages | `find` over `PackagesLocalDirectory/*/*/AxLabelFile/LabelResources/` |
| Custom models (`C:\Workspace\MAIN\Metadata`) | 7 files: HISOL/HSAPAC en-US + vi-VN/sv/fr/de, 2 other en-US | same walk |
| Description lines | SYS en-US: 122,272 labels / 78,311 descriptions (64%); AccountsPayable: 1,827 / 1,744 (95%); HSAPAC: 5,331 / 2,963 | `awk` on the files |
| Description is **language-independent** | `AccountsPayable.de` carries the identical ` ;Duty` lines as en-US; 41 diff lines = 27 labels missing in de, not different comments | `diff` en-US vs de |
| Description is single-line | 0 cases of two consecutive ` ;` lines in SYS en-US | `awk` |
| Encoding | UTF-8 with BOM, CRLF | `xxd` |
| KB `labels` (local snapshot, schema **1.1**, 2026-08-14) | 534,413 rows, en-US only, columns `label_id, text` — 223,874 numeric ids + 158,692 `@File:Key` + 151,847 bare duplicates ⇒ ≈383k distinct labels | `d365fo_kb.sqlite` |
| KB labels v2 code (#84/#127) | shipped in `build/build-kb.js` (`labels(label_id, language, text, label_file, module)`, FTS5, `KB_LABEL_LANGUAGES` default en-US) but **the local snapshot is pre-v2** — never rebuilt since | `PRAGMA table_info(labels)` |
| **KB parser drops the description** | `labelLines()` skips every line starting with ` ;` | `build/build-kb.js:322` |
| **KB keeps no label id on objects** | `tables.label`, `fields.label`, … are the resolved en-US text; `resolveLabel(t.Label)` discards the id | DDL, lines 474–671 |
| XRef label graph | 225,686 `/Labels/@…` names (123,900 named `@File:Key`), **558,572 inbound refs**; kind 2 (property read) 402,461, kind 1 (code use) 156,111 | `d365fo_xref.sqlite` |
| XRef encodes the **property** | source path `Table/CustTable/TableFieldString/AccountNum?Label`; top properties: Label 246k, Caption 68k, HelpText 28k, Text 24k, DeveloperDocumentation 19k, Description 8k, PromptString 5.5k, SingularLabel, GroupPrompt… | `refs ⋈ names` |
| Sealed ISV labels | `isv_labels(label_id, language, text, module, label_file, qualified_id)`, 153,054 rows, 31 languages, no description (binary store) | `isv-schema.js` |
| Delta merge | `mergeCustomKb()` does `INSERT OR IGNORE INTO labels` — a **changed** text or a **removed** label never updates until the weekly full rebuild | `build/merge-kb-custom.js:221` |

Two consequences drive the design:

1. **The description is the missing column, not a missing service.** Everything else
   (id → text, text → id, where-used with property) already has a home; the description
   was dropped by the parser and exists nowhere in any snapshot.
2. **The id → object direction goes through XRef, not KB.** The KB resolved the label
   at build time and kept only the text. XRef kept the id *and* the property. So
   "which label does `CustTable` carry on which property" is an XRef question, and the
   Labels service should read the XRef graph rather than force a KB schema change.

## 2. Options

| | A — fold into KB | **B — own DB + own server (recommended)** | C — own server over the KB DB |
|---|---|---|---|
| Data | add `description` to KB `labels`, all languages into the KB | `d365fo_labels.sqlite`, built by the KB pipeline | KB `labels` v2 + description |
| KB size | +1–2 GB on a 1 GB file; every `d365_*` handle pays for it | KB unchanged (en-US resolver stays) | KB +1–2 GB |
| `tools/list` | +3 tools on the already-largest list (91.9 KB, ceiling 93.7 KB — **would breach**) | own list, ~4 tools, est. ≤ 12 KB, paid only by sessions that connect it | own list |
| Delta refresh | via `mergeCustomKb` (INSERT OR IGNORE problem) | per-model delete + insert in the labels builder | as A |
| Cross-service | direct SQL | reads XRef read-only for where-used (same `/home/data`) | as B |
| Verdict | cheapest to code, wrong cost profile | matches how ISV/XRef/Sec are separated: one concern, one file | splits one file across two servers — two freshness banners for one build |

**B**: the ask is a service, the data is 100× the KB's current label footprint, and a
label question is asked by a translator/functional consultant who does not need 32 KB
tools in context. Sessions that only need en-US in-context resolution keep using
`d365_resolve_label` (CORE profile) and never connect the fifth server.

## 3. Recommended design

### 3.1 Data — `d365fo_labels.sqlite`

Built with **better-sqlite3 directly**, not sql.js: 76 languages × ~383k ids ≈ 25–29M
rows do not fit the in-memory sql.js path `build-kb.js` uses (the KB finalizes FTS with
better-sqlite3 for the same reason). Estimated 1.5–2.5 GB with FTS; the XRef file is
already 3.3 GB on the same `/home/data`, so the host is sized for it.

```sql
-- one row per label id, language-independent facts
CREATE TABLE label_meta (
  label_id    TEXT PRIMARY KEY,          -- canonical: '@SYS154828' | '@AccountsPayable:VendVendorMasterIntegrationMaintain'
  label_file  TEXT NOT NULL,             -- 'SYS', 'AccountsPayable', 'HSAPAC', 'LAC'
  module      TEXT NOT NULL,             -- model that owns the file
  origin      TEXT NOT NULL,             -- microsoft | isv | custom (model_versions, rule of model-descriptors.js)
  description TEXT                        -- the ' ;' line; NULL when the file has none
);
-- one row per (id, language); text only
CREATE TABLE labels (
  label_id TEXT NOT NULL, language TEXT NOT NULL, text TEXT NOT NULL,
  PRIMARY KEY (label_id, language)
) WITHOUT ROWID;
CREATE VIRTUAL TABLE labels_fts USING fts5(text, content='', tokenize='unicode61 remove_diacritics 2');  -- external content, keyed (label_id, language) via a shadow rowid table
CREATE TABLE label_languages (language TEXT PRIMARY KEY, label_count INTEGER, file_count INTEGER);
CREATE TABLE label_files (label_file TEXT, language TEXT, module TEXT, path TEXT, label_count INTEGER, description_count INTEGER, PRIMARY KEY (label_file, language));
CREATE TABLE labels_metadata (key TEXT PRIMARY KEY, value TEXT);  -- build_date, schema_version, packages_path, languages, partial_build
-- model_versions: same table/DDL as the other three DBs (insertModelVersions)
```

Design rules carried over from the KB:

- **Description stored once** (`label_meta`), never per language — measured identical
  across language files; storing it per row would be 76× the bytes for zero information.
  The builder takes it from the first file that has it and **records a data-quality count**
  when a later language file disagrees (expected 0; if not 0 the assumption is wrong and
  the schema moves it to `labels`).
- **Canonical id** = the form the XRef and the KB use: numeric ids keep their `@SYS…`
  form as written; named keys become `@<File>:<Key>`. Inputs accept `@SYS154828`,
  `SYS154828`, `@AccountsPayable:Key` and `AccountsPayable:Key` (normalised at the
  handler, one regex shared with `d365_resolve_label`).
- **Parser**: `labelLines()` is generalised to yield `{key, value, description}` — a
  ` ;`/`\t;` line attaches to the **preceding** label; BOM stripped; CRLF tolerated;
  a description with no preceding label is counted, not stored. The KB builder imports the
  same function (one parser, two consumers) and keeps ignoring the description.
- **Sealed ISV labels** are folded in with `origin='isv'` from the same `isv-parsers.js`
  label-store decoder (31 languages, no description, `description=NULL`, provenance line
  on every response that includes one — `isvProvenance()`).
- **Language set**: `LABELS_LANGUAGES=all` (default — the point of the service) or a comma
  list for a small build. The response always states the languages *present in the
  snapshot* so a missing language is a coverage fact, not a miss.

### 3.2 Tools (4) — prefix `labels_`, server `d365fo-labels`

Every tool follows the response contract (H2, `_Labels snapshot: <date>_` banner from
`withFreshnessBanner`, typed-first `structuredResult`, `READ_ONLY_DB_ANNOTATIONS`,
`coverageKeys`, cursor pagination where list-shaped, rule #14 same keys on every row).

| Tool | Input | Output (typed) | Notes |
|---|---|---|---|
| `labels_lookup` | `label_ids[]` 1..100, `languages[]` optional (default: **all present**), `format` | `labels[]` rows `{label_id, language, text}` + `meta[]` rows `{label_id, label_file, module, origin, description}` hoisted once per id (rule #14 hoist — description is not repeated 76×), `not_found[]`, `languages_missing[]` `{label_id, languages[]}` | **The description is always on the response**, as the ask requires. `label_meta` is always returned even when a language filter yields 0 text rows. Single-id call = batch of one (#118 style, no singular alias). |
| `labels_search` | `text` (FTS, ≥2 chars, LIKE fallback), `language` optional, `label_file`/`modules` optional, `origin` optional, `limit` ≤100 default 20, `cursor` | rows `{label_id, language, text, label_file, description}` + `pageMeta()` | Reverse lookup ("the UI says *Kreditor sperren*, which label is it"). Description included per row here because rows are heterogeneous ids. |
| `labels_where_used` | `label_id`, `property` optional (`Label`/`HelpText`/`Caption`/…/`Code`), `object_type` optional, `limit`, `cursor` | `usages[]` `{object_type, object_name, element, property, kind}` grouped, `property_counts[]`, `total_count` + the label's `meta` | **Reads the XRef DB read-only** (`getXrefDb()`): `refs ⋈ names WHERE target = '/Labels/<id>'`, parsing `Type/Object[/Element]?Property`; kind 1 = X++ code use (`element` = method), kind 2 = metadata property. Coverage: `xref_unavailable` when no XRef DB is configured (local stdio without `XREF_DB_PATH`), `isv_excluded` as XRef does today. |
| `labels_for_object` | `object_type`, `object_name`, `languages[]` optional (default en-US), `properties[]` optional | rows `{element, property, label_id, language, text, description}` | The KB gap closed without a KB schema change: "which labels does `CustTable` carry, on which property" via the XRef graph + this DB's texts. `element` = field/control/method or `''` for the object itself. |

Not built: a `labels_stats` tool — the `d365://snapshot` resource (service, build_date,
languages, counts) already covers it for free on `tools/list`.

`d365_resolve_label` (KB, CORE) is **unchanged** in shape; its description gains one
clause: "all languages + description + where-used: `d365fo-labels` service". The KB
`labels` table stays en-US-by-default and resolver-only — the KB does not grow.

### 3.3 Response example (`labels_lookup`, 1 id, 3 languages present of 3 requested)

```
## Label lookup
_Labels snapshot: 2026-09-10_

meta[1]{label_id,label_file,module,origin,description}:
  @AccountsPayable:VendVendorMasterIntegrationMaintain,AccountsPayable,ApplicationSuite,microsoft,Duty
labels[3]{label_id,language,text}:
  @AccountsPayable:VendVendorMasterIntegrationMaintain,de,Masterdaten von Kreditoren über Datendienste verwalten
  @AccountsPayable:VendVendorMasterIntegrationMaintain,en-US,Maintain vendor master data using data services
  @AccountsPayable:VendVendorMasterIntegrationMaintain,fr,…
```

### 3.4 Build integration — "part of the KB metadata update"

The labels DB is refreshed by the **same three paths** that refresh the KB, in the same
order, so it can never be older than the KB it accompanies:

| Path | Today | With labels |
|---|---|---|
| `npm run build:kb` (full) | `buildKnowledgeBase()` → `isv-scan.js` (non-fatal) | → **`build/labels-scan.js`** (non-fatal, same pattern): full rebuild of `d365fo_labels.sqlite` from `KB_PACKAGES_PATHS` + `ISV_SCAN_PATHS`; `LABELS_DB_PATH` default `~/.claude/d365fo_labels.sqlite`; `LABELS_SCAN=off` disables |
| `build/update-kb-model.js` (per compile, MSBuild hook) | scoped `buildKnowledgeBase` + `mergeCustomKb` | → **`update-labels-model.js`**: for each compiled model `DELETE … WHERE module = ?` then re-insert its files, one transaction, fingerprint (`size+mtime` of the model's label files) to skip unchanged — fixes the INSERT-OR-IGNORE staleness the KB still has |
| `Publish-McpDataWeekly.ps1` → `Deploy.ps1 -Databases kb,xref` | 3-DB list | `-Databases` gains `labels`; `Deploy.ps1`/`Deploy-FunctionApp.ps1` upload `/home/data/d365fo_labels.sqlite`; health block checks `/api/d365labels` (Expect=401) + `labels_lookup` smoke |

`labels_metadata.partial_build` is set by the delta path and cleared by the full build,
surfacing as the existing `partial_build` coverage line.

### 3.5 Service wiring checklist (each item has a test that fails today if skipped)

- `src/azure/server-metadata.js` — `SERVICES.labels` (`name: 'd365fo-labels'`, title
  "D365 F&O Labels", ≤600-char `instructions`: "lookup = ids→all languages + description ·
  search = text→id · where_used = XRef graph by property · for_object = object→its
  labels"); `test/server-metadata.test.js` name map.
- `src/azure/shared.js` — `getLabelsDb()` (+ `ensureLabelsIndexes` twin of `kb-indexes.js`),
  `LABELS_DB_PATH` default `/home/data/d365fo_labels.sqlite`; `freshnessBanner` service
  label `Labels`.
- `src/azure/labels-tools.js` — `registerLabelsTools(server, db, { xrefDb })`; output schemas
  in `output-schemas.js` with `coverageKeys` spread first.
- `src/azure/tool-sets.js` — `TOOL_SETS.labels`, `registerAllLabelsTools`; `TITLE_PREFIXES`
  gets `labels`.
- `src/functions/d365labels.js` (route `api/d365labels`, self-prefixed) + `index.js`
  import; `src/local/mcp-server-labels.js`; `MCP_TOOL_GUARDS=on` at both entry points.
- `test/tool-schema-budget.test.js` — `labels: { maxBytes, tools: 4 }` ceiling set at
  ≤2% over the first measurement; `ENTRY_POINTS.labels`. `CORE_TOOLS` += `labels_lookup`.
- `scripts/Deploy-FunctionApp.ps1` + `local-deploy/Deploy.ps1` — DB list; staging list
  unchanged (`src/azure`, `src/functions` already staged — `test/deploy-staging.test.js`).
- `npm run gen:plugin-refs` (`labels-tools.md`), `npm run gen:trace-hook` (inputSchemas
  feed the trace contract), plugin `version` bump; `docs/Response-Format-Contract.md`,
  README service count (4 → 5, 71 → 75 tools), CLAUDE.md header.
- claude.ai connector: fifth connector URL `…/api/d365labels` (Easy Auth, same Entra app;
  `excludedPaths` unchanged). Local `~/.claude.json`: stdio entry with
  `MCP_STRUCTURED_CONTENT=off`, never the Azure URL (rule from 2026-08-25).

### 3.6 Testing

- Parser fixtures (TDD first): BOM + CRLF, label with/without description, description
  before any label, `=` inside the text, empty value, `\t;` variant, named vs numeric key,
  duplicate key in one file (last wins, counted).
- Builder: synthetic 3-language package with one label missing in one language →
  `languages_missing`; description equal across languages → 0 disagreements; ISV
  label rows land with `origin='isv'` and `description=NULL`.
- Tools: mock server (Zod bypassed → defensive defaults), single-id = batch-of-one
  payload disjointness (`test/batch-tools.test.js` pattern), pagination page 1 + page 2 no
  overlap, `xref_unavailable` when no XRef handle, response-format static scans pass
  unchanged, golden size baseline for the four calls.
- Live check after the first build: `@SYS154828` → "Maintain vendor master" /
  `[SecurityDuty FIM]`, `where_used` lists `SecurityDuty/…?Label`.

## 4. Sizing and risks

**Measured on the first real build (2026-09-08, dev box, all languages):**

| Item | Estimate (before) | Measured |
|---|---|---|
| Label files / language folders | ~330 per language, 76 folders | 60,022 files, 77 folders → **75 languages** (the `en-US` / `en-us` / `en-Us` folders are one language — 335 + 480 + 2 files; the builder now canonicalises with `Intl.getCanonicalLocales`) |
| Text rows / label ids | 25–29M / ~383k | **26,010,416 / 390,174** (en-US 389,713 labels, 817 files) |
| Origins | — | microsoft 372,248 · custom 10,920 · isv 7,006 (sealed stores, 153,054 rows, no description) |
| Ids with a description | ~64–95% per file | **305,870 of 390,174 (78%)** |
| Description disagreements across language files | 0 assumed | **857 (0.28%)** — recorded in `labels_metadata`; the first language file's comment is kept |
| File size | 1.5–2.5 GB | **5.0 GB** (text 26M rows + BINARY unique index + FTS5) |
| Full build time | 5–10 min | **26.6 min** (1,596 s; I/O bound on 2.9 GB of text + FTS rebuild) |
| tools/list | ≤ 12 KB | **8,256 B** (~2,064 tk), core profile 2,044 B |
| `labels_lookup` 1 id, 3 languages / all 75 | — | 8 ms, 932 chars / 2 ms, 4,207 chars (~1k tk) |
| `labels_search` "Kreditor sperren" (de) | — | **14 ms** — after pinning the join order with `CROSS JOIN`; the planner otherwise started from the language slice and timed out at 60 s (regression test asserts the plan) |
| `labels_where_used` @SYS154828 / `labels_for_object` CustTable | — | 3 ms / 453 ms against the 3.3 GB XRef |

| Item | Estimate | Mitigation |
|---|---|---|
| Rows, all languages | 26M text rows, 390k meta rows | rowid table + UNIQUE(label_id, language); FTS only on `text`; one transaction per file |
| File size | 5.0 GB | same class as XRef (3.3 GB); `LABELS_LANGUAGES` allow-list for a small local build |
| Full build time | ~27 min | runs after the KB build, non-fatal; delta path is per model |
| Kudu upload | 2 GB file | Deploy.ps1 already streams XRef 3.3 GB; add the integrity check the 2026-04 0-byte outage asked for |
| One slow query blocks the Function App | FTS with a 2-char term over 29M rows | `.min(2)` + LIKE fallback only with `language` set; `runWithBudget` like raw_sql |
| Description assumption (language-independent) | measured on 2 files | builder asserts it and reports disagreements; schema fallback documented in §3.1 |

## 5. Decisions needed before implementation

1. **Languages**: all 76 (default proposed) or the tenant's set for the Azure copy?
2. **Where-used location**: in the Labels service by reading the XRef DB (proposed —
   one call, grouped by property) versus only pointing to `xref_find_references`.
3. **Should the KB also gain the description** (`labels.description`, en-US)? Proposed
   **no** — keep the KB the resolver, the Labels service the reference; avoids the KB
   budget breach.
4. **Core profile**: `labels_lookup` in `CORE_TOOLS` (proposed yes).
5. **Local snapshot**: the local KB is schema 1.1; the first labels build should be run
   together with the pending `build:kb` (schema 1.2 + labels v2) so the two snapshots share
   a build date.

## 6. Phasing

1. Parser + builder (`build/labels-scan.js`, `build/update-labels-model.js`), TDD, local
   build, numbers verified against this document.
2. Tools + server + entry points + budget/contract tests.
3. Pipeline: `build:kb` hook, MSBuild delta, `Deploy.ps1`/weekly publish, health block.
4. Plugin refs, skill routing line ("label → d365fo-labels"), docs, connector registration.
