/**
 * Semantic layer store — ADR W7 + W7b (issue #111).
 *
 * `d365fo_semantic.sqlite` is the ONLY read-write database in the platform. It
 * is physically separate from the KB / XRef / Sec snapshots (read-only, rebuilt
 * weekly) so that functional-entity traces and data-quality rules survive every
 * rebuild. It holds METADATA ONLY: vocabulary ids, object/field names, models,
 * roles, declarative rule specs, aggregates and a salted session hash. No
 * business records, no party names, no sample values, no user identity, no
 * conversation text — the privacy guards in this module are what enforce that
 * at the write boundary, and `test/semantic-store.test.js` asserts them.
 *
 * Location: `SEMANTIC_DB_PATH` (default `~/.claude/d365fo_semantic.sqlite`;
 * on Azure the caller sets `/home/data/d365fo_semantic.sqlite`).
 *
 * Nothing in here executes a DQ rule. The store serves rules; the generator
 * (`build/gen-dq-sql.js`) renders them; the scripts run where the data lives.
 */

import { createRequire } from 'module';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Constants ────────────────────────────────────────────────────────────────

export const SEMANTIC_SCHEMA_VERSION = '1.0';

export const MAPPING_ROLES = Object.freeze([
  'header', 'line', 'master', 'setup', 'transaction', 'reference', 'posting', 'ui',
]);

export const MAPPING_SOURCES = Object.freeze([
  'user_confirmed', 'assistant_inferred', 'context_hint', 'seed',
]);

export const OBJECT_TYPES = Object.freeze([
  'table', 'view', 'data_entity', 'class', 'enum', 'edt', 'form', 'menu_item',
  'security_role', 'security_duty', 'security_privilege', 'query', 'report', 'other',
]);

export const DQ_DIMENSIONS = Object.freeze([
  'format', 'completeness', 'domain', 'uniqueness', 'closeness',
  'referential_integrity', 'consistency', 'timeliness', 'target_readiness',
]);

export const DQ_SEVERITIES = Object.freeze(['info', 'warning', 'error']);

export const DQ_RULE_SOURCES = Object.freeze([
  'kb_derived', 'user_confirmed', 'assistant_inferred', 'seed',
]);

export const NOTE_MAX_LENGTH = 200;

/** Base confidence per provenance. Confirmations add +0.03 each, capped at 0.99.
 *  Doubles as the strength order: a repeat from a weaker source never
 *  downgrades a stronger one (see upsertMapping / upsertDqRule). */
const BASE_CONFIDENCE = Object.freeze({
  user_confirmed: 0.90,
  kb_derived: 0.80,
  seed: 0.60,
  assistant_inferred: 0.50,
  context_hint: 0.20,
});

/** Higher = stronger provenance. */
function sourceStrength(source) {
  return BASE_CONFIDENCE[source] ?? 0;
}

// ── Location / open ──────────────────────────────────────────────────────────

/** Default path: `SEMANTIC_DB_PATH`, else `~/.claude/d365fo_semantic.sqlite`. */
export function defaultSemanticDbPath() {
  return process.env.SEMANTIC_DB_PATH || join(homedir(), '.claude', 'd365fo_semantic.sqlite');
}

/**
 * Open (or create) the semantic database READ-WRITE with WAL and ensure the
 * schema. Pass `':memory:'` for tests. This is the one place in the platform
 * that opens a database writable — every other `openDb` is `readonly: true`.
 */
