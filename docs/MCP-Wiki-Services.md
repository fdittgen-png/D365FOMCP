# MCP — Wiki Services

Reference for **MCP clients** (Claude Code, Claude Desktop, Copilot Studio, Cursor, …) connecting to the blob-backed wiki MCPs hosted on this Function App. For the architecture and admin view, see [Architecture §10](Architecture.md#10-wiki-mcp-platform--one-shape-many-wikis) and [Administration §12](Administration.md#12-wiki-mcp-operations).

## What is a Wiki MCP?

Each wiki is a collection of markdown pages in an Azure Blob Storage container. The MCP exposes four read-only tools that let an LLM navigate the catalog, enumerate pages, read a single page, or search across all pages. One Function App hosts any number of wikis — each with its own container, its own description, and its own MCP endpoint.

Current wikis are listed at `GET /api/wiki-mcp` (no MCP — a plain JSON catalog). Each wiki lives at `/api/wiki-mcp/<name>`.

## Connecting

### Azure endpoint

```
https://tis-{env}-mcpd365fo-func.azurewebsites.net/api/wiki-mcp/<name>
```

`{env}` is `d` for development or `p` for production; `<name>` is the wiki slug from the catalog. The endpoint speaks MCP Streamable HTTP — the same transport as the other services in this app (KB, XRef, Security, Task Recorder).

### Authentication

Anonymous. The Function App is internal / VPN-scoped, matching the other MCP endpoints. If your client needs no-auth HTTP, you're done; if it insists on a header, any value for `Authorization` will be ignored server-side.

### Claude Code (remote)

```json
{
  "mcpServers": {
    "wiki-otrs": {
      "type": "url",
      "url": "https://tis-p-mcpd365fo-func.azurewebsites.net/api/wiki-mcp/otrs"
    },
    "wiki-runbooks": {
      "type": "url",
      "url": "https://tis-p-mcpd365fo-func.azurewebsites.net/api/wiki-mcp/runbooks"
    }
  }
}
```

One entry per wiki you want the LLM to see. Multiple wikis are not combined into one MCP — each is its own server so the LLM picks the right one by description.

### Claude Desktop (remote)

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "wiki-otrs": {
      "type": "url",
      "url": "https://tis-p-mcpd365fo-func.azurewebsites.net/api/wiki-mcp/otrs"
    }
  }
}
```

### Claude Desktop / Code (local stdio)

Local mode reads from the same Azure Blob Storage as the Azure deployment (via the `AzureWebJobsStorage` connection string). Set it up in `.env` first.

```json
{
  "mcpServers": {
    "wiki-otrs": {
      "command": "node",
      "args": ["C:\\working\\MCP\\src\\local\\mcp-server-wiki.js", "otrs"]
    }
  }
}
```

The first positional arg is the wiki name from `config/wikis.json`. Alternatively, set `WIKI_NAME=otrs` in `env`.

### Copilot Studio / Cursor / other MCP clients

Any client that can consume MCP Streamable HTTP works. Point it at `/api/wiki-mcp/<name>`, pass anonymous (or ignore auth), and the four tools become available.

## Tool reference

Each wiki exposes the same four tools, with their descriptions customized to the wiki's title and description (so the LLM knows which wiki is relevant to a given question).

### `wiki_index`

Read the wiki's catalog page (`index.md`). This is the LLM's starting point — the catalog usually lists every page with a short description and link.

- **Input:** none
- **Output (typed):**
  - `wiki_name` — the configured slug
  - `wiki_title` — human-readable title
  - `present` — `false` when `index.md` has not been uploaded yet
  - `content` — the raw markdown (empty when `present=false`)
  - `page_count` — how many non-index pages are in the container
  - `last_modified` — ISO timestamp of the index blob (used as the freshness banner)

### `wiki_list`

Enumerate every page with slug, title, summary, tags, and last-modified time. Cheaper than `wiki_index` when you just need the page catalog.

- **Input:**
  - `limit` — max pages to return. Default 100, hard ceiling 500.
- **Output (typed):**
  - `wiki_name`, `wiki_title`
  - `total` — total pages in the container
  - `pages[]` — `{slug, title, summary, tags[], last_modified, size_bytes}`
  - `truncated` — `true` when `total > limit`

`summary` comes from the frontmatter `summary:` field when present, otherwise the first non-heading line of the body. `tags` unions the frontmatter `tags:` and `keywords:` arrays.

### `wiki_read`

Read a single page by slug.

- **Input:**
  - `slug` (required) — the blob name relative to `pagesPrefix`, without the `.md` suffix. If the wiki's `pagesPrefix` is `tickets/`, the slug for the blob `tickets/1721474.md` is `1721474`.
- **Output (typed):**
  - `slug`, `title`, `blob_name`
  - `frontmatter` — parsed YAML frontmatter (scalar/array values)
  - `content` — raw markdown including frontmatter
  - `body` — markdown with frontmatter stripped
  - `last_modified` — ISO timestamp of the blob

On miss, returns `isError: true` and a "did you mean" list of up to 8 fuzzy-matched slugs.

### `wiki_search`

Weighted substring search across every page. Ranks pages by hits on title (×5), frontmatter tags (×3), and body (×1), with a bonus when every query term appears somewhere in the page.

- **Input:**
  - `query` (required) — space-separated terms
  - `limit` — max results. Default 10, hard ceiling 50.
- **Output (typed):**
  - `total_pages_scanned` — how many pages were considered
  - `total_matches` — how many results are in `matches[]`
  - `matches[]` — `{slug, title, score, snippets[]}` ordered by descending `score`
  - `truncated` — `true` when the result set hit the limit

The search is substring-based, not vector-based — deliberately, per the Karpathy/Starmorph pattern. If a wiki grows beyond a few hundred pages, split it into sub-wikis with sharper descriptions rather than bolting on embeddings.

## Response-format conventions

Every response follows the project's response-format contract ([`Response-Format-Contract.md`](Response-Format-Contract.md)):

- Markdown fallback opens with `##` (no H1 openers, no bold-as-header).
- Success paths include a freshness banner (`_wiki:<name> snapshot: <date>_`) derived from `index.md`'s `lastModified`.
- Typed + Markdown shipped together — the typed payload is validated against its schema ([`src/azure/output-schemas.js`](../src/azure/output-schemas.js)) on both sides of the wire.
- `emptyResult` / `notFoundResult` / `errorResult` are used consistently — `isError: true` means tool-level failure, not just "no results".

