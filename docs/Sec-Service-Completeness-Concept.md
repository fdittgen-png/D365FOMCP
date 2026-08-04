# Concept: Complete the MCP Security Service (gaps #1–#6)

Implementation concept for closing the remaining gaps so the D365FO MCP Security
service can explain **any** access decision. Written 2026-06-10 to start build
tomorrow. Grounded in the AOT metadata at PackagesLocalDirectory (app 10.0.2263.202)
and the validated v3 build (`d365fo_sec_20260610_v3.sqlite`).

## Baseline (already done this session — do not redo)
Role → sub-role → duty → privilege → **entry-point** (29,126; all 6 access levels incl.
Invoke), direct privileges, and the **effective permission matrix**
(`role_direct_entity_permissions`: 391,101 rows / 377 roles / 33,497 resources;
**deny-wins** merge; **resource_type**). Tools resolve Deny-over-Grant with
granted/partial/denied status. Build emits DATA QUALITY CHECKS. Validated to within
25 rows of live (`SecurityPermissions` OData count 415,223 vs export 415,198 = drift).

## Cross-cutting rules (apply to every gap)
- Schema change → update `SCHEMA` in `src/azure/sec-builder.js`, the 3 test fixtures
  (`test/sec-tools.test.js`, `test/integration/sec.integration.test.js`,
  `test/sec-builder.test.js`), and add a DATA QUALITY CHECK.
- New tool → `registerTool` + `outputSchema` (in `output-schemas.js`) + `structuredResult`
  (typed-first) + `READ_ONLY_DB_ANNOTATIONS` + `##` heading + freshness banner; mirror the
  response-format contract (the static-scan test enforces it). Add tests.
- Export/DMF change → update `docs/Sec-DMF-Export-Runbook.md` + `docs/dmf/SecAnalysis_MCP.dta.xml`.
- Finish each gap green (`npm test`) before the next. Rebuild + re-validate at the end.

> Note: gap #2 (live SoD rules) was descoped — SoD is now a separate project and
> no longer a feature of the MCP Security service.

---

## #4 — Label resolution  (effort: S · do FIRST, quick win)
**Root cause (confirmed):** `loadLabels()` in `sec-builder.js` does a non-recursive
`readdirSync` on each `AxLabelFile` dir, but the files are nested at
`AxLabelFile/LabelResources/<locale>/<name>.<locale>.label.txt`. It also matches
`'en-US'` case-sensitively while some packages ship `en-us`. → `Labels loaded: 0`.
**Fix:** in `loadLabels`, walk into `LabelResources/**` (recursive) and match locale
case-insensitively (`/en-us/i`). Keep the `=`-split parser.
**Schema/tools:** none — labels already resolve into `roles/duties/privileges.label`
at build; `makeLabelResolver` handles `@SYS` at query time.
**Acceptance:** build log `Labels loaded: > 0`; `sec_lookup_role/duty/privilege` show
human text, no raw `@SYS…`. Add a DATA QUALITY CHECK `labels_loaded > 0`.

## #2 — (descoped)
Segregation of Duties (SoD) analysis has been **extracted into a separate
project** and is no longer part of the MCP Security service. Gap #2 is
intentionally left absent to avoid renumbering the other gaps and breaking
cross-references.

## #6 — Field-level security  (effort: S · do THIRD — likely investigate-only)
**Step 0:** determine whether FLS is actually used (rare). Check if the permission
matrix / entry points carry field-grain rows (object_type at field level) or if D365
field security is in a separate construct.
**Likely outcome:** resource-level coverage is sufficient; document FLS as
not-applicable, or add a thin `field_permissions` table only if real data exists.
**Acceptance:** either a populated `field_permissions` table or a documented decision
that FLS isn't in use for this tenant.

