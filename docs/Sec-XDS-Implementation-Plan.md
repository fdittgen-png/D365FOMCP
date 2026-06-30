# Implementation Plan — Sec Gap #1: Extensible Data Security (XDS)

Closes gap **#1** of [`Sec-Service-Completeness-Concept.md`](Sec-Service-Completeness-Concept.md):
make the `d365sec` service able to explain **row-level data restrictions** —
why a user sees *no rows* or *limited rows* on a table, as opposed to a
disabled control. XDS is AOT-sourced (`AxSecurityPolicy`), not DMF.

Status: **DRAFT** — written 2026-06-30. Effort: **L** (the substantial gap).
Order in the concept doc: do after #6 (field-level investigate), before #3/#5.

> **Scope framing (must surface in tool output):** XDS filters **data rows**,
> not UI controls. It explains "user sees no / limited data," never a greyed-out
> button. Keep that distinction in every readout so XDS isn't conflated with the
> Grant/Deny entry-point picture from `sec_object_access`.

---

## Step 0 — AOT XML shape  ✅ CONFIRMED (2026-06-30, 121 MS-base policies inspected)

`AxSecurityPolicy` objects live under `*/AxSecurityPolicy/*.xml`. Inspected
against the real metadata at `10.0.2527.130\PackagesLocalDirectory`.

**Distribution:** **121** policies in the Microsoft base, **0** in the custom
layers (iExtension / HISOL / HSAPAC `AxSecurityPolicy` dirs are all empty). So
for this tenant XDS is entirely Microsoft-standard behaviour — but it still
explains real "why do I see no/limited rows" cases, so it's worth capturing.

**Two surprises that changed the schema below:**
1. **No `<Roles>` node.** A policy binds to a *single* role context:
   either `<ContextType>RoleName</ContextType>` + `<RoleName>X</RoleName>`
   (one named role), **or** `<ContextType>RoleProperty</ContextType>` +
   `<ContextString>PolicyForVendorRoles</ContextString>` (a role *property* —
   indirectly many roles; resolving which roles is a follow-up, see §7).
   `ContextString` can also appear **without** a `ContextType`.
2. **Top-level `<ConstrainedTable>` is a Yes/No flag**, *not* the table list.
   The constrained tables are under `<ConstrainedTables>` as 0..n
   `<AxSecurityPolicyConstrainedEntity i:type="…">` nodes, **recursively nested**.
   Two entity types (discriminated by the `i:type` attribute):
   - `AxSecurityPolicyConstrainedTable` — has `<Name>` + `<TableRelation>` (the FK back to the primary table).
   - `AxSecurityPolicyConstrainedExpression` — has `<Name>` + `<Value>` (a join expression like `(PurchReqLine.PurchReqTable == PurchReqTable.RecId)`).
   Each can carry its own nested `<ConstrainedTables>` (unlimited depth).

### Confirmed shape

```xml
<!-- RoleName context, no constrained children -->
<AxSecurityPolicy xmlns:i="...">
  <Name>RetailAssortments</Name>
  <ConstrainedTable>Yes</ConstrainedTable>     <!-- flag, NOT the table list -->
  <ContextType>RoleName</ContextType>
  <Label>@SYP4910103</Label>
  <PrimaryTable>RetailAssortmentTable</PrimaryTable>
  <Query>RetailXDSAssortments</Query>
  <RoleName>RetailStoreManager</RoleName>
  <ConstrainedTables />
</AxSecurityPolicy>

<!-- RoleProperty context, nested constrained tables/expressions -->
<AxSecurityPolicy xmlns:i="...">
  <Name>VendProfileAccount</Name>
  <ConstrainedTable>Yes</ConstrainedTable>
  <ContextString>PolicyForVendorRoles</ContextString>
  <ContextType>RoleProperty</ContextType>
  <Label>@SYS329340</Label>
  <PrimaryTable>VendTable</PrimaryTable>
  <Query>VendProfileAccountPolicy</Query>
  <ConstrainedTables>
    <AxSecurityPolicyConstrainedEntity xmlns="" i:type="AxSecurityPolicyConstrainedTable">
      <Name>CatExternalCatalogVendor</Name>
      <ConstrainedTables />
      <TableRelation>VendTable</TableRelation>
    </AxSecurityPolicyConstrainedEntity>
    <AxSecurityPolicyConstrainedEntity xmlns="" i:type="AxSecurityPolicyConstrainedExpression">
      <Name>ContactPerson</Name>
      <ConstrainedTables> … recursive … </ConstrainedTables>
      <Value>(VendTable.Party = ContactPerson.ContactForParty)</Value>
    </AxSecurityPolicyConstrainedEntity>
  </ConstrainedTables>
</AxSecurityPolicy>
```

