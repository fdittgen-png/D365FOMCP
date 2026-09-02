/**
 * Tool sets — the single source of truth for WHICH register*Tools() functions
 * each MCP server registers, in which order, and under which REGISTRATION
 * POLICY.
 *
 * Every entry point (`src/local/mcp-server-*.js`, `src/functions/d365*.js`)
 * registers through `registerAll<Svc>Tools()` from here, and the tool-list
 * budget test (`test/tool-schema-budget.test.js`) measures exactly these sets.
 * That is the point: the budget used to register `registerKbTools` alone and
 * reported 44 KB for a KB server whose real `tools/list` is 69 KB, because the
 * ISV and custom-field sets were added to the servers but never to the test.
 * A registration list that lives in one module cannot drift from itself; the
 * test additionally static-scans the entry points so nobody can bypass it by
 * calling a `register*Tools()` directly.
 *
 * Because every registration flows through here, this is also the one place a
 * cross-cutting registration rule can be applied to ALL tools without touching
 * 58 handlers. Today that is the tool PROFILE (W2, #106): `core` used to be
 * filtered inside `installToolGuards`, which only kb/xref/sec call, so the ISV,
 * custom-fields and Task Recorder sets slipped past it — the two largest KB
 * tools, `d365_isv_lookup` (10.7 KB) and `d365_isv_extension_points` (7.9 KB),
 * survived the profile whose whole purpose is to drop tools like them.
 *
 * Order matters only for the printed budget breakdown and the tool order a
 * client sees; it mirrors what the servers did before this module existed.
 */

import { registerKbTools } from './kb-tools.js';
import { registerIsvKbTools } from './isv-kb-tools.js';
import { registerCustomFieldTools } from './custom-fields-tools.js';
import { registerXrefTools } from './xref-tools.js';
import { registerIsvXrefTools } from './isv-xref-tools.js';
import { registerSecTools } from './sec-tools.js';
import { registerTaskRecorderTools } from './taskrecorder-tools.js';
import { toolInProfile } from './tool-guards.js';
import { getRequestContext } from './request-context.js';
import { withFreshnessBanner } from './shared.js';
import { registerResources } from './resources.js';
import { registerSemanticTools } from './semantic-tools.js';
import { openSemanticDb } from './semantic-store.js';

/* ── Semantic layer (W7, #111) ────────────────────────────────────────────── */

/**
 * The four semantic-layer tools are NOT snapshot-backed: they read and write
 * `d365fo_semantic.sqlite`, which survives KB rebuilds. Stamping their
 * responses with the KB build date would claim a provenance they do not have,
 * so `withFreshness` skips them by name.
 */
export const SEMANTIC_TOOL_NAMES = Object.freeze(['d365_map_entity', 'd365_map_dq_rule', 'd365_entity_map', 'd365_dq_rules']);
const SEMANTIC_TOOLS = new Set(SEMANTIC_TOOL_NAMES);

/**
 * Open the semantic store on FIRST USE, not at registration: `serviceToolNames()`
 * dry-runs every register function to collect names, and a dry run must not
 * create a database file. `SEMANTIC_DB_PATH` selects the file (Azure:
 * `/home/data/d365fo_semantic.sqlite`, writable — unlike the snapshots).
 */
function lazySemanticDb() {
  let db = null;
  return new Proxy({}, {
    get(_t, prop) {
      db ??= openSemanticDb();
      const v = db[prop];
      return typeof v === 'function' ? v.bind(db) : v;
    },
  });
}

/** KB-set adapter: `(server, kbDb)` → `registerSemanticTools(server, semDb, kbDb)`. */
function registerSemanticKbTools(server, kbDb) {
  registerSemanticTools(server, lazySemanticDb(), kbDb ?? null);
}

/** @type {Readonly<Record<'kb'|'xref'|'sec'|'taskrecorder', ReadonlyArray<(server: any, db?: any) => void>>>} */
export const TOOL_SETS = Object.freeze({
  kb: Object.freeze([registerKbTools, registerIsvKbTools, registerCustomFieldTools, registerSemanticKbTools]),
  xref: Object.freeze([registerXrefTools, registerIsvXrefTools]),
  sec: Object.freeze([registerSecTools]),
  // Task Recorder tools take no database; the extra argument is ignored.
  taskrecorder: Object.freeze([registerTaskRecorderTools]),
});

/* ── Registration policy ──────────────────────────────────────────────────── */

const POLICY_APPLIED = Symbol.for('d365fo.mcp.toolSetPolicyApplied');

