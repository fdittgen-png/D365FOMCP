# Using Claude Code Efficiently on the D365 FO MCP Project

Practical guide for getting maximum value out of Claude Code on this codebase, based on lessons learned the hard way. **Read this before your first significant session.**

## TL;DR — The 5 rules that save the most time

1. **Verify live data before forming any hypothesis** about a security issue. Check `sec_metadata.build_date` and the user's actual current roles via the **Azure** sec MCP, not the local one.
2. **Never use `LOWER()` on indexed columns**. Use `COLLATE NOCASE` or explicit `IN ('mixed', 'UPPER')`. The 34M-row `duty_privileges` table has both casings for the same logical duty.
3. **Always run `tech-code-review` and `mcp-deploy`'s pre-flight checklist before any deploy.** A single `${var}` in a backtick template literal will take down all 5 endpoints with 404s.
4. **For database maintenance, use `sqlite3` CLI via `mcp-db-admin` skill**, not Node.js scripts. The Kudu Node version doesn't match the function runtime.
5. **For "also implement X" requests, ask one clarifying question** if X is more than ~15 minutes of work. A generator script in this conversation was built and immediately discarded.

---

## Project at a glance

| Component | Where | Notes |
|---|---|---|
| MCP service code | `src/functions/`, `src/azure/` | Azure Functions v4, Node.js 20, ES Modules |
| Database builders | `build/` | `build-sec.js`, `build-kb.js`, `build-xref.js` |
| Tests | `test/*.test.js` | 254 tests, run with `npm test`, must always pass |
| Deployment | `scripts/Deploy-*.ps1` | PowerShell scripts that package, npm install with Linux binary, push via Kudu |
| Live Function App | `tis-d-mcpd365fo-func.azurewebsites.net` | The ONLY environment that exists. Production was never provisioned. |
| Kudu SCM | `tis-d-mcpd365fo-func.scm.azurewebsites.net` | Use for VFS, command shell, log streaming. **Different Node version than the runtime.** |
| Sec database | `/home/data/d365fo_sec.sqlite` (~6.2 GB) | 34M effective duty-privileges, 40K entry points. Persistent CIFS mount. |
| Local sec database | `~/.claude/d365fo_sec.sqlite` (~13 MB) | Stale snapshot from a manual build. The local stdio MCP queries THIS, not Azure. |

---

## The skills (what to invoke and when)

### For investigations / support tickets

| If the question is... | Invoke skill | Why |
|---|---|---|
| "User can't do X / lost access to Y" | `support-diagnose` | Step 0 enforces verifying the ticket's stated facts against live data. |
| "What does this role do?" / "Who has this role?" | `d365-security` | Wraps `sec_lookup_role`, `sec_role_hierarchy`, `sec_find_users_by_role` in parallel. |
| "Why is this query slow?" | `mcp-db-admin` | Use the indexes section to add the right one if needed. |

### For code changes to the MCP service itself

| Task | Invoke skill | Why |
|---|---|---|
| Reviewing a planned change to `src/azure/*.js` or `src/functions/*.js` | `tech-code-review` | Has the MCP-specific pre-deploy checklist (template literal trap, file ops on CIFS, module load smoke test). |
| Deploying after a change | `mcp-deploy` | 6-phase workflow with rollback insurance. Catches the "all 5 endpoints return 404" scenario. |
| Adding indexes / running maintenance SQL | `mcp-db-admin` | Knows about `sqlite3` CLI, `sh -c` wrapping, singleton restart timing. |

### For D365 X++ analysis (not the MCP service itself)

| Task | Invoke skill |
|---|---|
| Reading X++ source / understanding a class | `d365-class` |
| Understanding the impact of changing an X++ object | `d365-impact` |
| Tracing where a field is used | `d365-trace-field` |
| Reviewing X++ customizations | `tech-code-review` (works for both X++ and the MCP code) |
| Researching D365 standard behavior | `d365-research` |

---

## The 7 most expensive mistakes (and how to avoid them)

### 1. Trusting a ticket's premise without verifying live data

**What goes wrong:** A ticket says "user X has roles A, B, C and can't do something." You spend hours debugging "what's wrong with roles A, B, C" — but the actual issue is that user X **no longer has** those roles. They were changed, and the ticket was based on a stale snapshot.

**Cost in this project:** ~2 hours on the Martin Ellhoff investigation.

