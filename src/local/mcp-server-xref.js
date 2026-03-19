/**
 * xref-mcp-server.js
 * MCP server for D365FO cross-reference queries.
 * Uses better-sqlite3 for direct file access (no memory size limit).
 *
 * Usage:
 *   node xref-mcp-server.js [databasePath]
 *
 * Default databasePath: %USERPROFILE%\.claude\d365fo_xref.sqlite
 */

import { createRequire } from 'module';
import { join } from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

// ── Configuration ──────────────────────────────────────────────────────────────

const DB_PATH = process.argv[2] || join(process.env.USERPROFILE, '.claude', 'd365fo_xref.sqlite');

// Kind lookup
const KIND_NAMES = {
  1: 'Call', 2: 'Read', 3: 'Implements', 4: 'Extends',
  6: 'Delegate', 7: 'Attribute', 9: 'Tag', 10: 'Override'
};

// ── Database Setup ─────────────────────────────────────────────────────────────

const db = new Database(DB_PATH, { readonly: true });

// Performance tuning for read-only workloads
db.pragma('journal_mode = OFF');
db.pragma('cache_size = -200000');  // 200 MB cache
db.pragma('mmap_size = 3221225472');  // 3 GB mmap for fast reads

// ── Helpers ────────────────────────────────────────────────────────────────────

// Statement cache for frequently-used queries
const stmtCache = new Map();

function query(sql, params = []) {
  let stmt = stmtCache.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql).raw();
    stmtCache.set(sql, stmt);
  }
  const rows = params.length ? stmt.all(...params) : stmt.all();
  const columns = stmt.columns().map(c => c.name);
  return { columns, rows };
}

function formatMarkdownTable(columns, rows) {
  if (rows.length === 0) return '_No results_';
  const header = '| ' + columns.join(' | ') + ' |';
  const sep = '| ' + columns.map(() => '---').join(' | ') + ' |';
  const body = rows.map(r => '| ' + r.map(c => c === null ? '' : String(c)).join(' | ') + ' |').join('\n');
  return `${header}\n${sep}\n${body}`;
}

function textResult(text) {
  return { content: [{ type: 'text', text }] };
}

function kindName(k) {
  return KIND_NAMES[k] || `Kind${k}`;
}

/**
 * Resolve a name path by object name. Handles common patterns:
 *   "SalesTable" → looks for /Tables/SalesTable, /Classes/SalesTable, etc.
 *   "/Classes/SalesFormLetter" → exact match
 */
function resolveNameId(objectName) {
  // If already a path (starts with / or contains /)
  if (objectName.startsWith('/') || objectName.includes('/')) {
    const result = query('SELECT id, path FROM names WHERE path = ? LIMIT 1', [objectName]);
    if (result.rows.length > 0) return result.rows[0];
    // Try LIKE match
    const likeResult = query('SELECT id, path FROM names WHERE path LIKE ? LIMIT 10', [`%${objectName}%`]);
    return likeResult.rows.length > 0 ? likeResult.rows[0] : null;
  }

  // Try common prefixes in priority order
  const prefixes = [
    `/Classes/${objectName}`,
    `/Tables/${objectName}`,
    `/Forms/${objectName}`,
    `/Enums/${objectName}`,
    `/DataEntityViews/${objectName}`,
    `/Edts/${objectName}`,
    `/Views/${objectName}`,
    `/Maps/${objectName}`,
    `/Queries/${objectName}`,
  ];

  for (const path of prefixes) {
    const result = query('SELECT id, path FROM names WHERE path = ? LIMIT 1', [path]);
    if (result.rows.length > 0) return result.rows[0];
  }

  // Fallback: try metadata provider paths (no leading /)
  const metaPrefixes = [
    `Table/${objectName}`,
    `Class/${objectName}`,
    `Form/${objectName}`,
    `Enum/${objectName}`,
    `DataEntityView/${objectName}`,
    `View/${objectName}`,
  ];

  for (const path of metaPrefixes) {
    const result = query('SELECT id, path FROM names WHERE path = ? LIMIT 1', [path]);
    if (result.rows.length > 0) return result.rows[0];
  }

  return null;
}

// ── MCP Server ─────────────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'd365fo-xref',
  version: '1.0.0',
  description: 'D365FO Cross-Reference database — find who calls, extends, implements, or references any AOT object.'
});

