/**
 * d365_effective_schema — the merged shape of a table as it exists in THIS
 * system (issue #85): base fields plus every field an AxTableExtension adds,
 * each row attributed to the model that declared it, plus the sealed-ISV
 * extensions the KB knows about only as an inventory.
 *
 * Why a separate tool rather than a flag on d365_lookup_table: the question
 * "what does CustTable actually look like here" used to take four calls
 * (lookup_table, xref_find_extensions, lookup_table per extension model) and a
 * merge done by the model — which is exactly where hallucination enters. One
 * call, one merge, every row attributed.
 *
 * Attribution rule (#14): `origin` and `module` are on EVERY field row — they
 * are what distinguishes the rows — and `model_origin` (microsoft/isv/custom
 * from model_versions) is on every row as well, null when the snapshot has no
 * provenance for that model. Keys that would be absent on some rows only are
 * not emitted at all.
 *
 * Sealed ISV models (`isv_extends`, `isv_elements`) publish an element
 * inventory, not a resolved field list: their table extensions are reported by
 * name and module, never as fields. `isvProvenance()` says so on the payload.
 *
 * Registered from the end of registerKbTools() so tool-sets.js is untouched.
 */

import { z } from 'zod';
import {
  query,
  formatMarkdownTable,
  notFoundResult,
  truncationNote,
  structuredResult,
  makeLabelResolver,
  formatTextParam,
  modulesFilterParam,
  sanitizeModulesFilter,
  queryModelVersions,
  validateLikePattern,
  patternErrorResult,
  coverageNotes,
  readKbMetadataFlag,
  READ_ONLY_DB_ANNOTATIONS,
} from './shared.js';
import { hasIsvData, isvProvenance, isvProvenanceNote } from './isv-schema.js';
import { semanticStore, recordContextHint, functionalContextParam } from './tool-guards.js';
import { d365EffectiveSchemaOutput } from './output-schemas.js';

const FIELD_LIMIT_DEFAULT = 300;
const FIELD_LIMIT_MAX = 2000;

/**
 * Field rows of one table with their attribution columns. Shared with
 * d365_lookup_table so the two tools never disagree on what a field row is.
 * On KB databases built before the customization columns existed the pair is
 * projected as constants, so callers can rely on the keys.
 *
 * @param {(sql:string, params?:any[])=>object[]} q
 * @param {string} tableName  exact-cased table name
 * @param {boolean} hasCustomization  `fields.is_extension` exists
 */
export function queryTableFields(q, tableName, hasCustomization) {
  const extCols = hasCustomization
    ? 'is_extension, source_module'
    : '0 AS is_extension, NULL AS source_module';
  return q(
    `SELECT field_name, field_type, edt, enum_type, label, mandatory, ${extCols}
     FROM fields WHERE table_name = ? COLLATE NOCASE ORDER BY field_name`, [tableName],
  );
}

