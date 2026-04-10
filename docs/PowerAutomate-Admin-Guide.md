# PowerAutomate Admin Guide — D365FO MCP Security Service

**Audience:** Azure & PowerAutomate administrators responsible for **deploying, configuring, and operating** the D365FO MCP Security service and its scheduled refresh.

This guide covers the **infrastructure, deployment, and connection setup**. For the actual flow logic and API contract, see [PowerAutomate-SecDatabase-Update.md](./PowerAutomate-SecDatabase-Update.md).

---

## 1. Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│  Azure Subscription: TIS.D365FO                                  │
│  Resource Group: tis-{d|p}-mcpd365fo-rg                          │
├──────────────────────────────────────────────────────────────────┤
│  Function App: tis-{d|p}-mcpd365fo-func                          │
│   ├── Linux App Service Plan (B2 dev / P1v2 prod)                │
│   ├── Node.js 20 runtime                                         │
│   ├── HTTP endpoints:                                            │
│   │     /api/d365sec              (MCP server)                   │
│   │     /api/d365sec/upload       (Web form + sync upload)       │
│   │     /api/d365sec/upload/sas   (Get SAS upload URL)           │
│   │     /api/d365sec/upload/build (Trigger async build)          │
│   │     /api/d365sec/upload/status (Poll job status)             │
│   └── Persistent storage: /home/data/d365fo_sec.sqlite (~6 GB)   │
│                                                                  │
│  Storage Account: tis{d|p}mcpd365fost                            │
│   ├── Function runtime storage (AzureWebJobsStorage)             │
│   └── Blob container: secbuild-uploads (auto-created)            │
│         (used for large file uploads via SAS)                    │
└──────────────────────────────────────────────────────────────────┘
                              ▲
                              │ HTTPS
                              │
┌──────────────────────────────────────────────────────────────────┐
│  PowerAutomate (Power Platform Environment)                      │
│   ├── Recurrence trigger (daily 02:00 UTC)                       │
│   ├── HTTP action → D365 DMF export (secMCP_Repository)          │
│   ├── HTTP action → /api/d365sec/upload/build { source_url }     │
│   └── Do Until → poll /upload/status until completed             │
└──────────────────────────────────────────────────────────────────┘
                              ▲
                              │ REST
                              │
┌──────────────────────────────────────────────────────────────────┐
│  D365 F&O Environment (PROD)                                     │
│   └── DMF Data Project: secMCP_Repository                        │
│       (security entities — owned by Eugene)                      │
└──────────────────────────────────────────────────────────────────┘
```

---

## 2. Prerequisites

### 2.1 Azure roles

| Role | Scope | Required for |
|------|-------|-------------|
| **Owner** or **Contributor** | Resource Group `tis-d-mcpd365fo-rg` | Deploy/restart Function App, upload database via Kudu |
| **Storage Blob Data Contributor** | Storage Account `tisdmcpd365fost` | (Future) direct blob CORS / lifecycle rule changes |
| **Reader** (managed identity) | Resource Group | RBAC check during HTML form uploads (optional Easy Auth) |

### 2.2 Local tools

| Tool | Version | Purpose |
|------|---------|---------|
| Azure CLI | ≥ 2.50 | Auth, function restart, SCM credentials |
| PowerShell | 5.1 or 7+ | Run `Deploy-SecService.ps1` |
| Node.js | ≥ 20 LTS | npm install during deployment |
| Git | any | Clone the repo |

### 2.3 D365 prerequisites

| Item | Owner | Notes |
|------|-------|-------|
| DMF Data Project `secMCP_Repository` | Eugene (X++ team) | Contains the security entities exported daily |
| D365 service principal | TIS IAM | App registration with `ODataReadAccess` on D365 API |
| D365 environment URL | — | e.g. `https://tis-prod.operations.dynamics.com` |

---

## 3. Deploying the MCP Service Code

### 3.1 First-time deployment

The repo's deployment script handles code packaging, npm install (with Linux binary cross-compile for `better-sqlite3`), zip deployment, and post-deploy validation.

