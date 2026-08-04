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

If this errors with "AuthorizationFailed", check the **subscription first**: the Function App lives in **TIS.D365FO**, which is not the default az subscription — `az account set --subscription TIS.D365FO` fixes it (learned 2026-07-06). Only if the right subscription still fails is the session expired → the user runs `az login` interactively.

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

## Knowledge Base database (`/home/data/d365fo_kb.sqlite`, ~1.1 GB)

The KB is **built locally and uploaded** (it can't be rebuilt on Azure — the raw
MS metadata is tens of GB). Two refresh paths, both via the unified back-office
page at **`/api/backoffice`** (KB tab) or programmatically:

- **Full replace** — upload a pre-built `.sqlite`. `POST /api/d365kb/upload/sas` → PUT to the SAS blob URL → `POST /api/d365kb/upload/apply {job_id}` → poll `/api/d365kb/upload/status`. The server validates (`kb_metadata.build_date` + non-empty `tables`) before an atomic swap, so a bad file never replaces the live KB. Or just `Deploy.ps1 -SkipCode -SkipRoles -Databases kb -KbDbPath <file>`.
- **Customizations delta** — upload a ZIP of `C:\Workspace\DEV\Metadata` only → `/api/d365kb/upload/rebuild` builds a custom-only KB and **ATTACH-merges** it additively (MS rows preserved, enum values unioned). Requires the live KB at `schema_version` 1.1.

Building the full KB: **write to a fresh path, not the live `d365fo_kb.sqlite`** — the local `mcp-server-kb.js` respawns and re-locks it, failing the write (see the deploy skill). Set `KB_PACKAGES_PATHS` = MS `PackagesLocalDirectory` + `C:\Workspace\DEV\Metadata`.

KB schema v1.1 captures customizations and entity methods: `fields.is_extension`/`source_module`, `tables.is_customized`, `data_entities.method_count`, and `methods` rows with `owner_type='entity'`. Query custom objects with `d365_raw_sql`, e.g. `SELECT * FROM fields WHERE is_extension=1`, or list entity methods via `d365_get_entity_sources` / `d365_get_class_methods`.

## Session learnings (2026-07-08 — sec-builder.js label resolution)

`resolveLabel()` in `src/azure/sec-builder.js` was silently leaking raw `@…`
label IDs into `roles.label`/`duties.duty_name`/`privileges.label` for ~20-35%
of rows (confirmed live). Two takeaways for anyone touching `build-sec.js` or
diagnosing "why does this role/duty show a raw label" again:

- **A PASS data-quality check only proves what it measures.** The old
  `"labels loaded"` check asserted `labelMap.size > 0` — that label *files*
  were found — and stayed green through the whole regression because
  `resolveLabel()` degrades to "return the raw string" instead of throwing.
  There is now a second check, `"labels resolved"`, that counts actual
  `LIKE '@%'` leaks in the three label columns after the build. When adding
  any future data-quality check, ask "does this check the file existed, or
  that the transformation actually worked?" — those are different questions.
- **D365 AOT label references have two shapes**, both real: colon-delimited
  (`@Module:LabelId`, common for ISV/custom modules with alphanumeric ids)
  and concatenated (`@ModuleLabelId`, the common Microsoft-standard shape,
  e.g. `@SYS154926`). A regex that only matches one shape will silently
  under-resolve — verify against `sec_raw_sql: SELECT label FROM roles WHERE
  label LIKE '@%' LIMIT 20` on a live-ish DB, not just synthetic fixtures.
- **No AOT-path test existed for `Label` properties at all** before this
  session — every prior `buildSecurityDatabase` test in
  `test/sec-builder.test.js` passed `packagesPathArg: 'skip'`. That's exactly
  why the bug shipped undetected. If you add a new AOT-sourced field, add at
  least one end-to-end build test that doesn't skip the AOT path.
- **Full rebuild needs two inputs, only one of which lives in this repo's
  config.** `KB_PACKAGES_PATHS` in `.env` covers the AOT side; the DMF export
  directory (`System Security Duty.xml` etc., ~4 GB, from Eugene's CR 99351
  pipeline) is not a standing local path — get it fresh from the user before
  attempting `build/build-sec.js`. An AOT-only rebuild (`dmfInputDir:
  'skip'`) is enough to validate label resolution but will under-report
  duty/privilege counts.

---

## Files in this project for DB admin

| File | Purpose |
|---|---|
| `build/add-sec-indexes.sql` | Canonical list of performance indexes (use this as a template) |
| `build/add-sec-indexes.cjs` | Local equivalent for use against `~/.claude/d365fo_sec.sqlite` |
| `build/build-sec.js` | Full rebuild from AOT + DMF |
| `scripts/Deploy-SecService.ps1` | Code deployment + optional DB upload |