export function openSemanticDb(filePath = defaultSemanticDbPath()) {
  if (filePath !== ':memory:') {
    const dir = dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  const db = new Database(filePath);
  if (filePath !== ':memory:') db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  ensureSemanticSchema(db);
  return db;
}

// ── Schema ───────────────────────────────────────────────────────────────────

/**
 * The seven tables of #111. `sem_dq_runs` carries AGGREGATES ONLY — there is
 * deliberately no row_key / value / sample column anywhere in this DDL, and the
 * test suite scans the DDL text for those words.
 */
export const SEMANTIC_SCHEMA = `
CREATE TABLE IF NOT EXISTS sem_vocabulary (
  entity_id     TEXT PRIMARY KEY COLLATE NOCASE,
  name          TEXT NOT NULL,
  process       TEXT NOT NULL,
  description   TEXT,
  is_custom     INTEGER NOT NULL DEFAULT 0,
  version       TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sem_entity_relations (
  from_entity   TEXT NOT NULL COLLATE NOCASE,
  to_entity     TEXT NOT NULL COLLATE NOCASE,
  relation      TEXT NOT NULL,
  PRIMARY KEY (from_entity, to_entity, relation)
);

CREATE TABLE IF NOT EXISTS sem_mappings (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  erp_system      TEXT NOT NULL,
  erp_version     TEXT,
  installation_id TEXT NOT NULL,
  snapshot_date   TEXT,
  entity_id       TEXT NOT NULL COLLATE NOCASE,
  object_type     TEXT NOT NULL,
  object_name     TEXT NOT NULL COLLATE NOCASE,
  model           TEXT,
  role            TEXT NOT NULL,
  confidence      REAL NOT NULL,
  source          TEXT NOT NULL,
  confirmations   INTEGER NOT NULL DEFAULT 0,
  verified        INTEGER NOT NULL DEFAULT 0,
  note            TEXT,
  session_hash    TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (installation_id, entity_id, object_type, object_name, role)
);
CREATE INDEX IF NOT EXISTS idx_sem_mappings_object ON sem_mappings(object_name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_sem_mappings_entity ON sem_mappings(entity_id COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS sem_dq_rules (
  rule_id         TEXT NOT NULL,
  version         INTEGER NOT NULL,
  entity_id       TEXT COLLATE NOCASE,
  erp_system      TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  object_name     TEXT COLLATE NOCASE,
  field_name      TEXT COLLATE NOCASE,
  dimension       TEXT NOT NULL,
  spec            TEXT NOT NULL,
  spec_hash       TEXT NOT NULL,
  severity        TEXT NOT NULL,
  source          TEXT NOT NULL,
  confidence      REAL NOT NULL,
  confirmations   INTEGER NOT NULL DEFAULT 0,
  enabled         INTEGER NOT NULL DEFAULT 1,
  note            TEXT,
  session_hash    TEXT,
  created_at      TEXT NOT NULL,
  PRIMARY KEY (rule_id, version)
);
CREATE INDEX IF NOT EXISTS idx_sem_dq_rules_object ON sem_dq_rules(object_name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_sem_dq_rules_entity ON sem_dq_rules(entity_id COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_sem_dq_rules_key ON sem_dq_rules(installation_id, object_name COLLATE NOCASE, field_name COLLATE NOCASE, dimension, spec_hash);

CREATE TABLE IF NOT EXISTS sem_dq_rule_links (
  rule_id     TEXT NOT NULL,
  entity_id   TEXT NOT NULL COLLATE NOCASE,
  role        TEXT,
  PRIMARY KEY (rule_id, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_sem_dq_rule_links_entity ON sem_dq_rule_links(entity_id COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS sem_dq_dialect_overrides (
  rule_id       TEXT NOT NULL,
  dialect       TEXT NOT NULL,
  sql_fragment  TEXT NOT NULL,
  PRIMARY KEY (rule_id, dialect)
);

-- Aggregates only. Never a row key, never a value: the MCP knows the rule;
-- the generated script found the rows.
CREATE TABLE IF NOT EXISTS sem_dq_runs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id         TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  run_date        TEXT NOT NULL,
  rows_checked    INTEGER NOT NULL,
  rows_flagged    INTEGER NOT NULL,
  ingested_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sem_dq_runs_rule ON sem_dq_runs(rule_id);
`;

/** Idempotent DDL. Safe to call on every open. */
export function ensureSemanticSchema(db) {
  db.exec(SEMANTIC_SCHEMA);
}

// ── Installation context / session hash ──────────────────────────────────────

/** Where a trace comes from. `installation_id` distinguishes environments that
 *  share one vocabulary; `erp_system` is what makes the export ERP-neutral. */
export function installationContext() {
  return {
    installation_id: process.env.MCP_INSTALLATION_ID || 'local',
    erp_system: process.env.MCP_ERP_SYSTEM || 'D365FO',
    erp_version: process.env.MCP_ERP_VERSION || null,
  };
}

/**
 * Salted SHA-256 of an opaque, caller-supplied session token — or of the
 * current hour when none is given — so traces from one conversation group
 * together without the hash ever being an identity or reversible to one.
 */
export function sessionHash(token) {
  const salt = process.env.MCP_SESSION_SALT || 'd365fo-semantic-v1';
  const material = typeof token === 'string' && token.length > 0
    ? token
    : new Date().toISOString().slice(0, 13);   // yyyy-mm-ddThh — hour bucket
  return createHash('sha256').update(salt + '|' + material).digest('hex').slice(0, 32);
}

// ── Privacy guards ───────────────────────────────────────────────────────────

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const IBAN_RE = /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/;
const VAT_RE = /\b[A-Z]{2}\d{8,12}\b/;
const PHONE_RE = /(?:\+|00)\d[\d\s().-]{7,}\d|\b\d{3}[\s.-]\d{3}[\s.-]\d{4}\b/;

/**
 * Scan one free-text value for party-like data. Returns null when clean, else a
 * short reason. Object/field names never trip it (no digits-after-letters
 * patterns, no at-sign); "CustAccount" or "SalesTable.SalesId" are fine.
 */
export function privacyViolation(text) {
  if (text == null) return null;
  const s = String(text);
  if (EMAIL_RE.test(s)) return 'contains an e-mail address';
  if (IBAN_RE.test(s)) return 'contains an IBAN-like token';
  if (VAT_RE.test(s)) return 'contains a VAT-number-like token';
  if (PHONE_RE.test(s)) return 'contains a phone-number-like token';
  return null;
}

/** Validate a `note`: optional, ≤200 chars, privacy-scanned. Returns
 *  `{ ok:true, value }` or `{ ok:false, reason }`. */
export function checkNote(note) {
  if (note == null || note === '') return { ok: true, value: null };
  if (typeof note !== 'string') return { ok: false, reason: 'note must be a string' };
  const trimmed = note.trim();
  if (trimmed.length > NOTE_MAX_LENGTH) {
    return { ok: false, reason: `note exceeds ${NOTE_MAX_LENGTH} characters` };
  }
  const v = privacyViolation(trimmed);
  if (v) return { ok: false, reason: `note ${v}` };
  return { ok: true, value: trimmed };
}

// ── DQ spec schemas (one per dimension, the shapes of the concept table) ─────

const ident = z.string().min(1).max(200);
const identList = z.array(ident).min(1).max(32);

export const DQ_SPEC_SCHEMAS = Object.freeze({
  format: z.discriminatedUnion('type', [
    z.object({ type: z.literal('pattern'), regex: z.string().min(1).max(500) }).strict(),
    z.object({
      type: z.literal('length'),
      max: z.number().int().positive(),
      min: z.number().int().nonnegative().optional(),
      edt: ident.optional(),
    }).strict(),
    z.object({
      type: z.literal('edt'),
      edt: ident,
      max_length: z.number().int().positive().optional(),
    }).strict(),
  ]),
  completeness: z.discriminatedUnion('type', [
    z.object({ type: z.literal('not_null') }).strict(),
    // Placeholders such as "", "N/A", "." — short by construction; never data.
    z.object({ type: z.literal('not_in'), values: z.array(z.string().max(20)).min(1).max(20) }).strict(),
  ]),
  domain: z.discriminatedUnion('type', [
    z.object({
      type: z.literal('enum'),
      enum: ident,
      // Allowed enum VALUES (integers or symbolic names) so the rule renders
      // without a KB at hand — metadata of the enum, not data of any row.
      allowed: z.array(z.union([z.number().int(), ident])).max(500).optional(),
    }).strict(),
    z.object({
      type: z.literal('range'),
      min: z.number().optional(),
      max: z.number().optional(),
    }).strict().refine(s => s.min !== undefined || s.max !== undefined, { message: 'range needs min or max' }),
  ]),
  uniqueness: z.object({ type: z.literal('unique'), fields: identList }).strict(),
  closeness: z.object({
    type: z.literal('similarity'),
    fields: identList,
    algorithm: z.enum(['jaro_winkler', 'levenshtein', 'soundex']),
    threshold: z.number().min(0).max(1),
    blocking: z.array(ident).max(8).optional(),
  }).strict(),
  referential_integrity: z.object({
    type: z.literal('fk'),
    to: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/, 'to must be Table or Table.Field'),
    // Compound keys: explicit pairs. Single-column: `to` = Table.Field and the
    // rule's field_name is the source column.
    pairs: z.array(z.object({ field: ident, related_field: ident }).strict()).max(8).optional(),
    nullable: z.boolean().optional(),
  }).strict(),
  consistency: z.object({
    type: z.literal('cross_field'),
    // TRUSTED INPUT: rendered verbatim by the generator (see gen-dq-sql.js).
    expr: z.string().min(1).max(500),
  }).strict(),
  timeliness: z.object({
    type: z.literal('age'),
    field: ident,
    max_days: z.number().int().positive(),
    when: z.string().max(300).optional(),
  }).strict(),
  target_readiness: z.object({
    type: z.literal('target'),
    entity: ident,
    checks: z.array(z.enum(['mandatory', 'enum_map', 'uom_map', 'key_unique'])).min(1).max(4),
    mandatory_fields: z.array(ident).max(200).optional(),
    key_fields: z.array(ident).max(16).optional(),
    enum_fields: z.array(ident).max(100).optional(),
    uom_fields: z.array(ident).max(50).optional(),
  }).strict(),
});

