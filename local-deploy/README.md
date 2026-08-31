# local-deploy/

**Local-only deployment scripts for D365FO MCP Services. Not git-tracked.**

A single self-contained PowerShell script (`Deploy.ps1`) that replaces the
multi-script flow in `scripts/Deploy-*.ps1`. Provisions infrastructure (optional),
packages the application, uploads the SQLite databases, assigns RBAC roles,
and health-checks every endpoint — in one call, with parallel uploads and
parallel health probes.

> **Why local-only?** This directory is gitignored. It exists so you can
> customize defaults (resource group, function-app name, database paths,
> budget contacts, environment) without polluting the repo or leaking
> internal naming. The original scripts in `scripts/` remain the source of
> truth for the public deployment recipe.

---

## 1. Prerequisites

### 1.1 Tooling

| Tool                | Version              | Verify                          |
|---------------------|----------------------|---------------------------------|
| PowerShell          | 7.0+ (`pwsh`)        | `$PSVersionTable.PSVersion`     |
| Azure CLI           | 2.50+                | `az --version`                  |
| Bicep (via az CLI)  | bundled              | `az bicep version`              |
| Node.js             | 20.x (matches Azure) | `node -v`                       |
| npm                 | 10.x+                | `npm -v`                        |
| `prebuild-install`  | bundled with `npx`   | `npx prebuild-install --help`   |
| ThreadJob module    | PS 7 built-in        | `Get-Module -ListAvailable ThreadJob` |

> Windows note: `robocopy` is used for source staging. It ships with Windows
> 10/11 — no extra install. On macOS/Linux, replace `robocopy` calls with
> `rsync` (the script will need a small port).

### 1.2 Azure access

| Need                                      | Why                                                        |
|-------------------------------------------|------------------------------------------------------------|
| Subscription **Contributor** on the RG    | Deploy infra + Function App, list publishing credentials   |
| **User Access Administrator** on the KV   | Assign Function App MI to *Key Vault Secrets User* (one-time) |
| Local SQLite databases built              | `npm run build:kb`, `build:xref`, `build:sec` ahead of time |
| Authenticated `az login`                  | Script auto-prompts if missing                             |

### 1.3 Local SQLite databases

Default lookup paths (override via `-KbDbPath`, `-XrefDbPath`, `-SecDbPath`):

| Variable | Default path                                          | Built by         | Approx. size |
|----------|-------------------------------------------------------|------------------|--------------|
| KB       | `%USERPROFILE%\.claude\d365fo_kb.sqlite`              | `npm run build:kb`   | ~1.0 GB      |
| XRef     | `%USERPROFILE%\.claude\d365fo_xref.sqlite`            | `npm run build:xref` | ~3.3 GB      |
| Sec      | `%USERPROFILE%\.claude\d365fo_sec.sqlite`             | `npm run build:sec`  | ~30–60 MB    |

Missing files are skipped silently (per database). At least one must exist
unless you pass `-SkipDb`.

### 1.4 Repository state

Run from the repo root or from `local-deploy/`. The script auto-detects
`package.json` from either location. It needs:

- `package.json` and `package-lock.json` at the project root
- `src/azure/`, `src/functions/`, `host.json`
- `infra/main-rg.bicep` (only when `-DeployInfra` is passed)
- `www/` and `config/` if present (copied if found)

---

## 2. Quickstart

### 2.1 Code-only refresh (most common — push the latest commit)

```powershell
# From repo root or local-deploy/
.\local-deploy\Deploy.ps1 -SkipDb -SkipRoles
```

Skips DB upload (slow) and role assignment (one-time). Validates with health
checks at the end.

### 2.2 Full deploy to default RG (code + databases + health checks)

```powershell
.\local-deploy\Deploy.ps1
```

Default `ResourceGroup` is `tis-d-mcpd365fo-rg`. Auto-discovers the Function
App. Uploads all three databases in parallel.

### 2.3 Custom resource group

```powershell
.\local-deploy\Deploy.ps1 -ResourceGroup my-mcp-rg
```

`Environment` is auto-derived from the RG name (`-d-` → dev, `-p-` → prod).

### 2.4 First-time provisioning of an empty RG

```powershell
.\local-deploy\Deploy.ps1 `
    -ResourceGroup my-new-mcp-rg `
    -DeployInfra `
    -BudgetEmails 'florian.dittgen@trelleborg.com'
