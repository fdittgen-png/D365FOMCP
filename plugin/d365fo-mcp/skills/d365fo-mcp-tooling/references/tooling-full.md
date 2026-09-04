# D365FO MCP tooling — full reference

> The complete text the tooling skill carried until 2026-09-04 (v1.2). The skill's SKILL.md is now a ≤ 7 KB core; read this file when a rule needs its measurement or its full wording. Kept verbatim so nothing was lost in the split.

# D365FO MCP tooling — how to get the right answer in the fewest calls

Four MCP servers expose a **read-only snapshot** of a D365FO build (AOT metadata, cross-references, security configuration) plus a Task Recorder converter. They return facts; you supply the reasoning. The rules below are the difference between a verified answer and a plausible-sounding guess.

## 1. Service map — need → server → first tool

| Need | Server | Start with | Then |
|---|---|---|---|
| Table structure (fields, indexes, relations, properties) | `d365kb` | `d365_lookup_table` | `d365_get_enum` for enum fields, `d365_find_referencing_tables` for incoming FKs |
| Table **as compiled** — base fields + every extension's fields, each tagged `origin` / `module` / `model_origin` | `d365kb` | `d365_effective_schema` | Replaces the `d365_lookup_table` + `xref_find_extensions` chain when the question is "which fields does this table really have, and who added them". Sealed-ISV extensions are listed by name only |
| "Does field X exist on table Y?" | `d365kb` | `d365_check_field_exists` | `d365_field_renames` if it was an AX2012 name; a `_Custom` name resolves live — see §4 |
| "Which UI custom fields exist on table Y?" | `d365kb` | `d365_custom_fields` | Live per-environment read, not the build snapshot. `table_name` attribution is **derived** — quote the row's `attribution` |
| Join two tables correctly | `d365kb` | `d365_get_join_keys` | `d365_sql_template` for a ready query |
| Enum values ↔ integers | `d365kb` | `d365_get_enum` | — |
| Class API, method list, inheritance | `d365kb` | `d365_get_class_methods` | `d365_get_method_source` (line-numbered X++) |
| Data entity → backing tables/fields | `d365kb` | `d365_get_entity_sources` (takes the AOT name, the OData public name **or** the collection name; add `custom_only: true` for just the customisation surface) | `xref_find_references` on the entity |
| Fuzzy "what objects relate to <term>" | `d365kb` | `d365_search` (FTS, use `modules` to scope) | `d365_lookup_table` on hits |
| Module / model inventory, build provenance, custom vs Microsoft | `d365kb` / `d365xref` | `d365_list_modules` / `xref_list_modules` with `origin: "custom"` (or `"isv"`) — a handful of rows instead of ~170 | `d365_get_module_summary` |
| Am I hallucinating a name? | `d365kb` | `d365_hallucination_check` | — |
| Do these objects / methods exist in the XRef? (preflight, ≤50) | `d365xref` | `xref_check_exists` (`Name`, `/Type/Name`, `Owner.method`) | misses carry suggestions; then `xref_object_summary` |
| Do these roles / duties / privileges / entry points exist? (preflight, ≤50) | `d365sec` | `sec_check_exists` — casing-tolerant, returns `canonical_name` | then `sec_lookup_role` / `sec_permission_trace` |
| Label text for a `@SYS…` id | `d365kb` | `d365_resolve_label` (tools resolve labels server-side; call this only for a bare id) | — |
| Who uses / calls / reads / writes an object | `d365xref` | `xref_object_summary` (counts first) | `xref_find_references`, `xref_find_field_usages`, `xref_find_method_callers` |
| CoC extensions, event handlers, overlayering | `d365xref` | `xref_find_extensions`, `xref_find_event_handlers` | `xref_class_hierarchy`, `xref_interface_implementors` |
| Impact of changing X | `d365xref` | `xref_impact_analysis` | `xref_cross_module_deps` |
| Role / duty / privilege contents | `d365sec` | `sec_lookup_role` / `sec_lookup_duty` / `sec_lookup_privilege` | `sec_role_hierarchy` |
| Can user U reach object O? Why not? | `d365sec` | `sec_permission_trace` | `sec_effective_permissions` (Deny-wins verdict) |
| Who can access object O / who has role R | `d365sec` | `sec_object_access`, `sec_find_users_by_role` | `sec_company_users` for company scope |
| Role design, comparison, licence | `d365sec` | `sec_compare_roles`, `sec_licence_assessment`, `sec_what_if` | — |
| Task recording → steps / test doc | `d365taskrecorder` | `taskrecorder_to_markdown` | `taskrecorder_to_document` (enriched MHTML, optional contract XML) |
| Internal wiki / ticket knowledge | `wiki-*` | `wiki_search` | `wiki_read` by slug; `wiki_index` once per session |
| Anything the typed tools cannot express | `*_raw_sql` | read `references/kb-raw-sql-schema.md` first | `SELECT name FROM sqlite_master` before guessing table names |