```powershell
# From the repo root
git clone <repo>
cd MCP
npm install

# Deploy to dev (code only, skip DB upload)
.\scripts\Deploy-SecService.ps1 -Environment d -SkipDbUpload

# Deploy to prod
.\scripts\Deploy-SecService.ps1 -Environment p -SkipDbUpload
```

The script:
1. Logs in via `az login` if needed
2. Verifies the Function App exists in the target subscription
3. Builds a deployment package (`.deploy-sec.zip`, ~14 MB)
4. Cross-installs the Linux x64 binary for `better-sqlite3` (required because the dev machine is Windows but the runtime is Linux)
5. Pushes via `az functionapp deployment source config-zip`
6. Restarts the Function App
7. Validates `/api/d365kb`, `/api/d365xref`, `/api/d365sec`, `/api/d365sec/upload`, `/api/d365taskrecorder/upload`

### 3.2 Code-only updates (typical day-to-day)

```powershell
.\scripts\Deploy-SecService.ps1 -Environment d -SkipDbUpload
```

This pushes only the JavaScript code without touching the database.

### 3.3 Database-only updates (one-off)

```powershell
.\scripts\Deploy-SecService.ps1 -Environment d -SkipCodeDeploy `
  -SecDbPath "C:\path\to\d365fo_sec.sqlite"
```

This uploads the SQLite file to `/home/data/d365fo_sec.sqlite` via Kudu VFS API. Used after rebuilding the database locally with full AOT data.

---

## 4. Configuring the Database

The Security database can be initialized in three ways. Choose **one** for the first build, then use PowerAutomate for ongoing refreshes.

### 4.1 Option A — Build locally and upload (one-time bootstrap)

On a D365 dev machine with access to both the customizations workspace and the PackagesLocalDirectory:

```powershell
# Build the full database (AOT + DMF) — combine customizations + standard models
node build/build-sec.js `
  "C:\Workspace\DEV\Metadata,C:\Users\<you>\AppData\Local\Microsoft\Dynamics365\10.0.2263.202\PackagesLocalDirectory" `
  "C:\path\to\dmf-extract" `
  "C:\Users\<you>\.claude\d365fo_sec.sqlite"

# Upload to Azure
.\scripts\Deploy-SecService.ps1 -Environment d -SkipCodeDeploy
```

Or, for AOT-only updates after a code deployment, use the dedicated extraction helper that walks both source paths automatically:

```powershell
# Extract just the AOT security XMLs from the dev workspace + standard models
.\scripts\Extract-AotSecurity.ps1
# → produces %USERPROFILE%\Downloads\d365fo-aot-security.zip
# Then upload via the web form or async API (Flow B)
```

### 4.2 Option B — Upload via the web form

1. Navigate to `https://tis-d-mcpd365fo-func.azurewebsites.net/api/d365sec/upload`
2. Drag a DMF zip onto the drop zone (or paste a download URL)
3. Files >150 MB automatically use the async blob path; smaller files use the sync path
4. The result panel shows the merge mode and final counts

### 4.3 Option C — PowerAutomate (production-grade refresh)

See section 5.

---

## 5. PowerAutomate Setup

### 5.1 Required connections

In the Power Platform Environment that will host the flow, create these connections:

| Connector | Purpose | Auth |
|-----------|---------|------|
| **HTTP** | Call MCP service `/upload/build` and `/upload/status` | None (anonymous) |
| **HTTP with Microsoft Entra ID** | (Optional, if you enable Easy Auth on the Function App) Call the MCP service with token | Service principal |
| **Fin & Ops Apps (Dynamics 365)** | Trigger DMF export from D365 | Service principal with `ODataReadAccess` |
| **Office 365 Outlook** or **Teams** | Failure notifications | User or service account |

### 5.2 Service principal for D365 access

```bash
# Create app registration
az ad app create --display-name "PowerAutomate-MCP-SecRefresh"
APP_ID=$(az ad app list --display-name "PowerAutomate-MCP-SecRefresh" --query "[0].appId" -o tsv)

# Create service principal
az ad sp create --id $APP_ID

# Generate client secret (save it — used in PowerAutomate connection)
az ad app credential reset --id $APP_ID --years 2
```

