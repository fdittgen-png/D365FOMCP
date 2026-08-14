# Metadata Update Runbook — refreshing all MCP databases after a D365FO version/metadata change

End-to-end procedure to bring the KB, XRef, and Security databases (local **and**
Azure) onto a new application version or a new custom-code drop. Every step below
was executed and verified on **2026-08-14** for the move to platform
**10.0.2645.90** with the production metadata root `C:\Workspace\MAIN\Metadata`.

Total wall-clock for a full refresh: **~1 h** (builds ~35 min, VS custom compile
~15 min, uploads ~10 min).

---

## 0. When to run this

| Trigger | What to run |
|---|---|
| New D365FO version installed (new `PackagesLocalDirectory`) | Everything (steps 1–6) |
| Custom code changed (iExtension / HISOL) | Steps 3–6 (KB/Sec pick up XML directly; XRef needs the VS compile) |
| Only user/role assignments changed | Neither — that needs a fresh DMF export (see [Sec-DMF-Export-Runbook](Sec-DMF-Export-Runbook.md)) |

## 1. Identify the authoritative sources

Open **Visual Studio → Extensions → Dynamics 365 → Manage local XPP configurations**
and read off the *current* configuration:

- **Folders for reference metadata** → the `PackagesLocalDirectory` path (Microsoft AOT)
- **Folder for your own custom metadata** → the custom root (e.g. `C:\Workspace\MAIN\Metadata`)
- **Cross reference database name** → the LocalDB XRef DB (e.g. `XRef_tis-d365fo-dev-02100264590`)

These three values are the single source of truth. Do **not** guess paths from
older `.env` contents — installed versions disappear from the box when VS
reprovisions.

> **Custom-root nuance:** pass the *whole* custom metadata root, not individual
> package folders. The descriptor scanner handles both. Packages inside the root
> that are **binary-only** (only `bin/`, `Resources/`, `*.xref` — e.g. Lasernet,
> AMC Banking, Experlogix, LACCE, PRNButtons) have **no XML source and cannot be
> scanned**; their objects will never appear in KB/Sec/XRef data. That is a
> platform fact, not a build bug. Only packages with a `Descriptor\` folder
> (iExtension, HISOL) contribute.

## 2. Retarget the build configuration

Two places must agree (the rebuild script preflights this):

1. **`.env`**:
   ```ini
   KB_PACKAGES_PATHS=<PackagesLocalDirectory>,<custom metadata root>
   D365FO_VERSION=<new version>
   XREF_DATABASE=<Cross reference database name from VS>
   # XREF_PACKAGES_PATHS unset on purpose — falls back to KB_PACKAGES_PATHS
   ```
2. **`local-deploy\Rebuild-Provenance.ps1`** — `$pkgRoots` (and its preflight
   version regexes, if the version changed).

## 3. Rebuild all three databases

```powershell
.\local-deploy\Rebuild-Provenance.ps1            # all three (~35 min total)
.\local-deploy\Rebuild-Provenance.ps1 -SkipXref  # quick pass: KB + Sec only
```

Approx. durations (2026-08-14 reference): KB **~11 min** (1.1 GB), Sec **~1.5 min**
(150 MB), XRef **~18 min** (3.5 GB, 28M refs). The script preflights sources/disk/
`.env`, then verifies `model_versions` landed in every DB (expect **180 models**
for 2645.90 + iExtension + HISOL/HSAPAC).

What to check in the output:

- **Sec data-quality block**: `dutyPrivileges` must be ~25–27k (millions = the V1
  Cartesian bug). A `labels resolved` WARN for modules without en-US label files
  is cosmetic.
- **KB**: `kb_search_fts finalized via better-sqlite3 (…rows indexed)` — the FTS5
  index is created post-save by `build/add-kb-fts.js` (sql.js cannot). To retrofit
  it onto an already-built KB without rebuilding:
  `node --env-file-if-exists=.env build/add-kb-fts.js`
- **Custom model versions show `1.0.0.0`** — expected: dev-branch descriptors are
  unstamped; only pipeline builds stamp real build numbers.
- Sec **user→role assignments** keep the vintage of the newest DMF export on disk
  (`%USERPROFILE%\.claude\sec-dmf-new`); only role/duty/privilege *definitions*
  are fresh from AOT.

## 4. Compile custom code into the XRef database (custom-layer coverage)

The XRef SQLite is exported from the **LocalDB cross-reference DB**, which
Microsoft ships pre-populated with *Microsoft* code only. Custom models appear in
XRef **only after being compiled on this box** with cross-reference update enabled.
(KB/Sec don't need this — they parse the custom XML directly.)

1. In Visual Studio, **build iExtension and HISOL** with *Update cross reference*
   checked (platform version must match the XRef DB — a mismatch was the historical
   blocker).
2. **Expect "does not exist" compile errors after a version jump** — privileges
   generated on an older version reference menu items/forms Microsoft has since
   removed (2645.90 example: 5× `CollabSite*` + `RetailCheckListStoreSetup` in
   iExtension `TOC_ReadOnlyPrivilege`). The same file compiles clean in the DevOps
   pipeline **only because the pipeline builds against an older app version** — it
   will break there too when the pipeline moves up. Fix: delete the dead
   `<AxSecurityEntryPointReference>` blocks. Do **not** delete references to
   binary-only ISV objects (`LAC*`, `PRN*`, `AMC*`, …) — those resolve from
   runtime packages and are fine.
3. Verify the compile landed before wasting a rebuild:
   ```powershell
   sqlcmd -S '(LocalDB)\MSSQLLocalDB' -d '<XREF_DATABASE>' -W -Q `
     "SELECT m.[Module], COUNT(n.[Id]) FROM [Modules] m LEFT JOIN [Names] n ON n.[ModuleId]=m.[Id] WHERE m.[Module] IN ('iExtension','HISOL') GROUP BY m.[Module]"
   ```
   (2026-08-14 reference: iExtension 37,466 names, HISOL 19,479.)
