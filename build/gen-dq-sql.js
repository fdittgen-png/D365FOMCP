#!/usr/bin/env node
/**
 * Data-quality indicator SQL generator — ADR W7b (issue #111).
 *
 *   node build/gen-dq-sql.js --dialect tsql|sqlite --export sem-export.json [--object SalesTable] --out dir/
 *
 * Renders every rule of a `sem_export` JSON (build/export-semantic.js) into one
 * SELECT per rule with the FIXED contract columns
 *
 *   dq_indicator(row_key, object_name, rule_id, dimension, severity, detail)
 *
 * identical for every ERP and dialect, so one readiness / DQ report reads all
 * of them. The scripts are versioned artefacts that run where the data lives
 * — this generator never connects to anything and the MCP never executes a rule.
 *
 * Trust boundary. Object, field, enum and entity names are validated as plain
 * identifiers before being quoted; string literals are escaped. The two
 * exceptions are declared TRUSTED INPUT and rendered verbatim:
 *   - `consistency` specs' `expr` (a cross-field predicate)
 *   - `sem_dq_dialect_overrides` fragments
 * Both come from the architecture-owned semantic DB, not from a caller at run
 * time. Review them as you would review SQL.
 *
 * Degradation is explicit. When a dialect cannot express a check faithfully
 * the statement carries a `-- degraded: …` header and `degraded:true`:
 * `closeness` (no Jaro-Winkler → SOUNDEX/DIFFERENCE on T-SQL, normalised
 * equality on SQLite), `format/pattern` on T-SQL (needs a CLR RegexIsMatch),
 * `target_readiness` enum_map/uom_map (needs the target mapping tables), and
 * any rule with no executable predicate (`format/edt` without max_length,
 * `domain/enum` without `allowed`).
 */

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DIALECTS = Object.freeze(['tsql', 'sqlite']);

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertIdent(name, what = 'identifier') {
  if (typeof name !== 'string' || !IDENT.test(name)) throw new Error(`invalid ${what}: ${JSON.stringify(name)}`);
  return name;
}

