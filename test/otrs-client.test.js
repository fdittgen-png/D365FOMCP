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
  OtrsRequestError,
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

// ── OtrsRequestError structured fields ───────────────────────────────────────

describe('OtrsRequestError — structured context on failure', () => {
  async function captureError(fn) {
    try { await fn(); }
    catch (e) { return e; }
    throw new Error('expected function to throw');
  }

  it('on OTRS in-band error (auth fail style), carries phase, url, otrsErrorCode, redacted password, and elapsed', async () => {
    const fetch = routedFetch([{
      prefix: CFG_OK.searchUrl,
      respond: () => mockResp({ Error: { ErrorCode: 'TicketSearch.AuthFail', ErrorMessage: 'TicketSearch: Authorization failing!' } }),
    }]);
    const err = await captureError(() => searchTickets({ fetch, cfg: CFG_OK }));

    assert.ok(err instanceof OtrsRequestError);
    assert.equal(err.category, 'otrs-error');
    assert.equal(err.phase, 'TicketSearch');
    assert.equal(err.url, CFG_OK.searchUrl);
    assert.equal(err.httpStatus, 200);
    assert.equal(err.otrsErrorCode, 'TicketSearch.AuthFail');
    assert.match(err.otrsErrorMessage, /Authorization failing/);
    assert.ok(typeof err.elapsedMs === 'number' && err.elapsedMs >= 0);
    assert.ok(typeof err.timestamp === 'string');
    assert.match(err.responseBody, /AuthFail/);

    // Password must never leak through the error surface.
    assert.equal(err.requestBodyRedacted.Password, '***');
    assert.equal(err.requestBodyRedacted.UserLogin, 'wstis');
    assert.equal(err.requestBodyRedacted.ServiceID, 798);
  });

  it('on HTTP error, carries httpStatus, httpStatusText, responseBody (truncated)', async () => {
    const longBody = 'upstream down '.repeat(500);
    const fetch = routedFetch([{
      prefix: CFG_OK.searchUrl,
      respond: () => mockResp(longBody, { status: 502, statusText: 'Bad Gateway' }),
    }]);
    const err = await captureError(() => searchTickets({ fetch, cfg: CFG_OK }));

    assert.ok(err instanceof OtrsRequestError);
    assert.equal(err.category, 'http-error');
    assert.equal(err.httpStatus, 502);
    assert.equal(err.httpStatusText, 'Bad Gateway');
    assert.match(err.responseBody, /upstream down/);
    assert.match(err.responseBody, /truncated/);  // long body got the truncation marker
  });

  it('on non-JSON response, categorizes as parse-error with the raw body preserved', async () => {
    const fetch = routedFetch([{
      prefix: CFG_OK.searchUrl,
      respond: () => mockResp('<html>oops</html>', { status: 200 }),
    }]);
    const err = await captureError(() => searchTickets({ fetch, cfg: CFG_OK }));
    assert.equal(err.category, 'parse-error');
    assert.match(err.responseBody, /<html>oops/);
  });

  it('on fetch rejection (network failure), categorizes as network with cause message', async () => {
    const fetch = async () => { throw new Error('ECONNREFUSED 127.0.0.1:443'); };
    const err = await captureError(() => searchTickets({ fetch, cfg: CFG_OK }));
    assert.equal(err.category, 'network');
    assert.match(err.message, /ECONNREFUSED/);
    assert.equal(err.causeMessage, 'ECONNREFUSED 127.0.0.1:443');
  });

  it('TicketGet errors are tagged with phase=TicketGet', async () => {
    const fetch = routedFetch([{
      prefix: CFG_OK.getUrl,
      respond: () => mockResp({ Error: { ErrorCode: 'TicketGet.PermissionDenied' } }),
    }]);
    const err = await captureError(() => getTicket('1234', { fetch, cfg: CFG_OK }));
    assert.equal(err.phase, 'TicketGet');
    assert.equal(err.otrsErrorCode, 'TicketGet.PermissionDenied');
  });

  it('toJSON omits null fields so the response payload stays compact', async () => {
    const fetch = routedFetch([{
      prefix: CFG_OK.searchUrl,
      respond: () => mockResp({ Error: { ErrorCode: 'AuthFail', ErrorMessage: 'nope' } }),
    }]);
    const err = await captureError(() => searchTickets({ fetch, cfg: CFG_OK }));
    const json = err.toJSON();
    assert.equal(json.name, 'OtrsRequestError');
    assert.equal(json.otrsErrorCode, 'AuthFail');
    // No network error → no causeMessage in payload
    assert.equal('causeMessage' in json, false);
  });
});

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
