---
name: d365fo-mcp-tooling
description: How to use the D365FO MCP services (d365kb, d365xref, d365sec, d365taskrecorder, wiki) correctly and cheaply — first tool per need, answer shape before the first call, the call-discipline rules, how to read banners / coverage lines / hints, verification, session hygiene, privacy. Load before the first MCP call in a free-form D365FO conversation; skip it when a /d365-* command is running — the commands embed their calls.
---

# D365FO MCP tooling — core (full text and measurements: `references/tooling-full.md`)

Four read-only **snapshot** servers (`d365kb`, `d365xref`, `d365sec`, `d365labels`) and a Task Recorder converter. They return facts; you supply the reasoning. Match on **tool names** — the server label varies by host (`D365 KB`, `plugin_d365fo-mcp_kb`, `mcp__d365kb__…`). A server that is not connected is a gap to report, never a detour through another server's `raw_sql` or memory.

## 1. First tool by need

| Need | First call | Then |
|---|---|---|
| Table structure | `d365_lookup_table` with `sections: ["indexes","relations_out"]`; fields only on request (`fields_like`, `field_limit`) | `d365_effective_schema` for base + every extension's fields |
| Does field X exist | `d365_check_field_exists` (batch `tables`) | `d365_field_renames` (AX2012 name); `_Custom` suffix → `d365_custom_fields`, "not in the snapshot", never "does not exist" |
| Data entity | `d365_get_entity_sources` — default **summary** (data sources + counts) | `custom_only: true` names the exposed extension fields; `fields_like` / `summary:false` for rows |
| Join two tables | `d365_get_join_keys` | `d365_sql_template` |
| Enum values | `d365_get_enum` (batch `enum_names`) | — |
| Class API / X++ | `d365_get_class_methods` (signatures + `source_lines`) | `d365_get_method_source` with `method_names` (≤ 10); `include_source` on at most ONE class per investigation |
| Unknown object name | `d365_search` (`modules` to scope; `include_context` only if the snippet matters) | `d365_lookup_table` on the hit |
| Do these names exist (preflight) | `xref_check_exists` / `sec_check_exists` / `d365_check_field_exists` — one batch, ≤ 50 | misses carry suggestions |
| Who uses / calls / writes X | `xref_object_summary` (counts first) | `xref_find_references` / `xref_find_field_usages` / `xref_find_method_callers`, `limit: 20` |
| Extensions, event handlers | `xref_find_extensions`, `xref_find_event_handlers` (`limit`) | `xref_class_hierarchy`, `xref_interface_implementors` |
| Impact of a change | `xref_impact_analysis` | `xref_cross_module_deps` |
| Role / duty / privilege content | `sec_lookup_role` (batch `role_names`) / `sec_lookup_duty` / `sec_lookup_privilege` | `sec_role_hierarchy` |
| Can user U do Y | `sec_effective_permissions` (Deny wins) | `sec_permission_trace` for the chain |
| Who can reach Y | `sec_object_access` (`limit`) | `sec_find_users_by_role`, `sec_company_users` |
| Task recording | `taskrecorder_to_markdown` | `taskrecorder_to_document` |
| Model inventory, custom vs Microsoft | `d365_list_modules` / `xref_list_modules` with `origin: "custom"` | `d365_get_module_summary` |
| Anything the typed tools cannot express | `*_raw_sql` — read `references/kb-raw-sql-schema.md` first | `LIMIT` always, `COLLATE NOCASE`, never `SELECT *` on XRef |

Parameter tables, generated from the code: `references/kb-tools.md`, `references/xref-tools.md`, `references/sec-tools.md`, `references/labels-tools.md`, `references/taskrecorder-tools.md`, `references/wiki-tools.md`. Contract details (structuredContent, error categories, truncation kinds): `references/response-format.md`. Full former text with every measurement: `references/tooling-full.md`.

## 2. Answer shape before the first call

Decide what the answer must contain, say it in one line (*"Shape: data sources + keys + party link → 1 summary + 1 lookup + 1 SQL"*), then call. The user may steer it ("summary only", "three calls max", "ten lines"). Measured 2026-09-04 on one question: improvised 9.8k MCP tokens, shaped 2.6k, same conclusion.

