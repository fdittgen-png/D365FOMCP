# Administration: D365FO MCP Services

**Project**: tis-p-mcpd365fo
**Owner**: Trelleborg IT Services (TIS)
**Version**: 2.1
**Date**: 2026-05-07
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

### 2.1 Configuration-Based Build (Recommended)

The recommended approach reads build parameters directly from your D365FO Visual Studio configuration, so you don't need to manually specify paths or database names.

**Step 1: List available configurations**

```powershell
.\Update-Databases.ps1 -ListConfigs
```

Output:

```
  [CURRENT] tis-d365fo-dev-02  v10.0.2263.202  Packages:OK  XRef:XRef_tis-d365fo-dev-021002263202
  [       ] tbg-dev365          v10.0.2263.172  Packages:OK  XRef:DYNAMICSXREFDB1
  [       ] tis-d365fo-dev-02  v10.0.2527.42   Packages:OK  XRef:XRef_tis-d365fo-dev-02100252742
```

**Step 2: Rebuild databases**

```powershell
# Rebuild from the current (active) configuration
.\Update-Databases.ps1

# Rebuild from a specific configuration by name
.\Update-Databases.ps1 -ConfigName "tis-d365fo-dev-02"

# KB only / XRef only
.\Update-Databases.ps1 -KbOnly
.\Update-Databases.ps1 -XrefOnly
```

The script automatically extracts from the selected D365FO configuration:

| Config Field | Used For |
|-------------|----------|
| `FrameworkDirectory` | Microsoft packages path (PackagesLocalDirectory) |
| `ModelStoreFolder` | Custom/ISV metadata path |
| `CrossReferencesDbServerName` | XRef SQL Server instance |
| `CrossReferencesDatabaseName` | XRef database name |

**Parameters:**

| Parameter | Default | Description |
|-----------|---------|-------------|
| `-ConfigName` | (current config) | D365FO configuration name |
| `-OutputDir` | `%USERPROFILE%\.claude` | Output directory for SQLite files |
| `-KbOnly` | (switch) | Only rebuild KB database |
| `-XrefOnly` | (switch) | Only rebuild XRef database |
| `-ListConfigs` | (switch) | List available configs and exit |

### 2.2 Export D365FO Configurations

To inspect or export all D365FO XPP configurations as XML:

```powershell
# Display XML to console
.\Get-D365Configurations.ps1

# Save to file
.\Get-D365Configurations.ps1 -OutputPath C:\temp\d365-configs.xml
```

This reads from `%LOCALAPPDATA%\Microsoft\Dynamics365\XPPConfig\` (JSON config files) and the registry (`HKCU:\SOFTWARE\Microsoft\Dynamics\AX7\Development\Configurations`).

### 2.3 Manual Build (Advanced)

For cases where you need to specify paths manually (e.g., paths not in any D365FO configuration):

```powershell
.\Build-Databases.ps1

# KB only, custom paths
.\Build-Databases.ps1 -KbOnly -MsPackagesPath "D:\Packages\PackagesLocalDirectory"

# XRef only, different database
.\Build-Databases.ps1 -XrefOnly -XrefDatabase "XRef_myenv"
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

Or use the Node.js scripts directly:

```bash
# KB database
node build/build-kb.js "C:\path1,C:\path2" "C:\output\d365fo_kb.sqlite"

# XRef database (--max-old-space-size=8192 is required)
node --max-old-space-size=8192 build/build-xref-db.js "(LocalDB)\MSSQLLocalDB" "XRef_dbname" "C:\output\d365fo_xref.sqlite"
```

### 2.4 Cross-Reference Data Coverage

The LocalDB cross-reference database is **initially delivered by Microsoft** and only contains references for standard Microsoft models. ISV and custom model references are **not included** until a full cross-reference build is performed in Visual Studio:

**Dynamics 365 > Build Cross Reference Data** (in Visual Studio)

Until this build completes, XRef queries will only return results for Microsoft standard objects. The `build-xref-db.js` script exports whatever data is in LocalDB at the time -- it does not generate cross-references itself.

### 2.5 Build Requirements

| Database | Memory Flag | Build Time | Output Size |
|----------|------------|------------|-------------|
| KB | Not required (but benefits from extra memory) | ~10 minutes | ~1,063 MB |
| XRef | `--max-old-space-size=8192` **required** | ~22 minutes | ~3,300 MB |

The XRef build streams 26.6M reference rows from LocalDB and must hold intermediate data in memory. Without the 8 GB heap flag, the build will fail with "JavaScript heap out of memory".

