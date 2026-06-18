# Technical: Code Review

Review D365 X++ code for a class or method: call chains, extensions, inheritance, patterns, and risks. For technical experts reviewing customizations or planning modifications.

## Arguments
- $ARGUMENTS: Class, method, or table (e.g., "SalesFormLetter", "CustPostInvoice.run", "PurchTable.validateWrite")

## Workflow

### Step 1: Parse target
Determine if $ARGUMENTS is:
- **Class** (no dot): analyze class-level
- **Class.Method** (has dot): analyze method-level
- **Table.Method** (table name pattern): analyze table method

### Step 2: Gather all code context (parallel)

**For class-level:**
- `d365_get_class_methods` with className, includeSource=true — all method signatures + source
- `xref_class_hierarchy` with className, direction=ancestors — inheritance chain up
- `xref_class_hierarchy` with className, direction=descendants — who extends this
- `xref_find_extensions` with objectName — CoC extensions and overlayering
- `xref_find_event_handlers` with objectName — event handlers attached
- `xref_object_summary` with objectName — reference counts

**For method-level (additional):**
- `d365_get_method_source` for the specific method — full X++ source
- `xref_find_method_callers` with className, methodName — all callers
- `xref_method_references` with className, methodName — what it calls

### Step 3: Extension analysis
For each CoC extension found:
- `d365_get_method_source` — read the extension code
- Identify: does it call next? What does it modify? Is it pre/post?

### Step 4: Present code review

**Code Review: $ARGUMENTS**

**1. Object Overview**
| Property | Value |
|----------|-------|
| Module | |
| Type | Class / Table |
| Extends | (parent) |
| Abstract | Yes/No |
| Methods | N |
| Extensions | N (list models) |
| Event Handlers | N |

**2. Inheritance Chain**
```
Base → Parent → $ARGUMENTS → [Children]
```

**3. Key Methods** (grouped)
- **Initialization**: construct, new, init
- **Core Logic**: [business methods]
- **Validation**: validate*, check*
- **Event Points**: delegates, events

**4. Extension Impact**
| Extension | Model | Method | Type | Calls next? | Risk |
|-----------|-------|--------|------|-------------|------|
(CoC extensions and their behavior)

**5. Call Chain** (for method-level)
```
Caller1.method → $ARGUMENTS → Callee1.method
Caller2.method →            → Callee2.method
```

**6. Code Quality Observations**
- Patterns used (command, strategy, factory)
- Potential issues (hardcoded values, missing error handling, performance)
- Extension points available for customization

**7. Modification Risks**
- Breaking changes if signature changes
- Extensions that depend on current behavior
- Cross-module consumers

### Step 5: Offer drill-down
- "View full source of a method?" → `d365_get_method_source`
- "Impact analysis?" → `/d365-impact`
- "Who has access to run this?" → `sec_permission_trace`

---

## When reviewing changes to THIS project (the MCP service itself, not D365 X++)

Before any commit / deploy of `src/azure/*.js`, `src/functions/*.js`, `host.json`, `package.json`, or `build/*.js`, run this checklist explicitly:

### Pre-deploy code-review checklist

1. **Template literals trap**: search the diff for `\`...${...}...\`` patterns where the template literal is later passed to `.replace('${...}', value)`. JS evaluates `${var}` at template-literal definition time, not at replace time. **A `ReferenceError` here crashes the entire Function App at module load → all 5 endpoints return 404.** Use `{{var}}` placeholders instead, or escape with `\${var}`.
   ```bash
   grep -nE '\$\{[A-Z_]+\}' src/functions/*.js
   ```
   If any matches are inside backtick strings AND the file calls `.replace('${...}', ...)` on the same string, that's the bug.

2. **File-operation safety on Azure CIFS**: any `rmSync(dest, { force: true })` followed by `renameSync(temp, dest)` is dangerous if `temp` is in `/tmp` (different filesystem) and `dest` is in `/home/data/` (CIFS mount). The rename throws EXDEV, the catch falls back to `copyFileSync`, and partial state can lose the destination file. **Default to in-place modifications via SQLite ATTACH for the security DB**, not file-rename gymnastics. If you must use temp files, put them in the same directory as the destination (`dirname(dest)`).

3. **Module load smoke test** before deploying:
   ```bash
   node -e "import('./src/functions/d365sec-upload.js').then(() => console.log('OK')).catch(e => console.error('FAIL:', e.message))" 2>&1 | grep -v WARNING
   ```
   This catches import errors, syntax errors, and the template-literal trap before they hit Azure.

