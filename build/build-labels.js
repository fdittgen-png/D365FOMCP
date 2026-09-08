/**
 * d365fo_labels.sqlite builder — the data behind the `d365fo-labels` MCP service
 * (docs/Labels-Service-Concept-2026-09-08.md §3.1, §3.4).
 *
 * Why its own file and its own builder: 76 language folders × ~383k label ids is
 * 25–29M rows — 100× the KB's en-US label footprint and too many for the sql.js
 * in-memory path build-kb.js uses. This builder writes with better-sqlite3
 * directly, file by file, in one transaction per label file.
 *
 * Schema (schema_version 1.0):
 *   label_meta      one row per label id: file, module, origin, DESCRIPTION (stored
 *                   once — measured identical across every language file)
 *   labels          one row per (id, language): text            [rowid kept for FTS]
 *   labels_fts      FTS5 external-content index on labels.text, kept in sync by
 *                   triggers so the per-model delta needs no rebuild
 *   label_languages / label_files   the inventory the tools report as coverage
 *   labels_metadata                 build_date, schema_version, languages, counts,
 *                                   partial_build (delta only)
 *   model_versions                  same table as the KB/XRef/Sec (provenance)
 *
 * Three entry points:
 *   buildLabelsDb()          full build (CLI: node build/build-labels.js)
 *   refreshLabelsModules()   per-model delta — DELETE the module's rows, re-insert,
 *                            stamp partial_build (build/update-labels-model.js)
 *   refreshLabelsAfterKb()   the non-fatal hook build:kb calls last; LABELS_SCAN=off
 *                            skips it, LABELS_DB_PATH / LABELS_LANGUAGES configure it
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync, unlinkSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readModelDescriptors, insertModelVersions, MODEL_VERSIONS_SCHEMA } from '../src/azure/model-descriptors.js';
import { findLabelFiles, parseLabelFile, canonicalLabelId } from './label-files.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

export const LABELS_SCHEMA_VERSION = '1.0';

export const DEFAULT_LABELS_DB = () => join(process.env.USERPROFILE || process.env.HOME || '.', '.claude', 'd365fo_labels.sqlite');

/** Tables only — indexes, FTS and triggers are added after the bulk insert (finalizeSchema). */
export const LABELS_SCHEMA = `
CREATE TABLE IF NOT EXISTS label_meta (
  label_id    TEXT PRIMARY KEY,
  label_file  TEXT NOT NULL,
  module      TEXT NOT NULL,
  origin      TEXT NOT NULL,
  description TEXT
);
CREATE TABLE IF NOT EXISTS labels (
  label_id TEXT NOT NULL,
  language TEXT NOT NULL,
  text     TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_labels_id_lang ON labels(label_id, language);
CREATE TABLE IF NOT EXISTS label_languages (
  language    TEXT PRIMARY KEY,
  label_count INTEGER NOT NULL,
  file_count  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS label_files (
  label_file        TEXT NOT NULL,
  language          TEXT NOT NULL,
  module            TEXT NOT NULL,
  path              TEXT,
  label_count       INTEGER NOT NULL,
  description_count INTEGER NOT NULL,
  PRIMARY KEY (label_file, language)
);
CREATE TABLE IF NOT EXISTS labels_metadata (key TEXT PRIMARY KEY, value TEXT);
${MODEL_VERSIONS_SCHEMA}
`;

/** Indexes + FTS + the triggers that keep the FTS in sync with labels. */
export const LABELS_FINALIZE = `
CREATE INDEX IF NOT EXISTS idx_label_meta_module ON label_meta(module COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_label_meta_file   ON label_meta(label_file COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_labels_lang       ON labels(language COLLATE NOCASE);
CREATE VIRTUAL TABLE IF NOT EXISTS labels_fts USING fts5(text, content='labels', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER IF NOT EXISTS labels_ai AFTER INSERT ON labels BEGIN
  INSERT INTO labels_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER IF NOT EXISTS labels_ad AFTER DELETE ON labels BEGIN
  INSERT INTO labels_fts(labels_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;
CREATE TRIGGER IF NOT EXISTS labels_au AFTER UPDATE ON labels BEGIN
  INSERT INTO labels_fts(labels_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO labels_fts(rowid, text) VALUES (new.rowid, new.text);
END;
`;