| Field | Tag path | Notes |
|---|---|---|
| policy_name | `AxSecurityPolicy/Name` | PK |
| label | `AxSecurityPolicy/Label` | resolve via `rl()` |
| primary_table | `AxSecurityPolicy/PrimaryTable` | the main constrained table |
| query_name | `AxSecurityPolicy/Query` | restricting XDS query (name only) |
| operation | `AxSecurityPolicy/Operation` | `AllOperations` when present (often omitted) |
| context_type | `AxSecurityPolicy/ContextType` | `RoleName` \| `RoleProperty` (only two observed; may be absent) |
| role_name | `AxSecurityPolicy/RoleName` | single role, when `ContextType=RoleName` |
| context_string | `AxSecurityPolicy/ContextString` | role-property id, when `RoleProperty` (or standalone) |
| enabled | `AxSecurityPolicy/Enabled` | `Yes`/`No`, **defaults Yes when omitted** |
| constrained_flag | `AxSecurityPolicy/ConstrainedTable` | Yes/No flag (not the list) |
| constrained entities | `ConstrainedTables/AxSecurityPolicyConstrainedEntity` (0..n, recursive) | `@i:type` = Table (→ `TableRelation`) or Expression (→ `Value`); each has `Name` |

> **Parser note (verified):** `createXmlParser()` (sec-builder.js:225) already
> sets `ignoreAttributes: false` + `attributeNamePrefix: '@_'`, so the
> discriminator lands at `entity['@_i:type']`. Add **`'AxSecurityPolicy'`** and
> **`'AxSecurityPolicyConstrainedEntity'`** to the `isArray` list (:228) so a
> single policy / single child parses as a 1-element array (matching how
> `AxSecurityRole` etc. are handled), letting `ensureArray` work uniformly.
> Belt-and-braces: also branch on presence of `TableRelation` vs `Value` to tell
> the two entity kinds apart, in case the `@_i:type` value carries a namespace.

---

## 1. Schema (`src/azure/sec-builder.js`, `SCHEMA` const ~line 23)

Mirror the `sod_rules` block (sec-builder.js:153) — **two tables** (the role
context is single-valued per policy, so it lives on the policies row; no
separate `security_policy_roles` join table is needed):

```sql
-- Extensible Data Security (XDS) policies. AOT-sourced (AxSecurityPolicy).
-- Filters DATA ROWS for a role context — explains "sees no/limited data",
-- not a disabled control. Each policy has ONE role context: either
-- role_name (ContextType=RoleName) or context_string (ContextType=RoleProperty,
-- a role-property flag set on 0..n roles). query_name is the restricting XDS query.
CREATE TABLE IF NOT EXISTS security_policies (
  policy_name      TEXT PRIMARY KEY,
  label            TEXT,
  primary_table    TEXT,
  query_name       TEXT,
  context_type     TEXT,        -- RoleName | RoleProperty | (NULL)
  role_name        TEXT,        -- single role, when ContextType=RoleName
  context_string   TEXT,        -- role-property id, when RoleProperty (or standalone)
  operation        TEXT,        -- AllOperations when present
  enabled          INTEGER,     -- 1/0 (defaults 1 when <Enabled> omitted)
  constrained_flag TEXT,        -- the top-level ConstrainedTable Yes/No flag
  module           TEXT
);
CREATE INDEX IF NOT EXISTS idx_secpol_primary ON security_policies(primary_table COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_secpol_role    ON security_policies(role_name COLLATE NOCASE);

-- Constrained entities under <ConstrainedTables>, flattened from the recursive
-- AxSecurityPolicyConstrainedEntity tree. entity_type discriminates Table vs
-- Expression; relation_or_value holds TableRelation (Table) or Value (Expression).
CREATE TABLE IF NOT EXISTS security_policy_constrained_tables (
  policy_name       TEXT NOT NULL,
  constrained_table TEXT NOT NULL,  -- the entity <Name> (a table/view)
  entity_type       TEXT,           -- 'table' | 'expression'
  relation_or_value TEXT,           -- TableRelation (FK) or the join Value expr
  depth             INTEGER,        -- 0 = direct child, >0 = nested
  PRIMARY KEY (policy_name, constrained_table, depth)
);
CREATE INDEX IF NOT EXISTS idx_secpol_ct_table ON security_policy_constrained_tables(constrained_table COLLATE NOCASE);
```