4. **Run the test suite** (`npm test`) — must be fully green (943/943 as of 2026-06; the count grows each phase, so treat the pre-change pass count as the floor, never regress it). Adding test cases is preferred over skipping.

5. **For changes to `sec-builder.js` SCHEMA**: verify the new schema is backward-compatible with the in-place merge functions in `d365sec-upload.js`. The `mergeBuildsInPlace` and `mergeAotUpdateInPlace` functions enumerate specific table names — if you add a new table, decide whether it's DMF-sourced or AOT-sourced and add it to the right list.

6. **For SQL queries on multi-million-row tables** (`duty_privileges`, `privilege_entry_points`):
   - Never use `LOWER()` on indexed columns (bypasses indexes)
   - Use `COLLATE NOCASE` literals which match the NOCASE indexes
   - For known-casing data, prefer explicit `IN ('CamelCase', 'UPPERCASE')` over `COLLATE NOCASE`
   - Avoid joining on case-mismatched columns without `COLLATE NOCASE` on the join condition itself

7. **`structuredContent` ↔ `outputSchema` — the two `-32602` traps** (both bit us 2026-06). A tool that declares an `outputSchema` is validated on BOTH ends (server on send, client on receive):
   - **Success path:** every non-error response MUST carry `structuredContent` matching the schema — *including zero-row results*. Pass `emptyResult(context, typedEmptyPayload)` with the typed empty shape (empty arrays, zeroed counts, known scalars). A bare `emptyResult(context)` throws `-32602 "has an output schema but no structured content was provided"` on the server. A static-scan test enforces that every `emptyResult(` in `kb-tools.js`/`sec-tools.js` passes a 2nd arg.
   - **Error path:** error responses must carry **no** `structuredContent`. The SDK *client* validates `structuredContent` against the schema even when `isError` is true (`client/index.js`), so an `{error:{…}}` payload fails for every schema'd tool with `-32602 "Structured content does not match…"`. `errorResult`/`notFoundResult`/`patternErrorResult`/`timeoutErrorResult` are text + `isError` only — put diagnostics in the text channel.
8. **`@SYS` label leaks:** label-rendering tools must resolve via `makeLabelResolver(db)`, and the labels table column is **`text`** (not `label_text`). A wrong column name makes the resolver silently degrade to pass-through and leak raw `@SYS…` IDs (contract item 10).

### Fixing a failing or just-migrated suite (methodology — 2026-06)

1. **Cascading root cause before mass-editing.** Dozens of failures are often one cause. `test did not finish before its parent and was cancelled` = a `before()` hook threw — most often a stale mock server that only implements the deprecated `tool()` and not `registerTool(name, config, handler)`. One harness fix turned ~46 red→green this session. Triage by root cause, not symptom count.
2. **Stale test vs real bug.** For each failure, ask: does the impl follow the documented contract (the `shared.js` helpers / CLAUDE.md)? If yes, the *test* drifted — realign its assertion to the helper's current output (`emptyResult` → `## No results\n\nNo <ctx> found.`; `truncationNote('user')` → `Showing first N results (caller …)`; `notFoundResult` → ``X `name` was not found.`` + `**Did you mean:**`). If the impl violates a real invariant, fix the *impl*. Never make a test pass without making that decision.
3. **Read the library source for exact rules** (see the `-32602` asymmetry above) — don't guess validation semantics.
4. **Audit the whole class when fixing a contract bug** — grep every helper / call-site of the same shape (the empty-result trap had an error-channel sibling across 4 helpers).
5. **Iterate on targeted files; full suite only at milestones.** `node --test test/<file>.test.js` is seconds; `npm test` is the whole suite. Use the targeted file while fixing a cluster; run the full suite to confirm the cluster is clear and once at the end.
6. **Dirty tree: separate your edits from pre-existing/concurrent WIP.** `git stash` on an already-dirty tree conflates others' changes with yours and yields false baselines — use `git diff HEAD -- <file>` to see what's actually yours. At commit time stage by explicit path (`git add <files…>`), never `git add -A` when concurrent work is in the tree, and verify with `git diff --cached --stat`.

### After deploy
1. Wait 30s for cold start
2. Smoke test:
   ```bash
   curl -s -o /dev/null -w "HTTP %{http_code}" "https://tis-d-mcpd365fo-func.azurewebsites.net/api/d365sec/upload"
   ```
   Expected: 200. If 404, the module failed to load — check Application Insights or roll back.
3. Verify the database is still loaded:
   ```bash
   sec_raw_sql: SELECT key, value FROM sec_metadata WHERE key IN ('build_date','dutyPrivileges','privileges','entryPoints')
   ```
   Compare against expected counts before declaring the deploy successful.

