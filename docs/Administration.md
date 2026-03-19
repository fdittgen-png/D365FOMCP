# Administration: D365FO MCP Services

**Project**: tis-p-mcpd365fo
**Owner**: Trelleborg IT Services (TIS)
**Version**: 2.0
**Date**: 2026-03-18
**Author**: Florian Dittgen
**Status**: Current

---

## 1. Prerequisites

### 1.1 Build Machine

| Requirement | Version | Purpose |
|-------------|---------|---------|
| Node.js | 20+ | Runtime for build scripts and MCP servers |
| npm | 10+ | Package management |
| D365FO development environment | 10.0.x | Source of PackagesLocalDirectory (XML metadata) |
| SqlLocalDB | Any | Cross-reference database (`(LocalDB)\MSSQLLocalDB`) |
| ISV/Custom metadata path | -- | Optional: custom model metadata directory |

### 1.2 Deployment Machine

| Requirement | Version | Purpose |
|-------------|---------|---------|
| Azure CLI (`az`) | 2.x+ | Infrastructure deployment and Function App management |
| PowerShell | 5.1+ or 7+ | Deployment scripts |
| Azure subscription | -- | With permissions to create resources in target resource group |

---

## 2. Building Databases

### 2.1 Full Build (KB + XRef)

The orchestrator script builds both databases from scratch:

```powershell
cd C:\working\MCP\scripts
.\Build-Databases.ps1
```

**Parameters:**

| Parameter | Default | Description |
|-----------|---------|-------------|
| `-MsPackagesPath` | `%LOCALAPPDATA%\Microsoft\Dynamics365\10.0.2263.202\PackagesLocalDirectory` | Microsoft standard package metadata |
| `-IsvMetadataPath` | `C:\Workspace\DEV\Metadata` | ISV/custom model metadata |
| `-OutputDir` | `%USERPROFILE%\.claude` | Output directory for SQLite files |
| `-XrefServer` | `(LocalDB)\MSSQLLocalDB` | SQL Server instance for XRef source data |
| `-XrefDatabase` | `XRef_tbg-dev3651002263172` | XRef source database name |
| `-KbOnly` | (switch) | Only rebuild KB database, skip XRef |
| `-XrefOnly` | (switch) | Only rebuild XRef database, skip KB |

**Examples:**

```powershell
# Full rebuild (both databases)
.\Build-Databases.ps1

# KB only, custom paths
.\Build-Databases.ps1 -KbOnly -MsPackagesPath "D:\Packages\PackagesLocalDirectory"

# XRef only, different database
.\Build-Databases.ps1 -XrefOnly -XrefDatabase "XRef_myenv"

# Custom ISV path
.\Build-Databases.ps1 -MsPackagesPath "D:\Packages" -IsvMetadataPath "D:\MyModels"
```

### 2.2 Individual Builds

```bash
# KB database (using npm script)
npm run build:kb

# KB database (direct, with custom paths)
node build/build-kb.js "C:\path1,C:\path2" "C:\output\d365fo_kb.sqlite"

# XRef database (using npm script -- includes --max-old-space-size=8192)
npm run build:xref

# XRef database (direct)
node --max-old-space-size=8192 build/build-xref-db.js "(LocalDB)\MSSQLLocalDB" "XRef_dbname" "C:\output\d365fo_xref.sqlite"
```

### 2.3 Build Requirements

| Database | Memory Flag | Build Time | Output Size |
|----------|------------|------------|-------------|
| KB | Not required (but benefits from extra memory) | ~10 minutes | ~1,063 MB |
| XRef | `--max-old-space-size=8192` **required** | ~22 minutes | ~3,300 MB |

The XRef build streams 26.6M reference rows from LocalDB and must hold intermediate data in memory. Without the 8 GB heap flag, the build will fail with "JavaScript heap out of memory".

### 2.4 Build Output

After a successful build, the output directory contains:

```
%USERPROFILE%\.claude\
├── d365fo_kb.sqlite      (~1,063 MB)
└── d365fo_xref.sqlite    (~3,300 MB)
```

---

## 3. Deploying Infrastructure

### 3.1 One-Time Setup

Deploy Azure resources using Bicep:

```powershell
cd C:\working\MCP\scripts
.\Deploy-Infrastructure.ps1 -Environment d
```

**Parameters:**