**Fix:** Always start with:
```sql
sec_raw_sql against the AZURE MCP (not local):
  SELECT r.role_name FROM users u
  JOIN user_roles ur ON u.user_id = ur.user_id
  JOIN roles r ON ur.role_id = r.role_id
  WHERE LOWER(u.user_id) LIKE '%username%' COLLATE NOCASE
```

The `support-diagnose` skill enforces this as Step 0.

### 2. The `${var}` template literal trap

**What goes wrong:** You write an HTML template as a backtick string with placeholder syntax like `${MAX_UPLOAD_MB}`, intending to call `.replace('${MAX_UPLOAD_MB}', value)` on it later. JavaScript evaluates `${MAX_UPLOAD_MB}` at template-literal definition time (module load), not at replace time. If `MAX_UPLOAD_MB` isn't a real variable, you get a `ReferenceError` that **prevents the entire module from loading**, which makes **all 5 Function App endpoints return 404**.

**Cost in this project:** ~20 minutes of "why is the deploy broken" debugging.

**Fix:** Use `{{var}}` placeholders instead of `${var}` in template literals destined for `.replace()`. Or escape: `\${var}`.

**Detection:** Before any deploy, run:
```bash
grep -nE '\$\{[A-Z_]+\}' src/functions/*.js
```
If any matches are inside backtick strings AND the file uses `.replace('${...}', ...)` on the same string, it's a bug. This is in the `tech-code-review` skill checklist.

### 3. File rename gymnastics on Azure CIFS

**What goes wrong:** You write code like:
```javascript
const tempFile = '/tmp/sec-build/merged.sqlite';
// ... build the temp file ...
rmSync(dbPath, { force: true });
try {
  renameSync(tempFile, dbPath);
} catch {
  copyFileSync(tempFile, dbPath); // EXDEV fallback
}
```

`/tmp` is a local SSD; `/home/data/` is an SMB/CIFS mount. The `renameSync` throws `EXDEV` (cross-device rename), the `copyFileSync` fallback can fail mid-stream on CIFS, and the destination is now **gone** because you `rmSync`'d it before the rename.

**Cost in this project:** Lost the 6.2 GB database **twice**. Each recovery took ~5 min for the upload but ~30 min of debugging to figure out what happened.

**Fix:** For SQLite databases, use **in-place modifications via SQLite ATTACH + transaction** instead of file-rename gymnastics. The `mergeBuildsInPlace` and `mergeAotUpdateInPlace` functions in `d365sec-upload.js` show the pattern. For full database replacement, use Kudu VFS PUT which streams directly to the destination.

### 4. In-memory dedup of multi-million-row streams

**What goes wrong:** You stream a multi-GB XML file to extract unique pairs and collect them in a JS `Map` or `Set`. At ~4M unique entries the heap explodes (4 GB heap), at ~8M it explodes again (8 GB heap), and you blow through Node's max old space size.

**Cost in this project:** 2 OOM crashes during the duty-privilege extraction.

**Fix:** Use SQLite as the dedup backbone. Open a temp DB, define a UNIQUE index, stream rows in with `INSERT OR IGNORE`. SQLite handles the dedup on disk with constant memory.

The `build/inject-duty-privs.js` file is a working example.

### 5. Using `LOWER()` on indexed columns

**What goes wrong:** Your query says `WHERE LOWER(duty_id) = LOWER(?)` for case-insensitivity. SQLite cannot use any index for function calls — you get a full table scan. On the 34M-row `duty_privileges` table, that's 16+ seconds for what should be a millisecond query.

**Cost in this project:** Multiple 60-second timeouts during the Martin investigation.

**Fix:** Never use `LOWER()` on the indexed side of a comparison. Use `COLLATE NOCASE`:
```sql
-- ❌ slow (function bypasses index)
WHERE LOWER(col) = LOWER('value')

-- ✅ fast (uses idx_col_nocase)
WHERE col = 'value' COLLATE NOCASE

-- ✅ also fast (uses BINARY index, both casings)
WHERE col IN ('CamelCase', 'UPPERCASE')
```

For JOIN conditions, the same rule applies — `COLLATE NOCASE` belongs on the join column itself, not the WHERE clause.

### 6. Running Node scripts via Kudu against the function app's `node_modules`

**What goes wrong:** You write a `.cjs` script that requires `better-sqlite3`, upload it to `/home/data/`, and run it via the Kudu command API. It fails with `NODE_MODULE_VERSION 115 vs 83`.

