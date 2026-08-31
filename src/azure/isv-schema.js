/**
 * Sealed-ISV data schema — shared by the builders and the MCP tools.
 *
 * Some third-party models ship *no* X++ source and *no* `Ax<Type>` metadata XML:
 * the whole model is a `bin/` directory holding a sealed metadata store
 * (`<Model>_Ax<Type>.md`), a cross-reference package (`<Model>.xref`) and a
 * handful of plain-text structural descriptors. On the reference dev box 17 of
 * 19 non-Microsoft models have that shape (see issue #75).
 *
 * Everything read from those models lands in the `isv_`-prefixed tables defined
 * here and **nowhere else**. No existing table ever receives a sealed-ISV row,
 * so every query that exists today keeps returning exactly what it returns
 * today; participation is opt-in through the `include_isv` tool parameter and
 * the dedicated `d365_isv_*` / `xref_isv_*` tools.
 *
 * Two fidelity levels are recorded and never conflated:
 *   'metadata' — read from `.md` / `.xref` / `.runtime` / `.xml`, i.e. data the
 *                ISV itself shipped in the deployable package. Authoritative.
 *   'il'       — derived from assembly metadata (issue #81). Signatures only;
 *                no method body is ever decompiled or stored.
 *
 * Used by build/isv-scan.js and the KB / XRef tool modules.
 */

/**
 * The registry: one row per sealed model. This is the join point for every
 * other isv_ table and the audit record of what was scanned, from where, when.
 */
export const ISV_MODELS_SCHEMA = `
CREATE TABLE IF NOT EXISTS isv_models (
  model       TEXT PRIMARY KEY,
  publisher   TEXT,
  version     TEXT,
  layer       TEXT,
  source_kind TEXT NOT NULL,
  fidelity    TEXT NOT NULL,
  depends_on  TEXT,
  root        TEXT,
  scanned_at  TEXT,
  counts      TEXT
);`;

/**
 * Element inventory from the sealed `.md` stores (issue #79, phase 1).
 * `blob_size` is the byte length of the element's undecoded property blob —
 * it is a useful "how much is in there" signal and costs nothing to record.
 */
