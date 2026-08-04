# D365 Research

Research a D365 topic across all available knowledge sources.

## Arguments
- $ARGUMENTS: Question or topic (e.g., "how does BYOD incremental sync work", "warehouse wave processing", "number sequence setup")

## Workflow

### Step 1: Search all sources in parallel
Run ALL of these simultaneously:
- `rag_ask` with the question — D365 documentation corpus
- `rag_search` with keywords — find specific documents
- `microsoft_docs_search` with the query — official Microsoft Learn
- `d365_search` with keywords — AOT metadata (tables, classes, enums related to topic)

### Step 2: Synthesize findings
Combine results into a unified answer:

1. **Concept Overview** — What is this, why does it exist (from RAG + MS docs)
2. **Key Objects** — Tables, classes, enums involved (from KB search)
3. **How It Works** — Step-by-step flow (from documentation)
4. **Configuration** — Where to set it up in D365 (from docs)

### Step 3: Deep dive (conditional)
If the initial search reveals specific relevant docs:
- `microsoft_docs_fetch` for the most relevant Microsoft Learn URL
- `rag_lookup_document` for specific RAG documents

If specific tables/classes mentioned:
- `d365_lookup_table` or `d365_get_class_methods` for metadata detail
- For **data entities**, `d365_get_entity_sources` returns the data sources, fields, AND entity-level X++ methods (`method_count` + list); `d365_get_class_methods` / `d365_get_method_source` also work on entities (`owner_type='entity'`).

### KB coverage & efficiency notes
- The KB indexes **Microsoft + customization models** (e.g. `iExtension`, `HISOL`, `LACCE`) together. Scope to custom code with `module_id` (e.g. `WHERE module_id='iExtension'`).
- **Customizations are flagged:** `d365_lookup_table` reports `is_customized`, `custom_field_count`, `customization_modules`, and per-field `is_extension`/`source_module`. To list all custom fields/objects use `d365_raw_sql`, e.g. `SELECT table_name, field_name, source_module FROM fields WHERE is_extension=1`.
- **Prefer `d365_raw_sql` for prefix/aggregate/bulk questions** ("all entities with prefix X", counts by module) — pass `format='markdown'` for readable tables or `format='toon'` for large uniform row sets. Reserve `d365_search` for fuzzy keyword discovery.
- Entity methods are fully indexed (`methods` table, `owner_type='entity'`) — including methods added to standard MS entities via `AxDataEntityViewExtension`.

### Tool-call gotchas (parameter names & search strategy, learned 2026-07-31)
- **Exact parameter names differ per tool** — first calls fail with InputValidationError otherwise:
  `d365_get_module_summary` wants `module_name` (not `module_id`); `d365_get_class_methods` wants `name`;
  `d365_check_field_exists` wants `field_names` as an **array** (even for one field).
- **Concept-phrase searches often return 0 hits** (`d365_search "Tax calculation service enable legal entity"` → nothing).
  Search **AOT name fragments** instead (`"TaxServiceTaxFeatureSetup"`, `"TaxIntegration"`) and iterate from any hit's
  module/class names. If a phrase fails, shorten to 1–2 distinctive tokens before giving up.
- **`d365_get_entity_sources` needs the AOT entity name, not the OData/public name** (`ProductReceiptLineEntity` fails;
  the error's "Did you mean: `VendProductReceiptLineEntity`" suggestion is reliable — follow it). The response's
  `public_name`/`public_collection` give you the OData endpoint, and `entity_fields[].field_name` are the **exact
  OData `$select` names** (with `data_field` = backing column). Derive `$select` lists from this instead of guessing —
  guessed field names cost 3 failed HTTP 400 round-trips for `ProductReceiptLines` before the metadata lookup solved it
  (`ReceivedPurchaseQuantity`=Qty, `RemainingPurchaseQuantity`=Remain, `OrderedPurchaseQuantity`=Ordered).
- **To prove an OData action does NOT exist** (e.g. "can this entity be posted via OData?"), check every entity in the
  pipeline before concluding: the target entity, its generic base entity, and any TOC_/custom line entity. Methods with
  `SysODataActionAttribute` in the signature are the actions; lookup-helper actions (`...CustomLookup`) don't count as
  business actions. (Journal-invoice pipeline verified action-free across 3 entities this way.)
- **`rag_search` failing with `no such column: d.source_type`** = deployed-service drift from repo source — rebuild/redeploy,
  don't debug the query (see MCP deploy/repo drift memory). Fall back to `rag_ask` or project-local docs meanwhile.

### Step 4: Code samples (if technical)
If the topic involves development:
- `microsoft_code_sample_search` with relevant keywords + language "xpp" or "csharp"

### Step 5: Present answer
Structure as:
- **Summary** (2-3 sentences)
- **Detailed Explanation** (from docs)
- **Related Objects** (tables, classes, enums from KB)
- **References** (links to Microsoft Learn pages, RAG document IDs)
- **Further Reading** suggestions