4. Rebuild the XRef SQLite: `npm run build:xref`

## 5. Publish to Azure

```powershell
.\local-deploy\Deploy.ps1                                   # code + all DBs (first refresh after code changes)
.\local-deploy\Deploy.ps1 -SkipCode -SkipRoles -Databases xref   # data-only, single DB
```

- **Ship code too** whenever tool behavior changed (e.g. the FTS5 search path) —
  `-SkipCode` uploads only databases.
- Conditional Access step-up (`acrs=p1`) *may* block agent-driven ARM writes.
  On 2026-08-14 a full agent-driven deploy went through with **zero** challenges —
  try it first, hand off to an interactive shell only if AADSTS claims errors
  appear (role assignment is the usual trigger; `-SkipRoles` avoids it on
  subsequent deploys).
- The deploy size-verifies each upload and runs 8 health checks; expect
  `DEPLOYMENT COMPLETE … (0 failures)`.

## 6. Verify — never via local stdio tools

The session's `d365kb`/`d365xref`/`d365sec` MCP connections are **local stdio
servers reading the local files** — they prove nothing about Azure (known
verification trap). Verify the *published* state via:

- the **claude.ai remote connectors** (they call the Function App), e.g.
  `sec_stats` → check `build_date` and `aot_source`; or
- direct HTTP POST against `https://tis-d-mcpd365fo-func.azurewebsites.net/api/…`; or
- the deploy's own size-verified uploads + health checks.

Then reload the local MCP connections (`/mcp` → reconnect) — the builders take
the SQLite file locks and disconnect the stdio servers.

Local sanity queries after reconnect: `d365_list_modules`, `xref_list_modules`,
`sec_stats` must show the new build versions; `xref_module_objects
module_name=iExtension` must return rows (custom coverage).

---

## Known limitations (by design)

| Limitation | Why | Where documented |
|---|---|---|
| Binary-only ISV packages absent from all DBs | No XML source to scan; compiler reads them from runtime packages | this page, §1 |
| Sec user→role assignments lag | Sourced from DMF export, not AOT | [Sec-DMF-Export-Runbook](Sec-DMF-Export-Runbook.md) |
| XRef custom coverage requires a VS compile | XRef source DB only contains compiled code | [XRef-Custom-Layer-Coverage](XRef-Custom-Layer-Coverage.md) |
| Custom model versions read `1.0.0.0` | Dev descriptors are unstamped | CLAUDE.md (model-descriptors) |
