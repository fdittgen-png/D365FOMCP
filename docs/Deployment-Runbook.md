# Deployment Runbook — D365FO MCP Services on Azure

_Authoritative as of 2026-09-02. Supersedes the `scripts/Deploy-*.ps1` procedures in `Administration.md` §4–6; those scripts remain for reference only. One script does the work: `local-deploy/Deploy.ps1`._

## 1. What gets deployed, and what does not

| Artefact | Built by | Deployed by | Lives on Azure at |
|---|---|---|---|
| **Code** — `src/`, `build/`, `config/`, `assets/`, `www/`, `host.json`, `package*.json`, `node_modules` (Linux prebuild of `better-sqlite3`) | `Deploy.ps1` itself (stages, `npm install --omit=dev`, zips) | `Deploy.ps1` (default; `-SkipCode` to skip) | Function App `tis-d-mcpd365fo-func`, run-from-package |
| **KB snapshot** `d365fo_kb.sqlite` (~1.3 GB) — includes the `isv_*` tables and `isv_il_methods` | `npm run build:kb` (ISV pass runs inside it when `ISV_SCAN_PATHS` is set) | `Deploy.ps1 -Databases kb` | `/home/data/d365fo_kb.sqlite` |
| **XRef snapshot** `d365fo_xref.sqlite` (~3.7 GB) — includes `isv_names`/`isv_refs` | `npm run build:xref` | `Deploy.ps1 -Databases xref` | `/home/data/d365fo_xref.sqlite` |
| **Sec snapshot** `d365fo_sec.sqlite` (~180 MB) | `npm run build:sec` (DMF export + AOT) | `Deploy.ps1 -Databases sec` or the Sec upload page | `/home/data/d365fo_sec.sqlite` |
| **Semantic store** `d365fo_semantic.sqlite` | created at first write by the running service | **not deployed** — runtime state, survives snapshot uploads | `/home/data/d365fo_semantic.sqlite` (`SEMANTIC_DB_PATH`) |
| **Infrastructure** — Function App, plan, storage, Key Vault, App Insights, cost alerts | `infra/main.bicep` + `infra/modules/*` | `Deploy.ps1 -DeployInfra` (one-time / on infra change) | resource group `tis-d-mcpd365fo-rg`, North Europe |
| **App settings** | — | `Deploy.ps1` (paths) or `az functionapp config appsettings set` | see §6 |
| **RBAC / Easy Auth / OAuth proxy** | — | `Deploy.ps1` (roles; `-SkipRoles` to skip), `scripts/Enable-McpAuth.ps1`, `scripts/Update-McpAuthExcludedPaths.ps1` | Entra app registration + Function App auth |

Three consequences that are easy to get wrong:

- **ISV data ships inside the KB and XRef files.** A code deploy never moves ISV data; `Deploy.ps1 -SkipDb` prints "Sealed-ISV data: DORMANT" for that reason even when the data is already on Azure. Upload the databases to ship it.
- **The delta path is local only.** Compiling in Visual Studio refreshes the local KB/XRef (`Refresh-McpData.ps1`); Azure gets the weekly full publish. `mergeCustomKb()` never deletes, so the weekly full rebuild is what keeps Azure *correct*.
- **Nothing in the deploy zip depends on dev tooling.** `jsconfig.json`, `docs/`, `evals/`, `test/`, devDependencies (`typescript`, `@anthropic-ai/sdk`) never enter `.deploy/`.

## 2. Prerequisites (once per machine / per session)

1. **Azure CLI** logged in to the right tenant and subscription:
   ```powershell
   az login
   az account set --subscription TIS.D365FO
   az account show --query "{sub:name,user:user.name}" -o json
   ```
   The deploying identity needs Contributor on `tis-d-mcpd365fo-rg` — **activate PIM first** if the role is eligible, then `az login` again (a token issued before activation does not carry the role).
2. **Node.js** — the Function App runs Node 20; local builds work on Node 20 or 24 (`engines` warns only). `npm install` once after pulling.
3. **`.env`** in the repo root (gitignored) with at least:
   ```
   KB_DB_PATH=C:\Users\<you>\.claude\d365fo_kb.sqlite
   XREF_DB_PATH=C:\Users\<you>\.claude\d365fo_xref.sqlite
   SEC_DB_PATH=C:\Users\<you>\.claude\d365fo_sec.sqlite
   KB_PACKAGES_PATHS=<PackagesLocalDirectory>;C:\Workspace\MAIN\Metadata
   ISV_SCAN_PATHS=C:\Workspace\MAIN\Metadata      # REQUIRED — unset = ISV tables silently skipped
   ISV_IL_SCAN=1                                   # sealed-ISV method signatures (KB only)
   ```
