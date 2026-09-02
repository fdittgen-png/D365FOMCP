/**
 * tool-guards.js — agent guardrails wrapped around every registered tool.
 *
 * Two failure modes cost real money and neither is visible from inside a single
 * tool call, so they are handled once at the registration boundary rather than
 * 51 times in the handlers.
 *
 * 1. LOOP DETECTION. An agent that re-issues the same call with the same
 *    arguments is not going to get a different answer, but it pays for the
 *    payload every time — and pays for it again on every later turn, because
 *    context is a running meter. A repeated 12k-token class dump is ~$0.25 of
 *    pure waste. On the Nth identical call this returns a SHORT corrective
 *    note instead of the payload: the loop is both broken and made cheap.
 *
 *    Deliberately not an error. The call succeeded; the answer is simply
 *    already in the transcript, and saying so is more useful than repeating it.
 *
 * 2. STALENESS. Every tool here reads a snapshot. A snapshot that is months old
 *    still answers confidently, and nothing in a normal response says "the
 *    thing you are asking about may have changed twice since this was built".
 *    The warning is emitted ONCE per process, on the first tool call that
 *    returns text — the information is needed once, and appending it to every
 *    response would be its own kind of waste.
 *
 * Both are off with `MCP_TOOL_GUARDS=off`.
 *
 * This module also OWNS the `core` tool profile list (`CORE_TOOLS`) and the
 * `toolInProfile()` predicate; the filter is APPLIED in tool-sets.js so it
 * reaches every tool set, not only the three that install guards.
 */

import { getRequestContext } from './request-context.js';
import { readBuildDate } from './shared.js';

/* ── Loop detection ───────────────────────────────────────────────────────── */

// Tuned to match the shape of a real loop rather than a deliberate re-read:
// three identical calls inside a fifteen-call window. Two identical calls are
// often legitimate (a re-check after a write elsewhere, a retry after an
// error); three in quick succession is a stuck agent.
export const LOOP_REPEAT_THRESHOLD = 3;
export const LOOP_WINDOW = 15;

const recentCalls = [];          // ring buffer of call keys, newest last
let staleNoticeEmitted = false;

/** Stable key for a call: tool name plus its arguments, key order normalised. */
export function callKey(toolName, args) {
  const stable = (v) => {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(stable);
    return Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])]));
  };
  let argPart;
  try { argPart = JSON.stringify(stable(args ?? {})); } catch { argPart = '<unserialisable>'; }
  return `${toolName}::${argPart}`;
}

/** Test seam — the buffers are module-level process state by design. */
export function resetToolGuards() {
  recentCalls.length = 0;
  staleNoticeEmitted = false;
}

/**
 * OPT-IN, and deliberately so.
 *
 * These guards are a *session* concern: they only make sense where an agent is
 * driving the tools turn by turn. The MCP entry points (src/local/*.js,
 * src/functions/*.js) set `MCP_TOOL_GUARDS=on` because that is where a session
 * exists. A library consumer — a test, a batch script, a builder — calls the
 * same handler repeatedly on purpose, and silently swapping its result for a
 * "you are looping" note would be a bug, not a feature.
 *
 * Defaulting this ON was tried first and broke 20 tests that legitimately
 * repeat a call; the failure was the guard's, not the tests'.
 */
export function guardsEnabled() {
  return ['on', '1', 'true'].includes(String(process.env.MCP_TOOL_GUARDS ?? '').toLowerCase());
}

/**
 * Record a call and report whether it is a loop.
 * @returns {{loop: boolean, repeats: number}}
 */
export function recordCall(key) {
  recentCalls.push(key);
  if (recentCalls.length > LOOP_WINDOW) recentCalls.shift();
  const repeats = recentCalls.filter(k => k === key).length;
  return { loop: repeats >= LOOP_REPEAT_THRESHOLD, repeats };
}

/** The response that replaces a looped payload. Short on purpose. */
export function loopResult(toolName, repeats) {
  return {
    content: [{
      type: 'text',
      text: `## Repeated call suppressed\n\n`
        + `\`${toolName}\` has now been called ${repeats} times with identical arguments in the last ${LOOP_WINDOW} calls. `
        + `The snapshot is read-only and has not changed between them, so the answer is the one already above — `
        + `re-reading it costs tokens without adding information.\n\n`
        + `If the earlier result did not answer the question, change the question rather than repeating it: `
        + `narrow it with a filter or \`limit\`, ask a different tool, or state what is missing. `
        + `Set \`MCP_TOOL_GUARDS=off\` to disable this.`,
    }],
    // No structuredContent: this is a meta-response, like errorResult. A client
    // validating structuredContent against the tool's outputSchema must not be
    // handed a payload that is not one (see feedback_error_responses_no_structuredcontent).
    _meta: { kind: 'loop' },
  };
}

/* ── Staleness ────────────────────────────────────────────────────────────── */

export const DEFAULT_STALE_DAYS = 45;