## #1 — Extensible Data Security (XDS / data policies)  (effort: L · the big one)
**Source (confirmed exists):** AOT `AxSecurityPolicy` objects (many under
`*/AxSecurityPolicy/*.xml`). Sample shape: `Name, PrimaryTable, ConstrainedTable,
Operation, Query`. Step 0 (first task): read 2–3 role-contexted policies to capture the
**role context** shape (ContextType = RoleName / RoleProperty / ContextString, the
`Roles` node, enabled flag, ConstrainedTable cardinality 1..n).
**Schema:**
- `security_policies(policy_name, label, primary_table, context_type, context_role, operation, enabled, module)`
- `security_policy_constrained_tables(policy_name, constrained_table)`
**Build:** add `processAxType('AxSecurityPolicy', …)` parsing the above (mirror the
Role/Duty/Privilege pattern). Add to the AOT phase (it's AOT-sourced, not DMF).
**Tools:** new `sec_data_policies` — input role | table | user; returns applicable XDS
policies, the constrained tables, and the role context. Add a note line into
`sec_effective_permissions`/`sec_permission_trace` when the target object's table is
constrained by a policy for the subject's roles ("data restricted by policy X").
**Scope note:** XDS filters **data rows**, not UI controls — it explains "user sees
no/limited data," not a disabled button. Keep that framing in the tool output.
**Acceptance:** policies + constrained tables queryable; for a role/table, list the XDS
policies that apply; DATA QUALITY CHECK `security_policies > 0`.

## #3 — Entra-group / rule-based role assignments  (effort: M · partially blocked)
**Finding:** NO standard DMF entity for Entra-group→role mapping was found in the
package scan. So this is **not** a simple export add.
**Step 0 (investigate):** locate where group/rule assignments are stored —
`SecurityUserRole` rows representing groups, `OMUserRoleOrganization`, automatic role
assignment rules (`SecurityRoleAssignmentRule`?), or the Security-configuration tables.
Determine if any is DMF/OData-exposed.
**Hard limit:** even with role→group mappings, **group MEMBERSHIP lives in Entra, not in
D365** — resolving "which users" via a group needs Microsoft Graph. So:
- Phase A (in scope): capture role→Entra-group mappings if a source exists →
  `role_aad_groups(role_id, aad_group_id, aad_group_name)`; tools flag "also granted via
  Entra group X."
- Phase B (out of scope for now): Graph lookup of group membership to enumerate users.
**Acceptance:** role→group mappings captured and surfaced where a source exists; the
Graph-membership limitation documented in tool output.

## #5 — Button → securable-object resolver (cross-service)  (effort: M–H)
**Goal:** map a screenshot control/label → the menu item it secures → `sec_object_access`.
**Step 0:** determine where the form-control→menuitem binding lives — KB form metadata
(does the KB DB carry form controls + their `MenuItemName`?) or XRef references (a form's
button → menu item reference). Pick the available source.
**Design:** a resolver (skill or a new tool) that chains: KB/XRef (control/label → menu
item object) → `sec_object_access` (who grants/denies it, with Invoke). Likely a
cross-service **skill** orchestrating existing tools rather than a single new MCP tool.
**Acceptance:** given a form + button label, return the securable menu item + its
grant/deny/Invoke picture; if the binding can't be resolved, say so explicitly.

---

## Suggested order for tomorrow
1. **#4 labels** (root cause known — ~30 min, improves all readouts).
2. ~~**#2 SoD rules**~~ — descoped (SoD extracted to a separate project).
3. **#6 field-level** (investigate; likely document-only).
4. **#1 XDS** (the substantial piece: sample-read → schema → AOT parse → `sec_data_policies` tool → tests).
5. **#3 Entra-group** (investigate storage; implement Phase A if a source exists).
6. **#5 button resolver** (confirm KB/XRef binding source; build the cross-service skill).
7. **Rebuild + revalidate + DATA QUALITY CHECKS green; then deploy (with the upload integrity check).**

## Open decisions (for the user)
- **#3:** accept Phase-A-only (mappings, no Graph membership) for now? 
- **#1:** is `sec_data_policies` a standalone tool, or folded into `sec_effective_permissions` as annotations, or both?
- **Deploy cadence:** ship #4 quickly (small, safe), or batch the remaining gaps then one deploy?
