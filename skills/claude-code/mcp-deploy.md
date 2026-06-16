# MCP: Safe Deploy

End-to-end safe deployment of MCP service code to the Azure Function App. Covers all 4 services (KB, XRef, Security, Task Recorder) deployed as a single package.

## Arguments
- $ARGUMENTS: optional flags and scope:
  - `--skip-tests` — skip the test suite (not recommended)
  - `--prod` — target production (DOES NOT EXIST as of 2026-04-16 — reject with explanation)
  - `--dry-run` — run all pre-flight checks but do not deploy
  - `--skip-capture` — skip the Phase 2 state snapshot (faster, less safe)

## Constants

```
RESOURCE_GROUP    = tis-d-mcpd365fo-rg
FUNCTION_APP      = tis-d-mcpd365fo-func
BASE_URL          = https://tis-d-mcpd365fo-func.azurewebsites.net
NODE_TARGET       = 20.20.0
EXPECTED_SERVICES = d365kb d365xref d365sec d365taskrecorder
```

---

## Phase 1 — Pre-flight checks (mandatory, parallel)

Run ALL of these in parallel. **Hard stop on any failure.**

### 1a. Azure auth + resource group

```bash
az account show --query "user.name" -o tsv 2>/dev/null || echo "FAIL: not logged in"
az group show --name tis-d-mcpd365fo-rg --query "name" -o tsv
```

If not logged in, tell the user to run `! az login` and wait.

### 1b. Module load smoke test

Test EVERY function entry point — not just changed files. A transitive import failure (e.g., in shared.js or output-schemas.js) crashes all endpoints.

```bash
for f in src/functions/d365kb.js src/functions/d365xref.js src/functions/d365sec.js src/functions/d365sec-upload.js src/functions/d365taskrecorder.js; do
  node -e "import('./$f').then(() => console.log('OK: $f')).catch(e => console.error('FAIL: $f -', e.message))" 2>&1 | grep -v WARNING
done
```

**Hard stop on any FAIL.** A module that doesn't load takes down ALL endpoints — the Function App returns 404 for every route.

### 1c. Run tests

```bash
npm test 2>&1 | tail -10
```

Must show **948 pass, 0 fail** (or the current count — never lower than the previous deploy). If tests fail, stop and fix before deploying.

### 1d. Response contract validation

```bash
# No hand-rolled empty/not-found strings — must use shared.js helpers
grep -nE "textResult\(\s*[\"'\`]No (results|methods|tables|roles|users|duties|privileges)" src/azure/*-tools.js
grep -nE "textResult\(\s*\`[A-Z][a-z]+ \".+\" not found" src/azure/*-tools.js
```

Both must return **zero hits**.

### 1e. Template-literal trap

```bash
grep -nE '\$\{[A-Z_]+\}' src/functions/*.js
```

Each match must be a real JS identifier in scope. The bug: `${VAR_NAME}` inside a backtick template literal where `VAR_NAME` isn't defined — throws `ReferenceError` at module load, crashing the entire Function App.

### 1f. Fragile file operations

```bash
git diff HEAD -- src/functions/ src/azure/sec-builder.js | grep -nE '(rmSync|renameSync|copyFileSync|unlinkSync)' || echo "OK: no new fragile ops"
```

Any new occurrence needs manual review. Rule: never `rmSync(dest)` before verifying source is in place. On Azure CIFS, prefer SQLite ATTACH in-place modifications over file rename.

### 1g. Verify critical assets exist

```bash
test -f host.json && echo "OK: host.json" || echo "FAIL: host.json missing"
test -f www/taskrecorder.html && echo "OK: www/taskrecorder.html" || echo "FAIL: www/taskrecorder.html missing"
test -f src/azure/output-schemas.js && echo "OK: output-schemas.js" || echo "FAIL: output-schemas.js missing"
```

The Task Recorder function reads `www/taskrecorder.html` at import time — missing it crashes the entire Function App.

---

## Phase 2 — Capture current state (rollback insurance)

Skip with `--skip-capture`. Otherwise:

```bash
echo "=== Pre-deploy state ==="
for svc in d365kb d365xref d365sec; do
  printf "%-10s " "$svc"
  curl -s -o /dev/null -w "HTTP %{http_code}" "https://tis-d-mcpd365fo-func.azurewebsites.net/api/$svc"
  echo ""
done
```

Capture sec database stats (the most fragile service):

```bash
curl -s -X POST "https://tis-d-mcpd365fo-func.azurewebsites.net/api/d365sec" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"sec_stats","arguments":{}}}'
```

Save the output. After deploy, counts must match exactly (deploy doesn't touch databases).

---

## Phase 3 — Deploy

```powershell
.\scripts\Deploy-SecService.ps1 -Environment d -SkipDbUpload -SkipValidation
```

**Rules:**
- **Always** pass `-SkipDbUpload` — the deploy should never touch databases. Use the async build pattern or `Deploy-Databases.ps1` for DB updates.
- **Always** pass `-SkipValidation` — the script's built-in validation races with cold start. Use Phase 4 instead.
- The script deploys ALL services (KB, XRef, Sec, TaskRecorder) as a single zip.

**What the script does:**
1. Copies `host.json`, `package.json`, `src/azure/`, `src/functions/`, `www/` to `.deploy-sec/`
2. Runs `npm install --omit=dev`
3. Cross-installs Linux `better-sqlite3` binary (`prebuild-install --platform linux --arch x64 --target 20.20.0`)
4. Sets `SCM_DO_BUILD_DURING_DEPLOYMENT=false`
5. Zips and deploys via `az functionapp deployment source config-zip`
6. Cleans up temp files

**Expected duration:** 2-4 minutes for the zip deploy.

---

## Phase 4 — Post-deploy verification

Wait for cold start (the Function App needs to restart and load ~6 GB of SQLite databases):

```bash
echo "Waiting 45s for cold start..."
sleep 45
echo "=== Endpoint health ==="
for path in d365kb d365xref d365sec d365sec/upload d365taskrecorder d365taskrecorder/upload; do
  printf "%-35s " "/$path"
  curl -s -o /dev/null -w "HTTP %{http_code}\n" "https://tis-d-mcpd365fo-func.azurewebsites.net/api/$path"
done
```

**Expected:**

| Endpoint | Status | Meaning |
|---|---|---|
| `/d365kb` | 200 | KB MCP healthy |
| `/d365xref` | 200 | XRef MCP healthy |
| `/d365sec` | 200 | Security MCP healthy |
| `/d365sec/upload` | 200 | Upload UI renders |
| `/d365taskrecorder` | 200 | Task Recorder MCP healthy |
| `/d365taskrecorder/upload` | 200 | Task Recorder upload UI |

**If ANY MCP endpoint returns 404:**
- The function module failed to load → ALL routes are dead
- Most likely: template-literal trap, import error, or missing file
- Check Application Insights or Kudu log stream
- Roll back immediately (see Rollback section)

**If 502/503:**
- Function worker crashed (OOM) or is still cold-starting
- Wait 30 more seconds and retry
- If persistent: `az functionapp restart --resource-group tis-d-mcpd365fo-rg --name tis-d-mcpd365fo-func`

---

## Phase 5 — Verify database integrity

```bash
curl -s -X POST "https://tis-d-mcpd365fo-func.azurewebsites.net/api/d365sec" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"sec_stats","arguments":{}}}'
```

Compare against Phase 2 snapshot:
- `build_date` must be identical
- Row counts (roles, duties, privileges, entry points, users) must match exactly
- If `dutyPrivileges` dropped from millions to thousands → in-place merge corruption. Investigate immediately.

---

## Phase 6 — Functional smoke test (for upload flow changes)

Only needed when `src/functions/d365sec-upload.js` or `www/` was modified:

1. Open `https://tis-d-mcpd365fo-func.azurewebsites.net/api/d365sec/upload` in browser
2. Verify the form renders (no raw `${...}` placeholders)
3. Verify the database stats line shows correct numbers
4. Open `https://tis-d-mcpd365fo-func.azurewebsites.net/api/d365taskrecorder/upload`
5. Verify Task Recorder upload form renders

---

## Rollback

### Code rollback (fast — 3 minutes)

```bash
git log --oneline -5                 # find the pre-deploy commit
git revert HEAD --no-edit            # create revert commit
npm test 2>&1 | tail -5             # verify revert is clean
```

Then redeploy:

```powershell
.\scripts\Deploy-SecService.ps1 -Environment d -SkipDbUpload -SkipValidation
```

### Database rollback (if corruption detected)

1. Find a known-good local copy of the database
2. Upload via Kudu VFS:

```powershell
.\scripts\Deploy-Databases.ps1 -Environment d -SecOnly
```

Or manually:

```bash
# Get Kudu creds
az functionapp deployment list-publishing-credentials \
  --resource-group tis-d-mcpd365fo-rg --name tis-d-mcpd365fo-func \
  --query '{user:publishingUserName, pass:publishingPassword}' -o json

# Upload (replace $USER:$PASS)
curl -X PUT "https://tis-d-mcpd365fo-func.scm.azurewebsites.net/api/vfs/data/d365fo_sec.sqlite" \
  -u "$USER:$PASS" -H "If-Match: *" \
  --data-binary @/path/to/d365fo_sec.sqlite
```

3. Restart: `az functionapp restart --resource-group tis-d-mcpd365fo-rg --name tis-d-mcpd365fo-func`

---

## Common failures

| Symptom | Cause | Fix |
|---|---|---|
| All endpoints 404 | Module load error in `src/functions/` | Template-literal trap, missing import, syntax error. Roll back. |
| `/d365sec` 200 but queries fail "unable to open database" | Database file lost or corrupted | Re-upload via `Deploy-Databases.ps1 -SecOnly` |
| Cold start >60s | Normal for P0v3 with 6+ GB databases | Wait. Premium plan Always On keeps it warm after first load. |
| HTTP 502 | Worker OOM during build/merge | Restart function app. Reduce concurrent operations. |
| `/upload/sas` returns 500 | `AzureWebJobsStorage` misconfigured | Check env var in Azure Portal → Function App → Configuration |
| `prebuild-install` fails in deploy script | Network issue or Node version mismatch | Verify `--target 20.20.0` matches Azure Function runtime. Check proxy settings. |

---

## Session learnings (2026-06 — `local-deploy/Deploy.ps1` path)

The one-shot orchestrator is `local-deploy/Deploy.ps1` (auto-discovers the Function App in the RG; phases: auth → optional Bicep → code zip-deploy → DB upload → roles → parallel health checks). Hard-won notes:

- **Probe ARM-write capability before packaging.** The Trelleborg tenant *can* require an interactive Conditional-Access step-up (`acrs=p1`) for ARM writes, which a non-interactive subprocess can't satisfy — **but the step-up is often already active in the current `az` session**, so don't assume it'll fail. Probe cheaply first (it's the same ARM call the deploy makes for Kudu creds):
  ```bash
  az functionapp deployment list-publishing-credentials -g tis-d-mcpd365fo-rg -n tis-d-mcpd365fo-func --query publishingUserName -o tsv
  ```
  Returns a value → the deploy's ARM writes will work non-interactively, run it directly. Fails with a claims challenge → hand the exact `Deploy.ps1` command to the operator to run interactively (`! …`). Memory that "subprocess deploys always fail" is point-in-time — verify the live session.
