/**
 * Tests for src/azure/otrs-xml.js.
 *
 * Verifies that the XML envelope is well-formed, CDATA escaping is correct
 * for the one forbidden sequence (`]]>`), skipped tickets appear inline,
 * and a round-trip through fast-xml-parser preserves the field values.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { XMLParser } from 'fast-xml-parser';

import { ticketsToXml } from '../src/azure/otrs-xml.js';

const GENERATED_AT = '2026-04-17T12:00:00.000Z';

function fixtureTicket(overrides = {}) {
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
      { senderType: 'customer', from: 'user@trelleborg.com', createdAt: '2026-04-05 10:00:00', body: 'Original problem text.' },
      { senderType: 'agent',    from: 'agent@trelleborg.com', createdAt: '2026-04-10 14:30:00', body: 'Step by step resolution text.' },
    ],
    ...overrides,
  };
}

describe('ticketsToXml — envelope', () => {
  it('emits an XML declaration and root element with attributes', () => {
    const xml = ticketsToXml([fixtureTicket()], { mode: 'incremental', generatedAt: GENERATED_AT });
    assert.match(xml, /^<\?xml version="1\.0" encoding="utf-8"\?>\n/);
    assert.match(xml, /<OtrsExtract\s[^>]*generatedAt="2026-04-17T12:00:00\.000Z"/);
    assert.match(xml, /mode="incremental"/);
    assert.match(xml, /count="1"/);
  });

  it('sets count="0" and skipped block when only skipped are supplied', () => {
    const xml = ticketsToXml([], {
      mode: 'incremental',
      generatedAt: GENERATED_AT,
      skipped: [{ ticketId: '999', reason: 'no customer article' }],
    });
    assert.match(xml, /count="0"/);
    assert.match(xml, /skippedCount="1"/);
    assert.match(xml, /<Skipped>/);
    assert.match(xml, /id="999"/);
    assert.match(xml, /reason="no customer article"/);
  });

  it('omits the Skipped block when nothing was skipped', () => {
    const xml = ticketsToXml([fixtureTicket()], { mode: 'full', generatedAt: GENERATED_AT });
    assert.doesNotMatch(xml, /<Skipped>/);
    assert.match(xml, /skippedCount="0"/);
  });
});

describe('ticketsToXml — CDATA escaping', () => {
  it('wraps description and resolution in CDATA', () => {
    const xml = ticketsToXml([fixtureTicket({
      description: 'HTML: <b>bold</b> & <script>alert()</script>',
    })], { generatedAt: GENERATED_AT });
    // The pretty-printer puts the CDATA block on its own indented line, so
    // match with `[\s\S]*?` across the whitespace between the opening tag
    // and the terminator rather than insisting on a single-line layout.
    assert.match(xml, /<Description>[\s\S]*?<!\[CDATA\[HTML: <b>bold<\/b> & <script>alert\(\)<\/script>]]>[\s\S]*?<\/Description>/);
  });

  it('escapes the forbidden CDATA terminator ]]>', () => {
    const nasty = 'see logs: foo]]>bar';
    const xml = ticketsToXml([fixtureTicket({ description: nasty })], { generatedAt: GENERATED_AT });
    // The string ']]>' inside the value must NOT appear except as the CDATA terminator(s).
    // The escaping splits it into ']]]]><![CDATA[>', which produces two adjacent CDATA
    // sections. Ensure the pattern shows up exactly once per occurrence.
    assert.match(xml, /foo]]]]><!\[CDATA\[>bar/);
  });
});

describe('ticketsToXml — round trip', () => {
  it('preserves attributes and CDATA contents when parsed back', () => {
    const t = fixtureTicket();
    const xml = ticketsToXml([t], { mode: 'full', generatedAt: GENERATED_AT });

    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      cdataPropName: '__cdata',
      parseAttributeValue: false,
    });
    const parsed = parser.parse(xml);

    const root = parsed.OtrsExtract;
    assert.equal(root['@_mode'], 'full');
    assert.equal(root['@_count'], '1');

    const ticket = root.Ticket;
    assert.equal(ticket['@_id'], t.ticketId);
    assert.equal(ticket['@_title'], t.title);
    assert.equal(ticket['@_closedAt'], t.closedAt);

    // CDATA is returned under the `__cdata` key by the parser
    assert.equal(ticket.Description.__cdata, t.description);
    assert.equal(ticket.Resolution.__cdata, t.resolution);

    const articles = Array.isArray(ticket.Articles.Article) ? ticket.Articles.Article : [ticket.Articles.Article];
    assert.equal(articles.length, 2);
    assert.equal(articles[0]['@_sender'], 'customer');
    assert.equal(articles[0].__cdata, t.articles[0].body);
    assert.equal(articles[1]['@_sender'], 'agent');
    assert.equal(articles[1].__cdata, t.articles[1].body);
  });
});
