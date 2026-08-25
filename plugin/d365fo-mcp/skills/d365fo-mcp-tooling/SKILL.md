---
name: d365fo-mcp-tooling
description: How to use the D365FO MCP services (d365kb, d365xref, d365sec, d365taskrecorder, wiki) correctly and cheaply — which server and tool to call first for any Dynamics 365 Finance & Operations question about a table, field, class, method, form, enum, data entity, menu item, security role, duty, privilege, user access, licence, task recording (.axtr), or customisation/extension; response format (TOON vs markdown), modules filter, snapshot freshness, verification rules, raw-SQL guardrails, token-efficiency and privacy rules. Load this before the first MCP call in any D365FO conversation.
---

# D365FO MCP tooling — how to get the right answer in the fewest calls

Four MCP servers expose a **read-only snapshot** of a D365FO build (AOT metadata, cross-references, security configuration) plus a Task Recorder converter. They return facts; you supply the reasoning. The rules below are the difference between a verified answer and a plausible-sounding guess.

## 1. Service map — need → server → first tool

| Need | Server | Start with | Then |
|---|---|---|---|
| Table structure (fields, indexes, relations, properties) | `d365kb` | `d365_lookup_table` | `d365_get_enum` for enum fields, `d365_find_referencing_tables` for incoming FKs |
| "Does field X exist on table Y?" | `d365kb` | `d365_check_field_exists` | `d365_field_renames` if it was an AX2012 name |
| Join two tables correctly | `d365kb` | `d365_get_join_keys` | `d365_sql_template` for a ready query |
| Enum values ↔ integers | `d365kb` | `d365_get_enum` | — |
| Class API, method list, inheritance | `d365kb` | `d365_get_class_methods` | `d365_get_method_source` (line-numbered X++) |
| Data entity → backing tables/fields | `d365kb` | `d365_get_entity_sources` | `xref_find_references` on the entity |
| Fuzzy "what objects relate to <term>" | `d365kb` | `d365_search` (FTS, use `modules` to scope) | `d365_lookup_table` on hits |
| Module / model inventory, build provenance, custom vs Microsoft | `d365kb` / `d365xref` | `d365_list_modules`, `xref_list_modules` | `d365_get_module_summary` |
| Am I hallucinating a name? | `d365kb` | `d365_hallucination_check` | — |
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

- **Match on tool name, not server label.** `d365kb` / `d365xref` / `d365sec` / `d365taskrecorder` above are logical names. The same servers appear as `D365 KB` / `D365 xRef` / `D365 Sec` / `D365 Task recorder` (claude.ai connectors), as `plugin_d365fo-mcp_<key>` (Claude Code plugin) or under whatever alias the host assigned — the tool names (`d365_lookup_table`, `xref_object_summary`, `sec_permission_trace`, …) are identical everywhere and are the stable key.
- **A service that is not connected is a gap, not a detour.** If no tool from a needed server is available or it times out, say so in the answer and mark the affected findings as unverified. Do not substitute another server's `*_raw_sql`, local files, or memory for it — that produces confident-looking answers from the wrong source (the security model, for example, lives only in `d365sec`).
- **Parallel by default — but not against one server at once with heavy calls.** The servers run SQLite synchronously: one slow query blocks every other call to that host until it finishes. Batch cheap lookups freely; fan out `sec_object_access` / `xref_find_references` on broad objects one at a time with a `limit`. Independent lookups (table + xref summary + extensions + security) go in one batch. Sequence only when an argument depends on a previous result (e.g. enum names discovered from `d365_lookup_table`).
- **Counts before lists — as the *first* call, not alongside the lists.** `xref_object_summary`, `sec_stats`, `d365_get_module_summary` cost a few hundred tokens and tell you which follow-up lists are worth asking for at all. Firing `xref_find_extensions` + `xref_find_event_handlers` + `xref_find_references` in the same batch as the summary defeats the purpose: you pay for lists you may not need. Run the summary, read the counts, then batch only the lists that matter.
- **`limit` on every list-returning call, no exceptions.** Any tool whose reference table shows a `limit` parameter returns a list — `xref_find_extensions`, `xref_find_event_handlers`, `xref_find_references`, `xref_find_method_callers`, `sec_object_access`, `sec_find_users_by_role`, `d365_search`, …. Pass `limit: 20` first; the response's truncation note tells you when more exists — only then re-query with a bigger limit. Defaults are 100–500 rows, which is thousands of tokens of rows you will not cite. (Measured: a run that skipped `limit` on 9 of 10 list calls cost the same tokens as no skill at all.)
- **Never re-fetch** what is already in context; reuse the earlier result.
- **Every factual claim has a call behind it.** Before writing "X extends Y" or "role R has privilege P", find the tool result that says so. If the only source is your background knowledge, write it as an inference ("standard behaviour is …, not verified in this build") — the reader must be able to tell which is which. A confident unbacked sentence is the single most damaging thing these tools exist to prevent.
- **Prefer typed tools to raw SQL.** Raw SQL is for shapes no tool covers; when you use it, `LIMIT` always, `COLLATE NOCASE` on name comparisons, never `SELECT *` on the 3 GB XRef DB, and expect the KB schema in `references/kb-raw-sql-schema.md` (not the AxDB schema).

