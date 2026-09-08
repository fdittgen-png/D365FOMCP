# D365 Labels MCP Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A fifth MCP service `d365fo-labels` serving every D365FO label in every language, always paired with its developer description, with where-used (XRef) and object-to-label lookups, refreshed by the KB build pipeline.

**Architecture:** One new SQLite file `d365fo_labels.sqlite` (better-sqlite3 builder, `label_meta` once per id + `labels` per (id, language) + FTS5), built at the end of `build:kb` and per model on the MSBuild delta path. One new tool module `labels-tools.js` (4 tools) registered through `tool-sets.js` like the other services; where-used reads the XRef DB read-only through the existing `getXrefDb()`.

**Tech Stack:** Node 20 ESM, better-sqlite3, Zod, MCP SDK 1.27, node:test, Azure Functions v4, PowerShell deploy scripts.

**Spec:** `docs/Labels-Service-Concept-2026-09-08.md`

## Global Constraints

- Response contract rules #1–#16 of `CLAUDE.md` (H2 heading, central freshness banner `_Labels snapshot: <date>_`, typed-first `structuredResult`, `READ_ONLY_DB_ANNOTATIONS`, `coverageKeys` spread first, rule #14 same keys on every row, `cursorParam`/`pageMeta` on list tools, `notFoundResult(..., { db, kind })`).
- Every `new McpServer(...)` = `new McpServer(serverInfo('labels', ...), serverOptions('labels'))`.
- Function routes self-prefix `api/`. Tool parameter names snake_case. Parameterised SQL only. `COLLATE NOCASE` on name lookups.
- Tool descriptions ≤ 300 chars; no `.describe()` that repeats name/enum/default.
- Descriptions are stored ONCE per label id (measured identical across language files).
- Default languages: all present (`LABELS_LANGUAGES=all`).
- Commit per task on branch `feat/labels-service`; `npm test` green before the merge.

---

### Task 1: Label file discovery + parser module (shared by KB builder and Labels builder)

**Files:**
- Create: `build/label-files.js`
- Modify: `build/build-kb.js:295-334` (replace private `findAllLabelFiles` / `labelLines` with imports)
- Test: `test/label-files.test.js`

**Interfaces:**
- Produces: `findLabelFiles(root) → Array<{path, language, prefix}>`; `parseLabelFile(text) → { labels: Array<{key, text, description}>, stats: {labels, descriptions, orphan_descriptions, duplicate_keys} }`; `canonicalLabelId(key, prefix) → string` (`@SYS1`→`@SYS1`, `Foo`+`AP`→`@AP:Foo`); `normalizeLabelIdInput(s) → string|null` (`SYS1`→`@SYS1`, `AP:Foo`→`@AP:Foo`, `@AP:Foo` unchanged, garbage→null); `labelLines(content)` generator kept for the KB (`[key, value]`).

- [ ] **Step 1: failing tests** — BOM+CRLF file parses; ` ;` and `\t;` attach to the preceding label; a description before any label counts as orphan; two `=` keep the text after the first; empty value skipped; duplicate key → last wins + counted; `canonicalLabelId`/`normalizeLabelIdInput` table; `findLabelFiles` on a tmp tree `Pkg/Model/AxLabelFile/LabelResources/de/X.de.label.txt` skips `bin/`.
- [ ] **Step 2:** run `node --test test/label-files.test.js` → fails (module missing).
- [ ] **Step 3:** implement `build/label-files.js`; `build-kb.js` imports `findLabelFiles as findAllLabelFiles`, `labelLines`.
- [ ] **Step 4:** `node --test test/label-files.test.js test/kb-tools.test.js` → pass.
- [ ] **Step 5:** commit `feat(labels): shared label-file discovery and parser with descriptions`.

### Task 2: Labels DB builder + per-model delta

**Files:**
- Create: `build/build-labels.js` (CLI + `buildLabelsDb`, `refreshLabelsModules`, `LABELS_SCHEMA`)
- Create: `build/update-labels-model.js` (CLI wrapper for the delta)
- Test: `test/build-labels.test.js`

