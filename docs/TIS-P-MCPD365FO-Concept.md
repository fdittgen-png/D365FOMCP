> **DEPRECATED**: This document describes the original Azure SQL-based design (v1.0). The architecture was migrated to SQLite in v2.0. See [Architecture.md](Architecture.md), [Implementation.md](Implementation.md), and [Administration.md](Administration.md) for current documentation.

# Concept Document: D365FO MCP Services on Azure

**Project**: tis-p-mcpd365fo
**Owner**: Trelleborg IT Services (TIS)
**Version**: 1.0
**Date**: 2026-03-16
**Author**: Florian Dittgen
**Status**: Draft

---

## 1. Executive Summary

This document describes the architecture and implementation design for hosting two D365FO metadata intelligence services — **Knowledge Base (KB)** and **Cross-Reference (XRef)** — as Azure Functions with an Azure SQL backend. The services expose 29 tools (16 KB + 13 XRef) via dual protocols: **MCP (Model Context Protocol)** for AI agents (Claude Code, Cursor, etc.) and **REST API** for integration clients (Power Automate, Teams, dashboards).

The solution replaces the current local-only architecture (SQLite in-memory, stdio transport) with a centrally hosted, multi-consumer service while preserving sub-100ms query latency and full data fidelity.

**Key metrics:**

| Dimension | Current (Local) | Target (Azure) |
|-----------|----------------|----------------|
| Consumers | 1 developer (stdio) | Unlimited (HTTP) |
| Protocol | MCP/stdio only | MCP/HTTP + REST API |
| Data freshness | Manual local rebuild | Local build → Azure deploy |
| Availability | Only when Claude Code running | 24/7 |
| Memory footprint | ~4.5 GB local RAM | 0 local (Azure SQL) |
| Query latency | 1-50 ms (in-memory) | 10-80 ms (Azure SQL) |

---

## 2. Current Architecture (As-Is)

### 2.1 System Overview

```
┌──────────────────────────────────────────────────────┐
│  Developer Workstation                               │
│                                                      │
│  ┌────────────┐    stdio/JSON-RPC    ┌────────────┐ │
│  │ Claude Code ├────────────────────►│ d365kb MCP │ │
│  │   (Client)  │                     │  Server    │ │
│  │             │                     │ (Node.js)  │ │
│  │             │                     │  968 MB    │ │
│  │             │    stdio/JSON-RPC   ├────────────┤ │
│  │             ├────────────────────►│ d365xref   │ │
│  │             │                     │ MCP Server │ │
│  └────────────┘                     │ (Node.js)  │ │
│                                     │  3.3 GB    │ │
│                                     └────────────┘ │
│                                                      │
│  Data Sources:                                       │
│  ├─ PackagesLocalDirectory (XML metadata)            │
│  └─ LocalDB (XRef cross-references)                  │
└──────────────────────────────────────────────────────┘
```

### 2.2 Service Specifications

| Service | Database | Objects | Tools | Build Time | Memory |
|---------|----------|---------|-------|------------|--------|
| **d365kb** | 968 MB SQLite | 17,634 tables, 63,412 classes, 820,230 methods (with full X++ source), 7,846 enums, 5,422 entities | 16 | ~10 min | ~1 GB |
| **d365xref** | 3,287 MB SQLite | 5.8M named paths, 26.6M references, 390 modules | 13 | ~22 min | ~3.5 GB |

### 2.3 Limitations of Current Architecture

1. **Single-user**: Only accessible from one developer workstation via stdio
2. **High local RAM**: 4.5 GB combined memory footprint
3. **No shared access**: Other team members, Power Automate flows, and non-MCP tools cannot consume the data
4. **Manual lifecycle**: Build and restart are manual processes
5. **No monitoring**: No telemetry, no alerting, no usage tracking

---

## 3. Target Architecture (To-Be)

### 3.1 High-Level Architecture

```
                          ┌─────────────────────────────────────────────┐
                          │  Azure Resource Group                       │
                          │  tis-p-mcpd365fo-rg                        │
                          │                                             │
 ┌──────────────┐  HTTPS  │  ┌──────────────────────────────────────┐  │
 │ Claude Code  ├────────►│  │  Azure Function App                  │  │
 │ (MCP Client) │  MCP    │  │  tis-p-mcpd365fo-func               │  │
 └──────────────┘  POST   │  │                                      │  │
                          │  │  ┌─────────┐  ┌─────────────────┐   │  │
 ┌──────────────┐  HTTPS  │  │  │   MCP   │  │   REST API      │   │  │
 │ Other LLM    ├────────►│  │  │ Endpoint│  │  /api/kb/{tool} │   │  │
 │ Agents       │  MCP    │  │  │ /mcp    │  │  /api/xref/{t}  │   │  │
 └──────────────┘  POST   │  │  └────┬────┘  └───────┬─────────┘   │  │
                          │  │       │                │             │  │
 ┌──────────────┐  HTTPS  │  │  ┌────▼────────────────▼──────────┐ │  │
 │ Power Auto-  ├────────►│  │  │     Tool Implementation Layer  │ │  │
 │ mate / Apps  │  REST   │  │  │  (shared query + format logic) │ │  │
 └──────────────┘         │  │  └────────────┬───────────────────┘ │  │
                          │  │               │                     │  │
 ┌──────────────┐  HTTPS  │  └───────────────┼─────────────────────┘  │
 │ Dashboards / ├────────►│                  │ SQL                    │
 │ Teams Bots   │  REST   │  ┌───────────────▼─────────────────────┐  │
 └──────────────┘         │  │  Azure SQL Database                 │  │
                          │  │  tis-p-mcpd365fo-sqldb              │  │
                          │  │                                     │  │
                          │  │  Schema: kb.*    Schema: xref.*     │  │
                          │  │  (21 tables)     (6 tables)         │  │
                          │  │  ~1 GB           ~4 GB              │  │
                          │  └─────────────────────────────────────┘  │
                          │                                             │
                          │  ┌──────────┐ ┌──────┐ ┌──────┐ ┌──────┐ │
                          │  │ appi     │ │ log  │ │ kv   │ │ st   │ │
                          │  └──────────┘ └──────┘ └──────┘ └──────┘ │
                          └─────────────────────────────────────────────┘

                          ┌──────────────────────────────────────────────┐
                          │  Developer Workstation (Build Only)          │
                          │                                              │
                          │  PackagesLocalDirectory ──► build-kb.js      │
                          │  LocalDB XRef DB ────────► build-xref-db.js  │
                          │                    │                         │
                          │                    ▼                         │
                          │           SQLite databases                   │
                          │                    │                         │
                          │                    ▼                         │
                          │         Deploy-McpD365fo.ps1                 │
                          │            (bcp / SqlPackage)                │
                          │                    │                         │
                          └────────────────────┼─────────────────────────┘
                                               │ HTTPS
                                               ▼
                                     Azure SQL Database
```

### 3.2 Design Principles

