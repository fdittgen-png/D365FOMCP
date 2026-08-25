---
description: Screens a D365FO support ticket and produces a full initial scoping document — entities extracted, related tickets checked, technical/security/impact context auto-populated from all MCP services, severity and complexity classified. Use when a new support ticket, issue summary, or .axtr recording needs to be scoped.
argument-hint: <ticket description | path\to\recording.axtr>
---

# Support: Scope Ticket

## Task
Screen the ticket in `$ARGUMENTS` and produce a scoping document saved under the `SupportTickets\` convention.
**Done when:** the document contains every section listed under Output, all technical facts come from MCP calls (facts you could not verify are flagged as assumptions, never stated as findings), related tickets were checked before any research, and the Actionable Data section lets the operations team act without a follow-up "which records exactly?" question.

Severity matrix, complexity scoring, and deep methodology: `the `d365fo-support-scoping` skill`.

## Workflow

### Step 1: Parse and extract entities
Extract from `$ARGUMENTS`: tables/fields (PascalCase, Table.Field), forms/menu items, users, companies (4-letter codes), quoted error messages, and processes (posting, approval, settlement…).

**If `$ARGUMENTS` is an .axtr path:** call `d365taskrecorder:taskrecorder_to_markdown` directly with the file content (base64) and file name — do NOT read/parse the .axtr yourself. Use its forms, data sources, roles, and navigation flow as the entities.

### Step 2: Check related tickets and memory FIRST
Before any MCP research, check session memory and existing `SupportTickets\` folders for the same document number, PO, reporter, or company. Tickets opened by the same reporter minutes apart, or sharing a document/PO number, are usually symptoms of one root cause — one may already be diagnosed. If a related ticket exists: link both, reuse its **confirmed** findings (don't re-derive), and sequence the fixes (root-cause ticket first).

### Step 3: Discovery scan (parallel)
- `d365kb:d365_search` with key terms — relevant tables, forms, classes
- `d365rag:rag_search` with OR-combined keywords — known internal issues _(if the d365rag MCP is connected)_
- `d365rag:rag_ask` "What could cause: [summary]?" (reasoning: true)
- `Microsoft Learn:microsoft_docs_search` — troubleshooting + setup/config (two queries)

Then `microsoft_docs_fetch` the 1-2 most relevant URLs for full procedures and known issues.

### Step 4: Technical deep dive (parallel per entity)
- Per table: `d365kb:d365_lookup_table`, `d365xref:xref_find_extensions`, `d365kb:d365_find_referencing_tables`
- Per class/action: `d365kb:d365_get_class_methods` (filtered), `d365xref:xref_find_extensions`
- Per enum field: `d365kb:d365_get_enum`
- Before writing ANY SQL: `d365kb:d365_check_field_exists` on every referenced field

**Cross-company scope:** if the ticket names one company, note that the issue may exist in other legal entities and include a ready-to-run SQL query across all DataAreaId values — the reported company is often just where the symptom surfaced.

### Step 5: Security and access (if a user is involved)
- `d365sec:sec_lookup_user` + `d365sec:sec_effective_permissions(user, object)`
- `d365sec:sec_permission_trace` on the affected form/menu item
- If OData/DMF involved: `d365kb:d365_get_entity_sources`

### Step 6: Impact and customization assessment
- `d365xref:xref_impact_analysis` + `d365xref:xref_cross_module_deps`
- Classify: **Standard** (no extensions), **Extended** (CoC/handlers found — check extension code next), **ISV/Heavy** (vendor contact may be needed)

### Step 7: Classify severity and complexity
Apply the severity matrix and 6-dimension complexity scoring (Modules, Customizations, Data model, Security, Integration, Reproduction — 1-3 each) from the d365fo-support-scoping skill.

## Output — scoping document sections
1. **Issue Summary** — structured rewrite
2. **Affected Area** — module, process, forms, company, environment; always note possible other-legal-entity scope with a verification query
3. **Technical Context** — tables, customizations, enums (from MCP)
4. **Security Context** — roles, required permission, access verdict
5. **Integration Context** — data entities if OData/DMF involved
6. **Known Information** — RAG + Microsoft Learn findings, with sources
7. **Impact Assessment** — dependents, modules, blast radius
8. **Reproduction Steps**
9. **Actionable Data** — if the fix changes data: a ready-to-run SQL extract of ALL affected records across companies, a per-company count summary, and flagged secondary data-quality issues (double spaces, trailing whitespace, special characters)
10. **Open Questions** — specific and actionable
11. **Recommended Next Steps** — prioritized with owners

Header carries severity (Critical/High/Medium/Low) and complexity (Simple/Medium/Complex).

**Decision table for pending verification:** when the RCA hinges on a query not yet run, add one row per possible outcome mapped to conclusion + action, so the doc is actionable before the query executes.

**Save location (standing convention):** `SupportTickets\<ticket id>-<title>\<ticket id>-<title>.md` under the case working directory; create the folder if missing; add a dated status-log section at the bottom.

## Boundaries
- Never write email addresses into the document — names only; no customer/vendor party data.

## Follow-ups to offer
Gemini challenge, `/d365-table`, `/d365-security`, `/d365-class`, or save to another path.