**Interfaces:**
- `buildLabelsDb({ outputPath, packagesPaths, isvRoots = [], languages = 'all', log }) → { labels, meta, languages, files, disagreements, seconds }`
- `refreshLabelsModules({ dbPath, modules, packagesPaths, log }) → { modules, labels, meta }` (per module: DELETE meta+labels of that module in one transaction, re-insert, set `partial_build`).
- Schema (schema_version `1.0`): `label_meta(label_id PK, label_file, module, origin, description)`, `labels(rowid, label_id, language, text, UNIQUE(label_id, language))`, `labels_fts` FTS5 external-content on `labels(text)` with the standard `ai/ad/au` triggers, `label_languages(language PK, label_count, file_count)`, `label_files(label_file, language, module, path, label_count, description_count, PK(label_file, language))`, `labels_metadata(key, value)` with `build_date`, `schema_version`, `packages_path`, `languages`, `label_count`, `meta_count`, `language_count`, `description_disagreements`, `partial_build` (delta only), `model_versions` (via `readModelDescriptors` + `insertModelVersions`).
- Origin: `model_versions.origin` by module, else `custom`; ISV rows (`scanSealedModels(isvRoots)` → `models[].labels`) `origin='isv'`, `description=NULL`.
- Build: `PRAGMA journal_mode=OFF, synchronous=OFF`, triggers created AFTER bulk insert, then `INSERT INTO labels_fts(labels_fts) VALUES('rebuild')`, indexes last.

- [ ] **Step 1: failing tests** — synthetic package (`en-US`, `de`, `fr`; one id missing in `de`; identical descriptions; one custom model + descriptor XML) → counts, `label_meta` has one row per id with description, `labels` rows = sum, `label_languages` 3 rows, FTS `MATCH 'Kreditor'` hits the de row, `labels_metadata.build_date` ISO, `languages=['en-US']` filter stores 1 language; delta: change a text on disk, `refreshLabelsModules` → new text present, old gone, `partial_build` set, FTS reflects it.
- [ ] **Step 2:** run → fails.
- [ ] **Step 3:** implement both files (`update-labels-model.js`: `node build/update-labels-model.js ModelA ModelB [--labels=<path>] [--model-store=<path>]`, packages from `KB_PACKAGES_PATHS`).
- [ ] **Step 4:** run → pass.
- [ ] **Step 5:** commit `feat(labels): d365fo_labels.sqlite builder and per-model delta`.

### Task 3: Pipeline hooks (build:kb tail, KB delta, npm scripts)

**Files:**
- Modify: `build/build-kb.js:2075` (after `refreshIsvMetadata`: `await refreshLabelsAfterKb(...)`, non-fatal, `LABELS_SCAN=off` skips)
- Modify: `build/update-kb-model.js` (after `mergeCustomKb`: `refreshLabelsModules` for the same models, non-fatal)
- Modify: `package.json` (`build:labels`, `start:labels`, `test:labels`)
- Test: `test/build-labels.test.js` (static scan: both call sites present)

- [ ] Steps: failing static-scan assertions → wire → pass → commit `feat(labels): refresh the labels DB from build:kb and the per-model KB delta`.

### Task 4: Tools module + schemas + shared helpers

**Files:**
- Create: `src/azure/labels-tools.js` — `registerLabelsTools(server, db, { xrefDb = null } = {})`
- Modify: `src/azure/output-schemas.js` (append `labelsLookupOutput`, `labelsSearchOutput`, `labelsWhereUsedOutput`, `labelsForObjectOutput`)
- Modify: `src/azure/shared.js` (`SERVICE_LABELS.labels='Labels'`, `readBuildDate` table list += `labels_metadata`, `getLabelsDb()` with `LABELS_DB_PATH` default `/home/data/d365fo_labels.sqlite`, `tryGetXrefDb()` returning null when the file is absent)
- Modify: `src/azure/resources.js:73`, `src/functions/d365health.js:41-54` (+ `labels: 'labels_metadata'`, counts `label_count`/`language_count`)
- Modify: `test/response-format.test.js:26` TOOL_FILES += `labels-tools.js`
- Test: `test/labels-tools.test.js`