In D365 F&O:
1. **System administration → Setup → Azure Active Directory applications**
2. Add a new entry with the App ID, name, and User ID `MCP_REFRESH`
3. The user `MCP_REFRESH` must have at minimum the **Data management** role (to trigger DMF export)

### 5.3 Importing the flow

A starter flow definition is available at `flows/SecDatabaseRefresh.zip` (TBD — see section 8 for the JSON template). Import it via:

1. Power Platform admin center → your environment → **Solutions** → **Import solution**
2. Select `SecDatabaseRefresh.zip`
3. Configure connections when prompted (HTTP, D365, Notifications)
4. After import, open the flow and update:
   - **D365 environment URL** in the export action
   - **MCP service URL** (dev vs prod) in the build/status actions
   - **Notification recipients**
5. Turn the flow on

### 5.4 Testing the flow

1. Run the flow manually from the maker portal
2. Watch the run history — each step should be green
3. Total time: 2–5 minutes (D365 export + download + merge)
4. Verify the database was updated by visiting `/api/d365sec/upload` — the **Last updated** timestamp should be recent

---

## 6. Configuration Reference

### 6.1 Function App settings

Set these via **Function App → Configuration → Application settings**:

| Setting | Default | Purpose |
|---------|---------|---------|
| `WEBSITE_NODE_DEFAULT_VERSION` | `~20` | Node.js runtime version |
| `FUNCTIONS_WORKER_RUNTIME` | `node` | — |
| `KB_DB_PATH` | `/home/data/d365fo_kb.sqlite` | KB database location |
| `XREF_DB_PATH` | `/home/data/d365fo_xref.sqlite` | XRef database location |
| `SEC_DB_PATH` | `/home/data/d365fo_sec.sqlite` (default) | Security database location (only set if non-default) |
| `AzureWebJobsStorage` | (auto-created) | Storage connection string. Required for SAS blob uploads. |
| `WEBSITE_AUTH_ENABLED` | `False` | Set to `True` to enforce Easy Auth (recommended for prod) |

### 6.2 host.json (already in the repo)

```json
{
  "version": "2.0",
  "extensions": {
    "http": {
      "routePrefix": "api",
      "maxRequestBodySize": 2147483648
    }
  },
  "logging": {
    "applicationInsights": {
      "samplingSettings": { "isEnabled": true, "excludedTypes": "Request" }
    }
  }
}
```

The `maxRequestBodySize: 2147483648` (2 GB) allows large blob-relayed uploads through the platform front-end.

### 6.3 Storage Account CORS

For browser-direct blob uploads (HTML form async path), CORS must allow the Function App origin:

```bash
az storage cors add --account-name tisdmcpd365fost \
  --services b \
  --methods PUT \
  --origins "https://tis-d-mcpd365fo-func.azurewebsites.net" \
  --allowed-headers "*" \
  --exposed-headers "*" \
  --max-age 3600
```

Repeat for the prod origin (`tis-p-mcpd365fo-func.azurewebsites.net`).

---

## 7. Operations & Monitoring

### 7.1 Daily checks

- **Last build time** — visit `/api/d365sec/upload` and check the "Last updated" line
- **Flow run history** — Power Platform → Flows → run history (should show daily success)
- **App Insights** — function exceptions in the last 24 h

### 7.2 Restart the Function App

```bash
az functionapp restart \
  --resource-group tis-d-mcpd365fo-rg \
  --name tis-d-mcpd365fo-func
```

Cold start takes ~25 seconds.

### 7.3 Inspect the database without downloading

Use the MCP `sec_raw_sql` tool from any MCP client (Claude Code, Copilot Studio, curl):

```bash
curl -s -X POST "https://tis-d-mcpd365fo-func.azurewebsites.net/api/d365sec" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"sec_raw_sql","arguments":{"sql":"SELECT key, value FROM sec_metadata WHERE key IN ('"'"'build_date'"'"','"'"'roles'"'"','"'"'duties'"'"','"'"'users'"'"','"'"'dutyPrivileges'"'"')"}}}'
```

### 7.4 Manual database upload (recovery)