```

Runs the Bicep template, then code, then DBs, then roles, then health.
**Storage account names are globally unique** — if `tis{env}mcpd365fost` is
already taken, pass a different `-Workload` (e.g. `mcpd365fov2`).

### 2.5 Surgical re-deploys

| Goal                       | Command                                          |
|----------------------------|--------------------------------------------------|
| Only the security DB       | `.\Deploy.ps1 -SkipCode -Databases sec`          |
| Code only, no validation   | `.\Deploy.ps1 -SkipDb -SkipRoles -SkipValidation`|
| KB + XRef only             | `.\Deploy.ps1 -SkipCode -Databases kb,xref`      |
| Pick a specific Function App | `.\Deploy.ps1 -FunctionAppName my-func-app`    |

---

## 3. What the script does (phase by phase)

| Phase | Action                                                   | Skip switch        |
|-------|----------------------------------------------------------|--------------------|
| 0     | Azure auth, RG check, Function App auto-discovery        | (always runs)      |
| 1     | Bicep deployment of `infra/main-rg.bicep`                | default skip; opt in via `-DeployInfra` |
| 2     | Stage source → `npm install` (cached) → Linux prebuild → zip → zip-deploy | `-SkipCode` |
| 3     | Parallel upload of `d365fo_kb.sqlite`, `d365fo_xref.sqlite`, `d365fo_sec.sqlite` via Kudu VFS | `-SkipDb` |
| 4     | Assign Function App managed identity to *Key Vault Secrets User* | `-SkipRoles` |
| 5     | Parallel health probes against 7 endpoints (4 retries, exponential backoff) | `-SkipValidation` |

### 3.1 npm install caching

`local-deploy/.npm-cache/` holds the resolved `node_modules` plus the
Linux-built `better-sqlite3` binary. The cache is keyed by the SHA-256 hash
of `package-lock.json` written to `local-deploy/.npm-cache-hash`.

- **Cache hit** → `robocopy .npm-cache → .deploy/node_modules` (~5 s)
- **Cache miss** → full `npm install --omit=dev` + `npx prebuild-install` (~60 s), then refresh cache

Delete `.npm-cache/` and `.npm-cache-hash` to force a clean install.

### 3.2 Why no explicit stop / start

Azure's zip-deploy already triggers an implicit restart of the Function App
when the package finishes uploading. Doing `az functionapp stop` + `start`
adds 30 s of dead time without changing the cold-start behaviour. The script
just waits 20 s for the new image to come up, then starts probing.

---

## 4. Validation: did it work?

### 4.1 Automated

The script prints a status line per endpoint. Look for `[OK]` on every row:

```
  [OK] d365kb (attempt 1)
  [OK] d365xref (attempt 1)
  [OK] d365sec (attempt 2)
  [OK] d365taskrecorder (attempt 1)
  [OK] d365sec/upload page (attempt 1)
  [OK] d365taskrecorder/upload (attempt 1)
  [OK] health (attempt 1)
```

A `[FAIL]` row means the endpoint did not return HTTP 200 within 4 retries
(5/10/15 s spaced backoff). Investigate via Application Insights.

### 4.2 Manual smoke tests

After a successful deploy, hit each endpoint from a browser or `curl`:

```powershell
$base = 'https://<your-func-app>.azurewebsites.net/api'
curl "$base/health"               # should return JSON {status: 'ok', ...}
curl -X POST "$base/d365kb" `
  -H 'Content-Type: application/json' `
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

The MCP `tools/list` call should return a JSON-RPC response listing every
registered tool.

### 4.3 Hooked into Claude Code

```powershell
claude mcp add d365kb-prod --transport http --url 'https://<your-func-app>.azurewebsites.net/api/d365kb'
claude mcp list                   # d365kb-prod should be ✓ Connected
```

### 4.4 Diagnose a failure

| Symptom                                    | Likely cause                                                        | Fix                                                                  |
|--------------------------------------------|---------------------------------------------------------------------|----------------------------------------------------------------------|
| `Resource group … not found`              | Wrong RG name (subscription is pinned to TIS.D365FO by `Ensure-AzContext`) | Pass `-ResourceGroup`; other subscription: `-Subscription <name/id>` |
| `Cannot select Azure subscription …`      | Login lacks access to TIS.D365FO, or wrong tenant                    | `az login --tenant <tenantId>`, then retry                           |
| `No Function App found in resource group` | RG exists but is empty                                              | Pass `-DeployInfra -BudgetEmails …`                                  |
| `Multiple Function Apps found in RG`      | RG hosts more than one app                                          | Pass `-FunctionAppName <name>`                                       |
| `npm install failed`                       | Old `package-lock.json`, or proxy/cert issue                        | Delete `.npm-cache/`, retry                                          |
| `prebuild-install failed`                  | better-sqlite3 version drift                                        | Bump `better-sqlite3` in `package.json`, delete cache, retry         |
| `Storage account name … already taken`     | Bicep tried a globally-claimed name                                 | Re-run with a different `-Workload` token                            |
| `Health: d365kb FAIL` after 4 retries      | Cold start > 60 s, or `/home/data/d365fo_kb.sqlite` missing         | Wait, retry; check Kudu VFS browser; verify DB upload phase succeeded |
| `Role assignment failed`                   | You lack User Access Administrator on the KV                        | Ask an Owner to run `az role assignment create` once                 |