- **Confirm the app already exists** (`az functionapp list -g <rg>`) → it's a code refresh, not a first-time provision, so **don't** pass `-DeployInfra`. `-SkipRoles` is safe on an existing app (the Key Vault role is already assigned — another ARM write to skip).
- **Default to code-only:** `.\local-deploy\Deploy.ps1 -SkipDb -SkipRoles`. `Deploy.ps1`'s zip-deploy runs with `--clean true` (wipes wwwroot before extract), so stale-wwwroot 404s aren't a risk on this path.
- **NEVER blind-upload the `sec` DB.** Prod `sec` is maintained via the upload UI and is large (≈9.2 GB / ~19.5k records); a local `d365fo_sec.sqlite` is often a smaller/older snapshot — uploading it **regresses prod**. Before any `-Databases sec`, GET `/api/health` and compare `size_bytes`/`last_modified` to the local file. The usual *legitimate* DB upload is xref (prod often shows `xref healthy:false, size_bytes:0` — the known outage); fix it with `-SkipCode -SkipRoles -Databases xref`.

---

## Session learnings (2026-06-16 — KB rebuild + backoffice)

- **`admin` is a reserved route segment on this host.** Every `/api/admin*` route 404s even when the function registers fine (verified: identical handler on route `backoffice` → 200, on `admin` → 404). The unified back-office page is served at **`/api/backoffice`** (`d365admin-pages.js`); the Sec/KB upload GET pages 302-redirect to `/api/backoffice#sec` / `#kb`. Don't resurrect `/api/admin`.
- **Never rebuild the KB onto the live `d365fo_kb.sqlite` path.** The local stdio MCP server (`mcp-server-kb.js`) holds an open handle and the MCP host **respawns it the instant `releaseOutputLock` kills it**, so the final `writeFileSync` fails with `UNKNOWN` (errno -4094). Build to a **fresh path** and upload from there:
  ```bash
  KB_PACKAGES_PATHS="<MS PackagesLocalDirectory>;C:\Workspace\DEV\Metadata" \
    node --max-old-space-size=8192 build/build-kb.js \
    "<MS>;C:\Workspace\DEV\Metadata" "C:\Users\<u>\.claude\d365fo_kb_full.sqlite"
  # ~4–5 min, ~1.1 GB. Then upload only the KB DB from the fresh path:
  .\local-deploy\Deploy.ps1 -SkipCode -SkipRoles -Databases kb -KbDbPath "...\d365fo_kb_full.sqlite"
  ```
  KB upload via Kudu VFS is fast (~30 s for 1.1 GB) — the build is the slow part.
