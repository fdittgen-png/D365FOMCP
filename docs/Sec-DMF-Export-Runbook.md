# Security DMF export project — for the MCP Security DB

Defines a clean, reliable DMF export project (`SecAnalysis_MCP`) that feeds
`build/build-sec.js`. Supersedes the ad-hoc `SecAnalysis_allCompanies` project —
this one exports **exactly** what the build consumes, with the correct filenames,
fields, and the one filter that matters.

## Principles (why these entities)
- **Grants are derived** from the AOT parse (PackagesLocalDirectory → roles, duties,
  privileges, **entry points**). The DMF export supplies what AOT can't: **user
  assignments, company scoping, and the ground-truth effective permission matrix
  (incl. runtime customizations + Deny)**.
- The build matches files **by name** (`findDmfFile`). A wrong name = silent skip.
- `System Security Permissions` is the **fully-exploded effective matrix** — the most
  reliable source for "what a role can actually do on object X" (it covers ~2.5× more
  resources than the AOT entry-point graph and includes Invoke + runtime denies).

## Entities to include (Format = **XML-Element** for all)

| # | DMF entity | Exported filename (must match) | Feeds build table |
|---|------------|--------------------------------|-------------------|
| 1 | System Security Role | `System Security Role.xml` | `roles` |
| 2 | System Security Sub Role V2 | `System Security Sub Role V2.xml` | `role_subroles` |
| 3 | System Security Role Duty | `System Security Role Duty.xml` | `role_duties` (role→duty) |
| 4 | System Security Privilege | `System Security Privilege.xml` | `role_direct_privileges` |
| 5 | **System Security Permissions** | `System Security Permissions.xml` | **`role_direct_entity_permissions`** (the effective matrix + Deny) |
| 6 | User information | `User information.xml` | `users` |
| 7 | Security user role association *(or `SystemSecurityUserRoleEntity`)* | `Security user role association.xml` | `user_roles` |
| 8 | SystemSecurityUserRoleOrganizationEntity | `SystemSecurityUserRoleOrganizationEntity.xml` | `user_role_companies` |
| 9 | Security segregation of duties rule *(`SystemSegregationOfDutiesRuleEntity`)* | `Security segregation of duties rule.xml` | `sod_rules` (gap #2 — live SoD rules) |

> **Entity #9 (SoD rules)** is small and needs no filter. When present it
> populates `sod_rules`, which `sec_sod_check`/`sec_what_if` prefer over the
> external `SOD_RULES_FILE` JSON. `findDmfFile` matches the filename
> case-insensitively, so label-casing differences between exports are tolerated.

### Do NOT include
- **`Security privilege metadata customizations entity`** — the build has no parser for
  it (it would be a silent no-op). Drop it unless/until the build is taught to consume it.
- **`System Security Duty` (V1)** — ~27 GB of Cartesian-noise duty→privilege pairs.
  Duty→privilege comes from the **AOT parse**, which is authoritative since the
  2026-04-17 casing fix. Skip V1.
- **`System Security Duty V2`** — exports no data in this environment; harmless to omit
  (AOT supplies duty→privilege). The build logs an expected "not found" note.

## The one filter that matters — on entity #5 only
On **System Security Permissions**, add **one** query-range **expression** (Inquiry →
Range). Plain multi-line ranges AND together, so cross-field OR needs an expression.
Toggle **Show system names = Yes** first to confirm the field names.

**Keep only rows with at least one defined access** (drop all-unset noise; the entity
usually does this already, but make it explicit):
```
((ReadAccess != 0) || (CreateAccess != 0) || (UpdateAccess != 0) || (DeleteAccess != 0) || (CorrectAccess != 0) || (InvokeAccess != 0))
```
Result for this tenant: ~415K rows / ~200 MB (vs ~27 GB unfiltered). No role-name
filter — capture **all roles** so denies in normally-named roles aren't missed.

> The build also drops all-zero rows defensively at ingest, so this filter is belt-and-suspenders.

### Fields to keep on #5 (data quality)
Ensure these survive the export (XML-Element keeps all entity fields by default):
`SECURITYROLEIDENTIFIER`, `SECURITYROLENAME`, `RESOURCENAME`, **`RESOURCETYPE`**
(MenuItemAction/Display/Output, Table… — now consumed by the build and needed to tell a
*button* from a form/table), and the six `*ACCESS` codes (`0`=Unset, `1`=Grant, `2`=Deny).

## Run → build → verify
1. Export `SecAnalysis_MCP`; **extract the package fully** into a stable folder (not a temp dir).
2. Confirm filenames match the table above (no project prefix, no nested zip).
3. Build against the **full** PackagesLocalDirectory:
   ```
   npm run build:sec "<PackagesLocalDirectory>" "<extracted folder>"
   ```
4. Read the build's **DATA QUALITY CHECKS** block — every line should be `[PASS]`:
   - duties have privileges · entry points carry Invoke · direct entity permissions present · resource_type captured · labels loaded · SoD rules from D365.
   A `[WARN]` means investigate before uploading. (The **SoD rules** check WARNs
   until entity #9 is added to the export — until then `sec_sod_check` falls back
   to the `SOD_RULES_FILE` JSON.)
5. Re-upload (now integrity-checked):
   ```
   .\local-deploy\Deploy.ps1 -SkipCode -SkipRoles -Databases sec
   ```

## Reconciliation guard (drift detection, optional but recommended)
Periodically run, against live F&O, to prove no Deny hides in an unexpected place — it
should return **0 rows**:
```sql
SELECT SECURITYROLENAME, COUNT(*) deny_rows
FROM   <System Security Permissions source>
WHERE  ReadAccess=2 OR CreateAccess=2 OR UpdateAccess=2
    OR DeleteAccess=2 OR CorrectAccess=2 OR InvokeAccess=2
GROUP BY SECURITYROLENAME;   -- review the list; alert if it changes unexpectedly
```