const FORBIDDEN_SPEC_KEYS = /^(sample|samples|example|examples|value|data|record|rows?)$/i;

/** Depth-first: any forbidden key, or any string value that trips the
 *  privacy scan, is a rejection. Runs BEFORE the shape check so a `.strict()`
 *  error never masks the privacy reason. */
function scanSpecForData(node, path = 'spec') {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const r = scanSpecForData(node[i], `${path}[${i}]`);
      if (r) return r;
    }
    return null;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (FORBIDDEN_SPEC_KEYS.test(k)) return `${path}.${k}: literal data keys are not allowed in a spec`;
      const r = scanSpecForData(v, `${path}.${k}`);
      if (r) return r;
    }
    return null;
  }
  if (typeof node === 'string') {
    const v = privacyViolation(node);
    if (v) return `${path} ${v}`;
  }
  return null;
}

/**
 * Validate a declarative spec against its dimension's schema and the privacy
 * rules. Returns `{ ok:true, spec }` (normalised) or `{ ok:false, reason }`.
 */
export function validateSpec(dimension, spec) {
  if (!DQ_DIMENSIONS.includes(dimension)) return { ok: false, reason: `unknown dimension "${dimension}"` };
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return { ok: false, reason: 'spec must be an object' };
  const dataHit = scanSpecForData(spec);
  if (dataHit) return { ok: false, reason: dataHit };
  const parsed = DQ_SPEC_SCHEMAS[dimension].safeParse(spec);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path?.length ? `${first.path.join('.')}: ` : '';
    return { ok: false, reason: `spec does not match the ${dimension} shape (${where}${first?.message ?? 'invalid'})` };
  }
  return { ok: true, spec: parsed.data };
}