- **`build/` must be in the Deploy.ps1 staged folders** (`src\azure, src\functions, www, config, build`). The KB custom-delta `/rebuild` endpoint imports `build/build-kb.js` + `build/merge-kb-custom.js` at runtime; without `build/` it 404s/throws on Azure. `sql.js` must be a **prod** dependency for the same reason.
- **KB refresh paths:** (1) full pre-built `.sqlite` upload via `/api/backoffice` (KB tab, "Full" mode) or `Deploy.ps1 -Databases kb`; (2) **customizations delta** — upload a ZIP of just `C:\Workspace\DEV\Metadata` via the KB tab "delta" mode → server builds + ATTACH-merges. The delta path **requires the live KB at `schema_version` 1.1** (it fails closed otherwise) — so the first refresh after a schema bump must be a full upload.
- **Verify the live MCP service directly** with a `tools/call` (no SDK needed); headers must include `Accept: application/json, text/event-stream`:
  ```bash
  curl -s -X POST "$BASE_URL/api/d365kb" \
    -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"d365_raw_sql","arguments":{"sql":"SELECT value FROM kb_metadata WHERE key='\''schema_version'\''","format":"markdown"}}}'
  ```

---

## Database-only deployment

When only updating databases (no code change):

```powershell
# All databases
.\scripts\Deploy-Databases.ps1 -Environment d

# Security only (most common)
.\scripts\Deploy-Databases.ps1 -Environment d -SecOnly

# Skip restart (for staging multiple DBs)
.\scripts\Deploy-Databases.ps1 -Environment d -KbOnly -SkipRestart
.\scripts\Deploy-Databases.ps1 -Environment d -XrefOnly -SkipRestart
.\scripts\Deploy-Databases.ps1 -Environment d -SecOnly  # restarts on last one
```

---

## Infrastructure deployment (rare)

Only needed when Bicep templates change:

```powershell
.\scripts\Deploy-Infrastructure.ps1 -Environment d
```

Then deploy code on top: `.\scripts\Deploy-SecService.ps1 -Environment d -SkipDbUpload`
