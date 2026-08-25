---
name: d365fo-mcp-workflows
description: Efficient multi-tool orchestration recipes for the D365FO MCP services — 14 named workflows (table deep dive, field investigation, impact analysis, security audit, migration-defect RCA, field-wiper hunt…), raw-SQL guardrails, anti-patterns, cost-efficiency rules. Use when planning which MCP tools to call and in what order.
---

# D365FO MCP Tool Orchestration Workflows

## Contents
- Overview
- Service Map (Quick Reference)
- Workflow 1: Table Deep Dive
- Workflow 2: Field Investigation
- Workflow 3: Impact Analysis (Before Modification)
- Workflow 4: Method Tracing
- Workflow 5: Security Audit
- Workflow 6: Research a D365 Topic
- Workflow 7: Data Entity Mapping
- Workflow 8: Enum Resolution
- Workflow 9: Class Extensibility Analysis
- Workflow 10: Parse Task Recording
- Workflow 11: Test Case Documentation from Recording
- Workflow 12: Caching / Timing Bug Diagnosis (fails once, retry succeeds)
- Workflow 13: Migration-Defect RCA via DMF Entity Validation Depth
- Workflow 14: "Who wipes/writes this field?" (system overwrites a user-entered value)
- Raw SQL guardrails (`*_raw_sql` on d365sec / d365kb / d365xref)
- Anti-Patterns (Do NOT Do)
- Cost-Efficiency Rules

## Overview

This skill defines efficient multi-tool workflows for the 5 MCP service families. The goal is minimum tool calls for maximum insight. Always run independent calls **in parallel**.

---

## Service Map (Quick Reference)

| Need | Service | Best Starting Tool |
|------|---------|-------------------|
| Table/field metadata | d365kb | `d365_lookup_table` |
| "Does this field exist?" | d365kb | `d365_check_field_exists` |
| Enum values | d365kb | `d365_get_enum` |
| Join keys between tables | d365kb | `d365_get_join_keys` |
| Who calls/uses X? | d365xref | `xref_find_references` or `xref_find_method_callers` |
| What does X depend on? | d365xref | `xref_find_usages` |
| Class hierarchy | d365xref | `xref_class_hierarchy` |
| Change impact | d365xref | `xref_impact_analysis` |
| User permissions | d365sec | `sec_lookup_user` |
| Role contents | d365sec | `sec_lookup_role` |
| "Can user X use object/button Y?" (net verdict) | d365sec | `sec_effective_permissions(user, object)` |
| "Who can — or is blocked from — object Y?" (incl. Deny) | d365sec | `sec_object_access(object)` |
| "Who can access table X?" | d365sec | `sec_permission_trace` |
| D365 concepts/how-to | d365rag | `rag_ask` or `rag_search` |
| Parse task recording | d365taskrecorder | `taskrecorder_to_markdown` |
| Microsoft docs | Microsoft Learn | `microsoft_docs_search` |
| Code samples | Microsoft Learn | `microsoft_code_sample_search` |

---

## Workflow 1: Table Deep Dive

**When:** User asks about a table, its structure, or how it's used.

```
PARALLEL:
  d365_lookup_table(tableName)           -- fields, indexes, relations
  xref_object_summary(objectName)        -- who references this table

THEN (if user needs security):
  sec_permission_trace(objectName)       -- who has access
```

**Do NOT** call `d365_search` if you already know the exact table name. Go straight to `d365_lookup_table`.

---

## Workflow 2: Field Investigation

**When:** User asks "what is field X on table Y" or "who uses field X".

```
PARALLEL:
  d365_check_field_exists(tableName, fieldName)   -- confirms existence + type
  d365_field_renames(fieldName)                    -- was it renamed from AX2012?
  xref_find_field_usages(tableName, fieldName)     -- who reads/writes it

THEN (if enum type):
  d365_get_enum(enumName)                          -- resolve enum values
```

---

## Workflow 3: Impact Analysis (Before Modification)

**When:** User plans to modify a table, field, class, or method.

```
PARALLEL:
  xref_impact_analysis(objectName)                 -- all downstream consumers
  d365_lookup_table(tableName) OR                   -- current structure
    d365_get_class_methods(className)
  xref_find_extensions(objectName)                  -- CoC extensions on it

THEN (if cross-module):
  xref_cross_module_deps(moduleName)               -- module boundary crossings
```

---

## Workflow 4: Method Tracing

**When:** User asks "who calls method X" or "what does method X call".

