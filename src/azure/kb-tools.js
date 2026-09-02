/**
 * D365FO Knowledge Base – SQLite MCP Tools
 *
 * Registers all 17 KB tools on an McpServer instance, querying
 * the knowledge base stored in a SQLite database.
 *
 * Usage:
 *   import { registerKbTools } from './kb-tools.js';
 *   registerKbTools(server, db);
 */

import {
  query,
  formatMarkdownTable,
  emptyResult,
  notFoundResult,
  truncationNote,
  errorResult,
  makeLabelResolver,
  structuredResult,
  formatTextParam,
  modulesFilterParam,
  sanitizeModulesFilter,
  queryModelVersions,
  numberSourceLines,
  contextAround,
  validateLikePattern,
  patternErrorResult,
  READ_ONLY_DB_ANNOTATIONS,
} from './shared.js';
import { installToolGuards } from './tool-guards.js';
import { z } from 'zod';
import { isCustomFieldName } from './custom-fields.js';
import { hasIsvData } from './isv-schema.js';
import { registerEffectiveSchemaTools, queryTableFields } from './effective-schema-tools.js';
import { cursorParam, decodeCursor, pageMeta, pageNote, probeLimit, takePage } from './pagination.js';
import {
  resolveCustomFieldChecks,
  customFieldsForTable,
  customFieldClassNote,
  customFieldKey,
} from './custom-fields-tools.js';
import {
  d365LookupTableOutput,
  d365GetClassMethodsOutput,
  d365GetJoinKeysOutput,
  d365SearchOutput,
  d365GetEnumOutput,
  d365CheckFieldExistsOutput,
  d365GetMethodSourceOutput,
  d365FindReferencingTablesOutput,
  d365GetModuleSummaryOutput,
  d365GetEntitySourcesOutput,
  d365SqlTemplateOutput,
  d365HallucinationCheckOutput,
  rawSqlOutput,
  d365GraphTraverseOutput,
  d365FieldRenamesOutput,
  d365ListModulesOutput,
  d365ResolveLabelOutput,
} from './output-schemas.js';

// ── Register all 17 KB tools ────────────────────────────────────────────────

