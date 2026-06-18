/**
 * Tests for src/azure/wiki-tools.js — registers the 4 wiki MCP tools on a
 * mock server with a fake BlobServiceClient. Covers:
 *   - registration, annotations, outputSchema
 *   - wiki_index success, empty, error shapes
 *   - wiki_list behavior with / without pages
 *   - wiki_read happy path + not-found suggestions
 *   - wiki_search behavior + truncation flag + frontmatter boost
 */

import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

import { registerWikiTools } from '../src/azure/wiki-tools.js';
import { _resetCache } from '../src/azure/wiki-storage.js';
import {
  wikiIndexOutput,
  wikiListOutput,
  wikiReadOutput,
  wikiSearchOutput,
} from '../src/azure/output-schemas.js';

// ── Mocks ────────────────────────────────────────────────────────────────────

class MockBlobServiceClient {
  /** @param {Record<string, {content:string, lastModified?:string}>} blobs  key = "container/blobname" */
  constructor(blobs) { this.blobs = blobs; }
  getContainerClient(container) { return new MockContainerClient(this, container); }
}

class MockContainerClient {
  constructor(svc, container) { this.svc = svc; this.container = container; }
  getBlobClient(blobName) { return new MockBlobClient(this.svc, this.container, blobName); }
  listBlobsFlat({ prefix = '' } = {}) {
    const svc = this.svc;
    const container = this.container;
    return (async function* () {
      for (const [key, val] of Object.entries(svc.blobs)) {
        const sep = key.indexOf('/');
        if (sep < 0) continue;
        if (key.slice(0, sep) !== container) continue;
        const name = key.slice(sep + 1);
        if (prefix && !name.startsWith(prefix)) continue;
        yield {
          name,
          properties: {
            lastModified: val.lastModified ? new Date(val.lastModified) : new Date('2026-04-01T00:00:00.000Z'),
            contentLength: Buffer.byteLength(val.content || '', 'utf8'),
          },
        };
      }
    })();
  }
}

class MockBlobClient {
  constructor(svc, container, blobName) { this.svc = svc; this.container = container; this.blobName = blobName; }
  async download() {
    const key = `${this.container}/${this.blobName}`;
    const b = this.svc.blobs[key];
    if (!b) {
      const err = new Error('BlobNotFound'); err.code = 'BlobNotFound'; err.statusCode = 404; throw err;
    }
    const buf = Buffer.from(b.content, 'utf8');
    return {
      readableStreamBody: Readable.from(buf),
      lastModified: b.lastModified ? new Date(b.lastModified) : new Date('2026-04-01T00:00:00.000Z'),
      contentLength: buf.length,
    };
  }
}

function createMockServer() {
  const handlers = {};
  return {
    registerTool: (name, config, handler) => {
      handlers[name] = {
        inputSchema: config.inputSchema || {},
        outputSchema: config.outputSchema,
        annotations: config.annotations,
        description: config.description,
        handler,
      };
    },
    handlers,
  };
}

// ── Fixture ──────────────────────────────────────────────────────────────────

const WIKI = {
  name: 'otrs',
  title: 'OTRS Resolved Cases',
  description: 'Fixture wiki for tests.',
  container: 'wiki',
  indexBlob: 'index.md',
  pagesPrefix: 'tickets/',
};

const INDEX_MD = `---
title: OTRS Resolved Cases
updated: 2026-04-15
---

# OTRS Resolved Cases

Curated catalog of resolved D365 support tickets.

## Recent

- [1721474](tickets/1721474.md) — Sales order post fails
- [1720411](tickets/1720411.md) — Inventory financial dim
`;

const PAGE_1721474 = `---
title: Sales order post fails with NumberSeq error
ticketId: 1721474
service: "TIS - Digital Solutions Support::ERP::D365"
tags: [sales, numbersequence, posting]
closedAt: 2026-04-10
summary: Number sequence not set up for sales posting.
---

# Sales order post fails with NumberSeq error

## Problem

When posting a sales order the system throws "Number sequence is not set up".

## Resolution

Navigate to Sales & marketing parameters → Number sequences → assign a new reference.
`;

