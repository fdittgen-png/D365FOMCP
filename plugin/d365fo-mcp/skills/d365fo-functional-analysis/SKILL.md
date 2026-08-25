---
name: d365fo-functional-analysis
description: Standards and template for D365FO functional analysis documents (FADs) — quality gate, maturity tagging, MCP orchestration, the full 13-section template, anti-patterns. Use when producing or reviewing an FAD/FDD; backs the /func-analysis command.
---

# D365FO Functional Analysis Documents

## Contents
- Overview
- Part 1: Document Standards
- Part 2: Microsoft Learn Integration for FADs
- Part 3: MCP Tool Orchestration for Functional Analysis
- Part 4: Document Template (Standard FAD)
- 1. Executive Summary
- 2. Business Requirement
- 3. Data Model
- 4. Functional Design
- 5. Technical Design
- 6. Security Requirements
- 7. Integration Impact
- 8. Impact Assessment [VERIFIED]
- 9. Data Migration
- 10. Testing Strategy
- 11. Risk Assessment
- 12. Dependencies & Assumptions
- 13. Open Questions [TBD]
- Appendix A: MCP Evidence
- Appendix B: Microsoft Learn References
- Part 5: Common Analysis Patterns
- Part 6: Security Analysis for FADs
- Part 7: Task Recorder for Functional Analysis
- Part 8: Anti-Patterns
- Part 9: Orchestration Workflow Summary

## Overview

Optimized skill for producing well-defined functional analysis documents (FADs) for
D365FO change requests, enhancements, and implementations. Uses all MCP services:
d365kb, d365xref, d365sec, d365taskrecorder, d365rag, and Microsoft Learn (search,
fetch, code samples) — with maturity tagging and parallel orchestration.

---

## Part 1: Document Standards

### Document Types

| Type | When | Sections Required | MCP Depth |
|------|------|-------------------|-----------|
| **Micro-FAD** | Config change, parameter tweak | 1-4, 10 | KB + MS Learn |
| **Standard FAD** | Single-process enhancement | 1-8, 10-11 | KB + XRef + Sec + MS Learn |
| **Extended FAD** | Cross-module feature, integration | All 1-13 | All services |
| **Blueprint FAD** | New module, major redesign | All 1-13 + architecture appendix | All + deep RAG + deep MS Learn |

### Maturity Marking

Every fact in the document must be tagged:

| Tag | Meaning | Source |
|-----|---------|--------|
| **[VERIFIED]** | Confirmed by MCP tool output | Cite tool name |
| **[MS-LEARN]** | From official Microsoft documentation | Cite URL |
| **[INFERRED]** | Derived from verified data | State reasoning |
| **[ASSUMPTION]** | Based on standard D365 behavior | Must be confirmed |
| **[TBD]** | Requires workshop/user input | Assign owner + date |

### Quality Gate

A FAD is ready for review when:
- [ ] Every table/field reference verified via `d365_check_field_exists`
- [ ] Every join verified via `d365_get_join_keys`
- [ ] Customization landscape complete (extensions + event handlers per object)
- [ ] Security requirements traced to specific privileges/duties
- [ ] Integration points reference verified data entities
- [ ] Standard behavior documented from Microsoft Learn (`microsoft_docs_search` + `microsoft_docs_fetch`)
- [ ] Process flow validated against official MS docs
- [ ] All [ASSUMPTION] items explicitly listed
- [ ] All [TBD] items have owners

---

## Part 2: Microsoft Learn Integration for FADs

### Three Tools — Search, Fetch, Code Samples

| Tool | Returns | When to Use |
|------|---------|-------------|
| `microsoft_docs_search(query)` | Up to 10 chunks (~500 tokens each) with title + URL + excerpt | Discovery: find relevant official documentation |
| `microsoft_docs_fetch(url)` | Full page as markdown (headings, tables, code blocks, steps) | Depth: get complete procedures, configuration, troubleshooting |
| `microsoft_code_sample_search(query, language)` | Up to 20 code samples from official docs | Implementation: find X++ patterns, API examples, extension samples |

