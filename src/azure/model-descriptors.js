/**
 * D365FO model descriptor reader.
 *
 * Every metadata root scanned by the DB builders carries the build provenance
 * of its models in `<root>/<Package>/Descriptor/<Model>.xml` (AxModelInfo):
 * publisher, layer, and the four-part version (VersionMajor.VersionMinor.
 * VersionBuild.VersionRevision). The builders persist these into a
 * `model_versions` table so every MCP service can answer "which build was
 * this data scanned from?" and callers can scope queries to specific models
 * (Microsoft application, an ISV model, or a customization like iExtension).
 *
 * Used by build/build-kb.js, build/build-xref-db.js, and src/azure/sec-builder.js.
 */

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { XMLParser } from 'fast-xml-parser';

/** AX metadata layer ids as written in AxModelInfo <Layer>. */
const LAYER_NAMES = [
  'SYS', 'SYP', 'GLS', 'GLP', 'FPK', 'FPP', 'SLN', 'SLP',
  'ISV', 'ISP', 'VAR', 'VAP', 'CUS', 'CUP', 'USR', 'USP',
];

/**
 * Classify a model's origin from its metadata layer:
 *   SYS..SLP (0-7)  -> 'microsoft' (the standard application + MS patch layers)
 *   ISV/ISP  (8-9)  -> 'isv'
 *   VAR..USP (10-15)-> 'custom'    (partner/customer layers, e.g. iExtension)
 * When the layer is missing, fall back to the publisher string.
 */
export function classifyOrigin(layer, publisher) {
  if (Number.isInteger(layer) && layer >= 0 && layer <= 15) {
    if (layer <= 7) return 'microsoft';
    if (layer <= 9) return 'isv';
    return 'custom';
  }
  if (publisher && /microsoft/i.test(publisher)) return 'microsoft';
  return 'unknown';
}

/** Map a numeric layer id to its AX layer name (SYS, ISV, USR, ...). */
export function layerName(layer) {
  return Number.isInteger(layer) && layer >= 0 && layer < LAYER_NAMES.length
    ? LAYER_NAMES[layer]
    : null;
}

function toInt(v) {
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

/**
 * Parse one AxModelInfo descriptor XML string.
 *
 * @param {string} xmlContent  Raw descriptor XML.
 * @returns {{model_name:string, module_id:string|null, display_name:string|null,
 *            publisher:string|null, layer:string|null, origin:string,
 *            version:string|null}|null}
 *          null when the content is not a parseable AxModelInfo document.
 */
export function parseModelDescriptor(xmlContent) {
  let doc;
  try {
    doc = new XMLParser({ ignoreAttributes: true }).parse(xmlContent);
  } catch {
    return null;
  }
  const info = doc?.AxModelInfo;
  if (!info || typeof info !== 'object') return null;
  const name = info.Name != null ? String(info.Name).trim() : '';
  if (!name) return null;

  const layer = toInt(info.Layer);
  const major = toInt(info.VersionMajor);
  const minor = toInt(info.VersionMinor);
  const build = toInt(info.VersionBuild);
  const revision = toInt(info.VersionRevision);
  const version = [major, minor, build, revision].every(v => v !== null)
    ? `${major}.${minor}.${build}.${revision}`
    : null;
  const publisher = info.Publisher != null && String(info.Publisher).trim() !== ''
    ? String(info.Publisher).trim()
    : null;

  return {
    model_name: name,
    module_id: info.ModelModule != null && String(info.ModelModule).trim() !== ''
      ? String(info.ModelModule).trim()
      : null,
    display_name: info.DisplayName != null && String(info.DisplayName).trim() !== ''
      ? String(info.DisplayName).trim()
      : null,
    publisher,
    layer: layerName(layer),
    origin: classifyOrigin(layer, publisher),
    version,
  };
}

/** Find a direct child directory named Descriptor (case-insensitive — AOT
 *  dirs are stored with inconsistent casing, like the builders' findAxDirs()). */
function findDescriptorDir(dirPath) {
  let entries;
  try {
    entries = readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return null;
  }
  const hit = entries.find(e => e.isDirectory() && e.name.toLowerCase() === 'descriptor');
  return hit ? join(dirPath, hit.name) : null;
}

/**
 * Scan metadata roots for model descriptors.
 *
 * Layouts handled:
 *   1. `<root>/<Package>/Descriptor/<Model>.xml` — the Microsoft
 *      PackagesLocalDirectory shape (packages under the root).
 *   2. `<root>/Descriptor/<Model>.xml` — a root that IS a single package,
 *      e.g. KB_PACKAGES_PATHS entries pointing straight at a model folder
 *      like C:\Workspace\DEV\Metadata\iExtension.
 *
 * @param {string[]} packagesPaths  Metadata roots to scan.
 * @param {(msg:string)=>void} [warn]  Warning sink (defaults to console.warn).
 * @returns {Array<{model_name, module_id, display_name, publisher, layer,
 *                  origin, version, source_root, descriptor_path}>}
 *          One row per descriptor found. `module_id` falls back to the package
 *          directory name when the descriptor omits <ModelModule>, so it always
 *          matches the per-row module attribution the builders derive from paths.
 */
export function readModelDescriptors(packagesPaths, warn = (m) => console.warn('Warning:', m)) {
  const rows = [];
  const seen = new Set();
  for (const root of packagesPaths || []) {
    let packages;
    try {
      packages = readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory());
    } catch (err) {
      warn(`descriptor scan skipped root ${root}: ${err.message}`);
      continue;
    }
    // Layout 2: the root itself is a package (Descriptor directly under it).
    // The root's own basename is the package-name fallback.
    const candidates = packages.map(p => ({ path: join(root, p.name), name: p.name }));
    if (packages.some(p => p.name.toLowerCase() === 'descriptor')) {
      const rootName = root.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
      candidates.unshift({ path: root, name: rootName });
    }
    for (const pkg of candidates) {
      const descPath = findDescriptorDir(pkg.path);
      if (!descPath) continue;
      let files;
      try {
        files = readdirSync(descPath).filter(f => f.toLowerCase().endsWith('.xml'));
      } catch {
        continue;
      }
      for (const file of files) {
        const filePath = join(descPath, file);
        let content;
        try {
          content = readFileSync(filePath, 'utf-8');
        } catch (err) {
          warn(`descriptor unreadable ${filePath}: ${err.message}`);
          continue;
        }
        const parsed = parseModelDescriptor(content);
        if (!parsed) {
          warn(`descriptor not parseable as AxModelInfo: ${filePath}`);
          continue;
        }
        // A model can only be deployed once; if the same model name shows up
        // under two roots (e.g. a source tree next to the deployed package),
        // the first root listed wins — roots are listed most-authoritative first.
        const key = parsed.model_name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({
          ...parsed,
          module_id: parsed.module_id || pkg.name,
          source_root: root,
          descriptor_path: filePath,
        });
      }
    }
  }
  return rows;
}