**Tools (exact contracts):**
- `labels_lookup({ label_ids: string[] 1..100, languages?: string[] 1..80, format })` → `{ requested_count, found_count, not_found: string[], languages_present: string[], meta: [{label_id, label_file, module, origin, description|null}], labels: [{label_id, language, text}], languages_missing: [{label_id, languages: string[]}] }`. `languages_missing` only when `languages` was given. All ids miss → `notFoundResult('label', ids.join(', '), [])`.
- `labels_search({ text 2..200, language?, label_file?, modules?, origin?: enum, limit ≤100 default 20, cursor, format })` → `{ query, result_count, results: [{label_id, language, text, label_file, module, description|null}], has_more, next_cursor? }`; FTS `MATCH` with quoted term, LIKE fallback when `labels_fts` absent; `emptyResult` on 0.
- `labels_where_used({ label_id, property?, object_type?, limit ≤200 default 50, cursor, format })` → `{ label_id, text: en-US or first, description|null, total_count, property_counts: [{property, count}], usages: [{object_type, object_name, element|null, property|null, kind}], has_more, next_cursor? }`; XRef SQL: `refs ⋈ names(target='/Labels/<id>') ⋈ names(source)`, ORDER BY source path, `probeLimit`/`takePage`. Path parser `parseXrefSourcePath(path)`: `/Classes/X/Methods/y` → `{object_type:'Class', object_name:'X', element:'y', property:null, kind:'Code'}`; `Type/Obj[/Sub/El]?Prop` → `{object_type: Type, object_name: Obj, element: El|null, property: Prop, kind:'Property'}`. No XRef → `errorResult('db-error', 'XRef database not configured …')`; label unknown in both → `notFoundResult`.
- `labels_for_object({ object_type, object_name, languages? default ['en-US'], properties?, limit ≤500 default 200, format })` → `{ object_type, object_name, label_count, labels: [{element|null, property, label_id, language, text|null, description|null}] }`; `object_type` accepts XRef prefix tokens or friendly names (`table→Table`, `form→Form`, `enum→Enum`, `class→/Classes/`, `entity→DataEntityView`, `edt→EdtString,EdtInt,…` via `LIKE 'Edt%'`, `menu_item→MenuItemDisplay,MenuItemAction,MenuItemOutput`, `privilege→SecurityPrivilege`, `duty→SecurityDuty`, `report→Report`, `view→View`); SQL `n2.path = 'Type/Name' OR n2.path LIKE 'Type/Name?%' OR n2.path LIKE 'Type/Name/%'`.

- [ ] **Step 1: failing tests** on a builder-made fixture DB + an in-memory XRef (`names(id,path,provider_id,module_id)`, `refs(source_id,target_id,kind,line,col)`) with `/Labels/@SYS1`, `Table/CustTable?Label`, `Table/CustTable/TableFieldString/AccountNum?HelpText`, `/Classes/Foo/Methods/bar`: lookup shape (meta once, description present, missing language listed, not_found), search FTS + cursor page 2 no overlap, where_used grouping/property_counts/page, for_object element/property rows, no-xref error, contract statics (H2, `structuredContent`, no `isError` on empty).
- [ ] **Step 2:** run → fails. **Step 3:** implement. **Step 4:** `node --test test/labels-tools.test.js test/response-format.test.js test/freshness.test.js` → pass.
- [ ] **Step 5:** commit `feat(labels): four labels tools, output schemas, shared DB handle`.

### Task 5: Service wiring — metadata, tool set, entry points, tests, generators

