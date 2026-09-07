/**
 * ERP and MCP identity for the envelope (TDD §5.1, WI-09 D365FO adapter).
 * `erp.version` = ApplicationSuite model version, `erp.build` = ApplicationPlatform,
 * from `model_versions`; `mcp.snapshot_date` from the build date. Cached per db
 * handle. The env names are the ones `semantic-store.js` already uses.
 */
import { queryModelVersions, snapshotDate } from '../../azure/shared.js';
import { packageVersion } from '../../azure/server-metadata.js';

const cache = new WeakMap();
const NO_DB = {};

function modelVersion(db, name) {
  try {
    const row = queryModelVersions(db).find((m) => String(m.model_name ?? '').toLowerCase() === name.toLowerCase());
    const v = row?.version;
    return typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(v) ? `v${v}`.replace(/^vv/, 'v') : null;
  } catch {
    return null;
  }
}

/** `{ erp: { system, installation_id, version?, build? }, mcp: { service, version, snapshot_date? } }` */
export function traceIdentity(service, db = null) {
  const key = db && typeof db === 'object' ? db : NO_DB;
  let byService = cache.get(key);
  if (!byService) { byService = new Map(); cache.set(key, byService); }
  if (byService.has(service)) return byService.get(service);

  const erp = {
    system: process.env.MCP_ERP_SYSTEM || 'D365FO',
    installation_id: process.env.MCP_INSTALLATION_ID || 'local',
  };
  const version = process.env.MCP_ERP_VERSION || (db ? modelVersion(db, 'ApplicationSuite') : null);
  const build = db ? modelVersion(db, 'ApplicationPlatform') : null;
  if (version) erp.version = version;
  if (build) erp.build = build;
  const mcp = { service, version: `v${packageVersion()}` };
  const snap = db ? snapshotDate(db) : null;
  if (snap) mcp.snapshot_date = snap;
  const id = Object.freeze({ erp: Object.freeze(erp), mcp: Object.freeze(mcp) });
  byService.set(service, id);
  return id;
}