```
PARALLEL:
  xref_find_method_callers(className, methodName)  -- incoming calls
  xref_method_references(className, methodName)    -- outgoing calls from this method
  d365_get_method_source(className, methodName)    -- source code (KB)
```

---

## Workflow 5: Security Audit

**When:** User asks about a user's permissions, role analysis, or access control.

**Authoritative-first rule:** for "can a user use object Y" and "who grants/denies object Y", the dedicated tools `sec_effective_permissions` (net verdict, applies Deny-over-Grant) and `sec_object_access` (reverse trace incl. ⛔ Deny paths) are the **primary** path. They are authoritative. Reach for `sec_raw_sql` / `sec_find_roles_by_privilege` only as a fallback — those join through `duty_privileges`, which has been seen corrupted (every duty → ~17k privileges); see "Raw SQL guardrails" below.

```
For a USER:
  sec_lookup_user(userId)                           -- roles assigned, companies, enabled
  sec_effective_permissions(userId, objectName)     -- NET verdict on the object/button

For a ROLE:
  sec_lookup_role(roleName)                         -- duties in role
  sec_role_hierarchy(roleName)                      -- parent/child roles
  sec_find_users_by_role(roleName)                  -- who has this role

For an OBJECT (who can/can't use it):
  sec_object_access(menuItemOrTable)                -- every role/duty/privilege + Deny paths

For comparing:
  sec_compare_roles(role1, role2)                   -- side-by-side diff (roles, not users)
  -- to compare two USERS: sec_lookup_user on each, then diff role sets in your head/table
```

### Workflow 5c: Find the securable object behind a UI feature

**When:** the user names a *feature/page* ("Cycle count plan") but you need the menu item / form to query security.

`sec_search` FTS is unreliable for this — searching "cycle count" surfaced only *work-review* objects, not the plan form. Instead:

```
sec_raw_sql:  SELECT privilege_name, label FROM privileges
              WHERE lower(label) LIKE '%cycle count plan%'      -- find the privileges
sec_raw_sql:  SELECT privilege_name, object_name, object_type   -- find the menu item/form
              FROM privilege_entry_points WHERE privilege_name IN (...)
THEN sec_object_access(menuItemName)                            -- authoritative role/deny trace
```

The AOT menu item (e.g. `WHSCycleCountPlan` / `WHSCycleCountPlanListPage`) is what you pass to `sec_object_access` / `sec_effective_permissions`.

### Workflow 5d: "Works for user A, fails for user B"

**When:** a feature works for one user and not another. Do **not** assume a missing role.

```
PARALLEL:
  sec_effective_permissions(userA, object)
  sec_effective_permissions(userB, object)
```
- If B is **denied** → trace with `sec_object_access(object)` for the Deny path; check B's Deny roles.
- If **both are granted** → it is NOT a role gap. Pivot to non-security causes:
  - **Navigation / personalization** — a recording showing `SysGenBlankWorkspaceCanvas` opened from a `UserWS…` tile = a broken/empty dashboard-tile or workspace, not authorization. Use the proper menu path instead.
  - **Company / legal-entity context** — the granting role may be company-scoped to a company the user isn't in (note: an all-company role grant applies everywhere).
  - **User → Worker/Person link** — many WHS/mobile forms need it; a user whose `person_name` looks like the user id (not a real name) is suspect.
- Confirm the exact symptom: *blank page* ≠ *"You are not authorized"*. Only the latter is security.

### Workflow 5a: Additive Permission Change (grant existing account access to new entity)

**When:** "User X needs access to OData entity Y" / "grant integration account permission to read Z" / "what roles does this service user need to also see W".

**Critical:** *Check current state BEFORE prescribing a solution.* Do not design custom roles until you have confirmed (a) what the account already has, and (b) whether an existing tenant role already covers the gap.

```
STEP 1 — Anchor to current state (PARALLEL):
  sec_lookup_user(userId)                           -- what roles are already assigned?
  sec_effective_permissions(userId, objectName)     -- is access already granted indirectly?

STEP 2 — If gap confirmed, survey existing reuse (PARALLEL on underlying menu item/table):
  sec_object_access(menuItemOrTableName)            -- which roles already grant this?
  sec_search(object_type="role", query="read only") -- look for curated tenant read roles

STEP 3 — Only if no existing role fits:
  sec_find_roles_by_privilege(privilegeName)        -- verify OOB role options
  Design custom role with minimal direct privileges
```