/**
 * Wrap `server` so every `registerTool` that reaches it obeys the registration
 * policy of the CURRENT request context. Returns a prototype-chained view (like
 * `installToolGuards`), never mutates the caller's object, and is idempotent:
 * wrapping an already-wrapped server hands it straight back.
 *
 * Policy today:
 *   - PROFILE: a tool outside `CORE_TOOLS` is not registered when the request's
 *     profile is `core` (`toolInProfile`). Applies to EVERY set — that is why it
 *     lives here and not in the guards.
 *   - FRESHNESS: every data response of a snapshot-backed tool gets the rule #4
 *     banner (`withFreshness` below).
 *   - TITLE: a tool without `title` gets one derived from its name
 *     (`deriveToolTitle`). Measured cost on tools/list: see the budget test's
 *     `title` column — a deliberate ~1 KB across the four servers.
 *
 * `stats.registered` counts what actually reached the underlying server, so a
 * caller can report the effective tool count (the snapshot resource does).
 */
export function withRegistrationPolicy(server, { service = 'snapshot', db = null, profile = getRequestContext().profile } = {}) {
  if (!server || typeof server.registerTool !== 'function') return server;
  if (server[POLICY_APPLIED]) return server;

  const stats = { profile, registered: 0, skipped: [] };
  const view = Object.create(server);
  view[POLICY_APPLIED] = true;
  view.toolSetStats = stats;
  view.toolSetService = service;
  view.toolSetDb = db;
  view.registerTool = (name, config, handler) => {
    if (!toolInProfile(name, profile)) { stats.skipped.push(name); return undefined; }
    stats.registered += 1;
    return server.registerTool(name, withTitle(name, config), withFreshness(name, handler, config, db, service));
  };
  return view;
}

/* ── Tool titles (W5.B, #109) ─────────────────────────────────────────────── */

// Words that are acronyms in this domain and read wrong in sentence case.
const TITLE_ACRONYMS = Object.freeze({ isv: 'ISV', sql: 'SQL', id: 'ID', xref: 'XRef', kb: 'KB', il: 'IL' });
const TITLE_PREFIXES = new Set(['d365', 'xref', 'sec', 'taskrecorder', 'wiki']);

/**
 * Human display name from a tool name: `d365_lookup_table` → "Lookup table",
 * `xref_find_references` → "Find references", `d365_raw_sql` → "Raw SQL".
 * A tool file that sets its own `title` wins; this is the fallback so that
 * every tool has one without editing 58 registrations.
 */
