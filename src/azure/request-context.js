/**
 * request-context.js — per-request client preferences (W2 #106, W4 #108).
 *
 * Two knobs decide how much a client pays per turn, and neither belongs to the
 * process:
 *
 *   profile      'full' | 'core'      which tools are REGISTERED (tools/list size)
 *   textChannel  'full' | 'summary'   what `content[0].text` carries next to
 *                                     `structuredContent` (payload size)
 *
 * On Azure the Streamable HTTP entry points build a fresh `McpServer` per
 * request, so the natural scope for both is the request: the claude.ai
 * connector URL can carry `?profile=core&text=summary` while a Claude Code
 * stdio session on the same code keeps the full surface. `AsyncLocalStorage`
 * carries the resolved preferences from the HTTP handler down to
 * `registerTool` (profile) and `structuredResult` (text channel) without
 * threading a parameter through 58 tool handlers.
 *
 * Resolution order, highest precedence first — implemented ONCE here:
 *
 *   1. query parameter    ?profile=core            ?text=summary
 *   2. HTTP header        X-MCP-Tool-Profile       X-MCP-Text-Channel
 *   3. environment        MCP_TOOL_PROFILE         MCP_TEXT_CHANNEL
 *   4. clientInfo policy  —                        CLIENT_TEXT_CHANNEL_POLICY[clientInfo.name]
 *   5. default            full                     full
 *
 * An unknown value at any level falls through to the next one — never an
 * error. A typo in a connector URL must not strip a server down to nothing or
 * fail the request.
 *
 * Step 4 exists for stdio only: a stateless HTTP request never sees the
 * `initialize` handshake that carried `clientInfo`, but a stdio server does,
 * and `src/local/*` re-resolve after `oninitialized`. The policy table is
 * EMPTY on purpose — see the comment on it.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export const PROFILES = Object.freeze(['full', 'core']);
export const TEXT_CHANNELS = Object.freeze(['full', 'summary']);

export const DEFAULT_PREFERENCES = Object.freeze({
  profile: 'full',
  textChannel: 'full',
});

/**
 * clientInfo.name (lower-cased) → text channel, consulted for stdio sessions
 * after `initialize`.
 *
 * DELIBERATELY EMPTY. Issue #108's decision path starts with a measurement:
 * repeat the Run-4 method against Claude Code (stdio) and the claude.ai
 * connector to confirm which channel each client actually bills. Only a client
 * that is MEASURED to bill `structuredContent` and discard the text belongs in
 * here — e.g. `{ 'claude-ai': 'summary' }` — and recording that measurement on
 * #108 is the architect's call, not this module's. Until then every client
 * gets the full text channel, exactly as before this module existed.
 */
export const CLIENT_TEXT_CHANNEL_POLICY = Object.freeze({});

/** Header names, exported so the entry points and tests share one spelling. */
export const HEADER_PROFILE = 'x-mcp-tool-profile';
export const HEADER_TEXT_CHANNEL = 'x-mcp-text-channel';
export const QUERY_PROFILE = 'profile';
export const QUERY_TEXT_CHANNEL = 'text';
export const ENV_PROFILE = 'MCP_TOOL_PROFILE';
export const ENV_TEXT_CHANNEL = 'MCP_TEXT_CHANNEL';

/** 'core' | 'full', or null for anything else (so the caller can fall through). */
export function normalizeProfile(value) {
  const v = String(value ?? '').trim().toLowerCase();
  return PROFILES.includes(v) ? v : null;
}

/** 'summary' | 'full', or null for anything else. */
export function normalizeTextChannel(value) {
  const v = String(value ?? '').trim().toLowerCase();
  return TEXT_CHANNELS.includes(v) ? v : null;
}

/* ── Source readers (tolerant of every shape the runtimes hand us) ────────── */

function readHeader(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === 'function') return headers.get(name) ?? headers.get(name.toLowerCase()) ?? undefined;
  if (typeof headers === 'object') {
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() === name.toLowerCase()) return Array.isArray(v) ? v[0] : v;
    }
  }
  return undefined;
}

function readQuery(query, name) {
  if (!query) return undefined;
  if (typeof query === 'string') {
    try { return new URL(query, 'http://localhost').searchParams.get(name) ?? undefined; } catch { return undefined; }
  }
  if (typeof query.get === 'function') return query.get(name) ?? undefined;
  if (typeof query === 'object') return query[name];
  return undefined;
}