**Recommendation ranking (prefer top first):**
1. **Existing tenant-custom read role** (e.g., `TOC Read Only`, `*_ReadOnlyRole`) — consistent with governance pattern
2. **OOB role** — only if it does not overgrant (check Create/Update/Delete privileges)
3. **New custom role** — last resort; use direct privileges without duty wrappers to keep read-only

**Anti-pattern for this workflow:** writing a "recommended custom role" in the first response before calling `sec_lookup_user`. Always anchor to the account's current state first — otherwise the delta is unknown.

### Workflow 5b: Object Name Granularity for Security Queries

`sec_object_access` and `sec_effective_permissions` index **menu items and tables**, not data entity names. Entity names (e.g., `EcoResProductAttributeValuesV3Entity`) frequently return schema validation errors.

| User asks about | Pass to tool | Notes |
|---|---|---|
| OData entity `ProductAttributeValuesV3` | underlying table `EcoResProductAttributeValue` | strip `Entity` suffix, drop `V2`/`V3` variants |
| Form-based access | form name or menu-item name | e.g., `EcoResAttribute` not `EcoResAttributeEntity` |
| Table access | table name | native granularity |
| "Access to this entity" | menu item that exposes it | look it up via `d365_get_entity_sources` first |

**Fallback order if the first object name returns a schema error:**
1. Retry once with the underlying table name (drop `Entity`, `V2`, `V3`)
2. If still failing, drop to `sec_object_access` on the menu item (UI path)
3. Stop retrying after 2 attempts — per feedback memory, broken MCP tools should not be hammered

---

## Workflow 6: Research a D365 Topic

**When:** User asks a conceptual question about D365 functionality.

```
PARALLEL:
  rag_ask(question)                                 -- D365 documentation corpus
  microsoft_docs_search(query)                      -- official Microsoft docs

THEN (if need code):
  microsoft_code_sample_search(query, language)     -- code examples

THEN (if need full article):
  microsoft_docs_fetch(url)                         -- fetch specific doc page
```

---

## Workflow 7: Data Entity Mapping

**When:** User asks about a data entity, its fields, or staging behavior.

```
PARALLEL:
  d365_get_entity_sources(entityName)              -- field-to-datasource mapping
  d365_lookup_table(primaryTableName)              -- backing table structure
  xref_find_references(entityName)                 -- who uses the entity
```

---

## Workflow 8: Enum Resolution

**When:** User sees numeric values and needs names, or vice versa.

```
d365_get_enum(enumName)                            -- single call, all values

If enum name unknown:
  d365_check_field_exists(tableName, fieldName)    -- reveals EDT/enum type
  THEN d365_get_enum(enumName)
```

---

## Workflow 9: Class Extensibility Analysis

**When:** User wants to extend or customize a class.

```
PARALLEL:
  d365_get_class_methods(className)                -- available methods
  xref_class_hierarchy(className)                  -- inheritance chain
  xref_find_extensions(className)                  -- existing CoC extensions
  xref_find_event_handlers(className)              -- existing event handlers
```

---

## Workflow 10: Parse Task Recording

**When:** User uploads or references a .axtr file and wants to understand what was recorded.

```
taskrecorder_to_markdown(file_content, file_name)   -- single call, returns full Markdown

THEN (if user asks about specific tables/forms from the recording):
  PARALLEL:
    d365_lookup_table(tableName)                     -- table structure from Data Sources section
    sec_permission_trace(formName)                   -- who can access the forms used
    xref_find_references(formName)                   -- how the form is connected

THEN (if user asks about security roles from the recording):
  sec_lookup_role(roleName)                          -- drill into roles from Security Roles section
```

**Key:** The recording Markdown includes Data Sources and Security Roles from the BPM package. Use those as inputs to drill deeper with KB/XRef/Security tools.

---

## Workflow 11: Test Case Documentation from Recording

**When:** User wants to generate test documentation or understand a business process from a recording.

```
taskrecorder_to_markdown(file_content, file_name)   -- get the structured Markdown

THEN (use the Recorded Steps section to):
  - Identify the business process being tested
  - Extract data entry values as test data
  - Map navigation flow to process steps
  - Identify validation checkpoints

THEN (enrich with context):
  PARALLEL:
    rag_ask("how does [process] work in D365FO")    -- conceptual background
    d365_lookup_table(primaryTable)                  -- understand data model behind the steps
```

---

## Workflow 12: Caching / Timing Bug Diagnosis (fails once, retry succeeds)

