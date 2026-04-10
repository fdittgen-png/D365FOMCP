# PowerAutomate: MCP Service Database Provisioning

Reference guide for the PowerAutomate administrator responsible for provisioning and refreshing the databases behind the D365FO MCP services.

## MCP Service Databases — Provisioning Overview

The MCP platform exposes 4 services, backed by 3 SQLite databases plus 1 stateless parser. Only the **Security database** is provisioned via PowerAutomate today; the other databases are built out-of-band (dev machine / pipeline) because their sources (AOT metadata, xref index) are only available on a D365 dev environment.

| Service | Database | Size | Refresh source | PowerAutomate responsibility |
|---------|----------|------|----------------|-----------------------------|
| **d365sec** | `d365fo_sec.sqlite` | ~60 MB | DMF export from D365 PROD (+ AOT zip, rarely) | **Yes** — daily DMF refresh via async build API (this doc) |
| **d365kb** | `d365fo_kb.sqlite` | ~1 GB | D365 metadata / AOT / docs | No — built on dev machine via `npm run build:kb`, uploaded via deployment |
| **d365xref** | `d365fo_xref.sqlite` | ~3.3 GB | D365 cross-reference index | No — built on dev machine via `npm run build:xref`, uploaded via deployment |
| **d365taskrecorder** | *(none)* | — | User-supplied task recording XML | No — parses files on request, no database |

> **In scope for PowerAutomate:** daily refresh of the Security database. KB and XRef databases are refreshed only when D365 metadata changes meaningfully, and that process is owned by the development team, not PowerAutomate.

## Security Database Update — Overview

The MCP Security service at `https://tis-d-mcpd365fo-func.azurewebsites.net` exposes an async build API supporting **two flows**:

| Flow | What it updates | Frequency | Source |
|------|----------------|-----------|--------|
| **Flow A — DMF update** | Roles, users, role-duties, sub-roles, company scoping, custom duties | Daily / on demand | DMF export from D365 |
| **Flow B — AOT update** | Privileges, privilege entry points (CRUD), AOT duties, direct duty-privilege | Rare (after code deploys) | AOT XMLs from PackagesLocalDirectory |

**Both flows use the same `/upload/build` endpoint.** The function detects what's in the uploaded zip:

- **DMF only** → merges DMF tables into existing AOT (preserves privileges + entry points + 34M effective duty-privileges)
- **AOT only** → merges AOT tables into existing DMF (preserves runtime user/role state)
- **Both** → full rebuild

This means PowerAutomate uses **one identical pattern** for both update types — just the source content differs.

**Two integration patterns (same for Flow A and Flow B):**

| Pattern | When to use | Steps |
|---------|-------------|-------|
| **Source URL** (recommended) | Zip URL is accessible from Azure | 2 HTTP actions + polling loop |
| **Blob Upload** | File needs to be relayed | 3 HTTP actions + polling loop |

## Prerequisites

### D365 DMF Data Export Project — `secMCP_Repository`

The DMF export project used by this flow is named **`secMCP_Repository`** in D365 F&O Data Management. PowerAutomate references this project by name in the `definitionGroupId` field when triggering the export (see Step 1 below).

The project contains the following entities:

| Entity | File name | Required | Size |
|--------|-----------|----------|------|
| System Security Role | `System Security Role.xml` | Yes | ~150 KB |
| System Security Sub Role V2 | `System Security Sub Role V2.xml` | Yes | ~100 KB |
| System Security Role Duty | `System Security Role Duty.xml` | Yes | ~4 MB |
| System Security User Role | `SystemSecurityUserRoleEntity.xml` | Recommended | ~3 MB |
| System Security User Role Organization | `SystemSecurityUserRoleOrganizationEntity.xml` | Recommended | ~4 MB |
| User Information | `User information.xml` | Recommended | ~1.5 MB |

> **Do NOT include** the "System Security Duty" entity — it produces a 27+ GB file due to denormalization. Duty-to-privilege mappings come from the AOT metadata (loaded once during initial setup).

Total export size: **~15 MB** (zipped: ~3 MB).

> **Ownership:** The `secMCP_Repository` data project is maintained by the D365 development team (Eugene). If entities need to be added or removed, open a change request — do not modify the project definition directly from PowerAutomate.