| Question | Shape | Calls |
|---|---|---|
| Structure of entity X (`/d365-entity`) | data sources, keys, party link, customisation, siblings | entity summary → `lookup_table(primary, sections indexes+relations_out, include_provenance)` → siblings SQL → `custom_only` when customisation matters. ≤ 4 calls, ≤ 4k tokens |
| Structure of table X (`/d365-table`) | keys, relations, customisation, usage counts; fields on request | `lookup_table` sections → `xref_object_summary` → `find_referencing_tables limit 20` |
| Field X end to end | exists → type/EDT → usages | `check_field_exists` → `lookup_table fields_like` → `xref_find_field_usages limit 20` |
| Can user U do Y | verdict, then the chain | `sec_effective_permissions` → `sec_permission_trace` |
| Who can do Y | list with counts | `sec_object_access limit 20` |
| Impact of changing X | counts, then only the lists that matter | `xref_object_summary` → `xref_impact_analysis` |
| Conceptual "how does it work" | 5–8 lines, details on request | no tools, or `/d365-research` |

## 3. Rules — each one is measured (`references/tooling-full.md` §2 has the numbers)

1. **New topic → offer a new session before any work**: *"This is a new topic — a fresh session will cost about half; continue here or restart?"* Once asked is enough.
2. **Counts and summaries before lists.** Entity summary before rows; `sections` before fields; `xref_object_summary` / `sec_stats` before their lists. `limit: 20` on every list; more rows → `cursor`, never a bigger `limit`.
3. **One lookup per table.** `include_provenance: true` on the first `d365_lookup_table`; never a second call on the same table with `custom_only`.
4. **No discovery search for a known name.** `d365_search` only when the object name is unknown.
5. **Batch same-kind targets** (`enum_names`, `tables`, `method_names`, `queries`, `object_names`, `objects`, `role_names`); run independent calls in parallel; heavy calls against one server one at a time (SQLite is synchronous — one slow query blocks the host).
6. **raw_sql: aggregate, then ≤ 5 rows per group.** Never a > 50-row dump.
7. **Every factual claim has a call behind it.** Label inferences — a purpose read from a label or module name is an inference until fields or methods were queried. A confident unbacked sentence is what these tools exist to prevent.
8. **Pass `functional_context`** (vocabulary id such as `vendor`, `sales_order`) on the lookup tools — it also becomes the investigation's `expected_entities` in the trace when you wrote no `Entities:` line (§8).
9. **A "you are repeating this call" note means stop**, not retry.
10. **A `/d365-*` command carries its calls — do not load this skill on top of it** (the skill is ≈ 5.8k tokens of text against ≈ 2.6k of data for an entity question).

## 4. Reading a response

- `_<Service> snapshot: <date>_` under the H2: quote it when a claim matters. It proves an object exists now, not when it appeared.
- Coverage lines directly under the banner say what the response does NOT cover: `field_limit_hit`, `provenance_omitted`, `isv_not_scanned`, `isv_excluded` (exact count), `partial_build`. Carry them into the deliverable instead of asserting completeness.
- `_Hint: …_` means the response was large and unnarrowed; pass the named parameter (`sections`, `summary`, `fields_like`, `object_type`) next time.
- Empty result = valid object, zero rows. Not-found (`isError`) lists the closest names — pick one, do not spend a search on it.
- A raw `@SYS…` id is a data gap, not a label to invent — `d365_resolve_label` for the en-US text in a KB answer, `labels_lookup` (d365labels) when the question is the label itself: every language, the developer description, `labels_where_used` for where it is shown. Leave `format` at its default; `markdown` only when quoting verbatim.

## 5. Verify before you assert

| Claim | Minimum evidence |
|---|---|
| Field exists / has type T | `d365_check_field_exists` or a `d365_lookup_table` row |
| Method M does Y | `d365_get_method_source`, quoted line numbers |
| Nothing else uses X | `xref_object_summary` = 0 **and** `xref_find_extensions` empty **and** no `isv_excluded` line |
| User can(not) do Z | `sec_effective_permissions` verdict with the `sec_permission_trace` chain |
| Field X does not exist | say "not in the metadata snapshot"; `LAC*`/`PRN*` may be sealed-ISV, `_Custom` is a UI field |

