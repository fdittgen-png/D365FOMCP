/**
 * Semantic-layer MCP tools — ADR W7 + W7b (issue #111).
 *
 *   d365_map_entity    WRITE  record "these objects are what <entity> is here"
 *   d365_map_dq_rule   WRITE  record a declarative data-quality rule
 *   d365_entity_map    READ   forward (entity -> objects) / reverse (object -> entities)
 *   d365_dq_rules      READ   the applicable rule set — INPUT to generation
 *
 * The two write tools are the platform's first write path. They write to the
 * separate semantic database only (semantic-store.js); the KB handed in as
 * `kbDb` is used read-only to VERIFY that a mapped object exists. Nothing here
 * executes a rule: `d365_dq_rules` serves rules, `build/gen-dq-sql.js` renders
 * them, and the generated scripts run where the data lives.
 *
 * Every tool follows the response-format contract (CLAUDE.md rules #1-#14):
 * registerTool + outputSchema, typed-first via structuredResult, H2 heading,
 * emptyResult / notFoundResult / errorResult, truncationNote, defensive
 * defaults, the shared `format` parameter passed straight through.
 */

import { z } from 'zod';
import {
  query,
  formatMarkdownTable,
  emptyResult,
  notFoundResult,
  errorResult,
  truncationNote,
  structuredResult,
  formatTextParam,
  READ_ONLY_DB_ANNOTATIONS,
} from './shared.js';
import {
  MAPPING_ROLES,
  OBJECT_TYPES,
  DQ_DIMENSIONS,
  DQ_SEVERITIES,
  NOTE_MAX_LENGTH,
  ensureVocabulary,
  getVocabularyEntry,
  suggestEntities,
  checkNote,
  validateSpec,
  sessionHash,
  upsertMapping,
  upsertDqRule,
  mappingsForEntity,
  mappingsForObject,
  rulesFor,
} from './semantic-store.js';
import {
  d365MapEntityOutput,
  d365MapDqRuleOutput,
  d365EntityMapOutput,
  d365DqRulesOutput,
} from './output-schemas.js';

// ── Write-tool annotations ───────────────────────────────────────────────────
//
// The first non-read-only annotation constant in the platform, and it lives
// HERE rather than in shared.js on purpose: shared.js exports only read-only
// constants, and test/response-format.test.js accepts only those for the
// snapshot tool files. A write tool must not claim `readOnlyHint:true` to
// keep a static scan simple — hosts use the hint to decide whether to ask
// the user. Not destructive (upsert, versioned, never a delete), idempotent
// (the same call twice leaves the same state), closed world (local SQLite).
export const WRITE_METADATA_ANNOTATIONS = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});

// ── KB verification (read-only) ──────────────────────────────────────────────

/** object_type -> where the KB keeps that kind of object. `other` and anything
 *  missing from a given KB build fall back to kb_search. */
const KB_LOOKUP = Object.freeze({
  table: ['tables', 'table_name'],
  view: ['views', 'view_name'],
  data_entity: ['data_entities', 'entity_name'],
  class: ['classes', 'class_name'],
  enum: ['enums', 'enum_name'],
  edt: ['edts', 'edt_name'],
  form: ['forms', 'form_name'],
  menu_item: ['menu_items', 'menu_item_name'],
  security_role: ['security_roles', 'role_name'],
  security_duty: ['security_duties', 'duty_name'],
  security_privilege: ['security_privileges', 'privilege_name'],
});

/** Returns `{ verified, model }`. Never throws: an absent KB table, an old KB
 *  build or a missing KB altogether all degrade to `verified:false`. */
function verifyInKb(kbDb, type, name) {
  if (!kbDb) return { verified: false, model: null };
  const hit = KB_LOOKUP[type];
  if (hit) {
    const [table, col] = hit;
    try {
      const row = query(kbDb, `SELECT module_id FROM ${table} WHERE ${col} = ? COLLATE NOCASE LIMIT 1`, [name])[0];
      if (row) return { verified: true, model: row.module_id ?? null };
    } catch {
      // Older KB build without this table — fall through to kb_search.
    }
  }
  try {
    const row = query(kbDb, 'SELECT module_id FROM kb_search WHERE object_name = ? COLLATE NOCASE LIMIT 1', [name])[0];
    if (row) return { verified: true, model: row.module_id ?? null };
  } catch (err) {
    console.warn('[semantic-tools:verifyInKb]', err.message);
  }
  return { verified: false, model: null };
}

