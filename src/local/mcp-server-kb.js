/**
 * D365FO Knowledge Base MCP Server
 *
 * Exposes the D365FO knowledge base SQLite database as MCP tools
 * for Claude Code consumption. Optimized for minimal token usage.
 *
 * Usage: node mcp-server.js [dbPath]
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import initSqlJs from 'sql.js';

// ─── Configuration ───────────────────────────────────────────────────────────

const DEFAULT_DB_PATH = join(
  process.env.USERPROFILE || 'C:\\Users\\florian.dittgen',
  '.claude', 'd365fo_kb.sqlite'
);

const dbPath = process.argv[2] || DEFAULT_DB_PATH;

// ─── Initialize ──────────────────────────────────────────────────────────────

let db;

async function initDb() {
  const SQL = await initSqlJs();
  const buffer = readFileSync(dbPath);
  db = new SQL.Database(buffer);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function query(sql, params = []) {
  try {
    const result = db.exec(sql, params);
    if (result.length === 0) return { columns: [], rows: [] };
    return { columns: result[0].columns, rows: result[0].values };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * Format query results as a Markdown table (token-efficient).
 */
function formatMarkdownTable(columns, rows) {
  if (rows.length === 0) return 'No results found.';

  const header = '|' + columns.join('|') + '|';
  const sep = '|' + columns.map(() => '---').join('|') + '|';
  const body = rows.map(row =>
    '|' + row.map(v => v === null ? '' : String(v)).join('|') + '|'
  ).join('\n');

  return `${header}\n${sep}\n${body}`;
}

/**
 * Run a query and return formatted markdown.
 */
function queryFormatted(sql, params = []) {
  const result = query(sql, params);
  if (result.error) return `Error: ${result.error}`;
  return formatMarkdownTable(result.columns, result.rows);
}

// ─── MCP Server ──────────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'd365fo-kb',
  version: '1.0.0',
  description: 'D365FO Knowledge Base - AI-optimized metadata lookup for tables, fields, joins, enums, classes, and more.',
});