/** Canonical (key-sorted) JSON so equal specs hash equal regardless of key order. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

export function specHash(spec) {
  return createHash('sha256').update(canonicalJson(spec)).digest('hex').slice(0, 24);
}

/** Deterministic rule id from the upsert key (installation, object, field,
 *  dimension, spec-hash). The same rule re-declared yields the same id. */
export function makeRuleId({ installation_id, object_name, field_name, dimension, spec_hash }) {
  const key = [installation_id, (object_name || '').toLowerCase(), (field_name || '').toLowerCase(), dimension, spec_hash].join('|');
  return 'dq_' + createHash('sha256').update(key).digest('hex').slice(0, 16);
}

export function confidenceFor(source, confirmations = 0) {
  const base = BASE_CONFIDENCE[source] ?? 0.3;
  return Math.min(0.99, Math.round((base + 0.03 * Math.max(0, confirmations)) * 1000) / 1000);
}

// ── Vocabulary ───────────────────────────────────────────────────────────────

/** Read the checked-in vocabulary file (config/semantic-vocabulary.json). */
export function readVocabularyFile(filePath = join(__dirname, '..', '..', 'config', 'semantic-vocabulary.json')) {
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

const vocabularyFileSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  entities: z.array(z.object({
    entity_id: z.string().regex(/^[a-z][a-z0-9_]*$/, 'entity_id must be snake_case'),
    name: z.string().min(1),
    process: z.enum(['order_to_cash', 'procure_to_pay', 'record_to_report', 'plan_to_produce', 'master_data', 'hire_to_retire']),
    description: z.string().optional(),
    is_custom: z.boolean().optional(),
  })).min(1).max(60),
  relations: z.array(z.object({ from: z.string(), to: z.string(), relation: z.string() })).optional(),
}).passthrough();

