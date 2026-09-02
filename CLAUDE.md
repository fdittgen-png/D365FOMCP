# D365FO MCP Services

MCP server platform exposing D365FO metadata as 59 AI-consumable tools across 4 services (KB, XRef, Security, Task Recorder). 54 read a local snapshot; 4 read sealed-ISV metadata; 1 (`d365_custom_fields`) reads a live D365 environment.

## Key Commands

```bash
npm install                    # Install dependencies
npm test                       # Run all tests
npm run test:sec               # Security tools tests only
npm run test:taskrecorder      # Task Recorder parser tests only
npm run start:kb               # Local KB server (stdio)
npm run start:xref             # Local XRef server (stdio)
npm run start:sec              # Local Security server (stdio)
npm run start:taskrecorder     # Local Task Recorder server (stdio)
npm run build:isv              # Scan sealed ISV models into isv_* tables
```

## Architecture

- **Runtime**: Node.js 20, ES Modules, Azure Functions v4
- **Database**: SQLite via better-sqlite3 (read-only, native bindings)
- **Transport**: MCP stdio (local) / MCP Streamable HTTP (Azure)
- **Infrastructure**: Azure Bicep, deployed via PowerShell scripts

## Code Structure

- `src/azure/` — Shared tool implementations (used by both local and Azure)
  - `shared.js` — DB singletons, query helper, formatMarkdownTable
  - `model-descriptors.js` — build provenance: reads each scanned model's `Descriptor/*.xml` (publisher, layer, origin `microsoft`/`isv`/`custom`, version `Major.Minor.Build.Revision`) into a `model_versions` table shared by all three DBs. Builders call `readModelDescriptors()`/`insertModelVersions()`; tools read it via `queryModelVersions()` (shared.js, returns `[]` on pre-provenance DBs). Exposed by `d365_list_modules`/`d365_get_module_summary`/`xref_list_modules`/`sec_stats`; the shared `modules: modulesFilterParam` input (sanitized via `sanitizeModulesFilter`, rule #13) scopes `d365_search`/`xref_search_names`/`sec_search` to specific models. XRef's SQL source has no versions — its builder reads descriptors from `XREF_PACKAGES_PATHS`/`KB_PACKAGES_PATHS`
  - `server-metadata.js` — the single source of each MCP server's identity (`name` stable / `title` / `description` / `websiteUrl` / `icons` / `instructions`, author + contact attribution). Every `new McpServer(...)` in `src/functions/*` and `src/local/*` MUST be `new McpServer(serverInfo(svc, { baseUrl }), serverOptions(svc))` (static-scan enforced in `test/server-metadata.test.js`). Icon = Trelleborg mark in `assets/mcp-icon-{128,512}.png`, embedded as data URI + served anonymously by `src/functions/d365icon.js` (`/api/icon.png` — must stay in Easy Auth `excludedPaths`, see `scripts/Update-McpAuthExcludedPaths.ps1`). The RFC 9728 PRM document reuses it for `resource_name`.
  - `sec-indexes.js` — single source of the Security DB performance indexes (`SEC_INDEXES`) + `ensureSecIndexes(dbPath)`: `getSecDb()` runs it before opening the read-only connection, so a code deploy alone brings the Azure `/home/data/d365fo_sec.sqlite` up to date at first request (idempotent, `SEC_AUTO_INDEX=false` disables). `build/add-sec-indexes.js` is the manual migration; `src/azure/sec-builder.js` carries the same statements for fresh builds. Every `JOIN … COLLATE NOCASE` in `sec-tools.js` MUST have a NOCASE index on one side (`test/sec-join-collation.test.js`) — without it a single call blocks every MCP endpoint on the Function App for >90 s.
  - `oauth-proxy-core.js` — MCP OAuth compatibility layer (strips the RFC 8707 `resource` param Entra rejects, AADSTS9010010); endpoints in `src/functions/oauth-proxy.js`, docs in `docs/MCP-Entra-Auth-Setup.md`. NOTE: `host.json` `routePrefix` is `''` — every function route must self-prefix `api/` (static-scan enforced in `test/oauth-proxy.test.js`)
  - `isv-schema.js` — the sealed-ISV data contract: `isv_*` table DDL, `ensureIsvSchema(db, 'kb'|'xref')`, `hasIsvData(db)` / `hasIsvIlData(db)` (both return false on pre-ISV DBs — tools MUST check them), and the provenance helpers every ISV response repeats. **17 of 19 non-Microsoft models on the dev box ship no X++ source and no `Ax<Type>` XML** — only a `bin/` directory. `build/isv-parsers.js` decodes what they do ship: the sealed `.md` metadata store (directory + TLV property blobs), the `<Model>.xref` ZIP (199k cross-reference lines the XRef SQL source never received — `Lasernet` has **0** outbound refs in the main tables), the `*_AxLabelFile.md` label stores (153k labels, 31 languages, `@LAC*`/`@ABA*` previously unresolvable), and the `*.runtime` / `*.xml` CoC + event-handler descriptors. `build/isv-scan.js` orchestrates it and is called at the end of **both** `build:kb` and `build:xref` (non-fatal; no-op unless `ISV_SCAN_PATHS` is set), so the ISV metadata refreshes with the Microsoft application and iExtension rather than drifting. **Nothing is decompiled.** Separation is physical: sealed-ISV rows land only in `isv_`-prefixed tables, never in `tables`/`fields`/`names`/`refs`/`labels`
  - `pe-metadata.js` (in `build/`) — pure-JS PE/CLI metadata reader, issue #81 option A. Walks the ECMA-335 tables of `Dynamics.AX.*.dll` / `*.netmodule` and decodes signature blobs to recover **method signatures only** into `isv_il_methods` (`fidelity='il'`): parameter names + types, return type, static/virtual/final/visibility, attribute type names. Off by default behind `ISV_IL_SCAN` / `--il`, KB database only; 84,594 signatures across the 17 sealed models. Closes the "what does this sealed method take and return" gap that `.xref` cannot — the CoC-wrapper question. It reads `MethodDef.RVA` **only as a boolean** (`hasImplementation`) and never resolves it to an offset: there is no IL instruction decoder, the `#US` literal heap is never read, and no body/source/literal column exists in the DDL — all three asserted by static scan in `test/pe-metadata.test.js`. That structural guarantee is why option A beat ILSpy (option B in #81). `normalizeXppMethods()` folds two X++ compiler artefacts: the backtick twin (`` `foo ``/`foo`, 3,586 rows on AmcBankingFoundation) and the `OptionalParameterGeneratedMethodAttribute` overload, whose `@<param>_IsDefaultSet` flags are consumed to mark params `optional` before the overload is dropped. `kind` separates `method`/`constructor`/`accessor`; accessors (CLR get/set pairs for table fields, 5,938 of 12,814) are stored but **excluded from every tool response** — they are a field-list question, not a signature question. A signature is exact about the contract and **silent about behaviour**; `isvIlProvenance()` says so on every response and is deliberately a different shape from `isvProvenance()`
  - `isv-kb-tools.js` / `isv-xref-tools.js` — 4 sealed-ISV tools (`d365_isv_list_models`, `d365_isv_lookup`, `d365_isv_extension_points`, `xref_isv_find_usages`), registered onto the KB and XRef servers. Deliberately separate from the existing tools: ISV data says what a model declares and where it hooks in, never what its code does
  - `kb-tools.js` — 17 KB tools, exports `registerKbTools(server, db)`; its last line calls `registerEffectiveSchemaTools(server, db)` so `tool-sets.js` needs no change
  - `effective-schema-tools.js` — `d365_effective_schema` (issue #85): the merged base + every-`AxTableExtension` view of one table, each field row carrying `origin` (`base|extension`), `module` and `model_origin` (microsoft/isv/custom via `queryModelVersions`) — rule #14: all three on every row, they are what distinguishes the rows. Sealed-ISV table extensions come from `isv_extends(kind='table')` ∪ `isv_elements(AxTableExtension)` and are reported **by name only** with `isvProvenance()` — sealed models publish an element inventory, not a field list. Exports `queryTableFields()`, the one field-row query shared with `d365_lookup_table`. NOT in `CORE_TOOLS` yet (tool-guards.js) — add it once usage confirms it replaces the lookup_table + find_extensions chain
  - `custom-fields.js` / `custom-fields-tools.js` — the **only** outbound HTTP path in the KB service (issues #87-#91). UI custom fields (the `_Custom` suffix) live in a *runtime* table extension (`SysCustomFieldModel.getExtensionFieldsForTable` -> `GetRuntimeExtension(table, SysCustomFieldConstants::ExtensionName)`), so no build snapshot contains them and `d365_check_field_exists` used to return a **false negative** for a real field. They are read live from a configured environment's OData `/data/$metadata`, stream-scanned (the document is tens of MB - never buffered, never handed to an XML parser; the tail-buffer chunk-boundary logic is the load-bearing part and is asserted at every split offset in `test/custom-fields.test.js`). Adds `d365_custom_fields`, an opt-in `include_custom_fields` block on `d365_lookup_table`, and a post-pass on `d365_check_field_exists` that fires only for suffixed names - a normal field check makes **zero** network calls. Live rows NEVER enter `tables`/`fields`: a `fields` row means "declared in a scanned model at build X", a custom field is per-environment state. Secrets come from Key Vault via `key-vault.js` (managed identity); configured by `scripts/Set-D365CustomFieldsSource.ps1`. The one tool family using `READ_ONLY_LIVE_ANNOTATIONS` (`openWorldHint: true`) - see the PM-03 note in `test/response-format.test.js`
  - `xref-tools.js` — 16 XRef tools, exports `registerXrefTools(server, db)`
  - `sec-tools.js` — 18 Security tools, exports `registerSecTools(server, db)`
  - `taskrecorder-tools.js` — 2 tools (`taskrecorder_to_markdown`, `taskrecorder_to_document`), exports `registerTaskRecorderTools(server)`. The document tool composes `taskrecorder-parser.js` (server .axtr) + `repro-xml.js` (client reproReport recording, preferred screenshot source) / `docx-screenshots.js` (legacy) + `taskrecorder-enrich.js` (KB/Sec) + `mhtml.js` into an enriched MHTML web-archive, correlating each client step to the matching server action; and (when `include_xml=true`) a contract XML via `taskrecorder-xml.js` that validates against `schemas/task-recording-document.xsd`.
- `src/functions/` — Azure Functions HTTP entry points
- `src/local/` — Local stdio MCP servers (import from `src/azure/`)
- `build/` — SQLite database builders (KB, XRef, Security) **plus the per-model delta path** (see "Post-compile refresh" below): `update-xref-module.js`, `update-kb-model.js`, `xref-source.js`
- `infra/` — Bicep IaC templates
- `scripts/` — PowerShell deployment automation

## Conventions

- ES Modules only (no CommonJS except `better-sqlite3` via `createRequire`)
- Node.js built-in test runner (`node --test`) — no Jest/Mocha
- Zod for MCP tool parameter validation
- Snake_case for tool parameter names (e.g., `table_name`, not `tableName`)
- SQLite queries use parameterized `?` placeholders — never string interpolation
- All object name lookups use `COLLATE NOCASE`

## Response format conventions

Every MCP tool in this project MUST follow these rules. Authoritative reference: [`docs/Response-Format-Contract.md`](docs/Response-Format-Contract.md). Static-scan tests in `test/response-format.test.js` enforce most of them.

1. **Tool registration:** `server.registerTool(name, { description, inputSchema, outputSchema?, annotations }, handler)`. Never the deprecated `server.tool()` overload.
2. **Annotations:** every tool sets `annotations: READ_ONLY_DB_ANNOTATIONS` (`readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: false`). Hosts use these to suppress approval prompts.
3. **Heading:** every response opens with an H2 (`## <Tool context>`). H1 is reserved for stand-alone documents (Task Recorder output is the only exception in this repo). Bold-text fake headers like `**References TO**` are forbidden. The TOON default text channel (rule #5) keeps this H2 context line and renders the body as TOON beneath it.
4. **Freshness banner (shipped 2026-09-02, #86 base):** every DATA response of a snapshot-backed tool carries `_<Service> snapshot: <YYYY-MM-DD>_` (`_KB snapshot: 2026-08-14_`, `_XRef …_`, `_Sec …_`) on the line **directly after the H2 heading** — not before it, so rule #3 (the response opens with H2) still holds. It is attached **centrally**, not per handler: `registerServiceTools` in `tool-sets.js` wraps every registered handler with `withFreshnessBanner(result, db, service)` from `shared.js`, which calls `freshnessBanner(db, service)` (build date read once per DB handle via `readBuildDate` — tool-guards imports the same function; `''` when the snapshot is undatable, never throws). Handlers do not call it. Never on the three meta-responses: `emptyResult` / `notFoundResult` / `errorResult` stamp `_meta: { kind: 'empty' | 'not-found' | 'error' }` (part of the MCP Result type, survives the wire) and the wrapper skips any result with `_meta.kind`, any `isError`, and anything without `structuredContent`. Also skipped: live tools (`openWorldHint: true` — `d365_custom_fields` rows come from an environment now, not from a build) and db-less servers (Task Recorder). The banner goes into the `summary` text channel too (rule #5). What #86 still wants on top: per-model age (`indexed_at` in `model_versions`), an age qualifier, and the `partial_build` / `stale_search_models` caveat after a delta merge. Enforced by `test/freshness.test.js`. The identically-named function in `src/azure/wiki-storage.js` is unrelated (Wiki service, different signature).
5. **Typed-first, ADAPTIVE text channel:** any tool with an `outputSchema` builds the typed JSON object FIRST, then renders a Markdown fallback from that typed object, and returns both via `structuredResult(typed, markdownText, format)`. The text channel **defaults to `'auto'`: whichever of TOON or Markdown is smaller for that particular response.** Neither wins universally — measured on the production KB, TOON is smaller on nested payloads (`d365_get_entity_sources` 4,448 vs 5,216 tk) and *larger* on wide flat ones (`d365_lookup_table` 9,725 vs 6,772 tk, +44%, because TOON repeats a long key header). Across six real calls: TOON 21,731 / Markdown 19,653 / adaptive **18,677**. `'toon'` and `'markdown'` pin the encoding; use `'markdown'` when the text is quoted verbatim into a document. Add the shared `format: formatTextParam` to a data tool's `inputSchema` and pass the `format` arg **straight through** — never normalise it in the handler (`const fmt = format === 'markdown' ? 'markdown' : 'toon'` silently pins every default call; that bug shipped once). `structuredResult` is the choke point and treats anything that is not literally `'markdown'` or `'toon'` — including `undefined` from the test mock server — as adaptive. `structuredContent` is always the typed JSON regardless of `format`. KB / XRef / Sec data tools follow this; document/prose tools (Task Recorder, Wiki) pin `format` to `'markdown'`. Never build Markdown directly from DB rows.

   **Text-channel policy (W4, #108) — mechanism shipped, default unchanged.** Every response ships the payload **twice** — TOON/Markdown in `content[0].text` *and* JSON in `structuredContent` — and the dual send was measured at **1.3–2× the JSON alone** (20 calls, 2026-09-02: `structuredContent` is the larger channel every time; 1.3–1.6× on flat tables, ~2× on nested payloads; across six KB calls 35,927 tk JSON + 21,731 tk text = 1.60×). Run 4 found the claude.ai connector bills `structuredContent` and discards the text. `structuredResult` therefore reads the request context's `textChannel` (`src/azure/request-context.js`): **`full`** (default) is today's behaviour, byte-identical; **`summary`** makes `content[0].text` the H2 line plus one line `_Payload in structuredContent (N keys, M bytes)._` and nothing else, ≤ 300 B, `structuredContent` untouched, rule #3 still holds. Switch per request with `?text=summary` on the connector URL, the `X-MCP-Text-Channel: summary` header, or `MCP_TEXT_CHANNEL=summary` in the environment; stdio sessions additionally consult `CLIENT_TEXT_CHANNEL_POLICY` (`clientInfo.name` → channel), which is **deliberately empty**. `emptyResult` / `notFoundResult` / `errorResult` are text-only meta-responses and are never summarised. **The default stays `full` until #108's step 1 — measuring which channel Claude Code (stdio) and the claude.ai connector each bill, Run-4 method — is recorded on the issue; only a client measured to discard the text goes into the policy table.**
6. **Empty vs not-found:** `emptyResult(context)` for valid-but-zero-row results (sets no `isError`). `notFoundResult(type, name, suggestions)` for "the target object does not exist" (sets `isError: true`). The two-channel error model: success paths and tool-level failures are distinct.
7. **Errors:** `errorResult(category, hint, details?)` with one of five categories (`not-found`, `invalid-input`, `db-error`, `parse-error`, `internal`). Never forward raw `err.message` to the caller — `details` is logged server-side, not echoed.
8. **Truncation:** `truncationNote(kind, shown, hardMax?)` distinguishes `'user'` (caller's `limit`), `'cap'` (tool default with overridable max), `'hard'` (safety ceiling). Raw-SQL tools always use `'hard'`. **On a paginated tool (rule #15) the cut is resumable, so the note is `pageNote()` from `pagination.js` — "pass `cursor` to continue" — never "raise `limit`", which re-pays the head of the list.**
9. **Tables:** always `formatMarkdownTable(rows, columns?)`. It escapes `|`, collapses newlines, and unions keys across rows.
10. **Label resolution:** `@SYS…` IDs must never leak. Use `makeLabelResolver(db)` from `shared.js` — it caches per-request.
11. **Permission rendering:** `formatPermission(type)` (✓ Grant / ✗ Deny / — None) and `formatCrudFlag(v)` (Y / N / empty). Bare `'Deny'` cells in sec tools are forbidden.
12. **Snippet windows:** `contextAround(text, term, window)` for any "show context around a search match" — never `text.substring(0, N)`.
13. **Defensive defaults:** every Zod `.default(X)` must be mirrored by a handler-level defensive default (`x = Number.isInteger(x) && x > 0 ? x : 10`). The test mock server bypasses Zod.
14. **Omit dead keys — but never make array rows ragged.** A key that carries no information (`"source_code":null`, `"table_count":null`, `"parse_error":false`) should be omitted, not emitted: measured at 10–12% of a method-signature listing and +5.6% on `list_modules`. **The rule inverts inside an array whose rows are rendered as a table.** Omitting a key on *some* rows drops the TOON text channel out of its tabular form (`values[8]{name,value,label}:` + one line each) into a per-row key/value list — measured **+107%** on an enum's values and **+65%** on `d365_get_entity_sources`, against a ~27% JSON saving. So: decide per RESPONSE, not per row. `d365_get_entity_sources` picks from the filter (`custom_only` → all rows are extensions, emit it; otherwise emit it nowhere; `include_provenance` → everywhere), and every row of a given response carries the same keys. `d365EnumValueSchema.label` stays an explicit null for the same reason. Omit a key only when it is absent from **every** row.
15. **Pagination (issue #109, `src/azure/pagination.js`):** list-shaped tools take an optional `cursor: cursorParam` (opaque base64url of `{o: offset}`, stateless) and spread `pageMeta()` into the typed payload: `has_more` **always**, `next_cursor` **only when `has_more`**, `total_count` only when cheap and not already carried by the tool's own count key. `limit` semantics are unchanged, so a call without `cursor` is the old payload plus `has_more`. SQL side: stable `ORDER BY` (add the tie-breaker columns — `line, col`, `duty_id`, `rowid`) + `LIMIT ? OFFSET ?` fetching `probeLimit(limit)` rows so `takePage()` makes `has_more` exact without a COUNT; in-memory lists slice `[offset, offset+limit)`. `decodeCursor()` is tolerant (garbage → `errorResult('invalid-input')`); a batch call rejects a non-zero cursor. Paginated today: `d365_search`, `d365_get_class_methods`, `d365_get_entity_sources`, `xref_find_references`, `xref_find_usages`, `sec_search`, `sec_find_roles_by_duty`, `sec_find_roles_by_privilege` (`test/pagination.test.js` covers the set with page 1 + page 2, no overlap).

## Database Files

Databases are not in the repo (gitignored). Build them with:
```bash
npm run build:kb       # Builds d365fo_kb.sqlite (~1 GB)
npm run build:xref     # Builds d365fo_xref.sqlite (~3.3 GB)
npm run build:sec      # Builds d365fo_sec.sqlite (~60 MB)
```

Set paths via environment variables or `.env` file (see `.env.example`).

`ISV_SCAN_PATHS` (optional) adds the sealed-ISV pass to both builds. Unset = no ISV scan and byte-identical databases.

`ISV_IL_SCAN=1` (optional, KB only) adds the assembly-metadata signature pass of issue #81 on top. Unset = zero `isv_il_methods` rows and every other table unchanged.

## Batching (issue #83)

`d365_get_enum` (`enum_names`), `d365_check_field_exists` (`tables`) and `xref_object_summary` (`object_names`) accept several targets per call. Two rules, both enforced by `test/batch-tools.test.js`:

1. **Single and batch payloads are disjoint.** A single-target call emits *exactly* its pre-batching `structuredContent` — no batch keys — so it pays nothing for the feature. A batch call emits only batch keys. Never both.
2. **A partial batch is a success**, not an error: misses go to `not_found[]`. A single-target miss still returns `notFoundResult`.

**Which channel a batch costs depends on the tool's shape** — say which one when quoting a number.

- `d365_get_enum` (9 enums, re-measured 2026-09-01): `structuredContent` **+0.6%**, TOON text channel **+10.1%** (the historical "+9.5%" figure — it is a *text-channel* number). TOON's tabular encoding degrades once payloads nest, and each enum brings its own `values` array.
- `d365_get_method_source` (4 methods): `structuredContent` **−2%**, and −3.5% at 10. It has one shared owner, so `owner_type`/`owner_name` are hoisted out of the entries and carried once. Before that hoist the batch was *larger* than the single calls it replaced.

- `d365_search` (`queries[]`, max 5; 5 queries on the golden fixture): `structuredContent` **−0.8%**, text **+2.2%**. Hoisted: `object_type` / `modules` / `limit`. A query with zero hits is data (`result_count: 0`), never `not_found` — there is no "not found" for a search.
- `xref_find_references` (`objects[]`, max 10; 5 objects): `structuredContent` **−1.1%**, text **+7.3%**. Hoisted: `kind_filter` / `limit` and the ISV provenance note (`isv_note`, once); each object's `isv` block keeps only its counts and is present on every object or on none (rule #14).
- `sec_lookup_role` (`role_names[]`, max 10; 5 roles): `structuredContent` **+0.5%**, text **+21.8%**. Nothing to hoist — the summary options apply per role but repeat nothing in the payload — so the batch is the N payloads plus a ~70 B wrapper. It wins on **turns only**. Its outputSchema also costs +2.3 KB on every `tools/list` (the payload keys appear twice: optional at the top level and inside `roles[]`). Measured, kept because the task asked for it; the honest verdict is that a no-hoist batch on a wide payload is a marginal trade.
- The text channel is **larger** for every batch: TOON's tabular form degrades once payloads nest (the same effect as the enum +10.1%). Quote the JSON figure as the primary one; the connector bills that channel.

So the old blanket rule ("batching saves round-trips, not bytes") holds only for tools with no hoistable envelope. **Before adding a batch, check whether the entries repeat something the batch is already scoped by** — if they do, hoist it and the batch wins on both axes. Still do not batch a tool whose single response is already large; `d365_lookup_table` is deliberately excluded. `test/response-size-golden.test.js` prints the batch-vs-singles table on every run and fails when a batch's JSON exceeds its singles by more than 1%.

## Post-compile refresh (local deltas + weekly Azure publish)

Compiling an X++ project in Visual Studio refreshes the **local** KB and XRef
automatically; Azure is published weekly. Full rebuilds are 10-60 min and were never
viable per compile — the deltas are, because one model is a rounding error of the
database (measured: iExtension 37,466 names / 50,723 refs, HISOL 19,479 / 43,035,
against 6,151,273 names / 27,989,546 refs — **0.9% of names, 0.3% of refs**).
Real timings: XRef delta **1m43s** on the 3.5 GB file, KB delta **11s**, both skipped
in ~15 s when nothing changed.

- **Trigger** — `local-deploy/hooks/Directory.Build.targets`, copied to the directory
  containing the `.rnrproj` files (`C:\Workspace\DEV\Projects\`). MSBuild auto-imports
  it, and `AfterTargets="Build;Rebuild"` runs only when the target succeeded, so
  "refresh if the compile succeeded" needs no extra condition. The projects already set
  `<GenerateCrossReferences>True</GenerateCrossReferences>` and `<Model>`, which is what
  the hook passes on. **The Dynamics 365 > Build models dialog does NOT go through
  MSBuild** and will not fire it — the fingerprint guard below covers that path.
- **Runner** — `local-deploy/Refresh-McpData.ps1`. Coalesces (a solution build fires the
  hook per project), serialises on a global mutex, and is launched detached so Visual
  Studio never waits. Resolves the cross-reference database from the **active XPP
  configuration** (`HKCU:\…\AX7\Development\Configurations\CurrentMetadataConfig`), never
  from `.env` — six `XRef_*` databases from older platform versions sit in LocalDB and
  `.env` currently names one that is two versions old.
- **`build/update-xref-module.js`** — deletes and re-inserts one module's names + outbound
  refs in a single transaction. Safe because the SQL source has a UNIQUE index on
  `Names(Path, ModuleId)`, so ids survive recompiles, and inbound refs from other modules
  are 0 (iExtension) / 45 (HISOL). Not assumed: `assertNoOrphans()` runs **inside** the
  transaction and rolls everything back if one reference lost its target — a stale graph
  is recoverable, a corrupt one is not. `xref_module_sync` stores a per-module fingerprint
  (`COUNT` + `CHECKSUM_AGG`) so an unchanged module does no work.
- **`build/update-kb-model.js`** — scopes `buildKnowledgeBase()` to the compiled models via
  a throwaway directory of junctions, then `mergeCustomKb()`. NOTE: `findAxDirs()` in
  `build-kb.js` now resolves directory symlinks/junctions (`isDirEntry()`); without that
  the junction scope scanned **zero** objects.
- **`local-deploy/Publish-McpDataWeekly.ps1`** — full KB+XRef rebuild then
  `Deploy.ps1 -SkipCode -SkipRoles -Databases kb,xref`. **Not optional:** `mergeCustomKb()`
  is additive and never deletes, so an object removed from a model lingers and every delta
  compounds the drift. The weekly rebuild is what makes the KB *correct*; the deltas only
  keep it *current*. It also refreshes the `isv_*` tables — sealed ISV models are vendor
  binaries that change on an ISV upgrade, not on an X++ compile, so the per-compile path
  leaves them alone (`--isv` opts in).

## Tool-list economy and agent guardrails

`src/azure/tool-guards.js` wraps every tool registered by `registerKbTools` /
`registerXrefTools` / `registerSecTools`. Enforced by `test/tool-schema-budget.test.js`
and `test/tool-guards.test.js`.

**The tool list is the one cost you cannot filter away.** Every tool's name,
description, annotations and **both** schemas are re-sent on *every* request; no
`limit`, filter or format touches it. Measured 2026-09-02 (W0, #104) as the
**actual `tools/list` message captured off the transport** of a real `McpServer`
that registers exactly what each entry point registers (`src/azure/tool-sets.js`):
**58 tools · 155,789 B (~38,947 tk)** across the four servers, ~$0.78 over a
40-turn session before a single tool runs — KB 21 tools 69,113 B · XRef 17 tools
36,596 B · Sec 18 tools 36,837 B · Task Recorder 2 tools 13,243 B. Cross-checked
against all four local stdio servers through the SDK `Client`: identical to the byte.
(The earlier "114,932 B, verified live" figure was the test's own three-set sum;
the KB server also ships `isv-kb-tools` + `custom-fields-tools`, XRef ships
`isv-xref-tools`, and Task Recorder was never counted.) **Since W5.B (#109) every
tool also carries a `title`**, derived on the registration path
(`deriveToolTitle` in `tool-sets.js`: `d365_lookup_table` → "Lookup table") — a
deliberate **+1,455 B (~364 tk, 0.9%)** measured off the transport, so the
current full list is **157,244 B (~39,311 tk)**: KB 69,642 · XRef 37,039 · Sec
37,276 · Task Recorder 13,287.

Composition, four servers, on the wire (before titles; `title` adds 1,397 B, 0.9%):

| Field | Bytes | Share |
|---|---:|---:|
| `outputSchema` | 86,020 | **55.2%** |
| `inputSchema` | 43,005 | 27.6% |
| `description` | 17,826 | 11.4% |
| `annotations` | 4,581 | 2.9% |
| `execution` (SDK 1.27 adds `{"taskSupport":"forbidden"}` to every tool, unasked) | 2,262 | 1.5% |
| `name` | 1,627 | 1.0% |

> **`outputSchema` is the dominant term, and it is structure, not prose.** Output
> `.describe()` text is ~1.8% of outputSchema bytes for KB/XRef/Sec (~210 tk in
> total) — **not a lever**; the only place output prose matters is
> `taskrecorder_to_document` (3.4 KB). What the bytes are: `type` keys, `required`
> arrays, `anyOf:[{type},{type:"null"}]` nullable wrappers, `additionalProperties`,
> and a `"$schema":"http://json-schema.org/draft-07/schema#"` on **every** input
> and output schema (116 of 116 — the SDK converts via `z4mini.toJSONSchema(…,
> {target:'draft-7'})`, ≈6 KB in total). Repeated nested shapes are **inlined**:
> 0 `$ref`, 0 `$defs` on the wire, so the single/batch row duplication in
> `d365_lookup_table` / `d365_check_field_exists` / `d365_get_enum` /
> `xref_object_summary` is paid twice. Those structural levers belong to W1
> (#105); the typed-first contract (rule #5) is what makes the schemas large, and
> they are genuinely useful to a validating client, so each trim is a trade.

- **Keep shared-parameter descriptions SHORT.** `formatTextParam` now carries only
  what the enum cannot (which value is default, when to override). The long-form
  explanation lives in rule #5 above, where it is paid once. Same for the
  `Returns both a typed JSON payload…` tail that was on 43 tools: it is identical
  everywhere, so it distinguishes nothing and was removed.
- **`test/tool-schema-budget.test.js`** captures the real `tools/list` message
  of all four servers, prints the per-server breakdown and the four-server total
  on every run, and fails on a ceiling breach, a tool-count change, any shared
  parameter wasting >4,000 B, or an entry point that registers a tool set
  outside `src/azure/tool-sets.js` (the one list both the servers and the test
  use). It also prints the `core` figure for all four servers and asserts every
  tool carries a `title`. Raising a ceiling is a normal, deliberate act; doing it
  unnoticed is what this prevents. Current (≤2% headroom, moved by exactly the
  measured title delta): kb 69,642 → 70,929 B · xref 37,039 → 37,743 B · sec
  37,276 → 37,939 B · taskrecorder 13,287 → 13,544 B.
- **MCP resources (W5.B, #109 part B)** — `src/azure/resources.js`, registered
  on the registration path for every server: `d365://snapshot` (service,
  `build_date`, `schema_version`, `model_count`, `tool_count` after the profile,
  `isv_scanned`) and, on the three snapshot-backed servers, `d365://modules` (the
  `model_versions` list that `d365_list_modules` ships per call — 37 KB by
  default). JSON, small, never a protocol error (a failed read returns an
  `{error}` document). **`d365://sql-templates` is deliberately not exposed**:
  the query behind `d365_sql_template` is inline in `kb-tools.js`, and
  duplicating it would be the drift the single-source rules exist to prevent —
  lift it into a shared function first. **Still gated on #109's spike:** whether
  the claude.ai connector and Claude Code surface resources to the model at all;
  the resources cost nothing on `tools/list`, so shipping the mechanism ahead of
  the spike is free.
- **`test/response-size-golden.test.js`** is the variable-cost gate: the ten
  concept-§3.1 calls with default args against a wide synthetic fixture, both
  channels within ±10% of `test/fixtures/response-size-baseline.json`.
  `GOLDEN_UPDATE=1` re-baselines — deliberately, in the diff.
- **Tool profile `core` is a PER-REQUEST preference (W2, #106)**, resolved once
  per request in `src/azure/request-context.js` and carried on an
  `AsyncLocalStorage` store: `?profile=core` on the connector URL > the
  `X-MCP-Tool-Profile` header > `MCP_TOOL_PROFILE` env > `full`. Unknown values
  fall through, never error. The same deployment serves the full list to one
  client and `core` to another; the resolved preferences are logged once per
  request (`console.info`, App Insights) so `CORE_TOOLS` can be tuned from what
  clients actually ask for. Stdio servers resolve once from env at startup.
  Measured 2026-09-02 off the transport: **23 of 58 tools — 155,789 → 77,539 B
  (~38,947 → ~19,385 tk, −50.2%)**; KB 69,113 → 31,308 (−54.7%), XRef 36,596 →
  14,596 (−60.1%), Sec 36,837 → 18,392 (−50.1%). The filter is applied on the
  registration path in `tool-sets.js` (`registerServiceTools` →
  `withRegistrationPolicy`), so it reaches EVERY set — ISV and custom-fields
  included; it used to sit in `installToolGuards`, which only three sets call,
  and the two largest KB tools (`d365_isv_lookup` 10.7 KB,
  `d365_isv_extension_points` 7.9 KB) survived it. **A profile that would leave
  a server with zero tools falls back to `full`** (`effectiveProfile`): the SDK
  installs no `tools/list` handler for an empty server and the client gets
  `-32601` — Task Recorder has no `CORE_TOOLS` member and is that server today.
  `CORE_TOOLS` stays in `tool-guards.js`, hand-picked, not measured. A test
  asserts every name in it still exists across all four servers, because
  renaming a tool would otherwise shrink the profile silently (it caught two
  wrong names on the first run).

**Guardrails are opt-in and armed at the MCP entry points** (`src/local/*.js`,
`src/functions/*.js` set `MCP_TOOL_GUARDS=on`), not defaulted on in the library —
they are a *session* concern, and a test or batch script that repeats a call on
purpose must not have its result swapped for a "you are looping" note. Defaulting
them on was tried first and broke 20 tests.

- **Loop detection** — 3 identical calls (tool + arguments, key order normalised)
  inside a 15-call window returns a short corrective note instead of the payload.
  A repeated 12k-token class dump is ~$0.25 of pure waste. Not an error, and it
  carries no `structuredContent` (it is a meta-response, like `errorResult`).
- **Staleness** — one note per process when the snapshot is older than
  `MCP_STALE_WARN_DAYS` (default 45), appended to the first normal response and
  never to an error. Once, not on every response: the information is needed once.
- `installToolGuards` is **idempotent** — the KB and XRef servers each take two
  `register*Tools()` calls, and double-wrapping would trip the loop threshold at
  half the intended count.

## Claude plugin

`plugin/d365fo-mcp/` is the installable Claude Code plugin (19 commands, 8 skills; **deliberately no `.mcp.json`** — the 4 services are reached via the claude.ai connectors, because a plugin/local server with the same URL hides the connector, enforced by `test/plugin.test.js`); `plugin/.claude-plugin/marketplace.json` makes the repo its own marketplace. `skills/d365fo-mcp-tooling/references/*-tools.md` are **generated** from the tool registrations — run `npm run gen:plugin-refs` after changing any `src/azure/*-tools.js` (`test/plugin.test.js` fails otherwise). Privacy scrub in that test: no personal paths, no e-mail other than the operator contact.
