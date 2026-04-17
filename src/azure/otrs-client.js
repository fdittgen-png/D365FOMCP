/**
 * OTRS generic-interface REST client.
 *
 * Two endpoints are exposed per Przemysław's integration note:
 *   - TicketSearch → POST, returns { TicketID: [id, …] }
 *   - TicketGet    → POST with AllArticles=1, returns { Ticket: [{…}] }
 *
 * Credentials and endpoint URLs come from env; `fetch` is injectable so the
 * tests can run without a live OTRS. Plain primitives only — orchestration
 * (state blob, mode handling, XML serialization) lives in the caller.
 */

/**
 * Read the OTRS configuration at invocation time so tests can set env vars
 * just before calling. Validates required fields and throws a single
 * human-readable error listing every missing one.
 */
export function readOtrsConfig(env = process.env) {
  const serviceIdRaw = env.OTRS_SERVICE_ID;
  const serviceId = Number.parseInt(serviceIdRaw, 10);
  const cfg = {
    username:  env.OTRS_USERNAME,
    password:  env.OTRS_PASSWORD,
    searchUrl: env.OTRS_SEARCH_URL,
    getUrl:    env.OTRS_GET_URL,
    // OTRS TicketSearch expects the numeric Service **ID**, not the
    // human-readable service name. Przemysław's original integration email
    // showed a `Services: "TIS - Digital Solutions Support::ERP::D365"`
    // payload that OTRS actually rejects with a generic "Authorization
    // failing" error; the real API uses `ServiceID: 798`. Keep this as an
    // integer so the JSON serializer emits a number literal.
    serviceId: Number.isInteger(serviceId) && serviceId > 0 ? serviceId : null,
    state:     env.OTRS_STATE || 'closed successful',
    minResolutionChars: Number.parseInt(env.OTRS_MIN_RESOLUTION_CHARS || '200', 10) || 200,
  };
  const required = ['username', 'password', 'searchUrl', 'getUrl', 'serviceId'];
  const missing = required.filter(k => !cfg[k]);
  if (missing.length) {
    throw new Error(`Missing OTRS config: ${missing.map(k => envNameFor(k)).join(', ')}`);
  }
  return cfg;
}

const ENV_NAMES = {
  username: 'OTRS_USERNAME',
  password: 'OTRS_PASSWORD',
  searchUrl: 'OTRS_SEARCH_URL',
  getUrl: 'OTRS_GET_URL',
  serviceId: 'OTRS_SERVICE_ID',
};
function envNameFor(key) { return ENV_NAMES[key] || key; }

const RESPONSE_BODY_MAX_CHARS = 2000;

/**
 * Custom error class carrying the full request/response context for an
 * OTRS API call. Enables the admin UI and App Insights to surface every
 * detail that matters for debugging (which is almost all of them, since
 * OTRS returns the same `TicketSearch.AuthFail` string for half-a-dozen
 * different underlying problems — bad creds, wrong payload shape,
 * unauthorized service, bad web-service name, etc).
 *
 * The `Password` field in `requestBodyRedacted` is replaced with `***`;
 * everything else is preserved so the operator can compare against a
 * known-good Postman call.
 */
export class OtrsRequestError extends Error {
  constructor(message, context = {}) {
    super(message);
    this.name = 'OtrsRequestError';
    // Copy every context field onto the instance so `err.phase` etc. work
    // directly, and toJSON below emits them predictably.
    this.category          = context.category ?? 'unknown';
    this.phase             = context.phase ?? 'unknown';
    this.url               = context.url ?? null;
    this.httpStatus        = context.httpStatus ?? null;
    this.httpStatusText    = context.httpStatusText ?? null;
    this.otrsErrorCode     = context.otrsErrorCode ?? null;
    this.otrsErrorMessage  = context.otrsErrorMessage ?? null;
    this.responseBody      = context.responseBody ?? null;
    this.responseHeaders   = context.responseHeaders ?? null;
    this.requestBodyRedacted = context.requestBodyRedacted ?? null;
    this.elapsedMs         = context.elapsedMs ?? null;
    this.timestamp         = context.timestamp ?? new Date().toISOString();
    this.causeMessage      = context.cause?.message ?? null;
  }