/**
 * Upsert the vocabulary (by entity_id) and its relations. Versioned: every row
 * carries the file version it was last written from. Local `is_custom`
 * entities not present in the file are left untouched.
 */
export function loadVocabulary(db, json) {
  const vocab = vocabularyFileSchema.parse(json);
  const ids = new Set(vocab.entities.map(e => e.entity_id));
  for (const r of vocab.relations ?? []) {
    if (!ids.has(r.from) || !ids.has(r.to)) throw new Error(`relation ${r.from}->${r.to} references an unknown entity`);
  }
  const now = new Date().toISOString();
  const upsert = db.prepare(`
    INSERT INTO sem_vocabulary (entity_id, name, process, description, is_custom, version, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(entity_id) DO UPDATE SET
      name = excluded.name, process = excluded.process, description = excluded.description,
      is_custom = excluded.is_custom, version = excluded.version, updated_at = excluded.updated_at`);
  const upsertRel = db.prepare(`
    INSERT OR IGNORE INTO sem_entity_relations (from_entity, to_entity, relation) VALUES (?, ?, ?)`);
  const tx = db.transaction(() => {
    for (const e of vocab.entities) {
      upsert.run(e.entity_id, e.name, e.process, e.description ?? null, e.is_custom ? 1 : 0, vocab.version, now);
    }
    for (const r of vocab.relations ?? []) upsertRel.run(r.from, r.to, r.relation);
  });
  tx();
  return { version: vocab.version, entities: vocab.entities.length, relations: (vocab.relations ?? []).length };
}

/** True when the vocabulary table has at least one row. */
export function hasVocabulary(db) {
  return db.prepare('SELECT COUNT(*) AS n FROM sem_vocabulary').get().n > 0;
}

/** Load the checked-in vocabulary when the table is empty (first open). */
export function ensureVocabulary(db) {
  if (!hasVocabulary(db)) return loadVocabulary(db, readVocabularyFile());
  return null;
}

export function getVocabularyEntry(db, entityId) {
  return db.prepare('SELECT entity_id, name, process, description, is_custom, version FROM sem_vocabulary WHERE entity_id = ? COLLATE NOCASE').get(entityId) ?? null;
}

/** Cheap fuzzy suggestions for a missing entity id: substring on id and name. */
export function suggestEntities(db, term, limit = 5) {
  const like = `%${String(term).replace(/[%_]/g, '')}%`;
  return db.prepare(`SELECT entity_id FROM sem_vocabulary
     WHERE entity_id LIKE ? COLLATE NOCASE OR name LIKE ? COLLATE NOCASE
     ORDER BY entity_id LIMIT ?`).all(like, like, limit).map(r => r.entity_id);
}

// ── Mappings ─────────────────────────────────────────────────────────────────

/**
 * Upsert one entity→object mapping. Key: (installation, entity, type, name,
 * role). A repeat with `confirmed_by_user` bumps `confirmations` and hence
 * confidence; a repeat from a weaker source never downgrades a stronger one.
 * Returns `{ action:'inserted'|'confirmed'|'unchanged', row }`.
 */