4. **A green tree**: `npm test` before any deploy. `Deploy.ps1` also runs its own validation (`-SkipValidation` disables it — do not).
5. **Windows PowerShell 7** (`pwsh`) for the scripts; the repo's `local-deploy/README.md` has the script-level details.

## 3. Reading `Deploy.ps1`

```powershell
.\local-deploy\Deploy.ps1
  [-Environment d|p]                 # default: script's own default (d)
  [-DeployInfra]                     # Bicep: create/update the resource group contents
  [-SkipCode] [-SkipDb] [-SkipRoles] [-SkipValidation]
  [-Databases kb,xref,sec]           # which snapshots to upload (default: all three)
  [-KbDbPath <file>] [-XrefDbPath <file>] [-SecDbPath <file>]   # override the .env paths
  [-RefreshIsv]                      # run the ISV scan on the local files before uploading
  [-PurgeProtection] [-BudgetEmails …] [-AppServicePlanSku…]     # infra options
```

Phases, in order: discover the Function App → (infra) → code package + zip deploy `--clean` → database upload(s) with size/integrity check + restart → role assignments → parallel health checks with retry (ping, the four MCP endpoints, both upload pages, admin health). It ends with a summary table and writes a log to `local-deploy/logs/deploy-<timestamp>.log`. Exit code 0 only when every phase and health check passed.

Everything below is a combination of these switches.

## 4. Standard scenarios