## Pattern A: Source URL (Recommended)

Use this when the D365 DMF export produces a download URL accessible from Azure.

### Flow Design

```
┌─────────────────────────────────────────────────────┐
│  Trigger: Recurrence (e.g. daily) or manual         │
├─────────────────────────────────────────────────────┤
│  1. D365: Export data package                       │
│     → Get download URL                              │
├─────────────────────────────────────────────────────┤
│  2. HTTP: POST /api/d365sec/upload/build            │
│     Body: { "source_url": "<download URL>" }        │
│     → Get job_id                                    │
├─────────────────────────────────────────────────────┤
│  3. Do Until: status = "completed" or "failed"      │
│     │  HTTP: GET /api/d365sec/upload/status          │
│     │        ?job_id=<job_id>                        │
│     │  Wait: 30 seconds                              │
│     └────────────────────────────────────────────────│
├─────────────────────────────────────────────────────┤
│  4. Condition: if status = "failed"                 │
│     → Send notification (Teams/email)               │
└─────────────────────────────────────────────────────┘
```

### Step-by-step Configuration

#### Step 1: Export Data Package from D365

Use the **D365 F&O connector** or **HTTP action** to trigger the DMF export:

**Action:** HTTP  
**Method:** `POST`  
**URI:** `https://<your-d365-environment>.operations.dynamics.com/data/DataManagementDefinitionGroups/Microsoft.Dynamics.DataEntities.ExportToPackage`  
**Headers:**
```
Content-Type: application/json
```
**Body:**
```json
{
  "definitionGroupId": "secMCP_Repository",
  "packageName": "SecurityExport_@{utcNow('yyyyMMdd')}",
  "executionId": "",
  "reRunFailed": false,
  "legalEntityId": "DAT"
}
```

Then poll the execution status and call `GetExportedPackageUrl` to get the download URL:

**Action:** HTTP  
**Method:** `POST`  
**URI:** `https://<your-d365-environment>.operations.dynamics.com/data/DataManagementDefinitionGroups/Microsoft.Dynamics.DataEntities.GetExportedPackageUrl`  
**Body:**
```json
{
  "executionId": "<executionId from export>"
}
```

**Response** contains a `value` field with the download URL (Azure Blob SAS URL, valid for ~24 hours).

#### Step 2: Trigger Security Database Build

**Action:** HTTP  
**Method:** `POST`  
**URI:** `https://tis-d-mcpd365fo-func.azurewebsites.net/api/d365sec/upload/build`  
**Headers:**
```
Content-Type: application/json
```
**Body:**
```json
{
  "source_url": "@{body('GetExportedPackageUrl')?['value']}"
}
```

**Response (202 Accepted):**
```json
{
  "job_id": "2c70505b",
  "status": "accepted",
  "status_url": "/api/d365sec/upload/status?job_id=2c70505b",
  "message": "Build started. Poll the status_url for progress."
}
```

Save `job_id` from the response for polling.

#### Step 3: Poll for Completion

**Action:** Do Until  
**Condition:** `status` is equal to `completed` OR `status` is equal to `failed`  
**Limit:** Count = 60, Timeout = PT30M

Inside the loop:

**Action:** HTTP  
**Method:** `GET`  
**URI:** `https://tis-d-mcpd365fo-func.azurewebsites.net/api/d365sec/upload/status?job_id=@{body('TriggerBuild')?['job_id']}`

**Action:** Delay — 30 seconds

**Response when building:**
```json
{
  "job_id": "2c70505b",
  "status": "building",
  "progress": "[2/5] Parsing DMF exports from PROD...",
  "created_at": "2026-04-09T16:29:45Z",
  "updated_at": "2026-04-09T16:29:47Z"
}
```

**Response when completed:**
```json
{
  "job_id": "2c70505b",
  "status": "completed",
  "progress": "Done",
  "result": {
    "counts": {
      "roles": 390,
      "duties": 2604,
      "privileges": 6403,
      "entryPoints": 20442,
      "users": 829,
      "userRoles": 7867,
      "companies": 36,
      "subRoles": 317,
      "roleDuties": 11966,
      "dutyPrivileges": 6300
    },
    "elapsed": "1.9s",
    "fileSize": "5.4 MB"
  }
}
```

