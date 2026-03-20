# Implementation: D365FO MCP Services

**Project**: tis-p-mcpd365fo
**Owner**: Trelleborg IT Services (TIS)
**Version**: 2.0
**Date**: 2026-03-18
**Author**: Florian Dittgen
**Status**: Current

---

## 1. Project Structure

```
C:\working\MCP\
├── build/
│   ├── build-kb.js              # KB database builder (XML → SQLite)
│   └── build-xref-db.js         # XRef database builder (LocalDB → SQLite)
├── docs/
│   ├── Architecture.md           # System architecture (architects)
│   ├── Implementation.md         # Implementation details (this document)
│   ├── Administration.md         # Operations and deployment (Azure admins)
│   ├── AI-Configuration.md       # MCP client setup (AI administrators)
│   ├── VS-Code-Guide.md           # VS Code setup and development workflow
│   └── TIS-P-MCPD365FO-Concept.md  # Original concept v1.0 (deprecated)
├── infra/
│   ├── main-rg.bicep             # Main Bicep template (resource group scope)
│   ├── main.bicep                # Subscription-scoped wrapper
│   ├── dev.parameters.json       # Dev environment parameters
│   ├── parameters.prod.json      # Prod environment parameters
│   └── modules/
│       ├── functionApp.bicep     # Function App + ASP + Storage + KV
│       └── monitoring.bicep      # Log Analytics + App Insights
├── scripts/
│   ├── Get-D365Configurations.ps1  # Export D365FO XPP configurations to XML
│   ├── Update-Databases.ps1        # Rebuild DBs from D365FO config (recommended)
│   ├── Deploy-Databases.ps1        # Upload DBs to Azure + restart services
│   ├── Build-Databases.ps1         # Low-level build orchestrator (manual paths)
│   ├── Deploy-Infrastructure.ps1   # Bicep deployment
│   ├── Deploy-FunctionApp.ps1      # Code + DB deployment to Azure
│   ├── Deploy-McpD365foData.ps1    # Master pipeline (roles + deploy)
│   └── Set-RoleAssignments.ps1     # RBAC role assignment
├── src/
│   ├── azure/
│   │   ├── shared.js             # DB singletons, query helper, formatting
│   │   ├── kb-tools.js           # 17 KB tool implementations
│   │   └── xref-tools.js         # 16 XRef tool implementations
│   ├── functions/
│   │   ├── d365kb.js             # Azure Function: KB MCP endpoint
│   │   ├── d365xref.js           # Azure Function: XRef MCP endpoint
│   │   └── index.js              # Function App entry point
│   └── local/
│       ├── mcp-server-kb.js      # Local stdio server (KB)
│       └── mcp-server-xref.js    # Local stdio server (XRef)
├── host.json                     # Azure Functions runtime config
├── package.json                  # Dependencies and scripts
└── package-lock.json
```

---

## 2. Build Pipeline

### 2.1 KB Build (`build/build-kb.js`)

The KB builder parses D365FO XML metadata from PackagesLocalDirectory into a SQLite database optimized for AI consumption.

**Invocation:**

```bash
node build/build-kb.js [paths] [outputPath]
# paths: comma-separated list of package directories
# Example:
node build/build-kb.js "C:\path\PackagesLocalDirectory,C:\Workspace\DEV\Metadata" output.sqlite
```

**Build phases:**

| Phase | Action | Details |
|-------|--------|---------|
| Phase 0 | Label loading | Scans all en-US `.label.txt` files across package directories. Loads 369K+ label IDs (e.g., `@SYS12345`) with resolved text. Stored in `labels` table. |
| Phase 1 | Metadata extraction | Parses XML files for 10 object types across all source directories (Microsoft + ISV). |
| Phase 2 | Summaries and indexes | Builds module summaries, populates FTS search index (`kb_search`), imports curated data (hallucination traps, field renames, query templates). Stores build metadata. |

**Phase 1 extraction steps (10 steps):**