> `primary_table` is the policy's main constrained table; the
> `security_policy_constrained_tables` rows are the *additional* joined tables
> the same policy also filters (via FK relation or expression). For "which
> policies touch table T", query both `primary_table = T` and a join on the
> constrained-tables table (see §7).

## 2. Prepared statements (`stmts`, sec-builder.js:558)

```js
// security_policies has 11 columns
insertSecPolicy: db.prepare('INSERT OR REPLACE INTO security_policies VALUES (?,?,?,?,?,?,?,?,?,?,?)'),
// security_policy_constrained_tables has 5 columns
insertSecPolicyTable: db.prepare('INSERT OR IGNORE INTO security_policy_constrained_tables VALUES (?,?,?,?,?)'),
```

## 3. AOT parse pass (inside `aotTransaction`, after `AxSecurityPrivilege`, ~line 688)

`processAxType` (sec-builder.js:616) already works for **any** AOT type via
`findAxDirs` — no new discovery code needed. Add one more block mirroring
`extractRole`/`extractPrivilege`:

```js
// Extensible Data Security policies (XDS / AxSecurityPolicy)
const policyCount = processAxType('AxSecurityPolicy', (parsed, filePath) => {
  const p = parsed.AxSecurityPolicy?.[0] || parsed.AxSecurityPolicy;
  if (!p || !p.Name) return;
  const mod = getModuleFromPath(filePath, packagesPaths);
  // <Enabled> defaults to Yes when omitted (confirmed against the metadata).
  const enabledRaw = p.Enabled;
  const enabled = enabledRaw == null ? 1 : (/^(yes|true|1)$/i.test(String(enabledRaw)) ? 1 : 0);
  stmts.insertSecPolicy.run(
    p.Name, rl(p.Label) || null, p.PrimaryTable || null,
    p.Query || null,
    p.ContextType || null, p.RoleName || null, p.ContextString || null,
    p.Operation || null, enabled, p.ConstrainedTable || null, mod,
  );
  // Flatten the recursive ConstrainedTables tree (0..n, nested to any depth).
  const walk = (node, depth) => {
    for (const e of ensureArray(node?.AxSecurityPolicyConstrainedEntity)) {
      const name = e.Name; if (!name) continue;
      const isExpr = e.Value != null || /Expression/i.test(String(e['@_i:type'] ?? ''));
      stmts.insertSecPolicyTable.run(
        p.Name, name,
        isExpr ? 'expression' : 'table',
        isExpr ? (e.Value ?? null) : (e.TableRelation ?? null),
        depth,
      );
      stats.constrainedTables++;
      if (e.ConstrainedTables) walk(e.ConstrainedTables, depth + 1);  // recurse
    }
  };
  walk(p.ConstrainedTables, 0);
  stats.securityPolicies++;
});
log(`  AxSecurityPolicy: ${policyCount} files processed`);
```

Add `securityPolicies` and `constrainedTables` to the `stats` object init
(sec-builder.js:520) alongside the existing `aot*` counters. Note the PK on
`(policy_name, constrained_table, depth)` — if the same table appears at two
depths within one policy that's fine; `INSERT OR IGNORE` dedups exact repeats.

## 4. Counts + DATA QUALITY CHECK (sec-builder.js:1365 / :1396)

```js
// counts
securityPolicies: db.prepare('SELECT COUNT(*) as n FROM security_policies').get().n,
constrainedTables: db.prepare('SELECT COUNT(*) as n FROM security_policy_constrained_tables').get().n,
```