---

## 5. Original scripts (for reference)

The git-tracked `scripts/` directory still contains the multi-script flow:

| Script                       | Replaced by                              |
|------------------------------|------------------------------------------|
| `Deploy-Infrastructure.ps1`  | `Deploy.ps1 -DeployInfra`                |
| `Deploy-FunctionApp.ps1`     | `Deploy.ps1` (Phase 2 + 3 + 5)           |
| `Deploy-Databases.ps1`       | `Deploy.ps1 -SkipCode -SkipRoles`        |
| `Deploy-SecService.ps1`      | `Deploy.ps1 -Databases sec`              |
| `Set-RoleAssignments.ps1`    | `Deploy.ps1` (Phase 4)                   |
| `Deploy-McpD365foData.ps1`   | `Deploy.ps1` (full pipeline)             |

The `scripts/` versions hardcode `tis-{env}-mcpd365fo-*` naming; this one
takes any RG and discovers the Function App by enumeration.

---

## 6. Files produced

| Path                              | Purpose                                                  | Cleanup |
|-----------------------------------|----------------------------------------------------------|---------|
| `.deploy/`                        | Staging directory for the zip                            | Auto    |
| `.deploy.zip`                     | Zip uploaded to Azure                                    | Auto    |
| `local-deploy/.npm-cache/`        | Cached `node_modules` keyed by lock-file hash            | Manual  |
| `local-deploy/.npm-cache-hash`    | SHA-256 of `package-lock.json` matching `.npm-cache/`    | Manual  |

All four are `.gitignored` via the `local-deploy/` rule plus the existing
`.deploy/` and `.deploy.zip` rules.

## Rebuild-Provenance.ps1 (prepared 2026-08-13)

One-shot rebuild of all three LOCAL databases so they carry the
`model_versions` build provenance (commits `2bae0a0` + `27a534f`):

```powershell
.\local-deploy\Rebuild-Provenance.ps1              # KB (~10 min) + Sec (~10 min) + XRef (~30-60 min)
.\local-deploy\Rebuild-Provenance.ps1 -SkipXref    # quick pass while XRef isn't needed
.\local-deploy\Rebuild-Provenance.ps1 -VerifyOnly  # re-run the model_versions checks only
```

Everything is pre-wired: `.env` was updated 2026-08-13 to platform
**10.0.2645.90** / `XRef_tis-d365fo-dev-02100264590` (the 10.0.2527.130
paths no longer exist on this box), Sec uses the 2026-06-10 DMF export in
`%USERPROFILE%\.claude\sec-dmf-new`, and the descriptor scan was dry-run
against the real roots (180 models: 172 microsoft / 3 isv / 5 custom —
iExtension + HISOL + HSAPAC at VAR layer). The Sec rebuild also finally
lands the label-resolution fix from 2026-07-08 in the local DB.

Verification (`verify-model-versions.cjs`) fails the run unless every
rebuilt DB has ~180 `model_versions` rows including iExtension. After a
green run: restart the local stdio MCP servers, then upload to Azure
interactively with `.\local-deploy\Deploy.ps1 -SkipCode` and verify via
direct HTTP POST (not via the local stdio tools — they read local DBs).

## Sealed-ISV data (issue #75)

The sealed-ISV tools and the sealed-ISV **data** are two independent
deliverables, and confusing them is the easiest mistake to make here:

| | Ships with | Effect if missing |
|---|---|---|
| `d365_isv_*` / `xref_isv_*` tools, `include_isv` | the **code** (`-SkipCode` off) | tools absent entirely |
| `isv_*` tables (17 models, 199,392 references, 153,054 labels) | the **KB and XRef .sqlite files** | tools present but answer *"no sealed-ISV data scanned"* |