## 6. Session hygiene (measured 2026-09-04)

- **Stale servers.** Local stdio MCP servers are processes started with the session; after a deploy or a server code change they serve the OLD code and env until a new session (a same-session rerun paid 92 KB instead of 10 KB). Verify server changes with a fresh spawn or a new session — never through the session's own MCP tools, and never verify Azure through local stdio.
- **A green deploy is proven by `/api/ping` = 200, not by the 401s.** Easy Auth answers 401 before the Functions host is reached, so every authenticated health check passes even when the host loaded zero functions (2026-09-07: a new `src/` folder missing from the deploy's staging list took every tool down for 15 minutes while seven checks stayed green). Read the health block as: ping 200 = host alive, 401 = only the auth layer alive; when in doubt the host's `/admin/functions` (master key) lists what it actually loaded.
- **Skill versions.** Skills are snapshotted per session; after a plugin change run `/plugin marketplace update`, `/plugin update`, then start a new session.
- **Targets per investigation:** ≤ 5k MCP tokens per answered question · ≤ 5 calls for a structure question · no response section > 1k tokens with zero citations · ≤ 80k context at the start of build work, else a new session.

## 7. Privacy and scope

Metadata and configuration only — never customer or vendor party data, through any tool or `raw_sql`; stop and say so if a request needs real records. `d365sec` user data is internal staff information: analyse, do not paste into external documents. Never repeat e-mail addresses from tool output.

## 8. Trace protocol (hook-captured since 2026-09-07)

Every D365 KB/XRef investigation in Claude Code is recorded as a cross-ERP trace: the request as **you** interpreted it, your strategy lines, every MCP call with its replayable arguments (never the response), the final answer. The hook reads it all from the transcript — you only have to write three things well:

- **`Request:` line first**, before the first MCP call: the ask restated ERP-neutrally, so it can be replayed against another ERP's metadata service — no person names, no data values, no object names (*"Explain the logical structure of the vendor entity and its backing table"*, not *"look at VendTable for the key user"*). It becomes `request.interpreted` and the cross-ERP join key.
- **`Entities:` line second**: the functional entities in business terms (*vendor, postal address*) — aliases resolve to vocabulary ids (`supplier` → `vendor`); `none` when there is none. Without it the hook falls back to the first call's `functional_context`, then to a vocabulary match on your request line.
- **One short strategy line before each group of calls** (*"Now the backing table with its indexes"*). Each becomes a `step`; calls without a preceding line attach to the previous step.

Three levels live in the pivot vocabulary and in the trace: **functional** (vocabulary id, `expected_entities`) → **logical** (D365FO data entity, `touched.kind = data_entity`) → **physical** (table, `touched.kind = table`). An empty logical layer is a finding, not a gap — `resource` has none in D365FO itself. Write nothing sensitive in strategy lines: a line with an e-mail or IBAN-like token is dropped from the trace (the answer is unaffected). Records land in `~/.claude/mcp-trace/hook.ndjson` and in the ingest sink (`tis-d-claudetrace-func`, blob landing + Table indexes).

- **`Request:` / `Entities:` must be the FIRST text of the reply** (2026-09-08): a text block written between tool calls is not reliably persisted in the transcript — one such block with the two lines vanished while every other mid-turn text survived — and the hook can only read what the transcript holds. Lines written later fall back to `interpretation` (your first paragraph).
- **Annotate lines in the final answer** (plugin 1.5.0): `Entity: <kind> <Name> as <source|target|related|excluded> [= <functional_entity>] [~ <erp>:<Name>] [@ functional|logical|physical]` — one per entity (*`Entity: table VendTable as source = vendor ~ M3:CIDMAS`*, level defaults from the kind: `data_entity` → logical, AOT kinds → physical); `Expect: vendor, address` (vocabulary ids, unknown ones dropped); optional `Note: <≤300 chars>` (dropped alone if it carries party data). The hook emits one `annotate` record before the `close`; the lines are stripped from the conclusion. Write them only when you actually made a structural reading — an empty annotation is not emitted.