```js
// checks[] — WARN only when AOT was parsed but produced nothing
{ name: 'security policies present',
  pass: !packagesPathArg || packagesPathArg.toLowerCase() === 'skip' || counts.securityPolicies > 0,
  detail: `${counts.securityPolicies} XDS policies, ${counts.constrainedTables} constrained tables` },
```

Add `securityPolicies` to the metadata `counts` loop (already auto-persists via
the `Object.entries(counts)` loop at :1431) and to the final build-summary log block.

## 5. Search index (Phase 4, sec-builder.js:1334)

Add policies to `sec_search` so `sec_search` finds them:

```js
const policies = db.prepare('SELECT policy_name, primary_table, module FROM security_policies').all();
for (const p of policies) {
  const content = [p.policy_name, p.primary_table, p.module].filter(Boolean).join(' ');
  stmts.insertSearch.run('policy', p.policy_name, p.module, content);
}
```

(FTS5 `rebuild` at :1360 picks these up automatically.) Add `'policy'` to any
object-type allow-list / enum in `sec_search`'s tool if one exists.

## 6. Output schema (`src/azure/output-schemas.js`)

```js
export const secDataPoliciesOutput = z.object({
  query_type: z.enum(['role', 'table', 'user']),
  query_value: z.string(),
  policy_count: z.number(),
  policies: z.array(z.object({
    policy_name: z.string(),
    label: z.string().nullable(),
    primary_table: z.string().nullable(),
    query_name: z.string().nullable(),
    context_type: z.string().nullable(),     // RoleName | RoleProperty | null
    role_name: z.string().nullable(),        // single role (RoleName policies)
    context_string: z.string().nullable(),   // role-property id (RoleProperty)
    operation: z.string().nullable(),
    enabled: z.boolean(),
    module: z.string().nullable(),
    constrained_tables: z.array(z.object({
      table: z.string(),
      type: z.enum(['table', 'expression']),
      relation_or_value: z.string().nullable(),
      depth: z.number(),
    })),
  })),
});
```

## 7. New tool `sec_data_policies` (`src/azure/sec-tools.js`)

Model on `sec_object_access` (sec-tools.js:2157): `registerTool` +
`READ_ONLY_DB_ANNOTATIONS` + `secDataPoliciesOutput.shape` + `formatTextParam` +
typed-first `structuredResult(typed, out, format)`; `emptyResult` for a valid
zero-row query, `notFoundResult('Role'|'Table'|'User', value, suggestions)` when
the named subject doesn't exist.

- **Input** (exactly one of): `role`, `table`, or `user` (+ `format`, `limit`).
- **Resolution**:
  - `table=` → policies where `primary_table = ?` **or** the table appears in
    `security_policy_constrained_tables` (join on `constrained_table`).
  - `role=` → policies where `role_name = ?` (the direct `RoleName` context).
    **Plus** RoleProperty policies that apply via a role property — see the
    role-property caveat below; for Phase A, surface those separately as
    "may also apply via role property `<ContextString>`" rather than claiming
    a definite match.
  - `user=` → resolve the user's effective roles (reuse the sub-role walk from
    `sec_effective_permissions`), then run the `role=` path for each.
- **Output**: per policy — name, label, primary + constrained tables (+type/expr),
  operation, context (type + role_name/context_string), query name, enabled.
  Lead the markdown with the row-vs-control framing note.
- **Guardrail**: if `enabled = 0`, render the policy but flag it `(disabled)` so
  it isn't read as an active restriction.

> **Role-property caveat (Phase A limitation, must surface in output):**
> `RoleName` policies map cleanly to one role. `RoleProperty` policies bind to a
> `ContextString` (e.g. `PolicyForVendorRoles`) which is a *property flag* set on
> role definitions — resolving "which roles carry this property" needs the role's
> own context metadata, which the current `roles` ingest does **not** capture.
> Phase A: store + display the `context_string` and state the limitation. Phase B
> (follow-up): parse the role-property/context flags from `AxSecurityRole` XML
> into a `role_properties(role_id, context_string)` table to make RoleProperty
> policies fully role-resolvable. Document this gap in the tool output and the
> concept doc rather than silently under-reporting.