### Search → Fetch Workflow (Essential for FADs)

```
Step 1: microsoft_docs_search("D365 finance [feature/process]")
  → Returns titles + URLs + excerpts

Step 2: Identify the 1-3 most relevant URLs:
  - Feature overview page → fetch for standard behavior (AS-IS section)
  - Configuration/setup page → fetch for parameters (Technical Design)
  - Data entity reference → fetch for integration fields

Step 3: microsoft_docs_fetch(url) per relevant page
  → Returns full markdown with:
    - Prerequisites and setup steps
    - Configuration parameters with descriptions
    - Step-by-step procedures
    - Field descriptions and valid values
    - Known limitations and workarounds
    - Related features and links
```

### What Microsoft Learn Adds to Each FAD Section

| FAD Section | MS Learn Contribution | Tool |
|------------|----------------------|------|
| **2. Business Requirement** (AS-IS) | Official process description, standard behavior | `microsoft_docs_search` → `microsoft_docs_fetch` |
| **3. Data Model** | Official field descriptions, entity references | `microsoft_docs_search("D365 [table] entity")` |
| **4. Functional Design** | Standard configuration parameters, valid values | `microsoft_docs_fetch(config_page_url)` |
| **5. Technical Design** | Official extension patterns, best practices | `microsoft_code_sample_search("D365 CoC [pattern]")` |
| **7. Integration Impact** | Data entity documentation, OData field reference | `microsoft_docs_search("D365 [entity] data entity")` |
| **9. Data Migration** | DMF entity capabilities, import/export procedures | `microsoft_docs_fetch(dmf_guide_url)` |
| **11. Risk Assessment** | Known limitations, deprecated features | `microsoft_docs_search("D365 [feature] limitations")` |

### Parallel Orchestration with MS Learn

```
Phase 1 RESEARCH (5 parallel calls):
  rag_ask(question)
  rag_search_by_category("Functional Design Docs", keywords)
  rag_search_by_category("Business Blueprints", keywords)
  microsoft_docs_search("D365 [feature topic]")           ← NEW
  microsoft_docs_search("D365 [feature] configuration")   ← NEW

Phase 1b FETCH (sequential after search, 1-3 calls):
  microsoft_docs_fetch(feature_overview_url)               ← NEW: full standard behavior
  microsoft_docs_fetch(configuration_guide_url)            ← NEW: full setup parameters
  microsoft_code_sample_search("[pattern] X++")            ← NEW: official code examples
```

---

## Part 3: MCP Tool Orchestration for Functional Analysis

### Phase 1: Requirements Research (5 parallel + fetch)

```
PARALLEL:
  rag_ask("How does D365FO handle [requirement]?", top_k:7, reasoning:true)
  rag_search_by_category("Functional Design Docs", "keywords")
  rag_search_by_category("Business Blueprints", "keywords")
  microsoft_docs_search("D365 finance [feature topic]")
  microsoft_docs_search("D365 [feature] setup configuration")

THEN (after identifying best URLs from search results):
  microsoft_docs_fetch(feature_overview_url)    -- Full standard behavior
  microsoft_docs_fetch(setup_guide_url)         -- Full configuration reference
```

**Purpose:** Understand current-state, find existing FDDs/blueprints, get official guidance + full docs.
**Output used for:** AS-IS process (tag [MS-LEARN] with URL), gap identification, config reference.

### Phase 2: Data Model Analysis (parallel per table)

```
For each table in scope:
  PARALLEL:
    d365_lookup_table(tableName)                 -- Fields, indexes, relations, module
    d365_find_referencing_tables(tableName)       -- Downstream tables
    d365_get_entity_sources(relatedEntityName)    -- OData entity mapping

Between tables:
    d365_get_join_keys(table1, table2)            -- Exact join fields

For specific fields:
  PARALLEL:
    d365_check_field_exists(table, [field1, ...]) -- Verify + get EDT/type
    xref_find_field_usages(table, field)           -- Who reads/writes
    d365_field_renames(table)                       -- AX2012→D365FO renames
```

