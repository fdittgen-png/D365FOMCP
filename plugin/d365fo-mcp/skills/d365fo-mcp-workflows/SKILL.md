---
name: d365fo-mcp-workflows
description: Efficient multi-tool orchestration recipes for the D365FO MCP services — 14 named workflows (table deep dive, field investigation, impact analysis, security audit, migration-defect RCA, field-wiper hunt…), raw-SQL guardrails, anti-patterns, cost-efficiency rules. Use when planning which MCP tools to call and in what order.
---

# D365FO MCP Tool Orchestration Workflows

## Contents

Full recipes with call sequences: **`references/workflows-catalog.md`** — read the one workflow you need, not the file.

| # | Workflow | When |
|---|---|---|
| 1 | Table Deep Dive | a table's structure, usage and customisation (`/d365-table`, brief by default) |
| 2 | Field Investigation | one field end to end (`/d365-trace-field`) |
| 3 | Impact Analysis | before modifying an object (`/d365-impact`) |
| 4 | Method Tracing | callers / call chain of a method |
| 5 | Security Audit (5a–5d) | roles, additive grants, object granularity, securable object behind a UI feature, works-for-A-not-B |
| 6 | Research a D365 Topic | multi-source (`/d365-research`) |
| 7 | Data Entity Mapping (7a brief, 7b fields) | structure of an entity in 3–4 calls (`/d365-entity`), or its field rows |
| 8 | Enum Resolution | enum values ↔ integers |
| 9 | Class Extensibility | CoC / event-handler surface (`/d365-class`) |
| 10 | Parse Task Recording | `.axtr` → steps |
| 11 | Test Case from Recording | enriched document |
| 12 | Caching / Timing Bug | fails once, retry succeeds |
| 13 | Migration-Defect RCA | DMF entity validation depth |
| 14 | Who wipes / writes this field | system overwrites a user value |
| — | Raw SQL guardrails, KB raw-SQL schema notes | before any `*_raw_sql` |

### Most-used recipe inline — 7a "structure of entity X" (≤ 4 calls, ≤ 4k MCP tokens)

State the shape first, then: (1) `d365_get_entity_sources(entity)` — summary default; (2) `d365_lookup_table(primary_table, sections: ["indexes","relations_out"], include_provenance: true)`; (3) `d365_raw_sql`: `SELECT entity_name, public_collection, label, primary_table FROM data_entities WHERE primary_table = '<T>' COLLATE NOCASE LIMIT 20`; (4) when customisation or migration is in scope, `d365_get_entity_sources(entity, custom_only: true)`. Never a second lookup of the same table; field rows only on request. Measured 2026-09-04: 9.8k → 2.6k tokens, same conclusion.

## Overview

This skill defines efficient multi-tool workflows for the 5 MCP service families. The goal is minimum tool calls for maximum insight. Always run independent calls **in parallel**.

---

## Service Map (Quick Reference)