#### Step 4: Handle Errors

If `status` = `"failed"`, the response includes an `error` field:

```json
{
  "job_id": "2c70505b",
  "status": "failed",
  "error": "Download failed: 403 Forbidden"
}
```

Add a Condition action to check and send a notification (Teams, email) on failure.

## Pattern B: Blob Upload

Use this when the D365 export URL is not directly accessible from Azure (e.g. you need to relay the file through PowerAutomate).

### Additional Step: Get SAS Upload URL

Before triggering the build, request a SAS upload URL:

**Action:** HTTP  
**Method:** `GET`  
**URI:** `https://tis-d-mcpd365fo-func.azurewebsites.net/api/d365sec/upload/sas?filename=dmf-export.zip`

**Response:**
```json
{
  "job_id": "abc123",
  "upload_url": "https://tisdmcpd365fost.blob.core.windows.net/secbuild-uploads/abc123/dmf-export.zip?sv=...",
  "blob_name": "abc123/dmf-export.zip",
  "expires_in": 3600
}
```

### Upload the File to Blob

**Action:** HTTP  
**Method:** `PUT`  
**URI:** `@{body('GetSAS')?['upload_url']}`  
**Headers:**
```
x-ms-blob-type: BlockBlob
Content-Type: application/zip
```
**Body:** The ZIP file content (from D365 export or file connector)

### Trigger Build with Job ID

**Action:** HTTP  
**Method:** `POST`  
**URI:** `https://tis-d-mcpd365fo-func.azurewebsites.net/api/d365sec/upload/build`  
**Body:**
```json
{
  "job_id": "@{body('GetSAS')?['job_id']}"
}
```

Then poll `/status` the same as Pattern A.

---

## Flow B: AOT Update (after D365 code deployment)

When new code is deployed (new privileges, custom duties, security customizations), the AOT data needs to be refreshed. AOT data only changes with code deployments and is independent of runtime DMF state.

### One-Time Setup: Extract AOT Security XMLs

On a D365 dev machine, run the extraction script. By default it walks **two source directories** simultaneously to combine Microsoft standard models and customizations/ISVs:

```powershell
# From the MCP project directory — uses both default sources
.\scripts\Extract-AotSecurity.ps1
```

The defaults are:
- `C:\Workspace\DEV\Metadata` — Trelleborg customizations and ISV modules (X++ dev workspace)
- `%LOCALAPPDATA%\Microsoft\Dynamics365\10.0.2263.202\PackagesLocalDirectory` — Microsoft standard models

Override with `-SourcePaths` to use different directories:

```powershell
.\scripts\Extract-AotSecurity.ps1 -SourcePaths `
  "C:\Workspace\DEV\Metadata", `
  "C:\AOSService\PackagesLocalDirectory"
```

This produces a small zip (~50–150 MB) containing:
- `AxSecurityRole/*.xml` — role definitions (Microsoft + Trelleborg combined)
- `AxSecurityDuty/*.xml` — duty definitions with direct privilege assignments
- `AxSecurityPrivilege/*.xml` — privilege definitions with entry points + CRUD
- `AxLabelFile/*en-US*.label.txt` — label resolution

Files from each source are namespaced with a prefix (`custom__` and `standard__`) to prevent collisions when the same module exists in both locations.

Default output: `%USERPROFILE%\Downloads\d365fo-aot-security.zip`

### Storing the AOT Zip for PowerAutomate

PowerAutomate needs a URL it can fetch. Options:

1. **Azure Blob Storage** (recommended): Upload the zip after each code deploy. Use a SAS URL with read permissions.
2. **Azure DevOps build artifact**: Run `Extract-AotSecurity.ps1` as a pipeline step on a build agent that has access to the deployment package's `PackagesLocalDirectory`.
3. **GitHub release**: Tag releases with the zip attached.

### PowerAutomate Flow B (Identical Pattern to Flow A)

PowerAutomate triggers the build with the AOT zip URL. Same endpoint, same response handling:

```
┌─────────────────────────────────────────────────────┐
│  Trigger: After D365 code deployment                │
│           (manual / DevOps webhook)                 │
├─────────────────────────────────────────────────────┤
│  1. Get AOT zip URL                                 │
│     - From Blob Storage SAS URL, OR                 │
│     - From DevOps artifact download URL             │
├─────────────────────────────────────────────────────┤
│  2. HTTP: POST /api/d365sec/upload/build            │
│     Body: { "source_url": "<aot zip url>" }         │
│     → Get job_id                                    │
├─────────────────────────────────────────────────────┤
│  3. Do Until: status = "completed" or "failed"      │
│     │  HTTP: GET /api/d365sec/upload/status          │
│     │  Wait: 30 seconds                              │
└─────────────────────────────────────────────────────┘
```

**The function automatically detects the AOT zip** and uses merge mode `merged (AOT into existing DMF)`. This:

- **Replaces** AOT-sourced tables: `privileges`, `privilege_entry_points`, `role_direct_privileges`, `role_direct_entity_permissions`
- **Adds new** AOT duties (without removing custom DMF duties)
- **Preserves** all DMF runtime state: roles, users, role-duties, sub-roles, company scoping, the 34M effective duty-privileges

### Recommended Schedule

- **Flow A (DMF):** Daily at 02:00 UTC
- **Flow B (AOT):** After each D365 code deployment (manual trigger or DevOps webhook)

Run Flow A after Flow B to refresh effective duty-privilege mappings if the deployment introduced new privileges.

---

## API Reference

### POST /api/d365sec/upload/build

Triggers an async security database build.

**Request body (JSON):**

| Field | Type | Description |
|-------|------|-------------|
| `source_url` | string | Direct download URL for the DMF export ZIP. The server downloads it. |
| `job_id` | string | Job ID from `/sas` endpoint (when using blob upload pattern). |

Provide either `source_url` OR `job_id`, not both.

**Response:** `202 Accepted`
```json
{
  "job_id": "string",
  "status": "accepted",
  "status_url": "string",
  "message": "string"
}
```

**Errors:**
- `400` — Missing required fields
- `409` — Build already in progress

### GET /api/d365sec/upload/sas

Generates a SAS upload URL for direct browser/client blob upload.

**Query parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `filename` | string | `export.zip` | Name for the uploaded blob |

**Response:** `200 OK`
```json
{
  "job_id": "string",
  "upload_url": "string (SAS URL, valid 1 hour)",
  "blob_name": "string",
  "expires_in": 3600
}
```

### GET /api/d365sec/upload/status

Poll the status of an async build job.

**Query parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `job_id` | string | Job ID from `/build` or `/sas` response |

**Response:** `200 OK`

| Field | Type | Present when |
|-------|------|-------------|
| `job_id` | string | Always |
| `status` | string | Always — `pending`, `downloading`, `extracting`, `building`, `completed`, `failed` |
| `progress` | string | Always — human-readable progress message |
| `created_at` | string | Always — ISO 8601 timestamp |
| `updated_at` | string | Always — ISO 8601 timestamp |
| `result` | object | `completed` — contains `counts`, `elapsed`, `fileSize` |
| `error` | string | `failed` — error message |

**Errors:**
- `404` — Job not found (expired or unknown ID)

## Job Lifecycle

```
pending → downloading → extracting → building → completed
                                              → failed
```

Jobs are kept in memory for 2 hours, then automatically cleaned up. Only one build can run at a time — concurrent requests return `409 Conflict`.

## Scheduling

Recommended schedule: **daily** or **after security configuration changes** (role assignments, new users, etc.).

Example recurrence trigger: Every day at 02:00 UTC (low-activity period).

## Troubleshooting

| Error | Cause | Fix |
|-------|-------|-----|
| `409 Build already in progress` | Previous build still running | Wait and retry, or check `/status` for the active job |
| `Download failed: 403 Forbidden` | Source URL requires authentication | Use Pattern B (blob upload) instead of source_url |
| `Download failed: 404 Not Found` | D365 export URL expired | D365 package URLs expire after ~24 hours — trigger build immediately after export |
| `No recognized DMF XML files found` | ZIP doesn't contain expected entity files | Verify DMF export project includes the required entities |
| `ENOENT` / file errors | Azure CIFS mount timing issue | Retry — the builder handles this automatically |
