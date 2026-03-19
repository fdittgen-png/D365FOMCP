# Architecture: D365FO MCP Services

**Project**: tis-p-mcpd365fo
**Owner**: Trelleborg IT Services (TIS)
**Version**: 2.0
**Date**: 2026-03-18
**Author**: Florian Dittgen
**Status**: Current

---

## 1. Overview

D365FO MCP Services provides two AI-accessible metadata intelligence services for Microsoft Dynamics 365 Finance & Operations:

- **Knowledge Base (KB)** -- structured metadata (tables, fields, enums, classes, methods with full X++ source, entities, security objects, labels)
- **Cross-Reference (XRef)** -- code dependency graph (who calls/reads/extends/implements what, with line-level precision)

Both services expose tools via the **Model Context Protocol (MCP)** using Streamable HTTP transport. Consumers include Claude Code, Claude Desktop, Cursor, and any MCP-compatible client.

**Key metrics:**

| Dimension | Value |
|-----------|-------|
| KB tools | 17 |
| XRef tools | 16 |
| Total tools | 33 |
| KB database size | ~1,063 MB |
| XRef database size | ~3,300 MB |
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
│  │   + sql.js)      │              │   + sql.js)           │       │
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
| Database engine | sql.js (KB), better-sqlite3 (XRef) | better-sqlite3 (both) |
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
LocalDB SQL Server                   build-xref-db.js (mssql + sql.js WASM)
──────────────────                   ──────────────────────────────────────
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

## Related Documentation

| Document | Description |
|----------|-------------|
| [Implementation](Implementation.md) | Build pipeline, database schemas, tool catalog, dependencies |
| [Administration](Administration.md) | Build/deploy procedures, monitoring, troubleshooting |
| [AI Configuration](AI-Configuration.md) | MCP client setup for Claude, Copilot, ChatGPT, Gemini, Cursor |
| [README](../README.md) | Project overview and quick start |