**Files:**
- Modify: `src/azure/server-metadata.js` (`SERVICES.labels`: name `d365fo-labels`, title `D365 F&O Labels`, description, instructions ≤600 chars naming `labels_lookup`/`labels_search`/`labels_where_used`/`labels_for_object`, containing `First call`, `limit`, `modules`, `cursor`, `does not cover`, `snapshot date`)
- Modify: `src/azure/tool-sets.js` (`TOOL_SETS.labels`, `registerAllLabelsTools`, `TITLE_PREFIXES` += `labels`; labels set passes `{ xrefDb: tryGetXrefDb() }` lazily — a wrapper `registerLabelsSet(server, db)`)
- Modify: `src/azure/tool-guards.js:254` `CORE_TOOLS` += `labels_lookup`
- Create: `src/functions/d365labels.js` (clone of `d365kb.js`, route `api/d365labels`, `getLabelsDb()`), `src/local/mcp-server-labels.js` (clone of `mcp-server-kb.js`, default `~/.claude/d365fo_labels.sqlite`, opens XRef read-only if `XREF_DB_PATH` or the default file exists)
- Modify: `src/functions/index.js` (+ import)
- Modify tests: `test/tool-schema-budget.test.js` (`BUDGET.labels` measured then ≤2% ceiling, `ENTRY_POINTS.labels`, `TOTAL_MAX_BYTES`), `test/server-metadata.test.js` (name map, `PREFIX.labels='labels'`, `VERB_EXCEPTIONS.labels`, regex `(?:d365|xref|sec|taskrecorder|labels)_`), `test/resources.test.js:118-119`, `test/plugin.test.js:28` if it enumerates plugin refs, `src/trace/contract/arg-policies.js:184` (+ `d365labels` → `labels`), `build/gen-trace-hook.js`, `build/gen-plugin-tool-refs.js` (+ labels set → `labels-tools.md`), plugin `version` bump, `plugin/d365fo-mcp/skills/d365fo-mcp-tooling/SKILL.md` routing line "label id / all languages / description → d365fo-labels".
- Run: `npm run gen:trace-hook && npm run gen:plugin-refs && npm test`.

- [ ] Steps: adjust the enumerating tests first (they fail: unknown service) → wire → generators → `npm test` green → commit `feat(labels): register the d365fo-labels service (Azure + stdio), budgets, generators`.

### Task 6: Deploy + docs + local client config

**Files:**
- Modify: `local-deploy/Deploy.ps1` (`ValidateSet` + default `Databases` += `labels`, `-LabelsDbPath`, `$uploadPlan` row `Remote='d365fo_labels.sqlite'`, health list `/api/d365labels` Expect=401), `scripts/Deploy-FunctionApp.ps1` (same, `-LabelsDbPath`, Kudu PUT), `local-deploy/Publish-McpDataWeekly.ps1` (`-Databases kb,xref,labels` where kb,xref is passed), `README.md` (5 services / 75 tools, `build:labels`), `CLAUDE.md` (header + a "Labels service" paragraph), `docs/Response-Format-Contract.md` (banner label list), `.env.example` (`LABELS_DB_PATH`, `LABELS_LANGUAGES`, `LABELS_SCAN`).
- Local: add `d365labels` stdio entry to `~/.claude.json` (`MCP_STRUCTURED_CONTENT=off`, `XREF_DB_PATH`).
- [ ] Commit `feat(labels): deploy scripts, docs, env`.

### Task 7: Build the real database, smoke, measure

- [ ] `npm run build:labels` (all languages) → record rows/size/time in the concept doc §4 and CLAUDE.md.
- [ ] Smoke through the SDK client against `src/local/mcp-server-labels.js`: `labels_lookup(['@SYS154828'])` returns text + `[SecurityDuty FIM]`… (verify actual description), `labels_where_used('@SYS154828')` lists `SecurityDuty` rows; `labels_for_object('table','CustTable')`.
- [ ] Commit measurements `docs: labels service measurements`.

### Task 8: Merge and deploy

- [ ] `git push -u origin feat/labels-service`; `gh pr create`; `gh pr merge --squash --delete-branch` after CI; `git pull`.
- [ ] `.\local-deploy\Deploy.ps1 -SkipRoles -Databases labels` (code + labels DB). If the CA step-up blocks the agent, hand the exact command to the user. Verify: `GET /api/d365labels` → 200 health JSON; a bearer `tools/list` on the endpoint shows 4 tools.
- [ ] Memory + concept doc status update.