1. **Dual-protocol**: Every tool is accessible via both MCP (for AI agents) and REST (for everything else)
2. **Stateless functions**: No in-memory database loading; all state lives in Azure SQL
3. **Shared tool layer**: One implementation per tool, two protocol adapters
4. **Local build, cloud serve**: Build pipeline stays local (requires PackagesLocalDirectory + LocalDB); only the data is pushed to Azure
5. **Convention-compliant**: All resources follow Trelleborg naming convention v3.0

---

## 4. Azure Resource Naming

All resources follow the **Trelleborg Naming Convention v3.0**: `{prefix}-{env}-{workload}-{rtype}`

| Resource | Name | Format | Notes |
|----------|------|--------|-------|
| **Resource Group** | `tis-p-mcpd365fo-rg` | standard | |
| **Function App** | `tis-p-mcpd365fo-func` | standard | Node.js 20, Linux |
| **App Service Plan** | `tis-p-mcpd365fo-asp` | standard | Premium EP1 |
| **Storage Account** | `tispmcpd365fost` | slug | 15 chars (max 24) |
| **Key Vault** | `tis-p-mcpd365fo-kv` | standard | API keys, SQL connection |
| **Application Insights** | `tis-p-mcpd365fo-appi` | standard | Telemetry |
| **Log Analytics Workspace** | `tis-p-mcpd365fo-log` | standard | Diagnostics |
| **Azure SQL Server** | `tis-p-mcpd365fo-sql` | standard | Entra ID auth |
| **Azure SQL Database** | `tis-p-mcpd365fo-sqldb` | standard | Single DB, 2 schemas |

### 4.1 Resource Tags

| Tag | Value |
|-----|-------|
| `Owner` | TIS |
| `Environment` | Production |
| `Workload` | mcpd365fo |
| `CostCenter` | IT-Services |
| `ManagedBy` | Florian Dittgen |

---

## 5. Data Layer: Azure SQL Database

### 5.1 Schema Design

One Azure SQL Database with two schemas isolating the two services:

```
tis-p-mcpd365fo-sqldb
├── Schema: kb          (Knowledge Base - AOT metadata)
│   ├── kb.tables           (17,634 rows)
│   ├── kb.fields           (216,006 rows)
│   ├── kb.indexes_tbl      (23,284 rows)
│   ├── kb.relations        (44,881 rows)
│   ├── kb.enums            (7,846 rows)
│   ├── kb.edts             (22,550 rows)
│   ├── kb.classes          (63,412 rows)
│   ├── kb.methods          (820,230 rows)  ◄── includes source_code
│   ├── kb.data_entities    (5,422 rows)
│   ├── kb.entity_fields    (~50,000 rows)
│   ├── kb.forms            (9,058 rows)
│   ├── kb.views            (2,895 rows)
│   ├── kb.security_roles   (120 rows)
│   ├── kb.security_duties  (977 rows)
│   ├── kb.security_privileges (6,144 rows)
│   ├── kb.menu_items       (17,654 rows)
│   ├── kb.graph_edges      (~150,000 rows)
│   ├── kb.kb_search        (~120,000 rows)
│   ├── kb.hallucination_traps (11 rows)
│   ├── kb.field_renames    (9 rows)
│   ├── kb.query_templates  (5 rows)
│   ├── kb.modules          (165 rows)
│   ├── kb.object_paths     (~100,000 rows)
│   └── kb.kb_metadata      (5 rows)
│
└── Schema: xref        (Cross-References)
    ├── xref.names          (5,821,999 rows)
    ├── xref.refs           (26,589,848 rows)
    ├── xref.modules        (390 rows)
    ├── xref.providers      (2 rows)
    ├── xref.kind_map       (8 rows)
    └── xref.xref_metadata  (5 rows)
```

### 5.2 Azure SQL Tier Selection

**Workload profile**: Read-heavy, low concurrency, occasional bulk updates

| Option | DTU/vCores | Storage | Monthly Cost | Fit |
|--------|-----------|---------|-------------|-----|
| S2 (50 DTU) | 50 DTU | 250 GB | ~€60 | Minimal viable |
| **S3 (100 DTU)** | 100 DTU | 250 GB | **~€120** | **Recommended** |
| GP Serverless 2vc | 2 vCores | 32 GB | ~€80-280 | Auto-pause saves if idle |

**Recommendation**: **S3 (100 DTU)** — sufficient for 26.6M-row ref table joins with proper indexing, predictable cost. Consider GP Serverless if usage is sporadic.

### 5.3 Key Azure SQL Advantages over SQLite

| Feature | SQLite (sql.js) | Azure SQL |
|---------|-----------------|-----------|
| Full-Text Search | Not available (no FTS5 in WASM) | **Native FTS** on source_code, search content |
| Concurrent access | Single-process only | Multi-reader natively |
| Memory footprint | 4.5 GB in local RAM | 0 local RAM |
| Max database size | Limited by Node.js heap | 250 GB+ |
| Query optimizer | Basic | Advanced (statistics, adaptive joins) |
| Columnstore indexes | Not available | Available for analytics queries |

### 5.4 Index Strategy

**KB Schema — Critical Indexes:**

```sql
-- Primary keys (clustered) on all tables as in SQLite schema

-- Performance indexes (matching current SQLite indexes)
CREATE INDEX IX_kb_fields_table ON kb.fields (table_name);
CREATE INDEX IX_kb_relations_source ON kb.relations (source_table);
CREATE INDEX IX_kb_relations_target ON kb.relations (related_table);
CREATE INDEX IX_kb_methods_owner ON kb.methods (owner_type, owner_name);
CREATE INDEX IX_kb_classes_extends ON kb.classes (extends_class);
CREATE INDEX IX_kb_graph_source ON kb.graph_edges (source_node);
CREATE INDEX IX_kb_graph_target ON kb.graph_edges (target_node);
CREATE INDEX IX_kb_entity_fields ON kb.entity_fields (entity_name);

-- NEW: Full-Text Index on method source code
CREATE FULLTEXT CATALOG ftcat_kb AS DEFAULT;
CREATE FULLTEXT INDEX ON kb.methods (source_code, signature)
  KEY INDEX PK_methods ON ftcat_kb;

-- NEW: Full-Text Index on search table
CREATE FULLTEXT INDEX ON kb.kb_search (content, object_name)
  KEY INDEX PK_kb_search ON ftcat_kb;
```

**XRef Schema — Critical Indexes:**

```sql
-- Names
CREATE INDEX IX_xref_names_path ON xref.names (path);
CREATE INDEX IX_xref_names_module ON xref.names (module_id);

-- References (26.6M rows — most critical)
CREATE INDEX IX_xref_refs_source ON xref.refs (source_id);
CREATE INDEX IX_xref_refs_target ON xref.refs (target_id);
CREATE INDEX IX_xref_refs_kind ON xref.refs (kind);
CREATE INDEX IX_xref_refs_source_kind ON xref.refs (source_id, kind);
CREATE INDEX IX_xref_refs_target_kind ON xref.refs (target_id, kind);
```

### 5.5 Full-Text Search: New Capability