| Step | Object Type | XML Source | Key Data |
|------|-------------|-----------|----------|
| 1/10 | AxTable | `AxTable/*.xml` | Tables, fields, indexes, relations, field groups, table methods |
| 2/10 | AxEnum | `AxEnum/*.xml` | Enum names, values with numeric IDs, labels |
| 3/10 | AxEdt | `AxEdt/*.xml` | Extended data types, base types, references |
| 4/10 | AxClass | `AxClass/*.xml` | Classes, inheritance, interfaces, method signatures + full X++ source |
| 5/10 | AxDataEntityView | `AxDataEntityView/*.xml` | Data entities, OData names, primary tables, entity fields |
| 6/10 | AxForm | `AxForm/*.xml` | Form metadata, data sources |
| 7/10 | AxView | `AxView/*.xml` | Views, field counts |
| 8/10 | Security objects | `AxSecurityRole/*.xml`, `AxSecurityDuty/*.xml`, `AxSecurityPrivilege/*.xml` | Roles, duties, privileges, entry points |
| 9/10 | Menu Items | `AxMenuItemDisplay/*.xml`, `AxMenuItemAction/*.xml`, `AxMenuItemOutput/*.xml` | Menu items (Display, Action, Output) |
| 10/10 | Summaries | Computed | Module summaries, FTS index, curated data |

**Multi-directory support:** The builder accepts a comma-separated list of package directories. All directories are scanned sequentially. This supports both Microsoft standard packages and ISV/custom model metadata from separate paths.

**Build technology:** The KB builder uses `sql.js` (WebAssembly SQLite) during the build phase because it allows in-memory database construction and single-file export without requiring a native binary on the build machine. The XRef builder uses `better-sqlite3` (native, file-based) because the ~3.3 GB database exceeds the WASM in-memory ArrayBuffer limit.

### 2.2 XRef Build (`build/build-xref-db.js`)

The XRef builder extracts cross-reference data from Visual Studio's LocalDB into a SQLite database.

**Important:** The LocalDB cross-reference database is initially delivered by Microsoft and only contains references for standard Microsoft models. ISV and custom model references are only included after a full cross-reference build in Visual Studio (Dynamics 365 > Build Cross Reference Data). The `build-xref-db.js` script exports whatever data is in LocalDB at the time -- it does not generate cross-references itself.

**Invocation:**

```bash
node --max-old-space-size=8192 build/build-xref-db.js [server] [database] [outputPath]
# Defaults:
#   server   = (LocalDB)\MSSQLLocalDB
#   database = XRef_tbg-dev3651002263172
#   output   = %USERPROFILE%\.claude\d365fo_xref.sqlite
```

**Process:**
1. Connect to LocalDB via named pipe (resolved using `SqlLocalDB info` CLI)
2. Stream all rows from `dbo.Names`, `dbo.References`, `dbo.Modules`, `dbo.Providers`
3. Insert into SQLite tables with matching schema
4. Create covering indexes on `refs(source_id)`, `refs(target_id)`, `refs(kind)`, etc.
5. Export to file

**Note:** The `--max-old-space-size=8192` flag is required because the 26.6M reference rows require significant memory during bulk insert.

---

## 3. Database Schemas

### 3.1 KB Database Tables