### 2.6 Build Output

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

### 5.1 Recommended Workflow (Update + Deploy)

The simplest way to update the MCP services after a D365FO version change or code update:

```powershell
# 1. Rebuild databases from current D365FO configuration
.\Update-Databases.ps1

# 2. Upload databases to Azure and restart
.\Deploy-Databases.ps1 -Environment d
```

### 5.2 First-Time Setup (Complete End-to-End)

```powershell
# 1. Deploy infrastructure (one-time)
.\Deploy-Infrastructure.ps1 -Environment d

# 2. Build databases from D365FO configuration
.\Update-Databases.ps1

# 3. Deploy code + data + RBAC roles
.\Deploy-McpD365foData.ps1 -Environment d
```

### 5.3 Master Orchestrator (Code + Data)

For full code redeployment (including `node_modules` and databases):

```powershell
.\Deploy-McpD365foData.ps1 -Environment d
```

| Parameter | Default | Description |
|-----------|---------|-------------|
| `-Environment` | `d` | `d` or `p` |
| `-SkipRoles` | (switch) | Skip role assignment step |
| `-SkipFunctionApp` | (switch) | Skip Function App deployment step |

---

## 6. Updating Data

### 6.1 Update Both Databases (Recommended)

When the D365FO version changes or metadata is updated:

```powershell
# Rebuild from current config and deploy
.\Update-Databases.ps1
.\Deploy-Databases.ps1 -Environment d
```

### 6.2 Update KB Database Only

When metadata sources change (new D365FO version, ISV model updates):

```powershell
.\Update-Databases.ps1 -KbOnly
.\Deploy-Databases.ps1 -Environment d -KbOnly
```

### 6.3 Update XRef Database Only

When cross-reference data changes (new builds, code changes in Visual Studio):

```powershell
.\Update-Databases.ps1 -XrefOnly
.\Deploy-Databases.ps1 -Environment d -XrefOnly
```

### 6.4 Deploy-Databases.ps1 Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `-Environment` | `d` | `d` (development) or `p` (production) |
| `-KbDbPath` | `%USERPROFILE%\.claude\d365fo_kb.sqlite` | Path to KB database |
| `-XrefDbPath` | `%USERPROFILE%\.claude\d365fo_xref.sqlite` | Path to XRef database |
| `-KbOnly` | (switch) | Only upload KB database |
| `-XrefOnly` | (switch) | Only upload XRef database |
| `-SkipRestart` | (switch) | Skip Function App restart |

The script uploads databases via the Kudu VFS API, restarts the Function App, and validates both MCP endpoints with health checks.

### 6.5 Code-Only Deployment

When only the tool implementation changes (no database rebuild):

```powershell
.\Deploy-FunctionApp.ps1 -Environment d -SkipDbUpload
```

### 6.6 Script Reference

| Script | Purpose | When to Use |
|--------|---------|-------------|
| `Get-D365Configurations.ps1` | Export D365FO XPP configurations to XML | Inspect available configurations |
| `Update-Databases.ps1` | Rebuild KB/XRef from D365FO config | D365FO version update, metadata change |
| `Deploy-Databases.ps1` | Upload databases to Azure + restart | After rebuilding databases |
| `Build-Databases.ps1` | Low-level build with manual paths | When config-based build is not possible |
| `Deploy-Infrastructure.ps1` | Deploy Bicep templates | First-time Azure setup |
| `Deploy-FunctionApp.ps1` | Deploy code + databases | Code changes, full redeployment |
| `Deploy-McpD365foData.ps1` | Master pipeline (roles + deploy) | First-time or full redeployment |
| `Set-RoleAssignments.ps1` | RBAC role assignment | After infrastructure deployment |

