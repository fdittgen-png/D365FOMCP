# D365FO MCP Services

MCP server platform exposing D365FO metadata as 53 AI-consumable tools across 4 services (KB, XRef, Security, Task Recorder).

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
  - `oauth-proxy-core.js` — MCP OAuth compatibility layer (strips the RFC 8707 `resource` param Entra rejects, AADSTS9010010); endpoints in `src/functions/oauth-proxy.js`, docs in `docs/MCP-Entra-Auth-Setup.md`. NOTE: `host.json` `routePrefix` is `''` — every function route must self-prefix `api/` (static-scan enforced in `test/oauth-proxy.test.js`)
  - `kb-tools.js` — 17 KB tools, exports `registerKbTools(server, db)`
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

## Claude plugin

`plugin/d365fo-mcp/` is the installable Claude Code plugin (HTTP `.mcp.json` for the 4 services, 19 commands, 8 skills); `plugin/.claude-plugin/marketplace.json` makes the repo its own marketplace. `skills/d365fo-mcp-tooling/references/*-tools.md` are **generated** from the tool registrations — run `npm run gen:plugin-refs` after changing any `src/azure/*-tools.js` (`test/plugin.test.js` fails otherwise). Privacy scrub in that test: no personal paths, no e-mail other than the operator contact.
