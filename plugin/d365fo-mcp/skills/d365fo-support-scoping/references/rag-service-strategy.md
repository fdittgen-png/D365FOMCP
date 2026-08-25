# Part 4: RAG Service Strategy

_Reference for the `d365fo-support-scoping` skill. Read on demand._


### rag_ask vs rag_search vs rag_search_by_category

| Scenario | Tool | Why |
|----------|------|-----|
| "How does X work in D365?" | `rag_ask(question)` | Needs semantic understanding + synthesized answer |
| "Find documents about X" | `rag_search("keyword1 keyword2")` | Need specific document references, not an answer |
| "Find blueprints about X" | `rag_search_by_category("Business Blueprints","keyword")` | Know the domain, narrow the search |
| "Find existing FDD for X" | `rag_search_by_category("Functional Design Docs","keyword")` | FDDs are a specific category |
| "Read the full document" | `rag_lookup_document("filename")` | After finding a doc via search, read it fully |
| "What categories exist?" | `rag_list_categories()` | Discover available documentation domains |

### RAG Search-to-Document Pattern (Critical)

The most efficient RAG workflow follows three turns, not iterative keyword fishing:

```
Turn 1: DISCOVER (parallel)
  rag_list_categories()                              -- Understand document landscape
  rag_search("term1 OR term2 OR term3", limit:15)    -- Broad keyword search #1
  rag_search("term4 OR term5 OR term6", limit:15)    -- Broad keyword search #2
  rag_search("term7 OR term8", limit:15)              -- Broad keyword search #3

Turn 2: READ key documents (parallel)
  rag_lookup_document("best_doc_1.docx")             -- Full content of most relevant doc
  rag_lookup_document("best_doc_2.pdf")              -- Full content of second-best doc

Turn 3: WRITE the enriched output
```

**Anti-patterns to avoid:**
- **Natural language queries in FTS5:** `rag_search("How does the Basware invoice transfer work?")` returns nothing. Use `rag_search("Basware OR invoice OR transfer")` instead.
- **Iterative fragment hunting:** Don't run 6+ keyword variations hoping to find more fragments. After 2-3 searches, switch to `rag_lookup_document` on the best documents found.
- **Reading entire large documents unnecessarily:** If search already found the relevant chunks, don't `rag_lookup_document` a 70KB file just for completeness — it wastes context.
- **Repeated searches for the same concept:** If a search returns no results, rephrase once with simpler OR-separated keywords. If still nothing, the topic isn't in the RAG corpus — move on.

### RAG for Rescoping / Enrichment

When enriching an existing scoping document with RAG:
1. **Read the existing document first** — identify the 2-3 weakest areas
2. **Target RAG research at those gaps**, not the entire document
3. **Ask the user** whether they want a full rewrite or a targeted delta
4. **Add a "RAG Document Sources" appendix** citing which internal documents were consulted
5. **Cross-reference RAG findings with hypotheses** — upgrade likelihood when documentary evidence confirms a hypothesis

### Key Internal Documents by Domain (Trelleborg)

| Domain | Document | Key Content |
|--------|----------|-------------|
| LADE Finance / Dimensions | BODE FTM_Business Blue Print_V1.2.docx | Account structures, financial dimensions, defaulting logic, derived dimensions, posting policies |
| LADE Procurement | BODE_PTP_Business Blue Print_V01.docx | Vendor master, PO creation, charges, Basware flow, change management |
| Basware Integration | Trelleborg_SOF01_Basware_FDD_v1.3.pdf | OData entities, data flow, error handling, business events, master data sync |
| Basware API | Basware-Developer-Integration-Guide.md | API endpoints, prebooking, transferResponse, advancedValidations |
| Product / Items | BODE_CTP_Business Blue Print_V02.docx | Service items, product dimensions, templates, procurement categories |

### RAG Parameters

- `rag_ask`: Set `reasoning: true` for accuracy (adds ~3s but re-ranks with LLM). `top_k: 5-10` for broad, `top_k: 3` for focused.
- `rag_search`: FTS5 syntax: `"exact phrase"`, `term1 OR term2`, `term1 NOT term2`, `prefix*`. **Always use OR between keywords for broader results.**
- `rag_search_by_category`: Case-sensitive category names. Use `rag_list_categories()` if unsure.

### When NOT to use RAG

- Table/field metadata → d365kb (exact schemas)
- Code analysis → d365xref (cross-references)
- Security questions → d365sec (role/duty/privilege chain)
- Standard D365 behavior → `microsoft_docs_search` + `microsoft_docs_fetch` (official, always current)

