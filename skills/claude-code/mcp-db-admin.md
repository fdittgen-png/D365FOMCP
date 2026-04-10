# MCP: DB Admin Operations

Run SQL maintenance against the live Azure security database (`/home/data/d365fo_sec.sqlite`, ~6.2 GB) without breaking it.

## Arguments
- $ARGUMENTS: a brief description of what you want to do (e.g., "add an index", "vacuum", "check counts")

## When to use this skill

Anytime you need to **modify** the deployed sec database — adding indexes, running ANALYZE, fixing data, restoring from backup. **Read-only queries should use the MCP `sec_raw_sql` tool directly**, not this skill.

## Critical rules (memorize)

### Rule 1: Never run `node` against the database via Kudu

The Kudu shell at `tis-d-mcpd365fo-func.scm.azurewebsites.net/api/command` runs **Node.js 14**, but `better-sqlite3` was compiled for **Node.js 20** in the function app's `node_modules`. Mismatched ABI → `NODE_MODULE_VERSION` error. **Use the `sqlite3` CLI instead.**

```bash
# ❌ Don't do this — fails with NODE_MODULE_VERSION 115 vs 83
node /home/data/some-script.cjs

# ✅ Do this — sqlite3 CLI is at /usr/bin/sqlite3
sqlite3 /home/data/d365fo_sec.sqlite < /home/data/script.sql
```

### Rule 2: Always wrap shell redirects in `sh -c "..."`

Kudu's command parser mangles `<`, `>`, `|`, `&` if they're not quoted. Always wrap.

```bash
# ❌ Wrong — Kudu treats < as SQL operator
"command":"sqlite3 /home/data/db < /home/data/script.sql"

# ✅ Right — sh -c protects the redirect
"command":"sh -c \"sqlite3 /home/data/db < /home/data/script.sql\""
```

### Rule 3: Restart the Function App BEFORE writing to the database

The `getSecDb()` singleton holds an open SQLite connection. SQLite allows multiple readers but only one writer, and the writer can be blocked by long-running readers. Always restart first to drop the singleton:

```bash
az functionapp restart --resource-group tis-d-mcpd365fo-rg --name tis-d-mcpd365fo-func
sleep 5
```

The next request after restart will lazily reopen the singleton — that's fine, but **do your write operations during the gap between restart and the first request**.

### Rule 4: Use in-place modifications, never file rename gymnastics on `/home/data/`

`/home/data/` is mounted via SMB/CIFS. Cross-filesystem `renameSync` and partial `copyFileSync` failures have lost the database **twice** in this project's history. For SQL changes, modify the file in-place (SQLite handles atomicity via its journal). For full database replacement, use Kudu VFS PUT, not rename.

## Workflow

### Step 1 — Get Kudu credentials (always fresh, they expire)

```bash
CREDS=$(az functionapp deployment list-publishing-credentials \
  --resource-group tis-d-mcpd365fo-rg \
  --name tis-d-mcpd365fo-func \
  --query "[publishingUserName, publishingPassword]" -o tsv)
USER=$(echo "$CREDS" | head -1)
PASS=$(echo "$CREDS" | tail -1)
```

If this errors with "AuthorizationFailed", the user's Azure session expired — they need to run `az login` interactively.

### Step 2 — Snapshot the current database state

```bash
sec_raw_sql: SELECT key, value FROM sec_metadata WHERE key IN ('build_date','build_mode','dutyPrivileges','privileges','entryPoints','duties','roles','users')
```

Save the output. Compare against the same query after the maintenance to verify nothing was lost.

### Step 3 — Restart the Function App to drop the singleton connection

```bash
az functionapp restart --resource-group tis-d-mcpd365fo-rg --name tis-d-mcpd365fo-func
sleep 5
```

### Step 4 — Upload the SQL script to /home/data/

Write the SQL to a local file first, then PUT it to Kudu VFS:

```bash
curl -s -X PUT -u "$USER:$PASS" \
  "https://tis-d-mcpd365fo-func.scm.azurewebsites.net/api/vfs/data/maintenance.sql" \
  -H "If-Match: *" \
  --data-binary @./local-maintenance.sql \
  -w "HTTP %{http_code}\n"
```

Expected: `HTTP 201` (created) or `HTTP 204` (replaced).

### Step 5 — Run the SQL script via sqlite3 CLI in Kudu

```bash
curl -s -X POST -u "$USER:$PASS" \
  "https://tis-d-mcpd365fo-func.scm.azurewebsites.net/api/command" \
  -H "Content-Type: application/json" \
  --max-time 1800 \
  -d '{"command":"sh -c \"sqlite3 /home/data/d365fo_sec.sqlite < /home/data/maintenance.sql\"","dir":"/home/data"}'
```

For long operations (e.g., creating an index on the 34M-row `duty_privileges` table — 5–10 minutes), run with `run_in_background: true` and poll for the task completion.

### Step 6 — Verify and clean up

1. Re-run the snapshot from Step 2. Counts should match (or be higher if you added rows).
2. Restart the function app once more so the singleton picks up any schema changes:
   ```bash
   az functionapp restart --resource-group tis-d-mcpd365fo-rg --name tis-d-mcpd365fo-func
   sleep 30
   ```
3. Smoke test:
   ```bash
   curl -s -o /dev/null -w "HTTP %{http_code}" "https://tis-d-mcpd365fo-func.azurewebsites.net/api/d365sec/upload"
   ```
   Expected: 200.
4. Delete the maintenance script if it was a one-off:
   ```bash
   curl -s -X DELETE -u "$USER:$PASS" "https://tis-d-mcpd365fo-func.scm.azurewebsites.net/api/vfs/data/maintenance.sql" -H "If-Match: *"
   ```

## Common operations

### Upload a fresh database (recovery)

```bash
curl -X PUT -u "$USER:$PASS" \
  "https://tis-d-mcpd365fo-func.scm.azurewebsites.net/api/vfs/data/d365fo_sec.sqlite" \
  -H "If-Match: *" \
  --data-binary @"C:/path/to/local/d365fo_sec.sqlite" \
  --max-time 1800 \
  -w "HTTP %{http_code} — %{size_upload} bytes in %{time_total}s\n"
```

Run via `run_in_background: true` for files >100 MB. Typical 6 GB upload: ~50 seconds at 115 MB/s.

### Add a new index

See `build/add-sec-indexes.sql` in the repo for the canonical list. Add new indexes there too so they're persisted in source control. After applying via this skill, also update the SCHEMA constant in `src/azure/sec-builder.js` so future rebuilds get them.

### Run ANALYZE (refresh planner stats)

```sql
PRAGMA journal_mode = DELETE;
ANALYZE;
```

### Check disk usage

```bash
sh -c "ls -lh /home/data/ && df -h /home"
```

## Files in this project for DB admin

| File | Purpose |
|---|---|
| `build/add-sec-indexes.sql` | Canonical list of performance indexes (use this as a template) |
| `build/add-sec-indexes.cjs` | Local equivalent for use against `~/.claude/d365fo_sec.sqlite` |
| `build/build-sec.js` | Full rebuild from AOT + DMF |
| `scripts/Deploy-SecService.ps1` | Code deployment + optional DB upload |