const PAGE_1720411 = `---
title: Inventory adjustment fails on financial dimension
ticketId: 1720411
tags: [inventory, financial-dimension]
---

# Inventory adjustment fails on financial dimension

Body without a leading summary line works too.

Financial dimensions are invalid during inventory posting. Check legal entity setup.
`;

function baseBlobs() {
  return {
    'wiki/index.md':               { content: INDEX_MD, lastModified: '2026-04-15T10:00:00.000Z' },
    'wiki/tickets/1721474.md':     { content: PAGE_1721474, lastModified: '2026-04-10T14:30:00.000Z' },
    'wiki/tickets/1720411.md':     { content: PAGE_1720411, lastModified: '2026-04-12T09:00:00.000Z' },
  };
}

let handlers;

before(() => {
  // Build once with the default fixture.
});

beforeEach(() => {
  _resetCache();
  const server = createMockServer();
  const svc = new MockBlobServiceClient(baseBlobs());
  registerWikiTools(server, WIKI, { serviceClient: svc });
  handlers = server.handlers;
});

// ── Registration ─────────────────────────────────────────────────────────────

describe('registerWikiTools — contract', () => {
  it('registers all four tools', () => {
    assert.ok(handlers.wiki_index);
    assert.ok(handlers.wiki_list);
    assert.ok(handlers.wiki_read);
    assert.ok(handlers.wiki_search);
  });

  it('every tool declares READ_ONLY_DB_ANNOTATIONS and an outputSchema', () => {
    for (const [name, tool] of Object.entries(handlers)) {
      assert.equal(tool.annotations?.readOnlyHint, true, `${name} readOnlyHint`);
      assert.equal(tool.annotations?.idempotentHint, true, `${name} idempotentHint`);
      assert.equal(tool.annotations?.openWorldHint, false, `${name} openWorldHint`);
      assert.ok(tool.outputSchema, `${name} outputSchema`);
    }
  });
});

// ── wiki_index ───────────────────────────────────────────────────────────────

