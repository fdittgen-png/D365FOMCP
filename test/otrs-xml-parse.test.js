/**
 * Tests for src/azure/otrs-xml-parse.js — the inverse of otrs-xml.js.
 * Proves that the serializer and parser round-trip losslessly for every
 * field shape in the envelope.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ticketsToXml } from '../src/azure/otrs-xml.js';
import { parseExtractXml } from '../src/azure/otrs-xml-parse.js';

const GENERATED_AT = '2026-04-17T12:00:00.000Z';

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
      { senderType: 'customer', from: 'u@x.com', createdAt: '2026-04-05 10:00:00', body: 'Original problem text.' },
      { senderType: 'agent',    from: 'a@x.com', createdAt: '2026-04-10 14:30:00', body: 'Step-by-step resolution.' },
    ],
    ...overrides,
  };
}

describe('parseExtractXml — validation', () => {
  it('rejects empty and non-string input', () => {
    assert.throws(() => parseExtractXml(''), /non-empty/);
    assert.throws(() => parseExtractXml(null), /non-empty/);
    assert.throws(() => parseExtractXml(undefined), /non-empty/);
  });

  it('rejects XML without an OtrsExtract root', () => {
    assert.throws(
      () => parseExtractXml('<?xml version="1.0"?><Other/>'),
      /does not contain an <OtrsExtract>/,
    );
  });
});

describe('parseExtractXml — round-trip', () => {
  it('recovers every attribute and CDATA content for a single ticket', () => {
    const original = fixture();
    const xml = ticketsToXml([original], { mode: 'incremental', generatedAt: GENERATED_AT });
    const parsed = parseExtractXml(xml);

    assert.equal(parsed.generatedAt, GENERATED_AT);
    assert.equal(parsed.mode, 'incremental');
    assert.equal(parsed.count, 1);
    assert.equal(parsed.skippedCount, 0);
    assert.equal(parsed.tickets.length, 1);

    const t = parsed.tickets[0];
    assert.equal(t.ticketId, original.ticketId);
    assert.equal(t.ticketNumber, original.ticketNumber);
    assert.equal(t.title, original.title);
    assert.equal(t.queue, original.queue);
    assert.equal(t.service, original.service);
    assert.equal(t.priority, original.priority);
    assert.equal(t.closedAt, original.closedAt);
    assert.equal(t.description, original.description);
    assert.equal(t.resolution, original.resolution);

    assert.equal(t.articles.length, 2);
    assert.equal(t.articles[0].senderType, 'customer');
    assert.equal(t.articles[0].body, original.articles[0].body);
    assert.equal(t.articles[1].senderType, 'agent');
    assert.equal(t.articles[1].body, original.articles[1].body);
  });

  it('handles multiple tickets', () => {
    const tickets = [fixture({ ticketId: '1' }), fixture({ ticketId: '2' }), fixture({ ticketId: '3' })];
    const xml = ticketsToXml(tickets, { generatedAt: GENERATED_AT });
    const parsed = parseExtractXml(xml);
    assert.equal(parsed.tickets.length, 3);
    assert.deepEqual(parsed.tickets.map(t => t.ticketId), ['1', '2', '3']);
  });

  it('preserves the skipped list', () => {
    const xml = ticketsToXml([fixture()], {
      generatedAt: GENERATED_AT,
      skipped: [
        { ticketId: '9001', reason: 'no customer article' },
        { ticketId: '9002', reason: 'resolution too thin' },
      ],
    });
    const parsed = parseExtractXml(xml);
    assert.equal(parsed.skippedCount, 2);
    assert.equal(parsed.skipped.length, 2);
    assert.deepEqual(parsed.skipped[0], { ticketId: '9001', reason: 'no customer article' });
  });

  it('preserves the ]]> split escape', () => {
    const tricky = 'see logs: foo]]>bar  — that should survive.';
    const xml = ticketsToXml([fixture({ description: tricky })], { generatedAt: GENERATED_AT });
    const parsed = parseExtractXml(xml);
    assert.equal(parsed.tickets[0].description, tricky);
  });

  it('returns an empty tickets array for an envelope with zero tickets', () => {
    const xml = ticketsToXml([], { generatedAt: GENERATED_AT, mode: 'full' });
    const parsed = parseExtractXml(xml);
    assert.equal(parsed.count, 0);
    assert.equal(parsed.tickets.length, 0);
    assert.equal(parsed.mode, 'full');
  });

  it('handles a ticket with no articles (future: extractor might omit them)', () => {
    const t = fixture();
    delete t.articles;
    const xml = ticketsToXml([t], { generatedAt: GENERATED_AT });
    const parsed = parseExtractXml(xml);
    assert.deepEqual(parsed.tickets[0].articles, []);
  });
});
