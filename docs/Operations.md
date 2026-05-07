# Operations: D365FO MCP Services

**Project**: tis-p-mcpd365fo
**Owner**: Trelleborg IT Services (TIS)
**Status**: Current

Operational runbook complementing [Administration.md](Administration.md). This document captures runtime concerns — limits, quotas, monitoring thresholds — that operators need at hand when triaging incidents.

---

## 1. Upload size limits

### 1.1 Global Functions limit (`host.json`)

`host.json` declares `"maxRequestBodySize": 2147483648` (2 GB) globally. This is **intentional** and sized for the security database upload endpoint, which receives full DMF / AOT export ZIPs that can exceed 1 GB. The KB and XRef rebuild paths are server-side (build scripts → blob storage), not HTTP uploads.

Azure Functions does **not** support per-route body-size overrides in `host.json`. Tighter caps must be enforced inside the handler itself.

### 1.2 Per-endpoint overrides

| Endpoint | Limit | Enforced where |
|----------|-------|----------------|
| `POST /api/d365sec/upload` | 200 MB | `MAX_UPLOAD_BYTES` constant in `src/functions/d365sec-upload.js`; checked against `file.size` after multipart parse |
| `POST /api/d365taskrecorder/upload` | **10 MB** | `MAX_UPLOAD_BYTES` constant in `src/functions/d365taskrecorder.js`; **Content-Length pre-checked before the body is read into memory** (issue #43) |
| MCP JSON-RPC endpoints (`d365kb`, `d365xref`, `d365sec`, `d365taskrecorder` GET/POST without `/upload`) | inherits 2 GB global | (separate hardening tracked in issue #29) |

### 1.3 Sizing rationale

- Task Recorder recordings (`.axtr`) are XML-based screen captures, normally well under 1 MB. The 10 MB cap is generous enough to absorb pathological recordings but cheap enough to reject runaway uploads early.
- Security DB upload accepts the full DMF export ZIP — these legitimately reach hundreds of MB.

### 1.4 Hardening pattern

For any new upload endpoint, prefer the **Content-Length pre-check** pattern from `d365taskrecorder.js`:

```js
const sizeRejection = checkUploadSize(request.headers.get('content-length'));
if (sizeRejection) return sizeRejection;
// only now read the body
```

Reading the body first (`await request.formData()` / `await request.arrayBuffer()`) and checking size afterwards defeats the purpose — Azure Functions has already buffered the entire payload by then.

---

## 2. SQLite on Azure Functions

The three runtime databases (KB ~1 GB, XRef ~3.3 GB, Security ~30–60 MB) are SQLite files served by `better-sqlite3` from the Function App's `/home/data/` directory. This section documents why that arrangement is used, what its limits are, and which mitigations are in place.

### 2.1 Why `/home` (Azure Files SMB)

Linux Function Apps mount `/home` from an Azure Files share over SMB. We use it as the database location because:

- **Persistence across deployments.** A code-only deploy (`Deploy-FunctionApp.ps1`) replaces `/home/site/wwwroot` but leaves `/home/data/` intact, so a 3 GB XRef DB survives a code deploy without re-upload.
- **Shared across elastic workers.** All workers in a Premium plan see the same `/home` mount, so a single uploaded file is immediately visible to every instance — there is no per-worker copy step.
- **No external dependency.** The alternative — Azure SQL or hosted Cosmos — would add a managed service, a connection-string secret, network egress, and a per-query cost. SQLite-on-disk keeps the data path entirely inside the Function App.

The trade-off is performance: SMB is 2–5× slower than local SSD on small reads, and degrades further on large-file mmap.

### 2.2 Cold-start latency

Opening and memory-mapping a SQLite file over SMB is a best-effort, not-instantaneous operation. Expected ranges, observed during Function App restarts:

| Database | File size | Cold-open latency (typical) |
|----------|-----------|-----------------------------|
| Sec | 30–60 MB | < 1 s |
| KB | ~1 GB | 5–10 s |
| XRef | ~3.3 GB | **15–30 s** |

The first request after a restart pays this cost. Subsequent requests on the same worker are warm and serve from the OS page cache.

### 2.3 Mitigations in place

The following are applied at DB-open time in `src/azure/shared.js` (`openDb()`):

| Pragma | Value | Rationale |
|--------|-------|-----------|
| `journal_mode` | `OFF` | DB is opened read-only; we never write a rollback journal, so there is nothing to flush. Cuts open-time SMB round-trips. |
| `cache_size` | `-50000` | 50 MB per-connection page cache (negative = KB). Hot rows stay resident, avoiding repeated SMB reads. |
| `mmap_size` | KB **1.1 GB**, XRef **3 GB**, Sec **64 MB** | Maps the whole file (or close to it) into the worker's virtual address space so SQLite can read pages with `memcpy()` instead of `pread()`. The OS handles paging from SMB transparently. Values are sized per-DB in `getKbDb()` / `getXrefDb()` / `getSecDb()`. |
| `busy_timeout` | `30000` (30 s) | Bounds lock-contention waits when multiple readers hit a write-protected file (issue #50). Prevents instantaneous `SQLITE_BUSY` failures during the brief window of a swap. |

Additional structural mitigations:

- **Read-only handles.** Every singleton in `shared.js` opens with `{ readonly: true }`. Writes are confined to the offline build pipeline and the `/api/d365sec/upload` reload path.
- **Connection singletons.** `getKbDb()` / `getXrefDb()` / `getSecDb()` cache one handle per worker process; the cold-open cost is paid once, not per request.
- **Sec DB perf indexes.** 14 indexes are created at build time in `src/azure/sec-builder.js` covering the hot security-traversal paths (`role_duties.duty_id`, `duty_privileges.privilege_name`, `user_roles.role_id`, `privilege_entry_points.object_name`, etc.). These are what make `sec_permission_trace` and `sec_effective_permissions` viable on a networked-storage backend.

### 2.4 Known weak spots

These are accepted limits, not bugs — operators should know about them when triaging.

- **Cold start after restart.** The first XRef query after `func restart` or after an idle scale-in waits the full 15–30 s for the mmap window to populate. Health-check probes that hit `d365xref` immediately after restart will time out.
- **Multi-worker contention on mmap.** When the Premium plan scales out and a second worker spins up, both workers mmap the same SMB file. They do not share the OS page cache, so the second worker repeats the cold-open cost. Each worker's cache also re-warms independently.
- **No write coordination across workers.** The security DB upload path (`/api/d365sec/upload`) reloads the singleton on the worker that handled the request. Other workers continue to serve the previous file until their next process restart. This is acceptable today (uploads are infrequent and operators can issue a `func restart`), but it is a real consistency gap that does not exist with a hosted database.
- **`SQLITE_IOERR_SHMLOCK` / `SHMMAP` on SMB.** SQLite's WAL coordination files (`.shm`) are not reliable on SMB; this is why the read path uses `journal_mode = OFF` and the build path drops back to `journal_mode = DELETE` on the upload server. Do **not** enable WAL on a `/home`-resident DB.

### 2.5 Pending / future work

- **KB and XRef index review.** The KB and XRef builders create the obvious lookup indexes (table-name, module-id, refs source/target — see `build/build-kb.js` and `build/build-xref-db.js`), but no systematic query-plan audit has been done against the live workload. If a particular tool is observed to be slow in App Insights, profile it with `EXPLAIN QUERY PLAN` and add a covering index in the relevant builder.
- **`temp_store = MEMORY`.** SQLite spills temporary B-trees (e.g. `ORDER BY` on un-indexed columns, `DISTINCT`, sub-selects) to disk by default. On `/home` that disk is SMB. Setting `temp_store = MEMORY` in `openDb()` would force temp tables into the connection's cache instead. Worth measuring on XRef raw-SQL queries; not yet applied.
- **Per-request DB context.** Today every handler reaches into the module-level singleton via `getKbDb()` / `getSecDb()` / etc. A reload triggered mid-request (security upload finishes while a read is in flight) can in principle swap the handle underneath the running query. A `DatabaseContext.snapshot()` pattern that captures the three handles at the start of each invocation would isolate the read from concurrent reloads. Tracked separately.

### 2.6 What this section does **not** claim

- **No formal benchmark.** The cold-start latencies in §2.2 are observational from App Insights traces, not a controlled benchmark. They are a reasonable expectation, not a contractual SLO.
- **No automated alarm on cold-start latency.** App Insights surfaces per-request duration; there is no specific alert on "first XRef query after restart took > 30 s."
- **CI/CD pipeline caching is moot.** Issue #24 originally called for caching `node_modules` in a build pipeline. There is no CI/CD pipeline today — deploys are launched manually from the operator's workstation via `Deploy-FunctionApp.ps1`. Caching there would require introducing a pipeline first, which is out of scope.

---

## 3. Region alignment

### 3.1 Current state

| Environment | Azure region | Source |
|-------------|--------------|--------|
| Dev | `northeurope` | `infra/dev.parameters.json` |
| Prod | `westeurope` | `infra/parameters.prod.json` |

These are **not** aligned. The split is a historical artefact — dev was provisioned in `northeurope` first and prod was later created in `westeurope` to match Trelleborg's primary D365 footprint. There is no documented technical reason for the difference today.

### 3.2 Why this matters

The MCP services do not call D365 at runtime — they read pre-built SQLite snapshots. So the region split does **not** add request-path latency between the MCP and D365.

It does affect:

- **Database upload path.** The security DB upload (`/api/d365sec/upload`) is invoked from a Power Automate flow that may itself be co-located with D365. A cross-region call adds ~10–30 ms per round-trip and a small egress cost. Negligible per upload, but unnecessary.
- **Operator round-trips.** Build artefacts uploaded from a Trelleborg engineer's workstation traverse different network paths to dev vs prod, which complicates "is the network slow today?" diagnostics.
- **Disaster-recovery posture.** A regional outage in `westeurope` would knock prod offline while dev remains reachable. That is accidentally a feature today, but it is not a designed DR strategy.

### 3.3 Recommendation

Align both environments to the region of the primary D365 environment they serve — currently `westeurope`. Concretely:

- [ ] Confirm that the production D365FO environments served by this MCP are in `westeurope` (TIS to verify with the D365 operations team).
- [ ] When the dev Function App is next rebuilt, redeploy it into `westeurope` by changing `infra/dev.parameters.json` `location` to `westeurope` and re-running `Deploy-Infrastructure.ps1`.
- [ ] If a future cross-region DR strategy is desired, treat it as an explicit design choice (paired regions, geo-redundant storage, traffic manager) rather than relying on the current accidental dev/prod split.

This is **not** an emergency — the current split is functional. Treat it as cleanup to do at the next convenient infrastructure rebuild.

---

## 4. Storage cost expectations

### 4.1 Steady-state monthly cost (production, west europe)

The workload runs in a single resource group (`tis-p-mcpd365fo-rg`) with the following cost structure. Figures are pay-as-you-go list prices, EUR, rounded to whole euros, and assume the steady-state usage pattern (no rebuild storms, no abnormal traffic).

| Component | SKU | Approx. monthly cost (EUR) | Notes |
|-----------|-----|----------------------------:|-------|
| Storage account (`tispmcpd365fost`) | Standard_LRS, StorageV2 | 5–15 | Hosts the SQLite DBs (`d365fo_kb.sqlite` ~1 GB, `d365fo_xref.sqlite` ~3.3 GB, `d365fo_sec.sqlite` ~60 MB) plus `mcpsec-uploads/` ZIP staging (lifecycle-deleted after 7 days) |
| App Service Plan | P0v3 Linux, 1 instance, alwaysOn | ~75 | Largest single line item — fixed cost regardless of traffic |
| Function App | Consumption on the P0v3 plan | included in ASP | No separate metered cost while running on the dedicated plan |
| Log Analytics workspace | PerGB2018, 30-day retention | 1–5 | Volume scales with App Insights ingestion |
| Application Insights | Workspace-based | included in Log Analytics | Telemetry is routed into the same workspace |
| **Estimated total RG cost** | — | **~85–100 / month** | — |

The **storage account alone** is the cheapest line item (5–15 EUR/month) and is the only component the budget alert tracks. The 50 EUR default ceiling is intentionally well above the expected steady state — it leaves headroom for one bad month (e.g. a stuck `mcpsec-uploads/` lifecycle policy, an accidental retention bump, a runaway log export) without firing on every minor blip.

### 4.2 Budget alert configuration

A `Microsoft.Consumption/budgets` resource is provisioned at the resource-group scope (`infra/modules/costAlerts.bicep`) and filtered to `microsoft.storage/storageaccounts` so it tracks blob/table/queue/file spend only — not the App Service Plan, Function App, Log Analytics, or App Insights line items.

| Property | Value | Source |
|----------|-------|--------|
| Scope | resource group (`tis-{env}-mcpd365fo-rg`) | implicit from module deployment |
| Time grain | Monthly | hardcoded |
| Filter | `ResourceType In microsoft.storage/storageaccounts` | hardcoded |
| Amount | `monthlyBudgetAmount` parameter (default **50**) | `parameters.prod.json` / `--parameters` override |
| Notifications | 80 % Actual, 100 % Actual (or higher) | hardcoded |
| Recipients | `budgetContactEmails` parameter (required) | `--parameters` override at deploy time |

The currency follows the subscription billing currency (EUR for the Trelleborg west-europe subscription). Override `monthlyBudgetAmount` only when the steady-state cost shifts — for example after onboarding a fourth database, or if blob egress becomes a meaningful line item.

### 4.3 Recipient privacy

`budgetContactEmails` is **not** committed to any parameter file. Supply it at deploy time:

```powershell
az deployment sub create `
  --template-file infra/main.bicep `
  --parameters infra/parameters.prod.json `
  --parameters budgetContactEmails="['ops@example.com']" `
  --location westeurope
```

The parameter is required (`@minLength(1)`) — the deployment will fail closed if no recipients are supplied. This avoids the "alert fires into the void" failure mode.

### 4.4 Blob lifecycle

The storage account also runs a blob lifecycle policy on the `mcpsec-uploads/` container that deletes ZIP stagings after 7 days. This is configured separately in `functionApp.bicep` and is the only automated cleanup path — the SQLite databases themselves are pinned to `/home/data/` on the Function App's mounted file share, not in blob storage, and are rebuilt from source rather than backed up. There is no `/backups/` container in this workload.

---

## 5. Database snapshots and restore

The MCP databases are not authoritative — `Update-Databases.ps1` rebuilds them from D365 source (PackagesLocalDirectory + the XRef SQL Server + DMF exports). However, the rebuild can take an hour or more, and a bad build that has been deployed needs to be rolled back **fast**, not rebuilt. Snapshots cover that gap.

### 5.1 What is captured

After every successful build, `scripts/Backup-Databases.ps1` uploads the resulting `.sqlite` files to the Function App's storage account, container `mcpsec-snapshots`, with a dated blob name:

```
mcpsec-snapshots/d365fo_kb_2026-05-06-103412.sqlite
mcpsec-snapshots/d365fo_xref_2026-05-06-103412.sqlite
mcpsec-snapshots/d365fo_sec_2026-05-06-103412.sqlite
```

The script auto-runs at the end of `Update-Databases.ps1` when `-BackupEnvironment d|p` is passed. It can also be called standalone after any local build.

### 5.2 Retention

Two layers, defence-in-depth:

| Mechanism | Where defined | Behaviour |
|-----------|---------------|-----------|
| Per-DB count cap | `Backup-Databases.ps1` `-KeepCount` (default **5**) | After uploading a new snapshot, blobs matching `d365fo_<db>_*.sqlite` are sorted by modified-date descending and any beyond `KeepCount` are deleted. |
| Calendar lifecycle | `infra/modules/functionApp.bicep` (`managementPolicies/default`) | Any snapshot blob older than **90 days** is deleted by the platform. Catches snapshots the script's prune step missed (e.g., script aborted mid-run). |

The "last 5 snapshots" criterion from issue #37 is enforced by the script's count cap. The 90-day lifecycle is a calendar-based safety net — the platform's lifecycle engine cannot count blobs, only age them.

### 5.3 Restore procedure

When a deployed build is bad and you need to roll back to the previous snapshot. Examples below use the **dev** storage account `tisdmcpd365fost`; for prod substitute `tispmcpd365fost`.

1. **List snapshots for the affected database:**
   ```powershell
   az storage blob list `
       --account-name tisdmcpd365fost `
       --container-name mcpsec-snapshots `
       --prefix d365fo_sec_ `
       --auth-mode login `
       --query "sort_by([].{name:name,modified:properties.lastModified}, &modified) | reverse(@)" `
       -o table
   ```

2. **Download the desired snapshot to local disk:**
   ```powershell
   az storage blob download `
       --account-name tisdmcpd365fost `
       --container-name mcpsec-snapshots `
       --name d365fo_sec_2026-05-06-103412.sqlite `
       --file $env:USERPROFILE\.claude\d365fo_sec.sqlite `
       --auth-mode login
   ```
   This overwrites the local `.sqlite` so the next deploy uses the snapshot.

3. **Re-deploy the snapshot to the Function App** using either path:

   **Option A — Re-run `Deploy-Databases.ps1` (preferred):** It will pick up the file you just downloaded and push it via Kudu VFS to `/home/data/d365fo_sec.sqlite`, then restart the Function App.
   ```powershell
   .\scripts\Deploy-Databases.ps1 -Environment p -SecOnly
   ```

   **Option B — Manual Kudu VFS upload:** When the deploy script is unavailable, push directly:
   ```powershell
   $rg = 'tis-p-mcpd365fo-rg'
   $func = 'tis-p-mcpd365fo-func'
   $creds = az functionapp deployment list-publishing-credentials `
       --resource-group $rg --name $func -o json | ConvertFrom-Json
   $auth = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes(
       "$($creds.publishingUserName):$($creds.publishingPassword)"))
   Invoke-RestMethod `
       -Uri "https://$func.scm.azurewebsites.net/api/vfs/data/d365fo_sec.sqlite" `
       -Method PUT `
       -Headers @{ Authorization = "Basic $auth"; 'If-Match' = '*' } `
       -InFile $env:USERPROFILE\.claude\d365fo_sec.sqlite `
       -ContentType 'application/octet-stream'
   az functionapp restart --resource-group $rg --name $func
   ```

   **Option C — `sec-upload` endpoint:** Only the Sec database has an upload endpoint (`POST /api/d365sec/upload`); KB/XRef must use Kudu. See `src/functions/d365sec-upload.js`.

4. **Verify** by hitting the health endpoint and a known-good query:
   ```powershell
   Invoke-RestMethod "https://$func.azurewebsites.net/api/d365sec"
   ```

### 5.4 Container layout reference

| Container | Purpose | Lifecycle |
|-----------|---------|-----------|
| `mcpsec-snapshots` | Dated snapshots from successful builds (issue #37) | 90-day delete + 5-deep prune in script |
| `mcpsec-uploads` (if present) | Async DMF upload staging for `sec-upload` endpoint | per existing endpoint config |

---

## 6. Related documentation

| Document | Description |
|----------|-------------|
| [Administration](Administration.md) | Build, deploy, maintenance procedures |
| [Architecture](Architecture.md) | System design, security model, data flow |
| [Implementation](Implementation.md) | Build pipeline, schemas, tool catalog |