export function upsertMapping(db, m) {
  const ctx = installationContext();
  const now = new Date().toISOString();
  const source = MAPPING_SOURCES.includes(m.source) ? m.source : 'assistant_inferred';
  const role = MAPPING_ROLES.includes(m.role) ? m.role : 'reference';
  const existing = db.prepare(`SELECT * FROM sem_mappings
      WHERE installation_id = ? AND entity_id = ? COLLATE NOCASE AND object_type = ?
        AND object_name = ? COLLATE NOCASE AND role = ?`)
    .get(ctx.installation_id, m.entity_id, m.object_type, m.object_name, role);

  if (!existing) {
    const confirmations = source === 'user_confirmed' ? 1 : 0;
    const info = db.prepare(`INSERT INTO sem_mappings
      (erp_system, erp_version, installation_id, snapshot_date, entity_id, object_type, object_name, model, role,
       confidence, source, confirmations, verified, note, session_hash, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      ctx.erp_system, ctx.erp_version, ctx.installation_id, m.snapshot_date ?? null,
      m.entity_id, m.object_type, m.object_name, m.model ?? null, role,
      confidenceFor(source, confirmations), source, confirmations, m.verified ? 1 : 0,
      m.note ?? null, m.session_hash ?? null, now, now);
    return { action: 'inserted', row: db.prepare('SELECT * FROM sem_mappings WHERE id = ?').get(info.lastInsertRowid) };
  }

  const newSource = sourceStrength(source) > sourceStrength(existing.source) ? source : existing.source;
  const confirmations = existing.confirmations + (source === 'user_confirmed' ? 1 : 0);
  const changed = newSource !== existing.source || confirmations !== existing.confirmations
    || (m.verified && !existing.verified) || (m.model && !existing.model);
  if (!changed) return { action: 'unchanged', row: existing };
  db.prepare(`UPDATE sem_mappings SET source = ?, confirmations = ?, confidence = ?, verified = ?,
      model = COALESCE(?, model), note = COALESCE(?, note), session_hash = ?, updated_at = ? WHERE id = ?`)
    .run(newSource, confirmations, confidenceFor(newSource, confirmations),
      existing.verified || (m.verified ? 1 : 0), m.model ?? null, m.note ?? null,
      m.session_hash ?? existing.session_hash, now, existing.id);
  return { action: 'confirmed', row: db.prepare('SELECT * FROM sem_mappings WHERE id = ?').get(existing.id) };
}

/** Forward map: every object mapped to `entityId` (this installation). */
export function mappingsForEntity(db, entityId, minConfidence = 0) {
  const ctx = installationContext();
  return db.prepare(`SELECT * FROM sem_mappings
     WHERE installation_id = ? AND entity_id = ? COLLATE NOCASE AND confidence >= ?
     ORDER BY role, confidence DESC, object_name`).all(ctx.installation_id, entityId, minConfidence);
}

/** Reverse map: every entity `objectName` is mapped to. */
export function mappingsForObject(db, objectName, minConfidence = 0) {
  const ctx = installationContext();
  return db.prepare(`SELECT * FROM sem_mappings
     WHERE installation_id = ? AND object_name = ? COLLATE NOCASE AND confidence >= ?
     ORDER BY confidence DESC, entity_id, role`).all(ctx.installation_id, objectName, minConfidence);
}

// ── DQ rules ─────────────────────────────────────────────────────────────────

/**
 * Upsert one DQ rule. Key: (installation, object, field, dimension, spec-hash)
 * → deterministic `rule_id`. Behaviour:
 *  - new key                       → version 1
 *  - same key, severity/enabled/note changed → new version (never a delete)
 *  - same key, same content        → confirmations/confidence bump in place
 * Returns `{ action, rule_id, version, row }`.
 */
export function upsertDqRule(db, r) {
  const ctx = installationContext();
  const now = new Date().toISOString();
  const source = DQ_RULE_SOURCES.includes(r.source) ? r.source : 'assistant_inferred';
  const severity = DQ_SEVERITIES.includes(r.severity) ? r.severity : 'warning';
  const enabled = r.enabled === false ? 0 : 1;
  const hash = specHash(r.spec);
  const rule_id = makeRuleId({
    installation_id: ctx.installation_id, object_name: r.object_name ?? null,
    field_name: r.field_name ?? null, dimension: r.dimension, spec_hash: hash,
  });
  const latest = db.prepare('SELECT * FROM sem_dq_rules WHERE rule_id = ? ORDER BY version DESC LIMIT 1').get(rule_id);

  const insert = db.prepare(`INSERT INTO sem_dq_rules
    (rule_id, version, entity_id, erp_system, installation_id, object_name, field_name, dimension, spec, spec_hash,
     severity, source, confidence, confirmations, enabled, note, session_hash, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

  let action, version;
  if (!latest) {
    version = 1;
    const confirmations = source === 'user_confirmed' ? 1 : 0;
    insert.run(rule_id, version, r.entity_id ?? null, ctx.erp_system, ctx.installation_id, r.object_name ?? null,
      r.field_name ?? null, r.dimension, canonicalJson(r.spec), hash, severity, source,
      confidenceFor(source, confirmations), confirmations, enabled, r.note ?? null, r.session_hash ?? null, now);
    action = 'inserted';
  } else {
    const contentChanged = latest.severity !== severity || latest.enabled !== enabled
      || (r.note != null && r.note !== latest.note);
    const newSource = sourceStrength(source) > sourceStrength(latest.source) ? source : latest.source;
    const confirmations = latest.confirmations + (source === 'user_confirmed' ? 1 : 0);
    if (contentChanged) {
      version = latest.version + 1;
      insert.run(rule_id, version, r.entity_id ?? latest.entity_id, ctx.erp_system, ctx.installation_id,
        latest.object_name, latest.field_name, latest.dimension, latest.spec, hash, severity, newSource,
        confidenceFor(newSource, confirmations), confirmations, enabled, r.note ?? latest.note,
        r.session_hash ?? null, now);
      action = 'versioned';
    } else {
      version = latest.version;
      if (newSource !== latest.source || confirmations !== latest.confirmations) {
        db.prepare(`UPDATE sem_dq_rules SET source = ?, confirmations = ?, confidence = ?, session_hash = COALESCE(?, session_hash)
                    WHERE rule_id = ? AND version = ?`)
          .run(newSource, confirmations, confidenceFor(newSource, confirmations), r.session_hash ?? null, rule_id, version);
        action = 'confirmed';
      } else {
        action = 'unchanged';
      }
    }
  }
  if (r.entity_id) {
    db.prepare('INSERT OR IGNORE INTO sem_dq_rule_links (rule_id, entity_id, role) VALUES (?, ?, ?)')
      .run(rule_id, r.entity_id, r.role ?? null);
  }
  const row = db.prepare('SELECT * FROM sem_dq_rules WHERE rule_id = ? AND version = ?').get(rule_id, version);
  return { action, rule_id, version, row };
}

/** Latest version of every rule (one row per rule_id) for this installation. */
const LATEST_RULES_CTE = `
  WITH latest AS (
    SELECT rule_id, MAX(version) AS version FROM sem_dq_rules WHERE installation_id = ? GROUP BY rule_id
  )
  SELECT r.* FROM sem_dq_rules r JOIN latest l ON l.rule_id = r.rule_id AND l.version = r.version`;

/**
 * Applicable rule set for an object and/or entity: rules bound to the object
 * directly, plus rules linked (sem_dq_rule_links) to any entity the object is
 * mapped to, plus — when `entityId` is given — rules linked to that entity.
 * Each row carries `binding` ('object' | 'entity:<id>') as provenance.
 */
export function rulesFor(db, { entityId = null, objectName = null, dimension = null, minSeverity = null, includeDisabled = false } = {}) {
  const ctx = installationContext();
  const out = new Map();
  const sevRank = { info: 0, warning: 1, error: 2 };
  const accept = (row, binding) => {
    if (!includeDisabled && !row.enabled) return;
    if (dimension && row.dimension !== dimension) return;
    if (minSeverity && sevRank[row.severity] < sevRank[minSeverity]) return;
    const key = row.rule_id;
    if (!out.has(key)) out.set(key, { ...row, binding });
  };

  if (objectName) {
    for (const row of db.prepare(`${LATEST_RULES_CTE} WHERE r.object_name = ? COLLATE NOCASE`).all(ctx.installation_id, objectName)) {
      accept(row, 'object');
    }
  }
  const entityIds = new Set();
  if (entityId) entityIds.add(entityId.toLowerCase());
  if (objectName) for (const m of mappingsForObject(db, objectName)) entityIds.add(m.entity_id.toLowerCase());
  for (const eid of entityIds) {
    const rows = db.prepare(`${LATEST_RULES_CTE}
        WHERE r.rule_id IN (SELECT rule_id FROM sem_dq_rule_links WHERE entity_id = ? COLLATE NOCASE)
           OR r.entity_id = ? COLLATE NOCASE`).all(ctx.installation_id, eid, eid);
    for (const row of rows) accept(row, `entity:${eid}`);
  }
  return [...out.values()].sort((a, b) =>
    (a.object_name ?? '').localeCompare(b.object_name ?? '') || a.dimension.localeCompare(b.dimension)
    || (a.field_name ?? '').localeCompare(b.field_name ?? ''));
}

/** Dialect overrides for a rule, as `{ [dialect]: sql_fragment }`. */
export function overridesFor(db, ruleId) {
  const out = {};
  for (const r of db.prepare('SELECT dialect, sql_fragment FROM sem_dq_dialect_overrides WHERE rule_id = ?').all(ruleId)) {
    out[r.dialect] = r.sql_fragment;
  }
  return out;
}

/** Ingest ONE aggregate run result. Rejects any object carrying row-level keys. */
export function recordDqRun(db, { rule_id, run_date, rows_checked, rows_flagged, ...rest }) {
  const extra = Object.keys(rest);
  if (extra.length) throw new Error(`sem_dq_runs accepts aggregates only; unexpected keys: ${extra.join(', ')}`);
  const ctx = installationContext();
  db.prepare(`INSERT INTO sem_dq_runs (rule_id, installation_id, run_date, rows_checked, rows_flagged, ingested_at)
              VALUES (?,?,?,?,?,?)`)
    .run(rule_id, ctx.installation_id, run_date, Math.trunc(rows_checked), Math.trunc(rows_flagged), new Date().toISOString());
}

// ── Export (the cross-ERP contract) ──────────────────────────────────────────

/**
 * One ERP-neutral JSON per installation. This is what the cross-ERP matcher
 * and `build/gen-dq-sql.js` consume; the M3 bridge emits the same shape.
 * Latest rule versions only; disabled rules are included with `enabled:false`
 * so a consumer can see what was switched off. `spec` is parsed JSON.
 */
export function exportSemantic(db) {
  const ctx = installationContext();
  const vocabulary = db.prepare('SELECT entity_id, name, process, description, is_custom, version FROM sem_vocabulary ORDER BY process, entity_id').all()
    .map(v => ({ ...v, is_custom: Boolean(v.is_custom) }));
  const relations = db.prepare('SELECT from_entity, to_entity, relation FROM sem_entity_relations ORDER BY from_entity, to_entity').all();
  const mappings = db.prepare(`SELECT erp_system, erp_version, installation_id, snapshot_date, entity_id, object_type, object_name,
       model, role, confidence, source, confirmations, verified FROM sem_mappings WHERE installation_id = ?
       ORDER BY entity_id, role, object_name`).all(ctx.installation_id)
    .map(m => ({ ...m, verified: Boolean(m.verified) }));
  const linkStmt = db.prepare('SELECT entity_id, role FROM sem_dq_rule_links WHERE rule_id = ?');
  const dq_rules = db.prepare(`${LATEST_RULES_CTE} ORDER BY r.object_name, r.dimension, r.field_name`).all(ctx.installation_id)
    .map(r => ({
      rule_id: r.rule_id,
      version: r.version,
      erp_system: r.erp_system,
      installation_id: r.installation_id,
      entity_id: r.entity_id,
      object_name: r.object_name,
      field_name: r.field_name,
      dimension: r.dimension,
      spec: JSON.parse(r.spec),
      severity: r.severity,
      source: r.source,
      confidence: r.confidence,
      enabled: Boolean(r.enabled),
      links: linkStmt.all(r.rule_id),
      overrides: overridesFor(db, r.rule_id),
    }));
  return {
    contract: 'sem_export/1',
    generated_at: new Date().toISOString(),
    erp_system: ctx.erp_system,
    erp_version: ctx.erp_version,
    installation_id: ctx.installation_id,
    vocabulary_version: vocabulary[0]?.version ?? null,
    vocabulary,
    relations,
    mappings,
    dq_rules,
  };
}