| Parameter | Default | Description |
|-----------|---------|-------------|
| `-Environment` | `d` | `d` (development) or `p` (production) |
| `-ResourceGroup` | `tis-{env}-mcpd365fo-rg` | Target resource group (must exist) |

**Prerequisites:** The resource group must be created manually in the Azure portal before running this script.

### 3.2 Resources Created

| Resource | Type | SKU |
|----------|------|-----|
| Function App | Linux Function App | (on EP1 plan) |
| App Service Plan | Elastic Premium | EP1, max 3 workers |
| Storage Account | StorageV2 | Standard_LRS |
| Key Vault | Standard | RBAC-enabled, soft delete (7 days) |
| Application Insights | Web | Connected to Log Analytics |
| Log Analytics Workspace | PerGB2018 | 30-day retention |

No Azure SQL Server or database is created -- all data is stored in SQLite files on the Function App's persistent filesystem.

### 3.3 Post-Infrastructure: Role Assignments

After infrastructure deployment, assign RBAC roles:

```powershell
.\Set-RoleAssignments.ps1 -Environment d
```

This assigns the **Key Vault Secrets User** role to the Function App's system-assigned managed identity, scoped to the Key Vault.

---

## 4. Deploying the Function App

### 4.1 Full Deployment

```powershell
cd C:\working\MCP\scripts
.\Deploy-FunctionApp.ps1 -Environment d
```

**Parameters:**

| Parameter | Default | Description |
|-----------|---------|-------------|
| `-Environment` | `d` | `d` or `p` |
| `-SkipNpmInstall` | (switch) | Skip npm install, use existing node_modules |
| `-SkipDbUpload` | (switch) | Skip SQLite database upload |
| `-KbDbPath` | `%USERPROFILE%\.claude\d365fo_kb.sqlite` | Path to KB database file |
| `-XrefDbPath` | `%USERPROFILE%\.claude\d365fo_xref.sqlite` | Path to XRef database file |

### 4.2 What the Deployment Does

1. **Verify Function App exists** -- checks the target Function App is deployed
2. **Upload SQLite databases** -- pushes KB and XRef databases to `/home/data/` via Kudu VFS API
3. **Prepare deployment package** -- copies `host.json`, `package.json`, `src/azure/`, `src/functions/`
4. **Install dependencies** -- runs `npm install --omit=dev` in a staging directory
5. **Cross-install Linux binary** -- downloads Linux x64 prebuild of `better-sqlite3` for Node.js 20.20.0
6. **Disable remote build** -- sets `SCM_DO_BUILD_DURING_DEPLOYMENT=false`
7. **Create and deploy zip** -- compresses staging directory and deploys via `az functionapp deployment source config-zip`
8. **Clean up** -- removes staging directory and zip file

### 4.3 Database Upload Details

Databases are uploaded via the Kudu VFS API (not Azure Storage):

```
PUT https://{funcName}.scm.azurewebsites.net/api/vfs/data/d365fo_kb.sqlite
PUT https://{funcName}.scm.azurewebsites.net/api/vfs/data/d365fo_xref.sqlite
```

Authentication uses Kudu publishing credentials (Basic auth). The XRef database (~3.3 GB) upload may take several minutes depending on network speed.

### 4.4 Cross-Platform Native Module

The `better-sqlite3` package contains platform-specific compiled code. Since the build machine runs Windows and the Function App runs Linux, the deployment script cross-installs:

```bash
npx --yes prebuild-install --platform linux --arch x64 --target 20.20.0 --runtime node
```

The `--target 20.20.0` must match the Node.js version running on the Azure Function App. If the Function App's Node.js version changes, update this target accordingly.

---

## 5. Full Pipeline

### 5.1 Master Orchestrator

The master pipeline script runs role assignments + Function App deployment:

```powershell
cd C:\working\MCP\scripts
.\Deploy-McpD365foData.ps1 -Environment d
```

**Parameters:**

| Parameter | Default | Description |
|-----------|---------|-------------|
| `-Environment` | `d` | `d` or `p` |
| `-SkipRoles` | (switch) | Skip role assignment step |
| `-SkipFunctionApp` | (switch) | Skip Function App deployment step |

### 5.2 Complete End-to-End Workflow

