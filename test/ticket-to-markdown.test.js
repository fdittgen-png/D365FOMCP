/**
 * Tests for src/azure/ticket-to-markdown.js.
 *
 * Verifies structural contract:
 *   - slug derivation and sanitization
 *   - frontmatter has every expected field with correct types
 *   - H1 title matches the ticket title
 *   - Problem + Resolution sections appear when content is provided,
 *     and are omitted cleanly when missing
 *   - The optional article trace can be suppressed
 *   - Output parses through our own wiki frontmatter parser (no YAML drift)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ticketToMarkdown, slugFor } from '../src/azure/ticket-to-markdown.js';
import { parseMarkdown } from '../src/azure/wiki-storage.js';

function fixture(overrides = {}) {
  return {
    ticketId: '1721474',
    ticketNumber: 'TN-0042',
    title: 'Sales order post fails with NumberSeq error',
    queue: 'D365 Support',
    service: 'TIS - Digital Solutions Support::ERP::D365',
    priority: '3 normal',
    closedAt: '2026-04-10 14:33:00',
    description: 'When posting a sales order, the system throws "Number sequence is not set up".',
    resolution: 'Navigate to Sales & marketing parameters → Number sequences → assign a new reference.',
    articles: [
      { senderType: 'customer', from: 'u@x.com', createdAt: '2026-04-05 10:00:00', body: 'Original customer text.' },
      { senderType: 'agent',    from: 'a@x.com', createdAt: '2026-04-10 14:30:00', body: 'Full resolution transcript.' },
    ],
    ...overrides,
  };
}

describe('slugFor', () => {
  it('uses ticketId as the slug when it is a bare number', () => {
    assert.equal(slugFor({ ticketId: '1721474' }), '1721474');
  });

  it('strips unsafe characters', () => {
    assert.equal(slugFor({ ticketId: '../../etc/passwd' }), 'etcpasswd');
  });

  it('returns an empty string for a missing ticketId (caller must guard)', () => {
    assert.equal(slugFor({}), '');
  });
});

describe('ticketToMarkdown — structure', () => {
  it('throws when ticketId is missing', () => {
    assert.throws(() => ticketToMarkdown({}), /requires a ticket with ticketId/);
  });

  it('produces a slug matching the ticket ID', () => {
    const { slug } = ticketToMarkdown(fixture());
    assert.equal(slug, '1721474');
  });

  it('renders an H1 with the title', () => {
    const { markdown } = ticketToMarkdown(fixture());
    assert.match(markdown, /^# Sales order post fails with NumberSeq error$/m);
  });

  it('includes Problem and Resolution H2 sections when content is present', () => {
    const { markdown } = ticketToMarkdown(fixture());
    assert.match(markdown, /^## Problem$/m);
    assert.match(markdown, /^## Resolution$/m);
  });

  it('omits the Problem section when description is empty', () => {
    const { markdown } = ticketToMarkdown(fixture({ description: '' }));
    assert.doesNotMatch(markdown, /^## Problem$/m);
    assert.match(markdown, /^## Resolution$/m);
  });

  it('omits the Resolution section when resolution is empty', () => {
    const { markdown } = ticketToMarkdown(fixture({ resolution: '' }));
    assert.match(markdown, /^## Problem$/m);
    assert.doesNotMatch(markdown, /^## Resolution$/m);
  });

  it('includes the Full article trace by default', () => {
    const { markdown } = ticketToMarkdown(fixture());
    assert.match(markdown, /^## Full article trace$/m);
    assert.match(markdown, /^### customer · u@x\.com · 2026-04-05 10:00:00$/m);
  });

  it('suppresses the trace when includeArticles=false', () => {
    const { markdown } = ticketToMarkdown(fixture(), { includeArticles: false });
    assert.doesNotMatch(markdown, /Full article trace/);
  });
});

describe('ticketToMarkdown — frontmatter', () => {
  it('emits every expected frontmatter field', () => {
    const { markdown, frontmatter } = ticketToMarkdown(fixture());
    assert.equal(frontmatter.title, 'Sales order post fails with NumberSeq error');
    assert.equal(frontmatter.ticketId, '1721474');
    assert.equal(frontmatter.ticketNumber, 'TN-0042');
    assert.equal(frontmatter.service, 'TIS - Digital Solutions Support::ERP::D365');
    assert.equal(frontmatter.queue, 'D365 Support');
    assert.equal(frontmatter.priority, '3 normal');
    assert.equal(frontmatter.closedAt, '2026-04-10 14:33:00');
    assert.ok(Array.isArray(frontmatter.tags));
    assert.ok(typeof frontmatter.summary === 'string');
    // Markdown fence present
    assert.match(markdown, /^---\n/);
    assert.match(markdown, /\n---\n/);
  });

  it('the rendered frontmatter parses back through wiki-storage', () => {
    const { markdown } = ticketToMarkdown(fixture());
    const parsed = parseMarkdown(markdown);
    assert.equal(parsed.frontmatter.title, 'Sales order post fails with NumberSeq error');
    assert.equal(parsed.frontmatter.ticketId, '1721474');
    assert.ok(Array.isArray(parsed.frontmatter.tags));
  });

  it('derives tags from title + description, skipping stopwords', () => {
    const { frontmatter } = ticketToMarkdown(fixture({
      title: 'Purchase order posting fails on financial dimension validation',
      description: 'When posting a purchase order the system rejects the financial dimension.',
    }));
    // Stopwords ('error','issue','system','user','client') must be absent
    for (const stop of ['error', 'issue', 'system']) {
      assert.ok(!frontmatter.tags.includes(stop), `tag list should not include stopword "${stop}"`);
    }
    // Domain words survive
    assert.ok(frontmatter.tags.some(t => ['posting', 'financial', 'dimension', 'purchase'].includes(t)),
      `expected some of posting/financial/dimension/purchase in tags, got ${JSON.stringify(frontmatter.tags)}`);
  });

  it('derives summary from the description, truncated to 160 chars', () => {
    const longDesc = 'x'.repeat(500);
    const { frontmatter } = ticketToMarkdown(fixture({ description: longDesc }));
    assert.equal(frontmatter.summary.length, 160);
  });

  it('omits null-valued frontmatter fields so the YAML stays tidy', () => {
    const { markdown } = ticketToMarkdown(fixture({
      ticketNumber: '', queue: '', priority: '', closedAt: '',
    }));
    // The fields with nullish values should not appear as frontmatter keys
    assert.doesNotMatch(markdown, /^ticketNumber:/m);
    assert.doesNotMatch(markdown, /^queue:/m);
  });
});
