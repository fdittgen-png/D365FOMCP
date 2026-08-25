---
name: d365fo-support-scoping
description: Methodology for screening D365FO support tickets into scoping documents — MCP tool selection matrix, entity extraction, issue-pattern diagnostics, severity/complexity classification, document template. Use when scoping support tickets; backs the /support-scope and /support-scope commands.
---

# D365FO Support Ticket Scoping

## Overview

Optimized skill for screening D365FO support tickets into well-defined scoping documents.
Uses all MCP services: d365kb (17 tools), d365xref (16 tools), d365sec (15 tools),
d365taskrecorder (1 tool), d365rag (8 tools), and Microsoft Learn (3 tools) —
with precise tool selection for maximum efficiency.

---

## Part 1: MCP Tool Selection Matrix

Always pick the narrowest tool that answers the question. Never search when you can look up directly.

### When to Use Which Tool

| Question | Tool | NOT This |
|----------|------|----------|
| "What fields does SalesTable have?" | `d365_lookup_table("SalesTable")` | d365_search |
| "Does SalesTable have CustAccount?" | `d365_check_field_exists("SalesTable", ["CustAccount"])` | d365_lookup_table |
| "What values can SalesStatus have?" | `d365_get_enum("SalesStatus")` | d365_search |
| "How to join CustInvoiceJour↔Trans?" | `d365_get_join_keys("CustInvoiceJour","CustInvoiceTrans")` | d365_lookup_table both |
| "Who calls SalesFormLetter.confirm?" | `xref_find_method_callers("SalesFormLetter","confirm")` | xref_find_references |
| "What customizations on CustTable?" | `xref_find_extensions("CustTable")` | xref_find_references |
| "Can user jsmith post invoices?" | `sec_effective_permissions(user_id:"jsmith", object_name:"CustInvoiceJour")` | sec_lookup_user |
| "What role needed for this form?" | `sec_permission_trace(role_name:"...", object_name:"FormName")` | sec_search |
| "How does vendor payment work?" | `rag_ask("How does vendor payment work in D365FO?")` | rag_search |
| "Find docs about SEPA" | `rag_search("SEPA credit transfer")` | rag_ask |
| "Find blueprints for procure-to-pay" | `rag_search_by_category("Business Blueprints", "procure to pay")` | rag_search |
| "What OData entity exposes CustTable?" | `d365_get_entity_sources("CustCustomerEntity")` | d365_search |
| "Parse this task recording" | `taskrecorder_to_markdown(file_content:...)` | Read the .axtr manually |
| "How does D365 standard posting work?" | `microsoft_docs_search("D365 sales order invoice posting")` | rag_ask |
| "Full MS docs on credit management" | `microsoft_docs_fetch(url_from_search)` | microsoft_docs_search alone |
| "X++ code sample for batch jobs" | `microsoft_code_sample_search("batch job SysOperation", language:"xpp")` | d365_get_method_source |

### Internal Docs (RAG) vs Official Docs (Microsoft Learn)

| Need | Use RAG | Use Microsoft Learn |
|------|---------|---------------------|
| Company-specific processes | `rag_ask` / `rag_search` | — |
| Existing FDDs, blueprints | `rag_search_by_category` | — |
| Known internal issues/fixes | `rag_search` | — |
| Standard D365 behavior | — | `microsoft_docs_search` |
| Feature configuration guides | — | `microsoft_docs_search` → `microsoft_docs_fetch` |
| Error message troubleshooting | `rag_search` first | `microsoft_docs_search` in parallel |
| Code patterns, API reference | — | `microsoft_code_sample_search` |
| Official release notes, what's new | — | `microsoft_docs_search` |

**Rule:** RAG = internal knowledge. Microsoft Learn = official, current, authoritative. Search BOTH in parallel for support tickets.

### Parallel vs Sequential Rules

**Parallel** (no data dependency):
```
d365_lookup_table(X)  |  xref_find_extensions(X)  |  microsoft_docs_search("D365 [X] form")
```

**Sequential** (output feeds next):
```
microsoft_docs_search(topic) → identify best URL → microsoft_docs_fetch(url)
d365_lookup_table(X) → find enum fields → d365_get_enum(enumName)
```

**Cost rule**: 4+ parallel calls = same latency as 1 call. Always batch independent calls.

---

## Part 9: Severity & Complexity Classification

### Severity Matrix

| Severity | Criteria | Indicators from MCP |
|----------|----------|---------------------|
| **Critical** | Production stopped, data corruption, financial posting blocked | Error in posting class (FormLetter, LedgerJournal), table with financial data |
| **High** | Key process blocked, workaround painful | Multiple users affected (`sec_find_users_by_role`), core process form |
| **Medium** | Functionality impaired, workaround exists | Single form/report, limited user impact |
| **Low** | Cosmetic, enhancement, question | No error, no data impact |

