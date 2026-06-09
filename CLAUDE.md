# D365FO MCP Services

MCP server platform exposing D365FO metadata as 54 AI-consumable tools across 4 services (KB, XRef, Security, Task Recorder).

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
  - `kb-tools.js` — 17 KB tools, exports `registerKbTools(server, db)`
  - `xref-tools.js` — 16 XRef tools, exports `registerXrefTools(server, db)`
  - `sec-tools.js` — 19 Security tools, exports `registerSecTools(server, db)`
  - `taskrecorder-tools.js` — 2 tools (`taskrecorder_to_markdown`, `taskrecorder_to_document`), exports `registerTaskRecorderTools(server)`. The document tool composes `taskrecorder-parser.js` + `docx-screenshots.js` + `taskrecorder-enrich.js` (KB/Sec) + `mhtml.js` into an enriched MHTML web-archive, and (when `include_xml=true`) a contract XML via `taskrecorder-xml.js` that validates against `schemas/task-recording-document.xsd`.
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
3. **Heading:** every response opens with an H2 (`## <Tool context>`). H1 is reserved for stand-alone documents (Task Recorder output is the only exception in this repo). Bold-text fake headers like `**References TO**` are forbidden.
4. **Freshness banner:** prepend `_<service> snapshot: <ISO date>_` to data responses via `freshnessBanner(db, service)` from `shared.js`. **Never** prepend the banner to `emptyResult` / `notFoundResult` / `errorResult` — those are meta-responses.
5. **Typed-first, render-from-typed:** any tool with an `outputSchema` builds the typed JSON object FIRST, then renders the Markdown fallback from that typed object. Return both via `structuredResult(typed, fallbackText)`. Never build Markdown directly from DB rows.
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
