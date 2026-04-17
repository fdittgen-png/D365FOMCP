/**
 * Tests for src/azure/otrs-xml-split.js — splits a multi-ticket extract
 * envelope into one valid OtrsExtract-with-count-1 file per ticket.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ticketsToXml } from '../src/azure/otrs-xml.js';
import { parseExtractXml } from '../src/azure/otrs-xml-parse.js';
import { splitExtractPerTicket } from '../src/azure/otrs-xml-split.js';

function ticket(id, overrides = {}) {
  return {
    ticketId: String(id),
    ticketNumber: `TN-${id}`,
    title: `Title for ${id}`,
    queue: '', queueId: '',
    service: 'svc', serviceId: '',
    state: 'closed successful', stateId: '',
    priority: '', priorityId: '',
    type: '', owner: '', responsible: '',
    customerUserId: '', customerId: '',
    sla: '', age: '',
    createdAt: '2026-04-10 10:00:00',
    changedAt: '2026-04-15 14:00:00',
    closedAt: '2026-04-15 14:00:00',
    description: `desc ${id}`,
    resolution: `res ${id}`,
    dynamicFields: [],
    articles: [
      { id: '1', number: '1', senderType: 'customer', body: `problem ${id}`,
        attachments: [], contentType: 'text/plain', charset: 'utf-8' },
    ],
    ...overrides,
  };
}

describe('splitExtractPerTicket — happy path', () => {
  it('returns one entry per ticket with <ticketNumber>-<title>.xml filenames', () => {
    const xml = ticketsToXml([ticket('A'), ticket('B'), ticket('C')], { mode: 'full' });
    const parts = splitExtractPerTicket(xml);
    assert.equal(parts.length, 3);
    assert.deepEqual(parts.map(p => p.filename).sort(), [
      'TN-A-Title for A.xml',
      'TN-B-Title for B.xml',
      'TN-C-Title for C.xml',
    ]);
  });

  it('each part is itself a valid OtrsExtract with count="1" and the right ticket', () => {
    const xml = ticketsToXml([ticket('X', { title: 'Specific' }), ticket('Y')], { mode: 'incremental' });
    const parts = splitExtractPerTicket(xml);
    const xParsed = parseExtractXml(parts[0].buffer.toString('utf8'));
    assert.equal(xParsed.count, 1);
    assert.equal(xParsed.mode, 'incremental');
    assert.equal(xParsed.tickets.length, 1);
    assert.equal(xParsed.tickets[0].ticketId, 'X');
    assert.equal(xParsed.tickets[0].title, 'Specific');
  });

  it('preserves the original envelope generatedAt so per-file provenance is stable', () => {
    const xml = ticketsToXml([ticket('1')], { mode: 'full', generatedAt: '2026-04-17T12:00:00.000Z' });
    const parts = splitExtractPerTicket(xml);
    const p = parseExtractXml(parts[0].buffer.toString('utf8'));
    assert.equal(p.generatedAt, '2026-04-17T12:00:00.000Z');
  });

  it('returns per-ticket metadata so callers can build manifests without re-parsing', () => {
    const xml = ticketsToXml([ticket('Z')], { mode: 'full' });
    const [p] = splitExtractPerTicket(xml);
    assert.equal(p.ticketId, 'Z');
    assert.equal(p.ticketNumber, 'TN-Z');
    assert.equal(p.title, 'Title for Z');
  });
});

describe('splitExtractPerTicket — edge cases', () => {
  it('returns an empty array for an envelope with no tickets', () => {
    const xml = ticketsToXml([], { mode: 'full' });
    assert.deepEqual(splitExtractPerTicket(xml), []);
  });

  it('disambiguates duplicate filenames by appending the ticketId', () => {
    // Two tickets with the same ticketNumber + title — rare but survives.
    const xml = ticketsToXml([
      ticket('1', { ticketNumber: 'SAME', title: 'SAME' }),
      ticket('2', { ticketNumber: 'SAME', title: 'SAME' }),
    ], { mode: 'full' });
    const parts = splitExtractPerTicket(xml);
    const names = parts.map(p => p.filename);
    assert.equal(names.length, 2);
    assert.equal(new Set(names).size, 2, 'filenames should be unique');
    assert.ok(names[0] === 'SAME-SAME.xml' || names[1] === 'SAME-SAME.xml');
    assert.ok(names.some(n => /^SAME-SAME-2?\.xml$/.test(n) || /-2\.xml$/.test(n)));
  });

  it('falls back to ticketId-only names when ticketNumber+title are empty', () => {
    const xml = ticketsToXml([ticket('9999', { ticketNumber: '', title: '' })], { mode: 'full' });
    const [p] = splitExtractPerTicket(xml);
    assert.equal(p.filename, '9999.xml');
  });
});