Full parameter tables per server (generated from the code, always current): `references/kb-tools.md`, `references/xref-tools.md`, `references/sec-tools.md`, `references/taskrecorder-tools.md`, `references/wiki-tools.md`.

## 2. Call discipline

- **New topic → offer a new session BEFORE any work (A1).** If the new prompt does not need the prior context, answer first: *"This is a new topic — a fresh session will cost about half; continue here or restart?"* Measured 2026-09-04: build work done on top of 150 k tokens of unrelated context was 71 % of an 8.70 USD session; the same turns in a fresh session cost about half. This is an obligation of the assistant, not a habit of the user.
- **Decide the answer shape before the first call, and say it in one line (A2).** *"Shape: data sources + keys + party link → 1 summary + 1 lookup."* Then call. Two runs of the same structure question cost 25 k and 17 k MCP tokens because both opened with field lists; the shape needed ≈ 1.5 k. The user can steer the shape too ("summary only", "three calls max", "ten lines").
- **Counts and aggregates before any list (B1).** Entities: `d365_get_entity_sources` in its default **summary** mode (data sources + counts) before any field rows. Tables: `d365_lookup_table` with `sections: ["indexes","relations_out"]` before fields. `xref_object_summary` / `sec_stats` before their lists.
- **Provenance on the FIRST call, never a second lookup (B2).** When customisation is in scope pass `include_provenance: true` on the first `d365_lookup_table`; never re-call the same table with `custom_only` — before C1 that re-emitted 4.9 k tokens of relations, now it returns fields only, but it is still a second call for nothing.
- **No discovery search for a known name (B3).** `d365_search` only when the object name is unknown; never to "see what else exists" around an entity you already have. A 15-hit search around VendVendorV2Entity cost 891 tokens and was cited zero times.
- **raw_sql: aggregate, then sample (B4).** `GROUP BY` first, then at most 5 rows per group; never a > 50-row dump into context.
- **Ask for the slice with the new parameters (C1/C2/C4).** `d365_lookup_table` takes `sections` (default `fields,indexes,relations_out`; incoming relations are a count unless `relations_in` is asked for; `custom_only` alone → fields only). `d365_get_entity_sources` defaults to `summary: true` (≈ 300 tokens) — field rows only with `fields_like` / `custom_only` / `computed_only` / `limit` / `cursor` or `summary: false`. `d365_search` omits snippets unless `include_context: true`. A response that is large and was not narrowed carries a `_Hint: …_` line naming the parameter to pass next time — read it.
- **Match on tool name, not server label.** `d365kb` / `d365xref` / `d365sec` / `d365taskrecorder` above are logical names. The same servers appear as `D365 KB` / `D365 xRef` / `D365 Sec` / `D365 Task recorder` (claude.ai connectors), as `plugin_d365fo-mcp_<key>` (Claude Code plugin) or under whatever alias the host assigned — the tool names (`d365_lookup_table`, `xref_object_summary`, `sec_permission_trace`, …) are identical everywhere and are the stable key.
- **A service that is not connected is a gap, not a detour.** If no tool from a needed server is available or it times out, say so in the answer and mark the affected findings as unverified. Do not substitute another server's `*_raw_sql`, local files, or memory for it — that produces confident-looking answers from the wrong source (the security model, for example, lives only in `d365sec`).
- **Parallel by default — but not against one server at once with heavy calls.** The servers run SQLite synchronously: one slow query blocks every other call to that host until it finishes. Batch cheap lookups freely; fan out `sec_object_access` / `xref_find_references` on broad objects one at a time with a `limit`. Independent lookups (table + xref summary + extensions + security) go in one batch. Sequence only when an argument depends on a previous result (e.g. enum names discovered from `d365_lookup_table`).
- **Counts before lists — as the *first* call, not alongside the lists.** `xref_object_summary`, `sec_stats`, `d365_get_module_summary` cost a few hundred tokens and tell you which follow-up lists are worth asking for at all. Firing `xref_find_extensions` + `xref_find_event_handlers` + `xref_find_references` in the same batch as the summary defeats the purpose: you pay for lists you may not need. Run the summary, read the counts, then batch only the lists that matter.
- **`limit` on every list-returning call, no exceptions.** Any tool whose reference table shows a `limit` parameter returns a list — `xref_find_extensions`, `xref_find_event_handlers`, `xref_find_references`, `xref_find_method_callers`, `sec_object_access`, `sec_find_users_by_role`, `d365_search`, …. Pass `limit: 20` first; the response tells you when more exists. Defaults are 100–500 rows, which is thousands of tokens of rows you will not cite. (Measured: a run that skipped `limit` on 9 of 10 list calls cost the same tokens as no skill at all.)
- **More rows → `cursor`, never a bigger `limit`.** The list tools are paginated: the payload carries `has_more` and, when true, `next_cursor`. Pass it back as `cursor` with the same arguments to get the *next* page. Re-issuing the call with a larger `limit` re-pays every row you already have. Paginated today: `d365_search`, `d365_get_class_methods`, `d365_get_entity_sources`, `xref_find_references`, `xref_find_usages`, `sec_search`, `sec_find_roles_by_duty`, `sec_find_roles_by_privilege`. On the others the truncation note says which limit applied (`user` = yours, `cap` = tool default you may raise, `hard` = ceiling you cannot).
- **Several targets of one kind → one batch call.** `d365_get_enum` (`enum_names`), `d365_check_field_exists` (`tables`), `d365_get_method_source` (`method_names`, ≤10), `d365_search` (`queries`, ≤5), `xref_object_summary` (`object_names`), `xref_find_references` (`objects`, ≤10), `sec_lookup_role` (`role_names`, ≤10), plus the three `check_exists` tools. One turn instead of N; the JSON payload is about the same size as the singles (the batch hoists what the entries repeat), the text channel a little larger. A partial batch is a success — misses land in `not_found[]`, hits are normal rows. `d365_lookup_table` has no batch on purpose: one response is already large, so ask for tables one at a time with `fields_like` / `custom_only`.
- **A "you are repeating this call" note means stop, not retry.** The servers return a short corrective note instead of the payload when the same tool with the same arguments is called three times within fifteen calls. The answer is already in your context or the arguments are wrong — change them or move on. Likewise a one-time *snapshot is N days old* note is information to pass on, not an error.
- **Ask for the slice you need — response size is a parameter, not a fate.** `d365_get_entity_sources` omits method signatures unless you pass `include_methods: true` (`method_count` is always there) and narrows a wide entity with `custom_only` / `computed_only` / `fields_like` / `limit`; `d365_lookup_table` takes `fields_like` / `custom_only` (counts stay whole-table); `d365_list_modules` / `xref_list_modules` take `origin` / `layer` / `publisher` / `include_counts`; `d365_find_referencing_tables`, `xref_class_hierarchy`, `xref_interface_implementors`, `xref_impact_analysis` take `limit`. Measured on a real export task: the unfiltered forms of two of these tools were 82% of the whole KB token bill.
- **X++ source is two-tier — never pull a whole class to read three methods.** `d365_get_class_methods` is tier 1: signatures plus each body's `source_lines`, no code. Read that, pick the methods that matter, then get their bodies from `d365_get_method_source`. **One method → `method_name`; two or more → `method_names` (up to 10 in one call).** That is not a preference, it is measured: a 4-method batch is 1,070 tokens against 1,092 for four single calls *and* costs one turn instead of four; at 10 it is 2,756 vs 2,855 and 1 turn instead of 10. Only at n=1 does the single form win (140 vs 157 tokens). `include_source: true` is tier 2 for the *entire* class and costs ~5–6× the signature listing (measured: 12,363 vs 1,985 tokens on `BankStatementImportBatch`; 53,473 vs 9,029 on `CustTable`). Use it on **at most one class per investigation** — the one you are actually extending. `source_lines` is there so this is a decision and not a guess: a 9-line method is worth a punt, a 179-line one is worth reading the signature first.
- **Name several objects → `check_exists` first.** Before writing SQL, X++ or a security answer that names several objects, verify the names in ONE batch call — `d365_check_field_exists` (fields), `xref_check_exists` (objects, paths, `Owner.method`), `sec_check_exists` (roles/duties/privileges/entry points, returns the canonical casing) — instead of one lookup per name or a confidently wrong name. A miss is data with suggestions, not an error: fix the spelling before the next call.
- **Pass `functional_context`** (a vocabulary id such as `sales_order`) on `d365_lookup_table`, `d365_get_entity_sources`, `xref_find_references`, `sec_lookup_role`, … when you know the business entity: a hit records the association for later sessions, a miss lists the objects already mapped to that entity.
- **Never re-fetch** what is already in context; reuse the earlier result.
- **Every factual claim has a call behind it.** Before writing "X extends Y" or "role R has privilege P", find the tool result that says so. If the only source is your background knowledge, write it as an inference ("standard behaviour is …, not verified in this build") — the reader must be able to tell which is which. A confident unbacked sentence is the single most damaging thing these tools exist to prevent.
- **Prefer typed tools to raw SQL.** Raw SQL is for shapes no tool covers; when you use it, `LIMIT` always, `COLLATE NOCASE` on name comparisons, never `SELECT *` on the 3 GB XRef DB, and expect the KB schema in `references/kb-raw-sql-schema.md` (not the AxDB schema).