### Complexity Scoring (1-3 per dimension, total 6-18)

| Dimension | 1 (Low) | 2 (Medium) | 3 (High) | How to Determine |
|-----------|---------|------------|----------|------------------|
| Modules | Single | 2-3 | Cross-module | `xref_cross_module_deps` |
| Customizations | None | CoC exists | Heavy CoC + ISV | `xref_find_extensions` count |
| Data model | 1 table | 2-3 tables | 4+ tables | `d365_find_referencing_tables` |
| Security | Single role | Multi-role | Cross-company + SoD | `sec_lookup_user` company count |
| Integration | None | OData/entities | External + batch | `d365_get_entity_sources` |
| Reproduction | Always | Intermittent | Environment-specific | Task recording available? |

**Score: 6-8 Simple | 9-12 Medium | 13-18 Complex**

---

## 1. Issue Summary
[Structured rewrite: what, where, when, who, business impact]

## 2. Affected Area
| Module(s) | [from d365_search / task recording] |
| Process | [business process] |
| Form(s) | [form names] |
| Company | [legal entity codes — **check ALL companies, not just the reported one**] |
| Full scope query | [SQL to verify across all DataAreaId] |
| Environment | [DEV/UAT/PROD] |

## 3. Technical Context
### Tables [VERIFIED — d365_lookup_table]
| Table | Key Fields | Relations | Module |

### Customizations [VERIFIED — xref_find_extensions]
| Object | Type | Extension Name | Module | Risk |

### Enum Values [VERIFIED — d365_get_enum]
| Enum | Value | Label |

## 4. Security Context
| User roles | [sec_lookup_user] |
| Required permission | [sec_permission_trace] |
| Has access? | [sec_effective_permissions] |
| Company-scoped? | [Yes/No] |
| SoD risk? | [sec_compare_roles if relevant] |

## 5. Integration Context [if OData/DMF involved]
| Entity | Public Name | Exposed? | Staging Table |
[from d365_get_entity_sources]

## 6. Known Information
### Internal Documentation [RAG]
[from rag_search / rag_ask — cite document names and categories]

### Microsoft Learn [Official]
[from microsoft_docs_search — cite article titles with URLs]
[from microsoft_docs_fetch — key procedures, config steps, troubleshooting]

## 7. Impact Assessment
| Direct dependents | [xref_impact_analysis] |
| Modules affected | [xref_cross_module_deps] |
| Blast radius | [Low/Medium/High] |

## 8. Reproduction Steps
[From task recording or structured description]
1. Navigate to [form] (path)
2. [Action] — expected: [X], actual: [Y]

## 9. Actionable Data [if resolution involves data changes]
When the fix requires renaming, updating, deleting, or creating records:
- **Extraction query:** Ready-to-run SQL that returns all affected records across ALL companies
- **Affected records:** Company | Current Value | Proposed Value — formatted for handoff
- **Summary:** Count per company
- **Data quality flags:** Secondary issues found in the data (double spaces, trailing whitespace, inconsistent casing, special characters that may cause further downstream problems)

*This is the handoff deliverable — the operations team should be able to act immediately without a follow-up.*

## 10. Open Questions
- [ ] [Specific, actionable question]

## 11. Recommended Next Steps
| # | Action | Owner | Reference |
| 1 | [highest priority] | [suggested] | [MS Learn link if applicable] |
```

---

## Part 11: Orchestration Workflow Summary

### Scoping Workflow (8 Steps)

```
Step 1: EXTRACT entities from ticket
  - Parse tables, fields, forms, users, companies, errors
  - If .axtr provided → call taskrecorder_to_markdown DIRECTLY

Step 2: DISCOVER (5+ parallel calls — use OR keywords for RAG)
  d365_search(keywords)  |  rag_search("term1 OR term2 OR term3")
  |  rag_search("term4 OR term5")  |  rag_list_categories()
  |  microsoft_docs_search(topic)  |  microsoft_docs_search(error_or_feature)

Step 3: READ key documents + FETCH MS Learn (parallel)
  rag_lookup_document("best_doc.docx")              -- Full internal doc (if not too large)
  rag_lookup_document("second_doc.pdf")             -- Second-best internal doc
  microsoft_docs_fetch(best_troubleshooting_url)    -- Full MS troubleshooting
  microsoft_docs_fetch(best_configuration_url)      -- Full MS config guide

Step 4: DEEP DIVE per entity (parallel per object)
  d365_lookup_table(T)  |  xref_find_extensions(T)  |  d365_find_referencing_tables(T)
  [then: d365_get_enum(E) for enum fields]
  NOTE: If a tool fails with schema errors, retry ONCE then move on.