| Table | Primary Key | Description | Approximate Rows |
|-------|-------------|-------------|-----------------|
| `kb_metadata` | `key` | Build metadata (version, date, paths) | ~4 |
| `modules` | `module_id` | Module/package summaries with object counts | ~180 |
| `tables` | `table_name` | Table metadata (group, cache, clustering) | ~17,600 |
| `fields` | `(table_name, field_name)` | Table fields (type, EDT, enum, mandatory) | ~250,000 |
| `indexes_tbl` | `(table_name, index_name)` | Table indexes (unique, clustered, fields JSON) | ~35,000 |
| `relations` | `(source_table, relation_name)` | Foreign key relations (constraints JSON) | ~60,000 |
| `enums` | `enum_name` | Enums with values JSON (name, value, label) | ~7,800 |
| `edts` | `edt_name` | Extended data types (base type, extends, ref) | ~12,000 |
| `classes` | `class_name` | Classes (extends, implements, abstract) | ~63,400 |
| `methods` | `(owner_type, owner_name, method_name)` | Method signatures + full X++ source code | ~820,000 |
| `data_entities` | `entity_name` | Data entities (OData name, primary table) | ~5,400 |
| `entity_fields` | `(entity_name, field_name)` | Entity field mappings | ~90,000 |
| `forms` | `form_name` | Form metadata with data sources JSON | ~12,000 |
| `views` | `view_name` | View definitions | ~4,500 |
| `security_roles` | `role_name` | Security roles with duties JSON | ~300 |
| `security_duties` | `duty_name` | Security duties with privileges JSON | ~1,500 |
| `security_privileges` | `privilege_name` | Security privileges with entry points JSON | ~7,000 |
| `menu_items` | `(menu_item_name, menu_item_type)` | Menu items (Display, Action, Output) | ~22,000 |
| `graph_edges` | `(source_node, target_node, edge_type, edge_detail)` | Object dependency graph for traversal | ~120,000 |
| `hallucination_traps` | `trap_id` | Known LLM mistakes and corrections | curated |
| `field_renames` | `(table_name, ax2012_name)` | AX2012-to-D365FO field renames | curated |
| `query_templates` | `template_id` | Pre-validated SQL query templates | curated |
| `object_paths` | `(object_type, object_name)` | File paths to source XML files | ~100,000+ |
| `labels` | `label_id` | Resolved label IDs (@SYS12345 → text) | ~369,000 |
| `kb_search` | (none) | Full-text search index (LIKE-based, not FTS5) | ~100,000+ |

### 3.2 XRef Database Tables

| Table | Primary Key | Description | Approximate Rows |
|-------|-------------|-------------|-----------------|
| `names` | `id` | Named AOT paths (e.g., `/Classes/SalesTable/Methods/find`) | ~5,800,000 |
| `refs` | (none, indexed) | Cross-references (source → target with kind, line, col) | ~26,600,000 |
| `modules` | `id` | Module names | ~390 |
| `providers` | `id` | Provider names | ~50 |
| `kind_map` | `id` | Reference kind enum (1=Call, 2=Read, 3=Implements, etc.) | 8 |
| `xref_metadata` | `key` | Build metadata | ~3 |

**XRef reference kinds:**

| ID | Kind | Description |
|----|------|-------------|
| 1 | Call | Method call or write |
| 2 | Read | Field or property read |
| 3 | Implements | Interface implementation |
| 4 | Extends | Class inheritance |
| 6 | Delegate | Delegate subscription |
| 7 | Attribute | X++ attribute usage (e.g., `[ExtensionOf]`) |
| 9 | Tag | Tag reference |
| 10 | Override | Method override |

---

## 4. Tool Catalog

### 4.1 Knowledge Base Tools (17)

| # | Tool Name | Description | Key Parameters |
|---|-----------|-------------|----------------|
| 1 | `d365_lookup_table` | Get complete metadata for a table: fields, indexes, relations | `table_name` |
| 2 | `d365_get_join_keys` | Get exact join fields between two tables, with hallucination trap warnings | `table1`, `table2` |
| 3 | `d365_search` | Full-text search across all object types (tables, classes, enums, entities) | `query`, `object_type?`, `limit?` |
| 4 | `d365_get_enum` | Get all enum values with numeric IDs and labels | `enum_name` |
| 5 | `d365_check_field_exists` | Verify field existence on a table; suggests corrections for hallucinated names | `table_name`, `field_names[]` |
| 6 | `d365_get_class_methods` | Get method signatures (optionally full X++ source) for a class or table | `name`, `filter?`, `include_source?` |
| 7 | `d365_get_method_source` | Get full X++ source code for a specific method | `owner_name`, `method_name` |
| 8 | `d365_find_referencing_tables` | Find all tables with foreign keys TO a given table | `table_name` |
| 9 | `d365_get_module_summary` | Module summary: object counts, key tables, key classes | `module_name` |
| 10 | `d365_get_entity_sources` | Data entity details: primary table, OData name, field mappings | `entity_name` |
| 11 | `d365_sql_template` | Get pre-validated SQL query templates for common scenarios | `scenario?` |
| 12 | `d365_hallucination_check` | Check known hallucination traps for a table | `table_name` |
| 13 | `d365_raw_sql` | Execute read-only SQL against the KB database (SELECT/WITH/PRAGMA only, 500-row limit) | `sql` |
| 14 | `d365_graph_traverse` | Traverse the object dependency graph within N hops | `start_node`, `max_depth?`, `edge_type?` |
| 15 | `d365_field_renames` | Look up AX2012-to-D365FO field renames | `table_name` |
| 16 | `d365_list_modules` | List all modules/packages with object counts | (none) |
| 17 | `d365_resolve_label` | Resolve label IDs (@SYS12345) to human-readable text | `label_ids[]` |

