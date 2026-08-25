---
description: Looks up internal D365FO knowledge in the blob-backed wiki MCPs (support tickets, runbooks, decisions) — search, then read the matching pages and answer with page citations. Use when a question is about "how did we solve this before", a past ticket, an internal convention, or anything documented internally rather than in Microsoft Learn.
argument-hint: <search terms | page slug>
---

# D365 Wiki Lookup

## Task
Answer `$ARGUMENTS` from the connected wiki MCP(s) — every server whose tools are named `wiki_index` / `wiki_list` / `wiki_read` / `wiki_search` (one server per wiki; the server name tells you which wiki it is).
**Done when:** the answer cites the wiki page slugs it relies on, states clearly if nothing relevant was found, and does not paraphrase content you did not actually read.

## Workflow

### Step 1: Orient (once per session per wiki)
- `wiki_index` — read the curated index page to learn what the wiki covers and how slugs are structured. Skip this if you already read it in this conversation.

### Step 2: Find candidates
- If `$ARGUMENTS` looks like a slug (no spaces, matches the index's slug pattern) → `wiki_read` with `slug` directly and go to Step 4.
- Otherwise `wiki_search` with `query` = space-separated key terms (object names, error text fragments, ticket numbers), `limit` 10. Run one search per distinct concept in parallel rather than one long query.

### Step 3: Read only what matters
- `wiki_read` the top 1–3 hits by score. Stop as soon as the question is answered; do not read every hit.

### Step 4: Cross-check when the wiki names D365 objects
- Tables/fields/classes mentioned in a page → confirm they still exist with `d365kb:d365_lookup_table` / `d365kb:d365_check_field_exists` (pages can be older than the current build).
- Security statements → `d365sec:sec_permission_trace` if the question is about access.

## Output
- **Answer** — 2–6 sentences, directly addressing the question
- **Sources** — `wiki:<server>/<slug>` for each page used, with the page's last-modified date if shown
- **Verification** — which D365 objects were re-confirmed against the KB snapshot, and anything that no longer matches
- **Not found** — if the search returned nothing useful, say so and suggest `/d365-research` for external sources

## Follow-ups to offer
- Broader research including Microsoft Learn and RAG: `/d365-research <topic>`
- Scope a related ticket: `/support-scope <description>`
