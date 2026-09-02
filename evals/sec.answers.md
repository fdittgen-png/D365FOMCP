# Sec evals — verified answers and the calls that produce them

Verified 2026-09-02 against the local Security snapshot (`~/.claude/d365fo_sec.sqlite`,
build 2026-08-14, 403 roles / 3,118 duties / 20,643 privileges) through
`src/local/mcp-server-sec.js`. Machine form: `sec.calls.json`; replay with
`node scripts/run-evals.mjs sec`. Byte figures are `structuredContent`.

Privacy: every question is about roles, duties, privileges and entry points. No user tool
(`sec_lookup_user`, `sec_find_users_by_role`, `sec_company_users`, `sec_licence_assessment`,
`sec_what_if`) is called anywhere in this set — `test/evals-format.test.js` enforces it.

Naming: roles are keyed by **display name** (`Accounts receivable manager`), not AOT name —
`sec_lookup_role {role_name:"AccountsReceivableClerk"}` is *not found*. Duties and privileges
use AOT names. `sec_search {object_type:role}` is the cheap way to resolve a display name.

| # | Title | Calls | Answer | sc bytes |
|---|---|---|---|---:|
| 1 | CustGroupMaintain: duty and roles via it | `sec_lookup_privilege {privilege_name:CustGroupMaintain, limit:1}` → `parent_duties: [CustCustomerProcessEnable]`, `granting_role_count: 5`; `sec_find_roles_by_privilege {privilege_name:CustGroupMaintain, limit:50}` → `via_chain_count: 5`, all via that duty | **CustCustomerProcessEnable,5** | 1,422 |
| 2 | AR manager: Delete on CustGroup via which privilege | `sec_search {query:"receivable manager", object_type:role, limit:5}` → `Accounts receivable manager`; `sec_permission_trace {role_name:"Accounts receivable manager", object_name:CustGroup, limit:100}` → 17 rows; rows with `object_name:CustGroup` + `grant_delete:Allow` all carry `priv_name: CustGroupMaintain` (once direct, once via CustCustomerProcessEnable) | **CustGroupMaintain** | 5,672 |
| 3 | Shared duties AR manager / Collections manager | `sec_search {query:"collections manager", object_type:role, limit:5}`; `sec_compare_roles {role1:"Accounts receivable manager", role2:"Collections manager", list_limit:1}` → `duties_shared_count: 28` (121 vs 54 duties) | **28** | 1,017 |
| 4 | CustCustomerProcessEnable privileges / CustGroupMaintain entry points | `sec_lookup_duty {duty_name:CustCustomerProcessEnable, limit:20}` → `privilege_count: 9`; `sec_lookup_privilege {privilege_name:CustGroupMaintain, limit:5}` → `entry_point_count: 2` (CustGroup full CRUD, CustGroupDefaultDimension_PSN read) | **9,2** | 2,237 |
| 5 | CustGroupView: duty and every role reaching it (#114 defect 1) | `sec_lookup_privilege {privilege_name:CustGroupView, limit:1}` → `parent_duties: [CustCustomerReferenceDataInquire]`, `granting_role_count: 10`; `sec_find_roles_by_privilege {privilege_name:CustGroupView, limit:50}` → `via_chain_count: 10`, `direct_count: 10`, the **same** 10 roles both ways (the DMF export flattens the duty's privilege onto the role), so the union is 10 and equals `granting_role_count`. Before the fix the lookup said `parent_duty_count: 0, granting_role_count: 0` — the canonical name was bound without `COLLATE NOCASE` against the `custgroupview` row | **CustCustomerReferenceDataInquire,10** | 2,127 |
| 6 | Duty holders without CustGroupView | `sec_find_roles_by_duty {duty_name:CustCustomerProcessEnable, limit:50}` → 5 roles; `sec_find_roles_by_privilege {privilege_name:CustGroupView, limit:50}` → 10 roles via CustCustomerReferenceDataInquire; set difference = Accounts receivable manager, Sales manager | **2** | 2,245 |
| 7 | Collections manager: distinct duty count + role_id (#114 defect 2) | `sec_lookup_role {role_name:"Collections manager"}` → `duty_count: 53`, `role_id: COLLECTIONLETTERCOLLECTIONSMANAGER` (DMF upper-cases it), `sub_roles: []`; `sec_compare_roles {role1:"Collections manager", role2:"Accounts receivable manager", list_limit:1}` → `duties_total_1: 53` (and `duties_shared_count: 28`, question 3). The role has **54** `role_duties` rows: `CollectionLetterCollectionsProcessEnable` and its DMF twin `collectionlettercollectionsprocessEnable`, both Grant. Before the fix `sec_compare_roles` counted the twin twice (54) while `sec_lookup_role` reached 53 only because its exact join to `duties` happened to drop the lowercase row | **53,COLLECTIONLETTERCOLLECTIONSMANAGER** | 16,117 |
| 8 | Second-largest security model and its *manager* roles | `sec_stats {}` → `security_modules[1]: PersonnelManagement (1,716 objects)`; `sec_search {query:manager, object_type:role, modules:[PersonnelManagement], limit:50}` → 6 (Compensation and benefits manager, Human resource manager, Manager, Self-service manager, Payroll manager, Training manager) | **PersonnelManagement,6** | 8,549 |
| 9 | TaxSalesTaxTransactionStatusInquire roles / privileges | `sec_lookup_duty {duty_name:TaxSalesTaxTransactionStatusInquire, limit:1}` → `role_count: 15`, `privilege_count: 115`; `sec_find_roles_by_duty {…, limit:100}` → 15, not truncated | **15,115** | 2,174 |
| 10 | Sales manager on ElectronicMessages | `sec_search {query:"sales manager", object_type:role, limit:5}`; `sec_effective_permissions {role_name:"Sales manager", object_name:ElectronicMessages, limit:50}` → one `ElectronicMessages / MenuItemDisplay` row: `source: direct_priv`, `grant_read: Allow`, `grant_create: null` | **direct_priv,False** | 7,110 |

Findings while verifying (kept OUT of the questions; worth an issue)

- **Fixed in #114 (2026-09-02)** — the two answer-correctness defects this file first
  reported are closed and are now questions 5 and 7. Root cause of both: the snapshot merges
  AOT (mixed-case) and DMF (lower/UPPER-case) rows — 56 `duty_privileges` and 41
  `role_duties` rows match their parent table only `COLLATE NOCASE` — and the tools walked
  them with different collations. Every duty/privilege set and count now comes from one
  canonical walk (`roleDuties` / `dutyRoles` / `privilegeDuties` / `privilegeRoles` in
  `sec-tools.js`). `ElectronicMessageMaintain`, the other privilege in the original report,
  is in **no** duty in this snapshot (the `TaxSalesTaxTransactionsMaintain` attribution came
  from the BPM package in `test/fixtures/test.axtr`, not from the database); it is a direct
  privilege of 4 roles, and `sec_lookup_privilege` now reports those 4 where it reported 0.
- `sec_role_hierarchy {direction:children}` returns 0 entries for every **standard** role
  (Accounts receivable manager, Sales manager, System administrator, …) because Microsoft
  roles carry no sub-roles; the 321 `role_subroles` rows all hang off custom `TIS …` roles
  (`TIS local administrator` 122 children, `TIS AR clerk` 12). Each hierarchy entry now
  carries the related role's `duty_count`, equal to `sec_lookup_role.duty_count` (verified:
  `Accounts receivable clerk` 97 both ways). No hierarchy question — the custom roles are
  environment-specific.
- `sec_object_access {CustGroup, limit:300}` is **151 KB** of `structuredContent` and still
  truncated; the tool is a path lister, not a counter — avoid it for "how many roles" questions.
- `sec_search {query:"Maintain customer groups", object_type:privilege}` does not surface
  `CustGroupMaintain` (its label `@SYS140685` is unresolved in the index), so label-text
  questions were not possible.
