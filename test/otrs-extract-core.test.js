/**
 * Tests for src/azure/otrs-extract-core.js — the pure orchestration
 * function behind the otrs-extract Azure Function. Uses an in-memory
 * fetch mock so no network / blob storage is required.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runExtract, toExtractedTicket } from '../src/azure/otrs-extract-core.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const CFG = {
  username: 'u', password: 'p',
  searchUrl: 'https://otrs.example/TicketSearch',
  getUrl:    'https://otrs.example/TicketGet',
  service:   'svc', state: 'closed successful',
  minResolutionChars: 200,
};

const LONG = 'x'.repeat(250);

/** Build a fetch that serves search + per-ticket get from in-memory maps. */
function makeFetch({ searchIds, tickets, getFailures = {} }) {
  return async (url, opts) => {
    const body = opts?.body ? JSON.parse(opts.body) : {};
    if (url.startsWith(CFG.searchUrl)) {
      return resp({ TicketID: searchIds });
    }
    if (url.startsWith(CFG.getUrl)) {
      const id = String(body.TicketID);
      if (getFailures[id]) return resp(getFailures[id], { status: 500 });
      if (!(id in tickets)) return resp({ Error: { ErrorCode: 'NotFound' } });
      return resp({ Ticket: [tickets[id]] });
    }
    throw new Error(`Unrouted URL ${url}`);
  };
}

function resp(json, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status, statusText: status === 200 ? 'OK' : 'Error',
    async json() { return json; },
    async text() { return typeof json === 'string' ? json : JSON.stringify(json); },
  };
}

const validTicket = (id) => ({
  TicketID: id,
  State: 'closed successful',
  Title: `Problem ${id}`,
  Article: [
    { SenderType: 'customer', Body: `description ${id}` },
    { SenderType: 'agent',    Body: LONG },
  ],
});

const thinTicket = (id) => ({
  TicketID: id,
  State: 'closed successful',
  Article: [
    { SenderType: 'customer', Body: `description ${id}` },
    { SenderType: 'agent',    Body: 'fixed it' }, // too short
  ],
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('runExtract — incremental mode', () => {
  it('returns only unknown tickets, skips already-processed IDs', async () => {
    const fetch = makeFetch({
      searchIds: ['100', '101', '102'],
      tickets: {
        100: validTicket('100'),
        101: validTicket('101'),
        102: validTicket('102'),
      },
    });
    const result = await runExtract({
      mode: 'incremental',
      cfg: CFG,
      state: { processedTicketIds: ['100'] },
      fetch,
    });
    assert.equal(result.candidateIds.length, 2);
    assert.deepEqual(result.extracted.map(t => t.ticketId).sort(), ['101', '102']);
    assert.equal(result.skipped.length, 0);
  });

  it('returns empty batch when everything is already known', async () => {
    const fetch = makeFetch({ searchIds: ['1', '2'], tickets: {} });
    const result = await runExtract({
      cfg: CFG,
      state: { processedTicketIds: ['1', '2'] },
      fetch,
    });
    assert.equal(result.candidateIds.length, 0);
    assert.equal(result.extracted.length, 0);
  });
});

describe('runExtract — full mode', () => {
  it('ignores state and returns every ticket that passes validation', async () => {
    const fetch = makeFetch({
      searchIds: ['1', '2', '3'],
      tickets: {
        1: validTicket('1'),
        2: validTicket('2'),
        3: validTicket('3'),
      },
    });
    const result = await runExtract({
      mode: 'full',
      cfg: CFG,
      state: { processedTicketIds: ['1', '2', '3'] }, // all known, but full mode ignores
      fetch,
    });
    assert.equal(result.extracted.length, 3);
  });
});

describe('runExtract — validation + failures', () => {
  it('puts tickets that fail validation into skipped with a reason', async () => {
    const fetch = makeFetch({
      searchIds: ['1', '2'],
      tickets: { 1: validTicket('1'), 2: thinTicket('2') },
    });
    const result = await runExtract({
      cfg: CFG, state: { processedTicketIds: [] }, fetch,
    });
    assert.equal(result.extracted.length, 1);
    assert.equal(result.extracted[0].ticketId, '1');
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0].ticketId, '2');
    assert.match(result.skipped[0].reason, /resolution too thin/);
  });

  it('catches per-ticket fetch errors and keeps processing the rest', async () => {
    const fetch = makeFetch({
      searchIds: ['1', '2', '3'],
      tickets: { 1: validTicket('1'), 3: validTicket('3') },
      getFailures: { 2: 'upstream blew up' },
    });
    const result = await runExtract({
      cfg: CFG, state: { processedTicketIds: [] }, fetch,
    });
    assert.equal(result.extracted.length, 2);
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0].ticketId, '2');
    assert.match(result.skipped[0].reason, /fetch error/);
  });
});

describe('runExtract — limit', () => {
  it('caps the number of tickets fetched per run', async () => {
    const ids = ['10', '11', '12', '13', '14'];
    const tickets = Object.fromEntries(ids.map(id => [id, validTicket(id)]));
    const fetch = makeFetch({ searchIds: ids, tickets });
    const result = await runExtract({
      mode: 'full', limit: 2, cfg: CFG,
      state: { processedTicketIds: [] }, fetch,
    });
    assert.equal(result.candidateIds.length, 2);
    assert.equal(result.extracted.length, 2);
  });
});