If the database is lost or corrupt, upload a known-good copy via Kudu VFS:

```bash
USER=$(az functionapp deployment list-publishing-credentials \
  --resource-group tis-d-mcpd365fo-rg \
  --name tis-d-mcpd365fo-func \
  --query "publishingUserName" -o tsv)
PASS=$(az functionapp deployment list-publishing-credentials \
  --resource-group tis-d-mcpd365fo-rg \
  --name tis-d-mcpd365fo-func \
  --query "publishingPassword" -o tsv)

curl -X PUT -u "$USER:$PASS" \
  "https://tis-d-mcpd365fo-func.scm.azurewebsites.net/api/vfs/data/d365fo_sec.sqlite" \
  -H "If-Match: *" \
  --data-binary @"C:/path/to/d365fo_sec.sqlite"

# Restart so the singleton reloads
az functionapp restart --resource-group tis-d-mcpd365fo-rg --name tis-d-mcpd365fo-func
```

A 6 GB upload typically takes ~50 seconds.

### 7.5 Application Insights queries

```kusto
// Failed function executions
requests
| where cloud_RoleName == "tis-d-mcpd365fo-func"
| where success == false
| where timestamp > ago(24h)
| project timestamp, name, resultCode, duration, operation_Id
| order by timestamp desc

// Sec database build durations
traces
| where cloud_RoleName == "tis-d-mcpd365fo-func"
| where message contains "Security Database Build Complete" or message contains "merged-dmf-into-aot"
| order by timestamp desc
| take 20
```

---

## 8. Sample PowerAutomate Flow JSON

A starter flow that runs daily and refreshes the security database. Save as `SecDatabaseRefresh.json`, import via Power Platform Admin Center.

```jsonc
{
  "definition": {
    "$schema": "https://schema.management.azure.com/schemas/2016-06-01/Microsoft.Logic.json",
    "actions": {
      "Trigger_DMF_Export": {
        "type": "OpenApiConnection",
        "inputs": {
          "host": { "connectionName": "shared_dynamicsax", "operationId": "ExecuteAction" },
          "parameters": {
            "instance": "https://tis-prod.operations.dynamics.com",
            "actionName": "Microsoft.Dynamics.DataEntities.ExportToPackage",
            "body": {
              "definitionGroupId": "secMCP_Repository",
              "packageName": "SecExport_@{utcNow('yyyyMMddHHmm')}",
              "executionId": "",
              "reRunFailed": false,
              "legalEntityId": "DAT"
            }
          }
        }
      },
      "Get_Export_URL": {
        "type": "OpenApiConnection",
        "runAfter": { "Trigger_DMF_Export": [ "Succeeded" ] },
        "inputs": {
          "host": { "connectionName": "shared_dynamicsax", "operationId": "ExecuteAction" },
          "parameters": {
            "actionName": "Microsoft.Dynamics.DataEntities.GetExportedPackageUrl",
            "body": { "executionId": "@body('Trigger_DMF_Export')" }
          }
        }
      },
      "Trigger_MCP_Build": {
        "type": "Http",
        "runAfter": { "Get_Export_URL": [ "Succeeded" ] },
        "inputs": {
          "method": "POST",
          "uri": "https://tis-d-mcpd365fo-func.azurewebsites.net/api/d365sec/upload/build",
          "headers": { "Content-Type": "application/json" },
          "body": { "source_url": "@body('Get_Export_URL')?['value']" }
        }
      },
      "Poll_Until_Done": {
        "type": "Until",
        "runAfter": { "Trigger_MCP_Build": [ "Succeeded" ] },
        "expression": "@or(equals(body('Get_Status')?['status'], 'completed'), equals(body('Get_Status')?['status'], 'failed'))",
        "limit": { "count": 60, "timeout": "PT30M" },
        "actions": {
          "Delay_30s": { "type": "Wait", "inputs": { "interval": { "count": 30, "unit": "Second" } } },
          "Get_Status": {
            "type": "Http",
            "runAfter": { "Delay_30s": [ "Succeeded" ] },
            "inputs": {
              "method": "GET",
              "uri": "https://tis-d-mcpd365fo-func.azurewebsites.net/api/d365sec/upload/status?job_id=@{body('Trigger_MCP_Build')?['job_id']}"
            }
          }
        }
      },
      "Notify_On_Failure": {
        "type": "If",
        "runAfter": { "Poll_Until_Done": [ "Succeeded" ] },
        "expression": { "equals": [ "@body('Get_Status')?['status']", "failed" ] },
        "actions": {
          "Send_Teams_Message": {
            "type": "OpenApiConnection",
            "inputs": {
              "host": { "connectionName": "shared_teams", "operationId": "PostMessageToChannel" },
              "parameters": {
                "groupId": "<your-teams-group>",
                "channelId": "<your-channel>",
                "messageBody": "Sec DB refresh failed: @{body('Get_Status')?['error']}"
              }
            }
          }
        }
      }
    },
    "triggers": {
      "Daily_At_2_UTC": {
        "type": "Recurrence",
        "recurrence": { "frequency": "Day", "interval": 1, "startTime": "2026-04-11T02:00:00Z" }
      }
    }
  }
}
```

