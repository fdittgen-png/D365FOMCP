/**
 * Wiki MCP tools — one tool shape, many wikis.
 *
 * Given a `WikiConfig` + a `WikiStore`, register four tools on the supplied
 * McpServer instance:
 *
 *   wiki_index   — read index.md (the catalog)
 *   wiki_list    — enumerate every page with frontmatter summary
 *   wiki_read    — read a single page by slug
 *   wiki_search  — weighted substring search + snippets
 *
 * Every tool:
 *   - Emits a freshness banner on success (the index blob's lastModified)
 *   - Opens the Markdown fallback with `##` H2 (no H1, no bold fake headers)
 *   - Returns typed output via `structuredResult` (schemas in output-schemas.js)
 *   - Uses `emptyResult` / `notFoundResult` / `errorResult` from shared.js
 *   - Carries the shared read-only annotations hint for host auto-allow
 */

import { z } from 'zod';
import {
  READ_ONLY_DB_ANNOTATIONS,
  emptyResult,
  errorResult,
  notFoundResult,
  structuredResult,
  truncationNote,
  formatMarkdownTable,
} from './shared.js';
import { createWikiStore } from './wiki-storage.js';
import { searchPages } from './wiki-search.js';
import {
  wikiIndexOutput,
  wikiListOutput,
  wikiReadOutput,
  wikiSearchOutput,
} from './output-schemas.js';

const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 500;
const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 50;

/**
 * Register the four wiki tools on an McpServer for a specific wiki.
 *
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 * @param {import('./wiki-registry.js').WikiConfig} wiki
 * @param {object} [opts]
 * @param {object} [opts.serviceClient] - injected BlobServiceClient for tests
 */