function lit(s) {
  return "'" + String(s ?? '').replace(/'/g, "''") + "'";
}

// ── Dialect adapters ─────────────────────────────────────────────────────────

const ADAPTERS = {
  tsql: {
    q: id => `[${assertIdent(id)}]`,
    len: x => `LEN(${x})`,
    trim: x => `LTRIM(RTRIM(${x}))`,
    concat: parts => parts.length === 1 ? `CAST(${parts[0]} AS NVARCHAR(200))` : `CONCAT(${parts.join(", '|', ")})`,
    ageDays: (f, n) => `DATEDIFF(day, ${f}, GETDATE()) > ${n}`,
    regexNotMatch: (f, rx) => ({ sql: `dbo.RegexIsMatch(${f}, ${lit(rx)}) = 0`, degraded: 'regex needs a CLR function dbo.RegexIsMatch(text, pattern) — not built into T-SQL' }),
    similar: (a, b) => ({ sql: `DIFFERENCE(${a}, ${b}) >= 3`, degraded: 'jaro_winkler not available — SOUNDEX/DIFFERENCE used' }),
    terminator: ';',
  },
  sqlite: {
    q: id => `"${assertIdent(id)}"`,
    len: x => `LENGTH(${x})`,
    trim: x => `TRIM(${x})`,
    concat: parts => parts.length === 1 ? `CAST(${parts[0]} AS TEXT)` : parts.join(" || '|' || "),
    ageDays: (f, n) => `(julianday('now') - julianday(${f})) > ${n}`,
    regexNotMatch: (f, rx) => ({ sql: `NOT (${f} REGEXP ${lit(rx)})`, degraded: null }),
    similar: (a, b) => ({ sql: `LOWER(TRIM(${a})) = LOWER(TRIM(${b}))`, degraded: 'jaro_winkler not available — normalised equality used' }),
    terminator: ';',
  },
};

// ── Row key ──────────────────────────────────────────────────────────────────

/**
 * Row-key columns for an object: `RecId` for D365FO tables, else the first
 * uniqueness rule's fields for that object in the export, else null (the
 * statement then emits `NULL AS row_key` and is marked degraded).
 */
export function rowKeyFieldsFor(rule, exportJson) {
  if (Array.isArray(rule.row_key_fields) && rule.row_key_fields.length) return rule.row_key_fields;
  if ((rule.erp_system ?? exportJson?.erp_system) === 'D365FO') return ['RecId'];
  const uniq = (exportJson?.dq_rules ?? []).find(r => r.dimension === 'uniqueness' && r.enabled !== false
    && (r.object_name ?? '').toLowerCase() === (rule.object_name ?? '').toLowerCase());
  return uniq?.spec?.fields?.length ? uniq.spec.fields : null;
}

// ── Predicate builders (one per dimension) ───────────────────────────────────

function blankOrNull(d, f) {
  return `(${f} IS NULL OR ${d.trim(f)} = '')`;
}

function buildPredicates(rule, d, ctx) {
  const spec = rule.spec ?? {};
  const T = d.q(assertIdent(rule.object_name, 'object name'));
  const tf = name => `t.${d.q(name)}`;
  const field = rule.field_name ? tf(rule.field_name) : null;
  const needField = () => { if (!field) throw new Error(`rule ${rule.rule_id}: ${rule.dimension}/${spec.type} needs field_name`); return field; };
  const out = [];   // [{ where, detail, degraded }]
  const push = (where, detail, degraded = null) => out.push({ where, detail, degraded });
  const base = `${rule.dimension}:${spec.type}`;

  switch (rule.dimension) {
    case 'format': {
      if (spec.type === 'length') {
        const f = needField();
        const parts = [`${d.len(f)} > ${Number(spec.max)}`];
        if (spec.min != null) parts.push(`${d.len(f)} < ${Number(spec.min)}`);
        push(`${f} IS NOT NULL AND (${parts.join(' OR ')})`, `${base}:${rule.field_name}:max=${Number(spec.max)}`);
      } else if (spec.type === 'pattern') {
        const r = d.regexNotMatch(needField(), spec.regex);
        push(`${field} IS NOT NULL AND ${r.sql}`, `${base}:${rule.field_name}`, r.degraded);
      } else if (spec.type === 'edt') {
        const f = needField();
        if (spec.max_length) push(`${f} IS NOT NULL AND ${d.len(f)} > ${Number(spec.max_length)}`, `${base}:${rule.field_name}:${assertIdent(spec.edt)}`);
        else push('1 = 0', `${base}:${rule.field_name}:${assertIdent(spec.edt)}`, `EDT ${spec.edt} carries no executable predicate (no max_length)`);
      } else throw new Error(`format: unknown type ${spec.type}`);
      break;
    }
    case 'completeness': {
      const f = needField();
      if (spec.type === 'not_null') push(blankOrNull(d, f), `${base}:${rule.field_name}`);
      else if (spec.type === 'not_in') push(`${f} IN (${spec.values.map(lit).join(', ')})`, `${base}:${rule.field_name}`);
      else throw new Error(`completeness: unknown type ${spec.type}`);
      break;
    }
    case 'domain': {
      const f = needField();
      if (spec.type === 'enum') {
        const allowed = Array.isArray(spec.allowed) ? spec.allowed : [];
        if (!allowed.length) push('1 = 0', `${base}:${rule.field_name}:${assertIdent(spec.enum)}`, `enum ${spec.enum} has no allowed values in the spec — resolve them from the KB`);
        else push(`${f} IS NOT NULL AND ${f} NOT IN (${allowed.map(v => typeof v === 'number' ? String(v) : lit(v)).join(', ')})`, `${base}:${rule.field_name}:${assertIdent(spec.enum)}`);
      } else if (spec.type === 'range') {
        const parts = [];
        if (spec.min != null) parts.push(`${f} < ${Number(spec.min)}`);
        if (spec.max != null) parts.push(`${f} > ${Number(spec.max)}`);
        push(`${f} IS NOT NULL AND (${parts.join(' OR ')})`, `${base}:${rule.field_name}`);
      } else throw new Error(`domain: unknown type ${spec.type}`);
      break;
    }
    case 'uniqueness': {
      const fields = (spec.fields ?? []).map(x => assertIdent(x, 'field'));
      if (!fields.length) throw new Error('uniqueness: fields required');
      const eq = fields.map(x => `d.${d.q(x)} = t.${d.q(x)}`).join(' AND ');
      push(`(SELECT COUNT(*) FROM ${T} d WHERE ${eq}) > 1`, `${base}:${fields.join(',')}`);
      break;
    }
    case 'closeness': {
      const fields = (spec.fields ?? []).map(x => assertIdent(x, 'field'));
      const blocking = (spec.blocking ?? []).map(x => assertIdent(x, 'field'));
      const sim = fields.map(x => d.similar(`d.${d.q(x)}`, `t.${d.q(x)}`));
      const differ = fields.map(x => `d.${d.q(x)} <> t.${d.q(x)}`).join(' OR ');
      const block = blocking.map(x => `d.${d.q(x)} = t.${d.q(x)}`);
      const where = [...block, `(${differ})`, ...sim.map(s => s.sql)].join(' AND ');
      push(`EXISTS (SELECT 1 FROM ${T} d WHERE ${where})`, `${base}:${spec.algorithm}:${fields.join(',')}`, sim[0]?.degraded ?? 'similarity not available');
      break;
    }
    case 'referential_integrity': {
      const [relTable, relField] = String(spec.to).split('.');
      assertIdent(relTable, 'related table');
      let pairs;
      if (Array.isArray(spec.pairs) && spec.pairs.length) pairs = spec.pairs;
      else if (relField) pairs = [{ field: assertIdent(rule.field_name, 'field_name'), related_field: relField }];
      else throw new Error(`fk: ${spec.to} needs a field or pairs`);
      const join = pairs.map(p => `r.${d.q(p.related_field)} = t.${d.q(p.field)}`).join(' AND ');
      const notExists = `NOT EXISTS (SELECT 1 FROM ${d.q(relTable)} r WHERE ${join})`;
      const first = tf(pairs[0].field);
      const where = spec.nullable === false
        ? `(${blankOrNull(d, first)} OR ${notExists})`
        : `NOT ${blankOrNull(d, first)} AND ${notExists}`;
      push(where, `${base}:${pairs.map(p => p.field).join(',')}->${spec.to}`);
      break;
    }
    case 'consistency': {
      // TRUSTED INPUT — see the module header.
      const override = rule.overrides?.[ctx.dialect];
      push(override ? `(${override})` : `NOT (${spec.expr})`, `${base}${override ? ':override' : ''}`);
      break;
    }
    case 'timeliness': {
      const f = tf(assertIdent(spec.field, 'field'));
      const when = spec.when ? ` AND (${spec.when})` : '';   // TRUSTED INPUT (analyst rule)
      push(`${f} IS NOT NULL AND ${d.ageDays(f, Number(spec.max_days))}${when}`, `${base}:${spec.field}:max_days=${Number(spec.max_days)}`);
      break;
    }
    case 'target_readiness': {
      const entity = assertIdent(spec.entity, 'entity');
      for (const check of spec.checks ?? []) {
        const detail = `${base}:${entity}:${check}`;
        if (check === 'mandatory') {
          const fs = (spec.mandatory_fields ?? []).map(x => assertIdent(x, 'field'));
          if (!fs.length) push('1 = 0', detail, 'no mandatory_fields listed for the target entity');
          else push(fs.map(x => blankOrNull(d, tf(x))).join(' OR '), detail);
        } else if (check === 'key_unique') {
          const fs = (spec.key_fields ?? []).map(x => assertIdent(x, 'field'));
          if (!fs.length) push('1 = 0', detail, 'no key_fields listed for the target entity');
          else push(`(SELECT COUNT(*) FROM ${T} d WHERE ${fs.map(x => `d.${d.q(x)} = t.${d.q(x)}`).join(' AND ')}) > 1`, detail);
        } else {
          push('1 = 0', detail, `${check} needs the target mapping table (${check === 'enum_map' ? 'enum_fields' : 'uom_fields'}) — provide a dialect override`);
        }
      }
      break;
    }
    default:
      throw new Error(`unknown dimension ${rule.dimension}`);
  }
  return out;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Render one rule for one dialect.
 *
 * @param {object} rule  An entry of `sem_export.dq_rules` (spec parsed).
 * @param {'tsql'|'sqlite'} dialect
 * @param {{row_key_fields?: string[]|null, export?: object}} [opts]
 * @returns {{rule_id:string, object_name:string, dimension:string, statements:{sql:string, degraded:boolean, notes:string[]}[]}}
 */
export function renderRule(rule, dialect, opts = {}) {
  if (!DIALECTS.includes(dialect)) throw new Error(`unknown dialect ${dialect}`);
  const d = ADAPTERS[dialect];
  if (!rule.object_name) throw new Error(`rule ${rule.rule_id}: object_name required to render`);
  const T = d.q(assertIdent(rule.object_name, 'object name'));
  const rowKeyFields = opts.row_key_fields !== undefined ? opts.row_key_fields : rowKeyFieldsFor(rule, opts.export);
  const rowKey = rowKeyFields?.length ? d.concat(rowKeyFields.map(x => `t.${d.q(x)}`)) : 'NULL';
  const notes = [];
  if (!rowKeyFields?.length) notes.push('no row key available for this object — row_key is NULL');

  const statements = buildPredicates(rule, d, { dialect }).map(p => {
    const stmtNotes = [...notes];
    if (p.degraded) stmtNotes.push(p.degraded);
    const header = [
      `-- dq_indicator · rule ${rule.rule_id} v${rule.version ?? 1} · ${rule.dimension} · ${rule.severity} · source ${rule.source ?? 'n/a'}`,
      ...stmtNotes.map(n => `-- degraded: ${n}`),
    ].join('\n');
    const sql = `${header}
SELECT ${rowKey} AS row_key,
       ${lit(rule.object_name)} AS object_name,
       ${lit(rule.rule_id)} AS rule_id,
       ${lit(rule.dimension)} AS dimension,
       ${lit(rule.severity)} AS severity,
       ${lit(p.detail)} AS detail
FROM ${T} t
WHERE ${p.where}${d.terminator}`;
    return { sql, degraded: stmtNotes.length > 0, notes: stmtNotes };
  });
  return { rule_id: rule.rule_id, object_name: rule.object_name, dimension: rule.dimension, statements };
}

/**
 * Render every enabled rule of an export. Rules that cannot render (bad
 * identifier, missing field) are reported in `errors`, never thrown past here.
 */
export function renderExport(exportJson, dialect, { object = null } = {}) {
  const rendered = [];
  const errors = [];
  for (const rule of exportJson.dq_rules ?? []) {
    if (rule.enabled === false || !rule.object_name) continue;
    if (object && rule.object_name.toLowerCase() !== object.toLowerCase()) continue;
    try {
      rendered.push(renderRule(rule, dialect, { export: exportJson }));
    } catch (err) {
      errors.push({ rule_id: rule.rule_id, error: err.message });
    }
  }
  return { rendered, errors };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { dialect: null, export: null, object: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [k, inlineV] = a.includes('=') ? a.split(/=(.*)/s) : [a, undefined];
    const v = () => inlineV !== undefined ? inlineV : argv[++i];
    if (k === '--dialect') out.dialect = v();
    else if (k === '--export') out.export = v();
    else if (k === '--object') out.object = v();
    else if (k === '--out') out.out = v();
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = parseArgs(process.argv.slice(2));
  if (!DIALECTS.includes(args.dialect) || !args.export || !args.out) {
    console.error('usage: node build/gen-dq-sql.js --dialect tsql|sqlite --export sem-export.json [--object X] --out dir/');
    process.exit(2);
  }
  const exp = JSON.parse(readFileSync(args.export, 'utf-8'));
  const { rendered, errors } = renderExport(exp, args.dialect, { object: args.object });
  const dir = join(args.out, args.dialect);
  mkdirSync(dir, { recursive: true });
  const byObject = new Map();
  for (const r of rendered) {
    if (!byObject.has(r.object_name)) byObject.set(r.object_name, []);
    byObject.get(r.object_name).push(r);
  }
  let statements = 0, degraded = 0;
  for (const [obj, rules] of byObject) {
    const lines = [
      `-- dq_indicator scripts for ${obj} · dialect ${args.dialect} · export ${exp.generated_at ?? 'n/a'} · ${exp.erp_system ?? ''}/${exp.installation_id ?? ''}`,
      `-- contract: row_key, object_name, rule_id, dimension, severity, detail — one SELECT per rule, UNION as needed`,
      '',
    ];
    for (const r of rules) for (const s of r.statements) { lines.push(s.sql, ''); statements++; if (s.degraded) degraded++; }
    writeFileSync(join(dir, `${obj}.sql`), lines.join('\n'), 'utf-8');
  }
  console.log(`${args.dialect}: ${rendered.length} rule(s) → ${statements} statement(s) in ${byObject.size} file(s) under ${dir}; degraded ${degraded}; errors ${errors.length}`);
  for (const e of errors) console.log(`  ! ${e.rule_id}: ${e.error}`);
}