**Key rule:** ALWAYS verify field existence before including in the document.

### Phase 3: Code Architecture Analysis (parallel per class)

```
For each processing class:
  PARALLEL:
    d365_get_class_methods(className)              -- Method inventory
    xref_class_hierarchy(className)                -- Inheritance chain
    xref_find_extensions(className)                -- CoC extensions
    xref_find_event_handlers(className)            -- Event subscriptions

For specific methods:
    d365_get_method_source(className, methodName)  -- Full X++ source
    xref_find_method_callers(className, methodName) -- Incoming calls
    xref_method_references(className, methodName)  -- Outgoing calls

For implementation patterns:
    microsoft_code_sample_search("[pattern] D365 X++")  -- Official code examples
```

**When to read source code:**
- Validate* methods → existing validation rules
- Init* methods → default value logic
- Post* methods → posting chain
- Methods you plan to extend via CoC → `next` call chain

**When to search code samples:**
- Designing a new CoC extension → `microsoft_code_sample_search("Chain of Command extension D365")`
- Implementing batch processing → `microsoft_code_sample_search("SysOperationServiceController batch")`
- Working with data entities → `microsoft_code_sample_search("data entity validate D365")`

### Phase 4: Security Analysis

```
PARALLEL:
  sec_search("feature_keywords")
  sec_permission_trace(role_name:"role", object_name:"form")
  microsoft_docs_search("D365 security [feature] role duty")   ← NEW
```

**SoD check for new feature:**
```
For each role getting a new duty:
  sec_lookup_role(role) → list existing duties
  Check: new duty + existing duties → SoD conflict?
  (Create + Approve, Record + Post, Maintain + Audit)
```

**Cross-company security (raw SQL):**
```sql
SELECT DISTINCT u.user_id, u.person_name, urc.company_id, r.role_name
FROM users u
JOIN user_roles ur ON u.user_id = ur.user_id
JOIN roles r ON ur.role_id = r.role_id
LEFT JOIN user_role_companies urc ON u.user_id = urc.user_id AND ur.role_id = urc.role_id
WHERE r.role_name IN ('AffectedRole1', 'AffectedRole2')
  AND u.enabled = 1
ORDER BY u.user_id
```

### Phase 5: Impact Assessment (parallel)

```
PARALLEL:
  xref_impact_analysis(primaryObject)           -- All downstream consumers
  xref_cross_module_deps(moduleName)            -- Module boundary crossings
  xref_find_extensions(modifiedObject)           -- Existing extensions at risk
```

**Interpret:**
- **<20 references**: Low risk, localized
- **20-100 references**: Medium risk, verify consumers
- **100+ references**: High risk, regression plan needed

### Phase 6: Integration Analysis

#### OData / Data Entity Impact

```
PARALLEL:
  d365_get_entity_sources(entityName)                        -- Field mappings, is_public
  xref_find_extensions(entityName)                           -- Entity extensions
  microsoft_docs_search("D365 [entityName] data entity")     -- Official entity docs
THEN:
  microsoft_docs_fetch(entity_reference_url)                 -- Full field reference
```

#### DIXF / DMF Impact

```
1. d365_get_entity_sources(entityName)              → staging table, field mappings
2. d365_lookup_table(stagingTableName)               → staging structure
3. d365_get_class_methods(entityName, filter:"*validate*") → validation logic
4. d365_get_class_methods(entityName, filter:"*map*")      → mapping overrides
5. xref_find_extensions(entityName)                  → CoC on entity
6. microsoft_docs_search("D365 DMF [entityName]")    → official DMF guidance
```

#### Web Services / REST API Impact