All scripts use relative paths internally and can be run from any directory.

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
| Development | Security MCP | `https://tis-d-mcpd365fo-func.azurewebsites.net/api/d365sec` |
| Development | Task Recorder MCP | `https://tis-d-mcpd365fo-func.azurewebsites.net/api/d365taskrecorder` |
| Development | OTRS Extractor (HTTP, function-key auth) | `https://tis-d-mcpd365fo-func.azurewebsites.net/api/otrs/extract` |
| Development | Wiki catalog | `https://tis-d-mcpd365fo-func.azurewebsites.net/api/wiki-mcp` |
| Development | Wiki MCP (per wiki) | `https://tis-d-mcpd365fo-func.azurewebsites.net/api/wiki-mcp/{name}` |
| Development | Health probe | `https://tis-d-mcpd365fo-func.azurewebsites.net/api/health` |
| Development | Admin UI | `https://tis-d-mcpd365fo-func.azurewebsites.net/api/admin` |
| Production | KB MCP | `https://tis-p-mcpd365fo-func.azurewebsites.net/api/d365kb` |
| Production | XRef MCP | `https://tis-p-mcpd365fo-func.azurewebsites.net/api/d365xref` |
| Production | Security MCP | `https://tis-p-mcpd365fo-func.azurewebsites.net/api/d365sec` |
| Production | Task Recorder MCP | `https://tis-p-mcpd365fo-func.azurewebsites.net/api/d365taskrecorder` |
| Production | OTRS Extractor (HTTP, function-key auth) | `https://tis-p-mcpd365fo-func.azurewebsites.net/api/otrs/extract` |
| Production | Wiki catalog | `https://tis-p-mcpd365fo-func.azurewebsites.net/api/wiki-mcp` |
| Production | Wiki MCP (per wiki) | `https://tis-p-mcpd365fo-func.azurewebsites.net/api/wiki-mcp/{name}` |
| Production | Health probe | `https://tis-p-mcpd365fo-func.azurewebsites.net/api/health` |
| Production | Admin UI | `https://tis-p-mcpd365fo-func.azurewebsites.net/api/admin` |

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

## 11. OTRS Extractor Operations

