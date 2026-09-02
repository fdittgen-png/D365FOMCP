# D365FO MCP — Tool Guide

Served as the MCP resource `d365://tool-guide` (text/markdown) by every service; the
short form is each server's `instructions`. Long form: verb contract, first-call rules,
the 14 workflow recipes, anti-patterns. Source of the recipes:
`plugin/d365fo-mcp/skills/d365fo-mcp-workflows/SKILL.md`.

## Verb contract

| Verb | Returns | Shape | Examples |
|---|---|---|---|
| `lookup_*` | one object, in full | object | `d365_lookup_table`, `sec_lookup_role`, `sec_lookup_user` |
| `get_*` | one aspect of one object | object | `d365_get_enum`, `d365_get_class_methods`, `d365_get_method_source` |
| `find_*` | a list matching a relation | list, `limit`, `cursor` | `xref_find_references`, `sec_find_users_by_role` |
| `check_*` | a boolean per target, batchable | list of verdicts | `d365_check_field_exists(tables[])` |
| `search` / `search_names` | ranked list by text or pattern | list, `limit` | `d365_search`, `sec_search`, `xref_search_names` |
| `list_*` / `*_summary` / `stats` | catalogue or counts | list / counts | `d365_list_modules`, `xref_object_summary`, `sec_stats` |
| `resolve_*` | id → text | scalar | `d365_resolve_label` |
| `compare_*` / `*_trace` / `*_analysis` | derived result | object | `sec_compare_roles`, `sec_permission_trace`, `xref_impact_analysis` |
| `*_raw_sql` | read-only SQL, last resort | rows (hard cap) | `d365_raw_sql`, `xref_raw_sql`, `sec_raw_sql` |

Every data response opens with `## <context>`, then `_<Service> snapshot: <date>_`, then
one `_…_` line per coverage boundary that applies (fields capped, extension provenance
omitted, sealed ISV not scanned / excluded, delta-merged build), then the body.
`structuredContent` carries the same payload typed; the text channel is TOON or Markdown,
whichever is smaller (`format` pins it).

## First-call rules

| Service | Question | Start with | Then |
|---|---|---|---|
| KB | known table / class / enum name | `d365_lookup_table` / `d365_get_class_methods` / `d365_get_enum` | `d365_get_method_source` for 3–6 methods, never a full class dump |
| KB | name unknown | `d365_search` (use `object_type`, `modules`) | `d365_lookup_table` |
| KB | "does field X exist" | `d365_check_field_exists` (batch `tables`) | `d365_custom_fields` for `_Custom` UI fields (live) |
| KB | data entity | `d365_get_entity_sources` (`custom_only` for the customisation surface) | `d365_lookup_table` on the primary table |
| XRef | anything about an object | `xref_object_summary` (batch `object_names`) for counts | `xref_find_references` / `xref_find_method_callers` / `xref_find_extensions` |
| XRef | before changing an object | `xref_impact_analysis` | `xref_cross_module_deps` |
| Sec | "can user X do Y" | `sec_effective_permissions(user, object)` | `sec_object_access(object)` for the Deny path |
| Sec | "who can reach Y" | `sec_object_access(object)` | `sec_permission_trace` |
| Sec | a role's contents | `sec_lookup_role` (summary; `include_entity_permissions` opt-in) | `sec_role_hierarchy`, `sec_find_users_by_role` |
| Task Recorder | `.axtr` recording | `taskrecorder_to_markdown` | `taskrecorder_to_document` for the enriched document |

Habits that save the most: pass `limit` and the field filters (`fields_like`, `custom_only`,
`field_limit`); scope with `modules` (`["iExtension"]`); batch the array parameters
(`enum_names`, `tables`, `object_names`, `role_names`); page with `cursor`; leave `format`
on its default. A not-found response lists the closest existing names — read them before
retrying with a guess.

## Boundaries

- Rows: `truncated` / `has_more` are exact. Coverage: the `_…_` lines under the banner say
  what the response does **not** include; absence of a line means the view is complete.
- `xref_search_names` matches the object **path** (`/Tables/CustTable`). 0 rows for a
  pattern without a leading `%` is a path miss, not absence — retry with `%name%`.
- `xref_search_names` with an `object_type` filter can return 0 for an object that exists
  (name-node type mismatch); retry without the filter before concluding.
- Sealed ISV models (Lasernet, STAEDEAN, …) ship no X++ source: `d365_isv_lookup`,
  `d365_isv_extension_points` and `xref_isv_find_usages` say what a model declares and where
  it hooks in, never what its code does. `include_isv:true` on the XRef `find_*` tools adds their usages.
- `*_Custom` UI fields live in no build snapshot; `d365_custom_fields` reads them live.
- Sec indexes menu items and tables, not OData entity names: drop `Entity`/`V2`/`V3`.
- System columns (`RecId`, `DataAreaId`, `RecVersion`, `Partition`) are real on every table
  even when `d365_check_field_exists` reports them missing. Table maps are not tables —
  enumerate a map via `xref_search_names('Map/<Name>/%')`.

## Workflow recipes

Independent calls go in ONE message. Stop when the first call answers the question.

1. **Table deep dive** — parallel `d365_lookup_table(table)` + `xref_object_summary(table)`;
   then `sec_permission_trace(table)` only if security is asked. Never `d365_search` for a
   name you already know.
2. **Field investigation** — parallel `d365_check_field_exists(table, field)`,
   `d365_field_renames(field)` (AX2012 rename?), `xref_find_field_usages(table, field)`;
   then `d365_get_enum` if the type is an enum.
