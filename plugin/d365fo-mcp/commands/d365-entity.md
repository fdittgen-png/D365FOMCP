---
description: Explains how a D365FO data entity is built — data sources with field counts, the backing table's keys and relations, the party/address chain, customisation surface and sibling entities — in three MCP calls and under 4k tokens. Use when the user asks for the (logical) structure of an entity; add --fields for field rows.
argument-hint: <EntityName | OData collection> [--fields]
---

# D365 Entity Structure (brief)

> **Do not load `d365fo-mcp-tooling` for this command** — it carries its own calls. Measured 2026-09-04: the skill is ≈ 5.8k tokens of text, the data for this answer ≈ 2.6k.


## Task
Explain how the data entity `$ARGUMENTS` is built. **Brief by default**: shape, data sources, keys, relations, customisation, siblings. Field rows only when `--fields` is given or the user asks.
**Done when:** every statement is backed by one of the three calls below, the customisation surface is named per model, and anything not queried (subtype tables, mandatory flags) is flagged as unverified.

## Workflow (target: 3 calls, ≤ 4 k MCP tokens)

State the shape in one line first: *"Shape: data sources + keys + party link → summary, one table lookup, one sibling query."*

### Step 1: Entity summary
- `d365kb:d365_get_entity_sources` with `entity_name` = `$ARGUMENTS` (default **summary** mode: header, `data_sources` with field counts, `method_count`, `custom_field_count`). Pass `functional_context` when the business entity is known.

### Step 2: Backing table keys and relations
- `d365kb:d365_lookup_table` with `table_name` = the `primary_table` from Step 1, `sections: ["indexes","relations_out"]`, `include_provenance: true`. **Do not** call it a second time with `custom_only`.

### Step 3: Sibling entities
- `d365kb:d365_raw_sql`: `SELECT entity_name, public_collection, label, primary_table FROM data_entities WHERE primary_table = '<primary_table>' COLLATE NOCASE LIMIT 20`

### Step 4 (only when customisation or a migration mapping is in scope)
- `d365kb:d365_get_entity_sources` with `custom_only: true` — names the extension fields the entity exposes, per model (≈ 360 tokens in the text channel). Measured 2026-09-04: without it the brief answer could only count the 11 extension fields, not name Trelleborg's `TRB_IsCRApproved`.

### Only with `--fields`
- `d365kb:d365_get_entity_sources` with `summary: false` and `fields_like` / `custom_only`, paging with `cursor` — never a larger `limit`.

## Output
1. **What the entity is**: AOT name, OData name/collection, label, config key, primary table; composite or single-table
2. **Data sources**: table with field counts, one line on what each contributes (party, address, tax, retail …)
3. **Keys and party link**: primary/replacement key, unique indexes, the relation to the Global Address Book
4. **Setup relations**: aggregations vs associations, self-references
5. **Customisation surface**: extension fields per model, which of them the entity exposes
6. **Siblings**: other entities on the same primary table (V1/V2/V3, satellites)
7. **Not verified here**: what the three calls did not cover

Separate what the tools confirmed from what you inferred; label inferences — in particular, a sibling entity's purpose read from its label or module name ("slim variant for Copilot") is an inference until its fields or methods were queried. Quote the snapshot date from the banner.

## Follow-ups to offer
- Field rows for one data source (`fields_like`, `summary: false`)
- Effective schema with every extension's fields (`d365kb:d365_effective_schema`)
- Who uses the entity (`d365xref:xref_find_references`, `limit: 20`)