## Operating on wiki content

The MCP is **read-only**. Populating / updating a wiki is a separate pipeline:

- **OTRS wiki** — Power Automate runs on a schedule, calls the extractor + (future) ingestor Functions, and drops markdown into `wiki/tickets/`. See [PowerAutomate-OTRS-Extract.md](PowerAutomate-OTRS-Extract.md).
- **Other wikis** — manual `az storage blob upload`, Logic Apps pulling from Confluence/SharePoint, or any process that can write blobs. The MCP doesn't care how markdown arrives.

Cache behavior: a 60-second TTL per Function instance means new uploads are visible to the LLM within one minute. Restart the Function App for an immediate refresh.

## Adding another wiki

For operators: one command — `scripts\Add-WikiMcp.ps1`. Details in [Administration §12.2](Administration.md#122-adding-a-wiki--add-wikimcpps1).

For MCP clients: once the operator has redeployed, point a new `mcpServers` entry at `/api/wiki-mcp/<new-name>` — no other client-side changes.

## Service URLs

| Environment | Catalog | Per-wiki pattern |
|-------------|---------|------------------|
| Development | `https://tis-d-mcpd365fo-func.azurewebsites.net/api/wiki-mcp` | `…/api/wiki-mcp/<name>` |
| Production | `https://tis-p-mcpd365fo-func.azurewebsites.net/api/wiki-mcp` | `…/api/wiki-mcp/<name>` |

---

## Related Documentation

| Document | Description |
|----------|-------------|
| [Architecture](Architecture.md) | §10 — multi-wiki MCP platform design |
| [Administration](Administration.md) | §12 — wiki ops (registry, deployment, content, troubleshooting) |
| [AI Configuration](AI-Configuration.md) | Full MCP-client configuration for every supported client |
| [Response-Format Contract](Response-Format-Contract.md) | Authoritative rules for tool output shapes |
| [PowerAutomate — OTRS Extractor](PowerAutomate-OTRS-Extract.md) | The upstream pipeline that feeds the OTRS wiki |
| [README](../README.md) | Project overview and quick start |
