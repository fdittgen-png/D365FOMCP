# Semantic layer — functional-entity traces and data-quality rules (ADR W7 + W7b, #111)

## Purpose

The KB/XRef/Sec snapshots say what exists. The semantic layer records two things a conversation
concludes and that otherwise evaporate: **what a functional entity *is* technically in this
installation** (`sales_order` = `SalesTable` header, `SalesLine` line, `SalesFormLetter` posting) and
**what *correct* looks like for that data** (declarative DQ rules). Both are keyed on an ERP-neutral
vocabulary, so the same shapes emitted by an M3, AX2012 or Sage bridge line up by construction —
that is the Clermont-Ferrand M3→D365 mapping problem made incremental.

Two hard lines: the MCP **stores and serves rules, never executes them** (a generator renders them
into SQL that runs where the data lives, no AI in the loop); and the store holds **metadata only**.

## Store — `d365fo_semantic.sqlite`

The only read-write database in the platform (`SEMANTIC_DB_PATH`, default
`~/.claude/d365fo_semantic.sqlite`, Azure `/home/data/d365fo_semantic.sqlite`; WAL; created on first
open). Physically separate from the snapshots so traces survive the weekly rebuilds.
`src/azure/semantic-store.js` owns the DDL (`ensureSemanticSchema`, idempotent) and every write.

| Table | Holds | Key |
|---|---|---|
| `sem_vocabulary` | ≤60 ERP-neutral entities from `config/semantic-vocabulary.json`, versioned | `entity_id` |
| `sem_entity_relations` | `from → to (relation)`: party, parent, what, where, settles… | (from, to, relation) |
| `sem_mappings` | entity → object: type, name, model, `role`, `source`, `confidence`, `confirmations`, `verified`, salted `session_hash` | (installation, entity, type, name, role) |
| `sem_dq_rules` | one dimension + dialect-free `spec` JSON, severity, source, confidence, `enabled`; **versioned, never deleted** | (`rule_id`, version) |
| `sem_dq_rule_links` | rule → entity (+role): the same rule id across systems makes DQ comparable per entity | (rule_id, entity_id) |
| `sem_dq_dialect_overrides` | `sql_fragment` per dialect — escape hatch for closeness/consistency | (rule_id, dialect) |
| `sem_dq_runs` | **aggregates only**: `rows_checked`, `rows_flagged` per run — no row key, no value (asserted by test) | id |

`rule_id` = `dq_` + hash(installation, object, field, dimension, spec-hash) — deterministic, so a
re-declared rule is the same rule. `confidence` = base(source) + 0.03 × confirmations, capped 0.99
(user_confirmed 0.90 · kb_derived 0.80 · seed 0.60 · assistant_inferred 0.50 · context_hint 0.20).
A weaker source never downgrades a stronger one.

## Tools (`src/azure/semantic-tools.js`, `registerSemanticTools(server, semDb, kbDb)`)

| Tool | Kind | Contract |
|---|---|---|
| `d365_map_entity` | **write** | `entity_id, objects[{type,name,role}] (1..50), confirmed_by_user, note?, session_token?` → upsert. `source` = `user_confirmed` or `assistant_inferred`. Each object is verified against the KB (read-only); unknown objects are recorded `verified:false` and listed, not rejected. Unknown entity → `notFoundResult` with suggestions. |
| `d365_map_dq_rule` | **write** | `entity_id \| object_name, field_name?, dimension, spec, severity, confirmed_by_user, enabled, note?` → `rule_id` + `version`. Same content → `unchanged`/`confirmed`; changed severity or `enabled:false` → new version. |
| `d365_entity_map` | read | `entity_id` (forward: objects grouped by role + related entities) or `object_name` (reverse: entities), `min_confidence`. |
| `d365_dq_rules` | read | `entity_id \| object_name, dimension?, min_severity?, include_disabled?, limit` → applicable set: rules bound to the object **plus** rules linked to the entities it is mapped to; each row carries `binding` (`object` / `entity:<id>`). **This is the input to generation.** |

The write tools carry `WRITE_METADATA_ANNOTATIONS` (`readOnlyHint:false, destructiveHint:false,
idempotentHint:true, openWorldHint:false`) — defined in `semantic-tools.js`, deliberately not in
`shared.js`. Everything else follows the response-format contract (typed-first `structuredResult`,
H2 heading, `emptyResult`/`notFoundResult`/`errorResult`, `truncationNote`, shared `format`).