**Why:** Kudu's shell runs Node 14 (`/usr/local/bin/node`). The function runtime runs Node 20. The native binding in `node_modules/better-sqlite3/build/Release/better_sqlite3.node` was compiled for Node 20.

**Cost in this project:** ~20 minutes trying three different Node-based approaches.

**Fix:** Use the `sqlite3` CLI instead. It's at `/usr/bin/sqlite3` in the Kudu container and doesn't depend on Node bindings:
```bash
curl -s -X POST -u "$USER:$PASS" \
  "https://tis-d-mcpd365fo-func.scm.azurewebsites.net/api/command" \
  -H "Content-Type: application/json" \
  -d '{"command":"sh -c \"sqlite3 /home/data/d365fo_sec.sqlite < /home/data/maintenance.sql\""}'
```

The `mcp-db-admin` skill has the full pattern. **Always wrap shell redirects in `sh -c "..."`** — Kudu's command parser mangles `<` otherwise.

### 7. Building "also X" features without checking scope

**What goes wrong:** The user says "implement Y, and also create a script for X". You build both. The user immediately says "drop X, I don't actually need it."

**Cost in this project:** Built a 150-line generator script, sample CSV, and README. Discarded.

**Fix:** For any "also X" request where X is >15 minutes of work, ask one clarifying question first:
- "Want me to start with Y now and circle back to X if needed?"
- "Quick check on X — is the goal A, B, or C? It changes the implementation significantly."

This is in the `feedback_verify_live_data_first.md` memory and in this guide because it's a recurring issue.

---

## Common workflows

### Workflow A: User reports a "lost access" ticket

```
1. /support-diagnose "User <name> can no longer <action>"
   → Step 0 verifies current roles vs ticket claim
   → If they differ, that's the answer — investigate the change
2. If chain looks broken, /d365-security <user>
   → Get the canonical role/duty/privilege path
3. Check for iExtension overrides on the affected menu item
   → sec_raw_sql: SELECT * FROM privilege_entry_points WHERE object_name = '<MenuItem>'
4. If TOC_ReadOnlyPrivilege appears, the fix is in iExtension X++, not in security config
```

### Workflow B: Code change to the MCP service

```
1. Make the change in your editor
2. /tech-code-review src/functions/d365sec-upload.js
   → Runs the pre-deploy checklist (template literal trap, file ops, module load test)
3. Local module load smoke test:
   node -e "import('./src/functions/d365sec-upload.js').then(() => console.log('OK')).catch(e => console.error(e.message))"
4. npm test
5. /mcp-deploy
   → Deploys + verifies + smoke-tests
6. If anything fails Phase 4 verification, roll back
```

### Workflow C: Database maintenance

```
1. /mcp-db-admin "add an index on <column>"
   → Generates the SQL, snapshots current state, restarts function app
2. Upload SQL via Kudu VFS
3. Execute via sqlite3 CLI in Kudu (with sh -c wrapper)
4. Verify counts unchanged
5. Restart function app, smoke test
```

### Workflow D: New DMF or AOT data needs to be uploaded

```
1. For a small DMF zip (<150 MB): drag-drop on the upload page
2. For a large zip (>150 MB) or PowerAutomate:
   GET /api/d365sec/upload/sas?filename=x.zip
   PUT <sas-url> with the zip
   POST /api/d365sec/upload/build with { job_id }
   GET /api/d365sec/upload/status?job_id=... (poll)
3. The function auto-detects DMF vs AOT vs both and merges in-place
4. Verify result mode in the response: "merged (DMF into existing AOT)" or "merged (AOT into existing DMF)" — full rebuilds are dangerous
```

---

## What NOT to ask Claude to do

These are slow, error-prone, or out-of-scope on this project. If the user asks anyway, push back.

