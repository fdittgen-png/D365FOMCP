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

import { query, formatMarkdownTable, textResult, validateLikePattern, patternErrorResult, runWithBudget, QueryBudgetExceededError, timeoutErrorResult } from './shared.js';
import { z } from 'zod';

// ── Register all 17 KB tools ────────────────────────────────────────────────

export function registerKbTools(server, db) {

  const q = (sql, params = []) => query(db, sql, params);

  /**
   * Issue #17: detect whether the FTS5 virtual table `kb_search_fts` exists
   * in the attached KB database. Computed once per server registration —
   * the schema doesn't change at runtime, so we don't pay the lookup cost
   * on every search call. Existing built KBs (sql.js builds) will not have
   * the table, in which case d365_search falls back to LIKE scanning.
   */
  const ftsAvailable = (() => {
    try {
      const rows = q(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='kb_search_fts'`
      );
      return rows.length > 0;
    } catch {
      return false;
    }
  })();

  function queryFormatted(sql, params = [], columns) {
    try {
      const rows = q(sql, params);
      return formatMarkdownTable(rows, columns);
    } catch (err) {
      return `Error: ${err.message}`;
    }
  }

  // ── 1. d365_lookup_table ──────────────────────────────────────────────────
  server.tool(
    'd365_lookup_table',
    'Get complete metadata for a D365FO table: fields (name, type, EDT), primary key, indexes, and foreign key relations. Returns a compact Markdown summary.',
    { table_name: z.string().max(500).describe('Table name (case-insensitive, e.g. CustInvoiceJour)') },
    async ({ table_name }) => {
      const _v = validateLikePattern(table_name);
      if (_v) return patternErrorResult(_v);
      const tn = table_name.trim();

      // Table header
      const tbl = q(
        `SELECT table_name, module_id, label, table_group, save_per_company, cache_lookup, clustered_index, replacement_key
         FROM tables WHERE table_name = ? COLLATE NOCASE`, [tn]
      );

      if (!tbl || tbl.length === 0) {
        // Try fuzzy match
        const fuzzy = q(
          `SELECT table_name FROM tables WHERE table_name LIKE ? LIMIT 10`, [`%${tn}%`]
        );
        if (fuzzy.length > 0) {
          return textResult(`Table "${tn}" not found. Did you mean:\n${fuzzy.map(r => `- ${r.table_name}`).join('\n')}`);
        }
        return textResult(`Table "${tn}" not found.`);
      }

      const { table_name: name, module_id: mod, label, table_group: grp, save_per_company: perComp, cache_lookup: cache, clustered_index: clustIdx, replacement_key: replKey } = tbl[0];

      let out = `# ${name}\n`;
      out += `Module: ${mod} | Group: ${grp || '-'} | PerCompany: ${perComp} | Cache: ${cache || '-'}\n`;
      if (label) out += `Label: ${label}\n`;
      out += '\n';

      // Fields
      out += '## Fields\n';
      out += queryFormatted(
        `SELECT field_name AS "Field", field_type AS "Type", edt AS "EDT", enum_type AS "Enum", mandatory AS "Mand"
         FROM fields WHERE table_name = ? ORDER BY field_name`, [name]
      );
      out += '\n\n';

      // Indexes
      out += '## Indexes\n';
      const idxResult = q(
        `SELECT index_name, is_unique, is_clustered, fields_json FROM indexes_tbl WHERE table_name = ?`, [name]
      );
      if (idxResult.length > 0) {
        out += '|Index|Unique|Clustered|Fields|\n|---|---|---|---|\n';
        for (const row of idxResult) {
          const fields = JSON.parse(row.fields_json || '[]').join(', ');
          out += `|${row.index_name}|${row.is_unique ? 'Y' : 'N'}|${row.is_clustered ? 'Y' : 'N'}|${fields}|\n`;
        }
      } else {
        out += 'No indexes.\n';
      }
      out += '\n';

      // Relations
      out += '## Relations (Foreign Keys)\n';
      const relResult = q(
        `SELECT relation_name, related_table, constraints_json, relationship_type, on_delete
         FROM relations WHERE source_table = ?`, [name]
      );
      if (relResult.length > 0) {
        out += '|Relation|To Table|Join Fields|Type|OnDelete|\n|---|---|---|---|---|\n';
        for (const row of relResult) {
          let joinFields = '';
          try {
            const constraints = JSON.parse(row.constraints_json || '[]');
            joinFields = constraints
              .filter(c => c.field && c.relatedField)
              .map(c => `${c.field}->${c.relatedField}`)
              .join(', ');
          } catch (e) { console.warn('KB tool warning:', e.message); }
          out += `|${row.relation_name}|${row.related_table}|${joinFields}|${row.relationship_type || '-'}|${row.on_delete || '-'}|\n`;
        }
      } else {
        out += 'No relations defined.\n';
      }

      // Incoming relations
      const inRelResult = q(
        `SELECT source_table, relation_name, constraints_json FROM relations WHERE related_table = ? LIMIT 20`, [name]
      );
      if (inRelResult.length > 0) {
        out += '\n## Incoming Relations (tables referencing this table)\n';
        out += '|From Table|Relation|Join Fields|\n|---|---|---|\n';
        for (const row of inRelResult) {
          let joinFields = '';
          try {
            const constraints = JSON.parse(row.constraints_json || '[]');
            joinFields = constraints.filter(c => c.field).map(c => `${c.field}->${c.relatedField}`).join(', ');
          } catch (e) { console.warn('KB tool warning:', e.message); }
          out += `|${row.source_table}|${row.relation_name}|${joinFields}|\n`;
        }
        if (inRelResult.length >= 20) {
          out += `\n> ⚠️ Showing first 20 results. There may be more — increase limit or refine your query.`;
        }
      }

      return textResult(out);
    }
  );

  // ── 2. d365_get_join_keys ─────────────────────────────────────────────────
  server.tool(
    'd365_get_join_keys',
    'Get the exact join fields between two D365FO tables. Critical for writing correct SQL joins.',
    {
      table1: z.string().max(500).describe('First table name'),
      table2: z.string().max(500).describe('Second table name'),
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

      if (!result || result.length === 0) {
        return textResult(`No direct relationship found between ${t1} and ${t2}.`);
      }

      let out = `## Join Keys: ${t1} <-> ${t2}\n\n`;
      for (const row of result) {
        let constraints = [];
        try { constraints = JSON.parse(row.constraints_json || '[]'); } catch (e) { console.warn('KB tool warning:', e.message); }

        const fieldPairs = constraints
          .filter(c => c.field && c.relatedField)
          .map(c => `${row.source_table}.${c.field} = ${row.related_table}.${c.relatedField}`);

        out += `### ${row.relation_name} (${row.relationship_type || 'Association'})\n`;
        out += `Direction: ${row.source_table} -> ${row.related_table}\n`;
        out += `Join ON:\n`;
        for (const fp of fieldPairs) {
          out += `  ${fp}\n`;
        }
        out += '\n';
      }

      // Also check hallucination traps for these tables
      const traps = q(
        `SELECT wrong_value, correct_value, explanation FROM hallucination_traps
         WHERE (object_name = ? COLLATE NOCASE OR object_name = ? COLLATE NOCASE)
           AND trap_type = 'wrong_join'`,
        [t1, t2]
      );
      if (traps.length > 0) {
        out += '### Known Hallucination Traps\n';
        for (const row of traps) {
          out += `- WRONG: ${row.wrong_value}\n- CORRECT: ${row.correct_value}\n- ${row.explanation}\n\n`;
        }
      }

      return textResult(out);
    }
  );

  // ── 3. d365_search ────────────────────────────────────────────────────────
  server.tool(
    'd365_search',
    'Full-text search across all D365FO objects (tables, classes, enums, entities). Use for discovery queries like "find tables related to inventory" or "classes that handle product release".',
    {
      query: z.string().max(1000).describe('Search query (keywords)'),
      object_type: z.string().max(500).optional().describe('Optional filter: table, class, enum, entity'),
      limit: z.number().optional().default(20).describe('Max results (default 20)'),
    },
    async ({ query: searchQuery, object_type, limit }) => {
      const _v = validateLikePattern(searchQuery);
      if (_v) return patternErrorResult(_v);
      const lim = limit || 20;
      const terms = searchQuery.trim().split(/\s+/).filter(Boolean);
      if (!terms.length) return textResult(`No results for "${searchQuery}".`);

      // Issue #17: try FTS5 MATCH first (10-50x faster than chained LIKEs),
      // fall back to LIKE if the kb_search_fts virtual table is missing
      // (sql.js builds) or if MATCH itself errors. Mirrors the sec_search
      // FTS5+LIKE fallback pattern.
      let rows;
      let usedFts = false;
      if (ftsAvailable) {
        try {
          // Each term becomes a prefix-match token. Quotes escape any FTS5
          // operator characters in the input.
          const ftsExpr = terms.map(t => `"${t.replace(/"/g, '""')}"*`).join(' AND ');
          let ftsSql = `
            SELECT s.object_type, s.object_name, s.module_id,
                   SUBSTR(s.content, 1, 120) AS context
            FROM kb_search_fts f
            JOIN kb_search s ON s.rowid = f.rowid
            WHERE kb_search_fts MATCH ?`;
          const ftsParams = [ftsExpr];
          if (object_type) {
            ftsSql += ` AND s.object_type = ? COLLATE NOCASE`;
            ftsParams.push(object_type);
          }
          ftsSql += ` LIMIT ?`;
          ftsParams.push(lim);
          rows = q(ftsSql, ftsParams);
          usedFts = true;
        } catch {
          // FTS5 MATCH failed (e.g., malformed expression) — fall through
          // to LIKE so the user still gets a result.
          rows = undefined;
        }
      }

      if (!usedFts) {
        // LIKE fallback — preserves the original behaviour for built KBs
        // that don't have the kb_search_fts virtual table.
        const likeParts = [];
        const likeParams = [];

        terms.forEach((term) => {
          likeParts.push(`(object_name LIKE ? OR content LIKE ?)`);
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

        try {
          rows = q(sql, likeParams);
        } catch (err) {
          return textResult(`Search error: ${err.message}`);
        }
      }

      if (!rows || rows.length === 0) {
        return textResult(`No results for "${searchQuery}".`);
      }
      let out = formatMarkdownTable(rows);
      if (rows.length >= lim) {
        out += `\n\n> ⚠️ Showing first ${lim} results. There may be more — increase limit or refine your query.`;
      }
      return textResult(out);
    }
  );

  // ── 4. d365_get_enum ──────────────────────────────────────────────────────
  server.tool(
    'd365_get_enum',
    'Get all values for a D365FO enum with their numeric values. Essential for correct enum usage in SQL and X++.',
    { enum_name: z.string().max(500).describe('Enum name (e.g. StatusIssue, InventTransType)') },
    async ({ enum_name }) => {
      const _v = validateLikePattern(enum_name);
      if (_v) return patternErrorResult(_v);
      const en = enum_name.trim();
      const result = q(
        `SELECT enum_name, module_id, label, values_json FROM enums WHERE enum_name = ? COLLATE NOCASE`, [en]
      );

      if (!result || result.length === 0) {
        const fuzzy = q(
          `SELECT enum_name FROM enums WHERE enum_name LIKE ? LIMIT 10`, [`%${en}%`]
        );
        if (fuzzy.length > 0) {
          return textResult(`Enum "${en}" not found. Did you mean:\n${fuzzy.map(r => `- ${r.enum_name}`).join('\n')}`);
        }
        return textResult(`Enum "${en}" not found.`);
      }

      const { enum_name: name, module_id: mod, label, values_json: vj } = result[0];
      let out = `# ${name}\nModule: ${mod} | Label: ${label || '-'}\n\n`;
      out += '|Name|Value|Label|\n|---|---|---|\n';

      try {
        const values = JSON.parse(vj || '[]');
        for (const v of values) {
          out += `|${v.name}|${v.value ?? ''}|${v.label || ''}|\n`;
        }
      } catch (e) { console.warn('KB tool warning:', e.message); }

      return textResult(out);
    }
  );

  // ── 5. d365_check_field_exists ────────────────────────────────────────────
  server.tool(
    'd365_check_field_exists',
    'Verify if fields exist on a D365FO table. Returns existence status and suggests corrections for non-existent fields. Use BEFORE generating SQL to prevent hallucinated column names.',
    {
      table_name: z.string().max(500).describe('Table name'),
      field_names: z.array(z.string().max(500)).describe('Array of field names to check'),
    },
    async ({ table_name, field_names }) => {
      const tn = table_name.trim();

      // Verify table exists
      const tblCheck = q(
        `SELECT table_name FROM tables WHERE table_name = ? COLLATE NOCASE`, [tn]
      );
      if (!tblCheck || tblCheck.length === 0) {
        return textResult(`Table "${tn}" not found in knowledge base.`);
      }
      const realTableName = tblCheck[0].table_name;

      // Get all actual fields
      const allFields = q(
        `SELECT field_name FROM fields WHERE table_name = ?`, [realTableName]
      );
      const actualFields = new Set((allFields || []).map(r => r.field_name.toUpperCase()));

      let out = `## Field Check: ${realTableName}\n\n`;
      out += '|Field|Exists|Note|\n|---|---|---|\n';

      for (const fn of field_names) {
        const fnUpper = fn.trim().toUpperCase();
        if (actualFields.has(fnUpper)) {
          // Find the correctly-cased name
          const correctName = allFields.find(r => r.field_name.toUpperCase() === fnUpper).field_name;
          out += `|${fn}|YES|${correctName}|\n`;
        } else {
          // Check hallucination traps
          const trap = q(
            `SELECT explanation FROM hallucination_traps
             WHERE object_name = ? AND wrong_value = ?`,
            [realTableName, fn]
          );

          // Try fuzzy match on actual fields
          const similar = allFields
            .filter(r => r.field_name.toUpperCase().includes(fnUpper) || fnUpper.includes(r.field_name.toUpperCase()))
            .map(r => r.field_name)
            .slice(0, 3);

          let note = 'DOES NOT EXIST';
          if (trap.length > 0) {
            note += ` -- ${trap[0].explanation}`;
          } else if (similar.length > 0) {
            note += ` -- similar: ${similar.join(', ')}`;
          }
          out += `|${fn}|**NO**|${note}|\n`;
        }
      }

      return textResult(out);
    }
  );

  // ── 6. d365_get_class_methods ─────────────────────────────────────────────
  server.tool(
    'd365_get_class_methods',
    'Get method signatures (and optionally full X++ source code) for a D365FO class or table. Use include_source=true to get the complete method bodies.',
    {
      name: z.string().max(500).describe('Class or table name'),
      filter: z.string().max(500).optional().describe('Optional filter on method name (LIKE pattern)'),
      include_source: z.boolean().optional().default(false).describe('If true, include full X++ source code for each method'),
      limit: z.number().optional().default(100).describe('Max results (default 100)'),
    },
    async ({ name, filter, include_source, limit }) => {
      const _vn = validateLikePattern(name);
      if (_vn) return patternErrorResult(_vn);
      const _vf = validateLikePattern(filter);
      if (_vf) return patternErrorResult(_vf);
      const n = name.trim();

      let sql = `SELECT owner_type, method_name, signature, is_static${include_source ? ', source_code' : ''}
                 FROM methods WHERE owner_name = ? COLLATE NOCASE`;
      const params = [n];

      if (filter) {
        sql += ` AND method_name LIKE ?`;
        params.push(`%${filter}%`);
      }
      sql += ` ORDER BY is_static DESC, method_name LIMIT ?`;
      params.push(limit);

      const result = q(sql, params);
      if (!result || result.length === 0) {
        return textResult(`No methods found for "${n}".`);
      }

      const ownerType = result[0].owner_type;
      let out = `## Methods: ${n} (${ownerType})\n\n`;

      // Also show class hierarchy info
      if (ownerType === 'class') {
        const cls = q(
          `SELECT extends_class, implements_list, is_abstract FROM classes WHERE class_name = ? COLLATE NOCASE`, [n]
        );
        if (cls.length > 0) {
          const { extends_class: ext, implements_list: impl, is_abstract: abs } = cls[0];
          if (abs) out += `Abstract class\n`;
          if (ext) out += `Extends: ${ext}\n`;
          if (impl) out += `Implements: ${impl}\n`;
          out += '\n';
        }
      }

      if (include_source) {
        // Full source code output — one code block per method
        for (const row of result) {
          out += `### ${row.method_name}${row.is_static ? ' (static)' : ''}\n`;
          out += `Signature: \`${row.signature || '-'}\`\n`;
          if (row.source_code) {
            out += '```x++\n' + row.source_code + '\n```\n\n';
          } else {
            out += '_No source code available._\n\n';
          }
        }
      } else {
        // Compact table output (signatures only)
        out += '|Method|Static|Signature|\n|---|---|---|\n';
        for (const row of result) {
          const shortSig = row.signature ? row.signature.substring(0, 200) : '';
          out += `|${row.method_name}|${row.is_static ? 'Y' : 'N'}|${shortSig}|\n`;
        }
      }

      if (result.length >= limit) {
        out += `\n\n> ⚠️ Showing first ${limit} results. There may be more — increase limit or refine your query.`;
      }

      return textResult(out);
    }
  );

  // ── 7. d365_get_method_source ─────────────────────────────────────────────
  server.tool(
    'd365_get_method_source',
    'Get the full X++ source code for a specific method on a class or table. Use this for targeted code analysis when you know the exact method name.',
    {
      owner_name: z.string().max(500).describe('Class or table name'),
      method_name: z.string().max(500).describe('Method name'),
    },
    async ({ owner_name, method_name }) => {
      const _vo = validateLikePattern(owner_name);
      if (_vo) return patternErrorResult(_vo);
      const _vm = validateLikePattern(method_name);
      if (_vm) return patternErrorResult(_vm);
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
          `SELECT method_name FROM methods WHERE owner_name = ? AND method_name LIKE ? LIMIT 10`,
          [on, `%${mn}%`]
        );
        if (fuzzy.length > 0) {
          return textResult(`Method "${mn}" not found on "${on}". Did you mean:\n${fuzzy.map(r => `- ${r.method_name}`).join('\n')}`);
        }
        return textResult(`Method "${mn}" not found on "${on}".`);
      }

      const { owner_type: ownerType, owner_name: realOwner, method_name: realMethod, signature: sig, is_static: isStatic, source_code: sourceCode } = result[0];
      let out = `## ${realOwner}.${realMethod}\n`;
      out += `Type: ${ownerType} | Static: ${isStatic ? 'Yes' : 'No'}\n`;
      out += `Signature: \`${sig || '-'}\`\n\n`;

      if (sourceCode) {
        out += '```x++\n' + sourceCode + '\n```';
      } else {
        out += '_No source code available for this method._';
      }

      return textResult(out);
    }
  );

  // ── 8. d365_find_referencing_tables ────────────────────────────────────────
  server.tool(
    'd365_find_referencing_tables',
    'Find all tables that have foreign key relationships TO a given table. Useful for impact analysis.',
    { table_name: z.string().max(500).describe('Target table name') },
    async ({ table_name }) => {
      const tn = table_name.trim();

      const result = q(
        `SELECT source_table, relation_name, constraints_json, relationship_type
         FROM relations WHERE related_table = ? COLLATE NOCASE
         ORDER BY source_table`, [tn]
      );

      if (!result || result.length === 0) {
        return textResult(`No tables reference "${tn}".`);
      }

      let out = `## Tables referencing: ${tn}\n\n`;
      out += '|Table|Relation|Join Fields|Type|\n|---|---|---|---|\n';

      for (const row of result) {
        let joinFields = '';
        try {
          const constraints = JSON.parse(row.constraints_json || '[]');
          joinFields = constraints.filter(c => c.field).map(c => `${c.field}->${c.relatedField}`).join(', ');
        } catch (e) { console.warn('KB tool warning:', e.message); }
        out += `|${row.source_table}|${row.relation_name}|${joinFields}|${row.relationship_type || '-'}|\n`;
      }

      out += `\nTotal: ${result.length} referencing tables`;
      return textResult(out);
    }
  );

  // ── 9. d365_get_module_summary ────────────────────────────────────────────
  server.tool(
    'd365_get_module_summary',
    'Get a summary of a D365FO module/package: object counts and key tables/classes.',
    { module_name: z.string().max(500).describe('Module name (e.g. ApplicationSuite, EngineeringChangeManagement)') },
    async ({ module_name }) => {
      const _v = validateLikePattern(module_name);
      if (_v) return patternErrorResult(_v);
      const mn = module_name.trim();

      const mod = q(
        `SELECT * FROM modules WHERE module_id = ? COLLATE NOCASE`, [mn]
      );

      if (!mod || mod.length === 0) {
        const fuzzy = q(
          `SELECT module_id FROM modules WHERE module_id LIKE ? LIMIT 10`, [`%${mn}%`]
        );
        if (fuzzy.length > 0) {
          return textResult(`Module "${mn}" not found. Did you mean:\n${fuzzy.map(r => `- ${r.module_id}`).join('\n')}`);
        }
        return textResult(`Module "${mn}" not found.`);
      }

      const { module_id: mid, table_count: tc, class_count: cc, enum_count: ec, entity_count: dc, form_count: fc } = mod[0];
      let out = `# Module: ${mid}\n\n`;
      out += `|Type|Count|\n|---|---|\n`;
      out += `|Tables|${tc}|\n|Classes|${cc}|\n|Enums|${ec}|\n|Entities|${dc}|\n|Forms|${fc}|\n\n`;

      // Key tables (top 20 by field count)
      out += '## Key Tables\n';
      out += queryFormatted(
        `SELECT table_name AS "Table", label AS "Label", field_count AS "Fields", save_per_company AS "PerCo", table_group AS "Group"
         FROM tables WHERE module_id = ? ORDER BY field_count DESC LIMIT 20`, [mid]
      );
      out += '\n\n';

      // Key classes (with most methods)
      out += '## Key Classes (by method count)\n';
      out += queryFormatted(
        `SELECT class_name AS "Class", extends_class AS "Extends", method_count AS "Methods"
         FROM classes WHERE module_id = ? ORDER BY method_count DESC LIMIT 15`, [mid]
      );

      return textResult(out);
    }
  );

  // ── 10. d365_get_entity_sources ───────────────────────────────────────────
  server.tool(
    'd365_get_entity_sources',
    'Get data source chain and fields for a D365FO data entity. Shows the primary table and OData name.',
    { entity_name: z.string().max(500).describe('Data entity name') },
    async ({ entity_name }) => {
      const _v = validateLikePattern(entity_name);
      if (_v) return patternErrorResult(_v);
      const en = entity_name.trim();
      const result = q(
        `SELECT entity_name, module_id, label, public_name, public_collection, is_public, primary_table, staging_table, config_key
         FROM data_entities WHERE entity_name = ? COLLATE NOCASE`, [en]
      );

      if (!result || result.length === 0) {
        const fuzzy = q(
          `SELECT entity_name FROM data_entities WHERE entity_name LIKE ? LIMIT 10`, [`%${en}%`]
        );
        if (fuzzy.length > 0) {
          return textResult(`Entity "${en}" not found. Did you mean:\n${fuzzy.map(r => `- ${r.entity_name}`).join('\n')}`);
        }
        return textResult(`Entity "${en}" not found.`);
      }

      const { entity_name: name, module_id: mod, label, public_name: pubName, public_collection: pubColl, is_public: isPub, primary_table: primTbl, staging_table: staging, config_key: cfgKey } = result[0];
      let out = `# ${name}\n`;
      out += `Module: ${mod} | Public: ${isPub ? 'Yes' : 'No'}\n`;
      if (label) out += `Label: ${label}\n`;
      if (pubName) out += `OData Name: ${pubName}\n`;
      if (pubColl) out += `Collection: ${pubColl}\n`;
      if (primTbl) out += `Primary Table: ${primTbl}\n`;
      if (staging) out += `Staging Table: ${staging}\n`;
      out += '\n';

      // Entity fields
      out += '## Entity Fields\n';
      out += queryFormatted(
        `SELECT field_name AS "Field", data_field AS "DataField", data_source AS "DataSource", is_mandatory AS "Mand"
         FROM entity_fields WHERE entity_name = ? ORDER BY field_name`, [name]
      );

      return textResult(out);
    }
  );

  // ── 11. d365_sql_template ─────────────────────────────────────────────────
  server.tool(
    'd365_sql_template',
    'Get a pre-validated SQL query template for common D365FO scenarios. Templates have correct join keys and field names.',
    {
      scenario: z.string().max(500).optional().describe('Search term for template (e.g. "customer invoice", "vendor", "GL entries"). Leave empty to list all.'),
    },
    async ({ scenario }) => {
      const _v = validateLikePattern(scenario);
      if (_v) return patternErrorResult(_v);
      let sql, params;
      if (scenario) {
        sql = `SELECT template_id, title, description, sql_template, tables_used
               FROM query_templates WHERE title LIKE ? OR description LIKE ? OR tables_used LIKE ?`;
        params = [`%${scenario}%`, `%${scenario}%`, `%${scenario}%`];
      } else {
        sql = `SELECT template_id, title, description, sql_template, tables_used FROM query_templates`;
        params = [];
      }

      const result = q(sql, params);
      if (!result || result.length === 0) {
        return textResult(scenario ? `No templates matching "${scenario}".` : 'No templates available.');
      }

      let out = '## SQL Query Templates\n\n';
      for (const row of result) {
        out += `### ${row.title}\n`;
        out += `${row.description}\n`;
        out += `Tables: ${row.tables_used}\n\n`;
        out += '```sql\n' + row.sql_template + '\n```\n\n';
      }

      return textResult(out);
    }
  );

  // ── 12. d365_hallucination_check ──────────────────────────────────────────
  server.tool(
    'd365_hallucination_check',
    'Check for known D365FO hallucination traps for a table. Returns common LLM mistakes and their corrections.',
    { table_name: z.string().max(500).describe('Table name to check traps for') },
    async ({ table_name }) => {
      const tn = table_name.trim();

      const result = q(
        `SELECT trap_type, wrong_value, correct_value, explanation
         FROM hallucination_traps WHERE object_name = ? COLLATE NOCASE`, [tn]
      );

      if (!result || result.length === 0) {
        return textResult(`No known hallucination traps for "${tn}".`);
      }

      let out = `## Hallucination Traps: ${tn}\n\n`;
      for (const row of result) {
        out += `- **${row.trap_type}**: \`${row.wrong_value}\`\n`;
        if (row.correct_value) out += `  Correct: \`${row.correct_value}\`\n`;
        out += `  ${row.explanation}\n\n`;
      }

      return textResult(out);
    }
  );

  // ── 13. d365_raw_sql ──────────────────────────────────────────────────────
  server.tool(
    'd365_raw_sql',
    'Execute a raw SQL query against the D365FO knowledge base. Use for ad-hoc queries not covered by other tools. READ-ONLY, limited to 500 rows. Schema: kb_tables(table_name, table_group, ...), kb_fields(table_name, field_name, ...), kb_enums(enum_name, ...), kb_classes(class_name, ...), kb_methods(class_name, method_name, source_code, ...), kb_search(object_type, object_name, content), kb_relations(...), kb_entities(...)',
    { sql: z.string().max(50000).describe('SQL SELECT query to execute') },
    async ({ sql: rawSql }) => {
      const trimmed = rawSql.trim();
      const upper = trimmed.toUpperCase();

      // Only allow SELECT / WITH / PRAGMA statements
      if (!upper.startsWith('SELECT') && !upper.startsWith('WITH') && !upper.startsWith('PRAGMA')) {
        return textResult('Only SELECT/WITH/PRAGMA queries are allowed.');
      }

      // Block data-modifying keywords anywhere in the query
      const forbidden = ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'CREATE', 'TRUNCATE', 'ATTACH', 'DETACH'];
      for (const kw of forbidden) {
        const regex = new RegExp(`\\b${kw}\\b`, 'i');
        if (regex.test(trimmed)) {
          return textResult(`Forbidden keyword "${kw}" detected. Only read-only queries are allowed.`);
        }
      }

      try {
        // Append LIMIT if not already present
        let safeSql = trimmed.replace(/;+$/, '');
        if (!/\bLIMIT\b/i.test(safeSql)) {
          safeSql += ' LIMIT 500';
        }
        const rows = runWithBudget('d365_raw_sql', () => q(safeSql));
        let out = formatMarkdownTable(rows);
        if (rows.length >= 500) {
          out += `\n\n> ⚠️ Showing first 500 results. There may be more — increase limit or refine your query.`;
        }
        return textResult(out);
      } catch (err) {
        if (err instanceof QueryBudgetExceededError) return timeoutErrorResult(err);
        return textResult(`Error: ${err.message}`);
      }
    }
  );

  // ── 14. d365_graph_traverse ───────────────────────────────────────────────
  server.tool(
    'd365_graph_traverse',
    'Traverse the D365FO object dependency graph. Find related tables, class hierarchies, or entity-to-table mappings within N hops.',
    {
      start_node: z.string().max(500).describe('Starting object name'),
      max_depth: z.number().optional().default(2).describe('Maximum traversal depth (default 2)'),
      edge_type: z.string().max(500).optional().describe('Optional edge type filter: FK, extends, datasource'),
    },
    async ({ start_node, max_depth, edge_type }) => {
      const sn = start_node.trim();
      const depth = Math.min(max_depth || 2, 4);

      const params = [sn];

      // Build edge filter
      let edgeFilter = '';
      if (edge_type) {
        edgeFilter = 'AND edge_type = ?';
        params.push(edge_type);
      }

      // SQLite recursive CTE (RECURSIVE keyword required)
      // Depth and edge_type params need to be repeated for base + recursive parts
      const depthParams = [depth];
      if (edge_type) {
        // params: sn, edge_type, depth, edge_type
        params.push(...depthParams, edge_type);
      } else {
        // params: sn, depth
        params.push(...depthParams);
      }

      const sql = `
        WITH RECURSIVE connected(node, node_type, edge, detail, depth) AS (
          SELECT target_node, target_type, edge_type, edge_detail, 1
          FROM graph_edges
          WHERE source_node = ? COLLATE NOCASE ${edgeFilter}
          UNION ALL
          SELECT g.target_node, g.target_type, g.edge_type, g.edge_detail, c.depth + 1
          FROM graph_edges g
          JOIN connected c ON g.source_node = c.node
          WHERE c.depth < ? ${edgeFilter}
        )
        SELECT DISTINCT node, node_type, edge, depth
        FROM connected
        ORDER BY depth, node
        LIMIT 100
      `;

      const result = q(sql, params);
      if (!result || result.length === 0) {
        return textResult(`No connections found from "${sn}".`);
      }

      let out = `## Graph: ${sn} (${depth} hops${edge_type ? `, ${edge_type} only` : ''})\n\n`;
      out += '|Node|Type|Edge|Depth|\n|---|---|---|---|\n';
      for (const row of result) {
        out += `|${row.node}|${row.node_type}|${row.edge}|${row.depth}|\n`;
      }

      if (result.length >= 100) {
        out += `\n\n> ⚠️ Showing first 100 results. There may be more — increase limit or refine your query.`;
      }

      return textResult(out);
    }
  );

  // ── 15. d365_field_renames ────────────────────────────────────────────────
  server.tool(
    'd365_field_renames',
    'Look up AX2012-to-D365FO field renames for a table. Prevents using obsolete field names.',
    { table_name: z.string().max(500).describe('Table name') },
    async ({ table_name }) => {
      const tn = table_name.trim();
      const result = q(
        `SELECT ax2012_name AS "AX2012", d365fo_name AS "D365FO"
         FROM field_renames WHERE table_name = ? COLLATE NOCASE`, [tn]
      );
      if (!result || result.length === 0) {
        return textResult(`No known field renames for "${tn}".`);
      }
      let out = `## Field Renames: ${tn} (AX2012 -> D365FO)\n\n`;
      out += formatMarkdownTable(result);
      return textResult(out);
    }
  );

  // ── 16. d365_list_modules ─────────────────────────────────────────────────
  server.tool(
    'd365_list_modules',
    'List all D365FO modules/packages with object counts. The Level-0 directory of the entire knowledge base.',
    {},
    async () => {
      const result = q(
        `SELECT module_id AS "Module", table_count AS "Tables", class_count AS "Classes",
                enum_count AS "Enums", entity_count AS "Entities", form_count AS "Forms"
         FROM modules ORDER BY table_count DESC`
      );
      if (!result || result.length === 0) {
        return textResult('No modules found in KB.');
      }
      let out = `## D365FO Modules (${result.length} total)\n\n`;
      out += formatMarkdownTable(result);
      return textResult(out);
    }
  );

  // ── 17. d365_resolve_label ──────────────────────────────────────────────────
  server.tool(
    'd365_resolve_label',
    'Resolve D365FO label IDs (like @SYS12345) to human-readable text. Use when you encounter unresolved label references.',
    {
      label_ids: z.array(z.string().max(500)).describe('Array of label IDs to resolve (e.g. ["@SYS12345", "@SYS67890"])'),
    },
    async ({ label_ids }) => {
      if (!label_ids || label_ids.length === 0) {
        return textResult('No label IDs provided.');
      }

      const placeholders = label_ids.map(() => '?').join(', ');
      const result = q(
        `SELECT label_id, text FROM labels WHERE label_id IN (${placeholders})`,
        label_ids
      );

      if (!result || result.length === 0) {
        return textResult(`No labels found for: ${label_ids.join(', ')}`);
      }

      let out = '## Label Resolution\n\n|Label ID|Text|\n|---|---|\n';
      const found = new Set();
      for (const row of result) {
        out += `|${row.label_id}|${row.text}|\n`;
        found.add(row.label_id);
      }

      const missing = label_ids.filter(id => !found.has(id));
      if (missing.length > 0) {
        out += `\n**Not found:** ${missing.join(', ')}`;
      }

      return textResult(out);
    }
  );
}