**When:** A report/process fails on first execution (blank field, missing value) but succeeds on retry, and the failure is environment-specific (e.g. PROD only, not TEST/UAT) or order-type-specific.

**Anti-pattern to avoid first:** don't default to "it's a lazy-read/cache timing race" as the *only* hypothesis. A bug in a connector/ISV's own code (e.g. a LaserNet query-caching layer) is environment-*agnostic* if the connector version is identical everywhere — it cannot by itself explain a PROD-only symptom. Any "it's this code's fault" theory needs a paired "and here's why only this environment/order-type triggers it" argument (data freshness, AOS topology, execution context), or it doesn't survive a symptom cross-check.

```
STEP 1 — Pull real metadata for every table in the chain (PARALLEL):
  d365_lookup_table(table1), d365_lookup_table(table2), ...
  → read cache_lookup ("Found" = exact-key cache only; "EntireTable" = always warm;
    "NotInTTS" = never cached), clustered_index vs alternate key shape, is_customized

STEP 2 — Flag composite/temporal keys as the load-bearing detail:
  - A clustered/alternate key that is a SINGLE column (e.g. RecId, natural id) is a clean
    "Found"-cache hit — not the source of a first-time-blank symptom.
  - A composite key including a date field (e.g. (Location, ValidFrom)) + EDTs
    EffectiveDateTime/ExpirationDateTime = a genuine validTimeState (temporal) table.
    "Found" cache can only serve an EXACT (key, date) pair already asked for — it can
    never answer "whichever row is valid right now" from cache cold. This is usually
    the more precise, more testable explanation than a vague "lazy read" theory.
  - A composite key spanning a junction/role table (e.g. (Site, Location)) with
    multiple boolean flags (IsPrimary/IsDefault/...) signals a row-ambiguity risk
    class, distinct from a caching class — check for it, but note SQL plan caching
    doesn't change which row wins a tie, so it rarely explains a *retry-fixes-it*
    pattern on its own.

STEP 3 — Cross-check every hypothesis against ALL symptoms before presenting it:
  - Does it explain why environments with less traffic/no scale-out never fail
    (not just why the failing environment fails)?
  - Does it explain why a DIFFERENT report/table touching the SAME underlying data
    (e.g. a simpler direct-FK path elsewhere) never shows the bug?
  - Does it explain why retry is *deterministic*, not just "maybe" fixed?
  A hypothesis that only covers the failure case, not the never-fails and
  fixed-on-retry cases too, is incomplete — say so explicitly rather than
  presenting it as the answer.

STEP 4 — If an ISV/connector is involved, search its own release notes/docs
  (WebSearch) for the exact class of data (e.g. "valid time state" / date-effective
  address data) before assuming a generic timing race — vendors sometimes document
  the exact pitfall (see lasernet.md Part 15).
```

**Real example (2026-07):** a LaserNet PO report's `InventSite` address printed blank on
first print in PROD only, correct on reprint. `d365_lookup_table` on the full join chain
(`InventSite → InventSiteLogisticsLocation → LogisticsLocation → LogisticsPostalAddress`)
showed the last table's key is `(Location, ValidFrom)` with `EffectiveDateTime`/
`ExpirationDateTime` EDTs — confirmed temporal. `CompanyInfo`'s address, which never
fails, turned out to resolve via a single direct FK (`DirPartyTable.PrimaryAddressLocation`)
with no temporal filtering at all — the *structural* reason one path is fragile and the
other isn't, found from metadata alone, without needing DB/log access.

---

## Workflow 13: Migration-Defect RCA via DMF Entity Validation Depth

**When:** A ticket points at a data inconsistency plausibly introduced by a historical
data migration (e.g. header status vs. downstream transaction status disagree), and you
need to identify *which* DMF/data-entity import path is the likely fault line — without
DB access to the actual migration/DMF execution logs.

