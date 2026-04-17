# Architecture: D365FO MCP Services

**Project**: tis-p-mcpd365fo
**Owner**: Trelleborg IT Services (TIS)
**Version**: 2.0
**Date**: 2026-03-18
**Author**: Florian Dittgen
**Status**: Current

---

## 1. Overview

D365FO MCP Services provides four AI-accessible metadata intelligence services for Microsoft Dynamics 365 Finance & Operations:

- **Knowledge Base (KB)** -- structured metadata (tables, fields, enums, classes, methods with full X++ source, entities, security objects, labels)
- **Cross-Reference (XRef)** -- code dependency graph (who calls/reads/extends/implements what, with line-level precision)
- **Security (Sec)** -- normalized security configuration (roles, duties, privileges, sub-roles, users, company scoping, Grant/Deny semantics)
- **Task Recorder** -- parses `.axtr` task recording artifacts into Markdown for downstream LLM consumption

All four services expose tools via the **Model Context Protocol (MCP)** using Streamable HTTP transport. Consumers include Claude Code, Claude Desktop, Cursor, ChatGPT, and any MCP-compatible client.

**Key metrics:**

| Dimension | Value |
|-----------|-------|
| KB tools | 17 |
| XRef tools | 16 |
| Security tools | 15 |
| Task Recorder tools | 1 |
| **Total tools** | **49 across 4 services** |
| KB database size | ~1,063 MB |
| XRef database size | ~3,300 MB |
| Security database size | ~60 MB |
| Transport (Azure) | MCP Streamable HTTP |
| Transport (Local) | MCP stdio |
| Runtime | Node.js 20 on Azure Functions v4 |
| Database engine | SQLite via better-sqlite3 |

---

## 2. System Architecture

### 2.1 End-to-End Data Flow

```
┌────────────────────────────────────────────────────────────────────┐
│  D365FO Development Environment                                    │
│                                                                    │
│  ┌──────────────────────────┐    ┌───────────────────────────┐    │
│  │  PackagesLocalDirectory  │    │  LocalDB (SQL Server)     │    │
│  │  (Microsoft + ISV XML)   │    │  XRef_tbg-dev365...       │    │
│  └─────────┬────────────────┘    └─────────────┬─────────────┘    │
│            │                                    │                  │
│            ▼                                    ▼                  │
│  ┌──────────────────┐              ┌──────────────────────┐       │
│  │  build-kb.js     │              │  build-xref-db.js    │       │
│  │  (fast-xml-parser │              │  (mssql/tedious      │       │
│  │   + sql.js)      │              │   + better-sqlite3)   │       │
│  └────────┬─────────┘              └──────────┬───────────┘       │
│           │                                    │                   │
│           ▼                                    ▼                   │
│  ┌──────────────────┐              ┌──────────────────────┐       │
│  │ d365fo_kb.sqlite │              │ d365fo_xref.sqlite   │       │
│  │    (~1,063 MB)   │              │    (~3,300 MB)       │       │
│  └────────┬─────────┘              └──────────┬───────────┘       │
│           │                                    │                   │
└───────────┼────────────────────────────────────┼───────────────────┘
            │           Kudu VFS API             │
            ▼                                    ▼
┌────────────────────────────────────────────────────────────────────┐
│  Azure Resource Group: tis-{env}-mcpd365fo-rg                      │
│                                                                    │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  Azure Function App (Linux, EP1)                             │  │
│  │  tis-{env}-mcpd365fo-func                                   │  │
│  │                                                              │  │
│  │  ┌─────────────────┐     ┌─────────────────┐                │  │
│  │  │  /api/d365kb    │     │  /api/d365xref  │                │  │
│  │  │  (MCP Endpoint) │     │  (MCP Endpoint) │                │  │
│  │  └───────┬─────────┘     └───────┬─────────┘                │  │
│  │          │                       │                           │  │
│  │          ▼                       ▼                           │  │
│  │  ┌───────────────────────────────────────────┐               │  │
│  │  │  better-sqlite3 (native, read-only)       │               │  │
│  │  │  200 MB cache, 3 GB mmap                  │               │  │
│  │  └───────────────────┬───────────────────────┘               │  │
│  │                      │                                       │  │
│  │                      ▼                                       │  │
│  │  ┌───────────────────────────────────────────┐               │  │
│  │  │  /home/data/  (persistent filesystem)     │               │  │
│  │  │  ├── d365fo_kb.sqlite                     │               │  │
│  │  │  └── d365fo_xref.sqlite                   │               │  │
│  │  └───────────────────────────────────────────┘               │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                    │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────────┐   │
│  │  Key Vault   │  │  Storage     │  │  App Insights +        │   │
│  │  (secrets)   │  │  Account     │  │  Log Analytics         │   │
│  └──────────────┘  └──────────────┘  └────────────────────────┘   │
└────────────────────────────────────────────────────────────────────┘

          ▲               ▲               ▲
          │ HTTPS/MCP     │ HTTPS/MCP     │ HTTPS/MCP
          │               │               │
   ┌──────┴──────┐ ┌──────┴──────┐ ┌──────┴──────┐
   │ Claude Code │ │   Claude    │ │   Cursor /  │
   │             │ │   Desktop   │ │  Other MCP  │
   └─────────────┘ └─────────────┘ └─────────────┘
```