Azure SQL's native FTS enables a powerful new feature not possible with the current SQLite architecture:

```sql
-- Search for X++ code patterns across all 820K methods
SELECT owner_name, method_name, signature
FROM kb.methods
WHERE CONTAINS(source_code, '"changecompany" AND "InventTable"');

-- Find methods related to a concept
SELECT owner_name, method_name
FROM kb.methods
WHERE FREETEXT(source_code, 'product release engineering change order');
```

This replaces the current LIKE-based search (`kb_search` table) with true full-text search, significantly improving discovery capabilities for AI agents and human users.

---

## 6. Azure Function App Design

### 6.1 Function App Structure

```
tis-p-mcpd365fo-func/
├── package.json
├── host.json
├── local.settings.json          (dev only)
│
├── src/
│   ├── shared/
│   │   ├── db.js                 (Azure SQL connection pool)
│   │   ├── format.js             (Markdown table formatter)
│   │   └── auth.js               (API key + Entra ID validation)
│   │
│   ├── tools/
│   │   ├── kb/                   (16 KB tool implementations)
│   │   │   ├── lookupTable.js
│   │   │   ├── getJoinKeys.js
│   │   │   ├── getEnum.js
│   │   │   ├── getClassMethods.js
│   │   │   ├── getMethodSource.js    ◄── NEW tool
│   │   │   ├── search.js
│   │   │   ├── getModuleSummary.js
│   │   │   ├── listModules.js
│   │   │   ├── graphTraverse.js
│   │   │   ├── findReferencingTables.js
│   │   │   ├── getEntitySources.js
│   │   │   ├── sqlTemplate.js
│   │   │   ├── rawSql.js
│   │   │   ├── checkFieldExists.js
│   │   │   ├── hallucinationCheck.js
│   │   │   └── fieldRenames.js
│   │   │
│   │   └── xref/                 (13 XRef tool implementations)
│   │       ├── findReferences.js
│   │       ├── findUsages.js
│   │       ├── findMethodCallers.js
│   │       ├── classHierarchy.js
│   │       ├── interfaceImplementors.js
│   │       ├── searchNames.js
│   │       ├── methodReferences.js
│   │       ├── moduleObjects.js
│   │       ├── crossModuleDeps.js
│   │       ├── rawSql.js
│   │       ├── impactAnalysis.js
│   │       ├── listModules.js
│   │       └── objectSummary.js
│   │
│   └── functions/
│       ├── mcpEndpoint.js        (MCP Streamable HTTP handler)
│       ├── kbApi.js              (REST: /api/kb/{toolName})
│       ├── xrefApi.js            (REST: /api/xref/{toolName})
│       └── healthCheck.js        (GET /api/health)
│
└── infra/
    ├── main.bicep                (IaC — all Azure resources)
    ├── modules/
    │   ├── functionApp.bicep
    │   ├── sqlDatabase.bicep
    │   └── monitoring.bicep
    └── parameters.prod.json
```

### 6.2 Dual-Protocol Design

Every tool is implemented once and exposed via two protocol adapters:

```
                    ┌──────────────────────────────────┐
                    │  Tool Implementation (shared)     │
                    │  lookupTable(params) → result     │
                    └──────────┬───────────────────────┘
                               │
              ┌────────────────┼────────────────┐
              ▼                                 ▼
   ┌──────────────────┐             ┌──────────────────┐
   │  MCP Adapter      │             │  REST Adapter     │
   │  POST /mcp        │             │  POST /api/kb/    │
   │                   │             │    lookupTable    │
   │  JSON-RPC 2.0     │             │                   │
   │  {method:         │             │  Standard JSON    │
   │   "tools/call",   │             │  {table_name:     │
   │   params: {       │             │   "CustTable"}    │
   │    name: "d365_   │             │                   │
   │     lookup_table",│             │  Response:        │
   │    arguments: {   │             │  {data: "...",    │
   │     table_name:   │             │   format: "md"}   │
   │     "CustTable"   │             │                   │
   │   }}}             │             │                   │
   └──────────────────┘             └──────────────────┘
```

#### MCP Endpoint Implementation

```javascript
// src/functions/mcpEndpoint.js
import { app } from '@azure/functions';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerAllTools } from '../tools/registry.js';

// Single stateless MCP server instance
const server = new McpServer({
  name: 'tis-p-mcpd365fo',
  version: '1.0.0',
  description: 'D365FO Knowledge Base + Cross-Reference MCP Server',
});

registerAllTools(server);  // Registers all 29 tools

app.http('mcp', {
  methods: ['POST'],
  route: 'mcp',
  handler: async (request, context) => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,  // Stateless mode
    });
    await server.connect(transport);
    return transport.handleRequest(request);
  },
});
```

#### REST API Implementation

```javascript
// src/functions/kbApi.js
import { app } from '@azure/functions';
import { getKbTool } from '../tools/registry.js';
import { validateApiKey } from '../shared/auth.js';

app.http('kbApi', {
  methods: ['POST', 'GET'],
  route: 'api/kb/{toolName}',
  handler: async (request, context) => {
    // Auth
    if (!validateApiKey(request)) {
      return { status: 401, body: 'Unauthorized' };
    }

    const toolName = request.params.toolName;
    const tool = getKbTool(toolName);
    if (!tool) {
      return { status: 404, body: `Tool "${toolName}" not found` };
    }

    const params = request.method === 'GET'
      ? Object.fromEntries(new URL(request.url).searchParams)
      : await request.json();

    const result = await tool.execute(params);
    return {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tool: toolName,
        format: 'markdown',
        data: result,
      }),
    };
  },
});
```

### 6.3 Database Connection Layer

```javascript
// src/shared/db.js
import sql from 'mssql';
import { DefaultAzureCredential } from '@azure/identity';

const config = {
  server: process.env.SQL_SERVER,       // tis-p-mcpd365fo-sql.database.windows.net
  database: process.env.SQL_DATABASE,   // tis-p-mcpd365fo-sqldb
  authentication: {
    type: 'azure-active-directory-default',
  },
  options: {
    encrypt: true,
    trustServerCertificate: false,
  },
  pool: {
    max: 10,
    min: 2,
    idleTimeoutMillis: 30000,
  },
};

let pool;

export async function getPool() {
  if (!pool) {
    pool = await sql.connect(config);
  }
  return pool;
}

export async function query(sqlText, params = {}) {
  const p = await getPool();
  const request = p.request();
  for (const [key, value] of Object.entries(params)) {
    request.input(key, value);
  }
  return request.query(sqlText);
}
```

### 6.4 Tool Implementation Pattern

Each tool is a pure function that accepts parameters and returns formatted markdown:

