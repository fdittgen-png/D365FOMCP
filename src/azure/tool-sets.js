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

/** @type {Readonly<Record<'kb'|'xref'|'sec'|'taskrecorder', ReadonlyArray<(server: any, db?: any) => void>>>} */
export const TOOL_SETS = Object.freeze({
  kb: Object.freeze([registerKbTools, registerIsvKbTools, registerCustomFieldTools]),
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
    return server.registerTool(name, config, handler);
  };
  return view;
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

/** Register every tool set of one service onto `server`, under the request's policy. */
export function registerServiceTools(service, server, db) {
  const sets = TOOL_SETS[service];
  if (!sets) throw new Error(`Unknown MCP service "${service}" — expected one of ${Object.keys(TOOL_SETS).join(', ')}`);
  const view = withRegistrationPolicy(server, { service, db, profile: effectiveProfile(service, db) });
  for (const register of sets) register(view, db);
  return view.toolSetStats;
}

export const registerAllKbTools = (server, db) => registerServiceTools('kb', server, db);
export const registerAllXrefTools = (server, db) => registerServiceTools('xref', server, db);
export const registerAllSecTools = (server, db) => registerServiceTools('sec', server, db);
export const registerAllTaskRecorderTools = (server) => registerServiceTools('taskrecorder', server);
