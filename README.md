# D365FO MCP Services

**MCP-based metadata intelligence for Microsoft Dynamics 365 Finance & Operations.**

Exposes D365FO metadata (tables, classes, enums, methods, entities, security objects), cross-reference data (code dependencies, call graphs, inheritance), security configuration (roles, users, duties, privileges, permissions, licence/SoD/what-if governance), Task Recorder parsing, and a multi-tenant blob-backed wiki platform as **57 tools across 5 services** via the [Model Context Protocol (MCP)](https://modelcontextprotocol.io). Designed for AI coding assistants (Claude, Copilot, ChatGPT, Gemini, Cursor) and any MCP-compatible client.

| Dimension | Value |
|-----------|-------|
| KB tools | 17 (table lookup, field check, join keys, search, X++ source, ...) |
| XRef tools | 16 (find references, call hierarchy, impact analysis, ...) |
| Security tools | 19 (role/duty/privilege lookup, permission trace, user assignments, licence assessment, SoD check, what-if, object access) |
| Task Recorder tools | 1 (parse .axtr recordings to structured Markdown) |
| Wiki tools (per wiki) | 4 (`wiki_index`, `wiki_list`, `wiki_read`, `wiki_search`) — multi-tenant blob-backed |
| KB database | ~1,063 MB SQLite (17K tables, 63K classes, 820K methods with full source) |
| XRef database | ~3,300 MB SQLite (5.8M objects, 26.6M cross-references) |
| Security database | ~30-60 MB SQLite (roles, duties, privileges, users, CRUD permissions) |
| Runtime | Node.js 20, Azure Functions v4 (Linux) |
| Transport | MCP Streamable HTTP (Azure) / MCP stdio (local) |

---

## Quick Start

### Local Development (stdio)

```bash
npm install
npm run start:kb             # Start KB MCP server on stdio
npm run start:xref           # Start XRef MCP server on stdio
npm run start:sec            # Start Security MCP server on stdio
npm run start:taskrecorder   # Start Task Recorder MCP server on stdio
npm run start:wiki -- otrs   # Start a wiki MCP on stdio (positional arg = wiki name from config/wikis.json)
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
  build-sec.js            Security database builder (AOT + DMF)
docs/                   Documentation
  Architecture.md         System architecture (architects)
  Implementation.md       Implementation details (developers)
  Administration.md       Operations & deployment (Azure admins)
  AI-Configuration.md     MCP client setup (AI administrators)
  VS-Code-Guide.md        VS Code setup & development workflow
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
    shared.js             DB singletons, query helpers, response-contract helpers
    kb-tools.js           17 KB tool implementations
    xref-tools.js         16 XRef tool implementations
    sec-tools.js          19 Security tool implementations (incl. licence/SoD/what-if/object-access governance)
    taskrecorder-parser.js  .axtr file parser (ZIP/XML -> Markdown)
    taskrecorder-tools.js   Task Recorder MCP tool registration
    wiki-tools.js         4 Wiki tool implementations (registered per wiki)
    wiki-registry.js      Multi-wiki registry loader (config/wikis.json or WIKI_CONFIG_JSON)
    wiki-storage.js       Blob-backed wiki page reader (60s cache)
    wiki-search.js        Weighted substring search + snippets
    otrs-client.js        OTRS REST client (TicketSearch + TicketGet)
    otrs-storage.js       OTRS state blob ($processedTicketIds$)
    otrs-extract-core.js  Pure orchestration of search → get → validate
    build-jobs.js         Async upload job tracking for /api/d365sec/upload
  functions/            Azure Functions entry points
    d365kb.js             KB MCP endpoint (/api/d365kb)
    d365xref.js           XRef MCP endpoint (/api/d365xref)
    d365sec.js            Security MCP endpoint (/api/d365sec)
    d365sec-upload.js     Sec DB upload endpoint (sync + async URL-download)
    d365taskrecorder.js   Task Recorder MCP + upload endpoint (/api/d365taskrecorder)
    d365health.js         Health endpoint (/api/health)
    d365admin-pages.js    Admin UI (/api/admin, /api/admin/db-health, /api/admin/upload)
    otrs-extract.js       OTRS extractor (POST /api/otrs/extract)
    otrs-ingest.js        Wiki ingest from OTRS XML
    otrs-admin.js         OTRS admin UI (/api/otrs-admin/*)
    wiki-mcp.js           Multi-wiki MCP route (/api/wiki-mcp/{name}) + catalog
    index.js              Function App loader
  local/                Local stdio servers (development)
    mcp-server-kb.js      KB stdio server
    mcp-server-xref.js    XRef stdio server
    mcp-server-sec.js     Security stdio server
    mcp-server-taskrecorder.js  Task Recorder stdio server
    mcp-server-wiki.js    Wiki stdio server (per-wiki, takes wiki-name arg)
config/
  wikis.json            Wiki registry (overridable via WIKI_CONFIG_JSON)
www/                    Test UIs
  taskrecorder.html       Task Recorder upload & preview UI
test/                   Tests
  sec-tools.test.js       Security tools unit tests
  taskrecorder-parser.test.js  Task Recorder parser tests
  response-format.test.js  Static-scan contract tests (registerTool / structuredResult / freshness banner)
.github/workflows/
  ci.yml                  CI (npm ci + npm test, Node 20)
```

---

## Documentation

| Document | Audience | Description |
|----------|----------|-------------|
| [Architecture](docs/Architecture.md) | Architects, Tech Leads | System design, data flow, Azure resource inventory, security model |
| [Implementation](docs/Implementation.md) | Developers | Build pipeline, database schemas, tool catalog, query patterns, dependencies |
| [Administration](docs/Administration.md) | Azure Administrators | Prerequisites, build/deploy procedures, monitoring, troubleshooting |
| [Operations](docs/Operations.md) | Azure Administrators | Runtime limits, SQLite-on-Azure pragmas and mitigations, region alignment |
| [AI Configuration](docs/AI-Configuration.md) | AI Administrators | MCP client setup for Claude, Copilot, ChatGPT, Gemini, Cursor |
| [VS Code Guide](docs/VS-Code-Guide.md) | Developers | VS Code setup, debugging, workflow, extensions |
| [Security Service Design](docs/Design-D365Sec-MCP-Service.md) | Developers | Security MCP service architecture, schema, build pipeline |
| [MCP — Wiki Services](docs/MCP-Wiki-Services.md) | AI Administrators, Developers | Multi-tenant wiki MCP — connection, tool reference, content pipeline |
| [Copilot Studio Guide](docs/Copilot-Studio-Guide.md) | AI Administrators | Copilot Studio MCP integration and knownTools setup |

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
| Development | Security | `https://tis-d-mcpd365fo-func.azurewebsites.net/api/d365sec` |
| Development | Task Recorder | `https://tis-d-mcpd365fo-func.azurewebsites.net/api/d365taskrecorder` |
| Development | Task Recorder UI | `https://tis-d-mcpd365fo-func.azurewebsites.net/api/d365taskrecorder/upload` |
| Development | Wiki catalog | `https://tis-d-mcpd365fo-func.azurewebsites.net/api/wiki-mcp` |
| Development | Wiki MCP (per wiki) | `https://tis-d-mcpd365fo-func.azurewebsites.net/api/wiki-mcp/{name}` |
| Production | KB | `https://tis-p-mcpd365fo-func.azurewebsites.net/api/d365kb` |
| Production | XRef | `https://tis-p-mcpd365fo-func.azurewebsites.net/api/d365xref` |
| Production | Security | `https://tis-p-mcpd365fo-func.azurewebsites.net/api/d365sec` |
| Production | Task Recorder | `https://tis-p-mcpd365fo-func.azurewebsites.net/api/d365taskrecorder` |
| Production | Task Recorder UI | `https://tis-p-mcpd365fo-func.azurewebsites.net/api/d365taskrecorder/upload` |
| Production | Wiki catalog | `https://tis-p-mcpd365fo-func.azurewebsites.net/api/wiki-mcp` |
| Production | Wiki MCP (per wiki) | `https://tis-p-mcpd365fo-func.azurewebsites.net/api/wiki-mcp/{name}` |

Other HTTP endpoints (not MCP):

| Endpoint | Purpose |
|----------|---------|
| `GET /api/health` | Lightweight health probe (used by deployment scripts) |
| `GET /api/admin` | Admin landing page |
| `GET /api/admin/db-health` | Per-database row counts and last-modified timestamps |
| `GET /api/admin/upload` | Sec DB upload UI |
| `POST /api/d365sec/upload` | Sync (≤200 MB form) and async (URL download up to 4 GB via blob SAS) DMF upload — async job tracking via `src/azure/build-jobs.js` |
| `POST /api/otrs/extract` | OTRS support-ticket extractor (function-key auth, called by Power Automate) |
| `POST /api/otrs/ingest` | Markdown ingest from extractor XML into the wiki container |
| `GET /api/otrs-admin/*` | OTRS admin UI (state blob inspection, manual replay) |

Health check: `GET` to any MCP endpoint returns `{ name, version, status }`.

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

### Security (19 tools)

| Tool | Description |
|------|-------------|
| `sec_lookup_role` | Full role details: sub-roles, duties, direct privileges, license type, Grant/Deny |
| `sec_lookup_duty` | Duty details: which roles contain it, privileges it grants |
| `sec_lookup_privilege` | Privilege details: entry points with CRUD grants, parent duties, parent roles |
| `sec_lookup_user` | User profile: roles, company scoping, enabled status |
| `sec_role_hierarchy` | Sub-role tree traversal (parent or child direction) |
| `sec_find_users_by_role` | All users assigned to a role, optionally filtered by company |
| `sec_find_roles_by_duty` | All roles that contain a duty |
| `sec_find_roles_by_privilege` | All roles that grant a privilege (via duty chain) |
| `sec_company_users` | All users and their roles scoped to a specific company |
| `sec_permission_trace` | Full permission chain: role → duties → privileges → entry points (CRUD) |
| `sec_compare_roles` | Side-by-side comparison of two roles |
| `sec_effective_permissions` | Flattened entry-point CRUD set considering sub-roles and Grant/Deny |
| `sec_search` | Full-text search across roles, duties, privileges, users |
| `sec_stats` | Role/user/duty/privilege summary counts |
| `sec_raw_sql` | Read-only SQL against the Security database |
| `sec_licence_assessment` | Per-user licence-type assessment from assigned roles |
| `sec_sod_check` | Segregation-of-Duties check for users / role pairs |
| `sec_what_if` | Simulate the effective permission delta of adding/removing a role |
| `sec_object_access` | "Who can read/write object X" — reverse lookup from object to roles/users |

### Task Recorder (1 tool)

| Tool | Description |
|------|-------------|
| `taskrecorder_to_markdown` | Parse a D365FO Task Recorder (.axtr) file into structured Markdown. Accepts `file_url` (for Copilot Studio uploads) or `file_content` (base64). |

A browser-based test UI is available at `/api/d365taskrecorder/upload` for drag-and-drop file parsing with live Markdown preview.

### Wiki (4 tools, per wiki)

Every configured wiki at `/api/wiki-mcp/{name}` exposes the same four tools — only their descriptions reference the specific wiki. Registry: `config/wikis.json`. See [MCP — Wiki Services](docs/MCP-Wiki-Services.md).

| Tool | Description |
|------|-------------|
| `wiki_index` | Read the wiki's catalog page (`index.md`) — the LLM's starting point |
| `wiki_list` | Enumerate every page with slug, title, summary, tags |
| `wiki_read` | Read a single page by slug — returns parsed frontmatter + body |
| `wiki_search` | Weighted substring search across title / tags / body with snippets |

---

## Technology Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js 20 LTS (ES Modules) |
| MCP SDK | @modelcontextprotocol/sdk ^1.27.0 |
| Database (runtime) | better-sqlite3 ^12.8.0 (native, read-only) |
| Database (KB build) | sql.js ^1.12.0 (WebAssembly SQLite) |
| XML parsing | fast-xml-parser ^5.2.3 |
| ZIP handling | adm-zip ^0.5.16 (Task Recorder .axtr + Security upload) |
| Azure Functions | @azure/functions ^4.9.0 (v4 programming model) |
| Infrastructure | Azure Bicep |
| Deployment | PowerShell + Azure CLI |

---

**Owner**: Trelleborg IT Services (TIS)
**Author**: Florian Dittgen
**Version**: 2.1