## 8. Annotations into existing tools

Per the concept doc, add a **note line** (not a hard dependency) to
`sec_effective_permissions` (sec-tools.js:1288) and `sec_permission_trace`
(:1052): when the target object's table is constrained by an enabled policy for
the subject's roles, append
`_ℹ Data restricted by XDS policy "<name>" on table <T> — rows may be filtered even where access is granted._`
Cheap lookup: one indexed query joining `security_policies` (by `role_name`) and
`security_policy_constrained_tables`/`primary_table` (by the target table). For
RoleProperty policies apply the same caveat as §7 (flag as "may apply"). Keep it
additive — these tools must still work against a pre-#1 DB (wrap in a table-exists
probe like the `rdep.resource_type` guard at sec-tools.js:252).

## 9. Tests (3 fixtures + tool tests)

- **`test/sec-builder.test.js`** — new `describe`: synthetic `AxSecurityPolicy`
  XML dir covering all three observed shapes (RoleName/no children;
  RoleProperty/nested table+expression; `<Enabled>No</Enabled>`) → assert
  `security_policies` + `_constrained_tables` populated, `enabled` defaults to 1
  when omitted and 0 for `No`, `entity_type` table-vs-expression split correct,
  and the recursive walk captures nested entities at `depth > 0`.
- **`test/sec-tools.test.js`** — in-memory DB seeded with the two new tables;
  register a fresh server; assert `sec_data_policies` by role / table / user,
  the disabled-policy flag, the RoleProperty "may also apply" framing, schema
  validity, `emptyResult` on no match, `notFoundResult` on a bogus subject. Add a
  case asserting the `sec_effective_permissions` annotation appears when a
  constrained table matches and is **absent** on a DB without the tables (graceful degrade).
- **`test/integration/sec.integration.test.js`** — add the two tables to the
  fixture so the integration server registers cleanly.
- **`test/response-format.test.js`** static scan already enforces the contract on
  the new tool — no change, just keep it green.

## 10. Export / docs

XDS is **AOT-sourced** — no DMF export change, so no runbook / DTA manifest edit
(unlike SoD #2). Update:
- This plan's Step-0 confirmed-shape section.
- `docs/Sec-Service-Completeness-Concept.md` gap #1 → ✅ DONE with the final tag mapping.
- Bump nothing in DMF docs.

## 11. Rebuild + validate + deploy

1. `npm test` green after each of (schema+parse), (tool), (annotations).
2. `npm run build:sec` → confirm DATA QUALITY CHECK `security policies present`
   PASSes and the count is plausible (MS base has many XDS policies; custom
   layers few). Spot-check 2–3 known policies via `sec_data_policies`.
3. This rolls into the **same pending v3 sec DB upload** already blocked on CA
   step-up — no separate deploy. Code ships via the standard
   `Deploy.ps1 -SkipDb -SkipRoles`; the data ships with the next sec DB upload.

---

## Open decisions (from the concept doc — need your call)

1. **Tool surface**: standalone `sec_data_policies` **and** annotations in
   `sec_effective_permissions`/`sec_permission_trace` (this plan does both), or
   annotations only / standalone only?
2. **RoleProperty resolution**: ship Phase A (store `context_string`, flag
   RoleProperty policies as "may apply", document the limit) — or invest now in
   Phase B (`role_properties` table parsed from `AxSecurityRole`) so RoleProperty
   policies are fully role-resolvable? **Recommend Phase A now**, Phase B as a
   fast-follow if vendor/HCM-property policies prove material in practice.
3. **Query body**: capture only the restricting query **name** (this plan), or
   also parse the query's ranges/tables? Parsing the query tree is a much larger
   effort and overlaps with the KB backlog's `AxQuery` item — recommend name-only
   now, defer the tree.
4. **Custom-layer coverage**: confirmed **0** custom XDS policies (all 121 are
   Microsoft-standard). Acceptable to ship covering only the MS base, or is a
   custom XDS policy expected later that should drive a re-test? (No action now;
   noting it so the empty custom layers aren't mistaken for a parse miss.)
