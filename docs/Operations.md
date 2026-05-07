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

## 4. Related documentation

| Document | Description |
|----------|-------------|
| [Administration](Administration.md) | Build, deploy, maintenance procedures |
| [Architecture](Architecture.md) | System design, security model, data flow |
| [Implementation](Implementation.md) | Build pipeline, schemas, tool catalog |
