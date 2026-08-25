---
description: Runs a D365FO security analysis for a user, role, object, feature/page, user-vs-user comparison, or an additive "grant access" request — full role→duty→privilege→entry-point traces with tooling fallbacks. Use for access investigations, permission gaps, "not authorized" errors, and designing minimal grants.
argument-hint: <UserId | RoleName | access to <object> | grant <user> access to <entity> | compare <A> and <B>>
---

# D365 Security Analysis

## Task
Analyze the security question in `$ARGUMENTS`.
**Done when:** the verdict is backed by an actual permission trace (role → duty → privilege → entry point) rather than role names, findings from tools known to misreport are cross-checked, and the answer ends with UAT verification steps. Separate confirmed grants from concluded ones; flag anything the tools could not verify (final confirmation belongs in the UI Security diagnostics).

Deep background (tool quirks, corrupt-table caveats, walk methodology): `the `d365fo-security-analysis` skill`.

## Workflow — detect analysis type from $ARGUMENTS

**If user ID**:
- Parallel: `d365sec:sec_lookup_user` (roles, companies, enabled status) + `d365sec:sec_effective_permissions` (flattened set)
- Present: profile, roles with duty breakdown, permissions summary. Offer object-specific check.
- For rejoining/reactivated users with login failures: compare the Entra Object ID against D365's Telemetry ID before touching roles — a stale GUID, not a role gap, is the common cause.

**If role name**:
- Parallel: `d365sec:sec_lookup_role` + `d365sec:sec_role_hierarchy` + `d365sec:sec_find_users_by_role`
- Present: role structure (duties → privileges → permissions), user count, hierarchy. Offer `sec_compare_roles`.

**If "access to <object>"**:
- `d365sec:sec_object_access` — authoritative reverse trace including **Deny (⛔) paths**. Primary tool.
- `d365kb:d365_lookup_table` for table context; `d365sec:sec_permission_trace` only as cross-check (it joins through `duty_privileges`, which can be corrupt).
- Present: every grant path and any Deny path, plus users holding those roles.

**If a feature/page name (not a table/menu item)** — e.g. "Cycle count plan":
FTS `sec_search` is unreliable for this; resolve the securable object first:
1. `d365sec:sec_raw_sql`: `SELECT privilege_name, label FROM privileges WHERE lower(label) LIKE '%<feature>%'`
2. `d365sec:sec_raw_sql`: `SELECT privilege_name, object_name, object_type FROM privilege_entry_points WHERE privilege_name IN (...)`
3. Then run the object analysis above with `sec_object_access(menuItem)`.

**If "compare <userA> and <userB>" / "why does X work for A but not B"**:
- `sec_lookup_user` on each (parallel) → diff role sets in a table
- `sec_effective_permissions(user, object)` for each (parallel) → net verdict per user
- **If both are granted, it is NOT a role gap** — say so and pivot to non-security causes: navigation/personalization (a recording showing `SysGenBlankWorkspaceCanvas` from a `UserWS…` tile = broken dashboard tile, not auth), company/legal-entity context, or a missing User→Worker/Person link. Confirm the symptom: *blank page* ≠ *"You are not authorized"*.

**If "grant <userId> access to <entity/object>"** (additive change) — this sequence is order-critical, follow it exactly:
1. Normalize the object name — strip `Entity` and version suffixes (`V2`, `V3`). The security DB indexes menu items and tables, not data entity names (`ProductAttributeValuesV3` → `EcoResProductAttributeValue`).
2. **Anchor to current state first** (parallel): `sec_lookup_user` + `sec_effective_permissions(userId, normalizedObject)`.
3. Already granted → report that no change is needed (common outcome).
4. If a gap exists, **survey existing reuse before designing** (parallel): `sec_object_access(normalizedObject)` — which roles in THIS tenant already grant it (watch for custom read-only patterns like `TOC Read Only`, `*_ReadOnlyRole`) + `sec_search(object_type="role", query="read only")`.
5. Design a custom role only if nothing fits. Direct privileges without duty wrappers to stay read-only.
6. Recommend ranked: existing tenant read-only role → OOB role (only if not overgranting CUD) → new minimal custom role (last resort, exact privilege list). Call out license impact, overgrant beyond the requirement, and company scope.

## Tooling fallbacks
- **Object-name ladder** on schema errors from `sec_object_access`/`sec_effective_permissions`: (1) normalized table name, (2) menu item name, then stop — switch to `d365kb:d365_get_entity_sources(entityName)` to discover the correct objects and resume.
- A `no such column` error means the sec server build/connection is stale, not a bad object name. Re-test once after reconnect; if it persists, fall back to `sec_raw_sql` and say so in the answer.
- `sec_raw_sql`: **aggregate, never enumerate** (one row per role via `count`/`GROUP BY` — role×privilege cross-joins overflow the token limit); no `group_concat` over unbounded columns; query must start with `SELECT`/`WITH`; keyword-bearing literals (`'…update'`) need a `LIKE` prefix. Sanity-check `duty_privileges` (a known-small duty should map to few privileges) before trusting any role list derived from it.
- Empty `entry_points` on a privilege = table/code-level enforcement, not a gap.

## Always end with
- Summary table of findings, with confirmed vs concluded clearly separated
- Gaps or over-provisioning detected, if any
- Verification steps to run in UAT before prod (exact OData calls expected to return 200, or the Security diagnostics path)