export function registerWikiTools(server, wiki, { serviceClient = null } = {}) {
  const store = createWikiStore(wiki, { serviceClient });

  // ── wiki_index ─────────────────────────────────────────────────────────────
  server.registerTool(
    'wiki_index',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description:
        `Read the index page of the "${wiki.title}" wiki — the curated catalog listing every entry. `
        + `${wiki.description} `
        + `Start here to understand what is in the wiki before calling wiki_read or wiki_search.`,
      inputSchema: {},
      outputSchema: wikiIndexOutput.shape,
    },
    async () => {
      try {
        const [idx, listing] = await Promise.all([store.getIndex(), store.listPages()]);
        const pageCount = listing.length;

        if (!idx) {
          const typed = {
            wiki_name: wiki.name,
            wiki_title: wiki.title,
            present: false,
            content: '',
            page_count: pageCount,
            last_modified: null,
          };
          const fallback = emptyResult(
            `index for wiki:${wiki.name}. The wiki exists but ${wiki.indexBlob} has not been written yet `
            + `(${pageCount} page(s) are in the container)`,
          );
          return { ...fallback, structuredContent: typed };
        }

        const banner = await store.freshnessBanner();
        const typed = {
          wiki_name: wiki.name,
          wiki_title: wiki.title,
          present: true,
          content: idx.content,
          page_count: pageCount,
          last_modified: idx.lastModified,
        };
        const md =
          banner
          + `## ${wiki.title} — Index\n\n`
          + `Pages in container \`${wiki.container}\`: **${pageCount}**\n\n`
          + `---\n\n`
          + idx.content;
        return structuredResult(typed, md);
      } catch (err) {
        return errorResult('db-error', `Could not read the ${wiki.title} index.`, err);
      }
    },
  );

  // ── wiki_list ──────────────────────────────────────────────────────────────
  server.registerTool(
    'wiki_list',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description:
        `List every page in the "${wiki.title}" wiki with its slug, title, tags, and last-modified time. `
        + `Cheaper than wiki_index when you only need the page catalog. Returns up to ${DEFAULT_LIST_LIMIT} `
        + `pages by default (hard ceiling ${MAX_LIST_LIMIT}).`,
      inputSchema: {
        limit: z.number().int().positive().max(MAX_LIST_LIMIT).optional().default(DEFAULT_LIST_LIMIT)
          .describe(`Max pages to return (hard ceiling ${MAX_LIST_LIMIT})`),
      },
      outputSchema: wikiListOutput.shape,
    },
    async ({ limit }) => {
      // Defensive default — the mock test server bypasses Zod and may pass undefined.
      const effectiveLimit = Number.isInteger(limit) && limit > 0 && limit <= MAX_LIST_LIMIT
        ? limit
        : DEFAULT_LIST_LIMIT;

      try {
        const pages = await store.loadAllPages();
        const total = pages.length;

        if (total === 0) {
          const typed = {
            wiki_name: wiki.name,
            wiki_title: wiki.title,
            total: 0,
            pages: [],
            truncated: false,
          };
          const fallback = emptyResult(`pages in wiki:${wiki.name}`);
          return { ...fallback, structuredContent: typed };
        }

        const truncated = total > effectiveLimit;
        const slice = truncated ? pages.slice(0, effectiveLimit) : pages;

        const typedPages = slice.map(p => ({
          slug: p.slug,
          title: p.title,
          summary: firstSummaryLine(p),
          tags: collectTags(p.frontmatter),
          last_modified: p.lastModified,
          size_bytes: Buffer.byteLength(p.content || '', 'utf8'),
        }));

        const typed = {
          wiki_name: wiki.name,
          wiki_title: wiki.title,
          total,
          pages: typedPages,
          truncated,
        };

        const banner = await store.freshnessBanner();
        const table = formatMarkdownTable(
          typedPages.map(p => ({
            slug: p.slug,
            title: p.title,
            tags: p.tags.join(', '),
            updated: p.last_modified || '',
          })),
          ['slug', 'title', 'tags', 'updated'],
        );
        let md = banner
          + `## ${wiki.title} — Pages (${typedPages.length}/${total})\n\n`
          + table;
        if (truncated) md += truncationNote('user', typedPages.length);
        return structuredResult(typed, md);
      } catch (err) {
        return errorResult('db-error', `Could not list pages in wiki:${wiki.name}.`, err);
      }
    },
  );

  // ── wiki_read ──────────────────────────────────────────────────────────────
  server.registerTool(
    'wiki_read',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description:
        `Read a single page from the "${wiki.title}" wiki by slug. Returns the full markdown, parsed `
        + `frontmatter, and the body with frontmatter stripped. Use wiki_index or wiki_list to discover `
        + `valid slugs, or wiki_search to find the relevant page.`,
      inputSchema: {
        slug: z.string().min(1).max(500).describe(
          'Page slug — the blob name relative to the wiki\'s pagesPrefix, without the .md suffix. '
          + 'Example: for a page at `tickets/1234567.md` in a wiki with pagesPrefix `tickets/`, the slug is `1234567`.',
        ),
      },
      outputSchema: wikiReadOutput.shape,
    },
    async ({ slug }) => {
      if (typeof slug !== 'string' || slug.trim().length === 0) {
        return errorResult('invalid-input', 'Provide the page slug.');
      }
      try {
        const page = await store.getPage(slug);
        if (!page) {
          // Offer fuzzy suggestions so the LLM can retry with a valid slug.
          let suggestions = [];
          try {
            const listing = await store.listPages();
            suggestions = fuzzyMatch(slug, listing.map(l => l.slug), 8);
          } catch { /* cleanup-warn suppressed; suggestions are best-effort */ }
          return notFoundResult('Wiki page', slug, suggestions);
        }

        const banner = await store.freshnessBanner();
        const typed = {
          wiki_name: wiki.name,
          slug: page.slug,
          title: page.title,
          blob_name: page.blobName,
          frontmatter: page.frontmatter,
          content: page.content,
          body: page.body,
          last_modified: page.lastModified,
        };

        const fmLines = Object.keys(page.frontmatter).length > 0
          ? `\n\n### Frontmatter\n\n${formatFrontmatter(page.frontmatter)}\n`
          : '';
        const md = banner
          + `## ${page.title}\n\n`
          + `_Source: \`${wiki.container}/${page.blobName}\` — updated ${page.lastModified || '(unknown)'}_\n`
          + fmLines
          + `\n${page.body}`;

        return structuredResult(typed, md);
      } catch (err) {
        return errorResult('db-error', `Could not read page "${slug}".`, err);
      }
    },
  );

  // ── wiki_search ────────────────────────────────────────────────────────────
  server.registerTool(
    'wiki_search',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description:
        `Search across every page in the "${wiki.title}" wiki. Ranks pages by weighted matches on title, `
        + `frontmatter tags, and body text; returns context snippets around each match. Returns up to `
        + `${DEFAULT_SEARCH_LIMIT} results by default (hard ceiling ${MAX_SEARCH_LIMIT}).`,
      inputSchema: {
        query: z.string().min(1).max(500).describe('Search query — space-separated terms.'),
        limit: z.number().int().positive().max(MAX_SEARCH_LIMIT).optional().default(DEFAULT_SEARCH_LIMIT)
          .describe(`Max results to return (hard ceiling ${MAX_SEARCH_LIMIT})`),
      },
      outputSchema: wikiSearchOutput.shape,
    },
    async ({ query, limit }) => {
      if (typeof query !== 'string' || query.trim().length === 0) {
        return errorResult('invalid-input', 'Provide a search query.');
      }
      const effectiveLimit = Number.isInteger(limit) && limit > 0 && limit <= MAX_SEARCH_LIMIT
        ? limit
        : DEFAULT_SEARCH_LIMIT;

      try {
        const pages = await store.loadAllPages();
        const totalScanned = pages.length;
        const matches = searchPages(pages, query, { limit: effectiveLimit });

        if (matches.length === 0) {
          const typed = {
            wiki_name: wiki.name,
            wiki_title: wiki.title,
            query,
            total_pages_scanned: totalScanned,
            total_matches: 0,
            matches: [],
            truncated: false,
          };
          const fallback = emptyResult(
            `matches for query "${query}" in wiki:${wiki.name} (scanned ${totalScanned} page(s))`,
          );
          return { ...fallback, structuredContent: typed };
        }

        // searchPages already truncates to `limit`; we never know the full hit
        // count without re-running without limit, so treat any result at the
        // cap as "possibly truncated" for the banner.
        const truncated = matches.length >= effectiveLimit;

        const typed = {
          wiki_name: wiki.name,
          wiki_title: wiki.title,
          query,
          total_pages_scanned: totalScanned,
          total_matches: matches.length,
          matches: matches.map(m => ({
            slug: m.slug, title: m.title, score: m.score, snippets: m.snippets,
          })),
          truncated,
        };

        const banner = await store.freshnessBanner();
        let md = banner
          + `## Search results — "${query}" in ${wiki.title}\n\n`
          + `Scanned ${totalScanned} page(s). Top ${matches.length} matches.\n\n`;
        for (const m of matches) {
          md += `### \`${m.slug}\` — ${m.title} (score ${m.score})\n\n`;
          if (m.snippets.length === 0) {
            md += `_(match in title or tags only)_\n\n`;
          } else {
            for (const s of m.snippets) md += `> ${s.replace(/\n/g, ' ')}\n\n`;
          }
        }
        if (truncated) md += truncationNote('user', matches.length);

        return structuredResult(typed, md);
      } catch (err) {
        return errorResult('db-error', `Could not search wiki:${wiki.name}.`, err);
      }
    },
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function firstSummaryLine(page) {
  // Prefer an explicit `summary:` frontmatter field, else the first non-blank
  // prose line of the body (skipping any opening heading).
  if (typeof page.frontmatter?.summary === 'string' && page.frontmatter.summary.trim()) {
    return page.frontmatter.summary.trim();
  }
  const body = page.body || '';
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) continue;
    return line.length > 200 ? line.slice(0, 197) + '...' : line;
  }
  return null;
}