```powershell
# 1. Build databases (on dev machine with D365FO environment)
.\Build-Databases.ps1

# 2. Deploy infrastructure (one-time)
.\Deploy-Infrastructure.ps1 -Environment d

# 3. Deploy code + data
.\Deploy-McpD365foData.ps1 -Environment d
```

---

## 6. Updating Data

### 6.1 Rebuild KB Database Only

When metadata sources change (new D365FO version, ISV model updates):

```powershell
# 1. Rebuild KB database
.\Build-Databases.ps1 -KbOnly

# 2. Upload new database to Azure
.\Deploy-FunctionApp.ps1 -Environment d -SkipNpmInstall
```

Or upload just the database manually via Kudu:

```powershell
# Get Kudu credentials
$creds = az functionapp deployment list-publishing-credentials `
    --resource-group tis-d-mcpd365fo-rg --name tis-d-mcpd365fo-func `
    --query "{user:publishingUserName, pass:publishingPassword}" -o json | ConvertFrom-Json
$auth = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("$($creds.user):$($creds.pass)"))

# Upload KB database
Invoke-RestMethod -Uri "https://tis-d-mcpd365fo-func.scm.azurewebsites.net/api/vfs/data/d365fo_kb.sqlite" `
    -Method PUT -Headers @{ Authorization = "Basic $auth"; 'If-Match' = '*' } `
    -InFile "$env:USERPROFILE\.claude\d365fo_kb.sqlite" -ContentType 'application/octet-stream'

# Restart Function App to pick up new database
az functionapp restart --resource-group tis-d-mcpd365fo-rg --name tis-d-mcpd365fo-func
```

### 6.2 Rebuild XRef Database Only

When cross-reference data changes (new builds, code changes in Visual Studio):

```powershell
# 1. Ensure LocalDB is running
SqlLocalDB start MSSQLLocalDB

# 2. Rebuild XRef database
.\Build-Databases.ps1 -XrefOnly

# 3. Upload (same process as KB)
.\Deploy-FunctionApp.ps1 -Environment d -SkipNpmInstall
```

### 6.3 Code-Only Deployment

When only the tool implementation changes (no database rebuild):

```powershell
.\Deploy-FunctionApp.ps1 -Environment d -SkipDbUpload
```

---

## 7. Monitoring

### 7.1 Application Insights

The Function App sends telemetry to Application Insights (`tis-{env}-mcpd365fo-appi`). Telemetry includes:

- Request traces (MCP tool invocations)
- Exceptions and errors
- Performance metrics (query duration)

Access via: Azure Portal > Application Insights > `tis-{env}-mcpd365fo-appi`

### 7.2 Health Check

Each MCP endpoint exposes a health check:

```bash
# KB health
curl https://tis-d-mcpd365fo-func.azurewebsites.net/api/d365kb

# XRef health
curl https://tis-d-mcpd365fo-func.azurewebsites.net/api/d365xref
```

Expected response:
```json
{ "name": "d365fo-kb", "version": "1.0.0", "status": "ok" }
```

### 7.3 Log Analytics

Logs are aggregated in Log Analytics (`tis-{env}-mcpd365fo-log`) with 30-day retention. Query via Azure Portal or `az monitor log-analytics query`.

---

## 8. Troubleshooting

### 8.1 Common Issues

| Symptom | Cause | Resolution |
|---------|-------|------------|
| "Cannot open database" or "no such file or directory" at runtime | SQLite files not present on `/home/data/` | Verify files exist via Kudu console: `https://{funcName}.scm.azurewebsites.net` > Debug console > navigate to `/home/data/`. Upload via `Deploy-FunctionApp.ps1` or Kudu VFS API. |
| `NODE_MODULE_VERSION` mismatch | better-sqlite3 was compiled for a different Node.js version than what the Function App runs | Re-run prebuild-install with the correct `--target` version matching the Function App's Node.js. Check with: `az functionapp config show --resource-group {rg} --name {func} --query "linuxFxVersion"`. |
| "database disk image is malformed" | KB build ran out of memory, producing a corrupt SQLite file | Rebuild with `node --max-old-space-size=8192 build/build-kb.js ...`. Delete the corrupt file first. |
| "JavaScript heap out of memory" during XRef build | Node.js default heap (4 GB) insufficient for 26.6M rows | Use `npm run build:xref` (which includes `--max-old-space-size=8192`) or add the flag manually. |
| Storage key permission errors during database upload | Azure CLI lacks permissions to get Kudu credentials | Use `az functionapp deployment list-publishing-credentials` explicitly, or upload via the Kudu portal UI. |
| Function App returns 500 after deployment | Code or dependency error | Check Application Insights for exception details. Common cause: missing or corrupt `node_modules` in the deployment package. |
| "SqlLocalDB not found" during XRef build | SqlLocalDB not installed or not on PATH | Install SQL Server LocalDB from the VS Installer or SQL Server Express. Ensure `SqlLocalDB` is on PATH. |
| MCP client receives empty response | Transport mismatch -- client sends SSE but server returns JSON | Ensure client is configured for MCP Streamable HTTP transport. The `enableJsonResponse: true` option is set in the Function App. |
| Deploy zip fails with "413 Request Entity Too Large" | node_modules too large for Kudu zip deployment | Ensure `--omit=dev` was used during npm install. The deployment package should be ~25-35 MB (excluding databases). |

