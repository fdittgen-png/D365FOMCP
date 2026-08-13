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

/**
 * Scan metadata roots for model descriptors.
 *
 * Layout handled: `<root>/<Package>/Descriptor/<Model>.xml` — this covers both
 * the Microsoft PackagesLocalDirectory and customization metadata roots
 * (e.g. C:\Workspace\DEV\Metadata\iExtension\Descriptor\iExtension.xml).
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
    for (const pkg of packages) {
      const pkgPath = join(root, pkg.name);
      let entries;
      try {
        entries = readdirSync(pkgPath, { withFileTypes: true });
      } catch {
        continue;
      }
      // AOT dirs are stored with inconsistent casing across models — match
      // Descriptor case-insensitively like the builders' findAxDirs() does.
      const descDir = entries.find(e => e.isDirectory() && e.name.toLowerCase() === 'descriptor');
      if (!descDir) continue;
      const descPath = join(pkgPath, descDir.name);
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
  source_root      TEXT
);
CREATE INDEX IF NOT EXISTS idx_model_versions_module ON model_versions(module_id COLLATE NOCASE);
`;

/**
 * Insert descriptor rows via a caller-supplied runner so both better-sqlite3
 * (`stmt.run`) and sql.js (`db.run(sql, params)`) builders can share it.
 *
 * @param {(sql:string, params:any[])=>void} run  Statement executor.
 * @param {ReturnType<typeof readModelDescriptors>} rows
 */
export function insertModelVersions(run, rows) {
  for (const r of rows) {
    run(
      `INSERT OR REPLACE INTO model_versions
       (model_name, module_id, display_name, publisher, layer, origin, version, source_root)
       VALUES (?,?,?,?,?,?,?,?)`,
      [r.model_name, r.module_id, r.display_name, r.publisher, r.layer, r.origin, r.version, r.source_root],
    );
  }
}