/* ── helpers ──────────────────────────────────────────────────────────────── */

export function parseLanguages(raw) {
  if (Array.isArray(raw)) return raw.length ? raw.map(String) : 'all';
  const s = String(raw ?? '').trim();
  if (!s || s.toLowerCase() === 'all') return 'all';
  return s.split(/[,;]/).map(x => x.trim()).filter(Boolean);
}

export function parsePathList(raw) {
  return String(raw ?? '').split(/[,;]/).map(s => s.trim()).filter(Boolean);
}

function languageFilter(languages) {
  if (languages === 'all') return () => true;
  const wanted = new Set(languages.map(l => l.toLowerCase()));
  return (lang) => wanted.has(String(lang).toLowerCase());
}

/** model_name (and lower-case) → origin, from the Descriptor XML of every model. */
function originIndex(descriptorRows) {
  const m = new Map();
  for (const r of descriptorRows) {
    if (r.model_name) m.set(r.model_name.toLowerCase(), r.origin || 'custom');
  }
  return (module) => m.get(String(module ?? '').toLowerCase()) ?? 'custom';
}

function prepare(db) {
  return {
    insLabel: db.prepare('INSERT OR REPLACE INTO labels (label_id, language, text) VALUES (?, ?, ?)'),
    insMeta: db.prepare('INSERT OR REPLACE INTO label_meta (label_id, label_file, module, origin, description) VALUES (?, ?, ?, ?, ?)'),
    insFile: db.prepare('INSERT OR REPLACE INTO label_files (label_file, language, module, path, label_count, description_count) VALUES (?, ?, ?, ?, ?, ?)'),
  };
}

/**
 * Ingest a list of label files. `meta` is the per-id accumulator (Map id →
 * {label_file, module, origin, description}); the description is taken from
 * the first file that has one and disagreements are counted, never overwritten.
 */
function ingestFiles(db, files, originOf, meta, stats, warn) {
  const st = prepare(db);
  const perFile = db.transaction((f, parsed) => {
    for (const l of parsed.labels) {
      const id = canonicalLabelId(l.key, f.prefix);
      if (!id) continue;
      st.insLabel.run(id, f.language, l.text);
      const cur = meta.get(id);
      if (!cur) {
        meta.set(id, { label_file: f.prefix, module: f.module ?? f.package ?? 'Unknown', origin: originOf(f.module), description: l.description });
      } else if (l.description) {
        if (cur.description == null) cur.description = l.description;
        else if (cur.description !== l.description) stats.description_disagreements++;
      }
    }
    st.insFile.run(f.prefix, f.language, f.module ?? f.package ?? 'Unknown', f.path, parsed.stats.labels, parsed.stats.descriptions);
  });
  for (const f of files) {
    let text;
    try { text = readFileSync(f.path, 'utf8'); } catch (e) { warn(`${f.path}: ${e.message}`); continue; }
    const parsed = parseLabelFile(text);
    perFile(f, parsed);
    stats.files++;
    stats.labels += parsed.stats.labels;
    stats.orphan_descriptions += parsed.stats.orphan_descriptions;
    stats.duplicate_keys += parsed.stats.duplicate_keys;
  }
}

function writeMeta(db, meta) {
  const st = prepare(db);
  const tx = db.transaction(() => {
    for (const [id, m] of meta) st.insMeta.run(id, m.label_file, m.module, m.origin, m.description ?? null);
  });
  tx();
}

