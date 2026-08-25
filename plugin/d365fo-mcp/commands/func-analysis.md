---
description: Produces a functional analysis document (FAD) for a D365FO change request, enhancement, or feature — technical context auto-populated from MCP services, every fact maturity-tagged. Use for change requests, new requirements, or feature designs needing a formal analysis document.
argument-hint: <requirement description | path\to\recording.axtr>
---

# Functional: Analysis Document

## Task
Produce a complete FAD for the requirement in `$ARGUMENTS`.
**Done when:** the document follows the template in `the `d365fo-functional-analysis` skill` (Part 3), every fact carries a maturity tag — [VERIFIED] (from MCP), [MS-LEARN] (with URL), [INFERRED], [ASSUMPTION] (with owner), or [TBD] (with owner and date) — and the Part 1 quality gate passes.

## Workflow

### Step 1: Understand the requirement
Identify: business domain (module/process area), change type (field, validation, report, config, integration, workflow), and the entities involved.

If ambiguous, ask ONE round of clarifying questions (business trigger, companies/legal entities, user roles, constraints/deadlines) — then proceed; don't iterate on questions.

If `$ARGUMENTS` is an .axtr path: call `d365taskrecorder:taskrecorder_to_markdown` directly with the file content (base64) — do NOT read/parse the .axtr yourself.

### Step 2: Research current state (parallel)
- `d365rag:rag_ask("How does D365FO handle [topic]?", top_k: 7, reasoning: true)`
- `d365rag:rag_search_by_category("Functional Design Docs", keywords)` and `("Business Blueprints", keywords)` — existing FDDs/blueprints
- `Microsoft Learn:microsoft_docs_search` — feature documentation and setup/config guides (two targeted queries)

Then fetch depth: `microsoft_docs_fetch` on the 1-3 best URLs (AS-IS behavior, configuration reference) and `microsoft_code_sample_search("[pattern] D365 X++")` for extension patterns.

### Step 3: Data model analysis (parallel per table)
- `d365kb:d365_lookup_table`, `d365kb:d365_find_referencing_tables`, `d365kb:d365_get_entity_sources`
- Then: `d365kb:d365_get_join_keys` for related pairs, `d365kb:d365_check_field_exists` for every field being modified (existence + EDT — never assert fields from memory), `d365kb:d365_get_enum` for enum fields, `d365xref:xref_find_field_usages` for key fields

### Step 4: Code architecture (parallel per class)
- `d365kb:d365_get_class_methods`, `d365xref:xref_class_hierarchy`, `d365xref:xref_find_extensions`, `d365xref:xref_find_event_handlers`
- For methods relevant to the change: `d365kb:d365_get_method_source` + `d365xref:xref_find_method_callers`

### Step 5: Security (parallel)
- `d365sec:sec_search`, `d365sec:sec_permission_trace` (current access model), `d365sec:sec_find_roles_by_privilege`
- If a new duty is introduced: check SoD against the affected roles' existing duties

### Step 6: Impact
- `d365xref:xref_impact_analysis` + `d365xref:xref_cross_module_deps`. Interpret: <20 refs = Low, 20-100 = Medium, 100+ = High blast radius.

### Step 7: Generate the FAD
Follow the 12-section template from the d365fo-functional-analysis skill: Executive Summary, Business Requirement (AS-IS/TO-BE), Data Model, Functional Design, Technical Design, Security Requirements, Integration Impact, Impact Assessment, Testing Strategy, Risk Assessment, Dependencies & Assumptions, Open Questions. Include **Appendix B: Microsoft Learn References**.

### Step 8: Quality gate (from the skill, Part 1)
All table/field references verified? Joins verified? Customization landscape complete? Security traced to privileges? Integration points checked? All assumptions marked with owners? Fix gaps before presenting.

## Follow-ups to offer
- Gemini devil's-advocate challenge (Invoke-GeminiChallenge.ps1), `/d365-table`, `/d365-impact`, `/d365-security`, `/d365-class`, or save to a specified path