```javascript
// src/tools/kb/lookupTable.js
import { query } from '../../shared/db.js';
import { formatMarkdownTable } from '../../shared/format.js';

export const definition = {
  name: 'd365_lookup_table',
  description: 'Get complete metadata for a D365FO table...',
  schema: {
    table_name: { type: 'string', description: 'Table name (case-insensitive)' },
  },
};

export async function execute({ table_name }) {
  const tn = table_name.trim();

  // Table header
  const tbl = await query(
    `SELECT table_name, module_id, label, table_group, save_per_company
     FROM kb.tables WHERE table_name = @tn COLLATE SQL_Latin1_General_CP1_CI_AS`,
    { tn }
  );

  if (tbl.recordset.length === 0) {
    // Fuzzy match...
    const fuzzy = await query(
      `SELECT TOP 10 table_name FROM kb.tables WHERE table_name LIKE @pattern`,
      { pattern: `%${tn}%` }
    );
    // return suggestions...
  }

  // Fields, Indexes, Relations... (same logic as current mcp-server.js)
  // Returns markdown string
}
```

### 6.5 App Service Plan

**Plan**: Premium EP1 (Elastic Premium)

| Setting | Value | Rationale |
|---------|-------|-----------|
| SKU | EP1 | 3.5 GB memory, 1 vCPU |
| OS | Linux | Lower cost than Windows |
| Runtime | Node.js 20 LTS | ES modules, async/await |
| Always Ready | 1 instance | Eliminates cold start |
| Max Burst | 3 instances | Handles concurrent load spikes |
| VNET Integration | Optional | If SQL needs private endpoint |

**Why Premium (not Consumption)?**
- Connection pool persistence (no cold-start SQL reconnect per invocation)
- Predictable latency for MCP clients (AI agents are latency-sensitive)
- Always-warm instance eliminates 5-10s cold start

---

## 7. API Design

### 7.1 MCP Protocol Endpoints

| Method | Route | Purpose |
|--------|-------|---------|
| POST | `/mcp` | MCP Streamable HTTP transport (JSON-RPC 2.0) |

**MCP Methods Supported:**

| JSON-RPC Method | Description |
|----------------|-------------|
| `initialize` | Capability negotiation |
| `tools/list` | Returns all 29 tool definitions |
| `tools/call` | Executes a specific tool |

**Client configuration (Claude Code `~/.claude.json`):**

```json
{
  "mcpServers": {
    "d365fo-azure": {
      "type": "streamable-http",
      "url": "https://tis-p-mcpd365fo-func.azurewebsites.net/mcp",
      "headers": {
        "x-api-key": "{{KEY_FROM_KEYVAULT}}"
      }
    }
  }
}
```

### 7.2 REST API Endpoints

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/health` | Health check (DB connectivity) |
| POST | `/api/kb/{toolName}` | Execute KB tool |
| POST | `/api/xref/{toolName}` | Execute XRef tool |
| GET | `/api/kb/{toolName}?param=value` | GET variant for simple queries |
| GET | `/api/xref/{toolName}?param=value` | GET variant for simple queries |

### 7.3 Complete Tool Inventory

**KB Tools (16):**

| REST Route | MCP Tool Name | Description |
|-----------|---------------|-------------|
| `/api/kb/lookupTable` | `d365_lookup_table` | Table metadata: fields, indexes, relations |
| `/api/kb/getJoinKeys` | `d365_get_join_keys` | Exact join fields between two tables |
| `/api/kb/getEnum` | `d365_get_enum` | Enum values with numeric codes |
| `/api/kb/getClassMethods` | `d365_get_class_methods` | Method signatures (optionally with source) |
| `/api/kb/getMethodSource` | `d365_get_method_source` | Full X++ source for a specific method |
| `/api/kb/search` | `d365_search` | Full-text search across all objects |
| `/api/kb/getModuleSummary` | `d365_get_module_summary` | Module object counts and key objects |
| `/api/kb/listModules` | `d365_list_modules` | All modules with counts |
| `/api/kb/graphTraverse` | `d365_graph_traverse` | Dependency graph traversal |
| `/api/kb/findReferencingTables` | `d365_find_referencing_tables` | Tables with FK to a given table |
| `/api/kb/getEntitySources` | `d365_get_entity_sources` | Data entity field source mappings |
| `/api/kb/sqlTemplate` | `d365_sql_template` | Pre-validated SQL query templates |
| `/api/kb/rawSql` | `d365_raw_sql` | Ad-hoc read-only SQL (KB schema only) |
| `/api/kb/checkFieldExists` | `d365_check_field_exists` | Verify field existence on a table |
| `/api/kb/hallucinationCheck` | `d365_hallucination_check` | Known LLM mistakes for a table |
| `/api/kb/fieldRenames` | `d365_field_renames` | AX2012 → D365FO field name map |

**XRef Tools (13):**

| REST Route | MCP Tool Name | Description |
|-----------|---------------|-------------|
| `/api/xref/findReferences` | `xref_find_references` | Who uses this object? (incoming) |
| `/api/xref/findUsages` | `xref_find_usages` | What does this object use? (outgoing) |
| `/api/xref/findMethodCallers` | `xref_find_method_callers` | Who calls this method? |
| `/api/xref/classHierarchy` | `xref_class_hierarchy` | Inheritance tree (up or down) |
| `/api/xref/interfaceImplementors` | `xref_interface_implementors` | Interface implementations |
| `/api/xref/searchNames` | `xref_search_names` | Search objects by name pattern |
| `/api/xref/methodReferences` | `xref_method_references` | What a method calls/reads |
| `/api/xref/moduleObjects` | `xref_module_objects` | Objects in a module |
| `/api/xref/crossModuleDeps` | `xref_cross_module_deps` | Module-level dependencies |
| `/api/xref/rawSql` | `xref_raw_sql` | Ad-hoc read-only SQL (XRef schema) |
| `/api/xref/impactAnalysis` | `xref_impact_analysis` | Change impact assessment |
| `/api/xref/listModules` | `xref_list_modules` | All modules with object counts |
| `/api/xref/objectSummary` | `xref_object_summary` | Compact object overview |

### 7.4 Response Format

All tools return markdown-formatted text (same as current MCP servers):

```json
// REST Response
{
  "tool": "d365_lookup_table",
  "format": "markdown",
  "data": "# CustTable\nModule: ApplicationSuite | Group: Main | PerCompany: Yes\n\n## Fields\n|Field|Type|EDT|Enum|Mand|\n|---|---|---|---|---|\n|AccountNum|String|CustAccount||Yes|\n...",
  "metadata": {
    "query_ms": 12,
    "row_count": 45
  }
}