export function registerKbTools(server, db) {
  // Agent guardrails (loop detection + one-shot staleness note) wrap every
  // tool registered below. Returns a proxy, so the shared McpServer is not
  // mutated and a second register*Tools() call cannot double-wrap it.
  server = installToolGuards(server, { service: 'kb', db });


  // Batch caps (issue #83).
  //
  // What batching does and does not buy, measured against the live databases:
  // it does NOT shrink the response body. Nesting N payloads under a batch
  // envelope makes the TOON text *larger* than N separate responses (+9.5% for
  // 9 enums, +24% for 3 field checks), because TOON's tabular encoding degrades
  // once arrays nest. What it removes is N-1 round-trips — the per-call request
  // and result framing, and the latency — which is real but does not show up in
  // a byte count of the text channel.
  //
  // Two consequences, both deliberate: a single-target call emits exactly its
  // pre-batching payload so it pays nothing for the feature, and the caps stay
  // modest. Batching a tool whose single response is already large
  // (d365_lookup_table) would trade round-trips for a token bomb, so it is not
  // batched at all.
  const ENUM_BATCH_MAX = 10;
  const SEARCH_BATCH_MAX = 5;
  // Tier 2 of the code path. 10 bodies at the measured ~13-17 line median is a
  // few thousand tokens — a sane ceiling for one turn, and well under the point
  // where pulling the whole class would have been cheaper.
  const METHOD_SOURCE_BATCH_MAX = 10;
  const FIELD_CHECK_BATCH_MAX = 25;

  const q = (sql, params = []) => query(db, sql, params);

  /** Safe number coercion for SQLite TEXT columns that may contain "Yes"/"No"
   *  or other non-numeric strings. Returns null for non-parseable values. */
  function toNum(v) {
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  /** Coerce a relation constraint value to string. Fixed-value relations store a
   *  numeric/enum literal where field-to-field relations store a field name, so
   *  the parsed JSON can yield a number — which would fail the `z.string()`
   *  output schema. Keep null as null. */
  function toStr(v) {
    return v == null ? null : String(v);
  }

  /** True when `col` exists on `table`. Lets tools degrade gracefully on KB
   *  databases built before the customization columns (is_extension /
   *  source_module / is_customized) were added by the builder. */
  function tableHasColumn(table, col) {
    try {
      return q(`PRAGMA table_info(${table})`).some(c => c.name === col);
    } catch { return false; }
  }
  const fieldsHaveCustomization = tableHasColumn('fields', 'is_extension');
  const tablesHaveCustomization = tableHasColumn('tables', 'is_customized');

  function queryFormatted(sql, params = [], columns) {
    try {
      const rows = q(sql, params);
      return formatMarkdownTable(rows, columns);
    } catch (err) {
      // Log server-side; return a visible inline marker that never leaks raw error text.
      console.error('[kb-tools:queryFormatted]', err);
      return '*(db-error — see server logs)*';
    }
  }

  // ── 1. d365_lookup_table ──────────────────────────────────────────────────
  const FIELD_LIMIT_DEFAULT = 200;
  const FIELD_LIMIT_MAX = 2000;
  server.registerTool(
    'd365_lookup_table',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description: 'Get complete metadata for a D365FO table: fields (name, type, EDT), primary key, indexes, and foreign key relations.',
      inputSchema: {
        table_name: z.string().min(1).max(500).describe('Table name (case-insensitive, e.g. CustInvoiceJour)'),
        fields_like: z.string().min(1).max(200).optional().describe('Only list fields whose name contains this text (case-insensitive). Use on wide tables instead of pulling every field.'),
        custom_only: z.boolean().optional().default(false).describe('Only list fields added by a table extension (custom/ISV) - the customisation surface. Counts, indexes and relations are unaffected.'),
        field_limit: z.number().int().min(1).max(FIELD_LIMIT_MAX).optional().default(FIELD_LIMIT_DEFAULT).describe(`Max fields to list; field_count is always the whole table.`),
        include_provenance: z.boolean().optional().default(false).describe('Emit is_extension/source_module on every field. Default false: the pair is emitted only with custom_only, where every row is an extension.'),
        include_custom_fields: z.boolean().optional().default(false).describe('Also read UI custom fields (`_Custom` suffix) LIVE from the configured environment into a separate ui_custom_fields block. Off by default: makes a network call.'),
        environment: z.string().min(1).max(100).optional().describe('Environment key for include_custom_fields. Defaults to the source marked default.'),
        format: formatTextParam,
      },
      outputSchema: d365LookupTableOutput.shape,
    },
    async ({ table_name, fields_like, custom_only, field_limit, include_provenance, include_custom_fields, environment, format }) => {
      const resolve = makeLabelResolver(db);
      const tn = table_name.trim();
      // Defensive default - the test mock server bypasses Zod (contract rule #13).
      const fieldLimit = Number.isInteger(field_limit) && field_limit > 0
        ? Math.min(field_limit, FIELD_LIMIT_MAX) : FIELD_LIMIT_DEFAULT;
      // Provenance is decided per RESPONSE, never per row (rule #14, #107.4):
      // custom_only -> every row is an extension, emit it; include_provenance
      // -> emit everywhere; otherwise nowhere. Same policy as
      // d365_get_entity_sources; the header still carries the customisation
      // summary (custom_field_count, customization_modules) in every case.
      const emitProvenance = include_provenance === true || custom_only === true;

      const customizedCol = tablesHaveCustomization ? 'is_customized' : '0 AS is_customized';
      const tbl = q(
        `SELECT table_name, module_id, label, table_group, save_per_company, cache_lookup, clustered_index, replacement_key, ${customizedCol}
         FROM tables WHERE table_name = ? COLLATE NOCASE`, [tn]
      );

      if (!tbl || tbl.length === 0) {
        // issue #42: gate the wildcard LIKE scan on pattern length before the DB.
        const pv = validateLikePattern(tn);
        if (pv) return patternErrorResult(pv);
        const fuzzy = q(
          `SELECT table_name FROM tables WHERE table_name LIKE ? COLLATE NOCASE LIMIT 10`, [`%${tn}%`]
        );
        return notFoundResult('Table', tn, fuzzy.map(r => r.table_name));
      }

      const row = tbl[0];

      // PM-05 step 1: build the typed payload. Every handler that emits
      // structuredContent must build the typed object FIRST, then render
      // the Markdown fallback from the typed object. This guarantees the
      // two sides never drift.
      let fieldRows = [];
      try {
        // Shared with d365_effective_schema (issue #85): is_extension /
        // source_module are projected as constants on older DBs so downstream
        // code can rely on the keys existing regardless.
        fieldRows = queryTableFields(q, row.table_name, fieldsHaveCustomization);
      } catch (err) {
        console.error('[kb-tools:d365_lookup_table fields]', err);
      }

      // Field narrowing. The counts stay whole-table; only the rendered field
      // list narrows, so a 400-field table can be inspected for one thing
      // without paying for all of it.
      const fieldsLikeTerm = typeof fields_like === 'string' && fields_like.trim()
        ? fields_like.trim().toLowerCase()
        : null;
      const customFieldsOnly = custom_only === true;
      const matchedFieldRows = (fieldsLikeTerm || customFieldsOnly)
        ? fieldRows.filter(f =>
          (!fieldsLikeTerm || String(f.field_name).toLowerCase().includes(fieldsLikeTerm))
          && (!customFieldsOnly || Boolean(f.is_extension)))
        : fieldRows;
      // #107.3: a 300-field table shipped 60 KB by default. The cap applies
      // after the filters; field_count / fields_matched stay whole-table.
      const shownFieldRows = matchedFieldRows.slice(0, fieldLimit);

      const idxRows = q(
        `SELECT index_name, is_unique, is_clustered, fields_json FROM indexes_tbl WHERE table_name = ? COLLATE NOCASE`, [row.table_name]
      );

      const outRelRows = q(
        `SELECT relation_name, related_table, constraints_json, relationship_type, on_delete
         FROM relations WHERE source_table = ? COLLATE NOCASE`, [row.table_name]
      );

      const INCOMING_CAP = 20;
      const inRelRows = q(
        `SELECT source_table, relation_name, constraints_json FROM relations WHERE related_table = ? COLLATE NOCASE LIMIT ?`,
        [row.table_name, INCOMING_CAP]
      );

      function parseConstraints(jsonStr) {
        try {
          const list = JSON.parse(jsonStr || '[]');
          return list.map(c => ({
            field: toStr(c.field),
            related_field: toStr(c.relatedField),
          }));
        } catch { return []; }
      }

      const typed = {
        table_name: row.table_name,
        module_id: row.module_id ?? null,
        label: row.label ? resolve(row.label) : null,
        table_group: row.table_group ?? null,
        save_per_company: toNum(row.save_per_company),
        cache_lookup: row.cache_lookup ?? null,
        clustered_index: row.clustered_index ?? null,
        replacement_key: row.replacement_key ?? null,
        field_count: fieldRows.length,
        fields_matched: matchedFieldRows.length,
        fields_shown: shownFieldRows.length,
        fields_truncated: matchedFieldRows.length > shownFieldRows.length,
        is_customized: Boolean(row.is_customized),
        custom_field_count: fieldRows.filter(f => f.is_extension).length,
        customization_modules: [...new Set(
          fieldRows.filter(f => f.is_extension && f.source_module).map(f => f.source_module)
        )],
        fields: shownFieldRows.map(f => ({
          name: f.field_name,
          type: f.field_type ?? null,
          edt: f.edt ?? null,
          enum_type: f.enum_type ?? null,
          label: f.label ? resolve(f.label) : null,
          mandatory: toNum(f.mandatory),
          ...(emitProvenance ? {
            is_extension: Boolean(f.is_extension),
            source_module: f.source_module ?? null,
          } : {}),
        })),
        indexes: idxRows.map(i => ({
          name: i.index_name,
          is_unique: Boolean(i.is_unique),
          is_clustered: Boolean(i.is_clustered),
          fields: (() => {
            try { return JSON.parse(i.fields_json || '[]'); } catch { return []; }
          })(),
        })),
        outgoing_relations: outRelRows.map(r => ({
          relation_name: r.relation_name ?? null,
          related_table: r.related_table ?? null,
          join_fields: parseConstraints(r.constraints_json),
          relationship_type: r.relationship_type ?? null,
          on_delete: r.on_delete ?? null,
        })),
        incoming_relations: inRelRows.map(r => ({
          source_table: r.source_table ?? null,
          relation_name: r.relation_name ?? null,
          join_fields: parseConstraints(r.constraints_json),
        })),
        incoming_relations_truncated: inRelRows.length >= INCOMING_CAP,
      };

      // PM-05 step 2: render the Markdown fallback from the typed object.
      // Never re-query the DB — the typed object is the source of truth.
      let out = `## ${typed.table_name}\n`;
      out += `Module: ${typed.module_id || '-'} | Group: ${typed.table_group || '-'} | PerCompany: ${typed.save_per_company ?? '-'} | Cache: ${typed.cache_lookup || '-'}\n`;
      if (typed.label) out += `Label: ${typed.label}\n`;
      if (typed.is_customized) {
        out += `Customized: ${typed.custom_field_count} custom field(s)`
          + (typed.customization_modules.length ? ` from ${typed.customization_modules.join(', ')}` : '')
          + '\n';
      }
      out += '\n';

      out += `## Fields (${typed.field_count})\n`;
      out += formatMarkdownTable(
        typed.fields.map(f => ({
          Field: f.name,
          Type: f.type ?? '',
          EDT: f.edt ?? '',
          Enum: f.enum_type ?? '',
          Label: f.label ?? '-',
          Mand: f.mandatory ?? '',
          ...(emitProvenance ? { Custom: f.is_extension ? (f.source_module || '✓') : '' } : {}),
        })),
        emitProvenance
          ? ['Field', 'Type', 'EDT', 'Enum', 'Label', 'Mand', 'Custom']
          : ['Field', 'Type', 'EDT', 'Enum', 'Label', 'Mand'],
      );
      if (typed.fields_truncated) {
        out += truncationNote('cap', typed.fields_shown, FIELD_LIMIT_MAX);
        out += `_${typed.fields_matched} fields match. Narrow with \`fields_like\` / \`custom_only\`, or raise \`field_limit\`._\n\n`;
      } else {
        out += '\n\n';
      }

      out += '## Indexes\n';
      if (typed.indexes.length > 0) {
        out += formatMarkdownTable(
          typed.indexes.map(i => ({
            Index: i.name,
            Unique: i.is_unique ? 'Y' : 'N',
            Clustered: i.is_clustered ? 'Y' : 'N',
            Fields: i.fields.join(', '),
          })),
          ['Index', 'Unique', 'Clustered', 'Fields'],
        );
      } else {
        out += '_No indexes._';
      }
      out += '\n\n';

      out += '## Relations (Foreign Keys)\n';
      if (typed.outgoing_relations.length > 0) {
        out += formatMarkdownTable(
          typed.outgoing_relations.map(r => ({
            Relation: r.relation_name,
            'To Table': r.related_table,
            'Join Fields': r.join_fields
              .filter(c => c.field && c.related_field)
              .map(c => `${c.field}->${c.related_field}`)
              .join(', '),
            Type: r.relationship_type || '-',
            OnDelete: r.on_delete || '-',
          })),
          ['Relation', 'To Table', 'Join Fields', 'Type', 'OnDelete'],
        );
      } else {
        out += '_No relations defined._';
      }
      out += '\n';

      if (typed.incoming_relations.length > 0) {
        out += '\n## Incoming Relations (tables referencing this table)\n';
        out += formatMarkdownTable(
          typed.incoming_relations.map(r => ({
            'From Table': r.source_table,
            Relation: r.relation_name,
            'Join Fields': r.join_fields
              .filter(c => c.field)
              .map(c => `${c.field}->${c.related_field}`)
              .join(', '),
          })),
          ['From Table', 'Relation', 'Join Fields'],
        );
        if (typed.incoming_relations_truncated) out += truncationNote('hard', INCOMING_CAP);
      }

      // Issue #90 — opt-in live block. Kept strictly separate from `fields`:
      // a `fields` row means "declared in a scanned model at build X", while a
      // UI custom field is environment state that no build snapshot contains.
      // Merging them would make a UAT-only field indistinguishable from a
      // build fact, which is the confusion the ADR (#87) exists to prevent.
      if (include_custom_fields === true) {
        const live = await customFieldsForTable(db, typed.table_name, { environment });
        typed.ui_custom_fields = live.fields;
        typed.ui_custom_field_environment = live.environment;
        typed.ui_custom_field_fetched_at = live.fetched_at;
        typed.ui_custom_field_note = live.note;

        out += '\n## UI custom fields (live)\n';
        if (live.note) {
          out += `_Not available: ${live.note}_\n`;
        } else if (!live.fields.length) {
          out += `_None on this table in ${live.environment} as of ${live.fetched_at}._\n`;
        } else {
          out += `_Live from ${live.environment}, fetched ${live.fetched_at} — environment-local, not in the build snapshot._\n\n`;
          out += formatMarkdownTable(live.fields, ['property_name', 'type', 'max_length', 'nullable', 'entity_name', 'attribution']);
          out += '\n';
        }
      }

      return structuredResult(typed, out, format);
    }
  );

  // ── 2. d365_get_join_keys ─────────────────────────────────────────────────
  server.registerTool(
    'd365_get_join_keys',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description: 'Get the exact join fields between two D365FO tables. Critical for writing correct SQL joins.',
      inputSchema: {
      table1: z.string().min(1).max(500).describe('First table name'),
      table2: z.string().min(1).max(500).describe('Second table name'),
      format: formatTextParam,
    },
      outputSchema: d365GetJoinKeysOutput.shape,
    },
    async ({ table1, table2, format }) => {
      const t1 = table1.trim();
      const t2 = table2.trim();

      // Check both directions
      const result = q(
        `SELECT source_table, related_table, relation_name, constraints_json, relationship_type
         FROM relations
         WHERE (source_table = ? COLLATE NOCASE AND related_table = ? COLLATE NOCASE)
            OR (source_table = ? COLLATE NOCASE AND related_table = ? COLLATE NOCASE)`,
        [t1, t2, t2, t1]
      );

      const trapRows = q(
        `SELECT trap_type, wrong_value, correct_value, explanation FROM hallucination_traps
         WHERE (object_name = ? COLLATE NOCASE OR object_name = ? COLLATE NOCASE)
           AND trap_type = 'wrong_join'`,
        [t1, t2]
      );

      function parseConstraintsAsPairs(jsonStr) {
        try {
          const list = JSON.parse(jsonStr || '[]');
          return list.map(c => ({
            source_field: toStr(c.field),
            related_field: toStr(c.relatedField),
          }));
        } catch (e) {
          console.warn('KB tool warning:', e.message);
          return [];
        }
      }

      const typed = {
        table1: t1,
        table2: t2,
        has_relationship: (result && result.length > 0),
        relation_count: result ? result.length : 0,
        relations: (result || []).map(row => ({
          source_table: row.source_table ?? null,
          related_table: row.related_table ?? null,
          relation_name: row.relation_name ?? null,
          relationship_type: row.relationship_type ?? null,
          join_pairs: parseConstraintsAsPairs(row.constraints_json),
        })),
        trap_count: trapRows.length,
        traps: trapRows.map(r => ({
          trap_type: r.trap_type,
          wrong_value: r.wrong_value ?? null,
          correct_value: r.correct_value ?? null,
          explanation: r.explanation ?? null,
        })),
      };

      // Markdown fallback built from the typed object.
      let out;
      if (!typed.has_relationship) {
        out = `## Join Keys: ${t1} <-> ${t2}\n\nNo direct relationship found between ${t1} and ${t2}.\n`;
      } else {
        out = `## Join Keys: ${t1} <-> ${t2}\n\n`;
        for (const rel of typed.relations) {
          const fieldPairs = rel.join_pairs
            .filter(c => c.source_field && c.related_field)
            .map(c => `${rel.source_table}.${c.source_field} = ${rel.related_table}.${c.related_field}`);
          out += `### ${rel.relation_name} (${rel.relationship_type || 'Association'})\n`;
          out += `Direction: ${rel.source_table} -> ${rel.related_table}\n`;
          out += `Join ON:\n`;
          for (const fp of fieldPairs) out += `  ${fp}\n`;
          out += '\n';
        }
      }
      if (typed.trap_count > 0) {
        out += '### Known Hallucination Traps\n';
        for (const t of typed.traps) {
          out += `- WRONG: ${t.wrong_value}\n- CORRECT: ${t.correct_value}\n- ${t.explanation}\n\n`;
        }
      }

      return structuredResult(typed, out, format);
    }
  );

  // ── 3. d365_search ────────────────────────────────────────────────────────
  server.registerTool(
    'd365_search',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description: 'Full-text search across all D365FO objects (tables, classes, enums, entities) for discovery, e.g. "tables related to inventory". Scope with `modules` to specific models (see d365_list_modules).',
      inputSchema: {
      query: z.string().min(1).max(1000).optional().describe('Search query (keywords). Use this or `queries`.'),
      queries: z.array(z.string().min(1).max(1000)).min(1).max(SEARCH_BATCH_MAX).optional()
        .describe(`Run several searches in one call (max ${SEARCH_BATCH_MAX}); object_type / modules / limit apply to each.`),
      object_type: z.string().min(1).max(500).optional().describe('Optional filter: table, class, enum, entity'),
      modules: modulesFilterParam,
      limit: z.number().int().min(1).max(500).optional().default(20).describe('Max results'),
      cursor: cursorParam,
      format: formatTextParam,
    },
      outputSchema: d365SearchOutput.shape,
    },
    async ({ query: singleQuery, queries, object_type, modules, limit, cursor, format }) => {
      const lim = Number.isInteger(limit) && limit > 0 ? limit : 20;
      const moduleFilter = sanitizeModulesFilter(modules);
      const page = decodeCursor(cursor);
      if (!page.ok) return page.error;

      // Batching (issue #83): singular and plural are unioned and deduped, the
      // caller's order is preserved, and the shared filters are hoisted into
      // the envelope — they are what the batch is scoped by.
      const requested = [...new Set([
        ...(Array.isArray(queries) ? queries : []),
        ...(singleQuery ? [singleQuery] : []),
      ].map(s => String(s).trim()).filter(Boolean))];
      if (!requested.length) return errorResult('invalid-input', 'Provide `query` or `queries`.');
      const batchMode = Array.isArray(queries) && queries.length > 0;
      if (batchMode && page.offset > 0) {
        return errorResult('invalid-input', '`cursor` pages a single `query`; run a batch without it.');
      }
      // Defensive cap: Zod's .max() is bypassed by the test mock server (rule #13).
      const searches = requested.slice(0, SEARCH_BATCH_MAX);

      /** One search -> { typed, has_more, error }. `typed` is exactly the
       *  pre-batching single payload; `error` is an errorResult to return as-is.
       *  Fetches limit+1 rows (probe) so has_more is exact; rowid order is the
       *  order the un-ordered query always returned, now made explicit so
       *  OFFSET is stable. */
      const runSearch = (searchQuery, offset = 0) => {
      // issue #42: gate the wildcard LIKE scan on pattern length before the DB.
      const pv = validateLikePattern(searchQuery);
      if (pv) return { error: patternErrorResult(pv) };
      const terms = searchQuery.trim().split(/\s+/).filter(Boolean);
      if (!terms.length) return { error: errorResult('invalid-input', 'Provide at least one search term.') };

      // Issue #17: FTS5 MATCH first (10-50x faster on the ~1 GB KB), same
      // pattern as sec_search. Falls back to LIKE when the DB predates
      // kb_search_fts (older builds, sql.js-only environments).
      let rows;
      try {
        // Each term becomes a quote-escaped prefix-match token.
        const ftsExpr = terms.map(t => `"${t.replace(/"/g, '""')}"*`).join(' AND ');
        let ftsSql = `SELECT s.object_type, s.object_name, s.module_id, s.content
                      FROM kb_search_fts f
                      JOIN kb_search s ON s.rowid = f.rowid
                      WHERE kb_search_fts MATCH ?`;
        const ftsParams = [ftsExpr];
        if (object_type) {
          ftsSql += ` AND s.object_type = ? COLLATE NOCASE`;
          ftsParams.push(object_type);
        }
        if (moduleFilter.length) {
          ftsSql += ` AND s.module_id COLLATE NOCASE IN (${moduleFilter.map(() => '?').join(', ')})`;
          ftsParams.push(...moduleFilter);
        }
        ftsSql += ` ORDER BY s.rowid LIMIT ? OFFSET ?`;
        ftsParams.push(probeLimit(lim), offset);
        rows = q(ftsSql, ftsParams);
      } catch {
        // kb_search_fts missing — LIKE scan over kb_search.
        const likeParts = [];
        const likeParams = [];

        terms.forEach((term) => {
          likeParts.push(`(object_name LIKE ? COLLATE NOCASE OR content LIKE ? COLLATE NOCASE)`);
          likeParams.push(`%${term}%`, `%${term}%`);
        });

        let sql = `SELECT object_type, object_name, module_id, content
                   FROM kb_search
                   WHERE ${likeParts.join(' AND ')}`;

        if (object_type) {
          sql += ` AND object_type = ? COLLATE NOCASE`;
          likeParams.push(object_type);
        }

        if (moduleFilter.length) {
          sql += ` AND module_id COLLATE NOCASE IN (${moduleFilter.map(() => '?').join(', ')})`;
          likeParams.push(...moduleFilter);
        }

        sql += ` ORDER BY rowid LIMIT ? OFFSET ?`;
        likeParams.push(probeLimit(lim), offset);

        try {
          rows = q(sql, likeParams);
        } catch (err) {
          return { error: errorResult('db-error', 'Try a shorter or more specific search term.', err) };
        }
      }

      const pageRows = takePage(rows, lim);
      rows = pageRows.rows;
      return {
        has_more: pageRows.has_more,
        typed: {
          query: searchQuery,
          object_type: object_type ?? null,
          modules: moduleFilter.length ? moduleFilter : null,
          limit: lim,
          result_count: rows.length,
          truncated: pageRows.has_more,
          results: rows.map(r => ({
            object_type: r.object_type ?? null,
            object_name: r.object_name,
            module_id: r.module_id ?? null,
            // Rule #12: center the snippet on the first matching term instead
            // of blindly taking the first 120 chars (matches beyond position
            // 120 used to be invisible in the context column).
            context: r.content != null ? contextAround(r.content, terms[0], 60) : null,
          })),
        },
      };
      };

      const renderRows = (results) => formatMarkdownTable(results.map(r => ({
        object_type: r.object_type ?? '',
        object_name: r.object_name,
        module_id: r.module_id ?? '',
        context: r.context ?? '',
      })));

      if (!batchMode) {
        const { typed, has_more, error } = runSearch(searches[0], page.offset);
        if (error) return error;
        // Page envelope (#109): has_more always, next_cursor only when true.
        Object.assign(typed, pageMeta(null, page.offset, typed.result_count, lim, has_more));
        if (typed.result_count === 0) {
          return emptyResult(`matches for "${typed.query}"`, typed);
        }
        // Exactly the pre-batching payload plus the page keys: no batch keys at all.
        let out = `## Search Results: "${typed.query}"\n\n`;
        if (typed.modules) out += `_Scope: modules ${typed.modules.join(', ')}_\n\n`;
        out += renderRows(typed.results);
        if (typed.has_more) out += pageNote(typed.result_count, page.offset, typed.next_cursor);
        return structuredResult(typed, out, format);
      }

      // Batch mode: the shared scope is carried once in the envelope, each
      // query carries only what differs. A query with zero hits is data
      // (result_count 0), not a failure — there is no "not found" for a search.
      const perQuery = [];
      for (const sq of searches) {
        const { typed, error } = runSearch(sq);
        if (error) return error;
        perQuery.push({
          query: typed.query,
          result_count: typed.result_count,
          truncated: typed.truncated,
          results: typed.results,
        });
      }
      const typed = {
        object_type: object_type ?? null,
        modules: moduleFilter.length ? moduleFilter : null,
        limit: lim,
        requested_count: searches.length,
        queries: perQuery,
      };

      let out = `## Search Results (${typed.requested_count} queries)\n\n`;
      if (typed.modules) out += `_Scope: modules ${typed.modules.join(', ')}_\n\n`;
      for (const p of perQuery) {
        out += `### "${p.query}" (${p.result_count})\n`;
        out += p.result_count ? renderRows(p.results) : '_No matches._';
        out += p.truncated ? truncationNote('user', lim) + '\n' : '\n\n';
      }
      if (requested.length > searches.length) out += truncationNote('cap', searches.length, SEARCH_BATCH_MAX);
      return structuredResult(typed, out, format);
    }
  );

  // ── 4. d365_get_enum ──────────────────────────────────────────────────────
  server.registerTool(
    'd365_get_enum',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description: 'All values of a D365FO enum with their numeric values — essential for correct SQL and X++. `enum_names` resolves up to 10 enums in one call.',
      inputSchema: {
        enum_name: z.string().min(1).max(500).optional().describe('Enum name (e.g. StatusIssue, InventTransType). Use this or `enum_names`.'),
        enum_names: z.array(z.string().min(1).max(500)).min(1).max(ENUM_BATCH_MAX).optional()
          .describe(`Several enums in one call (max ${ENUM_BATCH_MAX}); unknown names come back in \`not_found\`.`),
        format: formatTextParam,
      },
      outputSchema: d365GetEnumOutput.shape,
    },
    async ({ enum_name, enum_names, format }) => {
      const resolve = makeLabelResolver(db);

      // Singular and plural are unioned so passing both is not an error, and
      // deduped so a caller repeating a name does not inflate the IN clause.
      const requested = [...new Set([
        ...(Array.isArray(enum_names) ? enum_names : []),
        ...(enum_name ? [enum_name] : []),
      ].map(n => String(n).trim()).filter(Boolean))];

      if (!requested.length) {
        return errorResult('invalid-input', 'Provide `enum_name` or `enum_names`.');
      }
      // Defensive cap: Zod's .max() is bypassed by the test mock server (rule #13).
      const names = requested.slice(0, ENUM_BATCH_MAX);
      const batchMode = Array.isArray(enum_names) && enum_names.length > 0;

      const rows = q(
        `SELECT enum_name, module_id, label, values_json FROM enums
         WHERE enum_name IN (${names.map(() => '?').join(', ')}) COLLATE NOCASE`, names
      );

      // Single-target miss keeps its existing behaviour — a not-found error with
      // fuzzy suggestions. Only batch mode reports misses as data, because there
      // the call as a whole still succeeded.
      if ((!rows || rows.length === 0) && !batchMode) {
        const fuzzy = q(
          `SELECT enum_name FROM enums WHERE enum_name LIKE ? COLLATE NOCASE LIMIT 10`, [`%${names[0]}%`]
        );
        return notFoundResult('Enum', names[0], fuzzy.map(r => r.enum_name));
      }

      /** Build one enum's payload. Parsing values_json has three explicit
       *  outcomes: parse error (visible, never silent), empty array, or values. */
      const toPayload = (row) => {
        let rawValues = null;
        let parseError = false;
        try {
          rawValues = JSON.parse(row.values_json || '[]');
        } catch (e) {
          console.error('[kb-tools:d365_get_enum parse]', e);
          parseError = true;
        }
        const values = Array.isArray(rawValues) ? rawValues : [];
        // Two keys are emitted only when they carry information. `parse_error`
        // must stay visible when true (a silent parse failure is the bug this
        // guards against) but false is the overwhelming case; and 12.3% of enum
        // values have no label at all. Both were dead weight on every response.
        return {
          enum_name: row.enum_name,
          module_id: row.module_id ?? null,
          label: row.label ? resolve(row.label) : null,
          value_count: values.length,
          // `label` stays as an explicit null. Omitting it on the 12.3% of
          // values that have none saves ~1% of the JSON and costs +107% of the
          // TOON text channel: ragged rows drop TOON out of its tabular form
          // into a per-row key/value list. Uniform rows are the whole point of
          // a tabular encoding — see the note in output-schemas.js.
          values: values.map(v => ({
            name: String(v.name ?? ''),
            value: typeof v.value === 'number' ? v.value : (v.value == null ? null : Number(v.value)),
            label: v.label ? resolve(v.label) : null,
          })),
          ...(parseError ? { parse_error: true } : {}),
        };
      };

      // Preserve the caller's order rather than SQLite's.
      const byName = new Map((rows || []).map(r => [r.enum_name.toUpperCase(), r]));
      const payloads = names.map(n => byName.get(n.toUpperCase())).filter(Boolean).map(toPayload);
      const notFound = names.filter(n => !byName.has(n.toUpperCase()));

      // Single mode opens at H2 (contract rule #3); batch mode nests each enum
      // under the H2 batch heading.
      const renderOne = (p, heading) => {
        let s = `${heading} ${p.enum_name}\nModule: ${p.module_id ?? '-'} | Label: ${p.label ?? '-'}\n\n`;
        if (p.parse_error) {
          s += '*(Could not parse stored values for this enum — see server logs.)*\n';
        } else if (p.value_count === 0) {
          s += '*(No values defined.)*\n';
        } else {
          s += '|Name|Value|Label|\n|---|---|---|\n';
          for (const v of p.values) s += `|${v.name}|${v.value ?? ''}|${v.label ?? ''}|\n`;
        }
        return s;
      };

      if (!batchMode) {
        const p = payloads[0];
        // Exactly the pre-batching payload: no batch keys at all, so a single
        // call costs precisely what it always did.
        return structuredResult(p, renderOne(p, '##'), format);
      }

      // Batch mode carries only batch keys — the single-target fields are
      // omitted rather than sent as nulls, which cost bytes for no information.
      const typed = {
        requested_count: names.length,
        resolved_count: payloads.length,
        not_found: notFound,
        enums: payloads,
      };

      let out = `## Enums (${typed.resolved_count} of ${typed.requested_count})\n\n`;
      for (const p of payloads) out += renderOne(p) + '\n';
      if (notFound.length) out += `**Not found:** ${notFound.join(', ')}\n`;

      return structuredResult(typed, out, format);
    }
  );

  // ── 5. d365_check_field_exists ────────────────────────────────────────────
  server.registerTool(
    'd365_check_field_exists',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description: 'Verify that fields exist on a D365FO table; suggests corrections for wrong names. Use BEFORE generating SQL. Pass `tables` to check several tables in one call (the usual case for a multi-table join).',
      inputSchema: {
        table_name: z.string().min(1).max(500).optional().describe('Table name. Use this with `field_names`, or use `tables`.'),
        field_names: z.array(z.string().min(1).max(500)).optional().describe('Array of field names to check on `table_name`.'),
        tables: z.array(z.object({
          table_name: z.string().min(1).max(500),
          field_names: z.array(z.string().min(1).max(500)).min(1),
        })).min(1).max(FIELD_CHECK_BATCH_MAX).optional()
          .describe(`Several tables in one call (max ${FIELD_CHECK_BATCH_MAX}); a missing table comes back with found=false.`),
        format: formatTextParam,
      },
      outputSchema: d365CheckFieldExistsOutput.shape,
    },
    async ({ table_name, field_names, tables, format }) => {
      const batchMode = Array.isArray(tables) && tables.length > 0;

      // Union singular and plural so passing both is not an error.
      const requests = [
        ...(batchMode ? tables : []),
        ...(table_name && Array.isArray(field_names) && field_names.length
          ? [{ table_name, field_names }]
          : []),
      ]
        .map(t => ({
          table_name: String(t.table_name ?? '').trim(),
          field_names: (Array.isArray(t.field_names) ? t.field_names : [])
            .map(f => String(f ?? '').trim()).filter(Boolean),
        }))
        .filter(t => t.table_name && t.field_names.length)
        // Defensive cap: Zod's .max() is bypassed by the test mock server (rule #13).
        .slice(0, FIELD_CHECK_BATCH_MAX);

      if (!requests.length) {
        return errorResult('invalid-input',
          'Provide `table_name` with `field_names`, or `tables` with at least one entry.');
      }

      /** Check one table's fields. Returns null when the table does not exist,
       *  which the two modes surface differently: a single-target call keeps its
       *  not-found error, a batch call records it in `not_found`. */
      const checkTable = ({ table_name: tn, field_names: fns }) => {
        const tblCheck = q(
          `SELECT table_name FROM tables WHERE table_name = ? COLLATE NOCASE`, [tn]
        );
        if (!tblCheck || tblCheck.length === 0) return null;
        const realTableName = tblCheck[0].table_name;

        const allFields = q(
          `SELECT field_name FROM fields WHERE table_name = ? COLLATE NOCASE`, [realTableName]
        ) || [];
        const actualFields = new Set(allFields.map(r => r.field_name.toUpperCase()));

        const checks = fns.map(fn => {
          const fnUpper = fn.toUpperCase();
          if (actualFields.has(fnUpper)) {
            return {
              field_name: fn,
              exists: true,
              correct_name: allFields.find(r => r.field_name.toUpperCase() === fnUpper).field_name,
              note: null,
              similar: [],
              origin: 'build-metadata',
              custom_field: null,
            };
          }
          const trap = q(
            `SELECT explanation FROM hallucination_traps
             WHERE object_name = ? COLLATE NOCASE AND wrong_value = ? COLLATE NOCASE`,
            [realTableName, fn]
          );
          const similar = allFields
            .filter(r => r.field_name.toUpperCase().includes(fnUpper) || fnUpper.includes(r.field_name.toUpperCase()))
            .map(r => r.field_name)
            .slice(0, 3);
          return {
            field_name: fn,
            exists: false,
            correct_name: null,
            note: trap.length > 0 ? trap[0].explanation : null,
            similar,
            origin: null,
            custom_field: null,
          };
        });

        return { table_name: realTableName, found: true, check_count: checks.length, checks };
      };

      const renderChecks = (checks) => {
        let s = '|Field|Exists|Note|\n|---|---|---|\n';
        for (const c of checks) {
          if (c.exists) {
            // `note` is null for a snapshot hit and carries the provenance
            // sentence for a field resolved live (issue #90).
            s += `|${c.field_name}|YES|${c.note || c.correct_name}|\n`;
          } else {
            let note = 'DOES NOT EXIST';
            if (c.note) note += ` -- ${c.note}`;
            else if (c.similar.length > 0) note += ` -- similar: ${c.similar.join(', ')}`;
            s += `|${c.field_name}|**NO**|${note}|\n`;
          }
        }
        return s;
      };

      /**
       * Issue #90 — stop answering "does not exist" to a UI custom field.
       *
       * A field name carrying the `_Custom` framework suffix lives in a runtime
       * table extension (SysCustomFieldModel.getExtensionFieldsForTable), so it
       * is absent from every build snapshot BY DESIGN and a bare not-found here
       * is a false negative — the exact wrong answer that cost real analysis
       * time on work item 99957.
       *
       * Two properties this pass must keep:
       *   - a check with no suffixed name makes NO network call (the early
       *     return below), so normal field checks keep their latency;
       *   - a live-source failure never fails the check — the caller still gets
       *     the class explanation, which is what prevents the wrong conclusion.
       *
       * Mutates `tableResults` in place.
       */
      const applyCustomFieldPass = async (tableResults) => {
        const wanted = [];
        for (const t of tableResults) {
          for (const c of t.checks) {
            if (!c.exists && isCustomFieldName(c.field_name)) {
              wanted.push({ table_name: t.table_name, field_name: c.field_name });
            }
          }
        }
        if (!wanted.length) return;

        const { resolved, environment, fetched_at, note } = await resolveCustomFieldChecks(db, wanted);

        for (const t of tableResults) {
          for (const c of t.checks) {
            if (c.exists || !isCustomFieldName(c.field_name)) continue;
            const hit = resolved.get(customFieldKey(t.table_name, c.field_name));
            if (hit) {
              c.exists = true;
              c.correct_name = hit.property_name;
              c.origin = 'custom-field';
              c.custom_field = {
                environment: hit.environment,
                entity_name: hit.entity_name,
                property_name: hit.property_name,
                type: hit.type,
                max_length: hit.max_length,
                fetched_at: hit.fetched_at,
              };
              c.note = `UI custom field — resolved live from ${hit.environment} via entity ${hit.entity_name} (${hit.attribution}).`;
            } else if (note) {
              // No source configured, or the environment could not be read:
              // explain the field class rather than asserting a negative.
              c.note = note;
            } else {
              // An EVIDENCED negative: we did look, in a named environment, at
              // a known point in time.
              c.note = customFieldClassNote(`Checked against ${environment} at ${fetched_at}: not present there.`);
            }
          }
        }
      };

      /**
       * Issue #90 — the sibling invisibility class.
       *
       * `LAC*` / `PRN*` fields on Microsoft tables come from binary-only ISV
       * models (`SalesConfirmDetailsTmp.LACTransRefRecId` is a real field the
       * KB reports as missing, because the model ships no XML for any build to
       * scan). Same wrong answer as the `_Custom` case, different cause and
       * different fix — so it gets the same treatment: explain why the name is
       * invisible to a build snapshot instead of asserting absence.
       *
       * Purely local: no network call, no extra query beyond the one-off
       * `hasIsvData` probe that decides whether to point at `d365_isv_lookup`
       * or at the offline inventory.
       */
      const applySealedIsvNote = (tableResults) => {
        const sealedName = (n) => /^(LAC|PRN)/i.test(String(n));
        const anySealed = tableResults.some(t => t.checks.some(c => !c.exists && sealedName(c.field_name)));
        if (!anySealed) return;

        let isvAvailable = false;
        try { isvAvailable = hasIsvData(db); } catch { isvAvailable = false; }
        const where = isvAvailable
          ? 'Look it up with d365_isv_lookup.'
          : 'This KB carries no sealed-ISV inventory — check the ISV model metadata directly.';

        for (const t of tableResults) {
          for (const c of t.checks) {
            if (c.exists || !sealedName(c.field_name) || c.note) continue;
            c.note = 'LAC/PRN prefix — this may be an extension field added by a binary-only ISV model ' +
              '(no X++ source, no Ax<Type> XML), which no build scan can see, so its absence here is not ' +
              `evidence that it does not exist. ${where}`;
          }
        }
      };

      if (!batchMode) {
        const result = checkTable(requests[0]);
        if (!result) return notFoundResult('Table', requests[0].table_name);
        await applyCustomFieldPass([result]);
        applySealedIsvNote([result]);

        // Exactly the pre-batching payload — no batch keys.
        const typed = {
          table_name: result.table_name,
          check_count: result.check_count,
          checks: result.checks,
        };
        const out = `## Field Check: ${typed.table_name}\n\n` + renderChecks(typed.checks);
        return structuredResult(typed, out, format);
      }

      const results = [];
      const notFound = [];
      for (const req of requests) {
        const r = checkTable(req);
        if (r) results.push(r);
        else notFound.push(req.table_name);
      }

      await applyCustomFieldPass(results);
      applySealedIsvNote(results);

      const typed = {
        requested_count: requests.length,
        not_found: notFound,
        tables: results,
      };

      let out = `## Field Check (${results.length} of ${requests.length} tables)\n\n`;
      for (const r of results) {
        out += `### ${r.table_name}\n\n` + renderChecks(r.checks) + '\n';
      }
      if (notFound.length) out += `**Tables not found:** ${notFound.join(', ')}\n`;

      return structuredResult(typed, out, format);
    }
  );

  // ── 6. d365_get_class_methods ─────────────────────────────────────────────
  server.registerTool(
    'd365_get_class_methods',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description: 'Method signatures of a class, table or data entity — TIER 1: signatures plus each body\'s line count (`source_lines`), no source. Then pull only the bodies you need with `d365_get_method_source`. `include_source: true` is ~6x this response; use it on at most one class per investigation.',
      inputSchema: {
        name: z.string().min(1).max(500).describe('Class, table, or data entity name'),
        filter: z.string().min(1).max(500).optional().describe('Optional filter on method name (LIKE pattern). Cheapest way to narrow a wide class.'),
        include_source: z.boolean().optional().default(false).describe('Full X++ body of EVERY method (~6x the signature listing); prefer d365_get_method_source for specific methods.'),
        limit: z.number().int().min(1).max(500).optional().default(100).describe('Max results'),
        cursor: cursorParam,
        format: formatTextParam,
      },
      outputSchema: d365GetClassMethodsOutput.shape,
    },
    async ({ name, filter, include_source, limit, cursor, format }) => {
      // Defensive defaults (mock server bypasses Zod)
      include_source = include_source === true;
      limit = Number.isInteger(limit) && limit > 0 ? limit : 100;
      const page = decodeCursor(cursor);
      if (!page.ok) return page.error;

      const n = name.trim();

      // On a signature listing the body is never transferred — only its line
      // count, computed in SQL. That count replaces the `"source_code":null`
      // this used to emit for every method, and is both cheaper than that null
      // and the thing that lets a caller decide whether tier 2 is worth a turn.
      const LINE_COUNT_SQL =
        `CASE WHEN source_code IS NULL OR source_code = '' THEN 0
              ELSE LENGTH(source_code) - LENGTH(REPLACE(source_code, char(10), '')) + 1 END AS source_lines`;

      let sql = `SELECT owner_type, method_name, signature, is_static, ${include_source ? 'source_code' : LINE_COUNT_SQL}
                 FROM methods WHERE owner_name = ? COLLATE NOCASE`;
      const params = [n];

      if (filter) {
        sql += ` AND method_name LIKE ? COLLATE NOCASE`;
        params.push(`%${filter}%`);
      }
      // (owner, method_name) is the PK, so this order is stable under OFFSET.
      sql += ` ORDER BY is_static DESC, method_name LIMIT ? OFFSET ?`;
      params.push(probeLimit(limit), page.offset);

      const { rows: result, has_more } = takePage(q(sql, params) || [], limit);
      if (result.length === 0) {
        return emptyResult(`methods on "${n}"`, {
          owner_name: n,
          owner_type: '',
          extends_class: null,
          implements_list: null,
          is_abstract: false,
          include_source,
          method_count: 0,
          methods: [],
          truncated: false,
          has_more: false,
        });
      }

      const ownerType = result[0].owner_type;

      // Class-level metadata (only for class owners)
      let extendsClass = null;
      let implementsList = null;
      let isAbstract = false;
      if (ownerType === 'class') {
        const cls = q(
          `SELECT extends_class, implements_list, is_abstract FROM classes WHERE class_name = ? COLLATE NOCASE`, [n]
        );
        if (cls.length > 0) {
          extendsClass = cls[0].extends_class ?? null;
          implementsList = cls[0].implements_list ?? null;
          isAbstract = Boolean(cls[0].is_abstract);
        }
      }

      const typed = {
        owner_name: n,
        owner_type: ownerType,
        extends_class: extendsClass,
        implements_list: implementsList,
        is_abstract: isAbstract,
        include_source,
        method_count: result.length,
        methods: result.map(r => (include_source
          ? {
            method_name: r.method_name,
            signature: r.signature ?? null,
            is_static: Boolean(r.is_static),
            source_code: r.source_code ?? null,
          }
          : {
            method_name: r.method_name,
            signature: r.signature ?? null,
            is_static: Boolean(r.is_static),
            source_lines: toNum(r.source_lines) ?? 0,
          })),
        ...(include_source ? {} : {
          source_lines_total: result.reduce((a, r) => a + (toNum(r.source_lines) ?? 0), 0),
        }),
        truncated: has_more,
        ...pageMeta(null, page.offset, result.length, limit, has_more),
      };

      // Markdown fallback rendered from the typed object.
      let out = `## Methods: ${typed.owner_name} (${typed.owner_type})\n\n`;
      if (typed.is_abstract) out += `Abstract class\n`;
      if (typed.extends_class) out += `Extends: ${typed.extends_class}\n`;
      if (typed.implements_list) out += `Implements: ${typed.implements_list}\n`;
      if (typed.is_abstract || typed.extends_class || typed.implements_list) out += '\n';

      if (typed.include_source) {
        out += `_Source blocks are line-numbered (body-relative; line 1 = first line of each method)._\n\n`;
        for (const m of typed.methods) {
          out += `### ${m.method_name}${m.is_static ? ' (static)' : ''}\n`;
          out += `Signature: \`${m.signature || '-'}\`\n`;
          if (m.source_code) {
            out += '```x++\n' + numberSourceLines(m.source_code) + '\n```\n\n';
          } else {
            out += '_No source code available._\n\n';
          }
        }
      } else {
        out += formatMarkdownTable(
          typed.methods.map(m => ({
            Method: m.method_name,
            Static: m.is_static ? 'Y' : 'N',
            Lines: m.source_lines ?? '',
            Signature: m.signature ? m.signature.substring(0, 200) : '',
          })),
          ['Method', 'Static', 'Lines', 'Signature'],
        );
        out += `\n\n_Signatures only. \`Lines\` is each body's length — pull the few you need with \`d365_get_method_source\` (\`method_names\` takes several in one call). \`include_source: true\` returns all ${typed.source_lines_total} lines of X++ at roughly 6x this response._`;
      }

      if (typed.has_more) out += pageNote(typed.method_count, page.offset, typed.next_cursor);

      return structuredResult(typed, out, format);
    }
  );

  // ── 7. d365_get_method_source ─────────────────────────────────────────────
  server.registerTool(
    'd365_get_method_source',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description: 'Full X++ source of specific methods on a class, table or data entity — TIER 2 after `d365_get_class_methods`. One method -> `method_name`; two or more -> `method_names` (a batch of 4 is smaller than 4 single calls and costs one turn instead of four).',
      inputSchema: {
      owner_name: z.string().min(1).max(500).describe('Class, table, or data entity name'),
      method_name: z.string().min(1).max(500).optional().describe('Method name — for exactly one method; otherwise use `method_names`.'),
      method_names: z.array(z.string().min(1).max(500)).min(1).max(METHOD_SOURCE_BATCH_MAX).optional()
        .describe(`Several methods on the same owner in one call (max ${METHOD_SOURCE_BATCH_MAX}) — cheaper than single calls (owner carried once); unknown names come back in \`not_found\`.`),
      format: formatTextParam,
    },
      outputSchema: d365GetMethodSourceOutput.shape,
    },
    async ({ owner_name, method_name, method_names, format }) => {
      const on = owner_name.trim();
      const requested = [
        ...(typeof method_name === 'string' && method_name.trim() ? [method_name.trim()] : []),
        ...(Array.isArray(method_names) ? method_names.map(s => String(s).trim()).filter(Boolean) : []),
      ];
      if (requested.length === 0) {
        return errorResult('invalid-input', 'Provide `method_name` or `method_names`.');
      }
      // Batch and single payloads are disjoint (batching rule #1): a single
      // call still emits exactly its pre-batching structuredContent.
      const batchMode = Array.isArray(method_names) && method_names.length > 0;

      if (batchMode) {
        const unique = [...new Set(requested)].slice(0, METHOD_SOURCE_BATCH_MAX);
        const rows = q(
          `SELECT owner_type, owner_name, method_name, signature, is_static, source_code
             FROM methods
            WHERE owner_name = ? COLLATE NOCASE
              AND method_name IN (${unique.map(() => '?').join(',')}) COLLATE NOCASE`,
          [on, ...unique],
        );
        const byName = new Map(rows.map(r => [String(r.method_name).toLowerCase(), r]));
        const methods = [];
        const notFound = [];
        for (const name of unique) {
          const r = byName.get(name.toLowerCase());
          if (!r) { notFound.push(name); continue; }
          const src = r.source_code ?? null;
          // owner_type / owner_name are DELIBERATELY absent here: the batch is
          // scoped to one owner, so repeating them per entry was 208 chars of
          // duplication on a 4-method call — enough to make the batch payload
          // larger than the single calls it replaces. Hoisted below instead, so
          // the batch is smaller on bytes as well as on round trips.
          methods.push({
            method_name: r.method_name,
            signature: r.signature ?? null,
            is_static: Boolean(r.is_static),
            source_code: src,
            line_count: src ? src.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n').length : null,
          });
        }

        // A partial batch is a SUCCESS (batching rule #2) — misses go to
        // not_found, they do not fail the call.
        const typed = {
          owner_type: rows.length ? rows[0].owner_type : null,
          owner_name: rows.length ? rows[0].owner_name : on,
          requested_count: unique.length,
          resolved_count: methods.length,
          not_found: notFound,
          methods,
        };

        let out = `## Method source: ${typed.owner_name} (${methods.length} of ${unique.length})\n\n`;
        if (methods.length) {
          out += `Type: ${typed.owner_type} | _Line numbers are body-relative (line 1 = first line of each method)._\n\n`;
          for (const m of methods) {
            out += `### ${m.method_name}${m.is_static ? ' (static)' : ''}\n`;
            out += `Signature: \`${m.signature || '-'}\`\n`;
            out += m.source_code
              ? `${m.line_count} line(s)\n\n` + '```x++\n' + numberSourceLines(m.source_code) + '\n```\n\n'
              : '_No source code available._\n\n';
          }
        }
        if (notFound.length) out += `_Not found on ${on}: ${notFound.join(', ')}._\n`;
        return structuredResult(typed, out, format);
      }

      const mn = requested[0];
      const result = q(
        `SELECT owner_type, owner_name, method_name, signature, is_static, source_code
         FROM methods
         WHERE owner_name = ? COLLATE NOCASE AND method_name = ? COLLATE NOCASE`,
        [on, mn]
      );

      if (!result || result.length === 0) {
        // Try fuzzy match on method name
        const fuzzy = q(
          `SELECT method_name FROM methods WHERE owner_name = ? COLLATE NOCASE AND method_name LIKE ? COLLATE NOCASE LIMIT 10`,
          [on, `%${mn}%`]
        );
        return notFoundResult('Method', `${on}.${mn}`, fuzzy.map(r => `${on}.${r.method_name}`));
      }

      const r = result[0];
      const sourceCode = r.source_code ?? null;
      const typed = {
        owner_type: r.owner_type,
        owner_name: r.owner_name,
        method_name: r.method_name,
        signature: r.signature ?? null,
        is_static: Boolean(r.is_static),
        source_code: sourceCode,
        line_count: sourceCode ? sourceCode.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n').length : null,
      };

      let out = `## ${typed.owner_name}.${typed.method_name}\n`;
      out += `Type: ${typed.owner_type} | Static: ${typed.is_static ? 'Yes' : 'No'}\n`;
      out += `Signature: \`${typed.signature || '-'}\`\n\n`;

      if (typed.source_code) {
        // Render with body-relative line numbers so callers can cite an exact
        // `:line` reproducibly (1 = first line of the method body).
        out += `_Line numbers are body-relative (line 1 = first line of the method source); ${typed.line_count} line(s)._\n\n`;
        out += '```x++\n' + numberSourceLines(typed.source_code) + '\n```';
      } else {
        out += '_No source code available for this method._';
      }

      return structuredResult(typed, out, format);
    }
  );

  // ── 8. d365_find_referencing_tables ────────────────────────────────────────
  server.registerTool(
    'd365_find_referencing_tables',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description: 'Find all tables that have foreign key relationships TO a given table. Useful for impact analysis.',
      inputSchema: {
        table_name: z.string().min(1).max(500).describe('Target table name'),
        limit: z.number().int().min(1).max(1000).optional().default(200).describe('Max referencing relations to return'),
        format: formatTextParam,
      },
      outputSchema: d365FindReferencingTablesOutput.shape,
    },
    async ({ table_name, limit, format }) => {
      const tn = table_name.trim();
      // Defensive default - the test mock server bypasses Zod (contract rule #13).
      const lim = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 1000) : 200;

      // Step 1: does the table exist at all? (Distinguishes "non-existent" from "leaf".)
      const exists = q(
        `SELECT table_name FROM tables WHERE table_name = ? COLLATE NOCASE LIMIT 1`, [tn]
      );
      if (!exists || exists.length === 0) {
        const fuzzy = q(
          `SELECT table_name FROM tables WHERE table_name LIKE ? COLLATE NOCASE LIMIT 10`, [`%${tn}%`]
        );
        return notFoundResult('Table', tn, fuzzy.map(r => r.table_name));
      }
      const realName = exists[0].table_name;

      // Step 2: incoming references
      const result = q(
        `SELECT source_table, relation_name, constraints_json, relationship_type
         FROM relations WHERE related_table = ? COLLATE NOCASE
         ORDER BY source_table`, [realName]
      );

      if (!result || result.length === 0) {
        return emptyResult(`tables referencing "${realName}"`, {
          table_name: realName,
          reference_count: 0,
          references: [],
        });
      }

      function parseConstraintsAsPairs(jsonStr) {
        try {
          const list = JSON.parse(jsonStr || '[]');
          return list.map(c => ({
            field: toStr(c.field),
            related_field: toStr(c.relatedField),
          }));
        } catch (e) {
          console.warn('KB tool warning:', e.message);
          return [];
        }
      }

      const shownRefs = result.slice(0, lim);
      const typed = {
        table_name: realName,
        reference_count: result.length,
        returned_count: shownRefs.length,
        references: shownRefs.map(row => ({
          source_table: row.source_table ?? null,
          relation_name: row.relation_name ?? null,
          relationship_type: row.relationship_type ?? null,
          join_fields: parseConstraintsAsPairs(row.constraints_json),
        })),
      };

      let out = `## Tables referencing: ${typed.table_name}\n\n`;
      out += '|Table|Relation|Join Fields|Type|\n|---|---|---|---|\n';
      for (const r of typed.references) {
        const joinFields = r.join_fields.filter(c => c.field).map(c => `${c.field}->${c.related_field}`).join(', ');
        out += `|${r.source_table}|${r.relation_name}|${joinFields}|${r.relationship_type || '-'}|\n`;
      }
      out += `\nTotal: ${typed.reference_count} referencing tables`;

      return structuredResult(typed, out, format);
    }
  );

  // ── 9. d365_get_module_summary ────────────────────────────────────────────
  server.registerTool(
    'd365_get_module_summary',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description: 'Get a summary of a D365FO module/package: object counts and key tables/classes.',
      inputSchema: {
      module_name: z.string().min(1).max(500).describe('Module name (e.g. ApplicationSuite, EngineeringChangeManagement)'),
      table_limit: z.number().int().min(1).max(200).default(20).describe('Max Key Tables rows'),
      class_limit: z.number().int().min(1).max(200).default(15).describe('Max Key Classes rows'),
      format: formatTextParam,
    },
      outputSchema: d365GetModuleSummaryOutput.shape,
    },
    async ({ module_name, table_limit, class_limit, format }) => {
      const resolve = makeLabelResolver(db);
      const mn = module_name.trim();
      // Defensive defaults (mock server bypasses Zod).
      const tLim = Number.isInteger(table_limit) && table_limit > 0 ? Math.min(table_limit, 200) : 20;
      const cLim = Number.isInteger(class_limit) && class_limit > 0 ? Math.min(class_limit, 200) : 15;

      const mod = q(
        `SELECT * FROM modules WHERE module_id = ? COLLATE NOCASE`, [mn]
      );

      if (!mod || mod.length === 0) {
        const fuzzy = q(
          `SELECT module_id FROM modules WHERE module_id LIKE ? COLLATE NOCASE LIMIT 10`, [`%${mn}%`]
        );
        return notFoundResult('Module', mn, fuzzy.map(r => r.module_id));
      }

      const { module_id: mid, table_count: tc, class_count: cc, enum_count: ec, entity_count: dc, form_count: fc } = mod[0];

      // Build provenance of the models in this package ([] on KB databases
      // built before model_versions capture).
      const models = queryModelVersions(q, mid).map(v => ({
        model_name: v.model_name,
        module_id: v.module_id ?? null,
        display_name: v.display_name ?? null,
        publisher: v.publisher ?? null,
        layer: v.layer ?? null,
        origin: v.origin ?? null,
        version: v.version ?? null,
      }));

      const tableRows = q(
        `SELECT table_name, label, field_count, save_per_company, table_group
         FROM tables WHERE module_id = ? COLLATE NOCASE ORDER BY field_count DESC LIMIT ?`, [mid, tLim]
      );
      const classRows = q(
        `SELECT class_name, extends_class, method_count
         FROM classes WHERE module_id = ? COLLATE NOCASE ORDER BY method_count DESC LIMIT ?`, [mid, cLim]
      );

      const typed = {
        module_id: mid,
        models,
        table_count: tc ?? 0,
        class_count: cc ?? 0,
        enum_count: ec ?? 0,
        entity_count: dc ?? 0,
        form_count: fc ?? 0,
        key_tables: tableRows.map(r => ({
          table_name: r.table_name,
          label: r.label ? resolve(r.label) : null,
          field_count: toNum(r.field_count),
          save_per_company: toNum(r.save_per_company),
          table_group: r.table_group ?? null,
        })),
        key_classes: classRows.map(r => ({
          class_name: r.class_name,
          extends_class: r.extends_class ?? null,
          method_count: toNum(r.method_count),
        })),
        tables_truncated: tableRows.length >= tLim,
        classes_truncated: classRows.length >= cLim,
      };

      let out = `## Module: ${typed.module_id}\n\n`;
      if (typed.models.length) {
        out += '## Model Build Versions\n';
        out += formatMarkdownTable(
          typed.models.map(m => ({
            Model: m.model_name,
            Version: m.version ?? '',
            Layer: m.layer ?? '',
            Origin: m.origin ?? '',
            Publisher: m.publisher ?? '',
          })),
          ['Model', 'Version', 'Layer', 'Origin', 'Publisher'],
        );
        out += '\n\n';
      }
      out += `|Type|Count|\n|---|---|\n`;
      out += `|Tables|${typed.table_count}|\n|Classes|${typed.class_count}|\n|Enums|${typed.enum_count}|\n|Entities|${typed.entity_count}|\n|Forms|${typed.form_count}|\n\n`;

      out += '## Key Tables\n';
      out += formatMarkdownTable(
        typed.key_tables.map(t => ({
          Table: t.table_name,
          Label: t.label ?? '-',
          Fields: t.field_count ?? '',
          PerCo: t.save_per_company ?? '',
          Group: t.table_group ?? '',
        })),
        ['Table', 'Label', 'Fields', 'PerCo', 'Group'],
      );
      if (typed.tables_truncated) out += truncationNote('cap', tLim, 200);
      out += '\n\n';

      out += '## Key Classes (by method count)\n';
      out += formatMarkdownTable(
        typed.key_classes.map(c => ({
          Class: c.class_name,
          Extends: c.extends_class ?? '',
          Methods: c.method_count ?? '',
        })),
        ['Class', 'Extends', 'Methods'],
      );
      if (typed.classes_truncated) out += truncationNote('cap', cLim, 200);

      return structuredResult(typed, out, format);
    }
  );

  // ── 10. d365_get_entity_sources ───────────────────────────────
  server.registerTool(
    'd365_get_entity_sources',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description: 'Data source chain and fields of a data entity, by AOT name, OData public name or collection name. Every field carries its model: `custom_only` returns the customisation surface; `fields_like` / `computed_only` / `limit` narrow it. Methods omitted unless `include_methods: true` (`method_count` always present).',
      inputSchema: {
        entity_name: z.string().min(1).max(500).describe('Data entity name: AOT name, OData public name, or OData collection name'),
        include_methods: z.boolean().optional().default(false).describe('Include entity method signatures (postLoad, validate*, OData actions). Default false - method_count is always returned.'),
        fields_like: z.string().min(1).max(200).optional().describe('Only fields whose name contains this text (case-insensitive)'),
        custom_only: z.boolean().optional().default(false).describe('Only fields added by a non-Microsoft model or by a table extension - the customisation surface'),
        computed_only: z.boolean().optional().default(false).describe('Only computed/virtual fields (no backing data field)'),
        include_provenance: z.boolean().optional().default(false).describe('Emit source_module/is_extension on EVERY field (default: only on extension fields — on standard fields it repeats the entity\'s module, ~27% of the response).'),
        limit: z.number().int().min(1).max(1000).optional().default(500).describe('Max fields to return'),
        cursor: cursorParam,
        format: formatTextParam,
      },
      outputSchema: d365GetEntitySourcesOutput.shape,
    },
    async ({ entity_name, include_methods, fields_like, custom_only, computed_only, include_provenance, limit, cursor, format }) => {
      const en = entity_name.trim();
      // Defensive defaults - the test mock server bypasses Zod (contract rule #13).
      const lim = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 1000) : 500;
      const page = decodeCursor(cursor);
      if (!page.ok) return page.error;
      const wantMethods = include_methods === true;
      const customOnly = custom_only === true;
      const computedOnly = computed_only === true;
      const wantProvenance = include_provenance === true;
      const likeTerm = typeof fields_like === 'string' && fields_like.trim()
        ? fields_like.trim().toLowerCase()
        : null;

      // Resolve the AOT name first, then the OData names a caller actually holds:
      // public_collection ("ReleasedProductsV2") and public_name ("ReleasedProductV2").
      const result = q(
        `SELECT entity_name, module_id, label, public_name, public_collection, is_public, primary_table, staging_table, config_key
         FROM data_entities
         WHERE entity_name = ? COLLATE NOCASE
            OR public_collection = ? COLLATE NOCASE
            OR public_name = ? COLLATE NOCASE
         ORDER BY CASE WHEN entity_name = ? COLLATE NOCASE THEN 0
                       WHEN public_collection = ? COLLATE NOCASE THEN 1
                       ELSE 2 END
         LIMIT 1`, [en, en, en, en, en]
      );

      if (!result || result.length === 0) {
        const fuzzy = q(
          `SELECT entity_name FROM data_entities
           WHERE entity_name LIKE ? COLLATE NOCASE
              OR public_collection LIKE ? COLLATE NOCASE
              OR public_name LIKE ? COLLATE NOCASE
           LIMIT 10`, [`%${en}%`, `%${en}%`, `%${en}%`]
        );
        return notFoundResult('Entity', en, fuzzy.map(r => r.entity_name));
      }

      const r = result[0];

      // Field rows carry their owning model via the backing table field
      // (fields.source_module / is_extension), so custom_only needs no second
      // round-trip. The join key (table_name, field_name) is the fields PK, so
      // it cannot multiply rows; an entity data source that is an alias rather
      // than a table name simply yields a null attribution.
      let fieldRows = [];
      try {
        if (!fieldsHaveCustomization) throw new Error('fields table has no attribution columns');
        fieldRows = q(
          `SELECT ef.field_name, ef.data_field, ef.data_source, ef.is_mandatory,
                  f.source_module AS source_module, f.is_extension AS is_extension
           FROM entity_fields ef
           LEFT JOIN fields f
             ON f.table_name = ef.data_source COLLATE NOCASE
            AND f.field_name = ef.data_field COLLATE NOCASE
           WHERE ef.entity_name = ? COLLATE NOCASE
           ORDER BY ef.field_name`, [r.entity_name]
        );
      } catch (err) {
        // KB databases built before fields.source_module / is_extension existed.
        console.warn('[kb-tools:d365_get_entity_sources] no field attribution:', err.message);
        try {
          fieldRows = q(
            `SELECT field_name, data_field, data_source, is_mandatory
             FROM entity_fields WHERE entity_name = ? COLLATE NOCASE ORDER BY field_name`, [r.entity_name]
          );
        } catch (err2) {
          console.error('[kb-tools:d365_get_entity_sources fields]', err2);
        }
      }

      const allFields = fieldRows.map(f => ({
        field_name: f.field_name,
        data_field: f.data_field ?? null,
        data_source: f.data_source ?? null,
        is_mandatory: toNum(f.is_mandatory),
        source_module: f.source_module ?? null,
        is_extension: f.is_extension == null ? null : toNum(f.is_extension) === 1,
      }));

      // Model origin (microsoft / isv / custom) keyed by model name and package.
      const originByModel = new Map();
      if (customOnly) {
        for (const v of queryModelVersions(q)) {
          const o = String(v.origin ?? '').toLowerCase();
          if (!o) continue;
          if (v.model_name) originByModel.set(String(v.model_name).toLowerCase(), o);
          const mid = v.module_id ? String(v.module_id).toLowerCase() : '';
          if (mid && !originByModel.has(mid)) originByModel.set(mid, o);
        }
      }
      const isCustomField = (f) => {
        if (f.is_extension === true) return true;
        const m = f.source_module ? String(f.source_module).toLowerCase() : '';
        if (!m) return false;
        const o = originByModel.get(m);
        return o === 'custom' || o === 'isv';
      };

      const matched = allFields.filter((f) => {
        if (likeTerm && !String(f.field_name).toLowerCase().includes(likeTerm)) return false;
        if (computedOnly && f.data_field) return false;
        if (customOnly && !isCustomField(f)) return false;
        return true;
      });
      // The model-attribution pair is emitted per RESPONSE, never per row.
      //
      // On a standard Microsoft field `source_module` just repeats the entity's
      // own module and `is_extension` is false — 262 of 284 fields on the
      // reference entity, ~27% of the JSON payload. But dropping it on only
      // *some* rows is worse than keeping it: ragged rows drop the TOON text
      // channel out of its tabular form into a per-row key/value list, measured
      // at +65% on that entity. Uniform rows are the whole point of a tabular
      // encoding.
      //
      // So the decision is made once, from the FILTER rather than the row, and
      // every row in a given response has the same shape:
      //   custom_only        -> every match is an extension, so emit it (useful)
      //   include_provenance -> caller asked for it, emit it everywhere
      //   otherwise          -> emit it nowhere
      // Filtering still runs on the full internal rows, so what comes back is
      // unaffected by what is emitted.
      const emitProvenance = wantProvenance || customOnly;
      // Page over the filtered rows (#109): the list is already in memory and
      // ordered by field_name, so the cursor is a plain offset into `matched`.
      const shownFields = matched.slice(page.offset, page.offset + lim).map(f => (emitProvenance
        ? f
        : { field_name: f.field_name, data_field: f.data_field, data_source: f.data_source, is_mandatory: f.is_mandatory }));

      // Entity-level methods. Derived from the methods table (owner_type='entity')
      // so the count is correct without depending on the data_entities.method_count
      // column, which is absent on KB databases built before this feature. Without
      // include_methods only the count is fetched - the signature list is the
      // single largest block of this response and is rarely why it was called.
      let methodRows = [];
      let methodCount = 0;
      try {
        if (wantMethods) {
          methodRows = q(
            `SELECT method_name, signature, is_static FROM methods
             WHERE owner_type = 'entity' AND owner_name = ? COLLATE NOCASE ORDER BY is_static DESC, method_name`,
            [r.entity_name]
          );
          methodCount = methodRows.length;
        } else {
          const counted = q(
            `SELECT COUNT(*) AS method_count FROM methods
             WHERE owner_type = 'entity' AND owner_name = ? COLLATE NOCASE`,
            [r.entity_name]
          );
          methodCount = toNum(counted?.[0]?.method_count) ?? 0;
        }
      } catch (err) {
        console.error('[kb-tools:d365_get_entity_sources methods]', err);
      }

      const typed = {
        entity_name: r.entity_name,
        module_id: r.module_id ?? null,
        label: r.label ?? null,
        public_name: r.public_name ?? null,
        public_collection: r.public_collection ?? null,
        is_public: Boolean(r.is_public),
        primary_table: r.primary_table ?? null,
        staging_table: r.staging_table ?? null,
        config_key: r.config_key ?? null,
        field_count: allFields.length,
        fields_matched: matched.length,
        fields_returned: shownFields.length,
        entity_fields: shownFields,
        method_count: methodCount,
        methods: methodRows.map(m => ({
          method_name: m.method_name,
          signature: m.signature ?? null,
          is_static: Boolean(m.is_static),
        })),
        ...pageMeta(null, page.offset, shownFields.length, lim, page.offset + shownFields.length < matched.length),
      };

      const activeFilters = [
        likeTerm ? `name contains "${fields_like.trim()}"` : null,
        customOnly ? 'custom/ISV fields only' : null,
        computedOnly ? 'computed fields only' : null,
      ].filter(Boolean);

      let out = `## ${typed.entity_name}\n`;
      out += `Module: ${typed.module_id ?? '-'} | Public: ${typed.is_public ? 'Yes' : 'No'}\n`;
      if (typed.label) out += `Label: ${typed.label}\n`;
      if (typed.public_name) out += `OData Name: ${typed.public_name}\n`;
      if (typed.public_collection) out += `Collection: ${typed.public_collection}\n`;
      if (typed.primary_table) out += `Primary Table: ${typed.primary_table}\n`;
      if (typed.staging_table) out += `Staging Table: ${typed.staging_table}\n`;
      out += '\n';

      out += activeFilters.length
        ? `## Entity Fields (${typed.fields_matched} of ${typed.field_count} - ${activeFilters.join(', ')})\n`
        : `## Entity Fields (${typed.field_count})\n`;
      if (shownFields.length > 0) {
        out += formatMarkdownTable(
          shownFields.map(f => ({
            Field: f.field_name,
            DataField: f.data_field ?? '',
            DataSource: f.data_source ?? '',
            Model: f.source_module ?? '',
            Mand: f.is_mandatory ?? '',
          })),
          ['Field', 'DataField', 'DataSource', 'Model', 'Mand'],
        );
        if (typed.has_more) {
          out += pageNote(shownFields.length, page.offset, typed.next_cursor);
        }
      } else {
        out += '_No fields match the filter._';
        if (customOnly || likeTerm) {
          out += '\n\n_Two classes of field are in no metadata model, and therefore in no KB snapshot: D365 UI custom fields (`*_Custom`, System administration > Custom fields) and fields from binary-only ISV models. For the latter, `d365_isv_lookup` confirms whether the owning object exists in a sealed ISV model — those models publish an element inventory but no field-level detail. Verify in the environment before concluding a field does not exist._';
        }
      }

      out += `\n\n## Methods (${typed.method_count})\n`;
      if (typed.methods.length > 0) {
        out += formatMarkdownTable(
          typed.methods.map(m => ({
            Method: m.method_name,
            Static: m.is_static ? 'Y' : 'N',
            Signature: m.signature ? m.signature.substring(0, 200) : '',
          })),
          ['Method', 'Static', 'Signature'],
        );
        out += `\n\n_Use \`d365_get_class_methods\` (or \`d365_get_method_source\`) with \`include_source\` for the full X++ body._`;
      } else if (typed.method_count > 0) {
        out += `_${typed.method_count} entity methods not listed - pass \`include_methods: true\` for the signatures._`;
      } else {
        out += '_No entity methods._';
      }

      return structuredResult(typed, out, format);
    }
  );

  // ── 11. d365_sql_template ─────────────────────────────────────────────────
  server.registerTool(
    'd365_sql_template',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description: 'Get a pre-validated SQL query template for common D365FO scenarios. Templates have correct join keys and field names.',
      inputSchema: {
      scenario: z.string().max(500).optional().describe('Search term for template (e.g. "customer invoice", "vendor", "GL entries"). Leave empty to list all.'),
      format: formatTextParam,
    },
      outputSchema: d365SqlTemplateOutput.shape,
    },
    async ({ scenario, format }) => {
      let sql, params;
      if (scenario) {
        sql = `SELECT template_id, title, description, sql_template, tables_used
               FROM query_templates WHERE title LIKE ? COLLATE NOCASE OR description LIKE ? COLLATE NOCASE OR tables_used LIKE ? COLLATE NOCASE`;
        params = [`%${scenario}%`, `%${scenario}%`, `%${scenario}%`];
      } else {
        sql = `SELECT template_id, title, description, sql_template, tables_used FROM query_templates`;
        params = [];
      }

      const result = q(sql, params);
      if (!result || result.length === 0) {
        return emptyResult(scenario ? `templates matching "${scenario}"` : 'templates available', {
          scenario: scenario ?? null,
          template_count: 0,
          templates: [],
        });
      }

      const typed = {
        scenario: scenario ?? null,
        template_count: result.length,
        templates: result.map(row => ({
          template_id: String(row.template_id ?? ''),
          title: String(row.title ?? ''),
          description: row.description ?? null,
          sql_template: row.sql_template ?? '',
          tables_used: row.tables_used ?? null,
        })),
      };

      let out = '## SQL Query Templates\n\n';
      for (const t of typed.templates) {
        out += `### ${t.title}\n`;
        if (t.description) out += `${t.description}\n`;
        if (t.tables_used) out += `Tables: ${t.tables_used}\n`;
        out += '\n```sql\n' + t.sql_template + '\n```\n\n';
      }

      return structuredResult(typed, out, format);
    }
  );

  // ── 12. d365_hallucination_check ──────────────────────────────────────────
  server.registerTool(
    'd365_hallucination_check',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description: 'Check for known D365FO hallucination traps for a table. Returns common LLM mistakes and their corrections.',
      inputSchema: { table_name: z.string().min(1).max(500).describe('Table name to check traps for'), format: formatTextParam },
      outputSchema: d365HallucinationCheckOutput.shape,
    },
    async ({ table_name, format }) => {
      const tn = table_name.trim();

      const result = q(
        `SELECT trap_type, wrong_value, correct_value, explanation
         FROM hallucination_traps WHERE object_name = ? COLLATE NOCASE`, [tn]
      );

      if (!result || result.length === 0) {
        return emptyResult(`hallucination traps for "${tn}"`, {
          table_name: tn,
          trap_count: 0,
          traps: [],
        });
      }

      const typed = {
        table_name: tn,
        trap_count: result.length,
        traps: result.map(t => ({
          trap_type: t.trap_type,
          wrong_value: t.wrong_value ?? null,
          correct_value: t.correct_value ?? null,
          explanation: t.explanation ?? null,
        })),
      };

      let out = `## Hallucination Traps for \`${typed.table_name}\`\n\n`;
      out += formatMarkdownTable(typed.traps, ['trap_type', 'wrong_value', 'correct_value', 'explanation']);

      return structuredResult(typed, out, format);
    }
  );

  // ── 13. d365_raw_sql ──────────────────────────────────────────────────────
  server.registerTool(
    'd365_raw_sql',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description: 'Raw READ-ONLY SQL against the KB (500-row cap), for what no other tool covers. Tables: tables, fields, enums, enum_values, classes, methods, relations, data_entities, entity_fields, modules, model_versions, labels, kb_search (no kb_ prefix otherwise). Columns: PRAGMA table_info(<table>) or d365_sql_template.',
      inputSchema: {
        sql: z.string().min(1).max(50000).describe('SQL SELECT query to execute'),
        // The SHARED param (rule #5): a private z.enum(['markdown','toon'])
        // .default('toon') here pinned TOON and defeated the adaptive default.
        format: formatTextParam,
      },
      outputSchema: rawSqlOutput.shape,
    },
    async ({ sql: rawSql, format }) => {
      const SAFETY_CAP = 500;
      const trimmed = rawSql.trim();

      // Strip SQL comments (block and line) BEFORE any keyword scanning, so a
      // caller can't hide a forbidden keyword behind `-- DROP TABLE`.
      const stripped = trimmed
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/--[^\n]*/g, ' ')
        .trim();
      const upper = stripped.toUpperCase();

      // Only allow SELECT / WITH / PRAGMA statements
      if (!upper.startsWith('SELECT') && !upper.startsWith('WITH') && !upper.startsWith('PRAGMA')) {
        return errorResult('invalid-input', 'Only SELECT, WITH, and PRAGMA queries are allowed.');
      }

      // Block data-modifying keywords anywhere in the (comment-stripped) query.
      const forbidden = ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'CREATE', 'TRUNCATE', 'ATTACH', 'DETACH'];
      for (const kw of forbidden) {
        const regex = new RegExp(`\\b${kw}\\b`, 'i');
        if (regex.test(stripped)) {
          return errorResult('invalid-input', `Forbidden keyword "${kw}" detected. Only read-only queries are allowed.`);
        }
      }

      function buildRawResult(rows, truncated) {
        const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
        const typed = {
          row_count: rows.length,
          truncated,
          columns,
          rows,
        };
        // Both renderings are built; structuredResult picks the smaller unless
        // the caller pinned one. `format` goes through untouched — rule #5.
        let md = formatMarkdownTable(rows);
        if (truncated) md += truncationNote('hard', SAFETY_CAP);
        return structuredResult(typed, md, format);
      }

      // PRAGMA queries are passed through verbatim — wrapping a PRAGMA in an
      // outer SELECT/LIMIT subquery is not valid SQL.
      if (upper.startsWith('PRAGMA')) {
        try {
          const rows = q(stripped.replace(/;+$/, ''));
          return buildRawResult(rows, false);
        } catch (err) {
          return errorResult('db-error', 'Check your PRAGMA syntax.', err);
        }
      }

      // For SELECT / WITH: wrap in an outer subquery with a hard LIMIT. This
      // is bulletproof against caller-supplied `LIMIT` bypass, comment tricks,
      // or embedded LIMIT-in-string-literal shenanigans.
      const inner = stripped.replace(/;+$/, '');
      const safeSql = `SELECT * FROM (${inner}) _sub LIMIT ${SAFETY_CAP}`;
      try {
        const rows = q(safeSql);
        return buildRawResult(rows, rows.length >= SAFETY_CAP);
      } catch (err) {
        return errorResult('db-error', 'Check your SQL syntax and table/column names. Only read-only SELECT queries are supported.', err);
      }
    }
  );

  // ── 14. d365_graph_traverse ───────────────────────────────────────────────
  server.registerTool(
    'd365_graph_traverse',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description: 'Traverse the D365FO object dependency graph. Find related tables, class hierarchies, or entity-to-table mappings within N hops.',
      inputSchema: {
      start_node: z.string().min(1).max(500).describe('Starting object name'),
      max_depth: z.number().int().min(0).max(10).optional().default(2).describe('Maximum traversal depth (0-10, default 2)'),
      edge_type: z.string().min(1).max(500).optional().describe('Optional edge type filter: FK, extends, datasource'),
      format: formatTextParam,
    },
      outputSchema: d365GraphTraverseOutput.shape,
    },
    async ({ start_node, max_depth, edge_type, format }) => {
      const sn = start_node.trim();
      // Defensive default: tests bypass Zod, so max_depth can be undefined.
      const depth = Math.min(Number.isInteger(max_depth) && max_depth > 0 ? max_depth : 2, 4);

      // Build the edge filter as a single reusable fragment. The recursive
      // CTE needs it in TWO places (anchor + recursive), so the params array
      // must interleave edge_type binds around the depth bind in the correct
      // order: [start_node, ...anchorEdge, maxDepth, ...recursiveEdge].
      // Previously this used multi-branch push() calls that were hard to
      // read; the explicit list below makes the argument order unambiguous.
      const edgeClause = edge_type ? 'AND edge_type = ? COLLATE NOCASE' : '';
      const edgeBinds = edge_type ? [edge_type] : [];
      const params = [sn, ...edgeBinds, depth, ...edgeBinds];

      const sql = `
        WITH RECURSIVE connected(node, node_type, edge, detail, depth) AS (
          SELECT target_node, target_type, edge_type, edge_detail, 1
          FROM graph_edges
          WHERE source_node = ? COLLATE NOCASE ${edgeClause}
          UNION ALL
          SELECT g.target_node, g.target_type, g.edge_type, g.edge_detail, c.depth + 1
          FROM graph_edges g
          JOIN connected c ON g.source_node = c.node
          WHERE c.depth < ? ${edgeClause}
        )
        SELECT DISTINCT node, node_type, edge, depth
        FROM connected
        ORDER BY depth, node
        LIMIT 100
      `;

      const result = q(sql, params);
      if (!result || result.length === 0) {
        return emptyResult(`connections from "${sn}"`, {
          start_node: sn,
          max_depth: depth,
          edge_type: edge_type ?? null,
          node_count: 0,
          truncated: false,
          nodes: [],
        });
      }

      const typed = {
        start_node: sn,
        max_depth: depth,
        edge_type: edge_type ?? null,
        node_count: result.length,
        truncated: result.length >= 100,
        nodes: result.map(r => ({
          node: r.node,
          node_type: r.node_type ?? null,
          edge: r.edge ?? null,
          depth: r.depth,
        })),
      };

      let out = `## Graph: ${typed.start_node} (${typed.max_depth} hops${typed.edge_type ? `, ${typed.edge_type} only` : ''})\n\n`;
      out += formatMarkdownTable(
        typed.nodes.map(r => ({ Node: r.node, Type: r.node_type ?? '', Edge: r.edge ?? '', Depth: r.depth })),
        ['Node', 'Type', 'Edge', 'Depth'],
      );
      if (typed.truncated) out += truncationNote('hard', 100);

      return structuredResult(typed, out, format);
    }
  );

  // ── 15. d365_field_renames ────────────────────────────────────────────────
  server.registerTool(
    'd365_field_renames',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description: 'Look up AX2012-to-D365FO field renames for a table. Prevents using obsolete field names.',
      inputSchema: { table_name: z.string().min(1).max(500).describe('Table name'), format: formatTextParam },
      outputSchema: d365FieldRenamesOutput.shape,
    },
    async ({ table_name, format }) => {
      const tn = table_name.trim();
      const result = q(
        `SELECT ax2012_name, d365fo_name
         FROM field_renames WHERE table_name = ? COLLATE NOCASE`, [tn]
      );
      if (!result || result.length === 0) {
        return emptyResult(`known field renames for "${tn}"`, {
          table_name: tn,
          rename_count: 0,
          renames: [],
        });
      }
      const typed = {
        table_name: tn,
        rename_count: result.length,
        renames: result.map(r => ({
          ax2012_name: r.ax2012_name,
          d365fo_name: r.d365fo_name,
        })),
      };
      let out = `## Field Renames: ${typed.table_name} (AX2012 -> D365FO)\n\n`;
      out += formatMarkdownTable(
        typed.renames.map(r => ({ AX2012: r.ax2012_name, D365FO: r.d365fo_name })),
        ['AX2012', 'D365FO'],
      );
      return structuredResult(typed, out, format);
    }
  );

  // ── 16. d365_list_modules ─────────────────────────────────────────────────
  server.registerTool(
    'd365_list_modules',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description: 'List modules/packages with object counts and Descriptor provenance (version, layer, origin microsoft/isv/custom, publisher) — the Level-0 directory of the KB. `origin: "custom"` returns a handful of models instead of ~170; `include_counts: false` for a bare list.',
      inputSchema: {
        origin: z.enum(['microsoft', 'isv', 'custom']).optional().describe('Only models with this build origin. Use "custom" / "isv" for the customisation surface.'),
        layer: z.string().min(1).max(20).optional().describe('Only models on this layer (SYS, SLN, ISV, VAR, USR)'),
        publisher: z.string().min(1).max(200).optional().describe('Only models whose publisher contains this text (case-insensitive)'),
        include_counts: z.boolean().optional().default(true).describe('Include table/class/enum/entity/form counts. Set false for a bare model list.'),
        limit: z.number().int().min(1).max(500).optional().default(200).describe('Max modules to return'),
        format: formatTextParam,
      },
      outputSchema: d365ListModulesOutput.shape,
    },
    async ({ origin, layer, publisher, include_counts, limit, format }) => {
      // Defensive defaults - the test mock server bypasses Zod (contract rule #13).
      const lim = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 500) : 200;
      const withCounts = include_counts !== false;
      const originF = typeof origin === 'string' && origin.trim() ? origin.trim().toLowerCase() : null;
      const layerF = typeof layer === 'string' && layer.trim() ? layer.trim().toLowerCase() : null;
      const publisherF = typeof publisher === 'string' && publisher.trim() ? publisher.trim().toLowerCase() : null;
      const filtered = Boolean(originF || layerF || publisherF);

      const result = q(
        `SELECT module_id, table_count, class_count, enum_count, entity_count, form_count
         FROM modules ORDER BY table_count DESC`
      );
      if (!result || result.length === 0) {
        return emptyResult('modules in the knowledge base', {
          module_count: 0,
          returned_count: 0,
          modules: [],
        });
      }
      // Build provenance per package: a package can hold several models
      // (e.g. ApplicationSuite), so distinct values are joined with ', '.
      const byModule = new Map();
      for (const v of queryModelVersions(q)) {
        const key = (v.module_id ?? '').toLowerCase();
        if (!byModule.has(key)) byModule.set(key, []);
        byModule.get(key).push(v);
      }
      const provenance = (moduleId, field) => {
        const vals = [...new Set(
          (byModule.get(moduleId.toLowerCase()) || []).map(r => r[field]).filter(Boolean),
        )];
        return vals.length ? vals.join(', ') : null;
      };
      // A package matches when ANY of its models does - filtering the joined
      // provenance string would drop mixed-origin packages.
      const matchesFilter = (moduleId) => {
        if (!filtered) return true;
        const rows = byModule.get(moduleId.toLowerCase()) || [];
        return rows.some(r =>
          (!originF || String(r.origin ?? '').toLowerCase() === originF)
          && (!layerF || String(r.layer ?? '').toLowerCase() === layerF)
          && (!publisherF || String(r.publisher ?? '').toLowerCase().includes(publisherF)));
      };

      const matched = result.filter(r => matchesFilter(r.module_id));
      const shown = matched.slice(0, lim);
      const typed = {
        module_count: matched.length,
        returned_count: shown.length,
        // With include_counts:false the count keys are OMITTED, never nulled -
        // nulling them costs MORE than emitting the number (`"table_count":null`
        // is 18 chars against 15 for `"table_count":8`), which made the option a
        // measured +5.6% net loss.
        modules: shown.map(r => ({
          module_id: r.module_id,
          ...(withCounts ? {
            table_count: r.table_count ?? null,
            class_count: r.class_count ?? null,
            enum_count: r.enum_count ?? null,
            entity_count: r.entity_count ?? null,
            form_count: r.form_count ?? null,
          } : {}),
          version: provenance(r.module_id, 'version'),
          origin: provenance(r.module_id, 'origin'),
          publisher: provenance(r.module_id, 'publisher'),
          layer: provenance(r.module_id, 'layer'),
        })),
      };

      const filterDesc = [
        originF ? `origin=${originF}` : null,
        layerF ? `layer=${layerF}` : null,
        publisherF ? `publisher~${publisherF}` : null,
      ].filter(Boolean).join(', ');

      if (matched.length === 0) {
        return emptyResult(`modules matching ${filterDesc}`, typed);
      }

      let out = `## D365FO Modules (${typed.module_count}${filterDesc ? ` matching ${filterDesc}` : ' total'})\n\n`;
      const columns = withCounts
        ? ['Module', 'Version', 'Origin', 'Layer', 'Tables', 'Classes', 'Enums', 'Entities', 'Forms']
        : ['Module', 'Version', 'Origin', 'Layer', 'Publisher'];
      out += formatMarkdownTable(
        typed.modules.map(m => (withCounts ? {
          Module: m.module_id,
          Version: m.version ?? '',
          Origin: m.origin ?? '',
          Layer: m.layer ?? '',
          Tables: m.table_count ?? '',
          Classes: m.class_count ?? '',
          Enums: m.enum_count ?? '',
          Entities: m.entity_count ?? '',
          Forms: m.form_count ?? '',
        } : {
          Module: m.module_id,
          Version: m.version ?? '',
          Origin: m.origin ?? '',
          Layer: m.layer ?? '',
          Publisher: m.publisher ?? '',
        })),
        columns,
      );
      if (typed.module_count > typed.returned_count) {
        out += truncationNote('cap', typed.returned_count, 500);
      }
      return structuredResult(typed, out, format);
    }
  );

  // ── 17. d365_resolve_label ──────────────────────────────────────────────────
  server.registerTool(
    'd365_resolve_label',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description: 'Resolve D365FO label IDs (like @SYS12345) to human-readable text. Use when you encounter unresolved label references.',
      inputSchema: {
      label_ids: z.array(z.string().regex(/^@[A-Za-z]+\d+$/, 'Label IDs must match the @LangPrefixNNNN pattern, e.g. "@SYS12345"'))
        .min(1, 'Provide at least one label ID.')
        .max(100, 'Max 100 label IDs per call.')
        .describe('Array of label IDs to resolve, e.g. ["@SYS12345"]. Max 100 per call.'),
      format: formatTextParam,
    },
      outputSchema: d365ResolveLabelOutput.shape,
    },
    async ({ label_ids, format }) => {
      // Dedupe before building the IN (...) clause so a caller passing 100 copies
      // of the same id doesn't inflate the placeholder list.
      const unique = [...new Set(label_ids)];
      // Defensive default: Zod enforces .min(1), but the test mock server
      // bypasses Zod, so guard the empty-array case explicitly (contract item 13).
      if (!unique.length) {
        return emptyResult('label IDs provided', {
          requested_count: 0,
          resolved_count: 0,
          not_found_count: 0,
          resolved: [],
          not_found: [],
        });
      }
      const placeholders = unique.map(() => '?').join(', ');
      const result = q(
        `SELECT label_id, text FROM labels WHERE label_id IN (${placeholders}) COLLATE NOCASE`,
        unique
      );

      if (!result || result.length === 0) {
        return emptyResult(`labels matching ${unique.join(', ')}`, {
          requested_count: unique.length,
          resolved_count: 0,
          not_found_count: unique.length,
          resolved: [],
          not_found: unique,
        });
      }

      const found = new Set(result.map(r => r.label_id));
      const missing = unique.filter(id => !found.has(id));

      const typed = {
        requested_count: unique.length,
        resolved_count: result.length,
        not_found_count: missing.length,
        resolved: result.map(r => ({ label_id: r.label_id, text: r.text })),
        not_found: missing,
      };

      let out = '## Label Resolution\n\n|Label ID|Text|\n|---|---|\n';
      for (const row of typed.resolved) {
        out += `|${row.label_id}|${row.text}|\n`;
      }
      if (typed.not_found_count > 0) {
        out += `\n**Not found:** ${typed.not_found.join(', ')}`;
      }

      return structuredResult(typed, out, format);
    }
  );

  // ── 18. d365_effective_schema (issue #85) — own module, registered here so
  // tool-sets.js and every entry point stay untouched. `server` is already the
  // guarded proxy (installToolGuards is idempotent either way).
  registerEffectiveSchemaTools(server, db);
}
