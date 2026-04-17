/**
 * Tests for src/azure/wiki-ingest-core.js.
 *
 * Uses a fake WikiWriter that records every call into arrays so we can
 * assert: one writePage per ticket, one writeIndex, per-ticket failures
 * don't kill the batch, and the summary shape is complete.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ticketsToXml } from '../src/azure/otrs-xml.js';
import { ingestExtractXml } from '../src/azure/wiki-ingest-core.js';

const WIKI = {
  name: 'otrs',
  title: 'OTRS Resolved Cases',
  description: 'fixture',
  container: 'wiki',
  indexBlob: 'index.md',
  pagesPrefix: 'tickets/',
};

function makeWriter({ failSlug = null } = {}) {
  const calls = { pages: [], index: [] };
  return {
    calls,
    wiki: WIKI,
    async writePage(slug, content) {
      if (failSlug && slug === failSlug) {
        throw new Error(`simulated blob failure for ${slug}`);
      }
      const blobName = `${WIKI.pagesPrefix}${slug}.md`;
      calls.pages.push({ slug, content, blobName });
      return blobName;
    },
    async writeIndex(content) {
      calls.index.push({ content });
      return WIKI.indexBlob;
    },
    async ensureContainer() { /* no-op */ },
  };
}

function ticket(id, overrides = {}) {
  return {
    ticketId: String(id),
    ticketNumber: `TN-${id}`,
    title: `Ticket ${id}`,
    queue: 'D365 Support',
    service: 'TIS - Digital Solutions Support::ERP::D365',
    priority: '3 normal',
    closedAt: `2026-04-${10 + Number(id) % 20} 14:00:00`,
    description: `Customer description for ticket ${id}.`,
    resolution: `Resolution transcript for ticket ${id}. Multi-line steps here.`,
    articles: [
      { senderType: 'customer', from: 'u@x.com', createdAt: '2026-04-05 10:00:00', body: `problem ${id}` },
      { senderType: 'agent', from: 'a@x.com', createdAt: '2026-04-10 14:00:00', body: `resolution ${id}` },
    ],
    ...overrides,
  };
}

// ── Happy path ───────────────────────────────────────────────────────────────

describe('ingestExtractXml — happy path', () => {
  it('writes one page per ticket and one index', async () => {
    const xml = ticketsToXml([ticket(1), ticket(2), ticket(3)], { mode: 'full' });
    const writer = makeWriter();

    const summary = await ingestExtractXml({ xml, wiki: WIKI, writer });

    assert.equal(summary.total_extracted, 3);
    assert.equal(summary.written, 3);
    assert.equal(summary.failed, 0);
    assert.equal(writer.calls.pages.length, 3);
    assert.equal(writer.calls.index.length, 1);
    assert.deepEqual(writer.calls.pages.map(p => p.slug).sort(), ['1', '2', '3']);
    assert.equal(summary.indexBlob, 'index.md');
  });

  it('writes page content that is valid markdown with our frontmatter fence', async () => {
    const xml = ticketsToXml([ticket(42)], { mode: 'full' });
    const writer = makeWriter();
    await ingestExtractXml({ xml, wiki: WIKI, writer });

    const page = writer.calls.pages[0];
    assert.match(page.content, /^---\n/);
    // ticketId is a numeric-looking string → always quoted in the YAML
    // so the round-trip via wiki-storage preserves its string type.
    assert.match(page.content, /^ticketId: "42"$/m);
    assert.match(page.content, /^# Ticket 42$/m);
  });

  it('produces a deterministic index ordered by closedAt desc', async () => {
    const xml = ticketsToXml([
      ticket('A', { closedAt: '2026-01-01 10:00:00' }),
      ticket('B', { closedAt: '2026-04-01 10:00:00' }),
      ticket('C', { closedAt: '2026-02-01 10:00:00' }),
    ], { mode: 'full' });
    const writer = makeWriter();
    await ingestExtractXml({ xml, wiki: WIKI, writer });

    const indexBody = writer.calls.index[0].content;
    const order = ['B', 'C', 'A']; // desc by closedAt
    const positions = order.map(id => indexBody.indexOf(`TN-${id}`));
    assert.ok(positions.every(p => p >= 0), 'every ticket should appear in the index');
    assert.ok(positions[0] < positions[1] && positions[1] < positions[2],
      `expected order ${JSON.stringify(order)} but saw positions ${JSON.stringify(positions)}`);
  });

  it('is byte-identical on a re-ingest of the same XML', async () => {
    const xml = ticketsToXml([ticket(1), ticket(2)], { mode: 'full' });
    const w1 = makeWriter();
    const w2 = makeWriter();
    await ingestExtractXml({ xml, wiki: WIKI, writer: w1 });
    await ingestExtractXml({ xml, wiki: WIKI, writer: w2 });
    // Pages match
    const p1 = w1.calls.pages.map(p => [p.slug, p.content]).sort();
    const p2 = w2.calls.pages.map(p => [p.slug, p.content]).sort();
    assert.deepEqual(p1, p2);
    // Indices differ only on the generated "updated:" timestamp; strip it before comparing
    const stripTs = s => s.replace(/^updated: .*$/m, 'updated: <ts>');
    assert.equal(stripTs(w1.calls.index[0].content), stripTs(w2.calls.index[0].content));
  });
});

// ── Resilience ───────────────────────────────────────────────────────────────

describe('ingestExtractXml — resilience', () => {
  it('collects per-ticket write errors without aborting the batch', async () => {
    const xml = ticketsToXml([ticket(1), ticket(2), ticket(3)], { mode: 'full' });
    const writer = makeWriter({ failSlug: '2' });

    const summary = await ingestExtractXml({ xml, wiki: WIKI, writer });

    assert.equal(summary.written, 2);
    assert.equal(summary.failed, 1);
    assert.equal(summary.errors.length, 1);
    assert.equal(summary.errors[0].ticketId, '2');
    assert.match(summary.errors[0].reason, /simulated blob failure/);
    // Index still gets written even when a page fails
    assert.equal(writer.calls.index.length, 1);
  });

  it('propagates the skipped list from the extract envelope', async () => {
    const xml = ticketsToXml([ticket(1)], {
      mode: 'incremental',
      skipped: [{ ticketId: '999', reason: 'no customer article' }],
    });
    const writer = makeWriter();
    const summary = await ingestExtractXml({ xml, wiki: WIKI, writer });
    assert.equal(summary.total_skipped, 1);
    assert.equal(summary.skipped[0].ticketId, '999');
  });

  it('handles an empty envelope (still rewrites the index)', async () => {
    const xml = ticketsToXml([], { mode: 'full' });
    const writer = makeWriter();
    const summary = await ingestExtractXml({ xml, wiki: WIKI, writer });
    assert.equal(summary.total_extracted, 0);
    assert.equal(summary.written, 0);
    assert.equal(writer.calls.pages.length, 0);
    assert.equal(writer.calls.index.length, 1);
    assert.match(writer.calls.index[0].content, /No pages in this ingest/);
  });
});
