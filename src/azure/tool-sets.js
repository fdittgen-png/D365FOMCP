/**
 * Tool sets — the single source of truth for WHICH register*Tools() functions
 * each MCP server registers, and in which order.
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

/** @type {Readonly<Record<'kb'|'xref'|'sec'|'taskrecorder', ReadonlyArray<(server: any, db?: any) => void>>>} */
export const TOOL_SETS = Object.freeze({
  kb: Object.freeze([registerKbTools, registerIsvKbTools, registerCustomFieldTools]),
  xref: Object.freeze([registerXrefTools, registerIsvXrefTools]),
  sec: Object.freeze([registerSecTools]),
  // Task Recorder tools take no database; the extra argument is ignored.
  taskrecorder: Object.freeze([registerTaskRecorderTools]),
});

/** Register every tool set of one service onto `server`. */
export function registerServiceTools(service, server, db) {
  const sets = TOOL_SETS[service];
  if (!sets) throw new Error(`Unknown MCP service "${service}" — expected one of ${Object.keys(TOOL_SETS).join(', ')}`);
  for (const register of sets) register(server, db);
}

export const registerAllKbTools = (server, db) => registerServiceTools('kb', server, db);
export const registerAllXrefTools = (server, db) => registerServiceTools('xref', server, db);
export const registerAllSecTools = (server, db) => registerServiceTools('sec', server, db);
export const registerAllTaskRecorderTools = (server) => registerServiceTools('taskrecorder', server);