// ── toExtractedTicket direct mapping (single-ticket path) ────────────────────

describe('toExtractedTicket — single-ticket full mapping', () => {
  it('maps every ticket / article / attachment field without needing a validation result', () => {
    const raw = {
      TicketID: 1717381,
      TicketNumber: '2026040200004375',
      Title: 'Software not installing',
      Queue: 'GroupIT::L1', QueueID: 42,
      Service: 'My workplace - General IT Issue', ServiceID: 17,
      State: 'closed successful', StateID: 2,
      Priority: '3 normal', PriorityID: 3,
      Type: 'Incident',
      Owner: 'notassigned', Responsible: '',
      CustomerUserID: 'marco@trelleborg.com', CustomerID: 'TRE',
      SLA: '', Age: 97,
      Created: '2026-04-02 11:41:09',
      Changed: '2026-04-02 11:41:16',
      Closed: '2026-04-02 11:41:16',
      DynamicField: [
        { Name: 'ModuleD365', Value: 'Finance' },
        { Name: 'Severity',   Value: null }, // null → mapped to empty string
      ],
      Article: [
        {
          ArticleID: 7765810, ArticleNumber: 1,
          SenderType: 'customer', SenderTypeID: 3,
          From: '"Marco" <marco@x>', To: 'GroupIT::L1', Cc: '', Bcc: '',
          Subject: 'Install fails',
          MessageID: '<abc@x>', References: '', InReplyTo: '',
          CommunicationChannel: 'Internal', CommunicationChannelID: 3,
          IsVisibleForCustomer: 1,
          ContentType: 'text/html; charset=utf-8',
          MimeType: 'text/html', Charset: 'utf-8',
          CreateTime: '2026-04-02 11:41:09', ChangeTime: '2026-04-02 11:41:09',
          Body: '<p>screenshot here</p>',
          Attachment: [
            {
              Filename: 'shot.png', ContentType: 'image/png',
              ContentID: '<part1@x>', Disposition: 'inline',
              FilesizeRaw: 2048, Filesize: '2 KB',
              Content: 'AAAA', // tiny base64 smoke-test
            },
          ],
        },
        {
          ArticleID: 7765811, ArticleNumber: 2,
          SenderType: 'agent', SenderTypeID: 1,
          From: 'agent@x', Subject: 'Re: Install fails',
          CreateTime: '2026-04-02 14:00:00',
          Body: 'Re-image the device. Steps: 1. boot USB. 2. install image.',
        },
      ],
    };
    const t = toExtractedTicket('1717381', raw);

    // Ticket-level fields
    assert.equal(t.ticketId, '1717381');
    assert.equal(t.ticketNumber, '2026040200004375');
    assert.equal(t.state, 'closed successful');
    assert.equal(t.stateId, '2');
    assert.equal(t.serviceId, '17');
    assert.equal(t.customerUserId, 'marco@trelleborg.com');
    assert.equal(t.age, '97');

    // description + resolution derived from articles
    assert.match(t.description, /screenshot here/);   // customer body
    assert.match(t.resolution, /Re-image/);            // agent body

    // Dynamic fields
    assert.equal(t.dynamicFields.length, 2);
    assert.equal(t.dynamicFields[0].name, 'ModuleD365');
    assert.equal(t.dynamicFields[0].value, 'Finance');
    assert.equal(t.dynamicFields[1].value, '');  // null normalized

    // Articles + attachments
    assert.equal(t.articles.length, 2);
    assert.equal(t.articles[0].contentType, 'text/html; charset=utf-8');
    assert.equal(t.articles[0].messageId, '<abc@x>');
    assert.equal(t.articles[0].attachments.length, 1);
    assert.equal(t.articles[0].attachments[0].filename, 'shot.png');
    assert.equal(t.articles[0].attachments[0].disposition, 'inline');
    assert.equal(t.articles[0].attachments[0].filesizeBytes, 2048);
    assert.equal(t.articles[0].attachments[0].content, 'AAAA');
    assert.equal(t.articles[1].attachments.length, 0);
  });

  it('gracefully handles a minimal ticket with no articles / attachments / dynamic fields', () => {
    const raw = { TicketID: 1, Title: 't' };
    const t = toExtractedTicket('1', raw);
    assert.equal(t.articles.length, 0);
    assert.equal(t.dynamicFields.length, 0);
    assert.equal(t.description, '');
    assert.equal(t.resolution, '');
  });

  it('honors an explicit validation result when provided (batch-extract path)', () => {
    const raw = {
      TicketID: 1,
      Article: [
        { SenderType: 'customer', Body: 'raw desc' },
        { SenderType: 'agent', Body: 'raw resolution' },
      ],
    };
    const v = { description: 'validator-supplied desc', resolution: 'validator-supplied resolution' };
    const t = toExtractedTicket('1', raw, v);
    assert.equal(t.description, 'validator-supplied desc');
    assert.equal(t.resolution, 'validator-supplied resolution');
  });
});
