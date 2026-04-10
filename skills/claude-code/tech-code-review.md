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

4. **Run the test suite** (`npm test`) — should be 254/254 passing. Adding test cases is preferred over skipping.

5. **For changes to `sec-builder.js` SCHEMA**: verify the new schema is backward-compatible with the in-place merge functions in `d365sec-upload.js`. The `mergeBuildsInPlace` and `mergeAotUpdateInPlace` functions enumerate specific table names — if you add a new table, decide whether it's DMF-sourced or AOT-sourced and add it to the right list.

6. **For SQL queries on multi-million-row tables** (`duty_privileges`, `privilege_entry_points`):
   - Never use `LOWER()` on indexed columns (bypasses indexes)
   - Use `COLLATE NOCASE` literals which match the NOCASE indexes
   - For known-casing data, prefer explicit `IN ('CamelCase', 'UPPERCASE')` over `COLLATE NOCASE`
   - Avoid joining on case-mismatched columns without `COLLATE NOCASE` on the join condition itself

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

