# Deployment Status & TODOs

_Audit date: 2026-06-12 — environment: **dev** (`tis-d-mcpd365fo-rg`, sub `TIS.D365FO`)_

Live audit of the only deployed MCP environment. Source of truth for code = the
active run-from-package zip (`SitePackages/packagename.txt`), **not** `/site/wwwroot`
(which holds a stale leftover and must be ignored). DB facts come from `/api/health`
and live `tools/list` responses.

| Resource | Value |
|---|---|
| Function App | `tis-d-mcpd365fo-func` (ElasticPremium **EP1**, Node 20, Linux, HTTPS-only) |
| Active package | `20260610070726.zip` — OneDeploy 2026-06-10 07:07 = branch `feat/toon-default-on-raw-sql` HEAD `e86683d` |
| Storage | `tisdmcpd365fost` (DBs on `/home/data` mount) |
| Other | ASP, App Insights, Log Analytics, Key Vault |

## Current state at a glance

| Area | Status |
|---|---|
| Function code | ✅ Current with branch HEAD |
| KB DB / XRef DB | ✅ Current (byte-identical to local builds) |
| Sec DB | ⚠️ Stale (2026-04-10, 9.2 GB) — v3 pending upload |
| Local sec work | ⚠️ Uncommitted, not deployed |
| Branch → main | ⚠️ 6 commits ahead, unmerged |
| `mcpdata` staging blobs | ⚠️ Stale; no sec blob (DR gap) |
| Admin dashboard routes | ❌ 404 (not registering) |
| Easy Auth | ❌ Not configured (anonymous endpoints) |
| Bicep ↔ live | ❌ Drift (SKU, snapshot container, budget, KV) |

---

## P1 — Data & reproducibility (do first)

- [ ] **Upload validated Sec DB v3.** Live sec DB is the old bloated build
  (2026-04-10, 9.2 GB, 19,567 roles). The validated v3
  (`d365fo_sec_20260610_v3.sqlite`, ~158 MB) is built and pending upload. None of
  the sec-completeness work is reflected in prod data until this lands.
- [ ] **Commit the uncommitted sec work** (30 working-tree files:
  `src/azure/sec-builder.js`, `src/azure/sec-tools.js`, `src/azure/output-schemas.js`,
  + sec-completeness docs). Currently local-only, so in no package.
- [ ] **Merge `feat/toon-default-on-raw-sql` → `main`.** Deployed package is from the
  branch (6 commits ahead of `main`). A redeploy sourced from `main` would silently
  regress (lose `taskrecorder_to_document`, the xref response-format migration,
  structured-output fixes). Open the PR, get it green, merge.

## P2 — Security & operability

- [ ] **Stand up Easy Auth (Entra OAuth).** Endpoints are fully anonymous/public.
  Apply the documented blueprint in `docs/MCP-Entra-Auth-Setup.md` (app role
  `Mcp.Access` + group, Easy Auth `Return401`, fail-closed `mcp-auth.js`).
- [ ] **Fix the admin dashboard.** `/api/admin`, `/api/admin/db-health`,
  `/api/admin/upload` return host-level 404 — `d365admin-pages.js` fails to register
  even though `index.js` imports it. Check App Insights for an import/registration
  exception; everything else routes fine.
- [ ] **Rotate the storage account key** if it has been pasted into any shared
  transcript/log (surfaced during the audit via `appsettings list`).

## P3 — Disaster recovery / staging hygiene

- [ ] **Fix DB rehydration source.** Live DBs serve from the `/home/data` mount; the
  only off-box copies are stale `mcpdata` blobs (kb/xref dated 2026-03-18) and there
  is **no sec blob at all**. If the mount is lost, sec cannot be restored. Add a
  current snapshot/backup of all three DBs and an upload integrity check to the
  deploy flow.

## P4 — Infrastructure-as-Code drift

Bicep is **not** the deployed source of truth. Reconcile (either update Bicep to
match live, or re-apply Bicep deliberately):

- [ ] **ASP SKU:** live `EP1` (ElasticPremium) vs Bicep `P0v3`.
- [ ] **`mcpsec-snapshots` container** (Bicep-declared for post-build snapshot backup,
  PR #37/#64) is missing — never provisioned.
- [ ] **Budget alert** ($50, `costAlerts` module) not found at subscription scope;
  likely not deployed.
- [ ] **Key Vault** (`tis-d-mcpd365fo-kv`) exists live and is wired (`KEY_VAULT_URI`),
  but Bicep still comments it as "not yet stood up" — bring it into IaC.

## Not started — prod environment

- [ ] **No prod deployment exists.** `parameters.prod.json` targets
  `tis-p-mcpd365fo-func` (env `p`); that app is not deployed. The earlier
  first-time prod provision (`mcpd365fo2`, blocked on Conditional Access step-up)
  never completed.

---

## Improvement suggestions (beyond fixes)

- **Make deploys reproducible from `main`.** Treat `main` as the deployable branch;
  never deploy a feature branch directly (current state). Tag releases to the package
  filename for traceability.
- **CI gate before deploy.** Run the full test suite (956 green locally) + the
  response-format static-scan in CI on PR merge so a regression can't reach the package.
- **Version/commit marker endpoint.** Add the git SHA to `/api/health` output so
  "what's deployed" is a single curl, not a Kudu package archaeology session.
- **Deploy integrity checks.** After upload, verify each DB's size + a row count
  against the source build before flipping it live (avoids the 0-byte / stale-mount
  class of outage seen before).
- **Document the run-from-package model** in `docs/Administration.md` — including the
  "`wwwroot` mtimes lie, read `SitePackages/packagename.txt`" gotcha — so future
  audits don't repeat the dead end.
- **Lifecycle/retention** for `secbuild-uploads` and snapshot blobs to cap storage
  cost (the lifecycle policy is declared in Bicep but unverified live).