// ── Tool: d365_lookup_table ──
server.tool(
  'd365_lookup_table',
  'Get complete metadata for a D365FO table: fields (name, type, EDT), primary key, indexes, and foreign key relations. Returns a compact Markdown summary.',
  { table_name: z.string().describe('Table name (case-insensitive, e.g. CustInvoiceJour)') },
  async ({ table_name }) => {
    const tn = table_name.trim();

    // Table header
    const tbl = query(
      `SELECT table_name, module_id, label, table_group, save_per_company, cache_lookup, clustered_index, replacement_key
       FROM tables WHERE table_name COLLATE NOCASE = ?`, [tn]
    );

    if (!tbl.rows || tbl.rows.length === 0) {
      // Try fuzzy match
      const fuzzy = query(
        `SELECT table_name FROM tables WHERE table_name LIKE ? LIMIT 10`, [`%${tn}%`]
      );
      if (fuzzy.rows?.length > 0) {
        return { content: [{ type: 'text', text: `Table "${tn}" not found. Did you mean:\n${fuzzy.rows.map(r => `- ${r[0]}`).join('\n')}` }] };
      }
      return { content: [{ type: 'text', text: `Table "${tn}" not found.` }] };
    }

    const [name, mod, label, grp, perComp, cache, clustIdx, replKey] = tbl.rows[0];

    let out = `# ${name}\n`;
    out += `Module: ${mod} | Group: ${grp || '-'} | PerCompany: ${perComp} | Cache: ${cache || '-'}\n`;
    if (label) out += `Label: ${label}\n`;
    out += '\n';

    // Fields
    out += '## Fields\n';
    out += queryFormatted(
      `SELECT field_name AS "Field", field_type AS "Type", edt AS "EDT", enum_type AS "Enum", mandatory AS "Mand"
       FROM fields WHERE table_name = ? ORDER BY rowid`, [name]
    );
    out += '\n\n';

    // Indexes
    out += '## Indexes\n';
    const idxResult = query(
      `SELECT index_name, is_unique, is_clustered, fields_json FROM indexes_tbl WHERE table_name = ?`, [name]
    );
    if (idxResult.rows?.length > 0) {
      out += '|Index|Unique|Clustered|Fields|\n|---|---|---|---|\n';
      for (const [iname, uniq, clust, fj] of idxResult.rows) {
        const fields = JSON.parse(fj || '[]').join(', ');
        out += `|${iname}|${uniq ? 'Y' : 'N'}|${clust ? 'Y' : 'N'}|${fields}|\n`;
      }
    } else {
      out += 'No indexes.\n';
    }
    out += '\n';

    // Relations
    out += '## Relations (Foreign Keys)\n';
    const relResult = query(
      `SELECT relation_name, related_table, constraints_json, relationship_type, on_delete
       FROM relations WHERE source_table = ?`, [name]
    );
    if (relResult.rows?.length > 0) {
      out += '|Relation|To Table|Join Fields|Type|OnDelete|\n|---|---|---|---|---|\n';
      for (const [rname, rtable, cj, rtype, ondel] of relResult.rows) {
        let joinFields = '';
        try {
          const constraints = JSON.parse(cj || '[]');
          joinFields = constraints
            .filter(c => c.field && c.relatedField)
            .map(c => `${c.field}->${c.relatedField}`)
            .join(', ');
        } catch {}
        out += `|${rname}|${rtable}|${joinFields}|${rtype || '-'}|${ondel || '-'}|\n`;
      }
    } else {
      out += 'No relations defined.\n';
    }

    // Incoming relations
    const inRelResult = query(
      `SELECT source_table, relation_name, constraints_json FROM relations WHERE related_table = ? LIMIT 20`, [name]
    );
    if (inRelResult.rows?.length > 0) {
      out += '\n## Incoming Relations (tables referencing this table)\n';
      out += '|From Table|Relation|Join Fields|\n|---|---|---|\n';
      for (const [src, rname, cj] of inRelResult.rows) {
        let joinFields = '';
        try {
          const constraints = JSON.parse(cj || '[]');
          joinFields = constraints.filter(c => c.field).map(c => `${c.field}->${c.relatedField}`).join(', ');
        } catch {}
        out += `|${src}|${rname}|${joinFields}|\n`;
      }
    }

    return { content: [{ type: 'text', text: out }] };
  }
);

// ── Tool: d365_get_join_keys ──
server.tool(
  'd365_get_join_keys',
  'Get the exact join fields between two D365FO tables. Critical for writing correct SQL joins.',
  {
    table1: z.string().describe('First table name'),
    table2: z.string().describe('Second table name'),
  },
  async ({ table1, table2 }) => {
    const t1 = table1.trim();
    const t2 = table2.trim();

    // Check both directions
    const result = query(
      `SELECT source_table, related_table, relation_name, constraints_json, relationship_type
       FROM relations
       WHERE (source_table COLLATE NOCASE = ? AND related_table COLLATE NOCASE = ?)
          OR (source_table COLLATE NOCASE = ? AND related_table COLLATE NOCASE = ?)`,
      [t1, t2, t2, t1]
    );

    if (!result.rows || result.rows.length === 0) {
      return { content: [{ type: 'text', text: `No direct relationship found between ${t1} and ${t2}.` }] };
    }

    let out = `## Join Keys: ${t1} <-> ${t2}\n\n`;
    for (const [src, tgt, rname, cj, rtype] of result.rows) {
      let constraints = [];
      try { constraints = JSON.parse(cj || '[]'); } catch {}

      const fieldPairs = constraints
        .filter(c => c.field && c.relatedField)
        .map(c => `${src}.${c.field} = ${tgt}.${c.relatedField}`);

      out += `### ${rname} (${rtype || 'Association'})\n`;
      out += `Direction: ${src} -> ${tgt}\n`;
      out += `Join ON:\n`;
      for (const fp of fieldPairs) {
        out += `  ${fp}\n`;
      }
      out += '\n';
    }

    // Also check hallucination traps for these tables
    const traps = query(
      `SELECT wrong_value, correct_value, explanation FROM hallucination_traps
       WHERE (object_name COLLATE NOCASE = ? OR object_name COLLATE NOCASE = ?)
         AND trap_type = 'wrong_join'`,
      [t1, t2]
    );
    if (traps.rows?.length > 0) {
      out += '### ⚠ Known Hallucination Traps\n';
      for (const [wrong, correct, expl] of traps.rows) {
        out += `- WRONG: ${wrong}\n- CORRECT: ${correct}\n- ${expl}\n\n`;
      }
    }

    return { content: [{ type: 'text', text: out }] };
  }
);