### 4.2 Cross-Reference Tools (16)

| # | Tool Name | Description | Key Parameters |
|---|-----------|-------------|----------------|
| 1 | `xref_find_references` | Find all objects that reference a given object ("Used By" / incoming) | `object_name`, `kind?`, `limit?` |
| 2 | `xref_find_usages` | Find all objects that a given object references ("Uses" / outgoing) | `object_name`, `kind?`, `limit?` |
| 3 | `xref_find_method_callers` | Find all callers of a specific method with line numbers | `object_name`, `method_name`, `limit?` |
| 4 | `xref_class_hierarchy` | Full class inheritance: all subclasses (recursive) or parent chain | `class_name`, `direction?` |
| 5 | `xref_interface_implementors` | Find all classes implementing an interface (direct + through inheritance) | `interface_name` |
| 6 | `xref_search_names` | Search for objects by name pattern in XRef database | `pattern`, `object_type?`, `limit?` |
| 7 | `xref_method_references` | Find all outgoing references from a specific method | `object_name`, `method_name`, `kind?`, `limit?` |
| 8 | `xref_module_objects` | List all top-level objects in a module | `module_name`, `object_type?`, `limit?` |
| 9 | `xref_cross_module_deps` | Analyze cross-module dependencies (depends-on or depended-by) | `module_name`, `direction?`, `limit?` |
| 10 | `xref_raw_sql` | Execute read-only SQL against the XRef database | `sql` |
| 11 | `xref_impact_analysis` | Analyze impact of changing an object: direct + indirect dependents by type/module | `object_name`, `depth?` |
| 12 | `xref_list_modules` | List all modules in XRef database with object counts | (none) |
| 13 | `xref_object_summary` | Compact object summary: reference counts by kind, methods, sub-objects | `object_name` |
| 14 | `xref_find_extensions` | Find Chain of Command extension classes and table/form extensions | `object_name`, `object_type?`, `limit?` |
| 15 | `xref_find_field_usages` | Find all code locations that read or write a specific table field | `table_name`, `field_name`, `kind?`, `limit?` |
| 16 | `xref_find_event_handlers` | Find event handlers/delegates: SubscribesTo, DataEventHandler, Pre/PostHandler | `object_name`, `method_name?`, `limit?` |

---

## 5. Query Patterns

### 5.1 T-SQL to SQLite Conversion

The migration from Azure SQL (v1.0 concept) to SQLite (v2.0 implementation) required adapting query patterns:

| Pattern | T-SQL (Azure SQL) | SQLite |
|---------|-------------------|--------|
| Positional parameters | `@param1, @param2` | `?, ?` (positional) |
| Row limit | `SELECT TOP 100 ...` | `SELECT ... LIMIT 100` |
| Recursive CTE | `WITH cte AS (...)` | `WITH RECURSIVE cte AS (...)` |
| String concat | `+` operator | `\|\|` operator |
| Boolean values | `BIT` (0/1) | `INTEGER` (0/1) |
| JSON extraction | `JSON_VALUE()`, `OPENJSON()` | `json_extract()`, `json_each()` |
| Full-text search | `CONTAINS()` / `FREETEXT()` | LIKE-based pattern matching (FTS5 not available in sql.js WASM) |
| Case sensitivity | Case-insensitive by default | Case-insensitive for ASCII (SQLite default NOCASE collation) |
| Data types | `NVARCHAR`, `INT`, `BIT` | `TEXT`, `INTEGER` (dynamic typing) |