/** Recompute label_languages from labels/label_files (cheap: GROUP BY over indexed columns). */
function refreshLanguageInventory(db) {
  db.exec(`DELETE FROM label_languages;
    INSERT INTO label_languages (language, label_count, file_count)
    SELECT l.language, COUNT(*), (SELECT COUNT(*) FROM label_files lf WHERE lf.language = l.language)
    FROM labels l GROUP BY l.language;`);
}

function writeCounts(db, extra = {}) {
  const set = db.prepare('INSERT OR REPLACE INTO labels_metadata (key, value) VALUES (?, ?)');
  const n = (sql) => String(db.prepare(sql).get().n);
  const tx = db.transaction(() => {
    set.run('label_count', n('SELECT COUNT(*) n FROM labels'));
    set.run('meta_count', n('SELECT COUNT(*) n FROM label_meta'));
    set.run('language_count', n('SELECT COUNT(*) n FROM label_languages'));
    for (const [k, v] of Object.entries(extra)) if (v !== undefined) set.run(k, String(v));
  });
  tx();
}

async function ingestIsvLabels(db, isvRoots, meta, stats, log, warn) {
  if (!isvRoots || !isvRoots.length) return;
  try {
    // Lazy: isv-scan pulls in the .md/.xref decoders, only needed here.
    const { scanSealedModels } = await import('./isv-scan.js');
    const models = scanSealedModels(isvRoots, warn);
    const st = prepare(db);
    const tx = db.transaction(() => {
      for (const m of models) {
        for (const l of m.labels) {
          const id = l.qualifiedId || (String(l.labelId).startsWith('@') ? l.labelId : `@${l.labelId}`);
          // A source label file (Microsoft/custom) wins over a sealed store on overlap.
          if (db.prepare('SELECT 1 FROM labels WHERE label_id = ? AND language = ?').get(id, l.language)) continue;
          st.insLabel.run(id, l.language, l.text);
          stats.isv_labels++;
          if (!meta.has(id)) meta.set(id, { label_file: l.labelFile ?? m.model, module: m.model, origin: 'isv', description: null });
        }
      }
    });
    tx();
    stats.isv_models = models.length;
    log(`  sealed ISV: ${models.length} model(s), ${stats.isv_labels.toLocaleString()} label rows`);
  } catch (e) {
    warn(`ISV label pass skipped: ${e.message}`);
  }
}

/* ── full build ───────────────────────────────────────────────────────────── */

/**
 * @param {object} opts
 * @param {string}   opts.outputPath
 * @param {string[]} opts.packagesPaths  metadata roots (Microsoft + custom)
 * @param {string[]} [opts.isvRoots]     sealed-ISV roots (ISV_SCAN_PATHS); [] = skip
 * @param {string[]|'all'} [opts.languages]
 * @param {(m:string)=>void} [opts.log]
 * @param {(m:string)=>void} [opts.warn]
 */