### 4.1 Code only (a PR merged, no database changed) — ~10 min
```powershell
git checkout main && git pull --ff-only
npm install && npm test
.\local-deploy\Deploy.ps1 -SkipDb -SkipRoles
```
Verifies itself with the eight health checks. Used for every code change; the two 2026-09-02 releases (#113, #121) went out this way.

### 4.2 Weekly data publish (KB + XRef rebuilt, ISV refreshed) — 20–60 min build + upload
```powershell
.\local-deploy\Publish-McpDataWeekly.ps1            # rebuild both, then Deploy.ps1 -SkipCode -SkipRoles -Databases kb,xref
.\local-deploy\Publish-McpDataWeekly.ps1 -SkipRebuild   # upload only, if the files are already fresh
```
Requires `ISV_SCAN_PATHS` in `.env`; the script warns and continues without it — that warning means the ISV tables are stale. This is **the** run that keeps Azure correct (the per-compile deltas only keep the local copy current).

### 4.3 One database, explicitly
```powershell
.\local-deploy\Deploy.ps1 -SkipCode -SkipRoles -Databases kb
.\local-deploy\Deploy.ps1 -SkipCode -SkipRoles -Databases sec -SecDbPath "$env:USERPROFILE\.claude\d365fo_sec_<date>.sqlite"
```
Use `-SecDbPath` whenever the Sec file to ship is not the one `.env` points at — the default path is the trap that once uploaded an older Sec build.

### 4.4 ISV-only refresh (an ISV upgrade landed, Microsoft application unchanged)
```powershell
npm run build:isv                                   # rewrites only the isv_* tables in the local KB + XRef
.\local-deploy\Deploy.ps1 -SkipCode -SkipRoles -Databases kb,xref
```
`Deploy.ps1 -RefreshIsv -Databases kb,xref` does the same scan as a pre-upload step.

### 4.5 Everything (new environment, or infra change)
```powershell
.\local-deploy\Deploy.ps1 -DeployInfra -Environment d
# then, once: auth + app registration
.\scripts\Enable-McpAuth.ps1 ...
.\scripts\Update-McpAuthExcludedPaths.ps1 ...       # keeps /api/icon.png (and the OAuth proxy routes) anonymous
```
Auth details: `docs/MCP-Entra-Auth-Setup.md`.

## 5. Verifying a deployment

1. **The script's own health table** — all `[OK]`, `0 failures`, exit 0.
2. **Admin health**: `GET https://tis-d-mcpd365fo-func.azurewebsites.net/api/health` (Easy Auth) shows the build date of each snapshot — compare with what you uploaded.
3. **Freshness banner**: any data tool response carries `_KB snapshot: YYYY-MM-DD_` on the line after its heading; a stale date means the upload did not land or the app did not restart.
4. **ISV data live**: `node local-deploy/verify-isv-live.cjs` (or call `d365_isv_list_models` through a client) — 17 sealed models expected.
5. **Provenance**: `node local-deploy/verify-model-versions.cjs`.
6. **Do not** verify Azure through the MCP tools of a Claude Code session: those are the **local stdio servers** reading the files under `~/.claude`. Verify with a direct HTTP call or the connectors in claude.ai.

## 6. App settings that matter

| Setting | Value | Set by |
|---|---|---|
| `KB_DB_PATH`, `XREF_DB_PATH`, `SEC_DB_PATH` | `/home/data/d365fo_<svc>.sqlite` | `Deploy.ps1` |
| `SEMANTIC_DB_PATH` | `/home/data/d365fo_semantic.sqlite` (writable) | `az functionapp config appsettings set` (2026-09-02) |
| `KEY_VAULT_URI`, `KEY_VAULT_NAME` | Key Vault for the live custom-fields credentials | infra / `Set-D365CustomFieldsSource.ps1` |
| `CUSTOM_FIELDS_SOURCES` | live environment(s) for `d365_custom_fields` | `Set-D365CustomFieldsSource.ps1` |
| `WIKI_CONFIG_JSON`, `OTRS_*` | wiki / ticket integrations | manual |
| `MCP_TOOL_PROFILE`, `MCP_TEXT_CHANNEL`, `MCP_STALE_WARN_DAYS` | optional server-wide defaults; per-connector `?profile=core` / `?text=summary` on the URL override them | manual |

```powershell
az functionapp config appsettings set -g tis-d-mcpd365fo-rg -n tis-d-mcpd365fo-func --settings NAME=value
az functionapp config appsettings list -g tis-d-mcpd365fo-rg -n tis-d-mcpd365fo-func --query "[?name=='NAME'].value" -o tsv
```
`set` echoes `null` for the value — that is masking, not failure; confirm with `list`.

## 7. Known failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `ResourceGroupNotFound` / `AuthorizationFailed` / `AADSTS…` at the start | wrong subscription, lapsed PIM, or expired token — the script classifies which | `az account set`; activate PIM then `az login`; `az login` |
| A conditional-access "claims challenge" mid-run (deployments, role assignments) | CA step-up MFA on some ARM writes | rerun the same command interactively in a terminal; the read/app-setting steps do not trigger it |
| All four MCP endpoints 404 after a deploy | run-from-package pointer not updated, or the zip was staged from a stale `.deploy/` | check App Insights traces; rerun the code deploy (the script stages with `--clean`) |
| Snapshot on Azure is 0 bytes / tools return `db-error` | interrupted upload | rerun the database upload; the script now checks size before swapping and the app only reopens the file after a successful copy |
| Sec tool call blocks every endpoint for >90 s | a `JOIN … COLLATE NOCASE` without a NOCASE index; `ensureSecIndexes()` self-heals at first request after a code deploy | wait for the first request, or run `build/add-sec-indexes.js` on the file before upload |
| ISV tools say "no sealed-ISV data scanned" | KB/XRef built without `ISV_SCAN_PATHS`, or only the code was deployed | set the variable, rebuild, upload the databases |
| PowerShell `.Count` is `$null` in a script on a successful run | `(pipeline).Count` on a no-match result | use `@(...).Count` |
| Icon / OAuth metadata 401 | `/api/icon.png` or the proxy routes dropped from Easy Auth `excludedPaths` | `scripts/Update-McpAuthExcludedPaths.ps1` |

## 8. Rollback

- **Code**: redeploy the previous commit — `git checkout <sha> && .\local-deploy\Deploy.ps1 -SkipDb -SkipRoles`. Run-from-package means the previous zip is gone; the git history is the rollback source.
- **Database**: `scripts/Backup-Databases.ps1` and the storage lifecycle rule keep prior snapshots (90-day expiry); download the previous file and upload it with `-<Svc>DbPath`.
- **Semantic store**: not overwritten by any deploy; if it must be reset, delete `/home/data/d365fo_semantic.sqlite` via Kudu and restart — the vocabulary is re-seeded from `config/semantic-vocabulary.json` on the next call.

## 9. Related

`local-deploy/README.md` (script internals) · `docs/Administration.md` (infra + auth background; §4–6 are the legacy procedure) · `docs/Metadata-Update-Runbook.md` (building the snapshots) · `docs/MCP-Entra-Auth-Setup.md` · `docs/Operations.md` (upload size limits) · `CLAUDE.md` "Post-compile refresh" and "Database Files".