## 3. Reading responses

- **`format`** — the text channel is **adaptive** by default: the server picks TOON or Markdown per response, whichever is smaller (TOON wins on nested payloads, Markdown on wide flat tables — neither wins everywhere, measured). Leave it alone. Pass `format: "markdown"` only when the output is quoted verbatim to a human (a report section, a ticket comment). The `structuredContent` JSON is identical either way — use it for anything you post-process.
- **Freshness banner** — every data response starts with `_<service> snapshot: <date>_`. Quote that date when a claim matters ("verified against the 2026-08-14 KB snapshot"). The snapshot is a single build: it proves an object *exists now*; it cannot tell you *when* it appeared.
- **`_Hint: …_` (C6)** under the banner means the response was large (> 8 KB JSON) and no narrowing parameter was passed; the line names the parameter (`sections`, `fields_like`, `summary`, `object_type`). It is a nudge, not an error.
- **Coverage lines — what the response does NOT cover.** Directly under the banner a data response may carry one italic line per gap, mirrored by a typed key: `field_limit_hit` (not every field shown — raise `limit` or narrow with `fields_like`), `provenance_omitted` (per-row model attribution dropped from the default view; `include_provenance` restores it), `isv_not_scanned` (no sealed-ISV pass in this build), `isv_excluded` (an exact count of sealed-ISV references left out — `include_isv` or `xref_isv_find_usages` brings them in), `partial_build` (the KB was refreshed by a per-model delta; models not in the delta are older than the banner date). These lines are the evidence limits of your answer: carry them into the deliverable ("XRef excludes 12 sealed-ISV references") instead of silently asserting completeness.
- **`modules` filter + provenance** — `d365_list_modules` / `xref_list_modules` return each model's publisher, layer, origin (`microsoft` / `isv` / `custom`) and version. Pass `modules: ["iExtension", …]` to `d365_search`, `xref_search_names`, `sec_search` to see only customisations; omit it for standard behaviour. Say which layer a finding comes from.
- **Two counts in a filtered response** — `field_count` / `result_count` / `module_count` are the totals; `fields_returned` / `returned_count` are what you actually got back. When they differ, the truncation note says which limit applied.
- **Empty vs not-found** — an empty result (no `isError`) means "valid object, zero rows". `isError: true` with *not-found* means the object does not exist in this build **and the response lists the closest existing names** — pick from that list and re-issue; do not spend a `d365_search` / `xref_search_names` call on a spelling the server has already corrected for you.
- **Labels** — `@SYS…` ids are resolved server-side; if you see a raw id in the text, mention it as a data gap rather than inventing a label.
- Details of the contract (`structuredContent`, error categories, truncation kinds): `references/response-format.md`.