/** Safe number coercion for SQLite TEXT columns ("Yes"/"No" -> null). */
function toNum(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
const toStr = (v) => (v == null ? null : String(v));

/** @param {{ semanticDb?: any }} [opts] test injection of the semantic store (#115) */
export function registerEffectiveSchemaTools(server, db, opts = {}) {
  const { semanticDb } = opts;
  const q = (sql, params = []) => query(db, sql, params);
  const tableHasColumn = (table, col) => {
    try { return q(`PRAGMA table_info(${table})`).some(c => c.name === col); } catch { return false; }
  };
  const fieldsHaveCustomization = tableHasColumn('fields', 'is_extension');
  // Same wiring as registerKbTools (#115 / #116): lazy semantic store, and the
  // build-level coverage facts read once per registration.
  const semDb = () => semanticDb ?? semanticStore();
  const partialBuildSince = readKbMetadataFlag(db, 'partial_build');
  const isvScanned = hasIsvData(db);

  server.registerTool(
    'd365_effective_schema',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description: 'Merged view of a table as it exists here: base fields plus every table-extension field, each attributed to its model (origin, module, model_origin microsoft/isv/custom), with indexes, relations and the sealed-ISV extensions known by name.',
      inputSchema: {
        table_name: z.string().min(1).max(500).describe('Table name (case-insensitive)'),
        include_isv: z.boolean().optional().default(true).describe('Include sealed-ISV table extensions (inventory only — no field list exists for them). Default true.'),
        modules: modulesFilterParam,
        field_limit: z.number().int().min(1).max(FIELD_LIMIT_MAX).optional().default(FIELD_LIMIT_DEFAULT)
          .describe(`Max fields to list; counts are always whole-table.`),
        functional_context: functionalContextParam,
        format: formatTextParam,
      },
      outputSchema: d365EffectiveSchemaOutput.shape,
    },
    async ({ table_name, include_isv, modules, field_limit, functional_context, format }) => {
      const resolve = makeLabelResolver(db);
      const tn = String(table_name ?? '').trim();
      // Defensive defaults - the test mock server bypasses Zod (rule #13).
      const fieldLimit = Number.isInteger(field_limit) && field_limit > 0
        ? Math.min(field_limit, FIELD_LIMIT_MAX) : FIELD_LIMIT_DEFAULT;
      const wantIsv = include_isv !== false;
      const moduleFilter = sanitizeModulesFilter(modules).map(m => m.toLowerCase());
      const inScope = (module) => !moduleFilter.length
        || (module != null && moduleFilter.includes(String(module).toLowerCase()));

      const tbl = q(
        `SELECT table_name, module_id, label, table_group FROM tables WHERE table_name = ? COLLATE NOCASE`, [tn],
      );
      if (!tbl.length) {
        const pv = validateLikePattern(tn);
        if (pv) return patternErrorResult(pv);
        const fuzzy = q(`SELECT table_name FROM tables WHERE table_name LIKE ? COLLATE NOCASE LIMIT 10`, [`%${tn}%`]);
        return notFoundResult('Table', tn, fuzzy.map(r => r.table_name), {
          db, kind: 'table', functional_context, semanticDb: functional_context ? semDb() : undefined,
        });
      }
      const row = tbl[0];
      if (functional_context) recordContextHint(semDb(), { functional_context, object_type: 'table', object_name: row.table_name });

      // Model origin (microsoft / isv / custom) keyed by model name and package.
      const originByModel = new Map();
      for (const v of queryModelVersions(q)) {
        const o = String(v.origin ?? '').toLowerCase();
        if (!o) continue;
        if (v.model_name) originByModel.set(String(v.model_name).toLowerCase(), o);
        const mid = v.module_id ? String(v.module_id).toLowerCase() : '';
        if (mid && !originByModel.has(mid)) originByModel.set(mid, o);
      }
      const modelOrigin = (m) => (m ? originByModel.get(String(m).toLowerCase()) ?? null : null);

      let fieldRows = [];
      try {
        fieldRows = queryTableFields(q, row.table_name, fieldsHaveCustomization);
      } catch (err) {
        console.error('[effective-schema:fields]', err);
      }
      // Base fields always belong to the table's own module; an extension field
      // to the model that declared it (fields.source_module).
      const allFields = fieldRows.map(f => {
        const isExt = toNum(f.is_extension) === 1;
        const module = isExt ? (f.source_module ?? null) : (f.source_module ?? row.module_id ?? null);
        return {
          name: f.field_name,
          type: f.field_type ?? null,
          edt: f.edt ?? null,
          enum_type: f.enum_type ?? null,
          label: f.label ? resolve(f.label) : null,
          mandatory: toNum(f.mandatory),
          origin: isExt ? 'extension' : 'base',
          module,
          model_origin: modelOrigin(module),
        };
      });
      // The modules filter scopes the EXTENSION surface; base fields are the
      // table and always stay.
      const scoped = allFields.filter(f => f.origin === 'base' || inScope(f.module));
      const shown = scoped.slice(0, fieldLimit);

      const byModule = new Map();
      for (const f of scoped) {
        const key = f.module ?? '(unknown)';
        if (!byModule.has(key)) byModule.set(key, { module: f.module, origin: f.origin, model_origin: f.model_origin, field_count: 0 });
        byModule.get(key).field_count++;
      }

      const idxRows = q(`SELECT index_name, is_unique, is_clustered, fields_json FROM indexes_tbl WHERE table_name = ? COLLATE NOCASE ORDER BY index_name`, [row.table_name]);
      const relRows = q(`SELECT relation_name, related_table, constraints_json, relationship_type, on_delete
                         FROM relations WHERE source_table = ? COLLATE NOCASE ORDER BY relation_name`, [row.table_name]);
      const parseJson = (s, dflt) => { try { return JSON.parse(s || 'null') ?? dflt; } catch { return dflt; } };

      // Sealed ISV: an inventory of table extensions and delete actions, never
      // fields. Absent (not empty) when not asked for or on a pre-ISV database.
      const isvAvailable = wantIsv && isvScanned;
      let isvExt = [];
      let isvDel = [];
      if (isvAvailable) {
        try {
          isvExt = q(`SELECT module, child FROM isv_extends WHERE kind = 'table' AND parent = ? COLLATE NOCASE
                      ORDER BY module COLLATE NOCASE, child COLLATE NOCASE`, [row.table_name])
            .map(r => ({ module: String(r.module), extension_name: String(r.child) }));
          // The element inventory names extensions `<Table>.<Ext>`; union with
          // the .runtime descriptors, deduped on (module, name).
          const seen = new Set(isvExt.map(x => `${x.module}|${x.extension_name}`.toLowerCase()));
          for (const r of q(`SELECT module, name FROM isv_elements WHERE element_type = 'AxTableExtension' COLLATE NOCASE
                             AND (name = ? COLLATE NOCASE OR name LIKE ? COLLATE NOCASE)
                             ORDER BY module COLLATE NOCASE, name COLLATE NOCASE`, [row.table_name, `${row.table_name}.%`])) {
            const key = `${r.module}|${r.name}`.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            isvExt.push({ module: String(r.module), extension_name: String(r.name) });
          }
          isvDel = q(`SELECT module, target, relation, action FROM isv_delete_actions WHERE table_name = ? COLLATE NOCASE
                      ORDER BY module COLLATE NOCASE, target COLLATE NOCASE`, [row.table_name])
            .map(r => ({ module: String(r.module), target: r.target ?? null, relation: r.relation ?? null, action: r.action ?? null }));
        } catch (err) {
          console.error('[effective-schema:isv]', err);
        }
        isvExt = isvExt.filter(x => inScope(x.module));
        isvDel = isvDel.filter(x => inScope(x.module));
      }

      const typed = {
        table_name: row.table_name,
        module_id: row.module_id ?? null,
        model_origin: modelOrigin(row.module_id),
        label: row.label ? resolve(row.label) : null,
        table_group: row.table_group ?? null,
        field_count: scoped.length,
        base_field_count: scoped.filter(f => f.origin === 'base').length,
        extension_field_count: scoped.filter(f => f.origin === 'extension').length,
        fields_shown: shown.length,
        fields_truncated: scoped.length > shown.length,
        contributing_models: [...byModule.values()],
        fields: shown,
        indexes: idxRows.map(i => ({
          name: i.index_name,
          is_unique: Boolean(toNum(i.is_unique)),
          is_clustered: Boolean(toNum(i.is_clustered)),
          fields: parseJson(i.fields_json, []).map(toStr),
        })),
        relations: relRows.map(r => ({
          relation_name: r.relation_name ?? null,
          related_table: r.related_table ?? null,
          join_fields: parseJson(r.constraints_json, []).map(c => ({ field: toStr(c.field), related_field: toStr(c.relatedField) })),
          relationship_type: r.relationship_type ?? null,
          on_delete: r.on_delete ?? null,
        })),
        ...(isvAvailable ? {
          isv_extensions: isvExt,
          isv_delete_actions: isvDel,
          isv_provenance: isvProvenance(db),
        } : {}),
      };

      let out = `## Effective schema: ${typed.table_name}\n`;
      out += `Module: ${typed.module_id ?? '-'}${typed.model_origin ? ` (${typed.model_origin})` : ''} | Group: ${typed.table_group ?? '-'}`;
      if (typed.label) out += ` | Label: ${typed.label}`;
      out += `\n${typed.field_count} fields: ${typed.base_field_count} base + ${typed.extension_field_count} from extensions`;
      if (moduleFilter.length) out += ` (extensions scoped to ${moduleFilter.join(', ')})`;
      out += '\n\n';

      out += '## Contributing models\n';
      out += formatMarkdownTable(typed.contributing_models.map(m => ({
        Module: m.module ?? '(unknown)', Origin: m.origin, 'Model origin': m.model_origin ?? '', Fields: m.field_count,
      })), ['Module', 'Origin', 'Model origin', 'Fields']) + '\n\n';

      out += `## Fields (${typed.field_count})\n`;
      out += formatMarkdownTable(typed.fields.map(f => ({
        Field: f.name, Type: f.type ?? '', EDT: f.edt ?? '', Enum: f.enum_type ?? '', Label: f.label ?? '-',
        Mand: f.mandatory ?? '', Origin: f.origin, Module: f.module ?? '', 'Model origin': f.model_origin ?? '',
      })), ['Field', 'Type', 'EDT', 'Enum', 'Label', 'Mand', 'Origin', 'Module', 'Model origin']);
      out += typed.fields_truncated
        ? truncationNote('cap', typed.fields_shown, FIELD_LIMIT_MAX) + '_Raise `field_limit` or scope with `modules`._\n\n'
        : '\n\n';

      out += '## Indexes\n';
      out += typed.indexes.length
        ? formatMarkdownTable(typed.indexes.map(i => ({
          Index: i.name, Unique: i.is_unique ? 'Y' : 'N', Clustered: i.is_clustered ? 'Y' : 'N', Fields: i.fields.join(', '),
        })), ['Index', 'Unique', 'Clustered', 'Fields'])
        : '_No indexes._';
      out += '\n\n## Relations\n';
      out += typed.relations.length
        ? formatMarkdownTable(typed.relations.map(r => ({
          Relation: r.relation_name ?? '', 'To Table': r.related_table ?? '',
          'Join Fields': r.join_fields.filter(c => c.field && c.related_field).map(c => `${c.field}->${c.related_field}`).join(', '),
          Type: r.relationship_type ?? '-', OnDelete: r.on_delete ?? '-',
        })), ['Relation', 'To Table', 'Join Fields', 'Type', 'OnDelete'])
        : '_No relations defined._';
      out += '\n';

      if (isvAvailable) {
        out += `\n## Sealed ISV table extensions (${typed.isv_extensions.length})\n`;
        out += typed.isv_extensions.length
          ? formatMarkdownTable(typed.isv_extensions, ['module', 'extension_name'])
          : '_No sealed ISV model extends this table._';
        if (typed.isv_delete_actions.length) {
          out += `\n\n### Sealed ISV delete actions (${typed.isv_delete_actions.length})\n`;
          out += formatMarkdownTable(typed.isv_delete_actions, ['module', 'target', 'relation', 'action']);
        }
        out += isvProvenanceNote(typed.isv_extensions.length + typed.isv_delete_actions.length,
          [...new Set(typed.isv_extensions.map(x => x.module))]);
        out += '_Sealed models publish an element inventory, not a field list: the fields these extensions add are not enumerable here._\n';
      }

      // Coverage (#116): field cap, whether sealed-ISV extensions could be in
      // this snapshot at all, and the delta-merge flag.
      return structuredResult(typed, out, format, {
        coverage: coverageNotes({
          field_limit_hit: typed.fields_truncated ? { shown: typed.fields_shown, total: typed.field_count } : null,
          isv_not_scanned: !isvScanned,
          partial_build: partialBuildSince ? { since: partialBuildSince } : null,
        }),
      });
    },
  );
}