### 8.2 Kudu Console Access

Access the Kudu console to inspect the Function App filesystem:

```
https://tis-{env}-mcpd365fo-func.scm.azurewebsites.net
```

Navigate to: **Debug console** > **Bash** > `/home/data/` to verify database files.

### 8.3 Restart Function App

```powershell
az functionapp restart --resource-group tis-d-mcpd365fo-rg --name tis-d-mcpd365fo-func
```

This is required after uploading new database files (the `better-sqlite3` singleton holds an open file handle).

---

## 9. Service URLs

| Environment | Service | URL |
|-------------|---------|-----|
| Development | KB MCP | `https://tis-d-mcpd365fo-func.azurewebsites.net/api/d365kb` |
| Development | XRef MCP | `https://tis-d-mcpd365fo-func.azurewebsites.net/api/d365xref` |
| Production | KB MCP | `https://tis-p-mcpd365fo-func.azurewebsites.net/api/d365kb` |
| Production | XRef MCP | `https://tis-p-mcpd365fo-func.azurewebsites.net/api/d365xref` |

---

## 10. MCP Client Configuration

### 10.1 Claude Code (Remote via Azure)

Add to Claude Code MCP settings:

```json
{
  "mcpServers": {
    "d365kb": {
      "type": "url",
      "url": "https://tis-d-mcpd365fo-func.azurewebsites.net/api/d365kb"
    },
    "d365xref": {
      "type": "url",
      "url": "https://tis-d-mcpd365fo-func.azurewebsites.net/api/d365xref"
    }
  }
}
```

### 10.2 Claude Code (Local stdio)

Add to Claude Code MCP settings:

```json
{
  "mcpServers": {
    "d365kb": {
      "type": "stdio",
      "command": "node",
      "args": ["C:\\working\\MCP\\src\\local\\mcp-server-kb.js"]
    },
    "d365xref": {
      "type": "stdio",
      "command": "node",
      "args": ["C:\\working\\MCP\\src\\local\\mcp-server-xref.js"]
    }
  }
}
```

### 10.3 Claude Desktop (Remote via Azure)

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "d365kb": {
      "type": "url",
      "url": "https://tis-d-mcpd365fo-func.azurewebsites.net/api/d365kb"
    },
    "d365xref": {
      "type": "url",
      "url": "https://tis-d-mcpd365fo-func.azurewebsites.net/api/d365xref"
    }
  }
}
```

### 10.4 Claude Desktop (Local stdio)

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "d365kb": {
      "command": "node",
      "args": ["C:\\working\\MCP\\src\\local\\mcp-server-kb.js"]
    },
    "d365xref": {
      "command": "node",
      "args": ["C:\\working\\MCP\\src\\local\\mcp-server-xref.js"]
    }
  }
}
```

### 10.5 Other AI Clients

For configuration of Cursor, GitHub Copilot, ChatGPT, Google Gemini, and other MCP-compatible clients, see [AI Configuration Guide](AI-Configuration.md).

---

## Related Documentation

| Document | Description |
|----------|-------------|
| [Architecture](Architecture.md) | System design, data flow, Azure resources, security model |
| [Implementation](Implementation.md) | Build pipeline, database schemas, tool catalog, dependencies |
| [AI Configuration](AI-Configuration.md) | MCP client setup for Claude, Copilot, ChatGPT, Gemini, Cursor |
| [README](../README.md) | Project overview and quick start |