```
PARALLEL:
  d365_get_entity_sources(entity) → is_public flag (OData)
  xref_search_names("*ServiceName*", object_type:"Classes") → custom services
  microsoft_docs_search("D365 OData [topic]")               → official API docs
THEN:
  microsoft_docs_fetch(api_docs_url) → full API reference
```

---

## Part 4: Document Template (Standard FAD)

```markdown
# Functional Analysis: [Feature Title]

| Version | Author | Date | Status |
|---------|--------|------|--------|
| 0.1 | [name] | [date] | Draft |

## 1. Executive Summary
[3-5 sentences: what, why, who benefits, approach]

## 2. Business Requirement
### Problem Statement
[Business impact, current pain point]

### Current Process (AS-IS)
[From rag_ask + microsoft_docs_fetch — tag [MS-LEARN] with URL for standard behavior]
```
[Actor] → Form: [X] → Action → Write: [Table] → Trigger: [Next]
```

### Desired Process (TO-BE)
[Changed flow with new/modified steps highlighted]

### Success Criteria
- [ ] [Measurable outcome 1]

## 3. Data Model
### Existing Tables [VERIFIED]
| Table | Key Fields | EDT/Type | Mandatory | Relations |
[from d365_lookup_table]

### Fields to Add/Modify
| Table | Field | Action | EDT/Type | Purpose | Tag |

### Join Relationships [VERIFIED]
| From | To | Join Condition |
[from d365_get_join_keys]

## 4. Functional Design
### 4.1 Process Flow
[Step-by-step with form, table, class references]

### 4.2 Standard D365 Behavior [MS-LEARN]
[From microsoft_docs_fetch — cite URL. Document how the standard feature works
so the gap between standard and required behavior is clear.]

### 4.3 Business Logic
| Rule | Implementation | Method | Tag |
| Validation: [X] | CoC on [Class.method] | [from d365_get_method_source] | [VERIFIED] |

### 4.4 UI Changes
| Form | Section | Change | Behavior |

## 5. Technical Design
### 5.1 Objects to Create/Modify
| Object | Type | Action | Module | Approach |

### 5.2 Extension Strategy
[For each modification: WHY CoC vs event handler vs new object]
[Reference official patterns from microsoft_code_sample_search if applicable]

Existing extensions [VERIFIED]:
| Object | Extension | Module | Conflict Risk |
[from xref_find_extensions]

Existing event handlers [VERIFIED]:
| Object.Method | Handler | Module |
[from xref_find_event_handlers]

## 6. Security Requirements
### Current Access Model [VERIFIED]
| Form/Object | Minimum Role | Duty | Privilege |
[from sec_permission_trace]

### New Security Objects
| Type | Name | Entry Points | Justification |

### SoD Considerations
[from sec_compare_roles]

### Affected Users [VERIFIED]
| Role | User Count | Companies |
[from sec_find_users_by_role]

## 7. Integration Impact
### Data Entities [VERIFIED]
| Entity | Public Name | Exposed? | Change Needed |
[from d365_get_entity_sources]

### DMF Impact
| Entity | Staging Table | Import | Export | Change Needed |

### External APIs
[OData endpoints, custom services. Reference MS Learn docs for API contracts.]

## 8. Impact Assessment [VERIFIED]
### Downstream Dependents
| Object | Type | Module | Reference Kind |
[from xref_impact_analysis]

### Module Boundaries
| Module | Reference Count |
[from xref_cross_module_deps]

**Blast Radius:** [Low (<20) / Medium (20-100) / High (100+)]

## 9. Data Migration
[Existing data changes, migration script, rollback plan]

## 10. Testing Strategy
| # | Scenario | Steps | Expected | Role |

## 11. Risk Assessment
| Risk | Probability | Impact | Mitigation |

## 12. Dependencies & Assumptions
### Assumptions [ASSUMPTION]
- [Each with owner to confirm]

### Dependencies
| Dependency | Owner | Status |

## 13. Open Questions [TBD]
- [ ] [Question] — Owner: [X], Due: [date]

## Appendix A: MCP Evidence
[Key tool outputs: table structures, extension lists, permission traces]

## Appendix B: Microsoft Learn References
| Topic | URL | Used In Section |
[All microsoft_docs_search and microsoft_docs_fetch URLs cited in the document]
```