  /**
   * Stable JSON shape for serializing into an HTTP response body. Omits
   * fields that are null to keep the payload compact in the happy case.
   */
  toJSON() {
    const out = { name: this.name, message: this.message };
    for (const k of [
      'category', 'phase', 'url', 'httpStatus', 'httpStatusText',
      'otrsErrorCode', 'otrsErrorMessage', 'responseBody', 'responseHeaders',
      'requestBodyRedacted', 'elapsedMs', 'timestamp', 'causeMessage',
    ]) {
      if (this[k] !== null && this[k] !== undefined) out[k] = this[k];
    }
    return out;
  }
}

/** Build a copy of the request body with password replaced by `***`. */
function redactBody(body) {
  if (!body || typeof body !== 'object') return body;
  const out = { ...body };
  if ('Password' in out && out.Password) out.Password = '***';
  return out;
}

/** Capture response headers as a plain object; tolerate fake test responses. */
function captureHeaders(resp) {
  try {
    if (resp.headers?.entries) return Object.fromEntries(resp.headers.entries());
    if (resp.headers && typeof resp.headers === 'object') return { ...resp.headers };
  } catch { /* logger unavailable */ }
  return null;
}

async function otrsPost(url, body, fetchFn, phase) {
  const timestamp = new Date().toISOString();
  const requestBodyRedacted = redactBody(body);
  const startedAt = Date.now();

  // ── Network phase ──────────────────────────────────────────────────────
  let resp;
  try {
    resp = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (cause) {
    throw new OtrsRequestError(`OTRS ${phase} fetch failed: ${cause.message}`, {
      category: 'network',
      phase, url, requestBodyRedacted,
      elapsedMs: Date.now() - startedAt,
      timestamp, cause,
    });
  }

  const elapsedMs = Date.now() - startedAt;
  const responseHeaders = captureHeaders(resp);

  // ── Read body once (fetch bodies cannot be re-read) ────────────────────
  let bodyText = '';
  try { bodyText = await resp.text(); } catch { /* leave empty */ }
  const truncatedBody = bodyText.length > RESPONSE_BODY_MAX_CHARS
    ? bodyText.slice(0, RESPONSE_BODY_MAX_CHARS) + `...[truncated ${bodyText.length - RESPONSE_BODY_MAX_CHARS} chars]`
    : bodyText;

  // ── HTTP-error phase ───────────────────────────────────────────────────
  if (!resp.ok) {
    throw new OtrsRequestError(
      `OTRS ${phase} returned HTTP ${resp.status} ${resp.statusText || ''}`.trim(),
      {
        category: 'http-error',
        phase, url,
        httpStatus: resp.status,
        httpStatusText: resp.statusText,
        responseHeaders, responseBody: truncatedBody,
        requestBodyRedacted, elapsedMs, timestamp,
      },
    );
  }

  // ── Parse phase ────────────────────────────────────────────────────────
  let data;
  try {
    data = JSON.parse(bodyText);
  } catch (cause) {
    throw new OtrsRequestError(`OTRS ${phase} returned non-JSON response`, {
      category: 'parse-error',
      phase, url,
      httpStatus: resp.status,
      httpStatusText: resp.statusText,
      responseHeaders, responseBody: truncatedBody,
      requestBodyRedacted, elapsedMs, timestamp, cause,
    });
  }

  // ── In-band OTRS error (HTTP 200 + { Error: {...} }) ───────────────────
  if (data && data.Error) {
    const code = data.Error.ErrorCode || 'unknown';
    const msg  = data.Error.ErrorMessage || '';
    throw new OtrsRequestError(
      `OTRS returned error ${code}${msg ? ': ' + msg : ''}`,
      {
        category: 'otrs-error',
        phase, url,
        httpStatus: resp.status,
        httpStatusText: resp.statusText,
        otrsErrorCode: code,
        otrsErrorMessage: msg,
        responseHeaders, responseBody: truncatedBody,
        requestBodyRedacted, elapsedMs, timestamp,
      },
    );
  }

  return data;
}

/**
 * POST /TicketSearch with the configured service/state filter.
 * Returns an array of stringified ticket IDs (OTRS sometimes returns
 * numbers, sometimes strings — we normalize).
 */
export async function searchTickets({ fetch = globalThis.fetch, cfg = null } = {}) {
  const c = cfg || readOtrsConfig();
  // Field names match the Postman-validated OTRS API:
  //   ServiceID: integer    (the DB id of the Services::::Subservice row)
  //   State:     string     (singular — OTRS rejects the plural form)
  // Sending the wrong names produces a generic "Authorization failing"
  // response, NOT a parameter-validation error. Do not change without a
  // round-trip through Postman first.
  const body = {
    UserLogin: c.username,
    Password:  c.password,
    ServiceID: c.serviceId,
    State:     c.state,
  };
  const data = await otrsPost(c.searchUrl, body, fetch, 'TicketSearch');
  const raw = data?.TicketID;
  if (!raw) return [];
  const ids = Array.isArray(raw) ? raw : [raw];
  return ids.map(String);
}

/**
 * POST /TicketGet for a single ticket id with AllArticles=1.
 * Returns the first (and only) ticket object from the response.
 */
export async function getTicket(ticketId, { fetch = globalThis.fetch, cfg = null } = {}) {
  const c = cfg || readOtrsConfig();
  const body = {
    UserLogin:   c.username,
    Password:    c.password,
    TicketID:    String(ticketId),
    AllArticles: 1,
  };
  const data = await otrsPost(c.getUrl, body, fetch, 'TicketGet');
  const t = data?.Ticket;
  const ticket = Array.isArray(t) ? t[0] : t;
  if (!ticket) throw new Error(`OTRS TicketGet returned no ticket for ID ${ticketId}`);
  return ticket;
}

/**
 * Validate that a ticket is actually resolved AND carries both a description
 * and a resolution. This is the quality gate — the wiki should only ever get
 * tickets with both halves of the "what was the problem / what fixed it"
 * story.
 *
 * Returns on success:
 *   { ok: true, description, resolution, articles }
 * Returns on failure:
 *   { ok: false, reason: '<human-readable>' }
 *
 * Rules:
 *   1. State must be a "closed" variant (belt-and-suspenders with TicketSearch).
 *   2. At least one customer-authored article with a non-empty body
 *      (gives us the problem description).
 *   3. Combined agent-article body text must be ≥ minResolutionChars
 *      (gives us a documented resolution, not a one-line "fixed it").
 */
export function validateTicket(ticket, { minResolutionChars = 200 } = {}) {
  const stateRaw  = ticket?.State || ticket?.StateType || '';
  const state     = String(stateRaw).toLowerCase();
  if (state && !state.includes('closed')) {
    return { ok: false, reason: `state is "${stateRaw}", expected a "closed" variant` };
  }

  const articles = extractArticles(ticket);
  if (articles.length === 0) {
    return { ok: false, reason: 'ticket has no articles (AllArticles=1 missing from TicketGet?)' };
  }

  const customerArticles = articles.filter(a => senderType(a) === 'customer' && nonEmptyBody(a));
  if (customerArticles.length === 0) {
    return { ok: false, reason: 'no customer article with non-empty body (description missing)' };
  }

  const agentArticles = articles.filter(a => senderType(a) === 'agent' && nonEmptyBody(a));
  const agentTotalChars = agentArticles.reduce((n, a) => n + bodyText(a).length, 0);
  if (agentTotalChars < minResolutionChars) {
    return {
      ok: false,
      reason: `agent-article body total is ${agentTotalChars} chars, minimum ${minResolutionChars} (resolution too thin)`,
    };
  }

  // Primary description = first customer article (the initial request).
  // Resolution = all agent articles concatenated, oldest first, so a
  // multi-step fix is preserved in chronological order.
  const description = bodyText(customerArticles[0]);
  const resolution  = agentArticles.map(bodyText).join('\n\n---\n\n');

  return { ok: true, description, resolution, articles };
}

function extractArticles(ticket) {
  // OTRS returns Article as an array when there are many, as a single object
  // when there is one, and omits it entirely when AllArticles wasn't set.
  const a = ticket?.Article;
  if (!a) return [];
  return Array.isArray(a) ? a : [a];
}

function senderType(article) {
  // `SenderType` is the human string ("customer"/"agent"/"system").
  // Normalize case, ignore any numeric SenderTypeID since it's installation-specific.
  return String(article?.SenderType || '').toLowerCase();
}

function bodyText(article) {
  const b = article?.Body;
  return typeof b === 'string' ? b.trim() : '';
}

function nonEmptyBody(article) {
  return bodyText(article).length > 0;
}
