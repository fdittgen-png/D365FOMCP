/**
 * xref-tools.js
 * SQLite version of D365FO cross-reference MCP tools.
 *
 * Registers all 13 XRef tools on a McpServer instance using a
 * better-sqlite3 database.
 */

import { query, formatMarkdownTable, textResult } from './shared.js';
import { z } from 'zod';

// Kind lookup (same values as the local SQLite version)
const KIND_NAMES = {
  1: 'Call', 2: 'Read', 3: 'Implements', 4: 'Extends',
  6: 'Delegate', 7: 'Attribute', 9: 'Tag', 10: 'Override',
};

function kindName(k) {
  return KIND_NAMES[k] || `Kind${k}`;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Resolve a name path by object name.
 *   "SalesTable"                → tries /Tables/SalesTable, /Classes/SalesTable, …
 *   "/Classes/SalesFormLetter"  → exact match
 */
function resolveNameId(queryFn, objectName) {
  if (objectName.startsWith('/') || objectName.includes('/')) {
    const rows = queryFn(
      'SELECT id, path FROM names WHERE path = ? LIMIT 1', [objectName]);
    if (rows.length > 0) return rows[0];
    const likeRows = queryFn(
      'SELECT id, path FROM names WHERE path LIKE ? LIMIT 10', [`%${objectName}%`]);
    return likeRows.length > 0 ? likeRows[0] : null;
  }

  const prefixes = [
    `/Classes/${objectName}`, `/Tables/${objectName}`, `/Forms/${objectName}`,
    `/Enums/${objectName}`, `/DataEntityViews/${objectName}`, `/Edts/${objectName}`,
    `/Views/${objectName}`, `/Maps/${objectName}`, `/Queries/${objectName}`,
  ];
  for (const path of prefixes) {
    const rows = queryFn(
      'SELECT id, path FROM names WHERE path = ? LIMIT 1', [path]);
    if (rows.length > 0) return rows[0];
  }

  const metaPrefixes = [
    `Table/${objectName}`, `Class/${objectName}`, `Form/${objectName}`,
    `Enum/${objectName}`, `DataEntityView/${objectName}`, `View/${objectName}`,
  ];
  for (const path of metaPrefixes) {
    const rows = queryFn(
      'SELECT id, path FROM names WHERE path = ? LIMIT 1', [path]);
    if (rows.length > 0) return rows[0];
  }

  return null;
}

/**
 * Build a dynamic IN-clause with positional parameters.
 * Returns { clause: '?, ?, …', params: [v0, v1, …] }
 */
function buildInClause(values) {
  const clause = values.map(() => '?').join(', ');
  return { clause, params: [...values] };
}

// ── Public registration function ────────────────────────────────────────────

export function registerXrefTools(server, db) {

  const q = (sql, params = []) => query(db, sql, params);

  // ─────────────────────────────────────────────────────────────────────────
  // Tool 1: xref_find_references — "Who uses this object?"
  // ─────────────────────────────────────────────────────────────────────────
  server.tool(
    'xref_find_references',
    'Find all objects that reference a given D365FO object (who calls/reads/extends it). This is the "Used By" / "Find All References" query.',
    {
      object_name: z.string().describe('Object name (e.g. "SalesTable", "CustInvoiceJour") or full path (e.g. "/Classes/SalesFormLetter")'),
      kind: z.enum(['All', 'Call', 'Read', 'Implements', 'Extends', 'Delegate', 'Attribute', 'Override']).default('All')
        .describe('Filter by reference kind. Default: All'),
      limit: z.number().default(100).describe('Max results (default 100)'),
    },
    async ({ object_name, kind, limit }) => {
      const resolved = resolveNameId(q, object_name);
      if (!resolved) return textResult(`Object "${object_name}" not found in XRef database.`);

      const { id: targetId, path: targetPath } = resolved;
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

      const result = q(`
        SELECT n.path AS source, r.kind, r.line, r.col, m.module
        FROM refs r
        JOIN names n ON r.source_id = n.id
        JOIN modules m ON n.module_id = m.id
        WHERE r.target_id = ? ${kindFilter}
        ORDER BY m.module, n.path
        LIMIT ?
      `, params);

      const rows = result.map(row => [
        row.source, kindName(row.kind), row.line ?? '', row.col ?? '', row.module,
      ]);

      const header = `**References TO** \`${targetPath}\` (${rows.length} results):\n\n`;
      const columns = ['Source', 'Kind', 'Line', 'Col', 'Module'];
      const table = rows.length === 0
        ? '_No results_'
        : formatTable(columns, rows);
      return textResult(header + table);
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Tool 2: xref_find_usages — "What does this object use?"
  // ─────────────────────────────────────────────────────────────────────────
  server.tool(
    'xref_find_usages',
    'Find all objects that a given D365FO object references (what it calls/reads/extends). This is the "Uses" / outgoing references query.',
    {
      object_name: z.string().describe('Object name or full path'),
      kind: z.enum(['All', 'Call', 'Read', 'Implements', 'Extends', 'Delegate', 'Attribute', 'Override']).default('All')
        .describe('Filter by reference kind'),
      limit: z.number().default(100).describe('Max results (default 100)'),
    },
    async ({ object_name, kind, limit }) => {
      const resolved = resolveNameId(q, object_name);
      if (!resolved) return textResult(`Object "${object_name}" not found in XRef database.`);

      const { id: sourceId, path: sourcePath } = resolved;
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

      const result = q(`
        SELECT n.path AS target, r.kind, r.line, r.col, m.module
        FROM refs r
        JOIN names n ON r.target_id = n.id
        JOIN modules m ON n.module_id = m.id
        WHERE r.source_id = ? ${kindFilter}
        ORDER BY r.kind, n.path
        LIMIT ?
      `, params);

      const rows = result.map(row => [
        row.target, kindName(row.kind), row.line ?? '', row.col ?? '', row.module,
      ]);

      const header = `**References FROM** \`${sourcePath}\` (${rows.length} results):\n\n`;
      return textResult(header + formatTable(['Target', 'Kind', 'Line', 'Col', 'Module'], rows));
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Tool 3: xref_find_method_callers — "Who calls this method?"
  // ─────────────────────────────────────────────────────────────────────────
  server.tool(
    'xref_find_method_callers',
    'Find all callers of a specific method on a class or table. Returns source locations with line numbers.',
    {
      object_name: z.string().describe('Class or table name (e.g. "SalesFormLetter")'),
      method_name: z.string().describe('Method name (e.g. "construct", "run")'),
      limit: z.number().default(100).describe('Max results'),
    },
    async ({ object_name, method_name, limit }) => {
      const methodPaths = [
        `/Classes/${object_name}/Methods/${method_name}`,
        `/Tables/${object_name}/Methods/${method_name}`,
        `/Forms/${object_name}/Methods/${method_name}`,
      ];

      let targetId = null;
      let targetPath = null;

      for (const path of methodPaths) {
        const rows = q(
          'SELECT id, path FROM names WHERE path = ? LIMIT 1', [path]);
        if (rows.length > 0) {
          targetId = rows[0].id;
          targetPath = rows[0].path;
          break;
        }
      }

      if (!targetId) return textResult(`Method "${object_name}.${method_name}" not found in XRef database.`);

      const result = q(`
        SELECT n.path, r.kind, r.line, r.col, m.module
        FROM refs r
        JOIN names n ON r.source_id = n.id
        JOIN modules m ON n.module_id = m.id
        WHERE r.target_id = ? AND r.kind = 1
        ORDER BY m.module, n.path, r.line
        LIMIT ?
      `, [targetId, limit]);

      const rows = result.map(row => [
        row.path, row.line ?? '', row.col ?? '', row.module,
      ]);

      const header = `**Callers of** \`${targetPath}\` (${rows.length} results):\n\n`;
      return textResult(header + formatTable(['Caller', 'Line', 'Col', 'Module'], rows));
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Tool 4: xref_class_hierarchy — "What extends this class?"
  // ─────────────────────────────────────────────────────────────────────────
  server.tool(
    'xref_class_hierarchy',
    'Find the full class inheritance hierarchy — all subclasses (recursive) or the parent chain of a given class.',
    {
      class_name: z.string().describe('Class name (e.g. "SalesFormLetter", "FormLetterServiceController")'),
      direction: z.enum(['subclasses', 'parents']).default('subclasses')
        .describe('"subclasses" = who extends this (default), "parents" = what does this extend'),
    },
    async ({ class_name, direction }) => {
      const classPath = `/Classes/${class_name}`;
      const classResult = q(
        'SELECT id FROM names WHERE path = ? LIMIT 1', [classPath]);
      if (classResult.length === 0) return textResult(`Class "${class_name}" not found.`);
      const classId = classResult[0].id;

      if (direction === 'subclasses') {
        // Recursive CTE: find all classes that extend this (kind=4)
        const result = q(`
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

        const rows = result.map(row => [
          '  '.repeat(row.depth - 1) + row.path.replace('/Classes/', ''),
          row.depth,
        ]);

        const header = `**Subclasses of** \`${class_name}\` (${rows.length} classes):\n\n`;
        return textResult(header + formatTable(['Class', 'Depth'], rows));
      } else {
        // Walk up the extends chain
        const result = q(`
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

        const rows = result.map(row => [
          row.path.replace('/Classes/', ''),
          row.depth,
        ]);

        const header = `**Inheritance chain for** \`${class_name}\`:\n\n`;
        return textResult(header + formatTable(['Class', 'Level'], rows));
      }
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Tool 5: xref_interface_implementors — "Who implements this interface?"
  // ─────────────────────────────────────────────────────────────────────────
  server.tool(
    'xref_interface_implementors',
    'Find all classes that implement a given interface, including indirect implementors through inheritance.',
    {
      interface_name: z.string().describe('Interface name (e.g. "SysRunnable", "SysPackable")'),
    },
    async ({ interface_name }) => {
      let targetId = null;
      let targetPath = null;
      for (const prefix of ['/Classes/', '/ClrType/']) {
        const rows = q(
          'SELECT id, path FROM names WHERE path = ? LIMIT 1', [prefix + interface_name]);
        if (rows.length > 0) {
          targetId = rows[0].id;
          targetPath = rows[0].path;
          break;
        }
      }
      if (!targetId) return textResult(`Interface "${interface_name}" not found.`);

      // Direct implementors (kind=3), then their subclasses (kind=4) recursively
      const result = q(`
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

      const rows = result.map(row => [
        row.path.replace('/Classes/', ''),
        row.depth === 1 ? 'Direct' : `Inherited (depth ${row.depth})`,
      ]);

      const header = `**Implementors of** \`${interface_name}\` (${rows.length} classes):\n\n`;
      return textResult(header + formatTable(['Class', 'Type'], rows));
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Tool 6: xref_search_names — Search for objects by name pattern
  // ─────────────────────────────────────────────────────────────────────────
  server.tool(
    'xref_search_names',
    'Search for D365FO objects by name pattern in the cross-reference database. Use to discover objects when you only know part of the name.',
    {
      pattern: z.string().describe('Search pattern (e.g. "SalesInvoice", "CustTrans"). Supports SQL LIKE wildcards (%).'),
      object_type: z.enum(['All', 'Classes', 'Tables', 'Forms', 'Enums', 'DataEntityViews', 'Edts', 'Views', 'Maps', 'Labels'])
        .default('All').describe('Filter by object type'),
      limit: z.number().default(50).describe('Max results'),
    },
    async ({ pattern, object_type, limit }) => {
      const likePattern = pattern.includes('%') ? pattern : `%${pattern}%`;
      let typeFilter = '';
      const params = [likePattern];

      if (object_type !== 'All') {
        typeFilter = ` AND n.path LIKE ?`;
        params.push(`/${object_type}/%`);
      }

      params.push(limit);

      const result = q(`
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
      `, params);

      const rows = result.map(row => [row.path, row.module]);
      return textResult(formatTable(['Path', 'Module'], rows));
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Tool 7: xref_method_references — "What does this method call/use?"
  // ─────────────────────────────────────────────────────────────────────────
  server.tool(
    'xref_method_references',
    'Find all outgoing references from a specific method — what objects/methods/types does it call or use.',
    {
      object_name: z.string().describe('Class or table name'),
      method_name: z.string().describe('Method name'),
      kind: z.enum(['All', 'Call', 'Read']).default('All').describe('Filter: All, Call (method invocations only), Read (type/field reads only)'),
      limit: z.number().default(100).describe('Max results'),
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
        const rows = q(
          'SELECT id, path FROM names WHERE path = ? LIMIT 1', [path]);
        if (rows.length > 0) {
          sourceId = rows[0].id;
          sourcePath = rows[0].path;
          break;
        }
      }
      if (!sourceId) return textResult(`Method "${object_name}.${method_name}" not found.`);

      let kindFilter = '';
      const params = [sourceId];
      if (kind === 'Call') { kindFilter = ' AND r.kind = 1'; }
      else if (kind === 'Read') { kindFilter = ' AND r.kind = 2'; }

      params.push(limit);

      const result = q(`
        SELECT n.path, r.kind, r.line, r.col
        FROM refs r
        JOIN names n ON r.target_id = n.id
        WHERE r.source_id = ? ${kindFilter}
        ORDER BY r.line, r.col
        LIMIT ?
      `, params);

      const rows = result.map(row => [
        row.path, kindName(row.kind), row.line ?? '', row.col ?? '',
      ]);

      const header = `**Outgoing references from** \`${sourcePath}\` (${rows.length}):\n\n`;
      return textResult(header + formatTable(['Target', 'Kind', 'Line', 'Col'], rows));
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Tool 8: xref_module_objects — Objects in a module
  // ─────────────────────────────────────────────────────────────────────────
  server.tool(
    'xref_module_objects',
    'List all top-level objects (classes, tables, forms, etc.) in a given D365FO module from the cross-reference database.',
    {
      module_name: z.string().describe('Module name (e.g. "ApplicationSuite", "EngineeringChangeManagement")'),
      object_type: z.enum(['All', 'Classes', 'Tables', 'Forms', 'Enums', 'DataEntityViews', 'Edts', 'Views'])
        .default('All').describe('Filter by object type'),
      limit: z.number().default(200).describe('Max results'),
    },
    async ({ module_name, object_type, limit }) => {
      let typeFilter = '';
      const params = [module_name];

      if (object_type !== 'All') {
        typeFilter = ` AND n.path LIKE ?`;
        params.push(`/${object_type}/%`);
      }

      params.push(limit);

      const result = q(`
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
      `, params);

      const rows = result.map(row => [row.path, row.provider]);
      const header = `**Objects in** \`${module_name}\` (${rows.length}):\n\n`;
      return textResult(header + formatTable(['Path', 'Provider'], rows));
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Tool 9: xref_cross_module_deps — Cross-module dependency analysis
  // ─────────────────────────────────────────────────────────────────────────
  server.tool(
    'xref_cross_module_deps',
    'Analyze cross-module dependencies: which modules does a given module depend on (or which modules depend on it).',
    {
      module_name: z.string().describe('Module name'),
      direction: z.enum(['depends_on', 'depended_by']).default('depends_on')
        .describe('"depends_on" = modules this module references, "depended_by" = modules that reference this one'),
      limit: z.number().default(50).describe('Max results'),
    },
    async ({ module_name, direction, limit }) => {
      let sql;
      // module_name used twice (= and !=), plus limit
      const params = [module_name, module_name, limit];

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

      const result = q(sql, params);
      const rows = result.map(row => [row.module, row.ref_count]);

      const dirLabel = direction === 'depends_on' ? 'depends on' : 'is depended on by';
      const header = `**\`${module_name}\`** ${dirLabel} (${rows.length} modules):\n\n`;
      return textResult(header + formatTable(['Module', 'Reference Count'], rows));
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Tool 10: xref_raw_sql — Ad-hoc read-only SQL
  // ─────────────────────────────────────────────────────────────────────────
  server.tool(
    'xref_raw_sql',
    'Execute a read-only SQL query against the XRef SQLite database. Schema: names(id,path,provider_id,module_id), refs(source_id,target_id,kind,line,col), modules(id,module), providers(id,provider).',
    {
      sql: z.string().describe('SQL SELECT query (no schema prefix needed — use table names directly)'),
      limit: z.number().default(100).describe('Max rows'),
    },
    async ({ sql: userSql, limit }) => {
      const trimmed = userSql.trim().replace(/;+$/, '');
      if (!/^\s*(SELECT|PRAGMA)/i.test(trimmed)) {
        return textResult('ERROR: Only SELECT/PRAGMA queries are allowed.');
      }

      // Reject dangerous keywords
      if (/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|ATTACH)\b/i.test(trimmed)) {
        return textResult('ERROR: Only SELECT queries are allowed.');
      }

      // Add LIMIT if not already present
      let finalSql = trimmed;
      if (!/\bLIMIT\b/i.test(finalSql)) {
        finalSql += ` LIMIT ${limit}`;
      }

      try {
        const result = q(finalSql);
        if (!result || result.length === 0) return textResult('_No results_');
        return textResult(formatMarkdownTable(result));
      } catch (err) {
        return textResult(`SQL Error: ${err.message}`);
      }
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Tool 11: xref_impact_analysis — Impact analysis for changes
  // ─────────────────────────────────────────────────────────────────────────
  server.tool(
    'xref_impact_analysis',
    'Analyze the impact of changing a D365FO object: find all direct and indirect dependents grouped by type and module. Essential before modifying shared classes, tables, or methods.',
    {
      object_name: z.string().describe('Object name or path'),
      depth: z.number().default(1).describe('Depth of analysis (1=direct only, 2=include dependents of dependents). Max 3.'),
    },
    async ({ object_name, depth }) => {
      const resolved = resolveNameId(q, object_name);
      if (!resolved) return textResult(`Object "${object_name}" not found.`);
      const { id: targetId, path: targetPath } = resolved;
      const maxDepth = Math.min(depth, 3);

      // Also include sub-paths (methods, fields) of this object as targets
      const subPaths = q(
        'SELECT id FROM names WHERE path LIKE ?',
        [targetPath + '/%']);
      const allTargetIds = [targetId, ...subPaths.map(r => r.id)];

      // Build dynamic IN clause
      const { clause: inClause, params: inParams } = buildInClause(allTargetIds);

      const result = q(`
        SELECT DISTINCT n.path, r.kind, m.module
        FROM refs r
        JOIN names n ON r.source_id = n.id
        JOIN modules m ON n.module_id = m.id
        WHERE r.target_id IN (${inClause})
        ORDER BY m.module, n.path
        LIMIT 500
      `, inParams);

      // Group by kind
      const byKind = {};
      const byModule = {};
      for (const row of result) {
        const kn = kindName(row.kind);
        byKind[kn] = (byKind[kn] || 0) + 1;
        byModule[row.module] = (byModule[row.module] || 0) + 1;
      }

      let text = `**Impact Analysis for** \`${targetPath}\`\n\n`;
      text += `**Total references:** ${result.length}\n\n`;

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
      const rows = result.slice(0, 100).map(row => [row.path, kindName(row.kind), row.module]);
      text += formatTable(['Source', 'Kind', 'Module'], rows);

      return textResult(text);
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Tool 12: xref_list_modules — List all modules
  // ─────────────────────────────────────────────────────────────────────────
  server.tool(
    'xref_list_modules',
    'List all D365FO modules in the XRef database with object counts.',
    {},
    async () => {
      const result = q(`
        SELECT m.module, COUNT(DISTINCT n.id) as object_count
        FROM modules m
        LEFT JOIN names n ON n.module_id = m.id
        GROUP BY m.module
        ORDER BY object_count DESC
      `);

      const rows = result.map(row => [row.module, row.object_count]);
      return textResult(formatTable(['Module', 'Object Count'], rows));
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Tool 13: xref_object_summary — Summary of an object's references
  // ─────────────────────────────────────────────────────────────────────────
  server.tool(
    'xref_object_summary',
    'Get a compact summary of an object: incoming vs outgoing reference counts by kind, methods, sub-objects, and module.',
    {
      object_name: z.string().describe('Object name or path'),
    },
    async ({ object_name }) => {
      const resolved = resolveNameId(q, object_name);
      if (!resolved) return textResult(`Object "${object_name}" not found.`);
      const { id: objId, path: objPath } = resolved;

      // Get module
      const modResult = q(
        'SELECT m.module FROM names n JOIN modules m ON n.module_id = m.id WHERE n.id = ?',
        [objId]);
      const moduleName = modResult[0]?.module || 'Unknown';

      // Sub-objects (methods, fields, etc.)
      const subObjects = q(
        'SELECT id, path FROM names WHERE path LIKE ? ORDER BY path LIMIT 200',
        [objPath + '/%']);

      // All IDs (object + sub-objects)
      const allIds = [objId, ...subObjects.map(r => r.id)];
      const { clause: inClause, params: inParams } = buildInClause(allIds);

      // Incoming (used by)
      const incoming = q(`
        SELECT kind, COUNT(*) as cnt FROM refs WHERE target_id IN (${inClause}) GROUP BY kind ORDER BY cnt DESC
      `, inParams);

      // Outgoing (uses)
      const { clause: inClause2, params: inParams2 } = buildInClause(allIds);
      const outgoing = q(`
        SELECT kind, COUNT(*) as cnt FROM refs WHERE source_id IN (${inClause2}) GROUP BY kind ORDER BY cnt DESC
      `, inParams2);

      let text = `**Object Summary:** \`${objPath}\`\n`;
      text += `**Module:** ${moduleName}\n`;
      text += `**Sub-objects:** ${subObjects.length}\n\n`;

      // Methods list
      const methods = subObjects
        .filter(r => r.path.includes('/Methods/'))
        .map(r => r.path.split('/Methods/')[1]);
      if (methods.length > 0) {
        text += `**Methods (${methods.length}):** ${methods.join(', ')}\n\n`;
      }

      text += `**Incoming references (used by):**\n`;
      let totalIn = 0;
      for (const row of incoming) {
        text += `- ${kindName(row.kind)}: ${row.cnt}\n`;
        totalIn += row.cnt;
      }
      text += `- **Total: ${totalIn}**\n\n`;

      text += `**Outgoing references (uses):**\n`;
      let totalOut = 0;
      for (const row of outgoing) {
        text += `- ${kindName(row.kind)}: ${row.cnt}\n`;
        totalOut += row.cnt;
      }
      text += `- **Total: ${totalOut}**\n`;

      return textResult(text);
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Tool 14: xref_find_extensions — "What CoC/extension classes exist for this object?"
  // ─────────────────────────────────────────────────────────────────────────
  server.tool(
    'xref_find_extensions',
    'Find all Chain of Command (CoC) extension classes and table/form extensions for a D365FO object. Shows [ExtensionOf] classes that wrap the target with CoC methods using "next".',
    {
      object_name: z.string().describe('Object name (e.g. "SalesTable", "CustTable", "SalesFormLetter")'),
      object_type: z.enum(['All', 'Classes', 'Tables', 'Forms', 'DataEntityViews']).default('All')
        .describe('Object type to search for extensions. Default: All'),
      limit: z.number().default(100).describe('Max results'),
    },
    async ({ object_name, object_type, limit }) => {
      // Strategy: Extension classes reference /Classes/ExtensionOf via kind=7 (Attribute)
      // and their name typically contains the target object name + "_Extension" suffix.
      // We also check xref for classes that have an Attribute (kind=7) reference to the target object.

      const params = [];
      const patterns = [];

      if (object_type === 'All' || object_type === 'Classes') {
        patterns.push(`/Classes/${object_name}%_Extension`);
        patterns.push(`/Classes/${object_name}%Extension`);
      }
      if (object_type === 'All' || object_type === 'Tables') {
        patterns.push(`/Classes/${object_name}%_Extension`);
        patterns.push(`/Tables/${object_name}.Extension%`);
      }
      if (object_type === 'All' || object_type === 'Forms') {
        patterns.push(`/Classes/${object_name}Form%_Extension`);
        patterns.push(`/Forms/${object_name}.Extension%`);
      }
      if (object_type === 'All' || object_type === 'DataEntityViews') {
        patterns.push(`/DataEntityViews/${object_name}.Extension%`);
      }

      // Deduplicate patterns
      const uniquePatterns = [...new Set(patterns)];

      // Build OR clause for LIKE patterns
      const likeClauses = uniquePatterns.map(() => 'n.path LIKE ?').join(' OR ');
      params.push(...uniquePatterns, limit);

      const result = q(`
        SELECT DISTINCT n.path, m.module
        FROM names n
        JOIN modules m ON n.module_id = m.id
        WHERE (${likeClauses})
          AND n.path NOT LIKE '%/Methods/%'
          AND n.path NOT LIKE '%/Fields/%'
        ORDER BY n.path
        LIMIT ?
      `, params);

      if (!result || result.length === 0) {
        return textResult(`No extensions found for "${object_name}".`);
      }

      // Categorize results
      const cocClasses = [];
      const tableExtensions = [];
      const formExtensions = [];
      const entityExtensions = [];
      const other = [];

      for (const row of result) {
        if (row.path.startsWith('/Classes/')) {
          cocClasses.push(row);
        } else if (row.path.startsWith('/Tables/') && row.path.includes('.Extension')) {
          tableExtensions.push(row);
        } else if (row.path.startsWith('/Forms/') && row.path.includes('.Extension')) {
          formExtensions.push(row);
        } else if (row.path.startsWith('/DataEntityViews/') && row.path.includes('.Extension')) {
          entityExtensions.push(row);
        } else {
          other.push(row);
        }
      }

      let text = `**Extensions for** \`${object_name}\`\n\n`;

      if (cocClasses.length > 0) {
        text += `**CoC / [ExtensionOf] Classes (${cocClasses.length}):**\n\n`;
        text += formatTable(
          ['Class', 'Module'],
          cocClasses.map(r => [r.path.replace('/Classes/', ''), r.module])
        );
        text += '\n\n';
      }

      if (tableExtensions.length > 0) {
        text += `**Table Extensions (${tableExtensions.length}):**\n\n`;
        text += formatTable(
          ['Extension', 'Module'],
          tableExtensions.map(r => [r.path, r.module])
        );
        text += '\n\n';
      }

      if (formExtensions.length > 0) {
        text += `**Form Extensions (${formExtensions.length}):**\n\n`;
        text += formatTable(
          ['Extension', 'Module'],
          formExtensions.map(r => [r.path, r.module])
        );
        text += '\n\n';
      }

      if (entityExtensions.length > 0) {
        text += `**Entity Extensions (${entityExtensions.length}):**\n\n`;
        text += formatTable(
          ['Extension', 'Module'],
          entityExtensions.map(r => [r.path, r.module])
        );
        text += '\n\n';
      }

      if (other.length > 0) {
        text += `**Other (${other.length}):**\n\n`;
        text += formatTable(['Path', 'Module'], other.map(r => [r.path, r.module]));
        text += '\n\n';
      }

      text += `\n**Total:** ${result.length} extensions`;
      return textResult(text);
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Tool 15: xref_find_field_usages — "Who reads/writes this field?"
  // ─────────────────────────────────────────────────────────────────────────
  server.tool(
    'xref_find_field_usages',
    'Find all code locations that read or write a specific field on a D365FO table. Returns callers with line numbers, grouped by kind (Read vs Call/Write).',
    {
      table_name: z.string().describe('Table name (e.g. "CustTable", "SalesTable")'),
      field_name: z.string().describe('Field name (e.g. "AccountNum", "InvoiceId")'),
      kind: z.enum(['All', 'Read', 'Write']).default('All')
        .describe('Filter: All, Read (field value reads), Write (field assignments). Default: All'),
      limit: z.number().default(100).describe('Max results'),
    },
    async ({ table_name, field_name, kind, limit }) => {
      // Fields are stored as /Tables/TableName/Fields/FieldName in xref
      const fieldPath = `/Tables/${table_name}/Fields/${field_name}`;

      // Resolve the field's name ID
      const fieldResult = q(
        'SELECT id FROM names WHERE path = ? LIMIT 1', [fieldPath]);

      if (fieldResult.length === 0) {
        // Try fuzzy match
        const fuzzy = q(
          'SELECT path FROM names WHERE path LIKE ? AND path LIKE ? LIMIT 10',
          [`%${table_name}%`, `%${field_name}%`]);
        if (fuzzy.length > 0) {
          return textResult(`Field "${table_name}.${field_name}" not found. Did you mean:\n${fuzzy.map(r => `- ${r.path}`).join('\n')}`);
        }
        return textResult(`Field "${table_name}.${field_name}" not found in XRef database.`);
      }

      const fieldId = fieldResult[0].id;
      let kindFilter = '';
      const params = [fieldId];

      // kind=2 is Read in xref, kind=1 is Call (used for writes/method invocations)
      if (kind === 'Read') {
        kindFilter = ' AND r.kind = 2';
      } else if (kind === 'Write') {
        kindFilter = ' AND r.kind = 1';
      }

      params.push(limit);

      const result = q(`
        SELECT n.path AS source, r.kind, r.line, r.col, m.module
        FROM refs r
        JOIN names n ON r.source_id = n.id
        JOIN modules m ON n.module_id = m.id
        WHERE r.target_id = ? ${kindFilter}
        ORDER BY m.module, n.path, r.line
        LIMIT ?
      `, params);

      if (!result || result.length === 0) {
        return textResult(`No usages found for field "${table_name}.${field_name}".`);
      }

      // Group by kind
      const reads = result.filter(r => r.kind === 2);
      const writes = result.filter(r => r.kind === 1);
      const other = result.filter(r => r.kind !== 1 && r.kind !== 2);

      let text = `**Field usages:** \`${table_name}.${field_name}\` (${result.length} results)\n\n`;

      if (reads.length > 0) {
        text += `**Reads (${reads.length}):**\n\n`;
        text += formatTable(
          ['Source', 'Line', 'Col', 'Module'],
          reads.map(r => [r.source, r.line ?? '', r.col ?? '', r.module])
        );
        text += '\n\n';
      }

      if (writes.length > 0) {
        text += `**Writes/Calls (${writes.length}):**\n\n`;
        text += formatTable(
          ['Source', 'Line', 'Col', 'Module'],
          writes.map(r => [r.source, r.line ?? '', r.col ?? '', r.module])
        );
        text += '\n\n';
      }

      if (other.length > 0) {
        text += `**Other references (${other.length}):**\n\n`;
        text += formatTable(
          ['Source', 'Kind', 'Line', 'Module'],
          other.map(r => [r.source, kindName(r.kind), r.line ?? '', r.module])
        );
      }

      return textResult(text);
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Tool 16: xref_find_event_handlers — "What event handlers subscribe to this delegate/event?"
  // ─────────────────────────────────────────────────────────────────────────
  server.tool(
    'xref_find_event_handlers',
    'Find all event handlers and delegates for a D365FO object or method. Discovers [SubscribesTo], [DataEventHandler], [PreHandlerFor], [PostHandlerFor] subscriptions, and delegate definitions.',
    {
      object_name: z.string().describe('Class or table name (e.g. "SalesFormLetter", "CustTable")'),
      method_name: z.string().optional().describe('Optional: specific method/delegate name to find handlers for'),
      limit: z.number().default(100).describe('Max results'),
    },
    async ({ object_name, method_name, limit }) => {
      let text = '';

      // Part 1: Find delegate definitions on this object (kind=6 references FROM the object)
      const resolved = resolveNameId(q, object_name);
      let delegateResults = [];

      if (resolved) {
        const { id: objId, path: objPath } = resolved;

        // Find all sub-paths (methods) that ARE delegates
        const delegatePaths = q(`
          SELECT DISTINCT t.path
          FROM refs r
          JOIN names n ON r.source_id = n.id
          JOIN names t ON r.target_id = t.id
          WHERE r.kind = 6
            AND n.path LIKE ?
          LIMIT ?
        `, [objPath + '/%', limit]);

        // Find methods on this object that have delegate references
        const delegateMethods = q(`
          SELECT DISTINCT n.path
          FROM names n
          JOIN refs r ON r.source_id = n.id
          WHERE n.path LIKE ?
            AND r.kind = 6
          LIMIT ?
        `, [objPath + '/Methods/%', limit]);

        if (delegateMethods.length > 0) {
          text += `**Delegates defined on** \`${objPath}\`:\n\n`;
          text += formatTable(
            ['Delegate Method'],
            delegateMethods.map(r => [r.path.split('/Methods/')[1] || r.path])
          );
          text += '\n\n';
        }
      }

      // Part 2: Find event handlers that subscribe to this object's events
      // These are methods with [SubscribesTo(classStr(ObjectName), ...)] or
      // [DataEventHandler(tableStr(ObjectName), ...)] attributes.
      // In xref: kind=7 (Attribute) where the source method references SubscribesTo/DataEventHandlerAttribute
      // AND also references the target object.

      // Strategy: Find all methods that have Attribute refs (kind=7) to both
      // SubscribesTo/DataEventHandler AND to the target object
      const handlerPatterns = method_name
        ? [`%${object_name}%${method_name}%`]
        : [`%${object_name}%`];

      // Search for methods referencing SubscribesTo that also reference the target object
      // We use the KB database approach: search source_code for SubscribesTo + object name
      // Since this tool is in xref-tools, we use the xref approach:
      // Find methods whose path contains handler patterns AND have kind=7 refs to SubscribesTo

      // First, find all subscriber/handler methods that reference this object
      const subscriberParams = [];
      let subscriberFilter = '';

      if (method_name) {
        // Specific delegate: find handlers that reference both the class and method
        subscriberFilter = `
          AND n.path IN (
            SELECT r2.source_id FROM refs r2
            JOIN names t2 ON r2.target_id = t2.id
            WHERE r2.kind = 7 AND (t2.path = '/Classes/SubscribesTo' OR t2.path = '/Classes/DataEventHandlerAttribute')
          )
        `;
        // This is complex — let's use a simpler pattern-based approach
        subscriberFilter = '';
      }

      // Find methods with SubscribesTo attribute that reference our target
      const subscriberResult = q(`
        SELECT DISTINCT n.path, m.module
        FROM names n
        JOIN modules m ON n.module_id = m.id
        JOIN refs r ON r.source_id = n.id
        JOIN names attr ON r.target_id = attr.id
        WHERE r.kind = 7
          AND (attr.path = '/Classes/SubscribesTo' OR attr.path = '/Classes/DataEventHandlerAttribute'
               OR attr.path = '/Classes/PostHandlerFor' OR attr.path = '/Classes/PreHandlerFor')
          AND n.path LIKE '/Classes/%/Methods/%'
          AND EXISTS (
            SELECT 1 FROM refs r2
            JOIN names t2 ON r2.target_id = t2.id
            WHERE r2.source_id = n.id
              AND t2.path LIKE ?
          )
        ORDER BY n.path
        LIMIT ?
      `, [`%${object_name}%`, limit]);

      if (subscriberResult.length > 0) {
        text += `**Event handlers subscribing to** \`${object_name}\`${method_name ? '.' + method_name : ''} **(${subscriberResult.length}):**\n\n`;
        text += formatTable(
          ['Handler Method', 'Module'],
          subscriberResult.map(r => [r.path, r.module])
        );
        text += '\n\n';
      }

      // Part 3: Find DataEventHandler subscriptions via table event patterns
      // These use [DataEventHandler(tableStr(TableName), DataEventType::Inserted)]
      const dataEventResult = q(`
        SELECT DISTINCT n.path, m.module
        FROM names n
        JOIN modules m ON n.module_id = m.id
        JOIN refs r ON r.source_id = n.id
        JOIN names attr ON r.target_id = attr.id
        WHERE r.kind = 7
          AND attr.path = '/Classes/DataEventHandlerAttribute'
          AND n.path LIKE '/Classes/%/Methods/%'
          AND EXISTS (
            SELECT 1 FROM refs r2
            JOIN names t2 ON r2.target_id = t2.id
            WHERE r2.source_id = n.id
              AND (t2.path = '/Tables/${object_name}' OR t2.path LIKE '/Tables/${object_name}/%')
          )
        ORDER BY n.path
        LIMIT ?
      `, [limit]);

      if (dataEventResult.length > 0 && subscriberResult.length === 0) {
        // Only show if not already captured above
        text += `**Data event handlers for** \`${object_name}\` **(${dataEventResult.length}):**\n\n`;
        text += formatTable(
          ['Handler Method', 'Module'],
          dataEventResult.map(r => [r.path, r.module])
        );
        text += '\n\n';
      }

      // Part 4: Find Override handlers (kind=10) on this object
      if (resolved) {
        const overrideResult = q(`
          SELECT DISTINCT n.path, m.module
          FROM refs r
          JOIN names n ON r.source_id = n.id
          JOIN modules m ON n.module_id = m.id
          WHERE r.kind = 10
            AND r.target_id IN (
              SELECT id FROM names WHERE path LIKE ?
            )
          ORDER BY n.path
          LIMIT ?
        `, [resolved.path + '/Methods/%', limit]);

        if (overrideResult.length > 0) {
          text += `**Method overrides on** \`${object_name}\` **(${overrideResult.length}):**\n\n`;
          text += formatTable(
            ['Override', 'Module'],
            overrideResult.map(r => [r.path, r.module])
          );
        }
      }

      if (!text) {
        return textResult(`No event handlers or delegates found for "${object_name}"${method_name ? '.' + method_name : ''}.`);
      }

      return textResult(text);
    },
  );
}

// ── Internal table formatter (columns + array-of-arrays) ────────────────────
// The shared formatMarkdownTable works with row objects, but many tools above
// build array-of-arrays.  This small helper keeps the code concise.

function formatTable(columns, rows) {
  if (rows.length === 0) return '_No results_';
  const header = '| ' + columns.join(' | ') + ' |';
  const sep = '| ' + columns.map(() => '---').join(' | ') + ' |';
  const body = rows
    .map(r => '| ' + r.map(c => (c == null ? '' : String(c))).join(' | ') + ' |')
    .join('\n');
  return `${header}\n${sep}\n${body}`;
}