---

## Part 5: Common Analysis Patterns

### Pattern A: New Field on Existing Table

```
PARALLEL:
  d365_lookup_table(table)                    -- Existing structure
  xref_find_extensions(table)                 -- Existing table extensions
  d365_get_entity_sources(relatedEntity)      -- Does data entity need updating?
  microsoft_docs_search("D365 [table] fields") -- Official field documentation
THEN:
  xref_find_field_usages(table, similarField) -- How similar field is used
  sec_permission_trace(role, object_name:form) -- Security impact
```

### Pattern B: New Validation Rule

```
PARALLEL:
  d365_get_class_methods(class, filter:"*validate*", include_source:true)
  xref_find_extensions(class)
  xref_find_event_handlers(class)
  microsoft_code_sample_search("D365 validation CoC extension X++")  ← NEW
```

### Pattern C: Report Modification

```
1. d365_search(reportName)                    -- Find report, DP class, controller
2. PARALLEL:
   d365_get_class_methods(dpClass)
   xref_find_references(reportName)
   xref_find_extensions(dpClass)
   microsoft_docs_search("D365 SSRS report [topic]") ← NEW
3. d365_lookup_table(dataSourceTable)
```

### Pattern D: Cross-Company Feature

```
1. d365_lookup_table(table) → check per_company flag
2. d365_get_join_keys(table1, table2) → verify cross-company joins
3. sec_company_users(company) → who operates in target companies
4. microsoft_docs_search("D365 cross-company intercompany") ← NEW: official guidance
```

### Pattern E: Batch Job / Recurring Process

```
PARALLEL:
  d365_get_class_methods(batchClass) → run(), execute(), process()
  xref_class_hierarchy(batchClass)   → RunBaseBatch? SysOperationServiceController?
  xref_find_extensions(batchClass)
  microsoft_code_sample_search("SysOperationServiceController batch D365") ← NEW
THEN:
  d365_get_method_source(batchClass, "run")
```

### Pattern F: DMF Entity Enhancement

```
PARALLEL:
  d365_get_entity_sources(entity)              → field mapping + staging
  d365_lookup_table(stagingTable)               → staging structure
  xref_find_extensions(entity)                  → entity extensions
  microsoft_docs_search("D365 data entity [entityName]") ← NEW
THEN:
  d365_get_class_methods(entity, filter:"*validate*")
  d365_check_field_exists(backingTable, [newFields])
  microsoft_docs_fetch(entity_docs_url)         ← NEW: full entity field reference
```

---

## Part 6: Security Analysis for FADs

### New Feature Security Checklist

1. **Identify entry points** → forms, actions, reports
2. **Map to security model** → Entry Point → Privilege → Duty → Role
3. **Verify existing model:**
   ```
   sec_permission_trace(role, object_name:form) → current pattern
   sec_find_roles_by_privilege(similarPrivilege) → who has similar access
   microsoft_docs_search("D365 security role [feature]")  → official role guidance
   ```
4. **SoD validation** → new duty must not conflict with existing duties
5. **Cross-company** → `sec_company_users(company)` → verify affected users

---

## Part 7: Task Recorder for Functional Analysis

### When to Use Task Recorder

- **AS-IS documentation**: Parse recording → auto-generate current process flow
- **Test case generation**: Recording steps → test scenarios for Section 10
- **Security requirements**: BPM roles → Section 6 baseline
- **Form/table discovery**: Data Sources → tables to investigate

### How to Use taskrecorder_to_markdown

**CRITICAL: When you see an .axtr file, call `taskrecorder_to_markdown` DIRECTLY.**
Do NOT try to read or open the file. The MCP service handles the binary parsing.