```
STEP 1 — Identify candidate entities by table, not by guessed name:
  d365_search(keywords, object_type="entity")  → find real entity names touching the
  tables implicated in the inconsistency (e.g. "purchase order header", "product receipt")

STEP 2 — Pull real field mappings AND method lists for each candidate (PARALLEL):
  d365_get_entity_sources(entityName)  → primary_table, entity_fields (target field →
  source table.field), method_count, methods[]

STEP 3 — Read method_count as a validation-depth signal:
  - Header/line entities with heavy validation (validateWrite, validateInventoryDimensions,
    detectStateChangeRelatedConflicts, 20-45+ methods) are guarded — still CAN import bad
    data (validation can be scoped narrower than the actual defect), but less likely to.
  - Entities with only `defaultCTQuery` (1 method, no insert/map/validate overrides) are
    thin pass-throughs straight into the table — a raw insert here does NOT re-run the
    business-process engine (e.g. InventUpdate) that a live UI action would trigger.
    These are the prime suspects for "header says X, downstream transaction says Y."

STEP 4 — State the finding as a hypothesis about WHICH entities were used, not a fact:
  entity existence + field mapping + method count are confirmed from the KB; that the
  actual migration used exactly these entities (vs. an older non-V2 version, or a raw
  table script bypassing DMF entities entirely) is usually NOT verifiable without the
  actual DMF execution history — say so explicitly.
```

**Real example (2026-07):** ticket showed a PO's header `DocumentState` stuck Draft while
a product receipt was already posted underneath it (inconsistent). `PurchPurchaseOrderLineV2Entity`
(→`PurchLine`) had 45 methods including inventory-dimension and state-conflict validation;
`VendProductReceiptHeaderEntity`/`VendProductReceiptLineV2Entity` (→`VendPackingSlipJour`/
`VendPackingSlipTrans`) had only `defaultCTQuery` — no validation at all. The asymmetry
directly explains the mechanism: importing the historical receipt through the thin entity
would not have driven the same InventTrans status transition a real posting would, while
importing the header through the heavily-validated entity still landed a wrong status
value the validation apparently didn't catch. Two independently-loaded entities, never
reconciled against each other.

**Bonus technique — `module_id` reveals custom AOT model names.** When a user uses an
internal shorthand for "our custom code" (e.g. "iExtension") that you don't recognize,
check whether any `d365_search`/`d365_lookup_table` result's `module_id`/`source_module`
field literally matches it before asking the user to clarify — every `TBG_`-prefixed
object in this tenant returns `module_id: "iExtension"`, confirming it's the actual AOT
model name, not a nickname. Cheaper than a clarifying question when the KB can answer it.

---

## Workflow 14: "Who wipes/writes this field?" (system overwrites a user-entered value)

**When:** A user-entered field value "disappears" or changes after a system event (approval, confirmation, posting) and you must find the writer. Real case: PO header Tax exempt number blanked at approval → root cause was the TCS multiple-VAT-ID write-back (`TaxIntegrationTaxIdUtility::saveTaxIDFromDocumentToTable`), found in ~20 calls with no DB access.

```
STEP 1 — Verify the field + try the indexed usage lookup (PARALLEL):
  d365_check_field_exists(table, [field])          -- confirm the real field name
  xref_find_field_usages(table, field, kind=Write) -- MAY return "Field not found" even
                                                      for real fields (PurchTable.VATNum did)

STEP 2 — When xref fails or returns 0 writes, get the COMPLETE writer list from source:
  d365_raw_sql: SELECT owner_name, method_name FROM methods
                WHERE source_code LIKE '%<Field>%' AND source_code LIKE '%<tableVarHint>%'
  -- The KB methods table is the ground truth for writers; xref's field-write index is weak.

STEP 3 — Rule custom code in/out EARLY:
  xref_list_modules → origin='custom' rows name the tenant models (e.g. iExtension)
  xref_search_names(pattern='%<Table>%', modules=[customModel]) → sweep for CoC/handlers.
  A short "custom code is clean" result lets you commit to standard-code tracing.

STEP 4 — For each writer, walk UP with xref_find_method_callers until a caller matches the
  REPORTED MOMENT (approval / confirmation / posting). Discard writers whose call chains
  only run at create/field-modify time — they can't explain an approval-time wipe.

STEP 5 — Read the winning method's SOURCE, not just its name. Two things clinched the real
  case: (a) an explicit blanking branch with the comment "…write 0", and (b) a Microsoft
  unit test named after the scenario (updateTaxIDWhenPurchTableInReview) that proved the
  timing linkage. Doc comments sometimes describe the exact user symptom verbatim
  ("…the tax exempt number …is updated to blank") — treat comments as searchable evidence.

STEP 6 — Resolve the user-facing warning/label so the report names what users saw:
  d365_raw_sql: SELECT label_id, text FROM labels WHERE label_id LIKE '%<hint>%'
  (d365_resolve_label only accepts @SYS-style numeric ids; named labels like
   @TaxMultipleVATID:VendVATIDNotFoundAndBlankWarning need the labels-table query.)
```

