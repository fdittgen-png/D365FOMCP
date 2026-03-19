# D365FO MCP Services

**MCP-based metadata intelligence for Microsoft Dynamics 365 Finance & Operations.**

Exposes D365FO metadata (tables, classes, enums, methods, entities, security objects) and cross-reference data (code dependencies, call graphs, inheritance) as **33 tools** via the [Model Context Protocol (MCP)](https://modelcontextprotocol.io). Designed for AI coding assistants (Claude, Copilot, ChatGPT, Gemini, Cursor) and any MCP-compatible client.

| Dimension | Value |
|-----------|-------|
| KB tools | 17 (table lookup, field check, join keys, search, X++ source, ...) |
| XRef tools | 16 (find references, call hierarchy, impact analysis, ...) |
| KB database | ~1,063 MB SQLite (17K tables, 63K classes, 820K methods with full source) |
| XRef database | ~3,300 MB SQLite (5.8M objects, 26.6M cross-references) |
| Runtime | Node.js 20, Azure Functions v4 (Linux) |
| Transport | MCP Streamable HTTP (Azure) / MCP stdio (local) |

---

## Quick Start

### Local Development (stdio)

```bash
npm install
npm run start:kb       # Start KB MCP server on stdio
npm run start:xref     # Start XRef MCP server on stdio
```

### Build & Deploy (recommended)

```powershell
# 1. List available D365FO configurations
scripts\Update-Databases.ps1 -ListConfigs

# 2. Rebuild databases from current (or named) configuration
scripts\Update-Databases.ps1
scripts\Update-Databases.ps1 -ConfigName "tis-d365fo-dev-02"

# 3. Deploy databases to Azure and restart MCP services
scripts\Deploy-Databases.ps1 -Environment d
```

### First-Time Azure Setup

```powershell
# 1. Deploy infrastructure (one-time)
scripts\Deploy-Infrastructure.ps1 -Environment d

# 2. Deploy code + databases
scripts\Deploy-McpD365foData.ps1 -Environment d
```

### Connect an AI Client

See [AI Configuration Guide](docs/AI-Configuration.md) for setup instructions for Claude Code, Claude Desktop, Cursor, VS Code Copilot, ChatGPT, and Gemini.

---

## Project Structure

```
build/                  Build scripts (XML/LocalDB -> SQLite)
  build-kb.js             KB database builder
  build-xref-db.js        XRef database builder
docs/                   Documentation
  Architecture.md         System architecture (architects)
  Implementation.md       Implementation details (developers)
  Administration.md       Operations & deployment (Azure admins)
  AI-Configuration.md     MCP client setup (AI administrators)
infra/                  Infrastructure as Code (Bicep)
  main-rg.bicep           Main template (resource group scope)
  modules/                Bicep modules (Function App, monitoring)
scripts/                PowerShell automation
  Get-D365Configurations.ps1  Export D365FO XPP configs to XML
  Update-Databases.ps1        Rebuild DBs from D365FO config (recommended)
  Deploy-Databases.ps1        Upload DBs to Azure + restart
  Build-Databases.ps1         Low-level DB build (manual paths)
  Deploy-Infrastructure.ps1   Bicep deployment (one-time)
  Deploy-FunctionApp.ps1      Code + DB deployment
  Deploy-McpD365foData.ps1    Master pipeline (roles + deploy)
  Set-RoleAssignments.ps1     RBAC setup
src/
  azure/                Shared tool implementations
    shared.js             DB singletons, query helpers
    kb-tools.js           17 KB tool implementations
    xref-tools.js         16 XRef tool implementations
  functions/            Azure Functions entry points
    d365kb.js             KB MCP endpoint (/api/d365kb)
    d365xref.js           XRef MCP endpoint (/api/d365xref)
    index.js              Function App loader
  local/                Local stdio servers (development)
    mcp-server-kb.js      KB stdio server
    mcp-server-xref.js    XRef stdio server
```

---

## Documentation

| Document | Audience | Description |
|----------|----------|-------------|
| [Architecture](docs/Architecture.md) | Architects, Tech Leads | System design, data flow, Azure resource inventory, security model |
| [Implementation](docs/Implementation.md) | Developers | Build pipeline, database schemas, tool catalog, query patterns, dependencies |
| [Administration](docs/Administration.md) | Azure Administrators | Prerequisites, build/deploy procedures, monitoring, troubleshooting |
| [AI Configuration](docs/AI-Configuration.md) | AI Administrators | MCP client setup for Claude, Copilot, ChatGPT, Gemini, Cursor |

---

## Azure Resources

All resources deployed via Bicep (`infra/main-rg.bicep`):

| Resource | Type | Naming Pattern |
|----------|------|---------------|
| Function App | Microsoft.Web/sites | `tis-{env}-mcpd365fo-func` |
| App Service Plan | Microsoft.Web/serverfarms | `tis-{env}-mcpd365fo-asp` |
| Storage Account | Microsoft.Storage/storageAccounts | `tis{env}mcpd365fost` |
| Key Vault | Microsoft.KeyVault/vaults | `tis-{env}-mcpd365fo-kv` |
| Application Insights | Microsoft.Insights/components | `tis-{env}-mcpd365fo-appi` |
| Log Analytics | Microsoft.OperationalInsights/workspaces | `tis-{env}-mcpd365fo-log` |

Environments: `d` (development), `p` (production).

---

## MCP Endpoints

| Environment | Service | URL |
|-------------|---------|-----|
| Development | KB | `https://tis-d-mcpd365fo-func.azurewebsites.net/api/d365kb` |
| Development | XRef | `https://tis-d-mcpd365fo-func.azurewebsites.net/api/d365xref` |
| Production | KB | `https://tis-p-mcpd365fo-func.azurewebsites.net/api/d365kb` |
| Production | XRef | `https://tis-p-mcpd365fo-func.azurewebsites.net/api/d365xref` |

Health check: `GET` to any endpoint returns `{ name, version, status }`.

---

## Tool Inventory

### Knowledge Base (17 tools)

| Tool | Description |
|------|-------------|
| `d365_lookup_table` | Complete table metadata (fields, indexes, relations) |
| `d365_get_join_keys` | Join fields between two tables with hallucination warnings |
| `d365_search` | Full-text search across all object types |
| `d365_get_enum` | Enum values with numeric IDs and labels |
| `d365_check_field_exists` | Verify field existence, suggest corrections |
| `d365_get_class_methods` | Method signatures, optionally with full X++ source |
| `d365_get_method_source` | Full X++ source code for a specific method |
| `d365_find_referencing_tables` | Foreign keys pointing to a table |
| `d365_get_module_summary` | Module overview with object counts |
| `d365_get_entity_sources` | Data entity field mappings and OData names |
| `d365_sql_template` | Pre-validated SQL query templates |
| `d365_hallucination_check` | Known LLM mistakes for a table |
| `d365_raw_sql` | Read-only SQL against KB database |
| `d365_graph_traverse` | Object dependency graph traversal |
| `d365_field_renames` | AX2012-to-D365FO field name mappings |
| `d365_list_modules` | All modules with object counts |
| `d365_resolve_label` | Resolve @SYS label IDs to text |

### Cross-Reference (16 tools)

| Tool | Description |
|------|-------------|
| `xref_find_references` | Who references this object (incoming) |
| `xref_find_usages` | What this object references (outgoing) |
| `xref_find_method_callers` | All callers of a method with line numbers |
| `xref_class_hierarchy` | Inheritance tree (ancestors or descendants) |
| `xref_interface_implementors` | Classes implementing an interface |
| `xref_search_names` | Search objects by name pattern |
| `xref_method_references` | Outgoing references from a method |
| `xref_module_objects` | Top-level objects in a module |
| `xref_cross_module_deps` | Cross-module dependency analysis |
| `xref_raw_sql` | Read-only SQL against XRef database |
| `xref_impact_analysis` | Change impact: direct + indirect dependents |
| `xref_list_modules` | All modules with object counts |
| `xref_object_summary` | Compact object overview with reference counts |
| `xref_find_extensions` | CoC extensions and table/form extensions |
| `xref_find_field_usages` | Code locations reading/writing a field |
| `xref_find_event_handlers` | Event handlers and delegates |

---

## Technology Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js 20 LTS (ES Modules) |
| MCP SDK | @modelcontextprotocol/sdk ^1.27.0 |
| Database (runtime) | better-sqlite3 ^12.8.0 (native, read-only) |
| Database (KB build) | sql.js ^1.12.0 (WebAssembly SQLite) |
| XML parsing | fast-xml-parser ^5.2.3 |
| Azure Functions | @azure/functions ^4.9.0 (v4 programming model) |
| Infrastructure | Azure Bicep |
| Deployment | PowerShell + Azure CLI |

---

**Owner**: Trelleborg IT Services (TIS)
**Author**: Florian Dittgen
**Version**: 2.0
