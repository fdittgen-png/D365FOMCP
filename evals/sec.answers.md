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
| 5 | Accounting manager Update on CustGroup? | `sec_search {query:"accounting manager", object_type:role, limit:5}`; `sec_effective_permissions {role_name:"Accounting manager", object_name:CustGroup, limit:50}` → the two `CustGroup / MenuItemDisplay` rows have `grant_read: Allow`, `grant_update: null` | **False** | 4,994 |
| 6 | Duty holders without CustGroupView | `sec_find_roles_by_duty {duty_name:CustCustomerProcessEnable, limit:50}` → 5 roles; `sec_find_roles_by_privilege {privilege_name:CustGroupView, limit:50}` → 10 roles via CustCustomerReferenceDataInquire; set difference = Accounts receivable manager, Sales manager | **2** | 2,245 |
| 7 | Collections manager licence + role_id | `sec_search {query:"collections manager", object_type:role, limit:5}`; `sec_lookup_role {role_name:"Collections manager"}` → `license_type: Enterprise`, `role_id: COLLECTIONLETTERCOLLECTIONSMANAGER` (DMF upper-cases it) | **Enterprise,COLLECTIONLETTERCOLLECTIONSMANAGER** | 15,716 |
| 8 | Second-largest security model and its *manager* roles | `sec_stats {}` → `security_modules[1]: PersonnelManagement (1,716 objects)`; `sec_search {query:manager, object_type:role, modules:[PersonnelManagement], limit:50}` → 6 (Compensation and benefits manager, Human resource manager, Manager, Self-service manager, Payroll manager, Training manager) | **PersonnelManagement,6** | 8,549 |
| 9 | TaxSalesTaxTransactionStatusInquire roles / privileges | `sec_lookup_duty {duty_name:TaxSalesTaxTransactionStatusInquire, limit:1}` → `role_count: 15`, `privilege_count: 115`; `sec_find_roles_by_duty {…, limit:100}` → 15, not truncated | **15,115** | 2,174 |
| 10 | Sales manager on ElectronicMessages | `sec_search {query:"sales manager", object_type:role, limit:5}`; `sec_effective_permissions {role_name:"Sales manager", object_name:ElectronicMessages, limit:50}` → one `ElectronicMessages / MenuItemDisplay` row: `source: direct_priv`, `grant_read: Allow`, `grant_create: null` | **direct_priv,False** | 7,110 |

Findings while verifying (kept OUT of the questions; worth an issue)

- **`sec_lookup_privilege.parent_duties` is empty for privileges that duties demonstrably
  contain.** `CustGroupView` → `parent_duty_count: 0, granting_role_count: 0`, yet
  `sec_find_roles_by_privilege {CustGroupView}` returns 10 roles via
  `CustCustomerReferenceDataInquire`, and `sec_object_access {CustGroup}` shows the same
  chain. Same for `ElectronicMessageMaintain` (0 parents; the BPM package of
  `test/fixtures/test.axtr` lists it under `TaxSalesTaxTransactionsMaintain`). It works for
  `CustGroupMaintain`. Likely the DMF-uppercase vs AOT-mixed-case join on `duty_privileges`
  (see `project_sec_dmf_data_quirks`). Questions 1 and 4 use `CustGroupMaintain`, where the
  tools agree.
- `sec_lookup_role {Collections manager}.duty_count` is **53** while
  `sec_compare_roles` reports `duties_total_2: 54` for the same role. Question 7 avoids the
  duty count.
- `sec_role_hierarchy {direction:children}` returns 0 entries for every standard role tried
  (Accounts receivable manager, Sales manager, Accounts payable manager, System
  administrator, Chief executive officer, Purchasing manager) and `sec_lookup_role.sub_roles`
  is `[]` — the snapshot appears to carry no sub-role data, so there is no hierarchy question.
- `sec_object_access {CustGroup, limit:300}` is **151 KB** of `structuredContent` and still
  truncated; the tool is a path lister, not a counter — avoid it for "how many roles" questions.
- `sec_search {query:"Maintain customer groups", object_type:privilege}` does not surface
  `CustGroupMaintain` (its label `@SYS140685` is unresolved in the index), so label-text
  questions were not possible.