**Framework write-backs to suspect when "the system changed my field":** TCS/tax-integration persistence (`TaxIntegration*DataPersistence.saveDocument` — runs after EVERY tax calc; approval auto-triggers confirmation → tax calc via `VersioningPurchaseOrder.approveChangeRequest` → `runPurchaseOrderConfirmationProcess`), intercompany sync, `initFrom*` re-defaulting on account change, DMF/entity `Ax*` writers. PO change-management approval itself only **archives** (never restores) — see d365fo-analysis Part 27.3 before blaming versioning.

### KB raw-SQL schema notes (verified 2026-08-18)

- The tool description's `kb_methods(class_name, …)` schema is **wrong** — the real table is `methods(owner_name, method_name, source_code, …)`. When a documented raw-SQL schema errors, discover the real one first: `SELECT name FROM sqlite_master WHERE type='table'` (32 tables incl. `methods`, `labels`, `tables`, `fields`, `modules`).
- `labels(label_id, text)` resolves **named** labels (`@TaxMultipleVATID:…`, `@TOC:…`) that `d365_resolve_label`'s `@Prefix123` regex rejects.
- Full-text source search (`source_code LIKE`) over `methods` is cheap and precise — it found all 28 methods touching `VATNum`+`purchTable` in one call. Use two LIKE terms (field + a table-variable hint) to cut noise.

### Table maps and metadata-path search

- **Table maps aren't tables**: `d365_check_field_exists('PurchTableMap', …)` → "Table not found". Enumerate a map's fields via `xref_search_names(pattern='Map/<MapName>/%')` — field nodes come back as `Map/X/MapFieldString/Y` (with `?ExtendedDataType`/`?Label` property nodes). To probe ONE field: `pattern='Map/<MapName>/MapFieldString/<Field>%'`.
- The same path-pattern trick enumerates any metadata container: `TableExtension/<Table>.<Model>/…` rows reveal which model extends a table and what it maps.

---

## Raw SQL guardrails (`*_raw_sql` on d365sec / d365kb / d365xref)

Hard-won this session — a raw_sql call blew the token limit **three times** and tripped the query guard twice.

1. **Aggregate, never enumerate.** "Which roles/duties grant X" must return **one row per entity** via `count(*)` / `GROUP BY`, never a row per (role × privilege) — a cross-join over a tenant's roles is thousands of rows and overflows the token budget. Get the count/shape first; only expand a specific slice you actually need.
2. **No `group_concat` over an unbounded column.** One `group_concat(duty_name)` returned a single 298 KB cell. If you must concat, wrap with a known-small `WHERE` or a `LIMIT`-ed subquery.
3. **Always add `LIMIT`** on exploratory queries, and pass **`format="toon"`** for flat tabular result sets (~25-35 % fewer tokens).
4. **Query-guard quirks** (the guard is a naive string check):
   - Must **start** with `SELECT` / `WITH` / `PRAGMA` — a **leading `--` comment makes it fail** ("Only SELECT, WITH, and PRAGMA allowed"). Put comments after the first keyword, or omit them.
   - `UPDATE` / `DELETE` / `INSERT` are rejected **even inside string literals** (role name `'…status update'` → "Forbidden keyword UPDATE"). Match such names with a keyword-free `LIKE 'prefix%'`.
5. **Sanity-check data integrity before trusting a derived join.** Before building role lists from `duty_privileges`, run `SELECT count(DISTINCT privilege_name) FROM duty_privileges dp JOIN duties d ON d.duty_id=dp.duty_id WHERE d.duty_name='<a known-small duty>'`. If it returns thousands, the mapping is corrupt → switch to `sec_object_access`/`sec_effective_permissions` or live D365 Security diagnostics, and **say so** rather than presenting a bogus "complete" list.
6. **System columns read as "missing".** `d365_check_field_exists` reports `DataAreaId`, `RecId`, `RecVersion`, `Partition` as not existing — they are real SQL columns on every table; use them freely.

---

## Anti-Patterns (Do NOT Do)