/**
 * Resolve the preferences for one request / one process.
 *
 * @param {{ headers?: any, query?: any, env?: object, clientInfo?: {name?: string}, policy?: Record<string, string> }} [sources]
 *   `headers`: Fetch `Headers`, Azure `HttpRequest.headers`, or a plain object.
 *   `query`: `URLSearchParams`, a plain object, or a full URL string.
 *   `env`: defaults to `process.env`.
 *   `clientInfo`: the `initialize` `Implementation` (stdio only).
 *   `policy`: clientInfo.name → text channel; defaults to CLIENT_TEXT_CHANNEL_POLICY
 *   (injectable so the mechanism is testable while the real table stays empty).
 * @returns {{ profile: 'full'|'core', textChannel: 'full'|'summary', clientName?: string,
 *             sources: { profile: string, textChannel: string } }}
 *   `sources` names the level that decided each value — it is what gets logged
 *   so `CORE_TOOLS` can be tuned from real usage rather than guessed.
 */
export function resolvePreferences({ headers, query, env = process.env, clientInfo, policy = CLIENT_TEXT_CHANNEL_POLICY } = {}) {
  const pick = (normalize, candidates) => {
    for (const [source, raw] of candidates) {
      if (raw === undefined || raw === null || raw === '') continue;
      const v = normalize(raw);
      if (v) return { value: v, source };
    }
    return { value: null, source: 'default' };
  };

  const profile = pick(normalizeProfile, [
    ['query', readQuery(query, QUERY_PROFILE)],
    ['header', readHeader(headers, HEADER_PROFILE)],
    ['env', env?.[ENV_PROFILE]],
  ]);

  const clientName = typeof clientInfo?.name === 'string' && clientInfo.name.trim()
    ? clientInfo.name.trim()
    : undefined;
  const policyChannel = clientName && policy ? policy[clientName.toLowerCase()] : undefined;

  const textChannel = pick(normalizeTextChannel, [
    ['query', readQuery(query, QUERY_TEXT_CHANNEL)],
    ['header', readHeader(headers, HEADER_TEXT_CHANNEL)],
    ['env', env?.[ENV_TEXT_CHANNEL]],
    ['client-policy', policyChannel],
  ]);

  return Object.freeze({
    profile: profile.value ?? DEFAULT_PREFERENCES.profile,
    textChannel: textChannel.value ?? DEFAULT_PREFERENCES.textChannel,
    ...(clientName ? { clientName } : {}),
    sources: Object.freeze({ profile: profile.source, textChannel: textChannel.source }),
  });
}

/**
 * Convenience for the Azure Functions entry points: pull headers + query off
 * an `HttpRequest` (the v4 model exposes `headers.get()` and a `url`).
 */
export function preferencesFromHttpRequest(request, env = process.env) {
  return resolvePreferences({
    headers: request?.headers,
    query: typeof request?.url === 'string' ? request.url : request?.query,
    env,
  });
}

/** One-line description for the per-request log (App Insights trace). */
export function describePreferences(prefs) {
  const p = prefs ?? DEFAULT_PREFERENCES;
  const src = p.sources ?? {};
  return `profile=${p.profile}(${src.profile ?? 'default'}) text=${p.textChannel}(${src.textChannel ?? 'default'})`
    + (p.clientName ? ` client=${p.clientName}` : '');
}

/* ── The context itself ───────────────────────────────────────────────────── */

const storage = new AsyncLocalStorage();

/**
 * Process-wide fallback for stdio servers, which have exactly one client and no
 * request boundary to wrap. `null` means "resolve from the environment on every
 * read", which is what tests and library consumers get.
 */
let processContext = null;

export function setProcessRequestContext(prefs) {
  processContext = prefs ? Object.freeze({ ...prefs }) : null;
}

/**
 * Run `fn` with `prefs` as the ambient request context. Every `await` chain,
 * timer and promise started inside `fn` sees the same store; a sibling request
 * running concurrently sees its own.
 */
export function runWithRequestContext(prefs, fn) {
  return storage.run(Object.freeze({ ...(prefs ?? DEFAULT_PREFERENCES) }), fn);
}

/**
 * The ambient preferences: the enclosing `runWithRequestContext` store, else
 * the stdio process context, else a fresh env-only resolution. Never throws
 * and never returns undefined — callers can destructure it directly.
 */
export function getRequestContext() {
  return storage.getStore() ?? processContext ?? resolvePreferences({ env: process.env });
}