### 5.2 Database Connection (shared.js)

The shared database layer provides:

- **Singleton pattern**: One `better-sqlite3` connection per database, created on first access
- **Read-only mode**: `new Database(filePath, { readonly: true })`
- **Performance pragmas**: Journal OFF, 200 MB cache, 3 GB mmap
- **Parameterized queries**: `query(db, sql, params)` using positional `?` placeholders
- **Markdown formatting**: `formatMarkdownTable(rows, columns)` for tool output

---

## 6. Cross-Platform Deployment

### 6.1 better-sqlite3 Native Module

`better-sqlite3` is a native Node.js addon (C++ compiled via node-gyp). The build machine runs Windows, but the Azure Function App runs Linux. The deployment script handles this via cross-platform prebuild:

```bash
# During Deploy-FunctionApp.ps1:
npx --yes prebuild-install --platform linux --arch x64 --target 20.20.0 --runtime node
```

This downloads a pre-compiled Linux x64 binary for Node.js 20.20.0 and installs it into `node_modules/better-sqlite3/prebuilds/`, replacing the Windows binary.

### 6.2 Deployment Package

The deployment disables server-side build (`SCM_DO_BUILD_DURING_DEPLOYMENT=false`) to ensure the pre-built Linux binary is used as-is:

```
.deploy.zip
├── host.json
├── package.json
├── package-lock.json
├── node_modules/           # With Linux better-sqlite3 binary
│   ├── better-sqlite3/
│   ├── @modelcontextprotocol/sdk/
│   ├── zod/
│   └── ...
└── src/
    ├── azure/
    │   ├── shared.js
    │   ├── kb-tools.js
    │   └── xref-tools.js
    └── functions/
        ├── d365kb.js
        ├── d365xref.js
        └── index.js
```

---

## 7. Dependencies

### 7.1 Runtime Dependencies (package.json)

| Package | Version | Purpose |
|---------|---------|---------|
| `@azure/functions` | ^4.9.0 | Azure Functions v4 programming model for Node.js |
| `@modelcontextprotocol/sdk` | ^1.27.0 | MCP server SDK -- McpServer, transports (stdio + Streamable HTTP) |
| `better-sqlite3` | ^12.8.0 | Native SQLite3 binding for Node.js -- used at runtime (Azure + local XRef) |
| `fast-xml-parser` | ^5.2.3 | XML parser for D365FO metadata files during KB build |
| `sql.js` | ^1.12.0 | WebAssembly SQLite -- used during KB build and local KB server (not XRef build) |

### 7.2 Build-Time Dependencies (not in package.json)

| Tool | Purpose |
|------|---------|
| `mssql` (tedious) | SQL Server client for LocalDB access during XRef build |
| `prebuild-install` | Downloads pre-compiled better-sqlite3 binaries for Linux |
| `zod` | Schema validation for MCP tool parameters (transitive via `@modelcontextprotocol/sdk`) |

### 7.3 npm Scripts

| Script | Command | Description |
|--------|---------|-------------|
| `build:kb` | `node build/build-kb.js` | Build KB SQLite database |
| `build:xref` | `node --max-old-space-size=8192 build/build-xref-db.js` | Build XRef SQLite database |
| `start:kb` | `node src/local/mcp-server-kb.js` | Start local KB MCP server (stdio) |
| `start:xref` | `node src/local/mcp-server-xref.js` | Start local XRef MCP server (stdio) |
| `start:azure` | `func start` | Start Azure Functions locally |

---

## Related Documentation

| Document | Description |
|----------|-------------|
| [Architecture](Architecture.md) | System design, data flow, Azure resources, security model |
| [Administration](Administration.md) | Build/deploy procedures, monitoring, troubleshooting |
| [AI Configuration](AI-Configuration.md) | MCP client setup for Claude, Copilot, ChatGPT, Gemini, Cursor |
| [VS Code Guide](VS-Code-Guide.md) | VS Code setup, debugging, workflow, extensions |
| [README](../README.md) | Project overview and quick start |
