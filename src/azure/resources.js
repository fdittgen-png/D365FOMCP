/**
 * resources.js — MCP resources for snapshot-scoped catalogues (W5.B, #109 part B).
 *
 * A tool response is paid per call; a resource is fetched when the client
 * wants it and is not part of the tool list. Two catalogues qualify today, both
 * small, both JSON:
 *
 *   d365://snapshot   what this server is serving: service, build date, schema
 *                     version, model count, tool count (after the profile),
 *                     whether sealed-ISV tables are present. The natural home
 *                     for the freshness signal of #86 — one read answers "how
 *                     old is this and what is in it" without a tool call.
 *   d365://modules    the `model_versions` provenance list (the 37 KB that
 *                     `d365_list_modules` ships by default). KB / XRef / Sec.
 *
 * NOT exposed: `d365://sql-templates`. The SQL of `d365_sql_template` is inline
 * in kb-tools.js (no shared function to call), and duplicating a query into a
 * second place is exactly the drift this repo's single-source rules exist to
 * prevent. It becomes a resource once the tool's query is lifted into a
 * function both can call — a kb-tools.js change, outside this module.
 *
 * Everything here is read-only, degrades to nulls / empty arrays on a database
 * that predates a table, and never throws into the SDK: a resource read that
 * fails returns `{ error }` JSON rather than a protocol error.
 *
 * Registered on the registration path (tool-sets.js) so every entry point gets
 * them; a mock server without `registerResource` is a silent no-op.
 */

import { query, queryModelVersions, snapshotDate, readBuildDate } from './shared.js';
import { hasIsvData } from './isv-schema.js';

export const RESOURCE_URIS = Object.freeze({
  snapshot: 'd365://snapshot',
  modules: 'd365://modules',
});

const MIME = 'application/json';

function metaValue(db, key) {
  if (!db || typeof db.prepare !== 'function') return null;
  for (const table of ['kb_metadata', 'xref_metadata', 'sec_metadata']) {
    try {
      const row = db.prepare(`SELECT value FROM ${table} WHERE key = ?`).get(key);
      if (row?.value != null) return String(row.value);
    } catch { /* table absent on this service */ }
  }
  return null;
}

function safeModelVersions(db) {
  if (!db) return [];
  try { return queryModelVersions((sql, params = []) => query(db, sql, params)); } catch { return []; }
}

function safeIsv(db) {
  if (!db) return false;
  try { return hasIsvData(db) === true; } catch { return false; }
}

/**
 * The `d365://snapshot` document. Pure apart from the reads; safe on any db.
 * @param {{ db?: any, service?: string, toolCount?: number | (() => number) | null }} [opts]
 */
export function snapshotInfo({ db = null, service = undefined, toolCount = null } = {}) {
  const built = db ? readBuildDate(db) : null;
  return {
    service,
    build_date: built ? built.toISOString() : null,
    snapshot_date: db ? snapshotDate(db) : null,
    schema_version: metaValue(db, 'schema_version'),
    model_count: safeModelVersions(db).length,
    tool_count: typeof toolCount === 'function' ? toolCount() : toolCount,
    isv_scanned: safeIsv(db),
  };
}

/**
 * The `d365://modules` document.
 * @param {{ db?: any, service?: string }} [opts]
 */
export function modulesInfo({ db = null, service = undefined } = {}) {
  const models = safeModelVersions(db);
  return {
    service,
    snapshot_date: db ? snapshotDate(db) : null,
    model_count: models.length,
    models,
  };
}

function jsonContents(uri, build) {
  let text;
  try { text = JSON.stringify(build()); } catch (err) { text = JSON.stringify({ error: 'resource-read-failed', resource: String(uri) }); console.error(`[resources] ${uri}: ${err?.message ?? err}`); }
  return { contents: [{ uri: String(uri), mimeType: MIME, text }] };
}

/**
 * Register the resources of one service. Returns the URIs registered.
 *
 * @param {any} server  McpServer (or a prototype-chained view of one).
 * @param {{ db?: any, service?: string, toolCount?: number | (() => number) | null }} [opts]
 */
export function registerResources(server, { db = null, service = 'snapshot', toolCount = null } = {}) {
  if (!server || typeof server.registerResource !== 'function') return [];
  const registered = [];

  server.registerResource(
    'snapshot',
    RESOURCE_URIS.snapshot,
    {
      title: 'Snapshot',
      description: `What this ${service} server serves: build date, schema version, model and tool counts, ISV scan state.`,
      mimeType: MIME,
    },
    (uri) => jsonContents(uri, () => snapshotInfo({ db, service, toolCount })),
  );
  registered.push(RESOURCE_URIS.snapshot);

  if (db) {
    server.registerResource(
      'modules',
      RESOURCE_URIS.modules,
      {
        title: 'Scanned models',
        description: 'Per-model build provenance (model_versions): name, module, publisher, layer, origin, version.',
        mimeType: MIME,
      },
      (uri) => jsonContents(uri, () => modulesInfo({ db, service })),
    );
    registered.push(RESOURCE_URIS.modules);
  }

  return registered;
}