export async function buildLabelsDb({ outputPath, packagesPaths, isvRoots = [], languages = 'all', log = console.log, warn = (m) => console.warn('Warning:', m) } = {}) {
  if (!outputPath) throw new Error('outputPath required');
  const roots = (packagesPaths || []).filter(p => existsSync(p));
  if (!roots.length) throw new Error('No existing packagesPaths — set KB_PACKAGES_PATHS.');
  const langs = parseLanguages(languages);
  const t0 = Date.now();
  const tmp = `${outputPath}.building`;
  for (const p of [tmp, `${tmp}-journal`]) { try { unlinkSync(p); } catch { /* absent */ } }

  const db = new Database(tmp);
  db.pragma('journal_mode = OFF');
  db.pragma('synchronous = OFF');
  db.pragma('temp_store = MEMORY');
  db.pragma('cache_size = -200000');
  db.exec(LABELS_SCHEMA);

  const descriptors = readModelDescriptors(roots, warn);
  insertModelVersions((sql, params) => db.prepare(sql).run(params), descriptors);
  const originOf = originIndex(descriptors);

  const keep = languageFilter(langs);
  const files = roots.flatMap(r => findLabelFiles(r, warn)).filter(f => keep(f.language));
  log(`  ${files.length.toLocaleString()} label file(s) in ${new Set(files.map(f => f.language)).size} language(s) from ${roots.length} root(s)`);

  const stats = { files: 0, labels: 0, orphan_descriptions: 0, duplicate_keys: 0, description_disagreements: 0, isv_labels: 0, isv_models: 0 };
  const meta = new Map();
  ingestFiles(db, files, originOf, meta, stats, warn);
  await ingestIsvLabels(db, isvRoots, meta, stats, log, warn);
  writeMeta(db, meta);
  refreshLanguageInventory(db);

  log('  finalizing indexes + FTS…');
  db.exec(LABELS_FINALIZE);
  db.exec("INSERT INTO labels_fts(labels_fts) VALUES ('rebuild')");

  const set = db.prepare('INSERT OR REPLACE INTO labels_metadata (key, value) VALUES (?, ?)');
  set.run('schema_version', LABELS_SCHEMA_VERSION);
  set.run('build_date', new Date().toISOString());
  set.run('packages_path', roots.join(';'));
  set.run('isv_roots', (isvRoots || []).join(';'));
  set.run('languages', langs === 'all' ? 'all' : langs.join(','));
  set.run('description_disagreements', String(stats.description_disagreements));
  set.run('orphan_descriptions', String(stats.orphan_descriptions));
  set.run('duplicate_keys', String(stats.duplicate_keys));
  set.run('model_versions_count', String(descriptors.length));
  writeCounts(db);
  const summary = {
    labels: db.prepare('SELECT COUNT(*) n FROM labels').get().n,
    meta: meta.size,
    languages: db.prepare('SELECT COUNT(*) n FROM label_languages').get().n,
    files: stats.files,
    disagreements: stats.description_disagreements,
    isv_labels: stats.isv_labels,
  };
  db.pragma('journal_mode = DELETE');
  db.close();

  try { unlinkSync(outputPath); } catch { /* absent */ }
  renameSync(tmp, outputPath);
  summary.seconds = Math.round((Date.now() - t0) / 1000);
  summary.mb = Math.round(statSync(outputPath).size / 1048576);
  summary.outputPath = outputPath;
  log(`  labels DB: ${summary.labels.toLocaleString()} rows / ${summary.meta.toLocaleString()} ids / ${summary.languages} languages → ${outputPath} (${summary.mb} MB, ${summary.seconds}s)`);
  return summary;
}

/* ── per-model delta ──────────────────────────────────────────────────────── */

/**
 * Replace the rows of the named models: every label id owned by the module is
 * deleted (labels + meta + files) and the module's current files re-ingested,
 * in one transaction per module. The FTS follows through the triggers.
 * Stamps `partial_build` — the weekly full build clears it.
 */