// ── Tool: d365_search ──
server.tool(
  'd365_search',
  'Full-text search across all D365FO objects (tables, classes, enums, entities). Use for discovery queries like "find tables related to inventory" or "classes that handle product release".',
  {
    query: z.string().describe('Search query (keywords)'),
    object_type: z.string().optional().describe('Optional filter: table, class, enum, entity'),
    limit: z.number().optional().default(20).describe('Max results (default 20)'),
  },
  async ({ query: searchQuery, object_type, limit }) => {
    // Build LIKE-based search (sql.js doesn't include FTS5)
    const terms = searchQuery.trim().split(/\s+/).filter(Boolean);
    const likeConditions = terms.map(() => `(object_name LIKE ? OR content LIKE ?)`).join(' AND ');
    const params = [];
    for (const term of terms) {
      params.push(`%${term}%`, `%${term}%`);
    }

    let sql = `SELECT object_type, object_name, module_id, SUBSTR(content, 1, 120) as context
               FROM kb_search WHERE ${likeConditions}`;

    if (object_type) {
      sql += ` AND object_type = ?`;
      params.push(object_type);
    }
    sql += ` LIMIT ?`;
    params.push(limit || 20);

    const result = query(sql, params);
    if (result.error) return { content: [{ type: 'text', text: `Search error: ${result.error}` }] };
    if (!result.rows?.length) return { content: [{ type: 'text', text: `No results for "${searchQuery}".` }] };
    return { content: [{ type: 'text', text: formatMarkdownTable(result.columns, result.rows) }] };
  }
);

// ── Tool: d365_get_enum ──
server.tool(
  'd365_get_enum',
  'Get all values for a D365FO enum with their numeric values. Essential for correct enum usage in SQL and X++.',
  { enum_name: z.string().describe('Enum name (e.g. StatusIssue, InventTransType)') },
  async ({ enum_name }) => {
    const en = enum_name.trim();
    const result = query(
      `SELECT enum_name, module_id, label, values_json FROM enums WHERE enum_name COLLATE NOCASE = ?`, [en]
    );

    if (!result.rows?.length) {
      const fuzzy = query(`SELECT enum_name FROM enums WHERE enum_name LIKE ? LIMIT 10`, [`%${en}%`]);
      if (fuzzy.rows?.length > 0) {
        return { content: [{ type: 'text', text: `Enum "${en}" not found. Did you mean:\n${fuzzy.rows.map(r => `- ${r[0]}`).join('\n')}` }] };
      }
      return { content: [{ type: 'text', text: `Enum "${en}" not found.` }] };
    }

    const [name, mod, label, vj] = result.rows[0];
    let out = `# ${name}\nModule: ${mod} | Label: ${label || '-'}\n\n`;
    out += '|Name|Value|Label|\n|---|---|---|\n';

    try {
      const values = JSON.parse(vj || '[]');
      for (const v of values) {
        out += `|${v.name}|${v.value ?? ''}|${v.label || ''}|\n`;
      }
    } catch {}

    return { content: [{ type: 'text', text: out }] };
  }
);

