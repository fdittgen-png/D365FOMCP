/**
 * Wiki search — weighted substring scoring over title / tags / body.
 *
 * The Karpathy-style LLM wiki pattern deliberately avoids vector search:
 * markdown files + an `index.md` is enough to steer Claude to the right
 * page. This search is the last-mile helper for when the LLM doesn't know
 * which slug to read — it ranks pages by how well the query matches their
 * title, frontmatter tags, and body, and returns short context snippets.
 *
 * Scaling: O(pages × tokens). A wiki of 500 pages at 10 KB each runs in
 * < 50 ms on Node 20. When you outgrow that, either bring your own index
 * (Azure AI Search) or split into sub-wikis.
 */

import { contextAround } from './shared.js';

const DEFAULT_SNIPPET_WINDOW = 80;
const MAX_SNIPPETS_PER_PAGE = 3;

/**
 * @param {import('./wiki-storage.js').WikiPage[]} pages
 * @param {string} query
 * @param {object} [opts]
 * @param {number} [opts.limit=10] - max results to return (after ranking)
 * @param {number} [opts.snippetWindow=80] - chars each side of a match
 * @returns {SearchResult[]}
 *
 * @typedef {object} SearchResult
 * @property {string} slug
 * @property {string} title
 * @property {number} score
 * @property {string[]} snippets
 */
export function searchPages(pages, query, { limit = 10, snippetWindow = DEFAULT_SNIPPET_WINDOW } = {}) {
  const terms = tokenize(query);
  if (terms.length === 0) return [];

  const scored = [];
  for (const page of pages) {
    const hit = scorePage(page, terms, snippetWindow);
    if (hit.score > 0) scored.push(hit);
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

function scorePage(page, terms, snippetWindow) {
  const title = (page.title || '').toLowerCase();
  const tags = collectTags(page.frontmatter).map(t => t.toLowerCase());
  const body = (page.body || '').toLowerCase();

  let score = 0;
  for (const t of terms) {
    const tl = t.toLowerCase();
    const titleHits = countOccurrences(title, tl);
    const tagHits = tags.filter(tag => tag.includes(tl)).length;
    const bodyHits = countOccurrences(body, tl);
    // Weights: title is authoritative, tags are curated, body is noise-prone.
    score += titleHits * 5 + tagHits * 3 + bodyHits;
  }

  // Bonus for matching every term at least once — rewards specific queries
  // over a single lucky match against one common word.
  const coverage = terms.every(t => {
    const tl = t.toLowerCase();
    return title.includes(tl) || tags.some(tag => tag.includes(tl)) || body.includes(tl);
  });
  if (coverage && terms.length > 1) score += 5;

  const snippets = score > 0 ? extractSnippets(page, terms, snippetWindow) : [];
  return {
    slug: page.slug,
    title: page.title,
    score,
    snippets,
  };
}

function extractSnippets(page, terms, snippetWindow) {
  const out = [];
  const seen = new Set();
  for (const t of terms) {
    for (const source of [page.body || '']) {
      if (!source) continue;
      const snip = contextAround(source, t, snippetWindow);
      if (!snip) continue;
      const key = snip.slice(0, 30);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(snip);
      if (out.length >= MAX_SNIPPETS_PER_PAGE) return out;
    }
  }
  return out;
}

function collectTags(fm) {
  if (!fm) return [];
  const out = [];
  if (Array.isArray(fm.tags)) out.push(...fm.tags.map(String));
  if (Array.isArray(fm.keywords)) out.push(...fm.keywords.map(String));
  if (typeof fm.service === 'string') out.push(fm.service);
  if (typeof fm.category === 'string') out.push(fm.category);
  return out;
}

/** Tokenize a query: split on whitespace, strip quotes, drop empty strings. */
export function tokenize(query) {
  if (typeof query !== 'string') return [];
  return query
    .split(/\s+/)
    .map(s => s.replace(/^["'`]+|["'`]+$/g, '').trim())
    .filter(Boolean);
}

function countOccurrences(haystack, needle) {
  if (!haystack || !needle) return 0;
  let count = 0;
  let i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) {
    count++;
    i += needle.length;
  }
  return count;
}