/** DDL for the shared provenance table — identical in all three databases. */
export const MODEL_VERSIONS_SCHEMA = `
CREATE TABLE IF NOT EXISTS model_versions (
  model_name       TEXT PRIMARY KEY,
  module_id        TEXT,
  display_name     TEXT,
  publisher        TEXT,
  layer            TEXT,
  origin           TEXT,
  version          TEXT,
  source_root      TEXT,
  indexed_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_model_versions_module ON model_versions(module_id COLLATE NOCASE);
`;

/**
 * Columns added to `model_versions` after its first release, with the DDL that
 * adds each one to an EXISTING database. `CREATE TABLE IF NOT EXISTS` never
 * alters a table that is already there, so every path that writes into a
 * database it did not create (the KB delta merge, the XRef module delta)
 * calls `ensureModelVersionsColumns()` first.
 *
 *   indexed_at (#86 item 1) — ISO timestamp of the build/delta that last wrote
 *   the row. A full build stamps every model with the same instant; a delta
 *   moves only the compiled models forward, which is exactly the per-model
 *   freshness the whole-DB `build_date` cannot express.
 */
export const MODEL_VERSIONS_OPTIONAL_COLUMNS = Object.freeze([
  { name: 'indexed_at', ddl: 'ALTER TABLE model_versions ADD COLUMN indexed_at TEXT' },
]);

/**
 * Add any missing optional column to an existing `model_versions` table
 * (better-sqlite3 handle). No-op when the table is absent or already current.
 * Returns the names of the columns added.
 *
 * @param {{ prepare(sql: string): { all(...p: any[]): any[] }, exec(sql: string): any }} db
 * @param {string} [schema] attached-database prefix (`'main'`), default main
 * @returns {string[]}
 */
export function ensureModelVersionsColumns(db, schema = 'main') {
  const added = [];
  /** @type {any[]} */
  let cols;
  try {
    cols = db.prepare(`PRAGMA ${schema}.table_info(model_versions)`).all();
  } catch {
    return added;
  }
  if (!cols.length) return added; // table absent — the caller creates it from MODEL_VERSIONS_SCHEMA
  const have = new Set(cols.map(c => String(c.name).toLowerCase()));
  for (const col of MODEL_VERSIONS_OPTIONAL_COLUMNS) {
    if (have.has(col.name)) continue;
    db.exec(col.ddl.replace('ALTER TABLE model_versions', `ALTER TABLE ${schema}.model_versions`));
    added.push(col.name);
  }
  return added;
}

/**
 * Insert descriptor rows via a caller-supplied runner so both better-sqlite3
 * (`stmt.run`) and sql.js (`db.run(sql, params)`) builders can share it.
 *
 * Every row is stamped with `indexed_at` — one instant per call (the build),
 * overridable for tests or for a merge that wants to keep the delta's stamp.
 *
 * @param {(sql:string, params:any[])=>void} run  Statement executor.
 * @param {Array<Record<string, any>>} rows  readModelDescriptors() rows
 * @param {{ indexedAt?: string }} [opts]
 */
export function insertModelVersions(run, rows, { indexedAt = new Date().toISOString() } = {}) {
  for (const r of rows) {
    run(
      `INSERT OR REPLACE INTO model_versions
       (model_name, module_id, display_name, publisher, layer, origin, version, source_root, indexed_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [r.model_name, r.module_id, r.display_name, r.publisher, r.layer, r.origin, r.version, r.source_root, r.indexed_at ?? indexedAt],
    );
  }
}