// ── Tool: d365_check_field_exists ──
server.tool(
  'd365_check_field_exists',
  'Verify if fields exist on a D365FO table. Returns existence status and suggests corrections for non-existent fields. Use BEFORE generating SQL to prevent hallucinated column names.',
  {
    table_name: z.string().describe('Table name'),
    field_names: z.array(z.string()).describe('Array of field names to check'),
  },
  async ({ table_name, field_names }) => {
    const tn = table_name.trim();

    // Verify table exists
    const tblCheck = query(`SELECT table_name FROM tables WHERE table_name COLLATE NOCASE = ?`, [tn]);
    if (!tblCheck.rows?.length) {
      return { content: [{ type: 'text', text: `Table "${tn}" not found in knowledge base.` }] };
    }
    const realTableName = tblCheck.rows[0][0];

    // Get all actual fields
    const allFields = query(`SELECT field_name FROM fields WHERE table_name = ?`, [realTableName]);
    const actualFields = new Set((allFields.rows || []).map(r => r[0].toUpperCase()));

    let out = `## Field Check: ${realTableName}\n\n`;
    out += '|Field|Exists|Note|\n|---|---|---|\n';

    for (const fn of field_names) {
      const fnUpper = fn.trim().toUpperCase();
      if (actualFields.has(fnUpper)) {
        // Find the correctly-cased name
        const correctName = allFields.rows.find(r => r[0].toUpperCase() === fnUpper)[0];
        out += `|${fn}|YES|${correctName}|\n`;
      } else {
        // Check hallucination traps
        const trap = query(
          `SELECT explanation FROM hallucination_traps
           WHERE object_name COLLATE NOCASE = ? AND wrong_value COLLATE NOCASE = ?`,
          [realTableName, fn]
        );

        // Try fuzzy match on actual fields
        const similar = allFields.rows
          .filter(r => r[0].toUpperCase().includes(fnUpper) || fnUpper.includes(r[0].toUpperCase()))
          .map(r => r[0])
          .slice(0, 3);

        let note = 'DOES NOT EXIST';
        if (trap.rows?.length > 0) {
          note += ` -- ${trap.rows[0][0]}`;
        } else if (similar.length > 0) {
          note += ` -- similar: ${similar.join(', ')}`;
        }
        out += `|${fn}|**NO**|${note}|\n`;
      }
    }

    return { content: [{ type: 'text', text: out }] };
  }
);

// ── Tool: d365_get_class_methods ──
server.tool(
  'd365_get_class_methods',
  'Get method signatures (and optionally full X++ source code) for a D365FO class or table. Use include_source=true to get the complete method bodies.',
  {
    name: z.string().describe('Class or table name'),
    filter: z.string().optional().describe('Optional filter on method name (LIKE pattern)'),
    include_source: z.boolean().optional().default(false).describe('If true, include full X++ source code for each method'),
  },
  async ({ name, filter, include_source }) => {
    const n = name.trim();

    let sql = `SELECT owner_type, method_name, signature, is_static${include_source ? ', source_code' : ''}
               FROM methods WHERE owner_name COLLATE NOCASE = ?`;
    const params = [n];

    if (filter) {
      sql += ` AND method_name LIKE ?`;
      params.push(`%${filter}%`);
    }
    sql += ` ORDER BY is_static DESC, method_name`;

    const result = query(sql, params);
    if (!result.rows?.length) {
      return { content: [{ type: 'text', text: `No methods found for "${n}".` }] };
    }

    const ownerType = result.rows[0][0];
    let out = `## Methods: ${n} (${ownerType})\n\n`;

    // Also show class hierarchy info
    if (ownerType === 'class') {
      const cls = query(`SELECT extends_class, implements_list, is_abstract FROM classes WHERE class_name COLLATE NOCASE = ?`, [n]);
      if (cls.rows?.length > 0) {
        const [ext, impl, abs] = cls.rows[0];
        if (abs) out += `Abstract class\n`;
        if (ext) out += `Extends: ${ext}\n`;
        if (impl) out += `Implements: ${impl}\n`;
        out += '\n';
      }
    }

    if (include_source) {
      // Full source code output — one code block per method
      for (const row of result.rows) {
        const mname = row[1];
        const sig = row[2];
        const isStatic = row[3];
        const sourceCode = row[4];
        out += `### ${mname}${isStatic ? ' (static)' : ''}\n`;
        out += `Signature: \`${sig || '-'}\`\n`;
        if (sourceCode) {
          out += '```x++\n' + sourceCode + '\n```\n\n';
        } else {
          out += '_No source code available._\n\n';
        }
      }
    } else {
      // Compact table output (signatures only)
      out += '|Method|Static|Signature|\n|---|---|---|\n';
      for (const [, mname, sig, isStatic] of result.rows) {
        const shortSig = sig ? sig.substring(0, 200) : '';
        out += `|${mname}|${isStatic ? 'Y' : 'N'}|${shortSig}|\n`;
      }
    }

    return { content: [{ type: 'text', text: out }] };
  }
);