So `-SkipDb` — the usual code-only refresh — deploys working ISV tools with
nothing behind them. That is a correct answer, but it reads like *"this
environment has no ISVs"*, which is false. The script now says so explicitly
before and after the deploy rather than leaving you to infer it.

### What the deploy reports

A `Sealed-ISV data` section runs before Phase 3 and prints the ISV content of
the local databases, e.g.

```
  Local KB   : 17 sealed model(s): 4,147 elements, 153,054 labels, 348 coc, 252 events   [scanned ...]
  Local XRef : 17 sealed model(s): 199,392 refs, 38,283 names, 204 deps   [scanned ...]
```

…then, with `-SkipDb`, the warning and the exact remedy. The final summary
repeats the state as `LIVE` / `DORMANT` / `NONE`, so it is visible without
scrolling back.

Status comes from `isv-status.cjs`, which reads the SQLite files directly and
never throws — a missing file, a pre-ISV database and a corrupt one are all
reported as data, so the deploy is never blocked by the check itself.

### Commands

```powershell
# Code only. ISV tools live, ISV data DORMANT.
.\Deploy.ps1 -SkipDb -SkipRoles

# Ship the ISV data too (uploads KB + XRef).
.\Deploy.ps1 -SkipRoles -Databases kb,xref

# Re-scan sealed models into the local DBs first (~7 s), then upload.
# Needs ISV_SCAN_PATHS, or a customization root in KB_PACKAGES_PATHS.
$env:ISV_SCAN_PATHS = "C:\Workspace\MAIN\Metadata"
.\Deploy.ps1 -SkipRoles -Databases kb,xref -RefreshIsv
```

`-RefreshIsv` is ignored with `-SkipDb`, since nothing would be uploaded.

### Cost note

The `isv_*` tables are ~83 MB, but they live inside the KB (~1 GB) and XRef
(~3.3 GB) files, so shipping them means re-uploading ~4.3 GB. There is no
smaller path today; if this becomes a routine refresh it is worth applying the
ISV tables to the remote databases in place over Kudu instead.

### Verifying afterwards

The local MCP servers read the databases in `~/.claude/`, so they will report
ISV data whether or not the deploy succeeded. Verify the **Azure** side by
calling `d365_isv_list_models` against the deployed KB endpoint over HTTP —
same trap as the earlier TOON deploy.

## Failure diagnostics and logging

On 2026-08-31 a **fully successful** deploy ended with one bare line:

```
Deploy.ps1: The property 'Count' cannot be found on this object.
```

No line number, no phase, no stack — and no indication that the code deploy,
both 4.7 GB of uploads and all eight health checks had actually succeeded. A
deploy script that cannot say *where* it failed is worse than one that fails
loudly, because you cannot tell a cosmetic summary bug from a half-finished
upload.

**Root cause.** `($steps | Where-Object { $_.Status -eq 'FAILED' }).Count`
yields `$null` when the pipeline matches nothing, and `$null.Count` throws
under `Set-StrictMode` (enabled by the operator's PowerShell profile). With
`$ErrorActionPreference = 'Stop'` that terminated the script — so it crashed
*precisely when the deployment had zero failures*. Fixed by wrapping every such
pipeline in `@(...)`, which always yields an array. The same pattern was
hardened at three other sites (`$apps`, `$existing`, `$BudgetEmails`).

**What you get now on any terminating error:**

```
  DEPLOYMENT FAILED
  Phase        : Phase 3: SQLite database upload (parallel)
  Exception    : System.Management.Automation.RuntimeException
  Message      : ...
  Error ID     : ...
  Category     : OperationStopped / RuntimeException
  Location     : C:\working\MCP\local-deploy\Deploy.ps1:312 char 5
  Failing line : throw "Resource group '$ResourceGroup' not found, ..."
  Stack:
    at <ScriptBlock>, ...Deploy.ps1: line 312

  Completed before the failure:
    [OK     ] Code deploy
    [OK     ] ISV data
  Full log: ...\local-deploy\logs\deploy-20260831-123710.log
```

The **steps completed before the failure** are the important part — they are
what distinguishes "cosmetic bug after a good deploy" from "died mid-upload".

Every run is also transcribed to `local-deploy/logs/deploy-<timestamp>.log`,
and the path is printed on both the success and failure paths. The transcript
is a convenience: if it cannot start, the deploy warns and continues.

The summary banner now reports warnings alongside failures
(`N failures, M warnings`) — previously a `WARNING` step was recorded but never
surfaced in the headline.