function collectTags(fm) {
  const out = [];
  if (Array.isArray(fm?.tags)) out.push(...fm.tags.map(String));
  if (Array.isArray(fm?.keywords)) out.push(...fm.keywords.map(String));
  return out;
}

function formatFrontmatter(fm) {
  const rows = Object.entries(fm).map(([k, v]) => ({
    key: k,
    value: Array.isArray(v) ? v.join(', ') : String(v ?? ''),
  }));
  return formatMarkdownTable(rows, ['key', 'value']);
}

/**
 * Lightweight fuzzy match for did-you-mean suggestions. Ranks by:
 *   1. Prefix match score (exact prefix is strongest)
 *   2. Substring inclusion
 *   3. Edit-distance-ish character overlap
 * No external dep required, and the slug list is small (wiki pages, not code).
 */
function fuzzyMatch(needle, haystack, limit = 8) {
  const n = needle.toLowerCase();
  const scored = haystack.map(s => {
    const sl = s.toLowerCase();
    let score = 0;
    if (sl === n) score += 100;
    if (sl.startsWith(n)) score += 50;
    if (sl.includes(n)) score += 25;
    // Shared-prefix bonus
    let i = 0;
    while (i < Math.min(sl.length, n.length) && sl[i] === n[i]) { score += 2; i++; }
    return { s, score };
  })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(x => x.s);
}