describe('wiki_index', () => {
  it('returns content + page count + lastModified when present', async () => {
    const r = await handlers.wiki_index.handler({});
    assert.ok(r.structuredContent);
    assert.doesNotThrow(() => wikiIndexOutput.parse(r.structuredContent));
    assert.equal(r.structuredContent.present, true);
    assert.equal(r.structuredContent.wiki_name, 'otrs');
    assert.equal(r.structuredContent.page_count, 2);
    assert.equal(r.structuredContent.last_modified, '2026-04-15T10:00:00.000Z');

    const text = r.content[0].text;
    assert.match(text, /_wiki:otrs snapshot: 2026-04-15/);
    assert.match(text, /^_.*\n\n## OTRS Resolved Cases — Index/m);
    assert.match(text, /Curated catalog/);
  });

  it('returns empty-result shape when index.md is missing', async () => {
    // Remove the index blob
    const server = createMockServer();
    const blobs = baseBlobs();
    delete blobs['wiki/index.md'];
    const svc = new MockBlobServiceClient(blobs);
    _resetCache();
    registerWikiTools(server, WIKI, { serviceClient: svc });

    const r = await server.handlers.wiki_index.handler({});
    assert.equal(r.structuredContent.present, false);
    assert.equal(r.structuredContent.page_count, 2);
    assert.match(r.content[0].text, /index.md has not been written yet/);
    assert.equal(r.isError, undefined); // empty, not an error
  });
});

// ── wiki_list ────────────────────────────────────────────────────────────────

describe('wiki_list', () => {
  it('lists the two pages with frontmatter-derived summaries and tags', async () => {
    const r = await handlers.wiki_list.handler({ limit: 10 });
    assert.doesNotThrow(() => wikiListOutput.parse(r.structuredContent));
    assert.equal(r.structuredContent.total, 2);
    assert.equal(r.structuredContent.truncated, false);
    const slugs = r.structuredContent.pages.map(p => p.slug).sort();
    assert.deepEqual(slugs, ['1720411', '1721474']);
    const t = r.structuredContent.pages.find(p => p.slug === '1721474');
    assert.ok(t.tags.includes('sales'));
    assert.match(t.summary, /Number sequence/);
  });

  it('marks truncated when pages > limit', async () => {
    const r = await handlers.wiki_list.handler({ limit: 1 });
    assert.equal(r.structuredContent.total, 2);
    assert.equal(r.structuredContent.pages.length, 1);
    assert.equal(r.structuredContent.truncated, true);
    assert.match(r.content[0].text, /Showing first 1 results/);
  });

  it('returns empty-result when the wiki has no pages', async () => {
    const server = createMockServer();
    const svc = new MockBlobServiceClient({
      'wiki/index.md': { content: INDEX_MD, lastModified: '2026-04-15' },
    });
    _resetCache();
    registerWikiTools(server, WIKI, { serviceClient: svc });
    const r = await server.handlers.wiki_list.handler({ limit: 10 });
    assert.equal(r.structuredContent.total, 0);
    assert.match(r.content[0].text, /No pages in wiki:otrs/);
  });
});

// ── wiki_read ────────────────────────────────────────────────────────────────

describe('wiki_read', () => {
  it('reads a page by slug with frontmatter and body split', async () => {
    const r = await handlers.wiki_read.handler({ slug: '1721474' });
    assert.doesNotThrow(() => wikiReadOutput.parse(r.structuredContent));
    assert.equal(r.structuredContent.slug, '1721474');
    assert.equal(r.structuredContent.blob_name, 'tickets/1721474.md');
    assert.equal(r.structuredContent.title, 'Sales order post fails with NumberSeq error');
    assert.equal(r.structuredContent.frontmatter.ticketId, 1721474);
    assert.ok(Array.isArray(r.structuredContent.frontmatter.tags));
    // Body starts with the first H1 after the (stripped) frontmatter. Leading
    // whitespace from the blank line separating `---` and the heading is
    // preserved — match with a regex anchor to the first `#`.
    assert.match(r.structuredContent.body, /^\s*#\s+Sales order post fails/);
    assert.ok(r.structuredContent.content.startsWith('---'));
  });

  it('returns notFound with fuzzy suggestions for an unknown slug', async () => {
    const r = await handlers.wiki_read.handler({ slug: '1721475' });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /Wiki page .1721475. was not found/);
    assert.match(r.content[0].text, /1721474/);
  });

  it('rejects an empty slug with invalid-input', async () => {
    const r = await handlers.wiki_read.handler({ slug: '' });
    // errorResult('invalid-input', …) sets isError: true and renders the
    // hint under a "## Error" heading (no structuredContent on error responses).
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /## Error/);
    assert.match(r.content[0].text, /Provide the page slug/);
  });
});

// ── wiki_search ──────────────────────────────────────────────────────────────

describe('wiki_search', () => {
  it('finds a page and returns snippets', async () => {
    const r = await handlers.wiki_search.handler({ query: 'NumberSeq' });
    assert.doesNotThrow(() => wikiSearchOutput.parse(r.structuredContent));
    assert.equal(r.structuredContent.total_pages_scanned, 2);
    assert.ok(r.structuredContent.total_matches >= 1);
    assert.equal(r.structuredContent.matches[0].slug, '1721474');
  });

  it('matches on frontmatter tags', async () => {
    const r = await handlers.wiki_search.handler({ query: 'financial-dimension' });
    assert.ok(r.structuredContent.matches.length >= 1);
    assert.equal(r.structuredContent.matches[0].slug, '1720411');
  });

  it('returns empty-result when nothing matches', async () => {
    const r = await handlers.wiki_search.handler({ query: 'zzzzzzz', limit: 10 });
    assert.equal(r.structuredContent.total_matches, 0);
    assert.match(r.content[0].text, /No matches for query "zzzzzzz"/);
    assert.equal(r.isError, undefined);
  });

  it('rejects empty query with invalid-input', async () => {
    const r = await handlers.wiki_search.handler({ query: '' });
    assert.equal(r.isError, true);
  });
});