| Need | Service | Best Starting Tool |
|------|---------|-------------------|
| Table/field metadata | d365kb | `d365_lookup_table` |
| Table as compiled (base + extension fields, tagged by origin/module) | d365kb | `d365_effective_schema` |
| "Does this field exist?" | d365kb | `d365_check_field_exists` |
| "Do these objects / methods exist?" (preflight, ≤50, misses carry suggestions) | d365xref | `xref_check_exists` |
| "Do these roles / duties / privileges / entry points exist?" (preflight, returns canonical casing) | d365sec | `sec_check_exists` |
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
| **Answering about object A by checking object B, because the KB cannot reach A** (view → its base tables; map → the mapped table; entity → its primary table) | The tool gap silently becomes an assumption. `d365_check_field_exists('PurchTableHistory','PurchOrderFormNum')`=true was used to conclude `PurchTableAllVersions` exposes it. It does **not** — a union view exposes a *curated* column list. Wrong design conclusion, stated as fact (2026-09-01) | When the tool cannot address the exact object, fill the gap from another source — `AxView\`/`AxQuery\` XML under `PackagesLocalDirectory` (the KB `views.file_path` column hands you the path), or a live query. Never substitute the nearest object the tool *can* address |
| **Reusing a prior analysis's `CONFIRMED` finding without re-reading the evidence under it** | A finding can be confirmed on one leg and merely *quoted* on the other, while the label covers both. "The requester InnerJoin drops POs" was CONFIRMED on `PurchTable.Requester mandatory=No` (true, from MCP) and inherited on "GRUK/HOVN/KAIN/WEUK configured InnerJoin" (false — every child join in all 11 Queries is OuterJoin) | Split a reused finding into its premises and ask which were **read** and which were **quoted**; re-read the quoted ones. "Treat these as baseline, don't re-run settled work" is scope guidance, not evidence |
| Reporting a derived count or list with no independent figure to check it against | Every parsing bug caught in the PO run (leaf-name collision across two aliases of one table, missing `()` on display-method output names, Windows `*.XML`/`*.xml` double glob counting 114 files instead of 57) was caught by a mismatch against a known number. The two errors that survived had no such anchor | Anchor each extraction to something known independently — document count, prior per-LE counts, figures the requester supplied. Where no anchor exists, say so and mark the number unverified |
| Re-running a truncated list call with a bigger `limit` | On the paginated tools (`d365_search`, `d365_get_class_methods`, `d365_get_entity_sources`, `xref_find_references`, `xref_find_usages`, `sec_search`, `sec_find_roles_by_*`) that re-pays every row already in context | Pass `next_cursor` back as `cursor` with the same arguments — the next page only |
| One lookup call per name just to confirm the names exist | N turns and N payloads for a yes/no question; a wrong guess ships confidently | `d365_check_field_exists(tables=[…])` / `xref_check_exists(objects=[…])` / `sec_check_exists(roles=[…], …)` — one batch, misses come back with suggestions and canonical casing |
| Re-issuing the same call after a *not-found*, or a `d365_search` to fix the spelling | The not-found response already lists the closest existing names | Pick from that list; a search call is a wasted turn |
| Ignoring the italic coverage lines under the snapshot banner (`isv_excluded`, `partial_build`, `field_limit_hit`, `provenance_omitted`, `isv_not_scanned`) | They are the exact statement of what the response does NOT cover — asserting completeness over them is the hallucination these tools exist to prevent | Carry each line into the deliverable as an evidence limit; widen the call (`include_isv`, `include_provenance`, `fields_like`) only when the gap matters |
| Retrying a call that came back with a "you are repeating this call" note | The server suppresses the payload on the third identical call in fifteen — the answer is already in context or the arguments are wrong | Change the arguments or move on; never loop on an unchanged call |
| Calling `d365_lookup_table` on several tables in one turn, or `xref_find_extensions` + `d365_lookup_table` to learn who added which field | `lookup_table` is deliberately unbatched (one response is already large); two calls to answer one question | One `d365_effective_schema(table)` — base + every extension's fields, each row tagged `origin` / `module` / `model_origin` |

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
11. **Preflight names in one batch**: `*_check_exists` / `d365_check_field_exists(tables=[…])` before any SQL, X++ or security statement that names several objects — a miss is data with suggestions, not an error
12. **Page with `cursor`, never with a bigger `limit`**: `has_more` + `next_cursor` are on every paginated list; re-issuing with a larger limit re-pays the head of the list
13. **Batch same-kind targets**: `enum_names`, `tables`, `method_names`, `queries`, `object_names`, `objects`, `role_names` — one turn instead of N at about the same JSON size (the batch hoists what the entries repeat). Exception: `d365_lookup_table`, unbatched on purpose
14. **Read the coverage lines before asserting completeness**: `isv_excluded` / `partial_build` / `field_limit_hit` / `provenance_omitted` / `isv_not_scanned` say exactly what a response leaves out — repeat them in the answer
15. **Leave `format` at its default**: the text channel is adaptive (TOON or Markdown, whichever is smaller per response); the JSON `structuredContent` is what the claude.ai connector bills and it is identical either way
17. **Counts and aggregates before any list** (B1): entity summary before field rows; `sections: ["indexes","relations_out"]` before fields; `GROUP BY` before rows in raw_sql, then ≤ 5 rows per group (B4).
18. **Provenance on the first call** (B2): `include_provenance: true` on the first `d365_lookup_table`; never a second lookup of the same table with `custom_only`.
19. **No discovery search for a known name** (B3): `d365_search` only when the object name is unknown.
20. **Decide the answer shape before the first call and name it in one line** (A2); **offer a new session at a topic switch before any work** (A1).
22. **After a deploy or server code change, verify with a fresh stdio spawn or a new session** — the session's own MCP servers still run the old code (measured 2026-09-04: 92 KB vs 10 KB for the same recipe). **A `/d365-*` command carries its calls: do not load the tooling skill on top of it.**
21. **One `WebFetch` beats a subagent for a single documentation page** (E2, measured: 49 k tokens of subagent for four facts one fetch gives); **when a deploy script is likely to hit the classifier, run the publish steps directly from the start** (E3).
16. **Pass `functional_context`** (`sales_order`, `vendor_invoice`, …) on the lookup tools when the business entity is known — a hit records the mapping for later sessions, a miss returns the objects already mapped to that entity

---

*Version: 2.0 | Date: 2026-09-04 | Split: Workflows 1–14 + raw-SQL notes moved to `references/workflows-catalog.md` (48 KB → index + 7a inline + anti-patterns + cost rules); loaded per session only what steers behaviour.*
*Version: 1.10 | Date: 2026-09-04 | Workflow 7a step 4 (`custom_only` when customisation/migration is in scope), replayed measurement 9.8 k → 2.2 k tokens, label-derived sibling descriptions are inferences.*
*Version: 1.9 | Date: 2026-09-04 | Added: Workflow 7a (entity structure in 3 calls — summary default, `sections`, sibling query), rules 17–21 (counts before lists, provenance once, no discovery search, answer shape + new-session offer, WebFetch over subagent) from `MCP_Communication_Efficiency_Improvements_2026-09-04`.*
*Version: 1.8 | Date: 2026-09-03 | Added: `d365_effective_schema` (Workflow 1/3, service map), `xref_check_exists` / `sec_check_exists` preflights (service map, Workflow 3), cursor pagination + batch parameters + coverage lines + loop-guard note as cost rules 11–16 and 6 anti-patterns; corrected the stale `format="toon"` guardrail (adaptive default, ~5% not 25–35%). First external-user measurement: ~70% fewer tokens on a script-writing task after the 2026-09-02 response-quality release.*
*Version: 1.7 | Date: 2026-08-18 | Added: Workflow 14 ("who wipes/writes this field" — KB source search as ground truth for writers, custom-model rule-out sweep, walk-up-to-the-trigger-moment discipline, unit-test names and doc comments as evidence, labels-table lookup for named labels), KB raw-SQL schema notes (real `methods(owner_name,…)` schema vs the wrong documented one, `sqlite_master` discovery, `labels` table), map-field enumeration via path patterns, 4 anti-patterns (xref field-usage false negatives, object_type-filtered 0-rows ≠ absence, check_field_exists on maps, stopping at the first plausible writer).*
*Version: 1.6 | Date: 2026-07-08 | Added: Workflow 13 (migration-defect RCA via DMF entity validation depth — method-count as a signal for thin-pass-through vs. guarded entities; module_id-reveals-custom-AOT-model-name bonus technique), 3 anti-patterns (trusting docs over a live-environment contradiction; silently resolving conflicting sources instead of flagging; guessing a custom model name instead of checking module_id).*
*Version: 1.5 | Date: 2026-07-07 | Added: Workflow 12 (caching/timing bug diagnosis via d365_lookup_table cache_lookup + key-shape + validTimeState EDT checks; cross-check every hypothesis against ALL symptoms, not just the failure case), 2 anti-patterns (environment-agnostic theory presented as environment-specific cause; d365kb raw_sql confirmed broken like d365sec's).*
*Version: 1.4 | Date: 2026-06-18 | Added: Workflow 5c (find securable object via privileges.label→entry_points, not FTS), 5d (works-for-A-not-B → pivot to navigation/company/worker-link when both granted), "Raw SQL guardrails" section (aggregate-not-enumerate, group_concat limit, query-guard quirks, duty_privileges corruption sanity-check, system-column false-negatives), 6 anti-patterns + 3 cost rules. Authoritative-first security rule (sec_object_access/effective_permissions primary; raw_sql fallback).*
*Version: 1.3 | Date: 2026-04-20 | Added: Workflow 5a (additive permission change — check current state first), Workflow 5b (object name granularity: strip Entity/V2/V3 suffixes for sec queries), 3 security anti-patterns (design-before-survey, entity-name-granularity, recommend-without-lookup)*

