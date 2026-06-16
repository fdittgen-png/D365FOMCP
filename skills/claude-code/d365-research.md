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