// ── Tool: d365_get_method_source ──
server.tool(
  'd365_get_method_source',
  'Get the full X++ source code for a specific method on a class or table. Use this for targeted code analysis when you know the exact method name.',
  {
    owner_name: z.string().describe('Class or table name'),
    method_name: z.string().describe('Method name'),
  },
  async ({ owner_name, method_name }) => {
    const on = owner_name.trim();
    const mn = method_name.trim();

    const result = query(
      `SELECT owner_type, owner_name, method_name, signature, is_static, source_code
       FROM methods
       WHERE owner_name COLLATE NOCASE = ? AND method_name COLLATE NOCASE = ?`,
      [on, mn]
    );

    if (!result.rows?.length) {
      // Try fuzzy match on method name
      const fuzzy = query(
        `SELECT method_name FROM methods WHERE owner_name COLLATE NOCASE = ? AND method_name LIKE ? LIMIT 10`,
        [on, `%${mn}%`]
      );
      if (fuzzy.rows?.length > 0) {
        return { content: [{ type: 'text', text: `Method "${mn}" not found on "${on}". Did you mean:\n${fuzzy.rows.map(r => `- ${r[0]}`).join('\n')}` }] };
      }
      return { content: [{ type: 'text', text: `Method "${mn}" not found on "${on}".` }] };
    }

    const [ownerType, realOwner, realMethod, sig, isStatic, sourceCode] = result.rows[0];
    let out = `## ${realOwner}.${realMethod}\n`;
    out += `Type: ${ownerType} | Static: ${isStatic ? 'Yes' : 'No'}\n`;
    out += `Signature: \`${sig || '-'}\`\n\n`;

    if (sourceCode) {
      out += '```x++\n' + sourceCode + '\n```';
    } else {
      out += '_No source code available for this method._';
    }

    return { content: [{ type: 'text', text: out }] };
  }
);

// ── Tool: d365_find_referencing_tables ──
server.tool(
  'd365_find_referencing_tables',
  'Find all tables that have foreign key relationships TO a given table. Useful for impact analysis.',
  { table_name: z.string().describe('Target table name') },
  async ({ table_name }) => {
    const tn = table_name.trim();

    const result = query(
      `SELECT source_table, relation_name, constraints_json, relationship_type
       FROM relations WHERE related_table COLLATE NOCASE = ?
       ORDER BY source_table`, [tn]
    );

    if (!result.rows?.length) {
      return { content: [{ type: 'text', text: `No tables reference "${tn}".` }] };
    }

    let out = `## Tables referencing: ${tn}\n\n`;
    out += '|Table|Relation|Join Fields|Type|\n|---|---|---|---|\n';

    for (const [src, rname, cj, rtype] of result.rows) {
      let joinFields = '';
      try {
        const constraints = JSON.parse(cj || '[]');
        joinFields = constraints.filter(c => c.field).map(c => `${c.field}->${c.relatedField}`).join(', ');
      } catch {}
      out += `|${src}|${rname}|${joinFields}|${rtype || '-'}|\n`;
    }

    out += `\nTotal: ${result.rows.length} referencing tables`;
    return { content: [{ type: 'text', text: out }] };
  }
);

// ── Tool: d365_get_module_summary ──
server.tool(
  'd365_get_module_summary',
  'Get a summary of a D365FO module/package: object counts and key tables/classes.',
  { module_name: z.string().describe('Module name (e.g. ApplicationSuite, EngineeringChangeManagement)') },
  async ({ module_name }) => {
    const mn = module_name.trim();

    const mod = query(
      `SELECT * FROM modules WHERE module_id COLLATE NOCASE = ?`, [mn]
    );

    if (!mod.rows?.length) {
      const fuzzy = query(`SELECT module_id FROM modules WHERE module_id LIKE ? LIMIT 10`, [`%${mn}%`]);
      if (fuzzy.rows?.length > 0) {
        return { content: [{ type: 'text', text: `Module "${mn}" not found. Did you mean:\n${fuzzy.rows.map(r => `- ${r[0]}`).join('\n')}` }] };
      }
      return { content: [{ type: 'text', text: `Module "${mn}" not found.` }] };
    }

    const [mid, tc, cc, ec, dc, fc] = mod.rows[0];
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

    return { content: [{ type: 'text', text: out }] };
  }
);