---

## 9. Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Function returns 404 on all endpoints | Container failed to start (likely a JS module load error) | Check Application Insights for the load error; redeploy via `Deploy-SecService.ps1` |
| `/upload/build` returns `Build already in progress (status: pending)` | Stale SAS-issued job. Pending jobs auto-expire after 2 h | Wait, or trigger via `source_url` (skips the SAS step entirely) |
| `/upload/build` returns 409 with status `building` | A previous build is still running | Wait for it to complete (max 30 min) or check `/upload/status` |
| Build completes but `dutyPrivileges` count drops to 0 | Old code path that wiped AOT data on DMF-only upload | Code already fixed (commit `<git-sha>`); ensure latest deployment |
| `Last updated` timestamp doesn't change after PowerAutomate run | DMF export failed silently, or MCP build failed | Check flow run history, then `/upload/status` for the job ID |
| Browser shows `Unexpected token '<'` on form upload | Platform proxy returned an HTML error page (413 or 502) | For files >150 MB the form auto-uses the async path. Hard-refresh (Ctrl+F5) if cached. |
| Disk space issues during build | `/tmp` filled by extracted DMF files | The builder skips entries >500 MB automatically. Check `df -h /tmp` via Kudu shell. |

---

## 10. Security Checklist

- [ ] **Easy Auth enabled** on prod Function App (`WEBSITE_AUTH_ENABLED=True`)
- [ ] **Managed identity** configured with **Reader** on the resource group
- [ ] **Service principal** for PowerAutomate has minimal D365 roles (Data management only)
- [ ] **RBAC restricted** to Owner/Contributor for upload (Easy Auth + Azure AD groups)
- [ ] **Storage Account CORS** restricted to the Function App origins only (no wildcards)
- [ ] **Application Insights** retention set to 90 days
- [ ] **Diagnostic logs** sent to a Log Analytics workspace for the resource group
- [ ] **No secrets in source control** — D365 client secret stored only in PowerAutomate connection
- [ ] **Storage account network rules** — restrict to Azure trusted services + Function App outbound IPs

---

## 11. Related Documentation

- [PowerAutomate-SecDatabase-Update.md](./PowerAutomate-SecDatabase-Update.md) — flow logic and API contract
- [Copilot-Studio-Guide.md](./Copilot-Studio-Guide.md) — Copilot Studio agent configuration
- [Administration.md](./Administration.md) — general MCP service administration
- [Architecture.md](./Architecture.md) — overall MCP platform architecture
- [Design-D365Sec-MCP-Service.md](./Design-D365Sec-MCP-Service.md) — security service design doc

## 12. Contacts

| Role | Name | Responsibility |
|------|------|----------------|
| Service owner | Florian Dittgen | Architecture, deployment script, code |
| D365 dev (DMF project) | Eugene | `secMCP_Repository` data project, AOT extraction |
| Azure platform | TIS Cloud Ops | Function App, Storage, networking |
| Power Platform | TIS Power Platform team | PowerAutomate environment, connections, RBAC |