3. **Impact analysis before a change** — parallel `xref_impact_analysis(object)`,
   `d365_lookup_table` or `d365_get_class_methods`, `xref_find_extensions(object)`; then
   `xref_cross_module_deps(module)` when it crosses a module boundary.
4. **Method tracing** — parallel `xref_find_method_callers(class, method)` (incoming),
   `xref_method_references(class, method)` (outgoing), `d365_get_method_source(class, method)`.
5. **Security audit** — user: `sec_lookup_user` then `sec_effective_permissions(user, object)`;
   role: `sec_lookup_role`, `sec_role_hierarchy`, `sec_find_users_by_role`; object:
   `sec_object_access`; two roles: `sec_compare_roles`. The dedicated tools are
   authoritative; `sec_raw_sql` through `duty_privileges` is a fallback only.
   - 5a *Additive grant*: anchor first (`sec_lookup_user`, `sec_effective_permissions`), then
     survey reuse (`sec_object_access`, `sec_search(object_type="role")`), and only then design
     a role. Prefer an existing curated read role, then an OOB role that does not overgrant.
   - 5b *Object granularity*: pass the underlying table or menu item, never the entity name;
     stop after two attempts.
   - 5c *Feature → securable object*: `sec_raw_sql` on `privileges.label LIKE '%feature%'` →
     `privilege_entry_points` → `sec_object_access(menuItem)`. FTS is unreliable here.
   - 5d *Works for A, fails for B*: `sec_effective_permissions` for both. Both granted → not
     security: check navigation/personalisation, company scope, user→worker link. A blank
     page is not "not authorized".
6. **Research a topic** — documentation sources (Microsoft Learn search → fetch) in parallel
   with the metadata tools; KB for metadata, docs for concepts, never the reverse.
7. **Data entity mapping** — parallel `d365_get_entity_sources(entity)` (`custom_only` for the
   customisation), `d365_lookup_table(primaryTable)`, `xref_find_references(entity)`.
8. **Enum resolution** — `d365_get_enum(enum)` (batch `enum_names`); enum name unknown →
   `d365_check_field_exists` reveals the EDT/enum first.
9. **Class extensibility** — parallel `d365_get_class_methods`, `xref_class_hierarchy`,
   `xref_find_extensions`, `xref_find_event_handlers`.
10. **Parse a task recording** — `taskrecorder_to_markdown(content, name)`; then drill into
    its Data Sources / Security Roles with `d365_lookup_table`, `sec_permission_trace`,
    `xref_find_references`, `sec_lookup_role`.
11. **Test documentation from a recording** — `taskrecorder_to_markdown`, read the Recorded
    Steps as process + test data, then `d365_lookup_table(primaryTable)` for the data model.
12. **Fails once, retry succeeds** — `d365_lookup_table` on every table in the chain; read
    `cache_lookup`, the clustered/alternate key shape and date-effective EDTs. A composite
    `(key, ValidFrom)` temporal table is the testable explanation; an environment-agnostic
    theory needs a "why only here" argument before it is presented.
13. **Migration-defect RCA via DMF entities** — `d365_search(object_type="entity")` by table,
    then `d365_get_entity_sources` per candidate; read `method_count` as validation depth
    (`defaultCTQuery` only = thin pass-through, prime suspect). State which entity was used
    as a hypothesis, not a fact. `module_id` on any result names the custom model.
14. **"Who wipes/writes this field?"** — `d365_check_field_exists` + `xref_find_field_usages`
    (may miss real writers); then `d365_raw_sql` over `methods.source_code LIKE '%Field%' AND
    LIKE '%tableHint%'` as ground truth; rule custom code in/out early
    (`xref_list_modules(origin='custom')`, `xref_search_names('%Table%', modules=[...])`);
    walk callers up with `xref_find_method_callers` to the reported moment; read the winning
    method's source; resolve named labels via the `labels` table.

## Raw SQL guardrails

Aggregate, never enumerate (one row per entity via `count(*)`/`GROUP BY`); no `group_concat`
over an unbounded column; always `LIMIT`; the query must start with `SELECT`/`WITH`/`PRAGMA`
(a leading comment fails the guard) and may not contain `UPDATE`/`DELETE`/`INSERT` even
inside a string literal; sanity-check `duty_privileges` before trusting a derived join. The
real KB tables are `tables`, `fields`, `methods(owner_name, method_name, source_code)`,
`labels(label_id, text)` — discover with `SELECT name FROM sqlite_master WHERE type='table'`.

## Anti-patterns

| Do not | Instead |
|---|---|
| `d365_search` for a known name | `d365_lookup_table` / `d365_get_enum` directly |
| Sequential calls that do not depend on each other | one message, parallel |
| `include_source` on more than one class | signatures, then `d365_get_method_source` for the few methods |
| Unfiltered `d365_list_modules` / `sec_lookup_role` with entity permissions | `origin`/`modules` filter; opt-in flags |
| Retrying a failing tool a third time | one retry, then an alternative source |
| Designing a role before `sec_lookup_user` + `sec_object_access` | anchor to the current state, reuse an existing role |
| Entity names to `sec_object_access` / `sec_effective_permissions` | underlying table or menu item |
| "Missing role" from one user's failure | `sec_effective_permissions` for both users, then pivot |
| Trusting 0 rows from `xref_search_names` with no leading `%` or with `object_type` | retry `%name%` / without the filter |
| Trusting `xref_find_field_usages` 0 writes as proof | KB source search (recipe 14) |
| `d365_check_field_exists` on a table map | `xref_search_names('Map/<Name>/%')` |
| Stopping an RCA at the first plausible writer | walk each writer's callers to the reported moment |
| A row per (role × privilege) or `group_concat` in `*_raw_sql` | aggregate first, expand one slice |
