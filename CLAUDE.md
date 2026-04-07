# D365FO MCP Services

MCP server platform exposing D365FO metadata as 49 AI-consumable tools across 4 services (KB, XRef, Security, Task Recorder).

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
  - `sec-tools.js` — 15 Security tools, exports `registerSecTools(server, db)`
  - `taskrecorder-tools.js` — 1 tool, exports `registerTaskRecorderTools(server)`
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
- `formatMarkdownTable()` from `shared.js` for all table output
- `textResult()` from `shared.js` for all tool responses
- SQLite queries use parameterized `?` placeholders — never string interpolation
- All object name lookups use `COLLATE NOCASE`

## Database Files

Databases are not in the repo (gitignored). Build them with:
```bash
npm run build:kb       # Builds d365fo_kb.sqlite (~1 GB)
npm run build:xref     # Builds d365fo_xref.sqlite (~3.3 GB)
npm run build:sec      # Builds d365fo_sec.sqlite (~60 MB)
```

Set paths via environment variables or `.env` file (see `.env.example`).
