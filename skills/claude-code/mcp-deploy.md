# MCP: Safe Deploy

End-to-end safe deployment of MCP service code (`src/azure/`, `src/functions/`, `host.json`, etc.) to the Azure Function App. Use this for any change to the runtime, not just deploys triggered by the user.

## Arguments
- $ARGUMENTS: optional — `--skip-tests` to skip the test suite (not recommended), `--prod` (note: prod doesn't exist as of 2026-04-10)

## Workflow

### Phase 1 — Pre-flight checks (mandatory)

Run all in parallel:

1. **Verify the dev environment exists** (PROD does NOT exist as of 2026-04-10):
   ```bash
   az group show --name tis-d-mcpd365fo-rg --query "name" -o tsv
   ```
2. **Module load smoke test** for every modified `.js` file in `src/`:
   ```bash
   for f in $(git diff --name-only HEAD -- 'src/**/*.js'); do
     node -e "import('./$f').then(() => console.log('OK: $f')).catch(e => console.error('FAIL: $f -', e.message))" 2>&1 | grep -v WARNING
   done
   ```
   **Hard stop on any FAIL.** A module that doesn't load will take down ALL 5 endpoints.
3. **Run tests**: `npm test 2>&1 | tail -8` — must show `pass 254` (or whatever the current count is).
4. **Check for the template-literal trap** in any HTML-template-bearing file:
   ```bash
   grep -nE '\$\{[A-Z_]+\}' src/functions/*.js
   ```
   If any matches, verify each is properly escaped or replaced. The bug pattern is `${VAR_NAME}` inside a backtick template literal where `VAR_NAME` isn't a real JS identifier in scope.
5. **Check for fragile file operations** in changed files:
   ```bash
   git diff src/functions/d365sec-upload.js src/azure/sec-builder.js | grep -nE '(rmSync|renameSync|copyFileSync|unlinkSync)'
   ```
   Any new occurrences need a manual safety review. Default rule: never `rmSync(dest)` until you've verified the source is safely in place. For Azure CIFS persistence, prefer SQLite ATTACH-based in-place modifications over file rename gymnastics.

### Phase 2 — Capture the current state (rollback insurance)

```bash
# Snapshot current database stats so you can verify nothing was lost after deploy
curl -s -X POST "https://tis-d-mcpd365fo-func.azurewebsites.net/api/d365sec" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"sec_raw_sql","arguments":{"sql":"SELECT key, value FROM sec_metadata WHERE key IN (\u0027build_date\u0027,\u0027dutyPrivileges\u0027,\u0027privileges\u0027,\u0027entryPoints\u0027,\u0027roles\u0027,\u0027users\u0027)"}}}'
```
Save the output. After deploy, the same query should return the same counts (or higher).

### Phase 3 — Deploy

```powershell
.\scripts\Deploy-SecService.ps1 -Environment d -SkipDbUpload -SkipValidation
```

**Always pass `-SkipDbUpload`** unless you specifically need to upload a fresh local database (which is rare; the async build pattern is preferred). The deploy script's built-in validation is unreliable on cold starts — use Phase 4 instead.

### Phase 4 — Post-deploy verification

Wait 30 seconds for cold start, then:

```bash
sleep 30
echo "=== Endpoint health ==="
for path in d365kb d365xref d365sec d365sec/upload d365sec/upload/sas\?filename=t.zip d365sec/upload/status\?job_id=x d365taskrecorder/upload; do
  printf "%-40s " "/$path"
  curl -s -o /dev/null -w "HTTP %{http_code}\n" "https://tis-d-mcpd365fo-func.azurewebsites.net/api/$path"
done
```

**Expected:**
| Endpoint | Expected status |
|---|---|
| `/d365kb`, `/d365xref`, `/d365sec`, `/d365taskrecorder` | 200 |
| `/d365sec/upload`, `/d365taskrecorder/upload` | 200 |
| `/d365sec/upload/sas?...` | 200 |
| `/d365sec/upload/status?job_id=x` | 404 (job doesn't exist — endpoint works) |

**Any 404 on the MCP endpoints (`/d365kb` through `/d365taskrecorder`) means the function module failed to load.** Most likely cause: template-literal trap or import error in the new code. Check Kudu logs or Application Insights immediately.

### Phase 5 — Verify the database is still intact

```bash
# Re-run the snapshot query and compare
sec_raw_sql: SELECT key, value FROM sec_metadata WHERE key IN ('build_date','dutyPrivileges','privileges','entryPoints','roles','users')
```

Counts should match Phase 2 exactly (the deploy doesn't touch the database). If `dutyPrivileges` dropped from 34M to 6,300 (or zero), an in-place merge ran during cold start and may have corrupted state — investigate immediately.

### Phase 6 — Functional smoke test

For deploys touching the upload flow:
- Open `https://tis-d-mcpd365fo-func.azurewebsites.net/api/d365sec/upload` in a browser
- Verify the form renders (not the raw `${...}` placeholders)
- Verify the database stats line shows correct numbers
- Don't actually upload unless you have a test zip ready

### Rollback

If verification fails:
```bash
# Get the previous deployment version from git
git log --oneline -5
# Reset and redeploy
git revert HEAD
.\scripts\Deploy-SecService.ps1 -Environment d -SkipDbUpload -SkipValidation
```

For database corruption: re-upload the local known-good database via Kudu VFS (see `mcp-db-admin` skill).

---

## Common deploy failures and fixes

| Symptom | Likely cause | Fix |
|---|---|---|
| All endpoints return 404 after deploy | Module load error in any file under `src/functions/` | Check for template-literal trap (`${var}` in backtick string), syntax errors, missing imports. Roll back. |
| `/d365sec` returns 200 but queries fail with "unable to open database file" | Database lost or corrupted during deploy | Re-upload via Kudu VFS. Should never happen because deploy uses `-SkipDbUpload`. |
| Cold start takes >60 s | Container restart on a B-tier plan with the 6.2 GB DB | Normal. Wait. |
| HTTP 502 on a request | Function worker crashed (likely OOM during a build) | Restart the function app. Investigate the recent operation. |
| `/upload/sas` returns 500 | Storage account credentials issue OR the storage account doesn't exist | Check `AzureWebJobsStorage` env var; verify CORS rules. |