// ── Tool: d365_get_entity_sources ──
server.tool(
  'd365_get_entity_sources',
  'Get data source chain and fields for a D365FO data entity. Shows the primary table and OData name.',
  { entity_name: z.string().describe('Data entity name') },
  async ({ entity_name }) => {
    const en = entity_name.trim();
    const result = query(
      `SELECT entity_name, module_id, label, public_name, public_collection, is_public, primary_table, staging_table, config_key
       FROM data_entities WHERE entity_name COLLATE NOCASE = ?`, [en]
    );

    if (!result.rows?.length) {
      const fuzzy = query(`SELECT entity_name FROM data_entities WHERE entity_name LIKE ? LIMIT 10`, [`%${en}%`]);
      if (fuzzy.rows?.length > 0) {
        return { content: [{ type: 'text', text: `Entity "${en}" not found. Did you mean:\n${fuzzy.rows.map(r => `- ${r[0]}`).join('\n')}` }] };
      }
      return { content: [{ type: 'text', text: `Entity "${en}" not found.` }] };
    }

    const [name, mod, label, pubName, pubColl, isPub, primTbl, staging, cfgKey] = result.rows[0];
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
       FROM entity_fields WHERE entity_name = ? ORDER BY rowid`, [name]
    );

    return { content: [{ type: 'text', text: out }] };
  }
);

// ── Tool: d365_sql_template ──
server.tool(
  'd365_sql_template',
  'Get a pre-validated SQL query template for common D365FO scenarios. Templates have correct join keys and field names.',
  {
    scenario: z.string().optional().describe('Search term for template (e.g. "customer invoice", "vendor", "GL entries"). Leave empty to list all.'),
  },
  async ({ scenario }) => {
    let sql, params;
    if (scenario) {
      sql = `SELECT template_id, title, description, sql_template, tables_used
             FROM query_templates WHERE title LIKE ? OR description LIKE ? OR tables_used LIKE ?`;
      params = [`%${scenario}%`, `%${scenario}%`, `%${scenario}%`];
    } else {
      sql = `SELECT template_id, title, description, sql_template, tables_used FROM query_templates`;
      params = [];
    }

    const result = query(sql, params);
    if (!result.rows?.length) {
      return { content: [{ type: 'text', text: scenario ? `No templates matching "${scenario}".` : 'No templates available.' }] };
    }

    let out = '## SQL Query Templates\n\n';
    for (const [id, title, desc, sqlTmpl, tables] of result.rows) {
      out += `### ${title}\n`;
      out += `${desc}\n`;
      out += `Tables: ${tables}\n\n`;
      out += '```sql\n' + sqlTmpl + '\n```\n\n';
    }

    return { content: [{ type: 'text', text: out }] };
  }
);

// ── Tool: d365_hallucination_check ──
server.tool(
  'd365_hallucination_check',
  'Check for known D365FO hallucination traps for a table. Returns common LLM mistakes and their corrections.',
  { table_name: z.string().describe('Table name to check traps for') },
  async ({ table_name }) => {
    const tn = table_name.trim();

    const result = query(
      `SELECT trap_type, wrong_value, correct_value, explanation
       FROM hallucination_traps WHERE object_name COLLATE NOCASE = ?`, [tn]
    );

    if (!result.rows?.length) {
      return { content: [{ type: 'text', text: `No known hallucination traps for "${tn}".` }] };
    }

    let out = `## Hallucination Traps: ${tn}\n\n`;
    for (const [type, wrong, correct, expl] of result.rows) {
      out += `- **${type}**: \`${wrong}\`\n`;
      if (correct) out += `  Correct: \`${correct}\`\n`;
      out += `  ${expl}\n\n`;
    }

    return { content: [{ type: 'text', text: out }] };
  }
);

