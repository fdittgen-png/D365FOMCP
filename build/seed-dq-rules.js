#!/usr/bin/env node
/**
 * KB-derived data-quality rule seed — ADR W7b (issue #111).
 *
 *   node build/seed-dq-rules.js --tables CustTable,SalesTable,SalesLine
 *   node build/seed-dq-rules.js --all
 *
 * Reads the KB snapshot READ-ONLY and writes `source:'kb_derived'` rules into
 * the semantic database (SEMANTIC_DB_PATH). Six dimensions come straight from
 * metadata that is already correct by construction:
 *
 *   format                 EDT string size            -> {type:'length', max, edt}
 *   completeness           mandatory fields           -> {type:'not_null'}
 *   domain                 enum-typed fields          -> {type:'enum', enum, allowed}
 *   uniqueness             unique indexes             -> {type:'unique', fields}
 *   referential_integrity  table relations            -> {type:'fk', to, pairs?}
 *   target_readiness       data entities' mandatory   -> {type:'target', entity, checks:['mandatory'], mandatory_fields}
 *
 * Column names are DISCOVERED with `PRAGMA table_info`, never assumed — KB
 * builds differ (the customisation columns arrived later; the test fixture uses
 * INTEGER where production uses TEXT). Numerics are read through toNum().
 *
 * Idempotent: the same KB state yields the same rule ids and the second run
 * reports everything as `unchanged`. Rules are linked to the entities each
 * table is already mapped to (sem_mappings), so `d365_dq_rules('sales_order')`
 * returns them once SalesTable is mapped.
 */

import { createRequire } from 'module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  openSemanticDb,
  ensureVocabulary,
  upsertDqRule,
  mappingsForObject,
} from '../src/azure/semantic-store.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

/** SQLite TEXT-typed numerics ("1", "20") and INTEGER alike -> number|null. */
export function toNum(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 'Yes' / '1' / 1 / true -> true. */
function isYes(v) {
  if (v == null) return false;
  if (typeof v === 'number') return v !== 0;
  const s = String(v).trim().toLowerCase();
  return s === 'yes' || s === '1' || s === 'true';
}

function columnsOf(db, table) {
  try { return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name)); }
  catch { return new Set(); }
}

