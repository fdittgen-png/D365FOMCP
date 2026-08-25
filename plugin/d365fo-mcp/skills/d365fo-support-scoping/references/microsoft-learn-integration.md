# Part 2: Microsoft Learn Integration

_Reference for the `d365fo-support-scoping` skill. Read on demand._


### Three Tools — Search, Fetch, Code Samples

| Tool | Purpose | When to Use |
|------|---------|-------------|
| `microsoft_docs_search(query)` | Find relevant docs (returns up to 10 chunks, ~500 tokens each) | **Always** in discovery phase — fast, broad |
| `microsoft_docs_fetch(url)` | Get full page content as markdown | **After search** — when a search result looks highly relevant and you need full detail |
| `microsoft_code_sample_search(query, language)` | Find official code examples (up to 20 results) | When investigating implementation patterns, X++ examples, API usage |

### Search → Fetch Pattern (Critical)

This is the most effective pattern for support and functional consultants:

```
Step 1: microsoft_docs_search("D365 finance [topic]")
  → Returns 10 chunks with titles + URLs + excerpts

Step 2: Identify 1-2 most relevant URLs from results

Step 3: microsoft_docs_fetch(best_url)
  → Returns FULL page: prerequisites, step-by-step procedures,
    configuration details, troubleshooting, related links
```

**When to fetch after search:**
- Search result mentions "For more information, see..." → FETCH that page
- Search result has a relevant procedure but truncated → FETCH full steps
- Search result references a configuration page → FETCH for parameters
- Troubleshooting section mentioned but not shown → FETCH for full details
- Feature overview found but need setup steps → FETCH the setup guide

**When search alone is enough:**
- Need a quick concept confirmation (e.g., "does D365 support partial invoicing?")
- Need to verify a feature exists
- Need a URL reference for the scoping document

### Microsoft Learn for Support Tickets

**Discovery phase** — run in parallel with RAG:
```
PARALLEL:
  rag_search(error_or_topic)                              -- Internal known issues
  microsoft_docs_search("D365 [error_or_topic]")          -- Official troubleshooting
  microsoft_docs_search("D365 [feature] configuration")   -- Setup/config guides
```

**Deep dive** — after search identifies relevant pages:
```
microsoft_docs_fetch(troubleshooting_url)  -- Full troubleshooting steps
microsoft_docs_fetch(configuration_url)    -- Full setup guide
```

**Code investigation** — when bug is in custom code or extension:
```
microsoft_code_sample_search("[pattern] D365 X++")  -- Official code patterns
```

### What Microsoft Learn Adds to Scoping Documents

| Scoping Section | Microsoft Learn Contribution |
|----------------|-------------------------------|
| **Known Information** | Official troubleshooting guides, known issues, workarounds |
| **Technical Context** | Standard behavior documentation — "this is how it's SUPPOSED to work" |
| **Reproduction Steps** | Official step-by-step procedures for the affected process |
| **Recommended Next Steps** | Links to relevant configuration guides, setup procedures |
| **Integration Context** | OData endpoint documentation, data entity field reference |