Step 4b: CROSS-COMPANY SCOPE CHECK
  If the ticket mentions a specific company, generate a SQL query to check
  whether the same issue exists in other legal entities. The reported company
  is often just where the symptom was first noticed — data issues frequently
  span multiple companies. Include this query in the scoping document.

Step 5: SECURITY (parallel)
  sec_lookup_user(U)  |  sec_effective_permissions(U, obj)  |  sec_permission_trace(role, obj)

Step 6: IMPACT (parallel)
  xref_impact_analysis(primary_object)  |  xref_cross_module_deps(module)

Step 7: CLASSIFY severity + complexity

Step 8: GENERATE scoping document (template from Part 10)
  Include MS Learn references with URLs in Section 6 and Next Steps
  Include RAG Document Sources appendix citing internal docs consulted
```

### Rescoping Workflow (When enriching an existing scoping document)

```
Step 1: READ the existing scoping document
  - Identify 2-3 weakest sections or unconfirmed hypotheses
  - Note what is already well-covered (don't re-research)

Step 2: TARGETED DISCOVER (parallel — focused on gaps)
  rag_search("gap_topic1 OR gap_topic2", limit:15)
  rag_search("gap_topic3 OR gap_topic4", limit:15)
  microsoft_docs_search("D365 [gap topic]")

Step 3: READ key documents found (parallel)
  rag_lookup_document("relevant_doc.docx")

Step 4: ENRICH the scoping document
  - Add "Documented Design Context" section with RAG-sourced findings
  - Upgrade hypothesis confidence levels where documentary evidence confirms
  - Add new hypotheses discovered through RAG
  - Add "RAG Document Sources" appendix
```

### MCP Tool Resilience Rules

- **First failure on any MCP tool:** Note the error, try one alternative query or approach.
- **Second failure on the same tool:** Stop. The tool is likely broken server-side. Use alternative sources.
- **Never retry more than twice** on the same tool — context cost exceeds information gain.
- **Known intermittent issues:** `d365kb.d365_search` sometimes fails with "output schema but no structured content" — this is server-side, not a query issue. Switch to `d365_search` with different terms or use RAG/xref instead.
- **`d365_search` query limit:** max 100 characters — long OR-chains or pasted error messages get rejected with "Search pattern too long". Trim to 2-4 distinctive keywords. If a shortened OR query returns 0 results, don't keyword-fish — the label/code path can be pinned later; proceed with the functional analysis.

---

*Version: 3.1 | Date: 2026-04-16 | Changes: Added cross-company scope check (Step 4b), actionable data section (Section 9) in template, data fix handoff deliverable guidance — from PaymTermId/Basware session where ticket said "MIAE" but 5 companies were affected*
*Version: 3.2 | Date: 2026-06-30 | Changes: Added "Stuck / Orphaned Status Flags" diagnostic pattern (Part 8) — status flag + child event/log table + active-vs-audit enum; worked example = sales order "Do not process" (SalesTable.MCROrderStopped ← MCROrderEventTable), orphaned-flag fix via add/remove dummy order hold*
*Version: 3.3 | Date: 2026-08-03 | Changes: Added "Migrated-PO Inconsistency Signature" pattern (Part 8) — DMF-injected receipts bypass InventUpdate, InventTrans/remainder mismatch, decision-table diagnostics, "Purchase order distribution reset" as cheapest fix, ticket-linkage lesson; added d365_search 100-char query limit (Part 11 resilience rules) — from LADE tickets 202606172001847/1855 (PO 041551)*

## Reference files (read only the one you need)

Each file below is self-contained. Load it with the Read tool when the question falls into its area; do not load all of them.

- **Part 2: Microsoft Learn Integration** → `references/microsoft-learn-integration.md` — This is the most effective pattern for support and functional consultants:
- **Part 3: Task Recorder Integration** → `references/task-recorder-integration.md` — The Task Recorder MCP tool parses .axtr files (ZIP archives) into structured Markdown.
- **Part 4: RAG Service Strategy** → `references/rag-service-strategy.md` — The most efficient RAG workflow follows three turns, not iterative keyword fishing:
- **Part 5: Entity Extraction from Ticket Descriptions** → `references/entity-extraction-from-ticket-descriptions.md`
- **Part 6: Security Issue Diagnostics** → `references/security-issue-diagnostics.md` — PARALLEL:
- **Part 7: OData, DIXF/DMF, Web Services, REST Issue Patterns** → `references/odata-dixf-dmf-web-services-rest-issue-patterns.md` — PARALLEL:
- **Part 8: Technical Bug Analysis** → `references/technical-bug-analysis.md` — PARALLEL:
- **Part 10: Scoping Document Template** → `references/scoping-document-template.md`