### 2.2 Deployment Modes

The system supports two deployment modes with shared tool implementations:

| Aspect | Local Mode | Azure Mode |
|--------|-----------|------------|
| Transport | MCP stdio (JSON-RPC over stdin/stdout) | MCP Streamable HTTP (POST/SSE) |
| Database engine | sql.js (KB only), better-sqlite3 (XRef) | better-sqlite3 (both) |
| DB location | `%USERPROFILE%\.claude\` | `/home/data/` on Function App |
| Entry points | `src/local/mcp-server-kb.js`, `src/local/mcp-server-xref.js` | `src/functions/d365kb.js`, `src/functions/d365xref.js` |
| Consumers | Single developer (Claude Code, Claude Desktop) | Multiple concurrent (any MCP client over HTTPS) |
| Tool logic | `src/azure/kb-tools.js`, `src/azure/xref-tools.js` | Same files (shared) |

The tool implementation layer (`kb-tools.js`, `xref-tools.js`, `shared.js`) is shared between both modes. Only the transport and database initialization differ.

---

## 3. Data Sources

### 3.1 Knowledge Base Sources

| Source | Description | Location |
|--------|------------|----------|
| Microsoft PackagesLocalDirectory | Standard D365FO XML metadata (AxTable, AxClass, AxEnum, AxEdt, AxDataEntityView, AxForm, AxView, AxSecurityRole/Duty/Privilege, AxMenuItemDisplay/Action/Output) | `%LOCALAPPDATA%\Microsoft\Dynamics365\10.0.2263.202\PackagesLocalDirectory` |
| ISV/Custom Metadata | Custom and ISV model metadata in same XML format | `C:\Workspace\DEV\Metadata` |
| Label files | en-US `.label.txt` files for resolving `@SYS12345` references | Within both package directories under `AxLabelFile/LabelResources/en-US/` |

### 3.2 Cross-Reference Sources

| Source | Description | Location |
|--------|------------|----------|
| Visual Studio XRef LocalDB | Cross-reference database populated by VS D365FO tools | `(LocalDB)\MSSQLLocalDB` database `XRef_tbg-dev3651002263172` |

**Important:** The cross-reference database is initially provided by Microsoft and only contains references for standard Microsoft models. To include ISV and custom model references, a full cross-reference build must be performed in Visual Studio (Dynamics 365 > Build Cross Reference Data). Until that build completes, XRef queries will only return results for Microsoft standard objects.

---

## 4. Data Flow

### 4.1 KB Build Pipeline

```
XML Metadata Files                    build-kb.js (sql.js WASM)
─────────────────                    ──────────────────────────
AxTable/*.xml       ──┐              Phase 0: Load 369K+ labels from 796 en-US label files
AxEnum/*.xml        ──┤              Phase 1: Parse XML, extract 10 object types
AxEdt/*.xml         ──┤   ────►     Phase 2: Module summaries, FTS index, curated data
AxClass/*.xml       ──┤              Output:  d365fo_kb.sqlite (~1,063 MB)
AxDataEntityView/*  ──┤
AxForm/*.xml        ──┤
AxView/*.xml        ──┤
AxSecurityRole/*    ──┤
AxMenuItemDisplay/* ──┘
```

### 4.2 XRef Build Pipeline

```
LocalDB SQL Server                   build-xref-db.js (mssql + better-sqlite3)
──────────────────                   ────────────────────────────────────────
dbo.Names (5.8M rows)   ──┐         Stream all rows → SQLite names table
dbo.References (26.6M)  ──┤ ────►   Stream all rows → SQLite refs table
dbo.Modules (390+)      ──┤         Copy modules + providers
dbo.Providers            ──┘         Create indexes, export to file
                                     Output: d365fo_xref.sqlite (~3,300 MB)
```

### 4.3 Deployment Pipeline

```
Build-Databases.ps1    Deploy-Infrastructure.ps1    Deploy-FunctionApp.ps1
───────────────────    ─────────────────────────    ──────────────────────
  Build SQLite DBs  →   Bicep → Azure resources  →  Code zip + DB upload
  (on dev machine)       (one-time setup)            (Kudu VFS API)
```

---

## 5. Azure Resource Inventory

All resources are deployed via Bicep (`infra/main-rg.bicep` + modules).

### 5.1 Resources

| Resource | Type | Bicep Name | Purpose |
|----------|------|-----------|---------|
| Function App | `Microsoft.Web/sites` | `tis-{env}-mcpd365fo-func` | Hosts MCP endpoints, runs better-sqlite3 queries |
| App Service Plan | `Microsoft.Web/serverfarms` | `tis-{env}-mcpd365fo-asp` | EP1 Elastic Premium (Linux), max 3 workers |
| Storage Account | `Microsoft.Storage/storageAccounts` | `tis{env}mcpd365fost` | Azure Functions runtime storage |
| Key Vault | `Microsoft.KeyVault/vaults` | `tis-{env}-mcpd365fo-kv` | Secrets management (RBAC-enabled) |
| Application Insights | `Microsoft.Insights/components` | `tis-{env}-mcpd365fo-appi` | Telemetry and monitoring |
| Log Analytics | `Microsoft.OperationalInsights/workspaces` | `tis-{env}-mcpd365fo-log` | Log aggregation (30-day retention) |

### 5.2 Naming Convention

| Pattern | Example (dev) | Example (prod) |
|---------|--------------|----------------|
| `{prefix}-{env}-{workload}-{suffix}` | `tis-d-mcpd365fo-func` | `tis-p-mcpd365fo-func` |
| Resource Group | `tis-d-mcpd365fo-rg` | `tis-p-mcpd365fo-rg` |
| Storage (no hyphens) | `tisdmcpd365fost` | `tispmcpd365fost` |

Where: `prefix`=tis, `env`=d/p, `workload`=mcpd365fo.

### 5.3 Tags

All resources are tagged consistently:

| Tag | Value |
|-----|-------|
| Owner | TIS |
| Environment | Development / Production |
| Workload | mcpd365fo |
| CostCenter | IT-Services |
| ManagedBy | Florian Dittgen |

---

## 6. Database Storage

### 6.1 Persistent Filesystem

SQLite databases are stored on the Function App's persistent `/home/data/` filesystem, which survives restarts and scale-out events on Linux App Service.

| File | Path | Size |
|------|------|------|
| KB database | `/home/data/d365fo_kb.sqlite` | ~1,063 MB |
| XRef database | `/home/data/d365fo_xref.sqlite` | ~3,300 MB |

The paths are configured via app settings `KB_DB_PATH` and `XREF_DB_PATH` in the Function App.

### 6.2 Database Access Pattern

- **Read-only**: Databases are opened with `{ readonly: true }` flag
- **Journal mode OFF**: No write-ahead log (read-only)
- **200 MB page cache**: `PRAGMA cache_size = -200000`
- **3 GB memory-mapped I/O**: `PRAGMA mmap_size = 3221225472`
- **Singleton instances**: One `better-sqlite3` connection per database, reused across requests

---

## 7. Network and Security

### 7.1 Transport Security

- All endpoints are **HTTPS only** (`httpsOnly: true`)
- Minimum TLS 1.2 enforced
- FTPS disabled
- No database connection strings or credentials -- SQLite is a local file, no network access

### 7.2 Identity and Access

| Component | Authentication |
|-----------|---------------|
| MCP endpoints | Anonymous (authLevel: anonymous) -- intended for internal/VPN use |
| Function App → Key Vault | System-assigned Managed Identity with Key Vault Secrets User role |
| Database upload | Kudu publishing credentials (Basic auth over HTTPS) |

### 7.3 Function App Configuration

| Setting | Value |
|---------|-------|
| `FUNCTIONS_WORKER_RUNTIME` | `node` |
| `FUNCTIONS_EXTENSION_VERSION` | `~4` |
| `linuxFxVersion` | `NODE\|20` |
| `KB_DB_PATH` | `/home/data/d365fo_kb.sqlite` |
| `XREF_DB_PATH` | `/home/data/d365fo_xref.sqlite` |
| `SCM_DO_BUILD_DURING_DEPLOYMENT` | `false` (pre-built Linux binaries shipped) |

---

## 8. MCP Endpoint URLs

| Service | Endpoint | Methods |
|---------|----------|---------|
| KB | `https://tis-{env}-mcpd365fo-func.azurewebsites.net/api/d365kb` | GET, POST, DELETE |
| XRef | `https://tis-{env}-mcpd365fo-func.azurewebsites.net/api/d365xref` | GET, POST, DELETE |

- **GET** (without `Accept: text/event-stream`): Health check, returns `{ name, version, status }`.
- **POST**: MCP JSON-RPC messages (tool invocation).
- **DELETE**: MCP session cleanup.

---

## 9. OTRS Support-Case Pipeline

A second class of Functions on the same Function App ingests resolved D365 support tickets from OTRS into a human- and LLM-readable wiki. These routes are **plain HTTP**, not MCP — Power Automate invokes them on a schedule, and the extractor writes state, which breaks the read-only MCP contract.

### 9.1 Three-Layer Design

```
┌──────────────────────────────────────────────────────────────────┐
│  Layer 1 — Extraction pipeline (HTTP on tis-{env}-mcpd365fo-func) │
│                                                                  │
│   Power Automate (scheduled)                                     │
│         │                                                        │
│         ▼                                                        │
│   POST /api/otrs/extract  ──► OTRS TicketSearch + TicketGet     │
│         │                     (validates every ticket; records   │
│         │                      extracted IDs in state blob)      │
│         ▼                                                        │
│   Response: application/xml  (see otrs-xml.js envelope)         │
│         │                                                        │
│   Power Automate forwards XML                                    │
│         │                                                        │
│         ▼                                                        │
│   POST /api/otrs/ingest   ──► parses XML, writes markdown pages │
│                               + updates wiki/index.md            │
├──────────────────────────────────────────────────────────────────┤
│  Layer 2 — Wiki storage (Azure Blob Storage)                     │
│                                                                  │
│   Container: wiki                                                │
│     ├── index.md                (catalog of all tickets)         │
│     └── tickets/<ticketId>.md   (one page per resolved case)     │
│                                                                  │
│   Markdown files follow the Karpathy/Starmorph LLM-wiki pattern: │
│   YAML frontmatter (ticketId, closedAt, service, tags) plus      │
│   description / resolution / article trace. No vector DB, no     │
│   embedding pipeline — index.md is the retrieval handle.         │
├──────────────────────────────────────────────────────────────────┤
│  Layer 3 — Query surface (future MCP + human viewer)             │
│                                                                  │
│   GET /api/wiki?page=<slug>  ──► renders markdown → HTML (users) │
│   MCP otrs_search_resolved    ──► reads blob at query time (LLM) │
└──────────────────────────────────────────────────────────────────┘
          ▲                ▲                ▲
          │ schedule       │ browse         │ MCP
          │                │                │
   ┌──────┴──────┐  ┌──────┴──────┐  ┌──────┴──────────┐
   │  Power      │  │  1st-level  │  │  Claude Code /  │
   │  Automate   │  │  support    │  │  Copilot /…     │
   └─────────────┘  └─────────────┘  └─────────────────┘
```

### 9.2 Components

| Layer | File | Role |
|-------|------|------|
| 1 | `src/functions/otrs-extract.js` | HTTP route `POST /api/otrs/extract`; parses body, reads config+state, delegates to core, persists new state, serializes XML |
| 1 | `src/azure/otrs-extract-core.js` | Pure orchestration: search → get → validate → collect. No I/O; unit-testable without the Functions host |
| 1 | `src/azure/otrs-client.js` | OTRS REST client — `searchTickets`, `getTicket`, `validateTicket`, `readOtrsConfig`. Injectable `fetch` |
| 1 | `src/azure/otrs-storage.js` | State blob `otrs-extract-state.json` in container `otrs-state`. Stores the list of already-extracted ticket IDs |
| 1 | `src/azure/otrs-xml.js` | `<OtrsExtract>` envelope with CDATA-wrapped bodies and an inline `<Skipped>` block |
| 2 | *(future)* `src/functions/otrs-ingest.js` | HTTP route `POST /api/otrs/ingest`; parses XML and writes markdown to the `wiki` container |
| 3 | *(future)* `src/functions/wiki-viewer.js` | HTTP route `GET /api/wiki?page=…`; renders markdown → HTML for humans |
| 3 | *(future)* `src/azure/otrs-tools.js` | MCP tools (`otrs_search_resolved`, `otrs_get_case`, …) reading the same blob container |

Layer 1 ships today. Layers 2 and 3 are separate CRs — the research is in the Architecture doc so the design is locked in before implementation.

### 9.3 Auth model

Unlike the MCP endpoints (anonymous, intended for internal / VPN use), the OTRS routes use **function-key auth** (`authLevel: 'function'`). Power Automate's HTTP action supports function keys natively and there is no user principal to authenticate at the pipeline layer. The function key is managed in the portal under **Function App → App keys → default**.

### 9.4 Validation gate

Every ticket is rejected from the wiki unless it passes three gates in `validateTicket()`:

1. **State** is a "closed" variant (belt-and-suspenders with the TicketSearch filter).
2. **≥1 customer article** with a non-empty body — the ticket has a documented problem.
3. **Agent-article bodies** total at least `OTRS_MIN_RESOLUTION_CHARS` (default 200) — the ticket has a documented resolution, not a one-line "fixed it".

Skipped tickets are reported inline under `<Skipped>` with a human-readable reason so Power Automate can log quality issues without a second round-trip. Their IDs are **not** recorded in the state blob — if the resolution is later improved in OTRS, the next run picks them up.

### 9.5 State semantics

| Mode | Effect on state blob |
|------|----------------------|
| `incremental` (default) | Extracts tickets whose ID is not in `processedTicketIds`. Successful extractions are appended to the list. |
| `full` | Ignores `processedTicketIds` entirely (still appends on success). Used to backfill a fresh wiki. |
| `preview` | Same filter as `incremental` but **does not write the state blob**. Used by Power Automate dry-runs. |

Resetting the marker is an operator action — delete the `otrs-extract-state.json` blob in the `otrs-state` container and the next run behaves like the first.

---

## 10. Wiki MCP Platform — one shape, many wikis

The Function App also hosts a **multi-tenant wiki MCP**: one code path, one HTTP route, many independently-scoped wikis. Adding a new wiki is a config-plus-blob-container operation — no new Function, no new route, no per-wiki code.

### 10.1 Why multi-tenant

Different domains (resolved support cases, IT policies, internal runbooks, product documentation) all want the same thing: markdown files in a store, indexed by an `index.md`, readable by an LLM. Building one MCP per wiki would fork code every time the organization adds a knowledge source. Instead, every wiki shares the same four tools and differs only in its **container + description**.

### 10.2 Route + registry

```
                 config/wikis.json  (or env var WIKI_CONFIG_JSON)
                         │
                         ▼
               ┌───────────────────────┐
 POST ───────► │  /api/wiki-mcp/{name} │ ──► McpServer(wiki-<name>) ──► 4 tools
               └───────────┬───────────┘
                           │
                           ▼
                   ┌───────────────┐
                   │ Blob Storage  │
                   │ container=<X> │
                   │  index.md     │
                   │  pages/…md    │
                   └───────────────┘

GET /api/wiki-mcp           → catalog of every configured wiki (no MCP — a plain JSON index for operators)
```

One **parameterized route** at request time looks up the wiki by path segment against an in-memory registry; the registry is loaded lazily from `config/wikis.json` with an optional `WIKI_CONFIG_JSON` env override. A fresh `McpServer` + transport is spun up per request so tool state stays isolated.

### 10.3 Tool catalog (per wiki)

Every wiki exposes exactly the same four MCP tools — only their descriptions reference the specific wiki:

| Tool | Purpose |
|------|---------|
| `wiki_index` | Read the catalog (`index.md`) — the LLM starts here to see what the wiki contains. |
| `wiki_list` | Enumerate every page with slug, title, tags, summary. Cheaper than `wiki_index` when only the catalog structure is needed. |
| `wiki_read` | Read a single page by slug. Returns full markdown + parsed frontmatter + body. |
| `wiki_search` | Weighted substring search across title / tags / body with snippets. |

All four follow the project's response-format contract ([`docs/Response-Format-Contract.md`](Response-Format-Contract.md)): H2 heading, freshness banner derived from `index.md`'s `lastModified`, typed-first `structuredResult`, category-based `errorResult`, `formatMarkdownTable` for tabular output.

### 10.4 Registry schema

`config/wikis.json` is a JSON array. Each entry:

| Field | Required | Purpose |
|-------|----------|---------|
| `name` | yes | Slug used in the URL (`/api/wiki-mcp/<name>`) and the MCP server name. Pattern `^[a-z0-9][a-z0-9-]{0,62}$`. |
| `title` | yes | Human-readable title shown in the catalog and to the LLM. |
| `description` | yes | Sentence(s) telling the LLM what the wiki contains and when it's relevant. Becomes the MCP server description. |
| `container` | yes | Azure Blob Storage container holding the markdown files. |
| `indexBlob` | no | Filename of the catalog page. Default `index.md`. |
| `pagesPrefix` | no | Blob-name prefix under which page files live (e.g. `tickets/`). Default empty string (container root). |

### 10.5 Components

| File | Role |
|------|------|
| `src/azure/wiki-registry.js` | Load + validate the registry (file or env) |
| `src/azure/wiki-storage.js` | Blob client, 60-second TTL cache, minimal YAML frontmatter parser, lastModified-derived freshness banner |
| `src/azure/wiki-search.js` | Pure function: weighted scoring + snippet extraction |
| `src/azure/wiki-tools.js` | Registers the four MCP tools on a server, given a wiki config |
| `src/functions/wiki-mcp.js` | Parameterized HTTP route `wiki-mcp/{name}` + `wiki-mcp` catalog |
| `src/local/mcp-server-wiki.js` | Local stdio entry — one client-config entry per wiki |
| `scripts/Add-WikiMcp.ps1` | One-command provisioning — updates the registry, creates the container, optionally seeds `index.md` and redeploys |

### 10.6 Adding a new wiki

One command (detail in [Administration §12](Administration.md#12-wiki-mcp-operations)):

```powershell
.\Add-WikiMcp.ps1 -Name runbooks `
                  -Title 'Operations Runbooks' `
                  -Description 'Runbooks for common operational tasks across D365 and supporting platforms.' `
                  -PagesPrefix 'runbooks/' -SeedIndex -Redeploy
```

Internally:
1. Validates the slug, appends an entry to `config/wikis.json`
2. Creates the blob container (`wiki-runbooks` by default)
3. Optionally uploads a seed `index.md` so `wiki_index` responds immediately
4. Optionally redeploys the Function App

After redeploy the new MCP is reachable at `/api/wiki-mcp/runbooks` with no further code changes.

### 10.7 Populating a wiki

The MCP **only reads** — how markdown files get into the container is a separate concern:

- **OTRS-style ingest pipeline** (Function B, future CR): Power Automate → `POST /api/otrs/ingest` → markdown written to container
- **Manual upload**: `az storage blob upload` during onboarding or one-off edits
- **Logic App / custom pipeline**: for wikis sourced from Confluence, SharePoint, GitHub etc.

The wiki MCP is ingest-agnostic — any process that lands valid markdown in the container becomes usable by the LLM on the next request (modulo the 60-second cache TTL).

### 10.8 Design constraints

- **No vector index.** The Karpathy/Starmorph pattern — `index.md` is the retrieval handle, the LLM navigates from there — holds well for up to a few hundred pages. When a wiki outgrows that, the right response is to split it into sub-wikis with tighter descriptions, not to graft embeddings on.
- **No auth on the route.** Consistent with the other MCP endpoints (anonymous, intended for internal / VPN use). If a wiki needs stricter access, front it with APIM — don't embed auth logic in the Function.
- **One wiki per container.** A container is the authorization boundary; a single wiki spanning multiple containers would leak privileges through the MCP.

---

## Related Documentation

| Document | Description |
|----------|-------------|
| [Implementation](Implementation.md) | Build pipeline, database schemas, tool catalog, dependencies |
| [Administration](Administration.md) | Build/deploy procedures, monitoring, troubleshooting |
| [AI Configuration](AI-Configuration.md) | MCP client setup for Claude, Copilot, ChatGPT, Gemini, Cursor |
| [PowerAutomate — Security DB update](PowerAutomate-SecDatabase-Update.md) | Daily DMF refresh flow for the security MCP |
| [PowerAutomate — OTRS Extractor](PowerAutomate-OTRS-Extract.md) | Scheduled OTRS → wiki extraction flow |
| [MCP — Wiki Services](MCP-Wiki-Services.md) | MCP-client-facing reference for the multi-wiki platform |
| [VS Code Guide](VS-Code-Guide.md) | VS Code setup, debugging, workflow, extensions |
| [README](../README.md) | Project overview and quick start |
