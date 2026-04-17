/**
 * Tests for src/azure/otrs-client.js.
 *
 * Covers:
 *   - readOtrsConfig: error surface for missing env vars, defaults
 *   - searchTickets / getTicket: mocked fetch, OTRS error-in-200 handling
 *   - validateTicket: every accept / reject rule
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  readOtrsConfig,
  searchTickets,
  getTicket,
  validateTicket,
} from '../src/azure/otrs-client.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function mockResp(json, { status = 200, statusText = 'OK' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    async json() { return json; },
    async text() { return typeof json === 'string' ? json : JSON.stringify(json); },
  };
}

/** Build a fetch that routes by URL prefix to a handler. Passes both
 *  the parsed body (for convenience) and the raw string (so tests can
 *  assert on type-sensitive serialization like integer vs. string). */
function routedFetch(routes) {
  return async (url, opts) => {
    const r = routes.find(x => url.startsWith(x.prefix));
    if (!r) throw new Error(`No mock for ${url}`);
    const raw = opts?.body || '';
    const body = raw ? JSON.parse(raw) : {};
    return r.respond(body, raw);
  };
}

const CFG_OK = {
  username: 'wstis',
  password: 'secret',
  searchUrl: 'https://otrs.example/TicketSearch',
  getUrl:    'https://otrs.example/TicketGet',
  serviceId: 798,
  state:     'closed successful',
  minResolutionChars: 200,
};

// ── readOtrsConfig ──────────────────────────────────────────────────────────

describe('readOtrsConfig', () => {
  it('returns parsed config with the 200-char default', () => {
    const cfg = readOtrsConfig({
      OTRS_USERNAME: 'u', OTRS_PASSWORD: 'p',
      OTRS_SEARCH_URL: 'https://s', OTRS_GET_URL: 'https://g',
      OTRS_SERVICE_ID: '798',
    });
    assert.equal(cfg.username, 'u');
    assert.equal(cfg.serviceId, 798);              // coerced to integer
    assert.equal(cfg.state, 'closed successful');  // default
    assert.equal(cfg.minResolutionChars, 200);     // default
  });

  it('honors OTRS_STATE and OTRS_MIN_RESOLUTION_CHARS overrides', () => {
    const cfg = readOtrsConfig({
      OTRS_USERNAME: 'u', OTRS_PASSWORD: 'p',
      OTRS_SEARCH_URL: 'https://s', OTRS_GET_URL: 'https://g',
      OTRS_SERVICE_ID: '42',
      OTRS_STATE: 'closed with workaround',
      OTRS_MIN_RESOLUTION_CHARS: '500',
    });
    assert.equal(cfg.state, 'closed with workaround');
    assert.equal(cfg.minResolutionChars, 500);
  });

  it('throws a single error listing every missing required field', () => {
    assert.throws(
      () => readOtrsConfig({}),
      /OTRS_USERNAME.*OTRS_PASSWORD.*OTRS_SEARCH_URL.*OTRS_GET_URL.*OTRS_SERVICE_ID/,
    );
  });

  it('rejects a non-numeric OTRS_SERVICE_ID by treating it as missing', () => {
    assert.throws(
      () => readOtrsConfig({
        OTRS_USERNAME: 'u', OTRS_PASSWORD: 'p',
        OTRS_SEARCH_URL: 'https://s', OTRS_GET_URL: 'https://g',
        OTRS_SERVICE_ID: 'TIS - not a number',
      }),
      /OTRS_SERVICE_ID/,
    );
  });

  it('rejects zero / negative OTRS_SERVICE_ID (positive integer required)', () => {
    assert.throws(
      () => readOtrsConfig({
        OTRS_USERNAME: 'u', OTRS_PASSWORD: 'p',
        OTRS_SEARCH_URL: 'https://s', OTRS_GET_URL: 'https://g',
        OTRS_SERVICE_ID: '0',
      }),
      /OTRS_SERVICE_ID/,
    );
  });
});

// ── searchTickets ────────────────────────────────────────────────────────────