| Anti-Pattern | Why | Instead |
|-------------|-----|---------|
| `d365_search` when you know the exact name | Wastes a call, fuzzy results | Use `d365_lookup_table` / `d365_get_enum` directly |
| Sequential calls when parallel is possible | Doubles latency | Batch independent calls |
| `d365_raw_sql` for standard lookups | Fragile, schema may change | Use purpose-built tools |
| `rag_ask` for metadata questions | RAG is docs, not metadata | Use KB tools for tables/fields/enums |
| `rag_search` with natural language queries | FTS5 doesn't understand sentences | Use `rag_search("term1 OR term2 OR term3")` with OR-separated keywords |
| Iterative RAG keyword fishing (6+ searches) | Wastes turns, fragments context | After 2-3 searches, switch to `rag_lookup_document` on best docs found |
| Retrying broken MCP tools 3+ times | Context cost exceeds information gain | After 1 retry, move to alternative sources |
| Designing a new security role before checking existing tenant roles | Overgrants, ignores governance pattern, duplicates work | Call `sec_object_access` on the target table/menu item first — often surfaces an existing curated "Read Only" role reused by many users |
| Passing OData entity names to `sec_object_access` / `sec_effective_permissions` | Security DB indexes menu items + tables, not entities — causes schema errors | Drop `Entity` suffix and version suffixes (`V2`/`V3`); pass underlying table or menu item |
| Recommending permissions without looking up the current account | Delta is unknown; may duplicate already-granted access | `sec_lookup_user` first, then `sec_effective_permissions` for target object, then design the delta |
| `microsoft_docs_fetch` without search first | May fetch wrong page | Search first, then fetch |
| Calling `d365_hallucination_check` on every query | Overhead | Only when generating SQL or unsure about field names |
| Manually parsing .axtr XML | Fragile, misses BPM data | Use `taskrecorder_to_markdown` — handles all node types + BPM |
| `sec_raw_sql` returning a row per (role × privilege) | Thousands of rows → token-limit overflow (saved-to-file) | Aggregate to one row per entity with `count(*)` / `GROUP BY` |
| `group_concat` over an unbounded column | A single cell hit 298 KB | Concat only over a `LIMIT`-ed / `WHERE`-bounded set |
| Hand-rolling duty→role joins as the primary access answer | `duty_privileges` may be corrupt; `sec_find_roles_by_privilege` joins through it | Lead with `sec_object_access` / `sec_effective_permissions`; raw_sql is fallback only |
| Concluding "missing role" because a feature fails for one user | Often navigation/personalization/company/worker-link, not security | Run `sec_effective_permissions` for both users; if both granted, pivot (Workflow 5d) |
| Using `sec_search` FTS to find the form behind a feature | FTS returns adjacent objects, not the target form | Find via `privileges.label` → `privilege_entry_points` (Workflow 5c) |
| Leading `--` comment / `UPDATE` in a literal in `*_raw_sql` | Query guard rejects both | Start with SELECT/WITH; match keyword-bearing names via `LIKE` prefix |
| Presenting a caching/timing theory that's environment-agnostic as an environment-specific root cause | An ISV connector bug on an identical version reproduces everywhere unless something else varies too | Pair it with a concrete "why only here" argument (data freshness, AOS topology, execution context) or don't present it as sufficient (Workflow 12) |
| `d365_raw_sql` on d365kb for a simple `SELECT * FROM kb_tables WHERE table_name IN (...)` | Fails with a generic "check your SQL syntax" error despite the tool description advertising a real `kb_tables`/`kb_fields`/`kb_relations` schema (verified broken 2026-07, same as the d365sec raw_sql issues above) | Use `d365_lookup_table` per table instead — richer output (cache_lookup, indexes, customization flags, full relations) than raw_sql would give anyway |
| Assuming a documented ISV/module "doesn't support X" because the skill file / vendor docs say so | Docs and prior skill notes can undersell a product's real capability — a live dev-environment screenshot found a native STAEDEAN EDI Studio field (`BisUnloadingPoint` on address setup) the skill doc had missed entirely | Treat "no native field" claims as provisional; re-check against a live environment (screenshot, form personalization panel) when one becomes available, and correct the skill doc rather than defend the earlier claim |
| Picking a side when two sources for the same fact disagree (e.g. two workshops, a doc vs. a transcript) | Silently resolving the conflict hides a real open question from the person who'd need to reconcile it | Present both versions side-by-side with a clear flag; let the user/team decide which is current — don't guess which source is more authoritative |
| Guessing at a custom AOT model's name when a user references an internal shorthand you don't recognize | Wastes a clarifying question the KB could already answer | Check `module_id`/`source_module` on any `d365_search`/`d365_lookup_table` result touching that code first (Workflow 13 bonus technique) |
| Trusting `xref_find_field_usages` "Field not found" / 0 writes as proof nobody writes a field | The xref field index has gaps — `PurchTable.VATNum` errored while ~10 real writers existed | Fall back to KB source search: `SELECT owner_name, method_name FROM methods WHERE source_code LIKE '%Field%' AND source_code LIKE '%tableHint%'` (Workflow 14) |
| Concluding an object doesn't exist from 0 rows of `xref_search_names` with an `object_type` filter | `object_type="Classes"` returned 0 for `VersioningPurchaseOrder%` although the class exists (name-node type mismatch) | Retry without the filter, or prove existence via a caller/reference hit; only then conclude absence |
| `d365_check_field_exists` on a table MAP (`PurchTableMap`) | Maps aren't in the KB tables list → "Table not found" | Enumerate map fields via `xref_search_names('Map/<Name>/%')` (Workflow 14) |
| Stopping a wiped-field RCA at the first plausible writer (`initFromVendTable`, versioning restore) | The plausible writers often only run at create/modify time — they can't explain an approval/posting-time wipe | Walk each writer's call chain up to a trigger that matches the reported moment before presenting it (Workflow 14, step 4) |