| Ask | Why it's a bad idea | Better alternative |
|---|---|---|
| "Rebuild the security database from scratch in production" | Takes ~10 min and risks losing the 34M duty-privileges if anything goes wrong | Use the in-place merge endpoints — they preserve existing data |
| "Run a Node script via Kudu against the live database" | Node version mismatch with `better-sqlite3` | Use `sqlite3` CLI via Kudu (see `mcp-db-admin`) |
| "Add SQL indexes via the MCP `sec_raw_sql` tool" | The tool blocks DDL (only SELECT/WITH/PRAGMA allowed) | Upload SQL script via Kudu VFS, run with `sqlite3` CLI |
| "Push to GitHub from Claude Code" | The github remote needs interactive credential auth, no terminal in this environment | Push to Azure DevOps (`origin`); push to github manually |
| "Build the production environment (`tis-p-mcpd365fo-rg`)" | Doesn't exist as of 2026-04-10. The tis-p URLs in docs are aspirational. | Use only the dev environment; ignore the prod URLs |
| "Add SoD analysis to the security DB" | Segregation of Duties has been extracted into a separate project — it is out of scope for the MCP Security service. | Use the dedicated SoD project |

---

## How to ask Claude for the most efficient response

### Be explicit about whether you want investigation vs implementation

❌ "Look at this and tell me what to do." (ambiguous → Claude will probably do both, slowly)

✅ "Investigate why this is broken — don't fix anything yet. Show me your hypothesis and one verifying query."

✅ "Implement the fix for X. Tests should still pass. Don't deploy."

### When delegating to subagents, scope the prompt

❌ "Look at the security database." (no scope, unbounded exploration)

✅ "Find which roles contain duty `COLLECTIONLETTERCOLLECTIONSTRANSMAINTAI` and how many users have each. One MCP query, ~5 min report under 200 words."

### For multi-step tasks, list the steps explicitly

The user got the most efficient outputs in this conversation when they said things like "deploy it", "commit and push", "investigate again with the new data" — specific verbs with specific objects. Open-ended requests like "make this better" tend to spiral.

### Reuse past investigations

Claude has a `memory/` directory that persists across conversations. If a previous session learned something non-obvious (like the case-mismatch trap), it should already be in memory. Check `MEMORY.md` to see what's there.

---

## Troubleshooting Claude itself

### "Claude is repeating queries against stale data"

→ It's hitting the **local** `~/.claude/d365fo_sec.sqlite` (older snapshot) not the **Azure** MCP. Force a query against Azure with `curl -X POST .../api/d365sec` and the JSON-RPC payload.

### "Claude is being slow on database queries"

→ The query probably uses `LOWER()` or has a case-insensitive join without `COLLATE NOCASE`. Ask Claude to rewrite using `COLLATE NOCASE` or explicit `IN ('mixed', 'UPPER')`.

### "Claude built the wrong thing"

→ The request was probably ambiguous. Be more specific about scope and what NOT to include.

### "Claude's deploy broke production... I mean dev"

→ Most likely the template-literal trap or a file-rename bug. Check `Application Insights` → recent failed requests → exception details. The `mcp-deploy` skill's Phase 4 catches both before they're announced as "successful".

### "Claude didn't use the right skill"

→ Skills are loaded on-demand. You can explicitly invoke one with `/skill-name <args>`. If Claude is freelancing instead of using the appropriate skill, prompt it: "Use the `support-diagnose` skill for this."

---

## Reference

- [Architecture.md](./Architecture.md) — overall MCP platform architecture
- [Administration.md](./Administration.md) — general MCP service administration
- [PowerAutomate-Admin-Guide.md](./PowerAutomate-Admin-Guide.md) — Azure infra + deployment
- [PowerAutomate-SecDatabase-Update.md](./PowerAutomate-SecDatabase-Update.md) — flow logic + API contract
- [Copilot-Studio-Guide.md](./Copilot-Studio-Guide.md) — Copilot Studio agent configuration

Memory files (cross-conversation):
- `~/.claude/projects/C--working-MCP/memory/MEMORY.md` — index
- `project_sec_dmf_data_quirks.md` — case mismatch + iExtension overrides
- `project_sqlite_collation_indexes.md` — SQLite query patterns
- `reference_function_app_kudu.md` — Kudu shell environment
- `feedback_verify_live_data_first.md` — investigation discipline
- `project_sec_upload_architecture.md` — async upload pattern
- `project_dmf_export_project.md` — secMCP_Repository ownership

Skills:
- `skills/claude-code/d365-security.md` — security analysis (with case-mismatch + iExtension warnings)
- `skills/claude-code/support-diagnose.md` — issue investigation (with Step 0 live-data verification)
- `skills/claude-code/tech-code-review.md` — code review (with MCP pre-deploy checklist)
- `skills/claude-code/mcp-deploy.md` — safe deploys with rollback
- `skills/claude-code/mcp-db-admin.md` — live database maintenance via Kudu sqlite3 CLI
