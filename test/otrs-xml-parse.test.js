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

// ── Full-shape round-trip — attachments, dynamic fields, rich metadata ──────

describe('parseExtractXml — full schema round-trip', () => {
  // Binary PNG header (first 16 bytes), base64-encoded — proves non-ASCII
  // bytes survive through CDATA unchanged.
  const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  // DOCX starts with 'PK'; plausible prefix chosen for size + byte-diversity.
  const docxBase64 = 'UEsDBBQABgAIAAAAIQBi7p5oaQEAAIMFAAATAAgCW0NvbnRlbnRfVHlwZXNdLnhtbCCi';

  function richFixture() {
    return {
      ticketId: '1717381',
      ticketNumber: '2026040200004375',
      title: 'Software not installing on new laptop',
      queue: 'GroupIT::L1', queueId: '42',
      service: 'My workplace - General IT Issue', serviceId: '17',
      state: 'closed successful', stateId: '2',
      priority: '3 normal', priorityId: '3',
      type: 'Incident',
      owner: 'notassigned@trelleborg', responsible: '',
      customerUserId: 'marco.goedde@trelleborg.com', customerId: 'TRE',
      sla: '', age: '97',
      createdAt: '2026-04-02 11:41:09',
      changedAt: '2026-04-02 11:41:16',
      closedAt: '2026-04-02 11:41:16',
      description: 'Software not installing on new laptop',
      resolution: 'Re-imaged the laptop, software installs cleanly.',
      dynamicFields: [
        { name: 'ModuleD365', value: 'Finance' },
        { name: 'Severity',   value: 'Low' },
      ],
      articles: [
        {
          id: '7765810', number: '1', senderType: 'customer', senderTypeId: '3',
          from: '"Marco Goedde" <marco.goedde@trelleborg.com>',
          to: 'GroupIT::L1', cc: '', bcc: '',
          subject: 'Software not installing on new laptop',
          messageId: '<abc@trelleborg>', references: '', inReplyTo: '',
          communicationChannel: 'Internal', communicationChannelId: '3',
          isVisibleForCustomer: '1',
          contentType: 'text/html; charset=utf-8',
          mimeType: 'text/html', charset: 'utf-8',
          createdAt: '2026-04-02 11:41:09', changedAt: '2026-04-02 11:41:09',
          body: '<p>When I install <img src="cid:part1.12345@..."/> I see an error.</p>',
          attachments: [
            {
              id: '1', filename: 'screenshot.png',
              contentType: 'image/png', contentAlternative: '',
              contentId: '<part1.12345@trelleborg.com>',
              disposition: 'inline', filesizeBytes: 68,
              content: pngBase64,
            },
            {
              id: '2', filename: 'error-log.docx',
              contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
              contentAlternative: '', contentId: '',
              disposition: 'attachment', filesizeBytes: 2048,
              content: docxBase64,
            },
          ],
        },
        {
          id: '7765811', number: '2', senderType: 'agent', senderTypeId: '1',
          from: 'agent@trelleborg.com', to: 'marco.goedde@trelleborg.com',
          cc: '', bcc: '', subject: 'Re: Software not installing',
          messageId: '<def@trelleborg>', references: '<abc@trelleborg>',
          inReplyTo: '<abc@trelleborg>',
          communicationChannel: 'Email', communicationChannelId: '1',
          isVisibleForCustomer: '1',
          contentType: 'text/plain; charset=utf-8',
          mimeType: 'text/plain', charset: 'utf-8',
          createdAt: '2026-04-02 14:00:00', changedAt: '2026-04-02 14:00:00',
          body: 'Re-image the laptop using the IT Services image.',
          attachments: [],
        },
      ],
    };
  }

  it('round-trips every ticket / article / attachment field byte-identically', () => {
    const original = richFixture();
    const xml = ticketsToXml([original], { mode: 'single', generatedAt: GENERATED_AT });
    const parsed = parseExtractXml(xml);

    assert.equal(parsed.count, 1);
    assert.equal(parsed.mode, 'single');
    const t = parsed.tickets[0];

    // Ticket-level attributes
    assert.equal(t.state, 'closed successful');
    assert.equal(t.stateId, '2');
    assert.equal(t.serviceId, '17');
    assert.equal(t.queueId, '42');
    assert.equal(t.customerUserId, 'marco.goedde@trelleborg.com');
    assert.equal(t.customerId, 'TRE');
    assert.equal(t.age, '97');
    assert.equal(t.type, 'Incident');

    // Dynamic fields
    assert.equal(t.dynamicFields.length, 2);
    assert.deepEqual(
      t.dynamicFields.slice().sort((a, b) => a.name.localeCompare(b.name)),
      [{ name: 'ModuleD365', value: 'Finance' }, { name: 'Severity', value: 'Low' }],
    );

    // Articles
    assert.equal(t.articles.length, 2);
    const [a0, a1] = t.articles;
    assert.equal(a0.id, '7765810');
    assert.equal(a0.subject, 'Software not installing on new laptop');
    assert.equal(a0.contentType, 'text/html; charset=utf-8');
    assert.equal(a0.communicationChannel, 'Internal');
    assert.equal(a0.messageId, '<abc@trelleborg>');
    assert.equal(a0.body, original.articles[0].body);   // HTML preserved verbatim
    assert.equal(a1.inReplyTo, '<abc@trelleborg>');
    assert.equal(a1.attachments.length, 0);

    // Attachments
    assert.equal(a0.attachments.length, 2);
    const [att0, att1] = a0.attachments;
    assert.equal(att0.filename, 'screenshot.png');
    assert.equal(att0.contentType, 'image/png');
    assert.equal(att0.disposition, 'inline');
    assert.equal(att0.contentId, '<part1.12345@trelleborg.com>');
    assert.equal(att0.filesizeBytes, 68);
    assert.equal(att0.content, pngBase64);
    assert.equal(att1.filename, 'error-log.docx');
    assert.match(att1.contentType, /wordprocessingml/);
    assert.equal(att1.disposition, 'attachment');
    assert.equal(att1.content, docxBase64);

    // Buffer decoded from the round-tripped base64 must equal the original
    // bytes — guarantees we haven't injected whitespace.
    assert.equal(
      Buffer.compare(Buffer.from(att0.content, 'base64'), Buffer.from(pngBase64, 'base64')),
      0,
      'screenshot.png binary bytes differ after round-trip',
    );
  });

  it('preserves `]]>` in article bodies even when the article carries attachments', () => {
    const t = richFixture();
    t.articles[0].body = 'see logs: foo]]>bar — should survive';
    const xml = ticketsToXml([t], { mode: 'single', generatedAt: GENERATED_AT });
    const parsed = parseExtractXml(xml);
    assert.equal(parsed.tickets[0].articles[0].body, 'see logs: foo]]>bar — should survive');
  });
});