## 3. Reading responses

- **`format`** — the text channel defaults to **TOON** (compact key/value blocks, token-efficient). Pass `format: "markdown"` only when the output is quoted verbatim to a human (a report section, a ticket comment). The `structuredContent` JSON is identical either way — use it for anything you post-process.
- **Freshness banner** — every data response starts with `_<service> snapshot: <date>_`. Quote that date when a claim matters ("verified against the 2026-08-14 KB snapshot"). The snapshot is a single build: it proves an object *exists now*; it cannot tell you *when* it appeared.
- **`modules` filter + provenance** — `d365_list_modules` / `xref_list_modules` return each model's publisher, layer, origin (`microsoft` / `isv` / `custom`) and version. Pass `modules: ["iExtension", …]` to `d365_search`, `xref_search_names`, `sec_search` to see only customisations; omit it for standard behaviour. Say which layer a finding comes from.
- **Empty vs not-found** — an empty result (no `isError`) means "valid object, zero rows". `isError: true` with *not-found* means the object does not exist in this build: re-check spelling with `d365_search` / `xref_search_names` before concluding it was removed.
- **Labels** — `@SYS…` ids are resolved server-side; if you see a raw id in the text, mention it as a data gap rather than inventing a label.
- Details of the contract (`structuredContent`, error categories, truncation kinds): `references/response-format.md`.

## 4. Verify before you assert

| Claim | Minimum evidence |
|---|---|
| "Field X exists / has type T" | `d365_check_field_exists` or `d365_lookup_table` row — not memory, not AX2012 knowledge |
| "Method M does Y" | `d365_get_method_source` — quote line numbers |
| "Nothing else uses this" | `xref_object_summary` count = 0 **and** `xref_find_extensions` empty — note that the XRef covers compiled models only |
| "User U can(not) do Z" | `sec_permission_trace` chain role → sub-role → duty → privilege → entry point **with Deny-wins applied** (`sec_effective_permissions`) — never from role names alone |
| "Role R is minimal / over-provisioned" | `sec_compare_roles` + `sec_licence_assessment` |
| Numeric facts from KB | Treat TEXT-typed numerics as strings that need coercion; do not compare `"10" > "9"` |
| DMF vs AOT names | DMF exports are UPPERCASE, AOT is mixed-case — compare case-insensitively |

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

## 6. Privacy and scope

- The services hold **metadata and configuration**, not business transactions. Never use them (or `*_raw_sql`) to pull customer or vendor party data; if a request needs real consumer/vendor records, stop and say so.
- `d365sec` user data (user ids, role assignments) is **internal staff** information: use it in the analysis, do not paste it into external documents or share it outside the organisation.
- Do not repeat e-mail addresses that appear in tool output.