---

## Cost-Efficiency Rules

1. **Parallel first**: If two calls don't depend on each other, run them in the same message
2. **Narrow before wide**: `d365_lookup_table` before `d365_search`; `xref_find_method_callers` before `xref_impact_analysis`
3. **KB for metadata, RAG for concepts**: Never mix them up
4. **One raw_sql call > three specific calls** if you need a custom join across KB tables
5. **Stop early**: If the first call answers the question, don't make the remaining calls
6. **Search to find documents, then read documents**: Don't keep searching for fragments — 2-3 `rag_search` calls to identify key docs, then `rag_lookup_document` to read them
7. **Fail fast on broken tools**: If an MCP tool returns schema validation errors twice, stop and use alternatives
8. **Aggregate over enumerate in raw_sql**: count/shape a result set before expanding it; never return a row per (role × privilege) or `group_concat` an unbounded column (token-limit overflow)
9. **Authoritative tools beat hand-rolled SQL**: prefer `sec_object_access`/`sec_effective_permissions` over duty-join SQL — and sanity-check `duty_privileges` before trusting it
10. **Verify a "now fixed" claim once**: when told a broken tool is fixed, re-test exactly once; if it still errors the server build/connection wasn't reloaded — report, don't loop

---

*Version: 1.7 | Date: 2026-08-18 | Added: Workflow 14 ("who wipes/writes this field" — KB source search as ground truth for writers, custom-model rule-out sweep, walk-up-to-the-trigger-moment discipline, unit-test names and doc comments as evidence, labels-table lookup for named labels), KB raw-SQL schema notes (real `methods(owner_name,…)` schema vs the wrong documented one, `sqlite_master` discovery, `labels` table), map-field enumeration via path patterns, 4 anti-patterns (xref field-usage false negatives, object_type-filtered 0-rows ≠ absence, check_field_exists on maps, stopping at the first plausible writer).*
*Version: 1.6 | Date: 2026-07-08 | Added: Workflow 13 (migration-defect RCA via DMF entity validation depth — method-count as a signal for thin-pass-through vs. guarded entities; module_id-reveals-custom-AOT-model-name bonus technique), 3 anti-patterns (trusting docs over a live-environment contradiction; silently resolving conflicting sources instead of flagging; guessing a custom model name instead of checking module_id).*
*Version: 1.5 | Date: 2026-07-07 | Added: Workflow 12 (caching/timing bug diagnosis via d365_lookup_table cache_lookup + key-shape + validTimeState EDT checks; cross-check every hypothesis against ALL symptoms, not just the failure case), 2 anti-patterns (environment-agnostic theory presented as environment-specific cause; d365kb raw_sql confirmed broken like d365sec's).*
*Version: 1.4 | Date: 2026-06-18 | Added: Workflow 5c (find securable object via privileges.label→entry_points, not FTS), 5d (works-for-A-not-B → pivot to navigation/company/worker-link when both granted), "Raw SQL guardrails" section (aggregate-not-enumerate, group_concat limit, query-guard quirks, duty_privileges corruption sanity-check, system-column false-negatives), 6 anti-patterns + 3 cost rules. Authoritative-first security rule (sec_object_access/effective_permissions primary; raw_sql fallback).*
*Version: 1.3 | Date: 2026-04-20 | Added: Workflow 5a (additive permission change — check current state first), Workflow 5b (object name granularity: strip Entity/V2/V3 suffixes for sec queries), 3 security anti-patterns (design-before-survey, entity-name-granularity, recommend-without-lookup)*