## Dimensions and spec shapes (validated with Zod, one schema per dimension)

`format` `{type:"length",max,min?,edt?}` · `{type:"pattern",regex}` · `{type:"edt",edt,max_length?}` —
`completeness` `{type:"not_null"}` · `{type:"not_in",values}` — `domain` `{type:"enum",enum,allowed?}` ·
`{type:"range",min?,max?}` — `uniqueness` `{type:"unique",fields}` — `closeness`
`{type:"similarity",fields,algorithm,threshold,blocking?}` — `referential_integrity`
`{type:"fk",to:"Table.Field"|"Table",pairs?,nullable?}` — `consistency` `{type:"cross_field",expr}`
(**trusted input**, rendered verbatim) — `timeliness` `{type:"age",field,max_days,when?}` —
`target_readiness` `{type:"target",entity,checks:[mandatory|enum_map|uom_map|key_unique],mandatory_fields?,key_fields?}`.

## Workflow: seed → confirm → export → generate → run elsewhere

```bash
node build/seed-dq-rules.js --tables CustTable,SalesTable,SalesLine   # or --all; KB opened read-only
node build/export-semantic.js --out sem-export.json                   # sem_export/1 contract
node build/gen-dq-sql.js --dialect tsql --export sem-export.json --out out/   # or sqlite; [--object X]
```

The seed emits `source:'kb_derived'` rules from KB metadata — EDT string size → `length`, mandatory →
`not_null`, enum fields → `enum` (with `allowed` values so the rule renders without a KB), unique
indexes → `unique`, relations → `fk` (compound keys as `pairs`), data entities' mandatory fields →
`target`. Column names are discovered via `PRAGMA table_info`; it is idempotent and links rules to
the entities each table is already mapped to. Users then refine, confirm or disable via
`d365_map_dq_rule`. Generated scripts are versioned artefacts re-run per snapshot.

## `dq_indicator` contract

One `SELECT` per rule (one per check for `target_readiness`), always the same six columns:

`row_key, object_name, rule_id, dimension, severity, detail`

`row_key` = `RecId` for D365FO objects, else the object's unique-index columns concatenated with `|`,
else `NULL` with a `-- degraded:` note. Degradation is always explicit in a header comment and in
`renderRule(...).statements[].degraded`: `closeness` (T-SQL → `SOUNDEX`/`DIFFERENCE`, SQLite →
normalised equality), `format/pattern` on T-SQL (needs a CLR `dbo.RegexIsMatch`), `enum_map`/`uom_map`
(need the target mapping tables — supply a dialect override), and specs with no executable predicate.
Identifiers are validated (`^[A-Za-z_][A-Za-z0-9_]*$`) and literals escaped; a bad name is a per-rule
error, never SQL. Only `consistency.expr`, `timeliness.when` and dialect overrides are rendered
verbatim — they are architecture-owned content, review them as SQL.

## Privacy rules (enforced at the write boundary, tested)

- Metadata only: entity ids, object/field/model names, roles, specs, aggregates, a salted hash of an
  opaque session token (or the hour bucket). No records, party names, user identity, conversation text.
- `note` ≤200 chars; rejected on e-mail, IBAN-, VAT- or phone-like tokens.
- `spec` is `.strict()` per dimension and rejected when any key is `sample`/`example`/`value`/`data`/
  `record`/`row(s)` or any string trips the privacy scan. `not_in.values` are ≤20-char placeholders.
- `sem_dq_runs` accepts `rule_id, run_date, rows_checked, rows_flagged` and nothing else.
- Never say "the MCP found N duplicates": the MCP knows the rule; the generated script found them.

## Emitting the same shapes from another ERP bridge

Set `MCP_ERP_SYSTEM=M3`, `MCP_INSTALLATION_ID=<site>`, load the **same** `semantic-vocabulary.json`
(entity ids are the join key — never invent local ids, add `is_custom` entities via a PR), and write
`sem_mappings` / `sem_dq_rules` rows with the same columns (`object_name` = `OOHEAD`, `OCUSMA`…).
`exportSemantic()` then produces an identical `sem_export/1` document; `gen-dq-sql.js` renders it with
`row_key` from the M3 object's unique fields, and a D365 `target_readiness` rule
(`entity:"CustCustomerV3Entity", mandatory_fields:[…]`) renders against an M3 object unchanged —
that is `dq_target_readiness` before the rows ever reach DMF. The cross-ERP matcher joins two
exports on `entity_id`; it lives outside the MCP services.