function parseJson(text, fallback) {
  try { const v = JSON.parse(text ?? ''); return v ?? fallback; } catch { return fallback; }
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Kernel (non-AxEnum) enums the KB cannot see, lower-cased -> allowed values. */
const KERNEL_ENUMS = Object.freeze({
  noyes: [0, 1],
  noyescombo: [0, 1, 2],
  noyesall: [0, 1, 2],
  noyeschanged: [0, 1, 2],
});

/**
 * Seed rules for the given tables (or every table with --all).
 *
 * @param {import('better-sqlite3').Database} kbDb   read-only KB
 * @param {import('better-sqlite3').Database} semDb  read-write semantic DB
 * @param {{tables?: string[], all?: boolean, log?: (s:string)=>void}} opts
 * @returns {{tables:number, by_dimension: Record<string,{inserted:number,unchanged:number,versioned:number,confirmed:number}>, skipped:string[]}}
 */
export function seedDqRules(kbDb, semDb, { tables = [], all = false, log = () => {} } = {}) {
  const cols = {
    tables: columnsOf(kbDb, 'tables'),
    fields: columnsOf(kbDb, 'fields'),
    indexes: columnsOf(kbDb, 'indexes_tbl'),
    relations: columnsOf(kbDb, 'relations'),
    enums: columnsOf(kbDb, 'enums'),
    edts: columnsOf(kbDb, 'edts'),
    data_entities: columnsOf(kbDb, 'data_entities'),
    entity_fields: columnsOf(kbDb, 'entity_fields'),
  };
  if (!cols.fields.has('table_name') || !cols.fields.has('field_name')) {
    throw new Error('KB has no fields(table_name, field_name) — not a KB database?');
  }

  // Resolve the table list against the KB so names come back in canonical case.
  let tableNames;
  if (all) {
    tableNames = kbDb.prepare('SELECT table_name FROM tables ORDER BY table_name').all().map(r => r.table_name);
  } else {
    const find = kbDb.prepare('SELECT table_name FROM tables WHERE table_name = ? COLLATE NOCASE');
    tableNames = [];
    for (const t of tables) {
      const row = find.get(t);
      if (row) tableNames.push(row.table_name);
      else log(`skip: table ${t} not in KB`);
    }
  }

  const counts = {};
  const bump = (dim, action) => {
    counts[dim] ??= { inserted: 0, unchanged: 0, versioned: 0, confirmed: 0 };
    counts[dim][action] = (counts[dim][action] ?? 0) + 1;
  };
  const skipped = [];

  const fieldsStmt = kbDb.prepare(`SELECT * FROM fields WHERE table_name = ? COLLATE NOCASE ORDER BY field_name`);
  const edtStmt = cols.edts.has('edt_name') ? kbDb.prepare(`SELECT * FROM edts WHERE edt_name = ? COLLATE NOCASE`) : null;
  const enumStmt = cols.enums.has('enum_name') ? kbDb.prepare(`SELECT * FROM enums WHERE enum_name = ? COLLATE NOCASE`) : null;
  const idxStmt = cols.indexes.has('table_name') ? kbDb.prepare(`SELECT * FROM indexes_tbl WHERE table_name = ? COLLATE NOCASE`) : null;
  const relStmt = cols.relations.has('source_table') ? kbDb.prepare(`SELECT * FROM relations WHERE source_table = ? COLLATE NOCASE`) : null;
  const entStmt = cols.data_entities.has('primary_table') ? kbDb.prepare(`SELECT * FROM data_entities WHERE primary_table = ? COLLATE NOCASE`) : null;
  const entFieldsStmt = cols.entity_fields.has('entity_name') ? kbDb.prepare(`SELECT * FROM entity_fields WHERE entity_name = ? COLLATE NOCASE`) : null;

  /** Resolve an EDT's string size, following extends_edt up to 8 levels. */
  function edtStringSize(edtName) {
    let name = edtName; let depth = 0;
    while (name && edtStmt && depth++ < 8) {
      const e = edtStmt.get(name);
      if (!e) return null;
      const size = toNum(e.string_size);
      if (size && size > 0) return size;
      name = e.extends_edt;
    }
    return null;
  }

  const seed = (table, rule) => {
    if (!IDENT.test(table) || (rule.field_name && !IDENT.test(rule.field_name))) {
      skipped.push(`${table}.${rule.field_name ?? ''}: non-identifier name`);
      return;
    }
    const links = mappingsForObject(semDb, table);
    const r = upsertDqRule(semDb, {
      ...rule, object_name: table, source: 'kb_derived',
      entity_id: links[0]?.entity_id ?? null, role: links[0]?.role ?? null,
    });
    for (const m of links.slice(1)) {
      semDb.prepare('INSERT OR IGNORE INTO sem_dq_rule_links (rule_id, entity_id, role) VALUES (?, ?, ?)').run(r.rule_id, m.entity_id, m.role);
    }
    bump(rule.dimension, r.action);
  };

  const tx = semDb.transaction(() => {
    for (const table of tableNames) {
      const fields = fieldsStmt.all(table);

      for (const f of fields) {
        // format — EDT string length
        if (cols.fields.has('edt') && f.edt) {
          const size = edtStringSize(f.edt);
          const isString = !cols.fields.has('field_type') || /string/i.test(String(f.field_type ?? 'String'));
          if (size && isString && IDENT.test(f.edt)) {
            seed(table, { field_name: f.field_name, dimension: 'format', severity: 'error',
              spec: { type: 'length', max: size, edt: f.edt } });
          }
        }
        // completeness — mandatory
        if (cols.fields.has('mandatory') && isYes(f.mandatory)) {
          seed(table, { field_name: f.field_name, dimension: 'completeness', severity: 'error', spec: { type: 'not_null' } });
        }
        // domain — enum
        if (cols.fields.has('enum_type') && f.enum_type && enumStmt && IDENT.test(f.enum_type)) {
          const e = enumStmt.get(f.enum_type);
          const values = e ? parseJson(e.values_json, []) : [];
          let allowed = Array.isArray(values)
            ? values.map(v => (toNum(v?.value) ?? (typeof v?.name === 'string' ? v.name : null))).filter(v => v !== null)
            : [];
          // Kernel enums ship no AxEnum XML, so the KB has no row for them.
          // Measured on the production KB: NoYes alone was 161 of 245 enum
          // rules on CustTable/SalesTable/SalesLine — every one degraded.
          if (!allowed.length && KERNEL_ENUMS[f.enum_type.toLowerCase()]) allowed = KERNEL_ENUMS[f.enum_type.toLowerCase()];
          const spec = { type: 'enum', enum: f.enum_type };
          if (allowed.length) spec.allowed = allowed.slice(0, 500);
          seed(table, { field_name: f.field_name, dimension: 'domain', severity: 'error', spec });
        }
      }

      // uniqueness — unique indexes
      if (idxStmt) {
        for (const idx of idxStmt.all(table)) {
          if (!isYes(idx.is_unique)) continue;
          const idxFields = parseJson(idx.fields_json, []).filter(x => typeof x === 'string' && IDENT.test(x));
          if (!idxFields.length) continue;
          seed(table, { field_name: null, dimension: 'uniqueness', severity: 'error', spec: { type: 'unique', fields: idxFields } });
        }
      }

      // referential_integrity — relations
      if (relStmt) {
        for (const rel of relStmt.all(table)) {
          if (!rel.related_table || !IDENT.test(rel.related_table)) continue;
          const pairs = parseJson(rel.constraints_json, [])
            .filter(c => c && (c.type == null || /field/i.test(String(c.type))) && c.field && c.relatedField
              && IDENT.test(String(c.field)) && IDENT.test(String(c.relatedField)) && c.fixedValue == null)
            .map(c => ({ field: String(c.field), related_field: String(c.relatedField) }));
          if (!pairs.length) continue;
          const spec = pairs.length === 1
            ? { type: 'fk', to: `${rel.related_table}.${pairs[0].related_field}`, nullable: true }
            : { type: 'fk', to: rel.related_table, pairs, nullable: true };
          seed(table, { field_name: pairs[0].field, dimension: 'referential_integrity', severity: 'warning', spec });
        }
      }

      // target_readiness — data entities over this table
      if (entStmt && entFieldsStmt) {
        for (const ent of entStmt.all(table)) {
          if (!IDENT.test(ent.entity_name)) continue;
          const mandatory = entFieldsStmt.all(ent.entity_name)
            .filter(ef => isYes(ef.is_mandatory))
            .map(ef => ef.data_field || ef.field_name)
            .filter(x => typeof x === 'string' && IDENT.test(x));
          if (!mandatory.length) continue;
          seed(table, { field_name: null, dimension: 'target_readiness', severity: 'warning',
            spec: { type: 'target', entity: ent.entity_name, checks: ['mandatory'], mandatory_fields: [...new Set(mandatory)].slice(0, 200) } });
        }
      }
    }
  });
  tx();

  return { tables: tableNames.length, by_dimension: counts, skipped };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { tables: [], all: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') out.all = true;
    else if (a === '--tables') out.tables.push(...String(argv[++i] ?? '').split(',').map(s => s.trim()).filter(Boolean));
    else if (a.startsWith('--tables=')) out.tables.push(...a.slice(9).split(',').map(s => s.trim()).filter(Boolean));
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.all && args.tables.length === 0) {
    console.error('usage: node build/seed-dq-rules.js [--tables CustTable,SalesTable,SalesLine] [--all]');
    process.exit(2);
  }
  const kbPath = process.env.KB_DB_PATH || '/home/data/d365fo_kb.sqlite';
  if (!existsSync(kbPath)) {
    console.error(`KB database not found at ${kbPath} — set KB_DB_PATH (see .env.example).`);
    process.exit(2);
  }
  const kbDb = new Database(kbPath, { readonly: true });   // the KB is NEVER written here
  const semDb = openSemanticDb();
  ensureVocabulary(semDb);
  const t0 = Date.now();
  const result = seedDqRules(kbDb, semDb, { ...args, log: m => console.log(m) });
  console.log(`\nSeeded ${result.tables} table(s) in ${Date.now() - t0} ms`);
  for (const [dim, c] of Object.entries(result.by_dimension)) {
    console.log(`  ${dim.padEnd(22)} inserted ${c.inserted}  unchanged ${c.unchanged}  versioned ${c.versioned}  confirmed ${c.confirmed}`);
  }
  if (result.skipped.length) console.log(`  skipped: ${result.skipped.length}`);
  kbDb.close(); semDb.close();
}
