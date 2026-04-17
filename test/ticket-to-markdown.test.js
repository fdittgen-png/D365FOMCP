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

// ── Attachments + dynamic fields sections ───────────────────────────────────

describe('ticketToMarkdown — attachments and dynamic fields', () => {
  function fixtureWithExtras(overrides = {}) {
    return {
      ticketId: '1717381',
      ticketNumber: '2026040200004375',
      title: 'Software not installing on new laptop',
      service: 'My workplace - General IT Issue',
      priority: '3 normal',
      closedAt: '2026-04-02 11:41:16',
      description: 'Install fails.',
      resolution: 'Re-imaged the laptop.',
      dynamicFields: [
        { name: 'ModuleD365', value: 'Finance' },
        { name: 'Severity',   value: 'Low' },
        { name: 'EmptyField', value: '' },
      ],
      articles: [
        {
          id: '1', number: '1', senderType: 'customer', from: 'u@x',
          createdAt: '2026-04-02 11:41:09', subject: 'Install fails',
          body: '<p>screenshot attached</p>',
          contentType: 'text/html; charset=utf-8',
          attachments: [
            { id: '1', filename: 'screen.png', contentType: 'image/png', disposition: 'inline', filesizeBytes: 2048, content: '...' },
            { id: '2', filename: 'log.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', disposition: 'attachment', filesizeBytes: 45678, content: '...' },
          ],
        },
        {
          id: '2', number: '2', senderType: 'agent', from: 'a@x',
          createdAt: '2026-04-02 14:00:00', body: 'Re-image the device.',
          attachments: [],
        },
      ],
      ...overrides,
    };
  }

  it('adds an "Attachments" table enumerating filename / type / size / disposition', () => {
    const { markdown } = ticketToMarkdown(fixtureWithExtras());
    assert.match(markdown, /^## Attachments \(2\)$/m);
    assert.match(markdown, /screen\.png/);
    assert.match(markdown, /image\/png/);
    assert.match(markdown, /2\.0 KB/);            // 2048 bytes → "2.0 KB"
    assert.match(markdown, /inline/);
    assert.match(markdown, /log\.docx/);
    assert.match(markdown, /44\.6 KB/);           // 45678 bytes → "44.6 KB"
    assert.match(markdown, /attachment/);
    // Raw bytes explicitly NOT inlined — only the note that they live in XML
    assert.match(markdown, /preserved in the source XML/);
  });

  it('skips the attachments section entirely when no article carries any', () => {
    const { markdown } = ticketToMarkdown(fixtureWithExtras({
      articles: [
        { id: '1', number: '1', senderType: 'customer', body: 'no files here', attachments: [] },
      ],
    }));
    assert.doesNotMatch(markdown, /## Attachments/);
  });

  it('adds a "Dynamic fields" table that skips empty values', () => {
    const { markdown } = ticketToMarkdown(fixtureWithExtras());
    assert.match(markdown, /^## Dynamic fields$/m);
    assert.match(markdown, /ModuleD365/);
    assert.match(markdown, /Finance/);
    assert.match(markdown, /Severity/);
    assert.doesNotMatch(markdown, /EmptyField/);    // empty value filtered out
  });

  it('article-trace section lists per-article attachment filenames', () => {
    const { markdown } = ticketToMarkdown(fixtureWithExtras());
    // The label is wrapped in italics (`_..._`) so the literal output is
    // `_Attachments on this article:_ screen.png, log.docx`.
    assert.match(markdown, /Attachments on this article:_?\s+screen\.png,\s*log\.docx/);
  });
});