// ── Tool: d365_raw_sql ──
server.tool(
  'd365_raw_sql',
  'Execute a raw SQL query against the D365FO knowledge base SQLite database. Use for ad-hoc queries not covered by other tools. READ-ONLY.',
  { sql: z.string().describe('SQL SELECT query to execute') },
  async ({ sql: rawSql }) => {
    const trimmed = rawSql.trim().toUpperCase();
    if (!trimmed.startsWith('SELECT') && !trimmed.startsWith('WITH') && !trimmed.startsWith('PRAGMA')) {
      return { content: [{ type: 'text', text: 'Only SELECT/WITH/PRAGMA queries are allowed.' }] };
    }
    const result = query(rawSql);
    if (result.error) return { content: [{ type: 'text', text: `Error: ${result.error}` }] };
    return { content: [{ type: 'text', text: formatMarkdownTable(result.columns, result.rows) }] };
  }
);

// ── Tool: d365_graph_traverse ──
server.tool(
  'd365_graph_traverse',
  'Traverse the D365FO object dependency graph. Find related tables, class hierarchies, or entity-to-table mappings within N hops.',
  {
    start_node: z.string().describe('Starting object name'),
    max_depth: z.number().optional().default(2).describe('Maximum traversal depth (default 2)'),
    edge_type: z.string().optional().describe('Optional edge type filter: FK, extends, datasource'),
  },
  async ({ start_node, max_depth, edge_type }) => {
    const sn = start_node.trim();
    const depth = Math.min(max_depth || 2, 4);

    // SQLite recursive CTE
    let edgeFilter = '';
    if (edge_type) edgeFilter = `AND edge_type = '${edge_type}'`;

    const sql = `
      WITH RECURSIVE connected(node, node_type, edge, detail, depth) AS (
        SELECT target_node, target_type, edge_type, edge_detail, 1
        FROM graph_edges
        WHERE source_node COLLATE NOCASE = ? ${edgeFilter}
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

    const result = query(sql, [sn, depth]);
    if (!result.rows?.length) {
      return { content: [{ type: 'text', text: `No connections found from "${sn}".` }] };
    }

    let out = `## Graph: ${sn} (${depth} hops${edge_type ? `, ${edge_type} only` : ''})\n\n`;
    out += '|Node|Type|Edge|Depth|\n|---|---|---|---|\n';
    for (const [node, ntype, edge, d] of result.rows) {
      out += `|${node}|${ntype}|${edge}|${d}|\n`;
    }

    return { content: [{ type: 'text', text: out }] };
  }
);

// ── Tool: d365_field_renames ──
server.tool(
  'd365_field_renames',
  'Look up AX2012-to-D365FO field renames for a table. Prevents using obsolete field names.',
  { table_name: z.string().describe('Table name') },
  async ({ table_name }) => {
    const tn = table_name.trim();
    const result = query(
      `SELECT ax2012_name AS "AX2012", d365fo_name AS "D365FO"
       FROM field_renames WHERE table_name COLLATE NOCASE = ?`, [tn]
    );
    if (!result.rows?.length) {
      return { content: [{ type: 'text', text: `No known field renames for "${tn}".` }] };
    }
    let out = `## Field Renames: ${tn} (AX2012 -> D365FO)\n\n`;
    out += formatMarkdownTable(result.columns, result.rows);
    return { content: [{ type: 'text', text: out }] };
  }
);

// ── Tool: d365_list_modules ──
server.tool(
  'd365_list_modules',
  'List all D365FO modules/packages with object counts. The Level-0 directory of the entire knowledge base.',
  {},
  async () => {
    const result = query(
      `SELECT module_id AS "Module", table_count AS "Tables", class_count AS "Classes",
              enum_count AS "Enums", entity_count AS "Entities", form_count AS "Forms"
       FROM modules ORDER BY table_count DESC`
    );
    if (!result.rows?.length) {
      return { content: [{ type: 'text', text: 'No modules found in KB.' }] };
    }
    let out = `## D365FO Modules (${result.rows.length} total)\n\n`;
    out += formatMarkdownTable(result.columns, result.rows);
    return { content: [{ type: 'text', text: out }] };
  }
);

// ── Start Server ──
async function main() {
  await initDb();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(err => {
  console.error('Failed to start MCP server:', err);
  process.exit(1);
});
