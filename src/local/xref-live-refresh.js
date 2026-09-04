/**
 * XREF_LIVE (#129) — fresh cross-references for the LOCAL stdio XRef server.
 *
 * What it is: when `XREF_LIVE=1`, the server resolves the ACTIVE Visual Studio
 * XPP configuration (the same registry key `local-deploy/Refresh-McpData.ps1`
 * reads — never `.env`, which can name an XRef database two platform versions
 * old) and launches `build/update-xref-module.js` detached for the custom
 * modules, so the snapshot converges on the live `DYNAMICSXREFDB` within the
 * first minutes of a session (measured 1m43s for iExtension) without the client
 * waiting on startup. SQLite readers see each committed module as it lands.
 *
 * What it is NOT: a per-query bridge to SQL Server. better-sqlite3 is
 * synchronous and every handler queries the SQLite shape (`names/refs/
 * modules`); translating each tool's SQL to T-SQL per request is the follow-up
 * recorded on #129, not this file. Azure never runs this — the Function App has
 * no LocalDB and stays on the weekly snapshot.
 *
 * Everything that touches the machine is injectable so the selection logic is
 * unit-tested without a registry, a SQL Server or a child process.
 */

import { spawn as nodeSpawn, execSync as nodeExecSync } from 'child_process';
import { readFileSync as nodeReadFileSync, existsSync as nodeExistsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

export const XREF_CONFIG_REG_KEY = 'HKCU\\SOFTWARE\\Microsoft\\Dynamics\\AX7\\Development\\Configurations';
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Parse `reg query ... /v CurrentMetadataConfig` output into the .xppconfig path. */
export function parseRegQueryValue(output) {
  const m = String(output ?? '').match(/CurrentMetadataConfig\s+REG_\w+\s+(.+?)\s*$/m);
  return m ? m[1].trim() : null;
}

/**
 * The active configuration's cross-reference database + server.
 * @param {{ execSync?: any, readFileSync?: any, existsSync?: any }} [deps] test seams
 * @returns {{ configPath: string, database: string, server: string, modelStore: string|null } | null}
 */
export function readActiveXrefConfig({ execSync = nodeExecSync, readFileSync = nodeReadFileSync, existsSync = nodeExistsSync } = {}) {
  let out;
  try {
    out = execSync(`reg query "${XREF_CONFIG_REG_KEY}" /v CurrentMetadataConfig`, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
  const configPath = parseRegQueryValue(out);
  if (!configPath || !existsSync(configPath)) return null;
  let cfg;
  try { cfg = JSON.parse(readFileSync(configPath, 'utf-8')); } catch { return null; }
  const database = cfg?.CrossReferencesDatabaseName;
  if (!database) return null;
  return {
    configPath,
    database: String(database),
    server: String(cfg.CrossReferencesDbServerName || '(LocalDB)\\MSSQLLocalDB'),
    modelStore: cfg.ModelStoreFolder ? String(cfg.ModelStoreFolder) : null,
  };
}

/**
 * Modules worth refreshing: the ones the delta already tracks
 * (`xref_module_sync`), else every model the Descriptor scan marked `custom`.
 * Microsoft and sealed-ISV models change on a platform/ISV upgrade, not on a
 * compile — the weekly full rebuild owns those.
 * @param {any} db better-sqlite3 handle (read-only is fine)
 * @returns {string[]}
 */
export function selectLiveModules(db) {
  const has = (t) => { try { return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t); } catch { return false; } };
  try {
    if (has('xref_module_sync')) {
      /** @type {any[]} */
      const syncedRows = db.prepare('SELECT module FROM xref_module_sync ORDER BY module').all();
      const synced = syncedRows.map(r => String(r.module));
      if (synced.length) return synced;
    }
    if (has('model_versions')) {
      /** @type {any[]} */
      const rows = db.prepare("SELECT DISTINCT COALESCE(module_id, model_name) AS m FROM model_versions WHERE origin = 'custom' AND m IS NOT NULL ORDER BY m").all();
      return rows.map(r => String(r.m));
    }
  } catch { /* fall through */ }
  return [];
}

/**
 * Start the detached refresh. Returns `{ started: true, … }` describing what was
 * launched, or `{ started: false, reason }` when nothing could be (no flag, no
 * active configuration, no modules).
 * @param {{ db?: any, dbPath?: string, env?: any, log?: (msg: string) => void,
 *           spawn?: any, readConfig?: () => any, selectModules?: (db: any) => string[],
 *           nodeBin?: string, repoRoot?: string }} [opts]
 * @returns {{ started: boolean, reason?: string, modules?: string[], database?: string,
 *             server?: string, pid?: number|null, args?: string[] }}
 */
export function startLiveRefresh({
  db, dbPath, env = process.env, log = () => {},
  spawn = nodeSpawn, readConfig = readActiveXrefConfig, selectModules = selectLiveModules,
  nodeBin = process.execPath, repoRoot = REPO_ROOT,
} = {}) {
  if (env.XREF_LIVE !== '1') return { started: false, reason: 'XREF_LIVE is not 1' };
  const cfg = readConfig();
  if (!cfg) return { started: false, reason: 'no active XPP configuration (CurrentMetadataConfig) or it names no CrossReferencesDatabaseName' };
  const modules = env.XREF_LIVE_MODULES
    ? String(env.XREF_LIVE_MODULES).split(',').map(s => s.trim()).filter(Boolean)
    : selectModules(db);
  if (!modules.length) return { started: false, reason: 'no custom modules to refresh (set XREF_LIVE_MODULES=Model1,Model2)', database: cfg.database };

  const script = join(repoRoot, 'build', 'update-xref-module.js');
  const args = [script, ...modules, `--database=${cfg.database}`, `--server=${cfg.server}`, `--db=${dbPath}`];
  const child = spawn(nodeBin, args, { detached: true, stdio: 'ignore', windowsHide: true, cwd: repoRoot });
  child.unref?.();
  log(`XREF_LIVE: refreshing ${modules.join(', ')} from ${cfg.server}/${cfg.database} in the background (pid ${child.pid ?? '?'})`);
  return { started: true, modules, database: cfg.database, server: cfg.server, pid: child.pid ?? null, args };
}
