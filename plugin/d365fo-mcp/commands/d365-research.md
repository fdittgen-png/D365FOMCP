---
description: Researches a D365FO topic across internal RAG documentation, Microsoft Learn, and AOT metadata, and synthesizes one sourced answer. Use for "how does X work", feature/configuration questions, or any D365 topic needing multi-source research.
argument-hint: <question or topic>
---

# D365 Research

## Task
Research `$ARGUMENTS` across all knowledge sources and synthesize one answer.
**Done when:** the answer separates what the sources confirmed from what you concluded, every claim carries its source (Microsoft Learn URL, RAG document ID, or AOT object), and anything that could not be verified is flagged.

## Workflow

### Step 1: Search all sources in parallel
- `d365rag:rag_ask` with the question — internal documentation corpus _(if the d365rag MCP is connected)_
- `d365rag:rag_search` with OR-combined keywords (not sentences — FTS5) — find specific documents
- `Microsoft Learn:microsoft_docs_search` with the query — official documentation
- `d365kb:d365_search` with keywords — AOT metadata (tables, classes, enums related to the topic)
- `wiki_search` on every connected wiki MCP with the key terms — internal tickets, runbooks, decisions _(if a wiki MCP is connected; see `/d365-wiki`)_

### Step 2: Deep dive (conditional)
- Most relevant Microsoft Learn URL → `microsoft_docs_fetch` for the full page
- Specific RAG hits → `d365rag:rag_lookup_document`
- Wiki hits → `wiki_read` with the slug (top 1–2 only)
- Specific tables/classes surfaced → `d365kb:d365_lookup_table` / `d365kb:d365_get_class_methods`
- Development topics → `Microsoft Learn:microsoft_code_sample_search` (language "xpp" or "csharp")

## Output
- **Summary** (2-3 sentences)
- **Detailed Explanation** — from documentation; mark statements that are your own synthesis rather than sourced
- **Related Objects** — tables, classes, enums from the KB
- **References** — Microsoft Learn URLs, RAG document IDs
- **Unverified / open points** — anything the sources did not settle