export function deriveToolTitle(name) {
  const words = String(name ?? '').split('_').filter(Boolean);
  if (words.length > 1 && TITLE_PREFIXES.has(words[0].toLowerCase())) words.shift();
  return words
    .map((w, i) => TITLE_ACRONYMS[w.toLowerCase()] ?? (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ');
}

function withTitle(name, config) {
  if (!config || typeof config !== 'object') return config;
  if (typeof config.title === 'string' && config.title.trim()) return config;
  return { ...config, title: deriveToolTitle(name) };
}

/**
 * FRESHNESS (rule #4, #86 base). Every DATA response of a snapshot-backed tool
 * carries `_<Service> snapshot: <date>_` on the line after its H2 heading —
 * attached HERE, once, rather than remembered in 50 handlers. `withFreshnessBanner`
 * skips meta-responses (`_meta.kind`, `isError`, no `structuredContent`) itself.
 * Two more exclusions belong to the registration, not the response:
 *   - no database (Task Recorder): nothing to date;
 *   - a LIVE tool (`openWorldHint: true`, i.e. `d365_custom_fields`): its rows
 *     come from an environment right now, and stamping them with the KB build
 *     date would claim a provenance they do not have;
 *   - a SEMANTIC tool (`SEMANTIC_TOOL_NAMES`): its store outlives the snapshot.
 */
function withFreshness(name, handler, config, db, service) {
  if (!db || typeof handler !== 'function' || config?.annotations?.openWorldHint === true) return handler;
  if (SEMANTIC_TOOLS.has(name)) return handler;
  return async (...args) => withFreshnessBanner(await handler(...args), db, service);
}

/**
 * Tool names a service registers, independent of any profile. Registration
 * functions are pure in their NAMES (only the schemas probe the database), so
 * one dry run per service per process is enough.
 */
const serviceNamesCache = new Map();
export function serviceToolNames(service, db = null) {
  if (serviceNamesCache.has(service)) return serviceNamesCache.get(service);
  const sets = TOOL_SETS[service];
  if (!sets) throw new Error(`Unknown MCP service "${service}" — expected one of ${Object.keys(TOOL_SETS).join(', ')}`);
  const names = [];
  const collect = { registerTool(name) { names.push(name); } };
  for (const register of sets) register(collect, db);
  const frozen = Object.freeze(names);
  serviceNamesCache.set(service, frozen);
  return frozen;
}

/**
 * The profile a service will actually register under for the current request.
 *
 * A profile that would leave a server with ZERO tools is not a profile, it is a
 * broken server: the SDK never installs a `tools/list` handler and the client
 * gets `-32601 Method not found`. The Task Recorder has no CORE_TOOLS member, so
 * `?profile=core` on a URL that happens to be shared across connectors would
 * kill it. Same principle as an unknown profile value: fall back to `full`,
 * never to nothing.
 */
export function effectiveProfile(service, db = null, profile = getRequestContext().profile) {
  if (profile !== 'core') return profile;
  return serviceToolNames(service, db).some(n => toolInProfile(n, 'core')) ? 'core' : 'full';
}

/* ── tools/list wire trim (W1, #105) ──────────────────────────────────────── */

const LIST_TOOLS_METHOD = 'tools/list';
const WIRE_TRIMMED = Symbol.for('d365fo.mcp.toolsListWireTrimmed');

/**
 * Two keys the SDK's Zod→JSON-Schema conversion puts on the wire that no client
 * needs, removed from the `tools/list` RESULT — the schemas the server
 * validates against are untouched, because the SDK keeps validating with the
 * Zod objects, never with this JSON:
 *
 *   1. `"$schema":"http://json-schema.org/draft-07/schema#"` on every
 *      inputSchema and outputSchema — 53 B × 126 schemas ≈ 6.6 KB per request,
 *      pure overhead: the MCP `Tool` type already fixes the dialect.
 *   2. `"id":"<name>"` inside every `definitions` entry. Zod emits it for a
 *      schema registered with `.meta({ id })`, which is how output-schemas.js
 *      shares a row shape between the single and batch branch of a tool as a
 *      `$ref` instead of inlining it twice. The SDK client validates
 *      `structuredContent` with AJV, and AJV REJECTS the draft-04 `id` keyword
 *      (`NOT SUPPORTED: keyword "id", use "$id"`) — so without this strip every
 *      `callTool` on a `$ref` tool would fail on an SDK client. The budget test
 *      round-trips a real `Client.callTool` to prove the trim holds.
 *
 * Mechanism: DECORATE the handler McpServer installed, do not replace it — the
 * SDK's listing logic (enabled flag, pipe strategy, `execution`) stays its own.
 * `Protocol` keeps handlers in `_requestHandlers` (a Map keyed by method); if a
 * future SDK moves it, this is a no-op and the budget test's wire-facts
 * assertion (`$schema` 0, `id` 0) is what fails, loudly.
 */
export function trimToolsListWire(server) {
  const proto = server?.server;
  const handlers = proto?._requestHandlers;
  if (!(handlers instanceof Map) || proto[WIRE_TRIMMED]) return false;
  const original = handlers.get(LIST_TOOLS_METHOD);
  if (typeof original !== 'function') return false;
  handlers.set(LIST_TOOLS_METHOD, async (request, extra) => {
    const result = await original(request, extra);
    for (const tool of result?.tools ?? []) {
      for (const schema of [tool.inputSchema, tool.outputSchema]) {
        if (!schema || typeof schema !== 'object') continue;
        delete schema.$schema;
        for (const def of Object.values(schema.definitions ?? {})) {
          if (def && typeof def === 'object') delete def.id;
        }
      }
    }
    return result;
  });
  proto[WIRE_TRIMMED] = true;
  return true;
}

/** Register every tool set of one service onto `server`, under the request's policy. */
export function registerServiceTools(service, server, db) {
  const sets = TOOL_SETS[service];
  if (!sets) throw new Error(`Unknown MCP service "${service}" — expected one of ${Object.keys(TOOL_SETS).join(', ')}`);
  const view = withRegistrationPolicy(server, { service, db, profile: effectiveProfile(service, db) });
  for (const register of sets) register(view, db);
  // McpServer installs its tools/list handler on the first registerTool, so the
  // trim can only be attached now — after the sets — and only on a real server
  // (the test mocks have no `.server`).
  trimToolsListWire(server);
  // Snapshot-scoped catalogues as MCP resources (W5.B). No-op on a server
  // without registerResource (the test mocks). `tool_count` is read lazily so
  // the snapshot resource reports what this request actually registered.
  view.resources = registerResources(view, { db, service, toolCount: () => view.toolSetStats.registered });
  return view.toolSetStats;
}

export const registerAllKbTools = (server, db) => registerServiceTools('kb', server, db);
export const registerAllXrefTools = (server, db) => registerServiceTools('xref', server, db);
export const registerAllSecTools = (server, db) => registerServiceTools('sec', server, db);
export const registerAllTaskRecorderTools = (server) => registerServiceTools('taskrecorder', server);