## 4. Verify before you assert

| Claim | Minimum evidence |
|---|---|
| "Field X exists / has type T" | `d365_check_field_exists` or `d365_lookup_table` row — not memory, not AX2012 knowledge |
| "Method M does Y" | `d365_get_method_source` — quote line numbers |
| "Nothing else uses this" | `xref_object_summary` count = 0 **and** `xref_find_extensions` empty **and** no `isv_excluded` line (or `include_isv: true` / `xref_isv_find_usages` also empty) — the main XRef tables hold compiled models only; sealed-ISV usages (Lasernet, banking, …) live in the `isv_*` tables and are reported as an exact excluded count, never silently |
| "User U can(not) do Z" | `sec_permission_trace` chain role → sub-role → duty → privilege → entry point **with Deny-wins applied** (`sec_effective_permissions`) — never from role names alone |
| "Role R is minimal / over-provisioned" | `sec_compare_roles` + `sec_licence_assessment` |
| Numeric facts from KB | Treat TEXT-typed numerics as strings that need coercion; do not compare `"10" > "9"` |
| DMF vs AOT names | DMF exports are UPPERCASE, AOT is mixed-case — compare case-insensitively |
| "Field X does not exist" when `d365_check_field_exists` says false | Two false-negative classes. (a) `LAC*`/`PRN*` fields on Microsoft tables (e.g. `SalesConfirmDetailsTmp.LACTransRefRecId`) come from **binary-only ISV models** — try `d365_isv_lookup`, else the local Lasernet `metadata-inventory`. (b) The **`_Custom` suffix** means a D365 UI custom field (System administration › Setup › Custom fields), held in a *runtime* table extension that no build snapshot contains: `d365_check_field_exists` now resolves these live when an environment is configured, and otherwise returns the field-class explanation — **read the note, do not restate the boolean**. Use `d365_custom_fields` to enumerate. Either way say "not in the metadata snapshot", never "does not exist" |