**Enrichment pattern after parsing:**
```
1. taskrecorder_to_markdown(file_content or file_url)
2. PARALLEL per form in Forms Visited:
     d365_lookup_table(primaryTable)  |  microsoft_docs_search("D365 [form_label]")
3. PARALLEL per role in Security Roles:
     sec_lookup_role(roleName)
4. For key MS Learn results:
     microsoft_docs_fetch(url) → full page on each form's standard behavior
5. From Data Entry Summary:
     d365_check_field_exists for key fields
```

---

## Part 8: Anti-Patterns

| Anti-Pattern | Consequence | Instead |
|-------------|-------------|---------|
| Data model without `d365_lookup_table` | Wrong field names | Always verify tables |
| Fields without `d365_check_field_exists` | Hallucinated names | Verify before documenting |
| Skipping `xref_find_extensions` | Miss customization conflicts | Always check before designing |
| `rag_ask` for table metadata | RAG has docs, not schemas | d365kb for metadata |
| Security says "TBD" | Surprise effort later | `sec_permission_trace` takes seconds |
| No integration impact section | Entity breaks at go-live | Always check `d365_get_entity_sources` |
| Reading .axtr files manually | Miss BPM metadata | Use `taskrecorder_to_markdown` |
| Sequential MCP calls | 4x slower | Batch all independent calls |
| No maturity tags | Can't distinguish verified vs assumed | Tag everything |
| Effort estimate without extension count | Underestimate | Extension count = complexity input |
| `microsoft_docs_search` without `fetch` | Miss full procedures, config details | Always fetch the best 1-2 search results |
| Describing standard behavior without MS Learn | Assumptions, not facts | Search + fetch official docs, tag [MS-LEARN] |
| No code sample search for implementation | Reinvent patterns | `microsoft_code_sample_search` for official patterns |

---

## Part 9: Orchestration Workflow Summary

### Full FAD Workflow (9 Steps)

```
Step 1: CLARIFY requirements (ask user if ambiguous)
  If .axtr provided → call taskrecorder_to_markdown DIRECTLY

Step 2: RESEARCH (5 parallel calls)
  rag_ask(question)  |  rag_search_by_category("FDD", kw)
  |  rag_search_by_category("Blueprints", kw)
  |  microsoft_docs_search(feature_topic)  |  microsoft_docs_search(feature_config)

Step 3: FETCH MS Learn depth (1-3 calls)
  microsoft_docs_fetch(feature_overview_url)    -- Standard behavior for AS-IS
  microsoft_docs_fetch(config_guide_url)         -- Parameters for Technical Design
  microsoft_code_sample_search(pattern)          -- Code patterns for Extension Strategy

Step 4: DATA MODEL (parallel per table)
  d365_lookup_table(T)  |  d365_find_referencing_tables(T)  |  d365_get_entity_sources(E)
  [then: d365_get_join_keys, d365_get_enum, d365_check_field_exists]

Step 5: CODE ARCHITECTURE (parallel per class)
  d365_get_class_methods(C)  |  xref_class_hierarchy(C)
  |  xref_find_extensions(C)  |  xref_find_event_handlers(C)
  [then: d365_get_method_source for key methods]

Step 6: SECURITY
  sec_search(kw)  |  sec_permission_trace(role, obj)
  [then: sec_find_roles_by_privilege, SoD check]

Step 7: IMPACT (parallel)
  xref_impact_analysis(obj)  |  xref_cross_module_deps(mod)

Step 8: GENERATE FAD (template from Part 4, maturity-tagged)
  Include [MS-LEARN] tags with URLs. Appendix B: all MS Learn references.

Step 9: QUALITY GATE (checklist from Part 1)
```

---

*Version: 2.0 | Date: 2026-04-08 | Changes: Added Microsoft Learn 3-tool integration (search/fetch/code), fixed Task Recorder (direct call), added [MS-LEARN] maturity tag, expanded research phase to 5 parallel, added Appendix B template, added code sample patterns*

