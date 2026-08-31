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
  - `isv-schema.js` — the sealed-ISV data contract: `isv_*` table DDL, `ensureIsvSchema(db, 'kb'|'xref')`, `hasIsvData(db)` (returns false on pre-ISV DBs — tools MUST check it), and the provenance helpers every ISV response repeats. **17 of 19 non-Microsoft models on the dev box ship no X++ source and no `Ax<Type>` XML** — only a `bin/` directory. `build/isv-parsers.js` decodes what they do ship: the sealed `.md` metadata store (directory + TLV property blobs), the `<Model>.xref` ZIP (199k cross-reference lines the XRef SQL source never received — `Lasernet` has **0** outbound refs in the main tables), the `*_AxLabelFile.md` label stores (153k labels, 31 languages, `@LAC*`/`@ABA*` previously unresolvable), and the `*.runtime` / `*.xml` CoC + event-handler descriptors. `build/isv-scan.js` orchestrates it and is called at the end of **both** `build:kb` and `build:xref` (non-fatal; no-op unless `ISV_SCAN_PATHS` is set), so the ISV metadata refreshes with the Microsoft application and iExtension rather than drifting. **Nothing is decompiled** — see issue #81 before adding IL. Separation is physical: sealed-ISV rows land only in `isv_`-prefixed tables, never in `tables`/`fields`/`names`/`refs`/`labels`
  - `isv-kb-tools.js` / `isv-xref-tools.js` — 4 sealed-ISV tools (`d365_isv_list_models`, `d365_isv_lookup`, `d365_isv_extension_points`, `xref_isv_find_usages`), registered onto the KB and XRef servers. Deliberately separate from the existing tools: ISV data says what a model declares and where it hooks in, never what its code does
  - `kb-tools.js` — 17 KB tools, exports `registerKbTools(server, db)`
  - `custom-fields.js` / `custom-fields-tools.js` — the **only** outbound HTTP path in the KB service (issues #87-#91). UI custom fields (the `_Custom` suffix) live in a *runtime* table extension (`SysCustomFieldModel.getExtensionFieldsForTable` -> `GetRuntimeExtension(table, SysCustomFieldConstants::ExtensionName)`), so no build snapshot contains them and `d365_check_field_exists` used to return a **false negative** for a real field. They are read live from a configured environment's OData `/data/$metadata`, stream-scanned (the document is tens of MB - never buffered, never handed to an XML parser; the tail-buffer chunk-boundary logic is the load-bearing part and is asserted at every split offset in `test/custom-fields.test.js`). Adds `d365_custom_fields`, an opt-in `include_custom_fields` block on `d365_lookup_table`, and a post-pass on `d365_check_field_exists` that fires only for suffixed names - a normal field check makes **zero** network calls. Live rows NEVER enter `tables`/`fields`: a `fields` row means "declared in a scanned model at build X", a custom field is per-environment state. Secrets come from Key Vault via `key-vault.js` (managed identity); configured by `scripts/Set-D365CustomFieldsSource.ps1`. The one tool family using `READ_ONLY_LIVE_ANNOTATIONS` (`openWorldHint: true`) - see the PM-03 note in `test/response-format.test.js`
  - `xref-tools.js` — 16 XRef tools, exports `registerXrefTools(server, db)`
  - `sec-tools.js` — 18 Security tools, exports `registerSecTools(server, db)`
  - `taskrecorder-tools.js` — 2 tools (`taskrecorder_to_markdown`, `taskrecorder_to_document`), exports `registerTaskRecorderTools(server)`. The document tool composes `taskrecorder-parser.js` (server .axtr) + `repro-xml.js` (client reproReport recording, preferred screenshot source) / `docx-screenshots.js` (legacy) + `taskrecorder-enrich.js` (KB/Sec) + `mhtml.js` into an enriched MHTML web-archive, correlating each client step to the matching server action; and (when `include_xml=true`) a contract XML via `taskrecorder-xml.js` that validates against `schemas/task-recording-document.xsd`.
- `src/functions/` — Azure Functions HTTP entry points
- `src/local/` — Local stdio MCP servers (import from `src/azure/`)
- `build/` — SQLite database builders (KB, XRef, Security)
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
5. **Typed-first, TOON-default text channel:** any tool with an `outputSchema` builds the typed JSON object FIRST, then renders a Markdown fallback from that typed object, and returns both via `structuredResult(typed, markdownText, format)`. The **text channel defaults to TOON** (token-efficient, rendered from `typed` via `encodeToon`, keeping the leading `## context` heading); pass `format === 'markdown'` to emit the Markdown rendering instead. Add the shared `format: formatTextParam` to a data tool's `inputSchema` and pass the `format` arg through to `structuredResult` — `structuredResult` treats any non-`'markdown'` value as TOON, so it is the defensive choke point (no per-handler default needed). `structuredContent` is always the typed JSON regardless of `format`. KB / XRef / Sec data tools follow this; document/prose tools (Task Recorder, Wiki) pin `format` to `'markdown'`. Never build Markdown directly from DB rows.
6. **Empty vs not-found:** `emptyResult(context)` for valid-but-zero-row results (sets no `isError`). `notFoundResult(type, name, suggestions)` for "the target object does not exist" (sets `isError: true`). The two-channel error model: success paths and tool-level failures are distinct.
7. **Errors:** `errorResult(category, hint, details?)` with one of five categories (`not-found`, `invalid-input`, `db-error`, `parse-error`, `internal`). Never forward raw `err.message` to the caller — `details` is logged server-side, not echoed.
8. **Truncation:** `truncationNote(kind, shown, hardMax?)` distinguishes `'user'` (caller's `limit`), `'cap'` (tool default with overridable max), `'hard'` (safety ceiling). Raw-SQL tools always use `'hard'`.
9. **Tables:** always `formatMarkdownTable(rows, columns?)`. It escapes `|`, collapses newlines, and unions keys across rows.
10. **Label resolution:** `@SYS…` IDs must never leak. Use `makeLabelResolver(db)` from `shared.js` — it caches per-request.
11. **Permission rendering:** `formatPermission(type)` (✓ Grant / ✗ Deny / — None) and `formatCrudFlag(v)` (Y / N / empty). Bare `'Deny'` cells in sec tools are forbidden.
12. **Snippet windows:** `contextAround(text, term, window)` for any "show context around a search match" — never `text.substring(0, N)`.
13. **Defensive defaults:** every Zod `.default(X)` must be mirrored by a handler-level defensive default (`x = Number.isInteger(x) && x > 0 ? x : 10`). The test mock server bypasses Zod.

## Database Files

Databases are not in the repo (gitignored). Build them with:
```bash
npm run build:kb       # Builds d365fo_kb.sqlite (~1 GB)
npm run build:xref     # Builds d365fo_xref.sqlite (~3.3 GB)
npm run build:sec      # Builds d365fo_sec.sqlite (~60 MB)
```

Set paths via environment variables or `.env` file (see `.env.example`).

`ISV_SCAN_PATHS` (optional) adds the sealed-ISV pass to both builds. Unset = no ISV scan and byte-identical databases.

## Batching (issue #83)

`d365_get_enum` (`enum_names`), `d365_check_field_exists` (`tables`) and `xref_object_summary` (`object_names`) accept several targets per call. Two rules, both enforced by `test/batch-tools.test.js`:

1. **Single and batch payloads are disjoint.** A single-target call emits *exactly* its pre-batching `structuredContent` — no batch keys — so it pays nothing for the feature. A batch call emits only batch keys. Never both.
2. **A partial batch is a success**, not an error: misses go to `not_found[]`. A single-target miss still returns `notFoundResult`.

Batching saves **round-trips, not bytes** — measured, the batched body is *larger* (+9.5% for 9 enums) because TOON's tabular encoding degrades once payloads nest. Do not batch a tool whose single response is already large; `d365_lookup_table` is deliberately excluded.

## Claude plugin

`plugin/d365fo-mcp/` is the installable Claude Code plugin (19 commands, 8 skills; **deliberately no `.mcp.json`** — the 4 services are reached via the claude.ai connectors, because a plugin/local server with the same URL hides the connector, enforced by `test/plugin.test.js`); `plugin/.claude-plugin/marketplace.json` makes the repo its own marketplace. `skills/d365fo-mcp-tooling/references/*-tools.md` are **generated** from the tool registrations — run `npm run gen:plugin-refs` after changing any `src/azure/*-tools.js` (`test/plugin.test.js` fails otherwise). Privacy scrub in that test: no personal paths, no e-mail other than the operator contact.