Separate **confirmed** (tool output) from **inferred** (your reasoning) in every deliverable; label the inferred part.

## 5. Which command runs the whole workflow

| Intent | Command |
|---|---|
| Full table analysis | `/d365-table <Table>` |
| Class structure, extension surface | `/d365-class <Class>` |
| One field end-to-end | `/d365-trace-field <Table.Field>` |
| Change impact, go/no-go (single object) | `/d365-impact <Object>` |
| Architectural blast radius of a change request | `/arch-change-impact <change>` |
| Module / ISV model health | `/arch-module-review <Module>` |
| Access investigation, grants, "not authorized" | `/d365-security <user | role | object>` |
| Business-language "can X do Y" | `/biz-access-check <user> <action>` |
| SoD / over-provisioning audit | `/tech-security-audit <scope>` |
| X++ code review | `/tech-code-review <Class[.Method]>` |
| Multi-source research (wiki, RAG, Learn, AOT) | `/d365-research <topic>` |
| Internal wiki lookup | `/d365-wiki <query | slug>` |
| Functional analysis document | `/func-analysis <requirement | .axtr>` |
| Process analysis / fit-gap | `/func-process-analysis <process | .axtr>` |
| Configuration review | `/func-config-review <area>` |
| Plain-language process guide | `/biz-explain-process <process | .axtr>` |
| Ticket scoping | `/support-scope <ticket | .axtr>` |
| Root-cause diagnosis | `/support-diagnose <issue>` |
| Reproduction scenario / payload replay | `/support-reproduce <.axtr | issue>` |

Multi-step recipes without a command (migration-defect RCA, "who wipes this field", caching bugs): the `d365fo-mcp-workflows` skill.

## 6. Targets per investigation (D3)

| KPI | Target |
|---|---|
| MCP tokens per answered question | ≤ 5 k |
| MCP calls for a structure question | ≤ 5 (the `/d365-entity` recipe needs 3) |
| Response sections with zero citations | none > 1 k tokens — narrow the call instead |
| Context at the start of build work | ≤ 80 k tokens, else a new session (A1) |

Measure with `Get-SessionTurnStats.js` / `Get-McpCallStats.js` (kept next to the efficiency analysis, outside this plugin) at the end of an expensive session.

## 7. Privacy and scope

- The services hold **metadata and configuration**, not business transactions. Never use them (or `*_raw_sql`) to pull customer or vendor party data; if a request needs real consumer/vendor records, stop and say so.
- `d365sec` user data (user ids, role assignments) is **internal staff** information: use it in the analysis, do not paste it into external documents or share it outside the organisation.
- Do not repeat e-mail addresses that appear in tool output.
