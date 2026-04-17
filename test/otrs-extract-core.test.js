/**
 * Tests for src/azure/otrs-extract-core.js — the pure orchestration
 * function behind the otrs-extract Azure Function. Uses an in-memory
 * fetch mock so no network / blob storage is required.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runExtract } from '../src/azure/otrs-extract-core.js';

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