function staleDays() {
  const raw = Number(process.env.MCP_STALE_WARN_DAYS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_STALE_DAYS;
}

// The build-date reader lives in shared.js since the freshness banner (rule #4)
// needs it too; re-exported so existing importers keep working.
export { readBuildDate };

/**
 * One-shot staleness note, or '' when the snapshot is fresh / undatable.
 * Emitted at most once per process.
 */
export function stalenessNote(db, service) {
  if (staleNoticeEmitted || !guardsEnabled()) return '';
  const built = readBuildDate(db);
  if (!built) { staleNoticeEmitted = true; return ''; }

  const ageDays = Math.floor((Date.now() - built.getTime()) / 86_400_000);
  staleNoticeEmitted = true;
  if (ageDays < staleDays()) return '';

  return `\n\n_⚠ The ${service} snapshot was built ${ageDays} days ago (${built.toISOString().slice(0, 10)}). `
    + `Objects added or changed since then are absent from every answer this service gives, and a "not found" `
    + `may mean "not yet scanned". Rebuild before relying on this for a current-state question._`;
}

/* ── Tool profile ─────────────────────────────────────────────────────────── */

/**
 * `MCP_TOOL_PROFILE=core` registers only the tools below.
 *
 * The tool list is re-sent on EVERY request and cannot be filtered, limited or
 * paginated away — measured at ~13,000 tokens across the three services, ~$0.26
 * over a 40-turn session before a single tool runs. Most sessions use a fraction
 * of the surface, and a session running several MCP servers pays every
 * catalogue at once.
 *
 * This list is a STARTING POINT chosen by hand, not by measurement: it keeps the
 * tools that answer the common "what is this / who can reach it / what breaks"
 * questions and drops the specialised ones (ISV internals, SoD-adjacent
 * analysis, raw SQL, task recordings). Tune it from real usage rather than
 * treating it as settled — the cost of dropping a tool someone needs is a failed
 * investigation, which is worth far more than the tokens saved.
 *
 * Off by default: the full surface is what a first-time or exploratory session
 * should see.
 */
export const CORE_TOOLS = new Set([
  // KB — identify an object and read its shape
  'd365_search', 'd365_lookup_table', 'd365_get_join_keys', 'd365_get_enum',
  'd365_check_field_exists', 'd365_get_class_methods', 'd365_get_method_source',
  'd365_get_entity_sources', 'd365_list_modules', 'd365_resolve_label',
  // XRef — what uses it, what extends it
  'xref_search_names', 'xref_object_summary', 'xref_find_references',
  'xref_find_extensions', 'xref_find_method_callers', 'xref_list_modules',
  // Sec — can this user do this thing
  'sec_search', 'sec_lookup_user', 'sec_object_access',
  'sec_effective_permissions', 'sec_lookup_role', 'sec_permission_trace', 'sec_stats',
]);

/**
 * The profile of the CURRENT request (W2, #106): `?profile=` / `X-MCP-Tool-Profile`
 * / `MCP_TOOL_PROFILE`, resolved once per request in request-context.js. Outside
 * a request (tests, scripts, stdio startup) it is the env-only resolution, so
 * `MCP_TOOL_PROFILE=core` keeps working exactly as before.
 */
export function activeProfile() {
  return getRequestContext().profile;
}

/**
 * True when this tool should be registered under `profile`.
 *
 * The filter itself is applied in ONE place — `registerServiceTools()` in
 * tool-sets.js — so that every tool set is subject to it. It used to live in
 * `installToolGuards`, which only kb-tools / xref-tools / sec-tools call, so the
 * ISV, custom-fields and Task Recorder sets slipped past `core` and the two
 * largest KB tools (`d365_isv_lookup`, `d365_isv_extension_points`) survived it.
 */
export function toolInProfile(name, profile = activeProfile()) {
  return profile !== 'core' || CORE_TOOLS.has(name);
}

/* ── Installation ─────────────────────────────────────────────────────────── */

/**
 * Wrap a server so every tool registered through it carries the guards.
 *
 * Returns a proxy rather than mutating the caller's object: the same McpServer
 * instance is shared by several register*Tools() calls, and wrapping it twice
 * would double-count every call in the loop window.
 */
const GUARDED = Symbol.for('d365fo.mcp.toolGuardsInstalled');

export function installToolGuards(server, { service = 'snapshot', db = null } = {}) {
  if (!server || typeof server.registerTool !== 'function') return server;

  // The tool PROFILE is not applied here any more. It is a registration-path
  // concern that must reach every tool set, not only the three that install
  // guards — see registerServiceTools() in tool-sets.js and toolInProfile().
  if (!guardsEnabled()) return server;

  // IDEMPOTENT. The KB server takes both registerKbTools() and
  // registerIsvKbTools(), and the XRef server likewise — each installs guards on
  // the same McpServer. Wrapping twice would record every call once per wrap and
  // trip the loop threshold at half the intended count, suppressing legitimate
  // second calls. (`Object.create` means the flag is visible through the
  // prototype chain, which is exactly what makes the second install a no-op.)
  if (server[GUARDED]) return server;

  const wrapped = Object.create(server);
  wrapped[GUARDED] = true;
  wrapped.registerTool = (name, config, handler) => {
    return server.registerTool(name, config, async (...args) => {
    const { loop, repeats } = recordCall(callKey(name, args[0]));
    if (loop) return loopResult(name, repeats);

    const result = await handler(...args);

    // Attach the one-shot staleness note to the text channel of a normal
    // response. Never to an error or empty meta-response — those carry their
    // own explanation and a snapshot-age footnote only muddies it.
    const note = result?.isError ? '' : stalenessNote(db, service);
    if (note && Array.isArray(result?.content) && result.content[0]?.type === 'text') {
      return {
        ...result,
        content: [{ ...result.content[0], text: `${result.content[0].text}${note}` }, ...result.content.slice(1)],
      };
    }
    return result;
    });
  };
  return wrapped;
}
