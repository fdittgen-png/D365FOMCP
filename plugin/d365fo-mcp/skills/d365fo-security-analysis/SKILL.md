---
name: d365fo-security-analysis
description: D365FO security model analysis — role→sub-role→duty→privilege→entry-point resolution, Deny-wins semantics, segregation-of-duties (SoD) detection algorithm, duty-native role design, DMF security-entity formats, and audit methods. Use for SoD analysis, compliance audits, role design reviews, or interpreting D365FO security exports.
---

# D365FO Security Analysis Skill

Method knowledge for reasoning about D365FO security. The live data comes from the `d365sec` MCP (`sec_lookup_role`, `sec_permission_trace`, `sec_effective_permissions`, `sec_compare_roles`, …); this skill explains how the model fits together and which conclusions are safe to draw.

## The security model in one screen

```
User ──assigned──▶ Role ──contains──▶ Sub-roles (recursive)
                     │
                     ├──contains──▶ Duty ──contains──▶ Privilege ──grants──▶ Entry point (menu item / service / entity)
                     │                                                          │ permission: Read / Update / Create / Delete / Correct / Invoke
                     └──contains──▶ Privilege (direct)                          └─ Grant or Deny
```

Resolution rules that every answer must respect:

1. **Effective access = union of every path** from the user's roles down to entry points — walk sub-roles recursively, then duties, then direct privileges.
2. **Deny wins.** A single `Deny` on any path overrides every `Grant` for that entry point/table. Report status as *granted / partial / denied*, never just "has role X".
3. **Company scope** comes from the user-role-organization assignment (`ORGANIZATIONTYPE = LegalEntity`, `ORGANIZATIONID = <company>`). A role with no company restriction applies to all companies.
4. **Table permissions can come from an entry point's automatic inference or from explicit table permissions**; only the explicit ones show in the privilege XML. When the tools show no path but the user can see the form, suspect inferred permissions or `AOSAuthorization = None`.
5. **Casing trap:** DMF exports are UPPERCASE (`ACCOUNTSPAYABLECLERK`), AOT names are mixed-case (`AccountsPayableClerk`). Always compare case-insensitively; the MCP does so server-side but your own joins must too.
6. **Licence type** is a property of the role (and of the highest-licence entry point it reaches); a user's licence requirement is the *max* across roles — `sec_licence_assessment` computes it.

Verify before asserting: for any access claim, obtain the actual chain with `sec_permission_trace` (user/role → object) or `sec_effective_permissions`, and quote it. Do not infer from role names.

## Segregation of duties — how to reason

- An SoD *rule* pairs two duties that must not be held by the same user. A *violation* is a user (per company) whose effective duty set contains both — through any role path, including sub-roles.
- Duty-level rules miss privilege-level conflicts (two privileges in one duty) — when auditing, also check whether a single duty already combines the conflicting entry points.
- False positives come from **profile/template roles** and from **disabled users**; filter both before reporting.
- Evidence for an auditor = user, company, the two duties, and the role path to each. `sec_find_roles_by_duty` gives the role side; `sec_find_users_by_role` the user side.

## Reference files (read only the one you need)

- **SoD detection algorithm — lessons learned** → `references/sod-detection-algorithm-lessons-learned-2026-07-06-audit-sod.md` — the exact algorithm, the recursion and casing bugs that produced wrong counts, and how the result was validated against the auditor's list.
- **Duty-native role rewrite + Deny-role architecture** → `references/duty-native-rewrite-deny-role-architecture-lessons-learned-2.md` — designing minimal roles from duties, and using dedicated Deny roles to carve exceptions without cloning standard roles.
- **FDD compliance audit method** → `references/fdd-compliance-audit-method-2026-07-07-session.md` — how to check a functional design's security section against the implemented roles.
- **DMF SoD-rule entity vs auditor CSV/Excel format** → `references/dmf-sod-rule-entity-vs-auditor-csv-excel-format-comparison-d.md` — field mapping between `SystemSegregationOfDutiesRuleEntity` and the spreadsheet auditors deliver; import pitfalls.

## Privacy

Security data names internal employees (user IDs, role assignments). It is internal-only: fine inside the analysis, never pasted into external documents or shared outside the organisation. It never contains customer or vendor data — if a request would pull consumer/vendor party records, stop.