// MCP Response (JSON-RPC 2.0)
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": [{
      "type": "text",
      "text": "# CustTable\nModule: ApplicationSuite | Group: Main..."
    }]
  }
}
```

---

## 8. Authentication & Security

### 8.1 Authentication Strategy

| Consumer | Auth Method | Implementation |
|----------|------------|----------------|
| Claude Code (MCP) | API Key | `x-api-key` header, key stored in Key Vault |
| Other MCP agents | API Key | Same as above |
| Power Automate | API Key or Entra ID | Managed Identity or shared key |
| Internal dashboards | Entra ID (Azure AD) | OAuth 2.0 bearer token |
| Health check | None | Public (no sensitive data) |

### 8.2 API Key Management

```
Key Vault: tis-p-mcpd365fo-kv
├── Secret: mcp-api-key-primary    (active key)
├── Secret: mcp-api-key-secondary  (rotation spare)
└── Secret: sql-connection-string  (if not using Managed Identity)
```

- Function App reads keys from Key Vault via Managed Identity
- Key rotation: generate new secondary → swap primary/secondary → regenerate old primary

### 8.3 Network Security

| Layer | Control |
|-------|---------|
| Function App | HTTPS only (TLS 1.2+) |
| Azure SQL | Firewall: allow Azure services + developer IP |
| Key Vault | RBAC: Function App Managed Identity only |
| `rawSql` tools | Server-side `SELECT`-only validation (existing) |

### 8.4 Data Classification

All data is **non-sensitive** (D365FO standard metadata, no customer/business data):
- Table/class/method definitions from standard Microsoft D365FO packages
- Cross-references between AOT objects
- No PII, no financial data, no credentials

---

## 9. Data Deployment Pipeline

### 9.1 Build Phase (Local — Unchanged)

```
Developer Workstation
│
├─ Step 1: Build KB SQLite
│  cd C:\Users\florian.dittgen\d365fo-kb
│  node build-kb.js
│  → Output: ~/.claude/d365fo_kb.sqlite (968 MB)
│
├─ Step 2: Build XRef SQLite
│  cd C:\Users\florian.dittgen\d365fo-xref-mcp
│  node --max-old-space-size=8192 build-xref-db.js
│  → Output: ~/.claude/d365fo_xref.sqlite (3,287 MB)
│
└─ Step 3: Deploy to Azure SQL
   .\Deploy-McpD365foData.ps1 -Environment p
```

### 9.2 Deploy Phase: SQLite → Azure SQL

A new PowerShell deployment script handles the data migration:

```powershell
# Deploy-McpD365foData.ps1
param(
    [ValidateSet('d','p')]
    [string]$Environment = 'p',
    [switch]$KbOnly,
    [switch]$XrefOnly
)

$sqlServer = "tis-$Environment-mcpd365fo-sql.database.windows.net"
$sqlDb     = "tis-$Environment-mcpd365fo-sqldb"

# Step 1: Export SQLite tables to CSV/BCP format
# Step 2: Truncate Azure SQL target tables (within transaction)
# Step 3: Bulk insert via bcp.exe or SqlBulkCopy
# Step 4: Rebuild indexes
# Step 5: Update metadata (build_date, version, row counts)
# Step 6: Verify row counts match
```

**Bulk import strategy for large tables:**

| Table | Rows | Method | Estimated Time |
|-------|------|--------|---------------|
| `kb.methods` | 820K | bcp (source_code is large) | ~3 min |
| `kb.fields` | 216K | bcp | ~30 sec |
| `xref.names` | 5.8M | bcp (batched 500K) | ~5 min |
| `xref.refs` | 26.6M | bcp (batched 1M) | ~15 min |
| All others | <100K each | SqlBulkCopy | ~10 sec each |

**Total deploy time**: ~25 minutes (dominated by `xref.refs` bulk insert)

### 9.3 Deployment Sequence

```
1. Build locally (KB: 10 min, XRef: 22 min)         ─── 32 min
2. Deploy data to Azure SQL                          ─── 25 min
3. Verify (row counts, sample queries)               ───  2 min
                                                     ─────────
Total end-to-end                                      ~60 min
```

### 9.4 When to Rebuild

| Trigger | Action |
|---------|--------|
| D365FO version update (e.g., 10.0.2263.202 → 10.0.2263.215) | Full rebuild KB + XRef |
| Custom model change (TBG_CS_* models) | KB rebuild only (XRef unaffected by local XML) |
| Bug fix in extraction logic | Rebuild affected service |
| Schema change in MCP tools | Deploy new Function App code (no data rebuild) |

---

## 10. Infrastructure as Code (Bicep)

### 10.1 Main Template

```bicep
// infra/main.bicep
targetScope = 'subscription'

@description('Environment code (d=dev, p=prod)')
@allowed(['d', 'p'])
param env string = 'p'

param location string = 'westeurope'
param workload string = 'mcpd365fo'
param prefix string = 'tis'

// Naming
var rgName   = '${prefix}-${env}-${workload}-rg'
var funcName = '${prefix}-${env}-${workload}-func'
var aspName  = '${prefix}-${env}-${workload}-asp'
var stName   = '${prefix}${env}${workload}st'       // slug format
var kvName   = '${prefix}-${env}-${workload}-kv'
var appiName = '${prefix}-${env}-${workload}-appi'
var logName  = '${prefix}-${env}-${workload}-log'
var sqlName  = '${prefix}-${env}-${workload}-sql'
var sqlDbName = '${prefix}-${env}-${workload}-sqldb'

var tags = {
  Owner: 'TIS'
  Environment: env == 'p' ? 'Production' : 'Development'
  Workload: workload
  CostCenter: 'IT-Services'
  ManagedBy: 'Florian Dittgen'
}

resource rg 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: rgName
  location: location
  tags: tags
}

module monitoring 'modules/monitoring.bicep' = {
  scope: rg
  name: 'monitoring'
  params: {
    location: location
    logName: logName
    appiName: appiName
    tags: tags
  }
}

module sql 'modules/sqlDatabase.bicep' = {
  scope: rg
  name: 'sqlDatabase'
  params: {
    location: location
    sqlServerName: sqlName
    sqlDbName: sqlDbName
    tags: tags
  }
}

module func 'modules/functionApp.bicep' = {
  scope: rg
  name: 'functionApp'
  params: {
    location: location
    funcName: funcName
    aspName: aspName
    stName: stName
    kvName: kvName
    appiConnectionString: monitoring.outputs.appiConnectionString
    sqlServerFqdn: sql.outputs.sqlServerFqdn
    sqlDbName: sqlDbName
    tags: tags
  }
}
```

### 10.2 SQL Database Module

```bicep
// infra/modules/sqlDatabase.bicep
param location string
param sqlServerName string
param sqlDbName string
param tags object

resource sqlServer 'Microsoft.Sql/servers@2023-05-01-preview' = {
  name: sqlServerName
  location: location
  tags: tags
  properties: {
    administratorLogin: 'sqladmin'
    minimalTlsVersion: '1.2'
    publicNetworkAccess: 'Enabled'
  }
  identity: {
    type: 'SystemAssigned'
  }
}

resource sqlDb 'Microsoft.Sql/servers/databases@2023-05-01-preview' = {
  parent: sqlServer
  name: sqlDbName
  location: location
  tags: tags
  sku: {
    name: 'S3'
    tier: 'Standard'
    capacity: 100
  }
  properties: {
    collation: 'SQL_Latin1_General_CP1_CI_AS'
    maxSizeBytes: 268435456000  // 250 GB
  }
}

// Allow Azure services
resource firewallRule 'Microsoft.Sql/servers/firewallRules@2023-05-01-preview' = {
  parent: sqlServer
  name: 'AllowAzureServices'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
}

