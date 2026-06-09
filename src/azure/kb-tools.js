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
  formatToonBlock,
  textResult,
  emptyResult,
  notFoundResult,
  truncationNote,
  errorResult,
  makeLabelResolver,
  structuredResult,
  validateLikePattern,
  patternErrorResult,
  READ_ONLY_DB_ANNOTATIONS,
} from './shared.js';
import { z } from 'zod';
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

  const q = (sql, params = []) => query(db, sql, params);

  /** Safe number coercion for SQLite TEXT columns that may contain "Yes"/"No"
   *  or other non-numeric strings. Returns null for non-parseable values. */
  function toNum(v) {
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

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
  server.registerTool(
    'd365_lookup_table',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description: 'Get complete metadata for a D365FO table: fields (name, type, EDT), primary key, indexes, and foreign key relations. Returns both a typed JSON payload (structuredContent) and a Markdown rendering for legacy clients.',
      inputSchema: { table_name: z.string().min(1).max(500).describe('Table name (case-insensitive, e.g. CustInvoiceJour)') },
      outputSchema: d365LookupTableOutput.shape,
    },
    async ({ table_name }) => {
      const resolve = makeLabelResolver(db);
      const tn = table_name.trim();

      const tbl = q(
        `SELECT table_name, module_id, label, table_group, save_per_company, cache_lookup, clustered_index, replacement_key
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
        fieldRows = q(
          `SELECT field_name, field_type, edt, enum_type, label, mandatory
           FROM fields WHERE table_name = ? COLLATE NOCASE ORDER BY field_name`, [row.table_name]
        );
      } catch (err) {
        console.error('[kb-tools:d365_lookup_table fields]', err);
      }

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
            field: c.field ?? null,
            related_field: c.relatedField ?? null,
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
        fields: fieldRows.map(f => ({
          name: f.field_name,
          type: f.field_type ?? null,
          edt: f.edt ?? null,
          enum_type: f.enum_type ?? null,
          label: f.label ? resolve(f.label) : null,
          mandatory: toNum(f.mandatory),
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
        })),
        ['Field', 'Type', 'EDT', 'Enum', 'Label', 'Mand'],
      );
      out += '\n\n';

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

      return structuredResult(typed, out);
    }
  );

  // ── 2. d365_get_join_keys ─────────────────────────────────────────────────
  server.registerTool(
    'd365_get_join_keys',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description: 'Get the exact join fields between two D365FO tables. Critical for writing correct SQL joins. Returns both a typed JSON payload (structuredContent) and a Markdown rendering.',
      inputSchema: {
      table1: z.string().min(1).max(500).describe('First table name'),
      table2: z.string().min(1).max(500).describe('Second table name'),
    },
      outputSchema: d365GetJoinKeysOutput.shape,
    },
    async ({ table1, table2 }) => {
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
            source_field: c.field ?? null,
            related_field: c.relatedField ?? null,
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

      return structuredResult(typed, out);
    }
  );

  // ── 3. d365_search ────────────────────────────────────────────────────────
  server.registerTool(
    'd365_search',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description: 'Full-text search across all D365FO objects (tables, classes, enums, entities). Use for discovery queries like "find tables related to inventory" or "classes that handle product release". Returns both a typed JSON payload (structuredContent) and a Markdown rendering.',
      inputSchema: {
      query: z.string().min(1).max(1000).describe('Search query (keywords)'),
      object_type: z.string().min(1).max(500).optional().describe('Optional filter: table, class, enum, entity'),
      limit: z.number().int().min(1).max(500).optional().default(20).describe('Max results (default 20)'),
    },
      outputSchema: d365SearchOutput.shape,
    },
    async ({ query: searchQuery, object_type, limit }) => {
      const lim = Number.isInteger(limit) && limit > 0 ? limit : 20;
      // issue #42: gate the wildcard LIKE scan on pattern length before the DB.
      const pv = validateLikePattern(searchQuery);
      if (pv) return patternErrorResult(pv);
      const terms = searchQuery.trim().split(/\s+/).filter(Boolean);

      const likeParts = [];
      const likeParams = [];

      terms.forEach((term) => {
        likeParts.push(`(object_name LIKE ? COLLATE NOCASE OR content LIKE ? COLLATE NOCASE)`);
        likeParams.push(`%${term}%`, `%${term}%`);
      });

      let sql = `SELECT object_type, object_name, module_id, SUBSTR(content, 1, 120) as context
                 FROM kb_search
                 WHERE ${likeParts.join(' AND ')}`;

      if (object_type) {
        sql += ` AND object_type = ? COLLATE NOCASE`;
        likeParams.push(object_type);
      }

      sql += ` LIMIT ?`;
      likeParams.push(lim);

      let rows;
      try {
        rows = q(sql, likeParams);
      } catch (err) {
        return errorResult('db-error', 'Try a shorter or more specific search term.', err);
      }

      if (!rows || rows.length === 0) {
        return emptyResult(`matches for "${searchQuery}"`, {
          query: searchQuery,
          object_type: object_type ?? null,
          limit: lim,
          result_count: 0,
          truncated: false,
          results: [],
        });
      }

      const typed = {
        query: searchQuery,
        object_type: object_type ?? null,
        limit: lim,
        result_count: rows.length,
        truncated: rows.length >= lim,
        results: rows.map(r => ({
          object_type: r.object_type ?? null,
          object_name: r.object_name,
          module_id: r.module_id ?? null,
          context: r.context ?? null,
        })),
      };

      let out = `## Search Results: "${typed.query}"\n\n`;
      out += formatMarkdownTable(typed.results.map(r => ({
        object_type: r.object_type ?? '',
        object_name: r.object_name,
        module_id: r.module_id ?? '',
        context: r.context ?? '',
      })));
      if (typed.truncated) out += truncationNote('user', lim);
      return structuredResult(typed, out);
    }
  );

  // ── 4. d365_get_enum ──────────────────────────────────────────────────────
  server.registerTool(
    'd365_get_enum',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description: 'Get all values for a D365FO enum with their numeric values. Essential for correct enum usage in SQL and X++. Returns both a typed JSON payload (structuredContent) and a Markdown rendering.',
      inputSchema: { enum_name: z.string().min(1).max(500).describe('Enum name (e.g. StatusIssue, InventTransType)') },
      outputSchema: d365GetEnumOutput.shape,
    },
    async ({ enum_name }) => {
      const resolve = makeLabelResolver(db);
      const en = enum_name.trim();
      const result = q(
        `SELECT enum_name, module_id, label, values_json FROM enums WHERE enum_name = ? COLLATE NOCASE`, [en]
      );

      if (!result || result.length === 0) {
        const fuzzy = q(
          `SELECT enum_name FROM enums WHERE enum_name LIKE ? COLLATE NOCASE LIMIT 10`, [`%${en}%`]
        );
        return notFoundResult('Enum', en, fuzzy.map(r => r.enum_name));
      }

      const { enum_name: name, module_id: mod, label, values_json: vj } = result[0];

      // Parse values_json with three explicit outcomes:
      //   1. parse error  -> visible parse-error marker (not silent)
      //   2. empty array  -> "No values defined" sentinel
      //   3. ok           -> render the values table
      let rawValues = null;
      let parseError = false;
      try {
        rawValues = JSON.parse(vj || '[]');
      } catch (e) {
        console.error('[kb-tools:d365_get_enum parse]', e);
        parseError = true;
      }
      const values = Array.isArray(rawValues) ? rawValues : [];

      const typed = {
        enum_name: name,
        module_id: mod ?? null,
        label: label ? resolve(label) : null,
        value_count: values.length,
        values: values.map(v => ({
          name: String(v.name ?? ''),
          value: typeof v.value === 'number' ? v.value : (v.value == null ? null : Number(v.value)),
          label: v.label ? resolve(v.label) : null,
        })),
        parse_error: parseError,
      };

      let out = `## ${typed.enum_name}\nModule: ${typed.module_id ?? '-'} | Label: ${typed.label ?? '-'}\n\n`;
      if (parseError) {
        out += `*(Could not parse stored values for this enum — see server logs.)*\n`;
      } else if (typed.value_count === 0) {
        out += '*(No values defined.)*\n';
      } else {
        out += '|Name|Value|Label|\n|---|---|---|\n';
        for (const v of typed.values) {
          out += `|${v.name}|${v.value ?? ''}|${v.label ?? ''}|\n`;
        }
      }

      return structuredResult(typed, out);
    }
  );

  // ── 5. d365_check_field_exists ────────────────────────────────────────────
  server.registerTool(
    'd365_check_field_exists',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description: 'Verify if fields exist on a D365FO table. Returns existence status and suggests corrections for non-existent fields. Use BEFORE generating SQL to prevent hallucinated column names. Returns both a typed JSON payload (structuredContent) and a Markdown rendering.',
      inputSchema: {
      table_name: z.string().min(1).max(500).describe('Table name'),
      field_names: z.array(z.string().min(1).max(500)).describe('Array of field names to check'),
    },
      outputSchema: d365CheckFieldExistsOutput.shape,
    },
    async ({ table_name, field_names }) => {
      const tn = table_name.trim();

      // Verify table exists
      const tblCheck = q(
        `SELECT table_name FROM tables WHERE table_name = ? COLLATE NOCASE`, [tn]
      );
      if (!tblCheck || tblCheck.length === 0) {
        return notFoundResult('Table', tn);
      }
      const realTableName = tblCheck[0].table_name;

      // Get all actual fields
      const allFields = q(
        `SELECT field_name FROM fields WHERE table_name = ? COLLATE NOCASE`, [realTableName]
      );
      const actualFields = new Set((allFields || []).map(r => r.field_name.toUpperCase()));

      const checks = field_names.map(fn => {
        const fnUpper = fn.trim().toUpperCase();
        if (actualFields.has(fnUpper)) {
          const correctName = allFields.find(r => r.field_name.toUpperCase() === fnUpper).field_name;
          return {
            field_name: fn,
            exists: true,
            correct_name: correctName,
            note: null,
            similar: [],
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
        };
      });

      const typed = {
        table_name: realTableName,
        check_count: checks.length,
        checks,
      };

      let out = `## Field Check: ${typed.table_name}\n\n`;
      out += '|Field|Exists|Note|\n|---|---|---|\n';
      for (const c of typed.checks) {
        if (c.exists) {
          out += `|${c.field_name}|YES|${c.correct_name}|\n`;
        } else {
          let note = 'DOES NOT EXIST';
          if (c.note) note += ` -- ${c.note}`;
          else if (c.similar.length > 0) note += ` -- similar: ${c.similar.join(', ')}`;
          out += `|${c.field_name}|**NO**|${note}|\n`;
        }
      }

      return structuredResult(typed, out);
    }
  );

  // ── 6. d365_get_class_methods ─────────────────────────────────────────────
  server.registerTool(
    'd365_get_class_methods',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description: 'Get method signatures (and optionally full X++ source code) for a D365FO class or table. Returns both a typed JSON payload (structuredContent) and a Markdown rendering.',
      inputSchema: {
        name: z.string().min(1).max(500).describe('Class or table name'),
        filter: z.string().min(1).max(500).optional().describe('Optional filter on method name (LIKE pattern)'),
        include_source: z.boolean().optional().default(false).describe('If true, include full X++ source code for each method'),
        limit: z.number().int().min(1).max(500).optional().default(100).describe('Max results (default 100)'),
      },
      outputSchema: d365GetClassMethodsOutput.shape,
    },
    async ({ name, filter, include_source, limit }) => {
      // Defensive defaults (mock server bypasses Zod)
      include_source = include_source === true;
      limit = Number.isInteger(limit) && limit > 0 ? limit : 100;

      const n = name.trim();

      let sql = `SELECT owner_type, method_name, signature, is_static${include_source ? ', source_code' : ''}
                 FROM methods WHERE owner_name = ? COLLATE NOCASE`;
      const params = [n];

      if (filter) {
        sql += ` AND method_name LIKE ? COLLATE NOCASE`;
        params.push(`%${filter}%`);
      }
      sql += ` ORDER BY is_static DESC, method_name LIMIT ?`;
      params.push(limit);

      const result = q(sql, params);
      if (!result || result.length === 0) {
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
        methods: result.map(r => ({
          method_name: r.method_name,
          signature: r.signature ?? null,
          is_static: Boolean(r.is_static),
          source_code: include_source ? (r.source_code ?? null) : null,
        })),
        truncated: result.length >= limit,
      };

      // Markdown fallback rendered from the typed object.
      let out = `## Methods: ${typed.owner_name} (${typed.owner_type})\n\n`;
      if (typed.is_abstract) out += `Abstract class\n`;
      if (typed.extends_class) out += `Extends: ${typed.extends_class}\n`;
      if (typed.implements_list) out += `Implements: ${typed.implements_list}\n`;
      if (typed.is_abstract || typed.extends_class || typed.implements_list) out += '\n';

      if (typed.include_source) {
        for (const m of typed.methods) {
          out += `### ${m.method_name}${m.is_static ? ' (static)' : ''}\n`;
          out += `Signature: \`${m.signature || '-'}\`\n`;
          if (m.source_code) {
            out += '```x++\n' + m.source_code + '\n```\n\n';
          } else {
            out += '_No source code available._\n\n';
          }
        }
      } else {
        out += formatMarkdownTable(
          typed.methods.map(m => ({
            Method: m.method_name,
            Static: m.is_static ? 'Y' : 'N',
            Signature: m.signature ? m.signature.substring(0, 200) : '',
          })),
          ['Method', 'Static', 'Signature'],
        );
      }

      if (typed.truncated) out += truncationNote('user', limit);

      return structuredResult(typed, out);
    }
  );

  // ── 7. d365_get_method_source ─────────────────────────────────────────────
  server.registerTool(
    'd365_get_method_source',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description: 'Get the full X++ source code for a specific method on a class or table. Use this for targeted code analysis when you know the exact method name. Returns both a typed JSON payload (structuredContent) and a Markdown rendering.',
      inputSchema: {
      owner_name: z.string().min(1).max(500).describe('Class or table name'),
      method_name: z.string().min(1).max(500).describe('Method name'),
    },
      outputSchema: d365GetMethodSourceOutput.shape,
    },
    async ({ owner_name, method_name }) => {
      const on = owner_name.trim();
      const mn = method_name.trim();

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
      const typed = {
        owner_type: r.owner_type,
        owner_name: r.owner_name,
        method_name: r.method_name,
        signature: r.signature ?? null,
        is_static: Boolean(r.is_static),
        source_code: r.source_code ?? null,
      };

      let out = `## ${typed.owner_name}.${typed.method_name}\n`;
      out += `Type: ${typed.owner_type} | Static: ${typed.is_static ? 'Yes' : 'No'}\n`;
      out += `Signature: \`${typed.signature || '-'}\`\n\n`;

      if (typed.source_code) {
        out += '```x++\n' + typed.source_code + '\n```';
      } else {
        out += '_No source code available for this method._';
      }

      return structuredResult(typed, out);
    }
  );

  // ── 8. d365_find_referencing_tables ────────────────────────────────────────
  server.registerTool(
    'd365_find_referencing_tables',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description: 'Find all tables that have foreign key relationships TO a given table. Useful for impact analysis. Returns both a typed JSON payload (structuredContent) and a Markdown rendering.',
      inputSchema: { table_name: z.string().min(1).max(500).describe('Target table name') },
      outputSchema: d365FindReferencingTablesOutput.shape,
    },
    async ({ table_name }) => {
      const tn = table_name.trim();

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
            field: c.field ?? null,
            related_field: c.relatedField ?? null,
          }));
        } catch (e) {
          console.warn('KB tool warning:', e.message);
          return [];
        }
      }

      const typed = {
        table_name: realName,
        reference_count: result.length,
        references: result.map(row => ({
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

      return structuredResult(typed, out);
    }
  );

  // ── 9. d365_get_module_summary ────────────────────────────────────────────
  server.registerTool(
    'd365_get_module_summary',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description: 'Get a summary of a D365FO module/package: object counts and key tables/classes. Returns both a typed JSON payload (structuredContent) and a Markdown rendering.',
      inputSchema: {
      module_name: z.string().min(1).max(500).describe('Module name (e.g. ApplicationSuite, EngineeringChangeManagement)'),
      table_limit: z.number().int().min(1).max(200).default(20).describe('Max Key Tables rows (default 20, max 200)'),
      class_limit: z.number().int().min(1).max(200).default(15).describe('Max Key Classes rows (default 15, max 200)'),
    },
      outputSchema: d365GetModuleSummaryOutput.shape,
    },
    async ({ module_name, table_limit, class_limit }) => {
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

      return structuredResult(typed, out);
    }
  );

  // ── 10. d365_get_entity_sources ───────────────────────────────────────────
  server.registerTool(
    'd365_get_entity_sources',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description: 'Get data source chain and fields for a D365FO data entity. Shows the primary table and OData name. Returns both a typed JSON payload (structuredContent) and a Markdown rendering.',
      inputSchema: { entity_name: z.string().min(1).max(500).describe('Data entity name') },
      outputSchema: d365GetEntitySourcesOutput.shape,
    },
    async ({ entity_name }) => {
      const en = entity_name.trim();
      const result = q(
        `SELECT entity_name, module_id, label, public_name, public_collection, is_public, primary_table, staging_table, config_key
         FROM data_entities WHERE entity_name = ? COLLATE NOCASE`, [en]
      );

      if (!result || result.length === 0) {
        const fuzzy = q(
          `SELECT entity_name FROM data_entities WHERE entity_name LIKE ? COLLATE NOCASE LIMIT 10`, [`%${en}%`]
        );
        return notFoundResult('Entity', en, fuzzy.map(r => r.entity_name));
      }

      const r = result[0];
      let fieldRows = [];
      try {
        fieldRows = q(
          `SELECT field_name, data_field, data_source, is_mandatory
           FROM entity_fields WHERE entity_name = ? COLLATE NOCASE ORDER BY field_name`, [r.entity_name]
        );
      } catch (err) {
        console.error('[kb-tools:d365_get_entity_sources fields]', err);
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
        field_count: fieldRows.length,
        entity_fields: fieldRows.map(f => ({
          field_name: f.field_name,
          data_field: f.data_field ?? null,
          data_source: f.data_source ?? null,
          is_mandatory: toNum(f.is_mandatory),
        })),
      };

      let out = `## ${typed.entity_name}\n`;
      out += `Module: ${typed.module_id ?? '-'} | Public: ${typed.is_public ? 'Yes' : 'No'}\n`;
      if (typed.label) out += `Label: ${typed.label}\n`;
      if (typed.public_name) out += `OData Name: ${typed.public_name}\n`;
      if (typed.public_collection) out += `Collection: ${typed.public_collection}\n`;
      if (typed.primary_table) out += `Primary Table: ${typed.primary_table}\n`;
      if (typed.staging_table) out += `Staging Table: ${typed.staging_table}\n`;
      out += '\n';

      out += '## Entity Fields\n';
      out += formatMarkdownTable(
        typed.entity_fields.map(f => ({
          Field: f.field_name,
          DataField: f.data_field ?? '',
          DataSource: f.data_source ?? '',
          Mand: f.is_mandatory ?? '',
        })),
        ['Field', 'DataField', 'DataSource', 'Mand'],
      );

      return structuredResult(typed, out);
    }
  );

  // ── 11. d365_sql_template ─────────────────────────────────────────────────
  server.registerTool(
    'd365_sql_template',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description: 'Get a pre-validated SQL query template for common D365FO scenarios. Templates have correct join keys and field names. Returns both a typed JSON payload (structuredContent) and a Markdown rendering.',
      inputSchema: {
      scenario: z.string().max(500).optional().describe('Search term for template (e.g. "customer invoice", "vendor", "GL entries"). Leave empty to list all.'),
    },
      outputSchema: d365SqlTemplateOutput.shape,
    },
    async ({ scenario }) => {
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

      return structuredResult(typed, out);
    }
  );

  // ── 12. d365_hallucination_check ──────────────────────────────────────────
  server.registerTool(
    'd365_hallucination_check',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description: 'Check for known D365FO hallucination traps for a table. Returns common LLM mistakes and their corrections. Returns both a typed JSON payload (structuredContent) and a Markdown rendering.',
      inputSchema: { table_name: z.string().min(1).max(500).describe('Table name to check traps for') },
      outputSchema: d365HallucinationCheckOutput.shape,
    },
    async ({ table_name }) => {
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

      return structuredResult(typed, out);
    }
  );

  // ── 13. d365_raw_sql ──────────────────────────────────────────────────────
  server.registerTool(
    'd365_raw_sql',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description: 'Execute a raw SQL query against the D365FO knowledge base. Use for ad-hoc queries not covered by other tools. READ-ONLY, limited to 500 rows. Returns both a typed JSON payload (structuredContent with row_count, columns, and rows) and a text rendering. Schema: kb_tables(table_name, table_group, ...), kb_fields(table_name, field_name, ...), kb_enums(enum_name, ...), kb_classes(class_name, ...), kb_methods(class_name, method_name, source_code, ...), kb_search(object_type, object_name, content), kb_relations(...), kb_entities(...). Text channel defaults to TOON (compact, token-efficient). Pass format="markdown" for human-readable tables.',
      inputSchema: {
        sql: z.string().min(1).max(50000).describe('SQL SELECT query to execute'),
        format: z.enum(['markdown', 'toon']).optional().default('toon').describe('Text-channel rendering. "toon" (default, token-efficient) or "markdown" for human-readable tables.'),
      },
      outputSchema: rawSqlOutput.shape,
    },
    async ({ sql: rawSql, format }) => {
      const SAFETY_CAP = 500;
      const fmt = format === 'markdown' ? 'markdown' : 'toon';
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
        let text = fmt === 'toon'
          ? formatToonBlock('rows', rows, columns)
          : formatMarkdownTable(rows);
        if (truncated) text += truncationNote('hard', SAFETY_CAP);
        return structuredResult(typed, text);
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
      description: 'Traverse the D365FO object dependency graph. Find related tables, class hierarchies, or entity-to-table mappings within N hops. Returns both a typed JSON payload (structuredContent) and a Markdown rendering.',
      inputSchema: {
      start_node: z.string().min(1).max(500).describe('Starting object name'),
      max_depth: z.number().int().min(0).max(10).optional().default(2).describe('Maximum traversal depth (0-10, default 2)'),
      edge_type: z.string().min(1).max(500).optional().describe('Optional edge type filter: FK, extends, datasource'),
    },
      outputSchema: d365GraphTraverseOutput.shape,
    },
    async ({ start_node, max_depth, edge_type }) => {
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

      return structuredResult(typed, out);
    }
  );

  // ── 15. d365_field_renames ────────────────────────────────────────────────
  server.registerTool(
    'd365_field_renames',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description: 'Look up AX2012-to-D365FO field renames for a table. Prevents using obsolete field names. Returns both a typed JSON payload (structuredContent) and a Markdown rendering.',
      inputSchema: { table_name: z.string().min(1).max(500).describe('Table name') },
      outputSchema: d365FieldRenamesOutput.shape,
    },
    async ({ table_name }) => {
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
      return structuredResult(typed, out);
    }
  );

  // ── 16. d365_list_modules ─────────────────────────────────────────────────
  server.registerTool(
    'd365_list_modules',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description: 'List all D365FO modules/packages with object counts. The Level-0 directory of the entire knowledge base. Returns both a typed JSON payload (structuredContent) and a Markdown rendering.',
      inputSchema: {},
      outputSchema: d365ListModulesOutput.shape,
    },
    async () => {
      const result = q(
        `SELECT module_id, table_count, class_count, enum_count, entity_count, form_count
         FROM modules ORDER BY table_count DESC`
      );
      if (!result || result.length === 0) {
        return emptyResult('modules in the knowledge base', {
          module_count: 0,
          modules: [],
        });
      }
      const typed = {
        module_count: result.length,
        modules: result.map(r => ({
          module_id: r.module_id,
          table_count: r.table_count ?? null,
          class_count: r.class_count ?? null,
          enum_count: r.enum_count ?? null,
          entity_count: r.entity_count ?? null,
          form_count: r.form_count ?? null,
        })),
      };
      let out = `## D365FO Modules (${typed.module_count} total)\n\n`;
      out += formatMarkdownTable(
        typed.modules.map(m => ({
          Module: m.module_id,
          Tables: m.table_count ?? '',
          Classes: m.class_count ?? '',
          Enums: m.enum_count ?? '',
          Entities: m.entity_count ?? '',
          Forms: m.form_count ?? '',
        })),
        ['Module', 'Tables', 'Classes', 'Enums', 'Entities', 'Forms'],
      );
      return structuredResult(typed, out);
    }
  );

  // ── 17. d365_resolve_label ──────────────────────────────────────────────────
  server.registerTool(
    'd365_resolve_label',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description: 'Resolve D365FO label IDs (like @SYS12345) to human-readable text. Use when you encounter unresolved label references. Returns both a typed JSON payload (structuredContent) and a Markdown rendering.',
      inputSchema: {
      label_ids: z.array(z.string().regex(/^@[A-Za-z]+\d+$/, 'Label IDs must match the @LangPrefixNNNN pattern, e.g. "@SYS12345"'))
        .min(1, 'Provide at least one label ID.')
        .max(100, 'Max 100 label IDs per call.')
        .describe('Array of label IDs to resolve, e.g. ["@SYS12345"]. Max 100 per call.'),
    },
      outputSchema: d365ResolveLabelOutput.shape,
    },
    async ({ label_ids }) => {
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

      return structuredResult(typed, out);
    }
  );
}