// ── Rendering helpers (from the TYPED object, never from rows) ───────────────

function mappedObject(row) {
  return {
    object_type: row.object_type,
    object_name: row.object_name,
    model: row.model ?? null,
    role: row.role,
    source: row.source,
    confidence: row.confidence,
    confirmations: row.confirmations,
    verified: Boolean(row.verified),
  };
}

function ruleRow(r) {
  return {
    rule_id: r.rule_id,
    version: r.version,
    entity_id: r.entity_id ?? null,
    object_name: r.object_name ?? null,
    field_name: r.field_name ?? null,
    dimension: r.dimension,
    spec: JSON.parse(r.spec),
    severity: r.severity,
    source: r.source,
    confidence: r.confidence,
    enabled: Boolean(r.enabled),
    binding: r.binding,
  };
}

const objectColumns = ['role', 'object_type', 'object_name', 'model', 'source', 'confidence', 'confirmations', 'verified'];

// ── Registration ─────────────────────────────────────────────────────────────

/**
 * Register the four semantic-layer tools.
 *
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 * @param {import('better-sqlite3').Database} semDb  Read-write semantic DB (openSemanticDb()).
 * @param {import('better-sqlite3').Database|null} kbDb  Read-only KB for object verification; may be null.
 */
export function registerSemanticTools(server, semDb, kbDb = null) {
  // A fresh database gets the checked-in vocabulary on first registration.
  try { ensureVocabulary(semDb); } catch (err) { console.warn('[semantic-tools] vocabulary load failed:', err.message); }

  const sessionParam = z.string().max(64).optional()
    .describe('Opaque conversation token; only its salted hash is stored. Omit for an hourly bucket.');

  // ── d365_map_entity (WRITE) ────────────────────────────────────────────────
  server.registerTool('d365_map_entity', {
    description: 'Record that technical objects ARE a functional entity in this installation (e.g. sales_order = SalesTable header, SalesLine line). Upsert; repeat confirmations raise confidence. Set confirmed_by_user only after the user agreed in conversation. Metadata only — no data, no conversation text.',
    inputSchema: {
      entity_id: z.string().min(1).max(64).describe('Vocabulary id, e.g. sales_order, customer (see d365_entity_map).'),
      objects: z.array(z.object({
        type: z.enum(OBJECT_TYPES),
        name: z.string().min(1).max(200),
        role: z.enum(MAPPING_ROLES),
      })).min(1).max(50),
      confirmed_by_user: z.boolean().default(false),
      note: z.string().max(NOTE_MAX_LENGTH).optional().describe('Why (≤200 chars). Privacy-scanned; never party data.'),
      session_token: sessionParam,
      format: formatTextParam,
    },
    outputSchema: d365MapEntityOutput.shape,
    annotations: WRITE_METADATA_ANNOTATIONS,
  }, async ({ entity_id, objects, confirmed_by_user, note, session_token, format }) => {
    try {
      entity_id = typeof entity_id === 'string' ? entity_id.trim() : '';
      const list = (Array.isArray(objects) ? objects : [])
        .filter(o => o && typeof o.name === 'string' && o.name.trim() && OBJECT_TYPES.includes(o.type) && MAPPING_ROLES.includes(o.role))
        .slice(0, 50);
      if (!entity_id || list.length === 0) {
        return errorResult('invalid-input', 'entity_id and at least one object {type, name, role} are required.');
      }
      const entity = getVocabularyEntry(semDb, entity_id);
      if (!entity) return notFoundResult('Entity', entity_id, suggestEntities(semDb, entity_id));
      const noteCheck = checkNote(note);
      if (!noteCheck.ok) return errorResult('invalid-input', `Rejected: ${noteCheck.reason}.`);

      const source = confirmed_by_user === true ? 'user_confirmed' : 'assistant_inferred';
      const hash = sessionHash(session_token);
      const counts = { inserted: 0, confirmed: 0, unchanged: 0 };
      const unverified = [];
      const rows = [];
      const tx = semDb.transaction(() => {
        for (const o of list) {
          const { verified, model } = verifyInKb(kbDb, o.type, o.name.trim());
          if (!verified) unverified.push(`${o.type}:${o.name.trim()}`);
          const r = upsertMapping(semDb, {
            entity_id: entity.entity_id, object_type: o.type, object_name: o.name.trim(), model,
            role: o.role, source, verified, note: noteCheck.value, session_hash: hash,
          });
          counts[r.action]++;
          rows.push(mappedObject(r.row));
        }
      });
      tx();

      const typed = {
        entity_id: entity.entity_id,
        entity_name: entity.name,
        process: entity.process,
        source,
        ...counts,
        unverified_objects: unverified,
        objects: rows,
      };
      let md = `## Entity map updated: ${typed.entity_id} (${typed.entity_name})\n\n`;
      md += `Source: ${source} · inserted ${counts.inserted} · confirmed ${counts.confirmed} · unchanged ${counts.unchanged}\n\n`;
      md += formatMarkdownTable(typed.objects, objectColumns);
      if (unverified.length) {
        md += `\n\n_Not found in the KB snapshot (recorded with verified=false): ${unverified.map(u => `\`${u}\``).join(', ')}._`;
      }
      return structuredResult(typed, md, format);
    } catch (err) {
      return errorResult('db-error', 'Failed to record the entity mapping.', err);
    }
  });

  // ── d365_map_dq_rule (WRITE) ───────────────────────────────────────────────
  server.registerTool('d365_map_dq_rule', {
    description: 'Record a declarative data-quality rule on an entity, object or field: one dimension, a dialect-free spec, a severity. Upsert on (object, field, dimension, spec); enabled:false adds a version, never deletes. The rule is stored and served — never executed here.',
    inputSchema: {
      entity_id: z.string().min(1).max(64).optional().describe('Vocabulary id the rule belongs to (links it across ERPs).'),
      object_name: z.string().min(1).max(200).optional().describe('Technical object (table/entity) the rule checks.'),
      field_name: z.string().min(1).max(200).optional(),
      dimension: z.enum(DQ_DIMENSIONS),
      spec: z.record(z.string(), z.unknown()).describe('Per-dimension shape, e.g. {type:"length",max:20} · {type:"not_null"} · {type:"enum",enum:"SalesStatus"} · {type:"unique",fields:[…]} · {type:"fk",to:"CustTable.AccountNum"} · {type:"cross_field",expr:"…"} · {type:"age",field,max_days} · {type:"target",entity,checks:[…]}. No sample values.'),
      severity: z.enum(DQ_SEVERITIES).default('warning'),
      confirmed_by_user: z.boolean().default(false),
      enabled: z.boolean().default(true).describe('false = disable (new version).'),
      note: z.string().max(NOTE_MAX_LENGTH).optional().describe('Why (≤200 chars). Privacy-scanned.'),
      session_token: sessionParam,
      format: formatTextParam,
    },
    outputSchema: d365MapDqRuleOutput.shape,
    annotations: WRITE_METADATA_ANNOTATIONS,
  }, async ({ entity_id, object_name, field_name, dimension, spec, severity, confirmed_by_user, enabled, note, session_token, format }) => {
    try {
      entity_id = typeof entity_id === 'string' && entity_id.trim() ? entity_id.trim() : null;
      object_name = typeof object_name === 'string' && object_name.trim() ? object_name.trim() : null;
      field_name = typeof field_name === 'string' && field_name.trim() ? field_name.trim() : null;
      severity = DQ_SEVERITIES.includes(severity) ? severity : 'warning';
      enabled = enabled !== false;
      if (!entity_id && !object_name) return errorResult('invalid-input', 'Provide entity_id and/or object_name.');
      if (!DQ_DIMENSIONS.includes(dimension)) return errorResult('invalid-input', `dimension must be one of ${DQ_DIMENSIONS.join(', ')}.`);

      let entity = null;
      if (entity_id) {
        entity = getVocabularyEntry(semDb, entity_id);
        if (!entity) return notFoundResult('Entity', entity_id, suggestEntities(semDb, entity_id));
      }
      const specCheck = validateSpec(dimension, spec);
      if (!specCheck.ok) return errorResult('invalid-input', `Rejected spec: ${specCheck.reason}.`);
      const noteCheck = checkNote(note);
      if (!noteCheck.ok) return errorResult('invalid-input', `Rejected: ${noteCheck.reason}.`);

      const source = confirmed_by_user === true ? 'user_confirmed' : 'assistant_inferred';
      const r = upsertDqRule(semDb, {
        entity_id: entity?.entity_id ?? null, object_name, field_name, dimension, spec: specCheck.spec,
        severity, source, enabled, note: noteCheck.value, session_hash: sessionHash(session_token),
      });
      const typed = {
        rule_id: r.rule_id,
        version: r.version,
        action: r.action,
        entity_id: r.row.entity_id ?? null,
        object_name: r.row.object_name ?? null,
        field_name: r.row.field_name ?? null,
        dimension: r.row.dimension,
        severity: r.row.severity,
        source: r.row.source,
        confidence: r.row.confidence,
        enabled: Boolean(r.row.enabled),
        spec: JSON.parse(r.row.spec),
      };
      const target = [typed.object_name, typed.field_name].filter(Boolean).join('.') || typed.entity_id;
      let md = `## DQ rule ${typed.action}: ${typed.dimension} on ${target}\n\n`;
      md += formatMarkdownTable([{
        rule_id: typed.rule_id, version: typed.version, entity_id: typed.entity_id ?? '', severity: typed.severity,
        source: typed.source, confidence: typed.confidence, enabled: typed.enabled ? 'Y' : 'N', spec: JSON.stringify(typed.spec),
      }]);
      return structuredResult(typed, md, format);
    } catch (err) {
      return errorResult('db-error', 'Failed to record the data-quality rule.', err);
    }
  });

  // ── d365_entity_map (READ) ─────────────────────────────────────────────────
  server.registerTool('d365_entity_map', {
    description: 'What a functional entity IS technically in this installation (entity_id → objects by role), or which entities a technical object belongs to (object_name → entities). Accumulated from confirmed sessions; check before re-deriving "what belongs to Sales".',
    inputSchema: {
      entity_id: z.string().min(1).max(64).optional().describe('Forward: vocabulary id, e.g. sales_order.'),
      object_name: z.string().min(1).max(200).optional().describe('Reverse: technical object, e.g. SalesTable.'),
      min_confidence: z.number().min(0).max(1).default(0),
      format: formatTextParam,
    },
    outputSchema: d365EntityMapOutput.shape,
    annotations: READ_ONLY_DB_ANNOTATIONS,
  }, async ({ entity_id, object_name, min_confidence, format }) => {
    try {
      entity_id = typeof entity_id === 'string' && entity_id.trim() ? entity_id.trim() : null;
      object_name = typeof object_name === 'string' && object_name.trim() ? object_name.trim() : null;
      min_confidence = typeof min_confidence === 'number' && min_confidence >= 0 && min_confidence <= 1 ? min_confidence : 0;
      if (!entity_id && !object_name) return errorResult('invalid-input', 'Provide entity_id (forward) or object_name (reverse).');

      if (entity_id) {
        const entity = getVocabularyEntry(semDb, entity_id);
        if (!entity) return notFoundResult('Entity', entity_id, suggestEntities(semDb, entity_id));
        const rows = mappingsForEntity(semDb, entity.entity_id, min_confidence);
        const related = [
          ...query(semDb, 'SELECT to_entity AS entity_id, relation FROM sem_entity_relations WHERE from_entity = ? COLLATE NOCASE ORDER BY to_entity', [entity.entity_id])
            .map(r => ({ entity_id: r.entity_id, relation: r.relation, direction: 'out' })),
          ...query(semDb, 'SELECT from_entity AS entity_id, relation FROM sem_entity_relations WHERE to_entity = ? COLLATE NOCASE ORDER BY from_entity', [entity.entity_id])
            .map(r => ({ entity_id: r.entity_id, relation: r.relation, direction: 'in' })),
        ];
        const byRole = new Map();
        for (const r of rows) {
          if (!byRole.has(r.role)) byRole.set(r.role, []);
          byRole.get(r.role).push(mappedObject(r));
        }
        const typed = {
          direction: 'forward',
          entity_id: entity.entity_id,
          entity_name: entity.name,
          process: entity.process,
          object_name: null,
          mapping_count: rows.length,
          by_role: [...byRole.entries()].map(([role, objects]) => ({ role, objects })),
          entities: [],
          related_entities: related,
        };
        if (rows.length === 0) {
          return emptyResult(`objects mapped to entity \`${entity.entity_id}\``, typed,
            `\n\nRecord one with \`d365_map_entity\` once the user agrees which objects are ${entity.name}.`);
        }
        let md = `## Entity map: ${typed.entity_id} (${typed.entity_name}, ${typed.process})\n\n`;
        for (const g of typed.by_role) {
          md += `### ${g.role} (${g.objects.length})\n\n${formatMarkdownTable(g.objects, objectColumns.filter(c => c !== 'role'))}\n\n`;
        }
        if (related.length) {
          md += `### Related entities\n\n${formatMarkdownTable(related)}\n`;
        }
        return structuredResult(typed, md, format);
      }

      const rows = mappingsForObject(semDb, object_name, min_confidence);
      const entities = rows.map(r => {
        const e = getVocabularyEntry(semDb, r.entity_id);
        return {
          entity_id: r.entity_id, entity_name: e?.name ?? null, process: e?.process ?? null,
          role: r.role, source: r.source, confidence: r.confidence, confirmations: r.confirmations,
        };
      });
      const typed = {
        direction: 'reverse',
        entity_id: null, entity_name: null, process: null,
        object_name,
        mapping_count: rows.length,
        by_role: [],
        entities,
        related_entities: [],
      };
      if (rows.length === 0) {
        return emptyResult(`entity mappings for object \`${object_name}\``, typed);
      }
      const md = `## Entity map: ${object_name} → entities\n\n${formatMarkdownTable(entities)}`;
      return structuredResult(typed, md, format);
    } catch (err) {
      return errorResult('db-error', 'Failed to read the entity map.', err);
    }
  });

  // ── d365_dq_rules (READ) ───────────────────────────────────────────────────
  server.registerTool('d365_dq_rules', {
    description: 'Applicable data-quality rules for an object and/or entity: rules bound to the object directly plus rules linked to the entities it is mapped to, with source/confidence provenance. This is the INPUT to build/gen-dq-sql.js — the MCP never runs a rule.',
    inputSchema: {
      entity_id: z.string().min(1).max(64).optional(),
      object_name: z.string().min(1).max(200).optional(),
      dimension: z.enum(DQ_DIMENSIONS).optional(),
      min_severity: z.enum(DQ_SEVERITIES).optional(),
      include_disabled: z.boolean().default(false),
      limit: z.number().int().min(1).max(2000).default(200),
      format: formatTextParam,
    },
    outputSchema: d365DqRulesOutput.shape,
    annotations: READ_ONLY_DB_ANNOTATIONS,
  }, async ({ entity_id, object_name, dimension, min_severity, include_disabled, limit, format }) => {
    try {
      entity_id = typeof entity_id === 'string' && entity_id.trim() ? entity_id.trim() : null;
      object_name = typeof object_name === 'string' && object_name.trim() ? object_name.trim() : null;
      dimension = DQ_DIMENSIONS.includes(dimension) ? dimension : null;
      min_severity = DQ_SEVERITIES.includes(min_severity) ? min_severity : null;
      include_disabled = include_disabled === true;
      limit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 2000) : 200;
      if (!entity_id && !object_name) return errorResult('invalid-input', 'Provide entity_id and/or object_name.');
      if (entity_id && !getVocabularyEntry(semDb, entity_id)) {
        return notFoundResult('Entity', entity_id, suggestEntities(semDb, entity_id));
      }

      const all = rulesFor(semDb, { entityId: entity_id, objectName: object_name, dimension, minSeverity: min_severity, includeDisabled: include_disabled });
      const shown = all.slice(0, limit).map(ruleRow);
      const dims = new Map();
      for (const r of all) dims.set(r.dimension, (dims.get(r.dimension) ?? 0) + 1);
      const typed = {
        entity_id,
        object_name,
        rule_count: all.length,
        by_dimension: [...dims.entries()].map(([d, count]) => ({ dimension: d, count })),
        rules: shown,
        truncated: all.length > shown.length,
        note: 'Rules are served, not executed. Render with build/gen-dq-sql.js against an export.',
      };
      const scope = [object_name && `object \`${object_name}\``, entity_id && `entity \`${entity_id}\``].filter(Boolean).join(' / ');
      if (all.length === 0) {
        return emptyResult(`data-quality rules for ${scope}`, typed,
          '\n\nSeed KB-derived rules with `node build/seed-dq-rules.js --tables <Table>` or record one with `d365_map_dq_rule`.');
      }
      let md = `## DQ rules for ${scope}\n\n`;
      md += formatMarkdownTable(typed.by_dimension) + '\n\n';
      md += formatMarkdownTable(shown.map(r => ({
        rule_id: r.rule_id, object_name: r.object_name ?? '', field_name: r.field_name ?? '', dimension: r.dimension,
        spec: JSON.stringify(r.spec), severity: r.severity, source: r.source, confidence: r.confidence,
        enabled: r.enabled ? 'Y' : 'N', binding: r.binding,
      })));
      if (typed.truncated) md += truncationNote('user', shown.length);
      md += `\n\n_${typed.note}_`;
      return structuredResult(typed, md, format);
    } catch (err) {
      return errorResult('db-error', 'Failed to read the data-quality rules.', err);
    }
  });
}