output sqlServerFqdn string = sqlServer.properties.fullyQualifiedDomainName
```

---

## 11. Monitoring & Observability

### 11.1 Application Insights Telemetry

| Metric | Source | Alert Threshold |
|--------|--------|----------------|
| Request latency (P95) | Function App | > 500 ms |
| Failed requests | Function App | > 5% error rate |
| SQL query duration (P95) | Azure SQL | > 200 ms |
| DTU utilization | Azure SQL | > 80% sustained |
| Tool invocation count | Custom event | — (dashboard) |
| Most-used tools | Custom event | — (dashboard) |

### 11.2 Custom Events

```javascript
// Emit tool usage telemetry
const { defaultClient } = require('applicationinsights');

function trackToolCall(toolName, service, durationMs, success) {
  defaultClient.trackEvent({
    name: 'ToolInvocation',
    properties: {
      tool: toolName,
      service: service,       // 'kb' or 'xref'
      protocol: 'mcp',       // or 'rest'
    },
    measurements: {
      duration_ms: durationMs,
      success: success ? 1 : 0,
    },
  });
}
```

### 11.3 Health Check Endpoint

```
GET /api/health

Response:
{
  "status": "healthy",
  "services": {
    "sql": { "status": "connected", "latency_ms": 5 },
    "kb": { "tables": 17634, "methods": 820230 },
    "xref": { "names": 5821999, "refs": 26589848 }
  },
  "version": "1.0.0",
  "build_date": "2026-03-16T13:14:00Z"
}
```

---

## 12. Cost Estimation

### 12.1 Monthly Cost Breakdown (Production)

| Resource | SKU | Monthly Cost (EUR) |
|----------|-----|-------------------|
| Azure SQL Database | S3 (100 DTU, 250 GB) | ~€120 |
| Function App (Premium) | EP1 (1 vCPU, 3.5 GB, 1 always-ready) | ~€150 |
| App Service Plan | (included in EP1) | — |
| Storage Account | Standard LRS, minimal usage | ~€2 |
| Key Vault | Standard, <1000 operations/month | ~€1 |
| Application Insights | Basic, <5 GB/month ingestion | ~€10 |
| Log Analytics | Pay-as-you-go, <1 GB/month | ~€5 |
| **Total** | | **~€288/month** |

### 12.2 Cost Optimization Options

| Optimization | Savings | Trade-off |
|-------------|---------|-----------|
| Azure SQL Serverless (GP 2vc) | -€40/month if often idle | 60s resume delay after auto-pause |
| Function App Consumption plan | -€140/month | Cold starts (5-10s), no connection pool |
| Reduce DTU to S2 (50 DTU) | -€60/month | May bottleneck on large XRef queries |
| Reserved Instance (1yr SQL) | -€36/month (30%) | 1-year commitment |

---

## 13. Migration Path: SQLite Queries → Azure SQL

### 13.1 Query Translation Guide

Most queries require minimal changes:

| SQLite | Azure SQL | Notes |
|--------|-----------|-------|
| `COLLATE NOCASE` | `COLLATE SQL_Latin1_General_CP1_CI_AS` | Or set DB collation to CI |
| `LIKE ?` + `%term%` | Same | Works identically |
| `WITH RECURSIVE cte AS (...)` | `WITH cte AS (...)` | Azure SQL CTEs are recursive by default |
| `LIMIT n` | `TOP n` or `OFFSET 0 ROWS FETCH NEXT n ROWS ONLY` | Use TOP for simple cases |
| `INSERT OR REPLACE` | `MERGE` or delete+insert | For data loading only |
| `PRAGMA` | N/A | Remove PRAGMA calls |
| `SUBSTR(x, 1, 120)` | `SUBSTRING(x, 1, 120)` | Different function name |
| `LENGTH(x)` | `LEN(x)` | Different function name |

### 13.2 Full-Text Search Upgrade

**Before (SQLite LIKE-based):**
```sql
SELECT * FROM kb_search
WHERE object_name LIKE '%SalesForm%' AND content LIKE '%invoice%'
```

**After (Azure SQL FTS):**
```sql
SELECT * FROM kb.kb_search
WHERE CONTAINS(content, '"SalesForm*" AND "invoice"')
```

**New capability — Code search:**
```sql
SELECT owner_name, method_name
FROM kb.methods
WHERE CONTAINS(source_code, '"InventTable" NEAR "find"')
```

---

## 14. Implementation Phases

### Phase 1: Infrastructure + Schema (1-2 days)

- [ ] Deploy Azure resources via Bicep (`main.bicep`)
- [ ] Create SQL schemas (`kb`, `xref`) and all tables
- [ ] Create indexes and full-text catalogs
- [ ] Configure Key Vault secrets
- [ ] Test SQL connectivity from local machine

### Phase 2: Data Pipeline (1 day)

- [ ] Build `Deploy-McpD365foData.ps1` (SQLite → Azure SQL bulk import)
- [ ] Initial data load (KB + XRef)
- [ ] Verify row counts and sample queries
- [ ] Document deployment procedure

### Phase 3: Function App — Tool Layer (2-3 days)

- [ ] Port 16 KB tool implementations (SQLite → Azure SQL query syntax)
- [ ] Port 13 XRef tool implementations
- [ ] Implement shared db.js connection pool
- [ ] Implement format.js (reuse existing Markdown formatter)
- [ ] Unit test each tool against Azure SQL

### Phase 4: Protocol Adapters (1-2 days)

- [ ] Implement MCP Streamable HTTP endpoint (`/mcp`)
- [ ] Implement REST API endpoints (`/api/kb/*`, `/api/xref/*`)
- [ ] Implement health check endpoint
- [ ] API key authentication
- [ ] Deploy Function App

### Phase 5: Integration + Testing (1 day)

- [ ] Configure Claude Code to use remote MCP server
- [ ] Test all 29 tools via MCP protocol
- [ ] Test REST API with sample Power Automate flow
- [ ] Performance benchmarking (latency, throughput)
- [ ] Set up Application Insights dashboards

### Phase 6: Documentation + Handover (0.5 day)

- [ ] Update CLAUDE.md with Azure MCP configuration
- [ ] Document REST API for team consumption
- [ ] Document data refresh procedure

**Total estimated effort: 6-9 days**

---

## 15. Risks & Mitigations

| # | Risk | Impact | Likelihood | Mitigation |
|---|------|--------|-----------|------------|
| R1 | Azure SQL S3 insufficient for 26.6M refs table | Slow XRef queries (>200ms) | Low | Monitor DTU; upgrade to S4/GP if needed |
| R2 | MCP Streamable HTTP transport not supported by all clients | Some LLM agents can't connect | Medium | REST API provides universal fallback |
| R3 | Data staleness after D365FO update | Outdated metadata | Low | Document refresh procedure; add reminder on version update |
| R4 | Cold start latency on Premium EP1 | First request slow after deploy | Low | Always-ready instance = 1 eliminates this |
| R5 | Source code column inflates SQL storage | Higher Azure SQL cost | Low | 820K methods × ~1KB avg = ~800 MB; well within 250 GB |
| R6 | API key leaked | Unauthorized access to metadata | Low | Key rotation via Key Vault; data is non-sensitive |

---

## 16. Future Enhancements (Out of Scope)

| Enhancement | Description | Trigger |
|-------------|-------------|---------|
| Azure DevOps CI/CD | Automated rebuild on D365FO version update | When refresh frequency increases |
| Multiple D365FO versions | Schema versioning (v10.0.2263.202, v10.0.2345.117) | When supporting multiple environments |
| Customization overlay | Merge TBG_CS_* custom models into KB | When custom code analysis is needed |
| Code similarity search | Vector embeddings on source_code for semantic search | When AI code analysis demand grows |
| Rate limiting | Per-client throttling | When external consumers are onboarded |

---

## Appendix A: Tool Parameter Reference

### KB Tool Parameters

| Tool | Parameters |
|------|-----------|
| `d365_lookup_table` | `table_name: string` |
| `d365_get_join_keys` | `table1: string, table2: string` |
| `d365_get_enum` | `enum_name: string` |
| `d365_get_class_methods` | `name: string, filter?: string, include_source?: boolean` |
| `d365_get_method_source` | `owner_name: string, method_name: string` |
| `d365_search` | `query: string, object_type?: string, limit?: number` |
| `d365_get_module_summary` | `module_name: string` |
| `d365_list_modules` | _(none)_ |
| `d365_graph_traverse` | `start_node: string, max_depth?: number, edge_type?: string` |
| `d365_find_referencing_tables` | `table_name: string` |
| `d365_get_entity_sources` | `entity_name: string` |
| `d365_sql_template` | `scenario?: string` |
| `d365_raw_sql` | `sql: string` |
| `d365_check_field_exists` | `table_name: string, field_names: string[]` |
| `d365_hallucination_check` | `table_name: string` |
| `d365_field_renames` | `table_name: string` |

### XRef Tool Parameters

| Tool | Parameters |
|------|-----------|
| `xref_find_references` | `object_name: string, kind?: enum, limit?: number` |
| `xref_find_usages` | `object_name: string, kind?: enum, limit?: number` |
| `xref_find_method_callers` | `object_name: string, method_name: string, limit?: number` |
| `xref_class_hierarchy` | `class_name: string, direction?: enum` |
| `xref_interface_implementors` | `interface_name: string` |
| `xref_search_names` | `pattern: string, object_type?: enum, limit?: number` |
| `xref_method_references` | `object_name: string, method_name: string, kind?: enum, limit?: number` |
| `xref_module_objects` | `module_name: string, object_type?: enum, limit?: number` |
| `xref_cross_module_deps` | `module_name: string, direction?: enum, limit?: number` |
| `xref_raw_sql` | `sql: string, limit?: number` |
| `xref_impact_analysis` | `object_name: string, depth?: number` |
| `xref_list_modules` | _(none)_ |
| `xref_object_summary` | `object_name: string` |

---

## Appendix B: Azure SQL Schema DDL

### KB Schema

```sql
CREATE SCHEMA kb;
GO

CREATE TABLE kb.kb_metadata (
  [key] NVARCHAR(100) PRIMARY KEY,
  [value] NVARCHAR(MAX)
);

CREATE TABLE kb.modules (
  module_id NVARCHAR(200) PRIMARY KEY,
  table_count INT DEFAULT 0,
  class_count INT DEFAULT 0,
  enum_count INT DEFAULT 0,
  entity_count INT DEFAULT 0,
  form_count INT DEFAULT 0
);

CREATE TABLE kb.tables (
  table_name NVARCHAR(200) PRIMARY KEY,
  module_id NVARCHAR(200),
  label NVARCHAR(500),
  table_group NVARCHAR(100),
  save_per_company NVARCHAR(10) DEFAULT 'Yes',
  cache_lookup NVARCHAR(100),
  clustered_index NVARCHAR(200),
  replacement_key NVARCHAR(200),
  config_key NVARCHAR(200),
  field_count INT DEFAULT 0,
  has_methods BIT DEFAULT 0,
  developer_doc NVARCHAR(MAX),
  file_path NVARCHAR(500)
);

CREATE TABLE kb.fields (
  table_name NVARCHAR(200),
  field_name NVARCHAR(200),
  field_type NVARCHAR(100),
  edt NVARCHAR(200),
  enum_type NVARCHAR(200),
  mandatory NVARCHAR(10) DEFAULT 'No',
  allow_edit NVARCHAR(10) DEFAULT 'Yes',
  label NVARCHAR(500),
  PRIMARY KEY (table_name, field_name)
);

CREATE TABLE kb.indexes_tbl (
  table_name NVARCHAR(200),
  index_name NVARCHAR(200),
  is_unique BIT DEFAULT 0,
  is_clustered BIT DEFAULT 0,
  fields_json NVARCHAR(MAX),
  PRIMARY KEY (table_name, index_name)
);

CREATE TABLE kb.relations (
  source_table NVARCHAR(200),
  relation_name NVARCHAR(200),
  related_table NVARCHAR(200),
  cardinality NVARCHAR(50),
  related_cardinality NVARCHAR(50),
  on_delete NVARCHAR(50),
  relationship_type NVARCHAR(100),
  constraints_json NVARCHAR(MAX),
  PRIMARY KEY (source_table, relation_name)
);

CREATE TABLE kb.enums (
  enum_name NVARCHAR(200) PRIMARY KEY,
  module_id NVARCHAR(200),
  label NVARCHAR(500),
  values_json NVARCHAR(MAX)
);

CREATE TABLE kb.edts (
  edt_name NVARCHAR(200) PRIMARY KEY,
  base_type NVARCHAR(100),
  extends_edt NVARCHAR(200),
  label NVARCHAR(500),
  string_size INT,
  table_ref NVARCHAR(200),
  module_id NVARCHAR(200)
);

CREATE TABLE kb.classes (
  class_name NVARCHAR(200) PRIMARY KEY,
  module_id NVARCHAR(200),
  extends_class NVARCHAR(200),
  implements_list NVARCHAR(500),
  is_abstract BIT DEFAULT 0,
  method_count INT DEFAULT 0,
  file_path NVARCHAR(500)
);

CREATE TABLE kb.methods (
  owner_type NVARCHAR(20),
  owner_name NVARCHAR(200),
  method_name NVARCHAR(200),
  signature NVARCHAR(500),
  is_static BIT DEFAULT 0,
  source_code NVARCHAR(MAX),
  PRIMARY KEY (owner_type, owner_name, method_name)
);

CREATE TABLE kb.data_entities (
  entity_name NVARCHAR(200) PRIMARY KEY,
  module_id NVARCHAR(200),
  label NVARCHAR(500),
  public_name NVARCHAR(200),
  public_collection NVARCHAR(200),
  is_public BIT DEFAULT 0,
  primary_table NVARCHAR(200),
  staging_table NVARCHAR(200),
  config_key NVARCHAR(200),
  file_path NVARCHAR(500)
);

CREATE TABLE kb.entity_fields (
  entity_name NVARCHAR(200),
  field_name NVARCHAR(200),
  data_field NVARCHAR(200),
  data_source NVARCHAR(200),
  is_mandatory BIT DEFAULT 0,
  PRIMARY KEY (entity_name, field_name)
);

CREATE TABLE kb.forms (
  form_name NVARCHAR(200) PRIMARY KEY,
  module_id NVARCHAR(200),
  label NVARCHAR(500),
  data_sources_json NVARCHAR(MAX),
  file_path NVARCHAR(500)
);

CREATE TABLE kb.views (
  view_name NVARCHAR(200) PRIMARY KEY,
  module_id NVARCHAR(200),
  label NVARCHAR(500),
  config_key NVARCHAR(200),
  field_count INT DEFAULT 0,
  file_path NVARCHAR(500)
);

CREATE TABLE kb.security_roles (
  role_name NVARCHAR(200) PRIMARY KEY,
  module_id NVARCHAR(200),
  label NVARCHAR(500),
  description NVARCHAR(MAX),
  duties_json NVARCHAR(MAX)
);

CREATE TABLE kb.security_duties (
  duty_name NVARCHAR(200) PRIMARY KEY,
  module_id NVARCHAR(200),
  label NVARCHAR(500),
  description NVARCHAR(MAX),
  privileges_json NVARCHAR(MAX)
);

CREATE TABLE kb.security_privileges (
  privilege_name NVARCHAR(200) PRIMARY KEY,
  module_id NVARCHAR(200),
  label NVARCHAR(500),
  entry_points_json NVARCHAR(MAX)
);

CREATE TABLE kb.menu_items (
  menu_item_name NVARCHAR(200),
  menu_item_type NVARCHAR(50),
  module_id NVARCHAR(200),
  label NVARCHAR(500),
  object_name NVARCHAR(200),
  object_type NVARCHAR(100),
  config_key NVARCHAR(200),
  PRIMARY KEY (menu_item_name, menu_item_type)
);

CREATE TABLE kb.graph_edges (
  source_node NVARCHAR(200),
  source_type NVARCHAR(50),
  target_node NVARCHAR(200),
  target_type NVARCHAR(50),
  edge_type NVARCHAR(50),
  edge_detail NVARCHAR(500),
  PRIMARY KEY (source_node, target_node, edge_type, edge_detail)
);

CREATE TABLE kb.kb_search (
  id INT IDENTITY(1,1) PRIMARY KEY,
  object_type NVARCHAR(50),
  object_name NVARCHAR(200),
  module_id NVARCHAR(200),
  content NVARCHAR(MAX)
);

CREATE TABLE kb.hallucination_traps (
  trap_id INT IDENTITY(1,1) PRIMARY KEY,
  object_name NVARCHAR(200),
  trap_type NVARCHAR(100),
  wrong_value NVARCHAR(200),
  correct_value NVARCHAR(200),
  explanation NVARCHAR(MAX)
);

CREATE TABLE kb.field_renames (
  table_name NVARCHAR(200),
  ax2012_name NVARCHAR(200),
  d365fo_name NVARCHAR(200),
  PRIMARY KEY (table_name, ax2012_name)
);

CREATE TABLE kb.query_templates (
  template_id INT IDENTITY(1,1) PRIMARY KEY,
  title NVARCHAR(200),
  description NVARCHAR(MAX),
  sql_template NVARCHAR(MAX),
  tables_used NVARCHAR(500)
);

CREATE TABLE kb.object_paths (
  object_type NVARCHAR(50),
  object_name NVARCHAR(200),
  file_path NVARCHAR(500),
  file_size INT,
  PRIMARY KEY (object_type, object_name)
);
GO
```

### XRef Schema

```sql
CREATE SCHEMA xref;
GO

CREATE TABLE xref.names (
  id INT PRIMARY KEY,
  path NVARCHAR(500) NOT NULL,
  provider_id INT NOT NULL,
  module_id INT NOT NULL
);

CREATE TABLE xref.refs (
  source_id INT NOT NULL,
  target_id INT NOT NULL,
  kind INT NOT NULL,
  line INT,
  col INT
);

-- Clustered index on refs for optimal join performance
CREATE CLUSTERED INDEX IX_xref_refs_source_target
  ON xref.refs (source_id, target_id);

CREATE TABLE xref.modules (
  id INT PRIMARY KEY,
  module NVARCHAR(200) NOT NULL
);

CREATE TABLE xref.providers (
  id INT PRIMARY KEY,
  provider NVARCHAR(100) NOT NULL
);

CREATE TABLE xref.kind_map (
  id INT PRIMARY KEY,
  name NVARCHAR(50) NOT NULL
);

CREATE TABLE xref.xref_metadata (
  [key] NVARCHAR(100) PRIMARY KEY,
  [value] NVARCHAR(MAX)
);
GO
```

### Indexes

```sql
-- KB Indexes
CREATE INDEX IX_kb_fields_table ON kb.fields (table_name);
CREATE INDEX IX_kb_relations_source ON kb.relations (source_table);
CREATE INDEX IX_kb_relations_target ON kb.relations (related_table);
CREATE INDEX IX_kb_methods_owner ON kb.methods (owner_type, owner_name);
CREATE INDEX IX_kb_classes_extends ON kb.classes (extends_class);
CREATE INDEX IX_kb_classes_module ON kb.classes (module_id);
CREATE INDEX IX_kb_tables_module ON kb.tables (module_id);
CREATE INDEX IX_kb_graph_source ON kb.graph_edges (source_node);
CREATE INDEX IX_kb_graph_target ON kb.graph_edges (target_node);
CREATE INDEX IX_kb_entity_fields ON kb.entity_fields (entity_name);
CREATE INDEX IX_kb_search_name ON kb.kb_search (object_name);
CREATE INDEX IX_kb_search_type ON kb.kb_search (object_type);

-- XRef Indexes
CREATE INDEX IX_xref_names_path ON xref.names (path);
CREATE INDEX IX_xref_names_module ON xref.names (module_id);
CREATE INDEX IX_xref_refs_target ON xref.refs (target_id);
CREATE INDEX IX_xref_refs_kind ON xref.refs (kind);
CREATE INDEX IX_xref_refs_source_kind ON xref.refs (source_id, kind);
CREATE INDEX IX_xref_refs_target_kind ON xref.refs (target_id, kind);
CREATE INDEX IX_xref_modules_module ON xref.modules (module);

-- Full-Text Indexes (KB)
CREATE FULLTEXT CATALOG ftcat_mcpd365fo AS DEFAULT;

CREATE FULLTEXT INDEX ON kb.methods (source_code, signature)
  KEY INDEX PK__methods__... ON ftcat_mcpd365fo;

CREATE FULLTEXT INDEX ON kb.kb_search (content, object_name)
  KEY INDEX PK__kb_search__... ON ftcat_mcpd365fo;
GO
```

---

*End of document.*