export async function refreshLabelsModules({ dbPath = DEFAULT_LABELS_DB(), modules, packagesPaths, log = console.log, warn = (m) => console.warn('Warning:', m) } = {}) {
  if (!modules || !modules.length) throw new Error('No models named.');
  if (!existsSync(dbPath)) throw new Error(`Labels SQLite not found: ${dbPath}. Run \`npm run build:labels\` first — the delta refreshes an existing database.`);
  const roots = (packagesPaths || []).filter(p => existsSync(p));
  if (!roots.length) throw new Error('No existing packagesPaths.');

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  try {
    db.exec(LABELS_FINALIZE); // idempotent — a DB built before a trigger existed gets it now
    const langRaw = db.prepare("SELECT value FROM labels_metadata WHERE key = 'languages'").get()?.value ?? 'all';
    const keep = languageFilter(parseLanguages(langRaw));
    const descriptors = readModelDescriptors(roots, warn);
    insertModelVersions((sql, params) => db.prepare(sql).run(params), descriptors.filter(d => modules.some(m => m.toLowerCase() === String(d.model_name).toLowerCase())));
    const originOf = originIndex(descriptors);
    const allFiles = roots.flatMap(r => findLabelFiles(r, warn));

    const stats = { files: 0, labels: 0, orphan_descriptions: 0, duplicate_keys: 0, description_disagreements: 0, isv_labels: 0, isv_models: 0 };
    const done = [];
    for (const module of modules) {
      const files = allFiles.filter(f => String(f.module).toLowerCase() === module.toLowerCase() && keep(f.language));
      const meta = new Map();
      const tx = db.transaction(() => {
        db.prepare('DELETE FROM labels WHERE label_id IN (SELECT label_id FROM label_meta WHERE module = ? COLLATE NOCASE)').run(module);
        db.prepare('DELETE FROM label_meta WHERE module = ? COLLATE NOCASE').run(module);
        db.prepare('DELETE FROM label_files WHERE module = ? COLLATE NOCASE').run(module);
        ingestFiles(db, files, originOf, meta, stats, warn);
        writeMeta(db, meta);
      });
      tx();
      done.push(module);
      log(`  ${module}: ${files.length} file(s), ${meta.size.toLocaleString()} label id(s) refreshed`);
    }
    refreshLanguageInventory(db);
    writeCounts(db, { partial_build: new Date().toISOString(), last_delta_models: done.join(',') });
    return { modules: done, labels: stats.labels, meta: db.prepare('SELECT COUNT(*) n FROM label_meta').get().n, dbPath };
  } finally {
    try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* best effort */ }
    db.close();
  }
}

/* ── the build:kb hook ────────────────────────────────────────────────────── */

/**
 * Called last by `npm run build:kb` (CLI path only — never from the per-model
 * delta's scoped build). Non-fatal: a labels failure must not fail the KB.
 * `LABELS_SCAN=off` skips; `LABELS_DB_PATH`, `LABELS_LANGUAGES` configure.
 */
export async function refreshLabelsAfterKb({ packagesPaths, isvRoots, log = console.log } = {}) {
  if (String(process.env.LABELS_SCAN ?? '').toLowerCase() === 'off') {
    log('Labels DB refresh skipped (LABELS_SCAN=off).');
    return null;
  }
  const outputPath = process.env.LABELS_DB_PATH || DEFAULT_LABELS_DB();
  log(`\nRefreshing the labels DB (${outputPath})…`);
  try {
    return await buildLabelsDb({
      outputPath,
      packagesPaths,
      isvRoots: isvRoots ?? parsePathList(process.env.ISV_SCAN_PATHS),
      languages: parseLanguages(process.env.LABELS_LANGUAGES),
      log,
    });
  } catch (err) {
    log(`  labels DB refresh FAILED (non-fatal): ${err.message}`);
    return { error: err.message };
  }
}

/* ── CLI ──────────────────────────────────────────────────────────────────── */

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const opt = (name) => { const hit = argv.find(a => a.startsWith(`--${name}=`)); return hit ? hit.slice(name.length + 3) : null; };
  const outputPath = opt('out') || process.env.LABELS_DB_PATH || DEFAULT_LABELS_DB();
  const packagesPaths = parsePathList(opt('packages') || process.env.KB_PACKAGES_PATHS);
  const isvRoots = argv.includes('--no-isv') ? [] : parsePathList(opt('isv') || process.env.ISV_SCAN_PATHS);
  const languages = parseLanguages(opt('languages') || process.env.LABELS_LANGUAGES);
  console.log('Building d365fo_labels.sqlite');
  console.log(`  roots: ${packagesPaths.join(' | ') || '(none — set KB_PACKAGES_PATHS)'}`);
  console.log(`  languages: ${languages === 'all' ? 'all' : languages.join(',')}   isv roots: ${isvRoots.join(' | ') || '(none)'}`);
  buildLabelsDb({ outputPath, packagesPaths, isvRoots, languages }).then(() => process.exit(0)).catch(err => {
    console.error('FATAL ERROR:', err);
    process.exit(1);
  });
}