export const ISV_ELEMENTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS isv_elements (
  id           INTEGER PRIMARY KEY,
  module       TEXT NOT NULL,
  element_type TEXT NOT NULL,
  name         TEXT NOT NULL,
  blob_size    INTEGER,
  fidelity     TEXT NOT NULL DEFAULT 'metadata'
);
CREATE INDEX IF NOT EXISTS idx_isv_elements_name ON isv_elements(name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_isv_elements_mod  ON isv_elements(module COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_isv_elements_type ON isv_elements(element_type COLLATE NOCASE);`;

/**
 * Decoded properties from the `.md` TLV payload (issue #79, phase 2).
 * `tag` is the raw property tag as `0xNN` when its meaning is not yet pinned by
 * a fixture test — unknown tags are stored verbatim, never dropped, never
 * guessed at. `prop` carries the resolved name once a tag map confirms it.
 */
export const ISV_ELEMENT_PROPS_SCHEMA = `
CREATE TABLE IF NOT EXISTS isv_element_props (
  element_id INTEGER NOT NULL,
  tag        TEXT NOT NULL,
  prop       TEXT,
  value      TEXT
);
CREATE INDEX IF NOT EXISTS idx_isv_props_el ON isv_element_props(element_id);`;

/**
 * Cross-references from the `<Model>.xref` packages (issue #77).
 *
 * Targets stay *textual* rather than being resolved to `names.id`: the ISV
 * tables must remain independently rebuildable, and the main XRef tables must
 * never be written by this pass. Resolution to a Microsoft object happens at
 * query time.
 */
export const ISV_XREF_SCHEMA = `
CREATE TABLE IF NOT EXISTS isv_names (
  id     INTEGER PRIMARY KEY,
  path   TEXT NOT NULL,
  module TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS isv_refs (
  source_id     INTEGER NOT NULL,
  target_path   TEXT NOT NULL,
  target_module TEXT,
  kind          TEXT,
  line          INTEGER,
  col           INTEGER,
  tool          TEXT
);
CREATE TABLE IF NOT EXISTS isv_module_deps (
  module     TEXT NOT NULL,
  depends_on TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_isv_names_uq   ON isv_names(module COLLATE NOCASE, path COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_isv_names_path        ON isv_names(path COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_isv_names_module      ON isv_names(module COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_isv_refs_src          ON isv_refs(source_id);
CREATE INDEX IF NOT EXISTS idx_isv_refs_tgt          ON isv_refs(target_path COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_isv_refs_tgt_module   ON isv_refs(target_module COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_isv_deps_module       ON isv_module_deps(module COLLATE NOCASE);`;

/**
 * Structural descriptors from `bin/*.runtime` and `bin/*.xml` (issue #80) —
 * where a sealed ISV injects itself into standard code.
 */
export const ISV_STRUCTURE_SCHEMA = `
CREATE TABLE IF NOT EXISTS isv_coc (
  module          TEXT NOT NULL,
  extension_class TEXT NOT NULL,
  target          TEXT,
  target_type     TEXT,
  method          TEXT,
  is_static       INTEGER
);
CREATE TABLE IF NOT EXISTS isv_event_handlers (
  module                TEXT NOT NULL,
  delegate_element      TEXT,
  delegate_element_type TEXT,
  delegate_method       TEXT,
  handler_element       TEXT,
  handler_element_type  TEXT,
  handler_method        TEXT,
  delegate_type         TEXT
);
CREATE TABLE IF NOT EXISTS isv_extends (
  module TEXT NOT NULL,
  kind   TEXT NOT NULL,
  child  TEXT NOT NULL,
  parent TEXT
);
CREATE TABLE IF NOT EXISTS isv_delete_actions (
  module     TEXT NOT NULL,
  table_name TEXT NOT NULL,
  target     TEXT,
  relation   TEXT,
  action     TEXT
);
CREATE INDEX IF NOT EXISTS idx_isv_coc_target     ON isv_coc(target COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_isv_coc_module     ON isv_coc(module COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_isv_evt_delegate   ON isv_event_handlers(delegate_element COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_isv_evt_module     ON isv_event_handlers(module COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_isv_extends_child  ON isv_extends(child COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_isv_extends_parent ON isv_extends(parent COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_isv_del_table      ON isv_delete_actions(table_name COLLATE NOCASE);`;

/**
 * Labels recovered from sealed `<Model>_AxLabelFile.md` stores (issue #78).
 *
 * This is the one deliberate exception to strict table separation, and it is
 * staged: labels live here until the multi-language `labels` table of issue #84
 * exists, at which point this table is folded into it and separation is carried
 * by the `origin` / `module` columns instead. A label is a label — splitting
 * the resolver across two tables is how one of them gets forgotten.
 */
export const ISV_LABELS_SCHEMA = `
CREATE TABLE IF NOT EXISTS isv_labels (
  label_id     TEXT NOT NULL,
  language     TEXT NOT NULL,
  text         TEXT NOT NULL,
  module       TEXT NOT NULL,
  label_file   TEXT,
  qualified_id TEXT,
  PRIMARY KEY (label_id, language, module)
);
CREATE INDEX IF NOT EXISTS idx_isv_labels_id        ON isv_labels(label_id COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_isv_labels_qualified ON isv_labels(qualified_id COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_isv_labels_module    ON isv_labels(module COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_isv_labels_file      ON isv_labels(label_file COLLATE NOCASE);`;

/** Everything the KB database needs. */
export const ISV_KB_SCHEMA = [
  ISV_MODELS_SCHEMA,
  ISV_ELEMENTS_SCHEMA,
  ISV_ELEMENT_PROPS_SCHEMA,
  ISV_STRUCTURE_SCHEMA,
  ISV_LABELS_SCHEMA,
].join('\n');

/** Everything the XRef database needs. */
export const ISV_XREF_DB_SCHEMA = [
  ISV_MODELS_SCHEMA,
  ISV_XREF_SCHEMA,
].join('\n');

/**
 * Create the sealed-ISV tables on an open better-sqlite3 handle.
 * Idempotent — every statement is CREATE ... IF NOT EXISTS.
 *
 * @param {object} db     open better-sqlite3 Database (writable)
 * @param {'kb'|'xref'} target which schema set to apply
 */
export function ensureIsvSchema(db, target) {
  db.exec(target === 'xref' ? ISV_XREF_DB_SCHEMA : ISV_KB_SCHEMA);
}

/**
 * Does this database carry the sealed-ISV tables at all?
 *
 * Tools must call this before querying any isv_ table: databases built before
 * the ISV pass existed are still perfectly valid and must degrade to "no ISV
 * data scanned", never to a SQLite error. Mirrors queryModelVersions().
 *
 * @param {object} db  open better-sqlite3 Database
 * @returns {boolean}
 */
export function hasIsvData(db) {
  try {
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='isv_models'")
      .get();
    return Boolean(row);
  } catch {
    return false;
  }
}

/**
 * The provenance block every sealed-ISV response carries.
 *
 * Sealed-ISV rows must never read like fully-parsed KB or XRef data. They come
 * from artefacts the ISV compiled and shipped, which means they are accurate
 * about *what references what* and silent about *why* — there is no X++ source
 * behind them to quote. Saying so in the payload, on every response, is what
 * keeps a caller from over-reading the answer.
 *
 * @param {object} db  open better-sqlite3 Database
 * @returns {{fidelity:string, source_kind:string, scanned_at:string|null, caveat:string}}
 */
export function isvProvenance(db) {
  let scannedAt = null;
  try {
    scannedAt = db.prepare('SELECT MAX(scanned_at) AS t FROM isv_models').get()?.t ?? null;
  } catch { /* pre-ISV database — reported as an unknown scan date */ }
  return {
    fidelity: 'metadata',
    source_kind: 'sealed',
    scanned_at: scannedAt,
    caveat: 'Read from the metadata the ISV shipped in bin/ (.md, .xref, .runtime, .xml). '
      + 'No X++ source exists for these models, so call sites can be located but not quoted.',
  };
}

/** The one-line note appended to the Markdown rendering of any ISV response. */
export function isvProvenanceNote(rowCount, modules) {
  const who = Array.isArray(modules) && modules.length
    ? ` (${modules.slice(0, 6).join(', ')}${modules.length > 6 ? ', …' : ''})`
    : '';
  return `\n\n_${rowCount} row(s) from sealed ISV metadata${who} — no X++ source; `
    + 'call-site detail is limited to path, line and column._\n';
}

/** The payload returned when the database predates the ISV scan, or no ISV
 *  root was configured. A shape-valid success, never an error: "nothing was
 *  scanned" is a true and useful answer, not a failure. */
export function noIsvDataProvenance() {
  return {
    fidelity: 'metadata',
    source_kind: 'sealed',
    scanned_at: null,
    caveat: 'No sealed-ISV data in this database. Set ISV_SCAN_PATHS and rebuild, '
      + 'or run `npm run build:isv -- --kb <db> --xref <db>`.',
  };
}