The OTRS Extractor is an HTTP route (`POST /api/otrs/extract`) on the same Function App as the MCP services. It pulls resolved D365 support tickets from OTRS and returns them as XML for Power Automate to forward into the wiki. See [Architecture §9](Architecture.md#9-otrs-support-case-pipeline) for the pipeline design and [PowerAutomate — OTRS Extractor](PowerAutomate-OTRS-Extract.md) for the Power Automate flow.

### 11.1 App Settings

Configured in `infra/modules/functionApp.bicep` and deployed via `Deploy-Infrastructure.ps1`. After the initial `bicep deploy`, the `OTRS_PASSWORD` is an empty placeholder — the real secret must be set out-of-band so it never lands in source control or Bicep output.

| Setting | Purpose | Source | Default |
|---------|---------|--------|---------|
| `OTRS_USERNAME` | OTRS generic-interface login | Bicep | `wstis` |
| `OTRS_PASSWORD` | OTRS password | **Set manually post-deploy** (see §11.2) | *(empty)* |
| `OTRS_SEARCH_URL` | TicketSearch endpoint | Bicep | `https://trelleborg.managed-otrs.com/otrs/nph-genericinterface.pl/Webservice/TIS_WS/TicketSearch` |
| `OTRS_GET_URL` | TicketGet endpoint | Bicep | `https://trelleborg.managed-otrs.com/otrs/nph-genericinterface.pl/Webservice/TIS_WS/TicketGet` |
| `OTRS_SERVICE_ID` | Numeric service-row ID used as the TicketSearch `ServiceID` filter. **Not** the human-readable name — OTRS rejects the string form with a generic "Authorization failing" error. Look up in OTRS Admin → Services. | Bicep | `798` (Trelleborg D365 support) |
| `OTRS_STATE` | States filter applied on TicketSearch | Bicep | `closed successful` |
| `OTRS_MIN_RESOLUTION_CHARS` | Minimum combined agent-article body length (chars) for a ticket to count as "has resolution" | Bicep | `200` |

### 11.2 Setting the OTRS Password

The password is the only secret — every other app setting is a non-sensitive configuration value. Set it once after `Deploy-Infrastructure.ps1`:

```powershell
az functionapp config appsettings set `
  --name tis-p-mcpd365fo-func `
  -g   tis-p-mcpd365fo-rg `
  --settings OTRS_PASSWORD=<real-password>
```

The Function App restarts automatically. Rotating the password is the same command — no redeploy needed.

> When the dedicated Key Vault (`tis-p-mcpd365fo-kv`) is stood up in a future CR, replace the plain-value app setting with a Key Vault reference (`@Microsoft.KeyVault(SecretUri=…)`) and grant the Function App's managed identity **Key Vault Secrets User** on the secret. The code reads `process.env.OTRS_PASSWORD` either way.

### 11.3 State Blob

| Attribute | Value |
|-----------|-------|
| Storage account | `tis{env}mcpd365fost` (same account as Functions runtime) |
| Container | `otrs-state` (auto-created on first write) |
| Blob | `otrs-extract-state.json` |
| Payload | `{ version, lastExtractedAt, processedTicketIds: [string] }` |

**Inspecting** — open Azure Portal → storage account → containers → `otrs-state` → download `otrs-extract-state.json`, or:

```powershell
az storage blob download `
  --account-name tispmcpd365fost `
  -c otrs-state -n otrs-extract-state.json -f state.json
```

**Resetting** — delete the blob; the next `mode: "incremental"` run behaves like the first and will re-pull every ticket that currently matches the OTRS filter.

```powershell
az storage blob delete `
  --account-name tispmcpd365fost `
  -c otrs-state -n otrs-extract-state.json
```

### 11.4 Health Check

The route only responds to `POST` with a function key, so a browser GET is not a useful health signal. Use:

```bash
curl -X POST "https://tis-p-mcpd365fo-func.azurewebsites.net/api/otrs/extract?code=<function-key>" \
     -H "Content-Type: application/json" \
     -d '{"mode":"preview","limit":1}'
```

`mode: "preview"` extracts one ticket without writing the state blob. A `200` with a non-empty `<OtrsExtract>` envelope proves: app settings present, OTRS reachable, credentials valid, state container accessible. The response headers `X-OTRS-Extracted` / `X-OTRS-Skipped` / `X-OTRS-Candidates` give a quick snapshot of the batch.

### 11.5 Troubleshooting

| Symptom | Cause | Resolution |
|---------|-------|------------|
| `500` with `"Missing OTRS config: OTRS_PASSWORD"` | Password never set or deleted after redeploy | Run the `az functionapp config appsettings set` command in §11.2 |
| `500` with `"OTRS returned error WebserviceNotAuth"` | Wrong username / password, or OTRS account locked | Confirm credentials with Przemysław; re-run the `set` command |
| `500` with `"OTRS request failed: HTTP 502"` | OTRS service or its upstream proxy down | Retry; if persistent, escalate to OTRS operator |
| `200` but `X-OTRS-Extracted: 0` on a first `full` run | `OTRS_SERVICE_ID` or `OTRS_STATE` filters don't match anything | Verify the service ID in OTRS Admin → Services and confirm `OTRS_STATE` matches the exact state-name casing |
| `500` with `TicketSearch.AuthFail` even though the password is correct | Wrong payload shape — usually `OTRS_SERVICE_ID` is not numeric, or a legacy `OTRS_SERVICE` (string name) app-setting is still present | Delete any old `OTRS_SERVICE` setting, set `OTRS_SERVICE_ID=<integer>` |
| Every ticket ends up under `<Skipped>` with `"resolution too thin"` | `OTRS_MIN_RESOLUTION_CHARS` too strict for your tickets | Lower the value (try `100`) via `az functionapp config appsettings set` |
| State blob not updating | Calling with `mode: "preview"` | Use `incremental` or `full` — preview is dry-run by design |
| Same tickets re-extracted every run | State blob was deleted, or the Power Automate flow is calling with `mode: "full"` | Switch Power Automate to `incremental`; inspect the blob in Azure Portal |
| `401 Unauthorized` from Power Automate | Function key missing / wrong | Copy the current key from Azure Portal → Function App → App keys → default |

### 11.6 Observability

The route logs through App Insights alongside the MCP endpoints. Useful traces:

- `otrs-extract: mode=… limit=… known=…` — per-request parameters
- `otrs-extract: TicketSearch → <N> candidate IDs` — upstream response size
- `otrs-extract: extracted=<X> skipped=<Y>` — per-run outcome
- `otrs-extract: ticket <id> failed — <msg>` — per-ticket fetch errors (skipped, not fatal)
- `otrs-extract: state blob write failed — <msg>` — **warning** signal; the XML response was still returned but the next run may re-extract the same IDs

---

## 12. Wiki MCP Operations

The Wiki MCP platform exposes one MCP server per configured wiki via a single parameterized route. Architecture background: [Architecture §10](Architecture.md#10-wiki-mcp-platform--one-shape-many-wikis). MCP-client-facing reference: [MCP — Wiki Services](MCP-Wiki-Services.md).

### 12.1 Registry — `config/wikis.json`

The registry ships in source control. Each entry produces one MCP server, reachable at `/api/wiki-mcp/<name>`. Entries not in the registry are not reachable — the route returns `404` with the list of available names.

```json
[
  {
    "name": "otrs",
    "title": "OTRS Resolved Cases",
    "description": "Knowledge base of resolved D365 support cases…",
    "container": "wiki",
    "indexBlob": "index.md",
    "pagesPrefix": "tickets/"
  }
]
```

Overriding the committed file for one environment: set the `WIKI_CONFIG_JSON` app setting to the JSON array. When set, the env var wins — this lets you stage a new wiki in dev before editing the committed file.

### 12.2 Adding a Wiki — `Add-WikiMcp.ps1`

One-command provisioning:

```powershell
cd C:\working\MCP\scripts
.\Add-WikiMcp.ps1 `
    -Name runbooks `
    -Title 'Operations Runbooks' `
    -Description 'Runbooks for common operational tasks across D365 and supporting platforms.' `
    -PagesPrefix 'runbooks/' `
    -SeedIndex -Redeploy -Environment p
```

| Parameter | Required | Purpose |
|-----------|:--------:|---------|
| `-Name` | yes | URL slug. `^[a-z0-9][a-z0-9-]{0,62}$`. Becomes the MCP server name (`wiki-<name>`) and the path segment. |
| `-Title` | yes | Human-readable title. Any string. |
| `-Description` | yes | One-to-two sentences the LLM reads when deciding if the wiki is relevant. Be specific. |
| `-Container` | no | Blob container name. Default `wiki-<name>`. Must conform to Azure blob container naming rules. |
| `-PagesPrefix` | no | Blob-name prefix for pages (e.g. `runbooks/`). Default empty — pages live at the container root. |
| `-IndexBlob` | no | Index filename. Default `index.md`. |
| `-SeedIndex` | switch | Upload a minimal index.md so `wiki_index` responds immediately. |
| `-Redeploy` | switch | Run `Deploy-FunctionApp.ps1 -SkipDbUpload` after updating the registry. |
| `-Environment` | no | `d` or `p`. Default `d`. |

What it does, in order: validates the slug, appends an entry to `config/wikis.json`, reads the storage-account key via `az`, creates the blob container, optionally uploads a seed index, optionally redeploys. Prints the endpoint URL at the end.

### 12.3 Removing a Wiki

There is intentionally no `Remove-WikiMcp.ps1` — deletion is riskier than creation and benefits from a human-in-the-loop. To retire a wiki:

1. Remove its entry from `config/wikis.json`.
2. `Deploy-FunctionApp.ps1 -SkipDbUpload` — the route now returns `404` for the name.
3. **Decide separately** whether to delete the blob container (the markdown is the data; removing the MCP just hides it).

```powershell
# Only after you've confirmed the container is disposable
az storage container delete --account-name tispmcpd365fost -c <container>
```

### 12.4 Health Check per Wiki

```bash
# Catalog of every configured wiki
curl https://tis-p-mcpd365fo-func.azurewebsites.net/api/wiki-mcp

# Per-wiki health (cheap GET without SSE)
curl https://tis-p-mcpd365fo-func.azurewebsites.net/api/wiki-mcp/otrs
```

Expected: `200` with `{ "name": "wiki-otrs", "title": "…", "container": "wiki", "status": "ok" }`.

### 12.5 Managing Wiki Content

The MCP **only reads** the markdown. Content can arrive by several paths; pick whichever matches your source:

| Path | How |
|------|-----|
| OTRS pipeline | Power Automate → `POST /api/otrs/ingest` (future CR) writes markdown on a schedule. |
| Manual upload | `az storage blob upload --account-name <st> -c <container> -n <slug>.md -f <file>` |
| Logic App / bespoke | Any process that lands valid markdown in the container. The 60-second cache TTL means new files are visible to the LLM within one minute. |

**Inspecting:** Azure Portal → storage account → containers → pick wiki container → browse files. Or:

```powershell
az storage blob list --account-name tispmcpd365fost -c wiki --output table
```

### 12.6 Cache Invalidation

The MCP caches blob contents per Function instance for 60 seconds. After uploading new pages, expect up to one minute of staleness. If you need an immediate refresh:

```powershell
# Restart recycles every instance and clears the in-memory cache
az functionapp restart --resource-group tis-p-mcpd365fo-rg --name tis-p-mcpd365fo-func
```

Every client call that happens after the restart sees the fresh content on its first hit.

### 12.7 Troubleshooting

| Symptom | Cause | Resolution |
|---------|-------|------------|
| `404` with `"Wiki \"<name>\" is not configured"` | Registry has no entry for the requested slug | Check the `available` list in the response; fix the URL, or add the wiki via `Add-WikiMcp.ps1` |
| `500` with `"Wiki registry failed to load"` | `config/wikis.json` malformed or `WIKI_CONFIG_JSON` is invalid | Re-check the JSON. The error hint includes the parse/validation message |
| `wiki_index` returns `"index.md has not been written yet"` | Container exists but no index blob | Upload one manually or re-run `Add-WikiMcp.ps1 -SeedIndex` for this wiki |
| `wiki_search` returns no matches for a term that's obviously in a page | The 60-second cache is serving a pre-upload snapshot | Wait 60 s or `az functionapp restart` |
| `500` with `"Could not read the … index"` in tool output | Blob container is missing, or the storage account key rotated | Confirm the container exists; re-sync `AzureWebJobsStorage` with the current account key |
| Azure CLI errors on `storage container create` inside `Add-WikiMcp.ps1` | Signed-in identity lacks RBAC on the storage account | Grant `Storage Account Key Operator Service Role` or use a managed-identity-authenticated shell |

### 12.8 Observability

The wiki routes log to the same App Insights instance as the other MCPs. Useful traces:

- `wiki-mcp catalog error: <msg>` — registry failed to load
- `wiki-mcp registry error: <msg>` — per-request registry resolution failed
- `wiki-mcp[<name>] error: <msg>` — MCP transport-level error for a specific wiki
## 11. Dependency Update Policy

The runtime is locked to a single Node.js major version and selected dependencies are pinned to exact versions to prevent uncontrolled drift in the deployed Azure Function App and local MCP servers.

### 11.1 Node.js version

- `package.json` declares `"engines": { "node": ">=20.0.0 <21.0.0" }` — npm warns if a different major is used.
- `.nvmrc` pins the local development version to `20` for `nvm`/`fnm`/Volta users.
- Azure Function App runtime stack must remain on Node 20 LTS; any change to `engines` requires a matching infra update in `infra/`.

### 11.2 Pinned dependencies (exact version, no caret)

| Package | Reason |
|---------|--------|
| `better-sqlite3` | Native binding — minor changes can break Azure Functions Linux build |
| `sql.js` | Bundled WASM — version drift can shift query semantics |
| `adm-zip` | Used in DMF ingestion path — silent behavior changes have caused incidents |
| `@modelcontextprotocol/sdk` | Tool registration API surface — `registerTool` shape must match the static-scan tests in `test/response-format.test.js` |

### 11.3 How to update a pinned dependency

1. Open a dedicated branch: `chore/bump-<package>-<version>`.
2. Edit `package.json` to the new exact version, run `npm install` to refresh `package-lock.json`.
3. Run `npm test` and the relevant build (`npm run build:sec` etc.) on a representative dataset.
4. Open a PR. CI runs `npm ci` to verify lockfile integrity.
5. Note the change in the PR description: motivation, breaking changes scanned, test coverage.

### 11.4 How to update a non-pinned dependency

`@azure/functions`, `fast-xml-parser`, `zod`, `mssql` use `^` and follow npm semver. Refresh quarterly with `npm outdated` + `npm update` on a `chore/deps-refresh-<yyyy-mm>` branch; do not bump majors without a dedicated review.

### 11.5 CI lockfile verification

`.github/workflows/ci.yml` runs `npm ci` on every push and PR to `main`. `npm ci` fails fast if `package-lock.json` is missing, out of sync with `package.json`, or has a hash mismatch — preventing accidental ad-hoc dependency changes from reaching `main`.

---

## Related Documentation

| Document | Description |
|----------|-------------|
| [Architecture](Architecture.md) | System design, data flow, Azure resources, security model |
| [Implementation](Implementation.md) | Build pipeline, database schemas, tool catalog, dependencies |
| [AI Configuration](AI-Configuration.md) | MCP client setup for Claude, Copilot, ChatGPT, Gemini, Cursor |
| [PowerAutomate — Security DB update](PowerAutomate-SecDatabase-Update.md) | Daily DMF refresh flow for the security MCP |
| [PowerAutomate — OTRS Extractor](PowerAutomate-OTRS-Extract.md) | Scheduled OTRS → wiki extraction flow |
| [MCP — Wiki Services](MCP-Wiki-Services.md) | MCP-client-facing reference for the multi-wiki platform |
| [VS Code Guide](VS-Code-Guide.md) | VS Code setup, debugging, workflow, extensions |
| [README](../README.md) | Project overview and quick start |