// ─────────────────────────────────────────────────────────────────────────────
// Tool 1: xref_find_references — "Who uses this object?"
// ─────────────────────────────────────────────────────────────────────────────
server.tool(
  'xref_find_references',
  'Find all objects that reference a given D365FO object (who calls/reads/extends it). This is the "Used By" / "Find All References" query.',
  {
    object_name: z.string().describe('Object name (e.g. "SalesTable", "CustInvoiceJour") or full path (e.g. "/Classes/SalesFormLetter")'),
    kind: z.enum(['All', 'Call', 'Read', 'Implements', 'Extends', 'Delegate', 'Attribute', 'Override']).default('All')
      .describe('Filter by reference kind. Default: All'),
    limit: z.number().default(100).describe('Max results (default 100)')
  },
  async ({ object_name, kind, limit }) => {
    const resolved = resolveNameId(object_name);
    if (!resolved) return textResult(`Object "${object_name}" not found in XRef database.`);

    const [targetId, targetPath] = resolved;
    let kindFilter = '';
    const params = [targetId];

    if (kind !== 'All') {
      const kindId = Object.entries(KIND_NAMES).find(([, v]) => v === kind)?.[0];
      if (kindId) {
        kindFilter = ' AND r.kind = ?';
        params.push(Number(kindId));
      }
    }

    params.push(limit);

    const result = query(`
      SELECT n.path AS source, r.kind, r.line, r.col, m.module
      FROM refs r
      JOIN names n ON r.source_id = n.id
      JOIN modules m ON n.module_id = m.id
      WHERE r.target_id = ? ${kindFilter}
      ORDER BY m.module, n.path
      LIMIT ?
    `, params);

    const rows = result.rows.map(([src, k, line, col, mod]) => [
      src, kindName(k), line ?? '', col ?? '', mod
    ]);

    const header = `**References TO** \`${targetPath}\` (${rows.length} results):\n\n`;
    return textResult(header + formatMarkdownTable(['Source', 'Kind', 'Line', 'Col', 'Module'], rows));
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Tool 2: xref_find_usages — "What does this object use?"
// ─────────────────────────────────────────────────────────────────────────────
server.tool(
  'xref_find_usages',
  'Find all objects that a given D365FO object references (what it calls/reads/extends). This is the "Uses" / outgoing references query.',
  {
    object_name: z.string().describe('Object name or full path'),
    kind: z.enum(['All', 'Call', 'Read', 'Implements', 'Extends', 'Delegate', 'Attribute', 'Override']).default('All')
      .describe('Filter by reference kind'),
    limit: z.number().default(100).describe('Max results (default 100)')
  },
  async ({ object_name, kind, limit }) => {
    const resolved = resolveNameId(object_name);
    if (!resolved) return textResult(`Object "${object_name}" not found in XRef database.`);

    const [sourceId, sourcePath] = resolved;
    let kindFilter = '';
    const params = [sourceId];

    if (kind !== 'All') {
      const kindId = Object.entries(KIND_NAMES).find(([, v]) => v === kind)?.[0];
      if (kindId) {
        kindFilter = ' AND r.kind = ?';
        params.push(Number(kindId));
      }
    }
    params.push(limit);

    const result = query(`
      SELECT n.path AS target, r.kind, r.line, r.col, m.module
      FROM refs r
      JOIN names n ON r.target_id = n.id
      JOIN modules m ON n.module_id = m.id
      WHERE r.source_id = ? ${kindFilter}
      ORDER BY r.kind, n.path
      LIMIT ?
    `, params);

    const rows = result.rows.map(([tgt, k, line, col, mod]) => [
      tgt, kindName(k), line ?? '', col ?? '', mod
    ]);

    const header = `**References FROM** \`${sourcePath}\` (${rows.length} results):\n\n`;
    return textResult(header + formatMarkdownTable(['Target', 'Kind', 'Line', 'Col', 'Module'], rows));
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Tool 3: xref_find_method_callers — "Who calls this method?"
// ─────────────────────────────────────────────────────────────────────────────
server.tool(
  'xref_find_method_callers',
  'Find all callers of a specific method on a class or table. Returns source locations with line numbers.',
  {
    object_name: z.string().describe('Class or table name (e.g. "SalesFormLetter")'),
    method_name: z.string().describe('Method name (e.g. "construct", "run")'),
    limit: z.number().default(100).describe('Max results')
  },
  async ({ object_name, method_name, limit }) => {
    // Try /Classes/X/Methods/Y and /Tables/X/Methods/Y
    const methodPaths = [
      `/Classes/${object_name}/Methods/${method_name}`,
      `/Tables/${object_name}/Methods/${method_name}`,
      `/Forms/${object_name}/Methods/${method_name}`,
    ];

    let targetId = null;
    let targetPath = null;

    for (const path of methodPaths) {
      const r = query('SELECT id, path FROM names WHERE path = ? LIMIT 1', [path]);
      if (r.rows.length > 0) {
        [targetId, targetPath] = r.rows[0];
        break;
      }
    }

    if (!targetId) return textResult(`Method "${object_name}.${method_name}" not found in XRef database.`);

    const result = query(`
      SELECT n.path, r.kind, r.line, r.col, m.module
      FROM refs r
      JOIN names n ON r.source_id = n.id
      JOIN modules m ON n.module_id = m.id
      WHERE r.target_id = ? AND r.kind = 1
      ORDER BY m.module, n.path, r.line
      LIMIT ?
    `, [targetId, limit]);

    const rows = result.rows.map(([src, k, line, col, mod]) => [
      src, line ?? '', col ?? '', mod
    ]);

    const header = `**Callers of** \`${targetPath}\` (${rows.length} results):\n\n`;
    return textResult(header + formatMarkdownTable(['Caller', 'Line', 'Col', 'Module'], rows));
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Tool 4: xref_class_hierarchy — "What extends this class?"
// ─────────────────────────────────────────────────────────────────────────────
server.tool(
  'xref_class_hierarchy',
  'Find the full class inheritance hierarchy — all subclasses (recursive) or the parent chain of a given class.',
  {
    class_name: z.string().describe('Class name (e.g. "SalesFormLetter", "FormLetterServiceController")'),
    direction: z.enum(['subclasses', 'parents']).default('subclasses')
      .describe('"subclasses" = who extends this (default), "parents" = what does this extend')
  },
  async ({ class_name, direction }) => {
    const classPath = `/Classes/${class_name}`;
    const classResult = query('SELECT id FROM names WHERE path = ? LIMIT 1', [classPath]);
    if (classResult.rows.length === 0) return textResult(`Class "${class_name}" not found.`);
    const classId = classResult.rows[0][0];

    if (direction === 'subclasses') {
      // Recursive CTE: find all classes that extend this (kind=4)
      const result = query(`
        WITH RECURSIVE hierarchy(id, path, depth) AS (
          SELECT n.id, n.path, 0
          FROM names n WHERE n.id = ?
          UNION ALL
          SELECT child.id, child.path, h.depth + 1
          FROM hierarchy h
          JOIN refs r ON r.target_id = h.id AND r.kind = 4
          JOIN names child ON child.id = r.source_id
          WHERE h.depth < 10
        )
        SELECT path, depth FROM hierarchy WHERE depth > 0 ORDER BY depth, path
      `, [classId]);

      const rows = result.rows.map(([path, depth]) => [
        '  '.repeat(depth - 1) + path.replace('/Classes/', ''),
        depth
      ]);

      const header = `**Subclasses of** \`${class_name}\` (${rows.length} classes):\n\n`;
      return textResult(header + formatMarkdownTable(['Class', 'Depth'], rows));
    } else {
      // Walk up the extends chain
      const result = query(`
        WITH RECURSIVE chain(id, path, depth) AS (
          SELECT n.id, n.path, 0
          FROM names n WHERE n.id = ?
          UNION ALL
          SELECT parent.id, parent.path, c.depth + 1
          FROM chain c
          JOIN refs r ON r.source_id = c.id AND r.kind = 4
          JOIN names parent ON parent.id = r.target_id
          WHERE c.depth < 20
        )
        SELECT path, depth FROM chain ORDER BY depth
      `, [classId]);

      const rows = result.rows.map(([path, depth]) => [
        path.replace('/Classes/', ''),
        depth
      ]);

      const header = `**Inheritance chain for** \`${class_name}\`:\n\n`;
      return textResult(header + formatMarkdownTable(['Class', 'Level'], rows));
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Tool 5: xref_interface_implementors — "Who implements this interface?"
// ─────────────────────────────────────────────────────────────────────────────
server.tool(
  'xref_interface_implementors',
  'Find all classes that implement a given interface, including indirect implementors through inheritance.',
  {
    interface_name: z.string().describe('Interface name (e.g. "SysRunnable", "SysPackable")')
  },
  async ({ interface_name }) => {
    // Interface can be in /Classes/ or /ClrType/
    let targetId = null;
    let targetPath = null;
    for (const prefix of ['/Classes/', '/ClrType/']) {
      const r = query('SELECT id, path FROM names WHERE path = ? LIMIT 1', [prefix + interface_name]);
      if (r.rows.length > 0) {
        [targetId, targetPath] = r.rows[0];
        break;
      }
    }
    if (!targetId) return textResult(`Interface "${interface_name}" not found.`);

    // Find direct implementors (kind=3), then their subclasses (kind=4) recursively
    const result = query(`
      WITH RECURSIVE impl(id, path, depth) AS (
        SELECT n.id, n.path, 1
        FROM refs r
        JOIN names n ON r.source_id = n.id
        WHERE r.target_id = ? AND r.kind = 3
        UNION ALL
        SELECT child.id, child.path, i.depth + 1
        FROM impl i
        JOIN refs r ON r.target_id = i.id AND r.kind = 4
        JOIN names child ON child.id = r.source_id
        WHERE i.depth < 10
      )
      SELECT DISTINCT path, MIN(depth) as depth FROM impl
      GROUP BY path ORDER BY depth, path
    `, [targetId]);

    const rows = result.rows.map(([path, depth]) => [
      path.replace('/Classes/', ''),
      depth === 1 ? 'Direct' : `Inherited (depth ${depth})`
    ]);

    const header = `**Implementors of** \`${interface_name}\` (${rows.length} classes):\n\n`;
    return textResult(header + formatMarkdownTable(['Class', 'Type'], rows));
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Tool 6: xref_search_names — Search for objects by name pattern
// ─────────────────────────────────────────────────────────────────────────────
server.tool(
  'xref_search_names',
  'Search for D365FO objects by name pattern in the cross-reference database. Use to discover objects when you only know part of the name.',
  {
    pattern: z.string().describe('Search pattern (e.g. "SalesInvoice", "CustTrans"). Supports SQL LIKE wildcards (%).'),
    object_type: z.enum(['All', 'Classes', 'Tables', 'Forms', 'Enums', 'DataEntityViews', 'Edts', 'Views', 'Maps', 'Labels'])
      .default('All').describe('Filter by object type'),
    limit: z.number().default(50).describe('Max results')
  },
  async ({ pattern, object_type, limit }) => {
    const likePattern = pattern.includes('%') ? pattern : `%${pattern}%`;
    let typeFilter = '';

    if (object_type !== 'All') {
      typeFilter = ` AND path LIKE '/${object_type}/%'`;
    }

    // Only return top-level objects (no /Methods/ or /Fields/ subpaths)
    // by requiring exactly 2 slashes for the /Type/Name pattern
    const result = query(`
      SELECT n.path, m.module
      FROM names n
      JOIN modules m ON n.module_id = m.id
      WHERE n.path LIKE ? ${typeFilter}
        AND n.path NOT LIKE '%/Methods/%'
        AND n.path NOT LIKE '%/Fields/%'
        AND n.path NOT LIKE '%/Controls/%'
        AND LENGTH(n.path) - LENGTH(REPLACE(n.path, '/', '')) <= 3
      ORDER BY n.path
      LIMIT ?
    `, [likePattern, limit]);

    const rows = result.rows.map(([path, mod]) => [path, mod]);
    return textResult(formatMarkdownTable(['Path', 'Module'], rows));
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Tool 7: xref_method_references — "What does this method call/use?"
// ─────────────────────────────────────────────────────────────────────────────
server.tool(
  'xref_method_references',
  'Find all outgoing references from a specific method — what objects/methods/types does it call or use.',
  {
    object_name: z.string().describe('Class or table name'),
    method_name: z.string().describe('Method name'),
    kind: z.enum(['All', 'Call', 'Read']).default('All').describe('Filter: All, Call (method invocations only), Read (type/field reads only)'),
    limit: z.number().default(100).describe('Max results')
  },
  async ({ object_name, method_name, kind, limit }) => {
    const methodPaths = [
      `/Classes/${object_name}/Methods/${method_name}`,
      `/Tables/${object_name}/Methods/${method_name}`,
      `/Forms/${object_name}/Methods/${method_name}`,
    ];

    let sourceId = null;
    let sourcePath = null;
    for (const path of methodPaths) {
      const r = query('SELECT id, path FROM names WHERE path = ? LIMIT 1', [path]);
      if (r.rows.length > 0) {
        [sourceId, sourcePath] = r.rows[0];
        break;
      }
    }
    if (!sourceId) return textResult(`Method "${object_name}.${method_name}" not found.`);

    let kindFilter = '';
    const params = [sourceId];
    if (kind === 'Call') { kindFilter = ' AND r.kind = 1'; }
    else if (kind === 'Read') { kindFilter = ' AND r.kind = 2'; }
    params.push(limit);

    const result = query(`
      SELECT n.path, r.kind, r.line, r.col
      FROM refs r
      JOIN names n ON r.target_id = n.id
      WHERE r.source_id = ? ${kindFilter}
      ORDER BY r.line, r.col
      LIMIT ?
    `, params);

    const rows = result.rows.map(([tgt, k, line, col]) => [
      tgt, kindName(k), line ?? '', col ?? ''
    ]);

    const header = `**Outgoing references from** \`${sourcePath}\` (${rows.length}):\n\n`;
    return textResult(header + formatMarkdownTable(['Target', 'Kind', 'Line', 'Col'], rows));
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Tool 8: xref_module_objects — Objects in a module
// ─────────────────────────────────────────────────────────────────────────────
server.tool(
  'xref_module_objects',
  'List all top-level objects (classes, tables, forms, etc.) in a given D365FO module from the cross-reference database.',
  {
    module_name: z.string().describe('Module name (e.g. "ApplicationSuite", "EngineeringChangeManagement")'),
    object_type: z.enum(['All', 'Classes', 'Tables', 'Forms', 'Enums', 'DataEntityViews', 'Edts', 'Views'])
      .default('All').describe('Filter by object type'),
    limit: z.number().default(200).describe('Max results')
  },
  async ({ module_name, object_type, limit }) => {
    let typeFilter = '';
    if (object_type !== 'All') {
      typeFilter = ` AND n.path LIKE '/${object_type}/%'`;
    }

    const result = query(`
      SELECT n.path, p.provider
      FROM names n
      JOIN modules m ON n.module_id = m.id
      JOIN providers p ON n.provider_id = p.id
      WHERE m.module = ? ${typeFilter}
        AND n.path NOT LIKE '%/Methods/%'
        AND n.path NOT LIKE '%/Fields/%'
        AND n.path NOT LIKE '%/Controls/%'
        AND LENGTH(n.path) - LENGTH(REPLACE(n.path, '/', '')) <= 3
      ORDER BY n.path
      LIMIT ?
    `, [module_name, limit]);

    const rows = result.rows.map(([path, prov]) => [path, prov]);
    const header = `**Objects in** \`${module_name}\` (${rows.length}):\n\n`;
    return textResult(header + formatMarkdownTable(['Path', 'Provider'], rows));
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Tool 9: xref_cross_module_deps — Cross-module dependency analysis
// ─────────────────────────────────────────────────────────────────────────────
server.tool(
  'xref_cross_module_deps',
  'Analyze cross-module dependencies: which modules does a given module depend on (or which modules depend on it).',
  {
    module_name: z.string().describe('Module name'),
    direction: z.enum(['depends_on', 'depended_by']).default('depends_on')
      .describe('"depends_on" = modules this module references, "depended_by" = modules that reference this one'),
    limit: z.number().default(50).describe('Max results')
  },
  async ({ module_name, direction, limit }) => {
    let sql;
    if (direction === 'depends_on') {
      sql = `
        SELECT tm.module, COUNT(*) as ref_count
        FROM refs r
        JOIN names sn ON r.source_id = sn.id
        JOIN names tn ON r.target_id = tn.id
        JOIN modules sm ON sn.module_id = sm.id
        JOIN modules tm ON tn.module_id = tm.id
        WHERE sm.module = ? AND tm.module != ?
        GROUP BY tm.module
        ORDER BY ref_count DESC
        LIMIT ?
      `;
    } else {
      sql = `
        SELECT sm.module, COUNT(*) as ref_count
        FROM refs r
        JOIN names sn ON r.source_id = sn.id
        JOIN names tn ON r.target_id = tn.id
        JOIN modules sm ON sn.module_id = sm.id
        JOIN modules tm ON tn.module_id = tm.id
        WHERE tm.module = ? AND sm.module != ?
        GROUP BY sm.module
        ORDER BY ref_count DESC
        LIMIT ?
      `;
    }

    const result = query(sql, [module_name, module_name, limit]);
    const rows = result.rows.map(([mod, cnt]) => [mod, cnt]);

    const dirLabel = direction === 'depends_on' ? 'depends on' : 'is depended on by';
    const header = `**\`${module_name}\`** ${dirLabel} (${rows.length} modules):\n\n`;
    return textResult(header + formatMarkdownTable(['Module', 'Reference Count'], rows));
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Tool 10: xref_raw_sql — Ad-hoc read-only SQL
// ─────────────────────────────────────────────────────────────────────────────
server.tool(
  'xref_raw_sql',
  'Execute a read-only SQL query against the XRef SQLite database. Tables: names(id,path,provider_id,module_id), refs(source_id,target_id,kind,line,col), modules(id,module), providers(id,provider), kind_map(id,name), xref_metadata(key,value).',
  {
    sql: z.string().describe('SQL SELECT query'),
    limit: z.number().default(100).describe('Max rows')
  },
  async ({ sql: userSql, limit }) => {
    const trimmed = userSql.trim().replace(/;+$/, '');
    if (!/^\s*SELECT/i.test(trimmed)) {
      return textResult('ERROR: Only SELECT queries are allowed.');
    }

    // Add LIMIT if not present
    let finalSql = trimmed;
    if (!/\bLIMIT\b/i.test(finalSql)) {
      finalSql += ` LIMIT ${limit}`;
    }

    try {
      const result = query(finalSql);
      return textResult(formatMarkdownTable(result.columns, result.rows));
    } catch (err) {
      return textResult(`SQL Error: ${err.message}`);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Tool 11: xref_impact_analysis — Impact analysis for changes
// ─────────────────────────────────────────────────────────────────────────────
server.tool(
  'xref_impact_analysis',
  'Analyze the impact of changing a D365FO object: find all direct and indirect dependents grouped by type and module. Essential before modifying shared classes, tables, or methods.',
  {
    object_name: z.string().describe('Object name or path'),
    depth: z.number().default(1).describe('Depth of analysis (1=direct only, 2=include dependents of dependents). Max 3.')
  },
  async ({ object_name, depth }) => {
    const resolved = resolveNameId(object_name);
    if (!resolved) return textResult(`Object "${object_name}" not found.`);
    const [targetId, targetPath] = resolved;
    const maxDepth = Math.min(depth, 3);

    // Also include sub-paths (methods, fields) of this object as targets
    const subPaths = query(`
      SELECT id FROM names WHERE path LIKE ? || '/%'
    `, [targetPath]);
    const allTargetIds = [targetId, ...subPaths.rows.map(r => r[0])];

    // Find all references to these targets
    const placeholders = allTargetIds.map(() => '?').join(',');
    const result = query(`
      SELECT DISTINCT n.path, r.kind, m.module
      FROM refs r
      JOIN names n ON r.source_id = n.id
      JOIN modules m ON n.module_id = m.id
      WHERE r.target_id IN (${placeholders})
      ORDER BY m.module, n.path
      LIMIT 500
    `, allTargetIds);

    // Group by kind
    const byKind = {};
    const byModule = {};
    for (const [path, k, mod] of result.rows) {
      const kn = kindName(k);
      byKind[kn] = (byKind[kn] || 0) + 1;
      byModule[mod] = (byModule[mod] || 0) + 1;
    }

    let text = `**Impact Analysis for** \`${targetPath}\`\n\n`;
    text += `**Total references:** ${result.rows.length}\n\n`;

    text += `**By reference kind:**\n`;
    for (const [k, cnt] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) {
      text += `- ${k}: ${cnt}\n`;
    }

    text += `\n**By module (top 15):**\n`;
    const sortedMods = Object.entries(byModule).sort((a, b) => b[1] - a[1]).slice(0, 15);
    for (const [mod, cnt] of sortedMods) {
      text += `- ${mod}: ${cnt}\n`;
    }

    text += `\n**Referencing objects:**\n\n`;
    const rows = result.rows.slice(0, 100).map(([path, k, mod]) => [path, kindName(k), mod]);
    text += formatMarkdownTable(['Source', 'Kind', 'Module'], rows);

    return textResult(text);
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Tool 12: xref_list_modules — List all modules
// ─────────────────────────────────────────────────────────────────────────────
server.tool(
  'xref_list_modules',
  'List all D365FO modules in the XRef database with object counts.',
  {},
  async () => {
    const result = query(`
      SELECT m.module, COUNT(DISTINCT n.id) as object_count
      FROM modules m
      LEFT JOIN names n ON n.module_id = m.id
      GROUP BY m.module
      ORDER BY object_count DESC
    `);

    const rows = result.rows.map(([mod, cnt]) => [mod, cnt]);
    return textResult(formatMarkdownTable(['Module', 'Object Count'], rows));
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Tool 13: xref_object_summary — Summary of an object's references
// ─────────────────────────────────────────────────────────────────────────────
server.tool(
  'xref_object_summary',
  'Get a compact summary of an object: incoming vs outgoing reference counts by kind, methods, sub-objects, and module.',
  {
    object_name: z.string().describe('Object name or path')
  },
  async ({ object_name }) => {
    const resolved = resolveNameId(object_name);
    if (!resolved) return textResult(`Object "${object_name}" not found.`);
    const [objId, objPath] = resolved;

    // Get module
    const modResult = query('SELECT m.module FROM names n JOIN modules m ON n.module_id = m.id WHERE n.id = ?', [objId]);
    const moduleName = modResult.rows[0]?.[0] || 'Unknown';

    // Sub-objects (methods, fields, etc.)
    const subObjects = query(`
      SELECT path FROM names WHERE path LIKE ? || '/%' ORDER BY path LIMIT 200
    `, [objPath]);

    // All IDs (object + sub-objects)
    const allIds = [objId, ...subObjects.rows.map(r => {
      const subResult = query('SELECT id FROM names WHERE path = ? LIMIT 1', [r[0]]);
      return subResult.rows[0]?.[0];
    }).filter(Boolean)];
    const ph = allIds.map(() => '?').join(',');

    // Incoming (used by)
    const incoming = query(`
      SELECT kind, COUNT(*) as cnt FROM refs WHERE target_id IN (${ph}) GROUP BY kind ORDER BY cnt DESC
    `, allIds);

    // Outgoing (uses)
    const outgoing = query(`
      SELECT kind, COUNT(*) as cnt FROM refs WHERE source_id IN (${ph}) GROUP BY kind ORDER BY cnt DESC
    `, allIds);

    let text = `**Object Summary:** \`${objPath}\`\n`;
    text += `**Module:** ${moduleName}\n`;
    text += `**Sub-objects:** ${subObjects.rows.length}\n\n`;

    // Methods list
    const methods = subObjects.rows
      .filter(r => r[0].includes('/Methods/'))
      .map(r => r[0].split('/Methods/')[1]);
    if (methods.length > 0) {
      text += `**Methods (${methods.length}):** ${methods.join(', ')}\n\n`;
    }

    text += `**Incoming references (used by):**\n`;
    let totalIn = 0;
    for (const [k, cnt] of incoming.rows) {
      text += `- ${kindName(k)}: ${cnt}\n`;
      totalIn += cnt;
    }
    text += `- **Total: ${totalIn}**\n\n`;

    text += `**Outgoing references (uses):**\n`;
    let totalOut = 0;
    for (const [k, cnt] of outgoing.rows) {
      text += `- ${kindName(k)}: ${cnt}\n`;
      totalOut += cnt;
    }
    text += `- **Total: ${totalOut}**\n`;

    return textResult(text);
  }
);

// ── Start Server ───────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