describe('searchTickets', () => {
  it('POSTs the configured payload and returns string IDs', async () => {
    let captured = null;
    let capturedRaw = null;
    const fetch = routedFetch([{
      prefix: CFG_OK.searchUrl,
      respond: (body, raw) => {
        captured = body;
        capturedRaw = raw;
        return mockResp({ TicketID: [1721474, 1720411, 1720242] });
      },
    }]);
    const ids = await searchTickets({ fetch, cfg: CFG_OK });
    assert.deepEqual(captured, {
      UserLogin: 'wstis',
      Password: 'secret',
      ServiceID: 798,
      State: 'closed successful',
    });
    // ServiceID must be serialized as a JSON number literal, not a string —
    // OTRS rejects stringified integers for this field with a generic
    // "Authorization failing" error.
    assert.match(capturedRaw, /"ServiceID":\s*798[^"]/);
    assert.deepEqual(ids, ['1721474', '1720411', '1720242']);
  });

  it('returns empty array when TicketID is absent', async () => {
    const fetch = routedFetch([{ prefix: CFG_OK.searchUrl, respond: () => mockResp({}) }]);
    assert.deepEqual(await searchTickets({ fetch, cfg: CFG_OK }), []);
  });

  it('wraps a single-ID scalar response in an array', async () => {
    const fetch = routedFetch([{ prefix: CFG_OK.searchUrl, respond: () => mockResp({ TicketID: 42 }) }]);
    assert.deepEqual(await searchTickets({ fetch, cfg: CFG_OK }), ['42']);
  });

  it('raises on HTTP error', async () => {
    const fetch = routedFetch([{
      prefix: CFG_OK.searchUrl,
      respond: () => mockResp('upstream down', { status: 502, statusText: 'Bad Gateway' }),
    }]);
    await assert.rejects(() => searchTickets({ fetch, cfg: CFG_OK }), /HTTP 502/);
  });

  it('raises on OTRS in-band error (HTTP 200 + Error body)', async () => {
    const fetch = routedFetch([{
      prefix: CFG_OK.searchUrl,
      respond: () => mockResp({ Error: { ErrorCode: 'WebserviceNotAuth', ErrorMessage: 'Bad creds' } }),
    }]);
    await assert.rejects(() => searchTickets({ fetch, cfg: CFG_OK }), /WebserviceNotAuth.*Bad creds/);
  });
});

// ── getTicket ────────────────────────────────────────────────────────────────

describe('getTicket', () => {
  it('POSTs TicketID + AllArticles=1 and returns first ticket', async () => {
    let captured = null;
    const fetch = routedFetch([{
      prefix: CFG_OK.getUrl,
      respond: (body) => {
        captured = body;
        return mockResp({ Ticket: [{ TicketID: '123', Title: 'hi' }] });
      },
    }]);
    const t = await getTicket('123', { fetch, cfg: CFG_OK });
    assert.equal(captured.TicketID, '123');
    assert.equal(captured.AllArticles, 1);
    assert.equal(t.Title, 'hi');
  });

  it('unwraps a single-object Ticket payload', async () => {
    const fetch = routedFetch([{
      prefix: CFG_OK.getUrl,
      respond: () => mockResp({ Ticket: { TicketID: '77', Title: 'solo' } }),
    }]);
    const t = await getTicket('77', { fetch, cfg: CFG_OK });
    assert.equal(t.Title, 'solo');
  });

  it('throws when the response has no Ticket', async () => {
    const fetch = routedFetch([{ prefix: CFG_OK.getUrl, respond: () => mockResp({}) }]);
    await assert.rejects(() => getTicket('42', { fetch, cfg: CFG_OK }), /no ticket for ID 42/);
  });
});

// ── validateTicket ───────────────────────────────────────────────────────────

const longBody = 'x'.repeat(250);
const shortBody = 'fixed it';

describe('validateTicket', () => {
  it('passes a ticket with a customer description and a long agent resolution', () => {
    const ticket = {
      State: 'closed successful',
      Article: [
        { SenderType: 'customer', Body: 'System crashed when I clicked Save.' },
        { SenderType: 'agent',    Body: longBody },
      ],
    };
    const v = validateTicket(ticket);
    assert.equal(v.ok, true);
    assert.ok(v.description.startsWith('System crashed'));
    assert.equal(v.resolution, longBody);
    assert.equal(v.articles.length, 2);
  });

  it('joins multiple agent articles chronologically', () => {
    const ticket = {
      State: 'closed successful',
      Article: [
        { SenderType: 'customer', Body: 'broken' },
        { SenderType: 'agent',    Body: 'step 1: ' + 'a'.repeat(150) },
        { SenderType: 'agent',    Body: 'step 2: ' + 'b'.repeat(150) },
      ],
    };
    const v = validateTicket(ticket);
    assert.equal(v.ok, true);
    assert.match(v.resolution, /step 1:/);
    assert.match(v.resolution, /step 2:/);
    assert.match(v.resolution, /---/);
  });

  it('rejects a ticket in a non-closed state', () => {
    const ticket = {
      State: 'open',
      Article: [
        { SenderType: 'customer', Body: 'hi' },
        { SenderType: 'agent',    Body: longBody },
      ],
    };
    const v = validateTicket(ticket);
    assert.equal(v.ok, false);
    assert.match(v.reason, /state.*open/);
  });

  it('rejects a ticket with no articles', () => {
    const v = validateTicket({ State: 'closed successful' });
    assert.equal(v.ok, false);
    assert.match(v.reason, /no articles/);
  });

  it('rejects when there is no customer article', () => {
    const v = validateTicket({
      State: 'closed successful',
      Article: [{ SenderType: 'agent', Body: longBody }],
    });
    assert.equal(v.ok, false);
    assert.match(v.reason, /description missing/);
  });

  it('rejects when the customer body is whitespace only', () => {
    const v = validateTicket({
      State: 'closed successful',
      Article: [
        { SenderType: 'customer', Body: '   \n\n  ' },
        { SenderType: 'agent',    Body: longBody },
      ],
    });
    assert.equal(v.ok, false);
    assert.match(v.reason, /description missing/);
  });

  it('rejects when the combined agent body is below the threshold', () => {
    const v = validateTicket({
      State: 'closed successful',
      Article: [
        { SenderType: 'customer', Body: 'bug' },
        { SenderType: 'agent',    Body: shortBody },
      ],
    });
    assert.equal(v.ok, false);
    assert.match(v.reason, /resolution too thin/);
  });

  it('honors a custom minResolutionChars', () => {
    const ticket = {
      State: 'closed successful',
      Article: [
        { SenderType: 'customer', Body: 'bug' },
        { SenderType: 'agent',    Body: 'a'.repeat(50) },
      ],
    };
    assert.equal(validateTicket(ticket, { minResolutionChars: 40 }).ok, true);
    assert.equal(validateTicket(ticket, { minResolutionChars: 500 }).ok, false);
  });

  it('tolerates missing State (falls through to article checks)', () => {
    const v = validateTicket({
      Article: [
        { SenderType: 'customer', Body: 'bug' },
        { SenderType: 'agent',    Body: longBody },
      ],
    });
    assert.equal(v.ok, true);
  });
});
