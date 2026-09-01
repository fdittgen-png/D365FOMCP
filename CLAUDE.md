# D365FO MCP Services

MCP server platform exposing D365FO metadata as 58 AI-consumable tools across 4 services (KB, XRef, Security, Task Recorder). 53 read a local snapshot; 4 read sealed-ISV metadata; 1 (`d365_custom_fields`) reads a live D365 environment.

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
  - `kb-tools.js` — 17 KB tools, exports `registerKbTools(server, db)`
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
4. **Freshness banner:** prepend `_<service> snapshot: <ISO date>_` to data responses via `freshnessBanner(db, service)` from `shared.js`. **Never** prepend the banner to `emptyResult` / `notFoundResult` / `errorResult` — those are meta-responses.
5. **Typed-first, ADAPTIVE text channel:** any tool with an `outputSchema` builds the typed JSON object FIRST, then renders a Markdown fallback from that typed object, and returns both via `structuredResult(typed, markdownText, format)`. The text channel **defaults to `'auto'`: whichever of TOON or Markdown is smaller for that particular response.** Neither wins universally — measured on the production KB, TOON is smaller on nested payloads (`d365_get_entity_sources` 4,448 vs 5,216 tk) and *larger* on wide flat ones (`d365_lookup_table` 9,725 vs 6,772 tk, +44%, because TOON repeats a long key header). Across six real calls: TOON 21,731 / Markdown 19,653 / adaptive **18,677**. `'toon'` and `'markdown'` pin the encoding; use `'markdown'` when the text is quoted verbatim into a document. Add the shared `format: formatTextParam` to a data tool's `inputSchema` and pass the `format` arg **straight through** — never normalise it in the handler (`const fmt = format === 'markdown' ? 'markdown' : 'toon'` silently pins every default call; that bug shipped once). `structuredResult` is the choke point and treats anything that is not literally `'markdown'` or `'toon'` — including `undefined` from the test mock server — as adaptive. `structuredContent` is always the typed JSON regardless of `format`. KB / XRef / Sec data tools follow this; document/prose tools (Task Recorder, Wiki) pin `format` to `'markdown'`. Never build Markdown directly from DB rows.

   **Open, needs a decision:** every response ships the payload **twice** — TOON/Markdown in `content[0].text` *and* JSON in `structuredContent`. Measured across six calls that is 35,927 tk of JSON + 21,731 tk of text = **1.60× the JSON alone**. Run 4 of the cost measurement found the claude.ai connector bills `structuredContent` and ignores the text channel, which would make the text channel pure wire waste for the primary client — but MCP recommends the dual send for clients without structured-output support, so reducing the text channel to a heading plus a summary is an architecture change, not a tuning one.
6. **Empty vs not-found:** `emptyResult(context)` for valid-but-zero-row results (sets no `isError`). `notFoundResult(type, name, suggestions)` for "the target object does not exist" (sets `isError: true`). The two-channel error model: success paths and tool-level failures are distinct.
7. **Errors:** `errorResult(category, hint, details?)` with one of five categories (`not-found`, `invalid-input`, `db-error`, `parse-error`, `internal`). Never forward raw `err.message` to the caller — `details` is logged server-side, not echoed.
8. **Truncation:** `truncationNote(kind, shown, hardMax?)` distinguishes `'user'` (caller's `limit`), `'cap'` (tool default with overridable max), `'hard'` (safety ceiling). Raw-SQL tools always use `'hard'`.
9. **Tables:** always `formatMarkdownTable(rows, columns?)`. It escapes `|`, collapses newlines, and unions keys across rows.
10. **Label resolution:** `@SYS…` IDs must never leak. Use `makeLabelResolver(db)` from `shared.js` — it caches per-request.
11. **Permission rendering:** `formatPermission(type)` (✓ Grant / ✗ Deny / — None) and `formatCrudFlag(v)` (Y / N / empty). Bare `'Deny'` cells in sec tools are forbidden.
12. **Snippet windows:** `contextAround(text, term, window)` for any "show context around a search match" — never `text.substring(0, N)`.
13. **Defensive defaults:** every Zod `.default(X)` must be mirrored by a handler-level defensive default (`x = Number.isInteger(x) && x > 0 ? x : 10`). The test mock server bypasses Zod.
14. **Omit dead keys — but never make array rows ragged.** A key that carries no information (`"source_code":null`, `"table_count":null`, `"parse_error":false`) should be omitted, not emitted: measured at 10–12% of a method-signature listing and +5.6% on `list_modules`. **The rule inverts inside an array whose rows are rendered as a table.** Omitting a key on *some* rows drops the TOON text channel out of its tabular form (`values[8]{name,value,label}:` + one line each) into a per-row key/value list — measured **+107%** on an enum's values and **+65%** on `d365_get_entity_sources`, against a ~27% JSON saving. So: decide per RESPONSE, not per row. `d365_get_entity_sources` picks from the filter (`custom_only` → all rows are extensions, emit it; otherwise emit it nowhere; `include_provenance` → everywhere), and every row of a given response carries the same keys. `d365EnumValueSchema.label` stays an explicit null for the same reason. Omit a key only when it is absent from **every** row.

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

So the old blanket rule ("batching saves round-trips, not bytes") holds only for tools with no hoistable envelope. **Before adding a batch, check whether the entries repeat something the batch is already scoped by** — if they do, hoist it and the batch wins on both axes. Still do not batch a tool whose single response is already large; `d365_lookup_table` is deliberately excluded.

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
description and JSON-Schema is re-sent on *every* request; no `limit`, filter or
format touches it. Measured 2026-09-01: **68,569 B (~17,142 tk)**, ~$0.34 over a
40-turn session before a single tool runs. `inputSchema` was 74% of it, and the
single largest line item was the shared `format` parameter's prose — **16,074 B
of pure duplication**, because every character of it is paid 48 times.

- **Keep shared-parameter descriptions SHORT.** `formatTextParam` now carries only
  what the enum cannot (which value is default, when to override). The long-form
  explanation lives in rule #5 above, where it is paid once. Same for the
  `Returns both a typed JSON payload…` tail that was on 43 tools: it is identical
  everywhere, so it distinguishes nothing and was removed.
- **`test/tool-schema-budget.test.js`** prints the per-service breakdown on every
  run and fails on a ceiling breach or on any shared parameter wasting >4,000 B.
  Raising a ceiling is a normal, deliberate act; doing it unnoticed is what this
  prevents. Current: **51,937 B (~12,984 tk), −24%**.
- **`MCP_TOOL_PROFILE=core`** registers 20 of 51 tools (−50%, ~6,429 tk). Off by
  default. The list in `CORE_TOOLS` is hand-picked, not measured — tune it from
  real usage. A test asserts every name in it still exists, because renaming a
  tool would otherwise shrink the profile silently (it caught two wrong names on
  the first run).

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
