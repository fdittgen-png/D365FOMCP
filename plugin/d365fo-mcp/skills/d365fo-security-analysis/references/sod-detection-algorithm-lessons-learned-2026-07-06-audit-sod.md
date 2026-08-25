# SoD Detection Algorithm — Lessons Learned (2026-07-06 audit, SoDSecAnalysis repo)

_Reference for the `d365fo-security-analysis` skill. Read on demand._


> **SUPERSEDED 2026-07-09.** SoDSecAnalysis retired the entire D1-D46 bucket vocabulary this section describes — `DutyMapping.xml`, `SoD_Matrixes.xml`, the bucket-collapse layer, all gone. SoD rules and duty grants are now keyed directly on real D365 AOT duty identifiers. Kept below because the underlying traps (label-matching pitfalls, sub-role expansion gaps, silent-drop coverage) are still real lessons for **any** duty-bucket-based engine you might encounter elsewhere — just not this one anymore. See the "Duty-native rewrite" section further down for current-state lessons.

From the FDD 99352 compliance audit and overhaul of `<repo-path>` (successor to SecAnalysis1.0.0). These apply to ANY duty-bucket-based SoD engine on D365FO.

### Duty mapping is the weakest link — measure it, never trust it
- A hand-maintained AOT-duty→bucket mapping rots silently: at audit time only **61 of 2,274 duties actually assigned to users (~2.7%) were mapped**, and 76 of 139 entries were dead (plausible-sounding but *invented* duty IDs like `SYSSECURITYROLESMAINTAIN` — always verify IDs against the real AOT catalog).
- D365 ships **many duties per business function**: MCR retail variants (`MCRSALESORDERMAINTAIN`), localization variants (`*_RU`), kanban/GUP/PDS variants — all with the *same label* as the standard duty. Exact-ID mapping misses them all. **Regenerate the mapping by label-matching** duty labels against bucket definitions (see `scripts/Update-DutyMapping.ps1`). The DMF `System Security Role Duty.xml` export doubles as a duty catalog (id + name on every row).
- **Traps in label matching**: (a) duty IDs ending `VIEW`/`INQUIRE` can carry "Maintain …" labels (`LEDGERALLOCATIONJOURNALSANDTRANSACTIONSVIEW` is labeled "Maintain journals and transactions") — exclude them; (b) D365 itself truncates some duty AOT IDs at 39 chars (`BANKBANKACCOUNTRECONTRANSACTIONSMAINTAI` is the *real* ID) — don't "fix" them.
- Quantify misses against the live security DB (MCP `sec_raw_sql`): one unmapped duty (`PURCHORDERAPPROVE`, 217 users) hid a High-severity vendor-master×PO-approve conflict for **183 enabled users**.

### Bucket-model structural failures
- **Enter-vs-approve collapse**: if two auditor tasks (e.g. "edit vendor master" / "approve vendor master") map to the *same* bucket set, their mutual conflict expands to self-pairs and gets erased by self-conflict filters. Approve-side tasks need their **own buckets** (D45/D46 pattern) with the enter×approve rules added explicitly.
- Watch for environments where the approve concept has no native duty (vendor change management not enabled → no `VendTableChangeProposalApprove`); map the closest real control and flag it for business review.
- Conflict rows can carry a `description` attribute (auditor's functional translation, e.g. "Cannot enter and approve payments") — stamp it during CSV→matrix expansion and serve it to UIs as `businessRule`. Bucket names alone lose the auditor's intent.

### Sub-roles and the DMF export
- The DMF `System Security Role Duty` export **mostly but not completely** flattens sub-role duties onto parent roles — verified gaps: Credit management clerk/manager (5 duties), Landed cost agent/manager (6 duties). Never rely on the flattening; expand sub-roles in every detection path.
- DutyLinks/role-duty records are keyed to the role that *directly* owns the duty. Any engine that skips sub-role expansion silently under-reports for composite roles — and TIS profiles are ALL composite (2–122 sub-roles each).
- **Tests can encode bugs as expected behavior**: a test literally asserted "profile with duties only on sub-roles → zero violations". When fixing an engine, audit the tests for assertions that bless the defect.

### Coverage must be loud (fail-open is the default failure mode)
- Every silent drop (missing entity file → empty section, unmapped duty → no DutyLink, role absent from export → no duties) produces a **clean report**, which reads as "compliant". Emit a per-run coverage artifact (enforceable vs unenforceable rules, unmapped-duty list) and warn on gaps — see `SoD-RuleCoverage.json` in SoD_merge Step 5.
- Deny/mitigation reclassification is a compliance hazard: a bucket-level deny does not prove the granting duty is nullified. In approval-gate paths, deny info must be **advisory context**, never a filter.

### Config overlay trap (bundled + blob)
- When a rules file is both bundled in the deployment AND blob-overlaid (`sod-config/SoD_Matrixes.xml`), **a code deploy does NOT change the effective ruleset** — the blob wins. After deploying new bundled rules, also `PUT` them to the publish endpoint (auto-backup to history/), then **GET the API and verify version/counts**. Both dev and prod have this overlay.

### PowerShell engine pitfalls (StrictMode)
- `$x = if ($c) { @(...) } else { @() }` **unrolls a single-element array to a scalar** through the pipeline → `.Count` throws under StrictMode and JSON emits a string instead of an array. Wrap the whole expression: `$x = @(if ($c) { ... } else { })`.
- `Write-Error` inside `catch` under `$ErrorActionPreference='Stop'` is itself terminating and swallows position info. Use `Write-Warning "$_ (at $($_.InvocationInfo.ScriptName):$($_.InvocationInfo.ScriptLineNumber))"` + `throw`.

### Ops
- Deployment package top-level exclude lists don't catch **nested** working artifacts (SoD_Rules regeneration outputs) or root-level test outputs (`coverage.xml`, `pester-summary.json`) — inspect the package listing after changes and strip in a second pass.
- Prod RBAC via PIM can vanish silently (time-boxed activations expire; eligibilities get removed). Before any prod operation: `az group show -n <rg>` first. PIM "My roles → Azure resources → Eligible" shows exactly what can be self-activated vs what must be re-requested — pattern-match sibling RG eligibilities when requesting (`Owner` on `tbg-p-*` RGs).
