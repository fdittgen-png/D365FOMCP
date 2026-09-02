/**
 * xref-tools.js
 * SQLite version of D365FO cross-reference MCP tools.
 *
 * Registers all 16 XRef tools on a McpServer instance using a
 * better-sqlite3 database. Every tool follows the response-format contract:
 * registerTool + outputSchema, typed-first rendering via structuredResult,
 * emptyResult/notFoundResult/errorResult, and truncationNote — never
 * hand-rolled strings or bold-text fake headers.
 */

import {
  query,
  formatMarkdownTable,
  emptyResult,
  notFoundResult,
  errorResult,
  truncationNote,
  structuredResult,
  formatTextParam,
  modulesFilterParam,
  sanitizeModulesFilter,
  queryModelVersions,
  validateLikePattern,
  patternErrorResult,
  customLayerNote,
  runWithBudget,
  QueryBudgetExceededError,
  timeoutErrorResult,
  READ_ONLY_DB_ANNOTATIONS,
} from './shared.js';
import { installToolGuards } from './tool-guards.js';
import { z } from 'zod';
import {
  xrefFindReferencesOutput,
  xrefFindUsagesOutput,
  xrefFindMethodCallersOutput,
  xrefClassHierarchyOutput,
  xrefInterfaceImplementorsOutput,
  xrefSearchNamesOutput,
  xrefMethodReferencesOutput,
  xrefModuleObjectsOutput,
  xrefCrossModuleDepsOutput,
  xrefListModulesOutput,
  xrefObjectSummaryOutput,
  xrefFindExtensionsOutput,
  xrefFindFieldUsagesOutput,
  xrefFindEventHandlersOutput,
  xrefImpactAnalysisOutput,
  rawSqlOutput,
} from './output-schemas.js';
import { hasIsvData } from './isv-schema.js';
import { cursorParam, decodeCursor, pageMeta, pageNote, probeLimit, takePage } from './pagination.js';

/** Convert array-of-arrays rows to array-of-objects using column names as keys. */
function rowsToObjects(columns, arrayRows) {
  return arrayRows.map(row => Object.fromEntries(columns.map((c, i) => [c, row[i]])));
}

// Kind lookup (same values as the local SQLite version)
const KIND_NAMES = {
  1: 'Call', 2: 'Read', 3: 'Implements', 4: 'Extends',
  6: 'Delegate', 7: 'Attribute', 9: 'Tag', 10: 'Override',
};

function kindName(k) {
  return KIND_NAMES[k] || `Kind${k}`;
}

/** Numeric line/col → number or null (schemas type these as number|null). */
function num(v) {
  return v === null || v === undefined || v === '' ? null : Number(v);
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
  // Agent guardrails (loop detection + one-shot staleness note) wrap every
  // tool registered below. Returns a proxy, so the shared McpServer is not
  // mutated and a second register*Tools() call cannot double-wrap it.
  server = installToolGuards(server, { service: 'xref', db });


  // Batch cap (issue #83): xref_object_summary is the recommended first call
  // before drilling into an object, so batching it removes the most common
  // source of repeated round-trips. It saves round-trips, not bytes — the
  // batched body measured +1.6% against eight separate calls; see the note in
  // kb-tools.js. Each summary runs its own aggregate queries, hence a modest cap.
  const SUMMARY_BATCH_MAX = 10;
  const REFS_BATCH_MAX = 10;

  const q = (sql, params = []) => query(db, sql, params);

  /**
   * Per-model reference counts from the sealed-ISV tables (issues #77, #82).
   *
   * The main `refs` table has no rows sourced from binary-only ISV models —
   * measured: `Lasernet` has 0 outbound references there — so a "who references
   * this?" answer is silently incomplete for anything a third-party model
   * touches. This adds the missing side as a separate, clearly-labelled block.
   *
   * Returns null when the database predates the ISV scan, so the caller emits
   * no ISV block at all rather than an empty one that reads like "no ISV uses".
   *
   * @param {string} targetPath  resolved AOT path, e.g. /Tables/CustTable
   */
  function isvReferenceSummary(targetPath) {
    if (!hasIsvData(db)) return null;
    let rows;
    try {
      rows = q(`SELECT n.module AS module, COUNT(*) AS c
                FROM isv_refs r JOIN isv_names n ON n.id = r.source_id
                WHERE r.target_path = ? COLLATE NOCASE
                   OR r.target_path LIKE ? COLLATE NOCASE
                GROUP BY n.module ORDER BY c DESC`,
      [targetPath, `${targetPath}/%`]);
    } catch (err) {
      console.error('[xref-tools:isvReferenceSummary]', err);
      return null;
    }
    const summary = rows.map(r => ({ module: String(r.module), reference_count: Number(r.c || 0) }));
    return {
      reference_count: summary.reduce((n, m) => n + m.reference_count, 0),
      module_summary: summary,
      note: 'From sealed ISV metadata — these models ship no X++ source and are '
        + 'absent from the main cross-reference snapshot. Call sites: xref_isv_find_usages.',
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Tool 1: xref_find_references — "Who uses this object?"
  // ─────────────────────────────────────────────────────────────────────────
  server.registerTool(
    'xref_find_references',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description: 'Find all objects that reference a given D365FO object (who calls/reads/extends it). This is the "Used By" / "Find All References" query. Set `include_isv` to add a summary of references from sealed (binary-only) ISV models, which are absent from this snapshot entirely — do that before changing or deprecating anything a third-party model might touch.',
      inputSchema: {
        object_name: z.string().min(1).max(500).optional().describe('Object name (e.g. "SalesTable", "CustInvoiceJour") or full path (e.g. "/Classes/SalesFormLetter"). Use this or `objects`.'),
        objects: z.array(z.string().min(1).max(500)).min(1).max(REFS_BATCH_MAX).optional()
          .describe(`Several objects in one call (max ${REFS_BATCH_MAX}); kind / limit / include_isv apply to each. Unresolvable names come back in \`not_found\`.`),
        kind: z.enum(['All', 'Call', 'Read', 'Implements', 'Extends', 'Delegate', 'Attribute', 'Override']).default('All')
          .describe('Filter by reference kind. Default: All'),
        limit: z.number().int().min(1).max(500).default(100).describe('Max results (default 100, max 500)'),
        include_isv: z.boolean().optional().default(false)
          .describe('Add a per-model count of references from sealed ISV models. Off by default so existing results are unchanged. Use `xref_isv_find_usages` for the individual call sites.'),
        cursor: cursorParam,
        format: formatTextParam,
      },
      outputSchema: xrefFindReferencesOutput.shape,
    },
    async ({ object_name, objects, kind, limit: rawLimit, include_isv, cursor, format }) => {
      const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? rawLimit : 100;
      const kindFilterLabel = kind || 'All';
      // Defensive default: the test mock server bypasses Zod (contract item 13).
      const wantIsv = include_isv === true;
      const page = decodeCursor(cursor);
      if (!page.ok) return page.error;

      // Batching (issue #83): singular and plural are unioned and deduped in
      // caller order; kind / limit / include_isv are hoisted into the envelope.
      const requested = [...new Set([
        ...(Array.isArray(objects) ? objects : []),
        ...(object_name ? [object_name] : []),
      ].map(s => String(s).trim()).filter(Boolean))];
      if (!requested.length) return errorResult('invalid-input', 'Provide `object_name` or `objects`.');
      const batchMode = Array.isArray(objects) && objects.length > 0;
      if (batchMode && page.offset > 0) {
        return errorResult('invalid-input', '`cursor` pages a single `object_name`; run a batch without it.');
      }
      const names = requested.slice(0, REFS_BATCH_MAX);
      for (const n of names) {
        const _v = validateLikePattern(n);
        if (_v) return patternErrorResult(_v);
      }

      let kindFilter = '';
      const kindParams = [];
      if (kindFilterLabel !== 'All') {
        const kindId = Object.entries(KIND_NAMES).find(([, v]) => v === kindFilterLabel)?.[0];
        if (kindId) { kindFilter = ' AND r.kind = ?'; kindParams.push(Number(kindId)); }
      }

      /** References to one resolved object; null when the name does not resolve.
       *  Fetches limit+1 rows so has_more is exact; line/col complete the ORDER
       *  BY so OFFSET is stable when one source references the target twice. */
      const findOne = (name, offset = 0) => {
        const resolved = resolveNameId(q, name);
        if (!resolved) return null;
        const { id: targetId, path: targetPath } = resolved;
        const { rows: result, has_more } = takePage(q(`
          SELECT n.path AS source, r.kind, r.line, r.col, m.module
          FROM refs r
          JOIN names n ON r.source_id = n.id
          JOIN modules m ON n.module_id = m.id
          WHERE r.target_id = ? ${kindFilter}
          ORDER BY m.module, n.path, r.line, r.col
          LIMIT ? OFFSET ?
        `, [targetId, ...kindParams, probeLimit(limit), offset]), limit);
        return {
          target_path: targetPath,
          result_count: result.length,
          truncated: has_more,
          has_more,
          references: result.map(r => ({
            path: r.source, kind: kindName(r.kind), line: num(r.line), col: num(r.col), module: r.module ?? null,
          })),
          isv: wantIsv ? isvReferenceSummary(targetPath) : null,
        };
      };

      const renderRefs = (p) => formatMarkdownTable(
        p.references.map(r => ({ Source: r.path, Kind: r.kind, Line: r.line ?? '', Col: r.col ?? '', Module: r.module ?? '' })),
        ['Source', 'Kind', 'Line', 'Col', 'Module'],
      );
      const renderIsv = (isvBlock, heading) => {
        let s = `\n${heading} Sealed ISV models (${isvBlock.reference_count})\n\n`;
        s += isvBlock.reference_count
          ? formatMarkdownTable(
            isvBlock.module_summary.map(m => ({ Model: m.module, References: m.reference_count })),
            ['Model', 'References'])
          : '_No sealed ISV model references this object._\n';
        return s;
      };

      if (!batchMode) {
        const one = findOne(names[0], page.offset);
        if (!one) return notFoundResult('Object', names[0]);
        // Exactly the pre-batching payload plus the page keys — no batch keys.
        const baseTyped = {
          target_path: one.target_path,
          kind_filter: kindFilterLabel,
          limit,
          result_count: one.result_count,
          truncated: one.truncated,
          references: one.references,
          isv: one.isv,
          ...pageMeta(null, page.offset, one.result_count, limit, one.has_more),
        };
        const isvBlock = one.isv;
        if (!one.result_count && !(isvBlock && isvBlock.reference_count)) {
          return emptyResult(`references to "${one.target_path}"`, baseTyped);
        }

        let out = `## References to ${one.target_path}\n${baseTyped.result_count} result(s)\n\n`;
        out += renderRefs(baseTyped);
        if (baseTyped.has_more) out += pageNote(baseTyped.result_count, page.offset, baseTyped.next_cursor);
        if (isvBlock) out += renderIsv(isvBlock, '###') + `\n_${isvBlock.note}_\n`;
        return structuredResult(baseTyped, out, format);
      }

      // Batch mode: only batch keys. The ISV note is identical for every object,
      // so it is hoisted once into `isv_note`; each object's `isv` block keeps
      // just its counts. Rule #14: the `isv` key is present on every object or
      // on none (decided by include_isv + whether the DB was ISV-scanned).
      const found = [];
      const notFound = [];
      for (const n of names) {
        const one = findOne(n);
        if (!one) { notFound.push(n); continue; }
        found.push(one);
      }
      const emitIsv = wantIsv && found.some(o => o.isv);
      const isvNote = emitIsv ? (found.find(o => o.isv)?.isv.note ?? null) : null;
      const typed = {
        kind_filter: kindFilterLabel,
        limit,
        requested_count: names.length,
        resolved_count: found.length,
        not_found: notFound,
        ...(isvNote ? { isv_note: isvNote } : {}),
        objects: found.map(o => ({
          target_path: o.target_path,
          result_count: o.result_count,
          truncated: o.truncated,
          references: o.references,
          ...(emitIsv ? {
            isv: o.isv
              ? { reference_count: o.isv.reference_count, module_summary: o.isv.module_summary }
              : { reference_count: 0, module_summary: [] },
          } : {}),
        })),
      };

      let out = `## References (${typed.resolved_count} of ${typed.requested_count} objects)\n\n`;
      for (const o of typed.objects) {
        out += `### ${o.target_path} (${o.result_count})\n`;
        out += o.result_count ? renderRefs(o) : '_No references._\n';
        if (o.truncated) out += truncationNote('user', limit);
        if (o.isv) out += renderIsv(o.isv, '####');
        out += '\n';
      }
      if (isvNote) out += `_${isvNote}_\n\n`;
      if (notFound.length) out += `**Not found:** ${notFound.join(', ')}\n`;
      if (requested.length > names.length) out += truncationNote('cap', names.length, REFS_BATCH_MAX);
      return structuredResult(typed, out, format);
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Tool 2: xref_find_usages — "What does this object use?"
  // ─────────────────────────────────────────────────────────────────────────
  server.registerTool(
    'xref_find_usages',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description: 'Find all objects that a given D365FO object references (what it calls/reads/extends). This is the "Uses" / outgoing references query.',
      inputSchema: {
        object_name: z.string().min(1).max(500).describe('Object name or full path'),
        kind: z.enum(['All', 'Call', 'Read', 'Implements', 'Extends', 'Delegate', 'Attribute', 'Override']).default('All')
          .describe('Filter by reference kind'),
        limit: z.number().int().min(1).max(500).default(100).describe('Max results (default 100, max 500)'),
        cursor: cursorParam,
        format: formatTextParam,
      },
      outputSchema: xrefFindUsagesOutput.shape,
    },
    async ({ object_name, kind, limit: rawLimit, cursor, format }) => {
      const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? rawLimit : 100;
      const page = decodeCursor(cursor);
      if (!page.ok) return page.error;
      const _v = validateLikePattern(object_name);
      if (_v) return patternErrorResult(_v);
      const resolved = resolveNameId(q, object_name);
      if (!resolved) return notFoundResult('Object', object_name);

      const { id: sourceId, path: sourcePath } = resolved;
      const kindFilterLabel = kind || 'All';
      let kindFilter = '';
      const params = [sourceId];

      if (kindFilterLabel !== 'All') {
        const kindId = Object.entries(KIND_NAMES).find(([, v]) => v === kindFilterLabel)?.[0];
        if (kindId) { kindFilter = ' AND r.kind = ?'; params.push(Number(kindId)); }
      }
      params.push(probeLimit(limit), page.offset);

      // line/col complete the ORDER BY so OFFSET is stable (#109).
      const { rows: result, has_more } = takePage(q(`
        SELECT n.path AS target, r.kind, r.line, r.col, m.module
        FROM refs r
        JOIN names n ON r.target_id = n.id
        JOIN modules m ON n.module_id = m.id
        WHERE r.source_id = ? ${kindFilter}
        ORDER BY r.kind, n.path, r.line, r.col
        LIMIT ? OFFSET ?
      `, params), limit);

      const typed = {
        source_path: sourcePath,
        kind_filter: kindFilterLabel,
        limit,
        result_count: result.length,
        truncated: has_more,
        usages: result.map(r => ({
          path: r.target, kind: kindName(r.kind), line: num(r.line), col: num(r.col), module: r.module ?? null,
        })),
        ...pageMeta(null, page.offset, result.length, limit, has_more),
      };
      if (!result.length) return emptyResult(`outgoing references from "${sourcePath}"`, typed);

      let out = `## Outgoing references from ${sourcePath}\n${typed.result_count} result(s)\n\n`;
      out += formatMarkdownTable(
        typed.usages.map(r => ({ Target: r.path, Kind: r.kind, Line: r.line ?? '', Col: r.col ?? '', Module: r.module ?? '' })),
        ['Target', 'Kind', 'Line', 'Col', 'Module'],
      );
      if (typed.has_more) out += pageNote(typed.result_count, page.offset, typed.next_cursor);
      return structuredResult(typed, out, format);
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Tool 3: xref_find_method_callers — "Who calls this method?"
  // ─────────────────────────────────────────────────────────────────────────
  server.registerTool(
    'xref_find_method_callers',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description: 'Find all callers of a specific method on a class or table. Returns source locations with line numbers.',
      inputSchema: {
        object_name: z.string().min(1).max(500).describe('Class or table name (e.g. "SalesFormLetter")'),
        method_name: z.string().min(1).max(500).describe('Method name (e.g. "construct", "run")'),
        limit: z.number().int().min(1).max(500).default(100).describe('Max results (default 100, max 500)'),
        format: formatTextParam,
      },
      outputSchema: xrefFindMethodCallersOutput.shape,
    },
    async ({ object_name, method_name, limit: rawLimit, format }) => {
      const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? rawLimit : 100;
      const methodPaths = [
        `/Classes/${object_name}/Methods/${method_name}`,
        `/Tables/${object_name}/Methods/${method_name}`,
        `/Forms/${object_name}/Methods/${method_name}`,
      ];

      let targetId = null;
      let targetPath = null;
      for (const path of methodPaths) {
        const rows = q('SELECT id, path FROM names WHERE path = ? LIMIT 1', [path]);
        if (rows.length > 0) { targetId = rows[0].id; targetPath = rows[0].path; break; }
      }
      if (!targetId) return notFoundResult('Method', `${object_name}.${method_name}`);

      const result = q(`
        SELECT n.path, r.kind, r.line, r.col, m.module
        FROM refs r
        JOIN names n ON r.source_id = n.id
        JOIN modules m ON n.module_id = m.id
        WHERE r.target_id = ? AND r.kind = 1
        ORDER BY m.module, n.path, r.line
        LIMIT ?
      `, [targetId, limit]);

      const typed = {
        target_path: targetPath,
        method_name,
        owner_name: object_name,
        limit,
        result_count: result.length,
        truncated: result.length >= limit,
        callers: result.map(r => ({ path: r.path, line: num(r.line), col: num(r.col), module: r.module ?? null })),
      };
      if (!result.length) return emptyResult(`callers of "${targetPath}"`, typed);

      let out = `## Callers of ${targetPath}\n${typed.result_count} result(s)\n\n`;
      out += formatMarkdownTable(
        typed.callers.map(r => ({ Caller: r.path, Line: r.line ?? '', Col: r.col ?? '', Module: r.module ?? '' })),
        ['Caller', 'Line', 'Col', 'Module'],
      );
      if (typed.truncated) out += truncationNote('user', limit);
      return structuredResult(typed, out, format);
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Tool 4: xref_class_hierarchy — "What extends this class?"
  // ─────────────────────────────────────────────────────────────────────────
  server.registerTool(
    'xref_class_hierarchy',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description: 'Find the full class inheritance hierarchy — all subclasses (recursive) or the parent chain of a given class.',
      inputSchema: {
        class_name: z.string().min(1).max(500).describe('Class name (e.g. "SalesFormLetter", "FormLetterServiceController")'),
        direction: z.enum(['subclasses', 'parents']).default('subclasses')
          .describe('"subclasses" = who extends this (default), "parents" = what does this extend'),
        limit: z.number().int().min(1).max(1000).optional().default(200).describe('Max entries to return (default 200, max 1000). Framework base classes have thousands of subclasses.'),
        format: formatTextParam,
      },
      outputSchema: xrefClassHierarchyOutput.shape,
    },
    async ({ class_name, direction, limit, format }) => {
      const dir = direction || 'subclasses';
      // Defensive default - the test mock server bypasses Zod (contract rule #13).
      const lim = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 1000) : 200;
      const classPath = `/Classes/${class_name}`;
      const classResult = q('SELECT id FROM names WHERE path = ? LIMIT 1', [classPath]);
      if (classResult.length === 0) return notFoundResult('Class', class_name);
      const classId = classResult[0].id;
      const maxDepth = dir === 'subclasses' ? 10 : 20;

      let result;
      if (dir === 'subclasses') {
        result = q(`
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
      } else {
        result = q(`
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
      }

      const shownEntries = result.slice(0, lim);
      const typed = {
        class_name,
        direction: dir,
        max_depth: maxDepth,
        result_count: result.length,
        returned_count: shownEntries.length,
        truncated: result.length > shownEntries.length,
        entries: shownEntries.map(r => ({
          path: r.path, class_name: r.path.replace('/Classes/', ''), depth: num(r.depth) ?? 0,
        })),
      };
      if (!result.length) {
        return emptyResult(dir === 'subclasses' ? `subclasses of "${class_name}"` : `parents of "${class_name}"`, typed);
      }

      const heading = dir === 'subclasses' ? `## Subclasses of ${class_name}` : `## Inheritance chain for ${class_name}`;
      let out = `${heading}\n${typed.result_count} result(s)\n\n`;
      out += formatMarkdownTable(
        typed.entries.map(r => ({ Class: r.class_name, Depth: r.depth })),
        ['Class', 'Depth'],
      );
      if (typed.truncated) out += truncationNote('cap', typed.returned_count, 1000);
      return structuredResult(typed, out, format);
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Tool 5: xref_interface_implementors — "Who implements this interface?"
  // ─────────────────────────────────────────────────────────────────────────
  server.registerTool(
    'xref_interface_implementors',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description: 'Find all classes that implement a given interface, including indirect implementors through inheritance.',
      inputSchema: {
        interface_name: z.string().min(1).max(500).describe('Interface name (e.g. "SysRunnable", "SysPackable")'),
        limit: z.number().int().min(1).max(1000).optional().default(200).describe('Max implementors to return (default 200, max 1000). Framework interfaces have thousands.'),
        format: formatTextParam,
      },
      outputSchema: xrefInterfaceImplementorsOutput.shape,
    },
    async ({ interface_name, limit, format }) => {
      // Defensive default - the test mock server bypasses Zod (contract rule #13).
      const lim = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 1000) : 200;
      let targetId = null;
      let targetPath = null;
      for (const prefix of ['/Classes/', '/ClrType/']) {
        const rows = q('SELECT id, path FROM names WHERE path = ? LIMIT 1', [prefix + interface_name]);
        if (rows.length > 0) { targetId = rows[0].id; targetPath = rows[0].path; break; }
      }
      if (!targetId) return notFoundResult('Interface', interface_name);

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

      const shownImpl = result.slice(0, lim);
      const typed = {
        interface_name,
        interface_path: targetPath,
        result_count: result.length,
        returned_count: shownImpl.length,
        truncated: result.length > shownImpl.length,
        implementors: shownImpl.map(r => ({
          path: r.path,
          class_name: r.path.replace('/Classes/', ''),
          depth: num(r.depth) ?? 0,
          relationship: r.depth === 1 ? 'Direct' : `Inherited (depth ${r.depth})`,
        })),
      };
      if (!result.length) return emptyResult(`implementors of "${interface_name}"`, typed);

      let out = `## Implementors of ${interface_name}\n${typed.result_count} result(s)\n\n`;
      out += formatMarkdownTable(
        typed.implementors.map(r => ({ Class: r.class_name, Type: r.relationship })),
        ['Class', 'Type'],
      );
      if (typed.truncated) out += truncationNote('cap', typed.returned_count, 1000);
      return structuredResult(typed, out, format);
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Tool 6: xref_search_names — Search for objects by name pattern
  // ─────────────────────────────────────────────────────────────────────────
  server.registerTool(
    'xref_search_names',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description: 'Search for D365FO objects by name pattern in the cross-reference database. Use to discover objects when you only know part of the name. Scope with `modules` to search only specific models (e.g. only iExtension, an ISV model, or the Microsoft application — see xref_list_modules for the scanned build versions).',
      inputSchema: {
        pattern: z.string().min(1).max(500).describe('Search pattern (e.g. "SalesInvoice", "CustTrans"). Supports SQL LIKE wildcards (%).'),
        object_type: z.enum(['All', 'Classes', 'Tables', 'Forms', 'Enums', 'DataEntityViews', 'Edts', 'Views', 'Maps', 'Labels'])
          .default('All').describe('Filter by object type'),
        modules: modulesFilterParam,
        limit: z.number().int().min(1).max(500).default(50).describe('Max results (default 50, max 500)'),
        format: formatTextParam,
      },
      outputSchema: xrefSearchNamesOutput.shape,
    },
    async ({ pattern, object_type, modules, limit: rawLimit, format }) => {
      const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? rawLimit : 50;
      const objType = object_type || 'All';
      const moduleFilter = sanitizeModulesFilter(modules);
      const _v = validateLikePattern(pattern);
      if (_v) return patternErrorResult(_v);
      const likePattern = pattern.includes('%') ? pattern : `%${pattern}%`;
      let typeFilter = '';
      const params = [likePattern];
      if (objType !== 'All') { typeFilter = ` AND n.path LIKE ?`; params.push(`/${objType}/%`); }
      let moduleClause = '';
      if (moduleFilter.length) {
        moduleClause = ` AND m.module COLLATE NOCASE IN (${moduleFilter.map(() => '?').join(', ')})`;
        params.push(...moduleFilter);
      }
      params.push(limit);

      const result = q(`
        SELECT n.path, m.module
        FROM names n
        JOIN modules m ON n.module_id = m.id
        WHERE n.path LIKE ? ${typeFilter} ${moduleClause}
          AND n.path NOT LIKE '%/Methods/%'
          AND n.path NOT LIKE '%/Fields/%'
          AND n.path NOT LIKE '%/Controls/%'
          AND LENGTH(n.path) - LENGTH(REPLACE(n.path, '/', '')) <= 3
        ORDER BY n.path
        LIMIT ?
      `, params);

      const typed = {
        pattern,
        object_type: objType,
        modules: moduleFilter.length ? moduleFilter : null,
        limit,
        result_count: result.length,
        truncated: result.length >= limit,
        results: result.map(r => ({ path: r.path, module: r.module ?? null })),
      };
      if (!result.length) return emptyResult(`objects matching "${pattern}"`, typed, customLayerNote(pattern));

      let out = `## Objects matching "${pattern}"\n${typed.result_count} result(s)\n\n`;
      if (typed.modules) out += `_Scope: modules ${typed.modules.join(', ')}_\n\n`;
      out += formatMarkdownTable(
        typed.results.map(r => ({ Path: r.path, Module: r.module ?? '' })),
        ['Path', 'Module'],
      );
      if (typed.truncated) out += truncationNote('user', limit);
      return structuredResult(typed, out, format);
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Tool 7: xref_method_references — "What does this method call/use?"
  // ─────────────────────────────────────────────────────────────────────────
  server.registerTool(
    'xref_method_references',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description: 'Find all outgoing references from a specific method — what objects/methods/types does it call or use.',
      inputSchema: {
        object_name: z.string().min(1).max(500).describe('Class or table name'),
        method_name: z.string().min(1).max(500).describe('Method name'),
        kind: z.enum(['All', 'Call', 'Read']).default('All').describe('Filter: All, Call (method invocations only), Read (type/field reads only)'),
        limit: z.number().int().min(1).max(500).default(100).describe('Max results (default 100, max 500)'),
        format: formatTextParam,
      },
      outputSchema: xrefMethodReferencesOutput.shape,
    },
    async ({ object_name, method_name, kind, limit: rawLimit, format }) => {
      const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? rawLimit : 100;
      const kindFilterLabel = kind || 'All';
      const methodPaths = [
        `/Classes/${object_name}/Methods/${method_name}`,
        `/Tables/${object_name}/Methods/${method_name}`,
        `/Forms/${object_name}/Methods/${method_name}`,
      ];

      let sourceId = null;
      let sourcePath = null;
      for (const path of methodPaths) {
        const rows = q('SELECT id, path FROM names WHERE path = ? LIMIT 1', [path]);
        if (rows.length > 0) { sourceId = rows[0].id; sourcePath = rows[0].path; break; }
      }
      if (!sourceId) return notFoundResult('Method', `${object_name}.${method_name}`);

      let kindFilter = '';
      const params = [sourceId];
      if (kindFilterLabel === 'Call') kindFilter = ' AND r.kind = 1';
      else if (kindFilterLabel === 'Read') kindFilter = ' AND r.kind = 2';
      params.push(limit);

      const result = q(`
        SELECT n.path, r.kind, r.line, r.col
        FROM refs r
        JOIN names n ON r.target_id = n.id
        WHERE r.source_id = ? ${kindFilter}
        ORDER BY r.line, r.col
        LIMIT ?
      `, params);

      const typed = {
        source_path: sourcePath,
        owner_name: object_name,
        method_name,
        kind_filter: kindFilterLabel,
        limit,
        result_count: result.length,
        truncated: result.length >= limit,
        references: result.map(r => ({ path: r.path, kind: kindName(r.kind), line: num(r.line), col: num(r.col) })),
      };
      if (!result.length) return emptyResult(`outgoing references from "${sourcePath}"`, typed);

      let out = `## Outgoing references from ${sourcePath}\n${typed.result_count} result(s)\n\n`;
      out += formatMarkdownTable(
        typed.references.map(r => ({ Target: r.path, Kind: r.kind, Line: r.line ?? '', Col: r.col ?? '' })),
        ['Target', 'Kind', 'Line', 'Col'],
      );
      if (typed.truncated) out += truncationNote('user', limit);
      return structuredResult(typed, out, format);
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Tool 8: xref_module_objects — Objects in a module
  // ─────────────────────────────────────────────────────────────────────────
  server.registerTool(
    'xref_module_objects',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description: 'List all top-level objects (classes, tables, forms, etc.) in a given D365FO module from the cross-reference database.',
      inputSchema: {
        module_name: z.string().min(1).max(500).describe('Module name (e.g. "ApplicationSuite", "EngineeringChangeManagement")'),
        object_type: z.enum(['All', 'Classes', 'Tables', 'Forms', 'Enums', 'DataEntityViews', 'Edts', 'Views'])
          .default('All').describe('Filter by object type'),
        limit: z.number().int().min(1).max(500).default(200).describe('Max results (default 200, max 500)'),
        format: formatTextParam,
      },
      outputSchema: xrefModuleObjectsOutput.shape,
    },
    async ({ module_name, object_type, limit: rawLimit, format }) => {
      const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? rawLimit : 200;
      const objType = object_type || 'All';
      let typeFilter = '';
      const params = [module_name];
      if (objType !== 'All') { typeFilter = ` AND n.path LIKE ?`; params.push(`/${objType}/%`); }
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

      const typed = {
        module_name,
        object_type: objType,
        limit,
        result_count: result.length,
        truncated: result.length >= limit,
        objects: result.map(r => ({ path: r.path, provider: r.provider ?? null })),
      };
      if (!result.length) return emptyResult(`objects in module "${module_name}"`, typed);

      let out = `## Objects in ${module_name}\n${typed.result_count} result(s)\n\n`;
      out += formatMarkdownTable(
        typed.objects.map(r => ({ Path: r.path, Provider: r.provider ?? '' })),
        ['Path', 'Provider'],
      );
      if (typed.truncated) out += truncationNote('user', limit);
      return structuredResult(typed, out, format);
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Tool 9: xref_cross_module_deps — Cross-module dependency analysis
  // ─────────────────────────────────────────────────────────────────────────
  server.registerTool(
    'xref_cross_module_deps',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description: 'Analyze cross-module dependencies: which modules does a given module depend on (or which modules depend on it).',
      inputSchema: {
        module_name: z.string().min(1).max(500).describe('Module name'),
        direction: z.enum(['depends_on', 'depended_by']).default('depends_on')
          .describe('"depends_on" = modules this module references, "depended_by" = modules that reference this one'),
        limit: z.number().int().min(1).max(500).default(50).describe('Max results (default 50, max 500)'),
        format: formatTextParam,
      },
      outputSchema: xrefCrossModuleDepsOutput.shape,
    },
    async ({ module_name, direction, limit: rawLimit, format }) => {
      const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? rawLimit : 50;
      const dir = direction || 'depends_on';
      const params = [module_name, module_name, limit];
      const sql = dir === 'depends_on'
        ? `
          SELECT tm.module, COUNT(*) as ref_count
          FROM refs r
          JOIN names sn ON r.source_id = sn.id
          JOIN names tn ON r.target_id = tn.id
          JOIN modules sm ON sn.module_id = sm.id
          JOIN modules tm ON tn.module_id = tm.id
          WHERE sm.module = ? AND tm.module != ?
          GROUP BY tm.module
          ORDER BY ref_count DESC
          LIMIT ?`
        : `
          SELECT sm.module, COUNT(*) as ref_count
          FROM refs r
          JOIN names sn ON r.source_id = sn.id
          JOIN names tn ON r.target_id = tn.id
          JOIN modules sm ON sn.module_id = sm.id
          JOIN modules tm ON tn.module_id = tm.id
          WHERE tm.module = ? AND sm.module != ?
          GROUP BY sm.module
          ORDER BY ref_count DESC
          LIMIT ?`;

      const result = q(sql, params);
      const typed = {
        module_name,
        direction: dir,
        limit,
        result_count: result.length,
        truncated: result.length >= limit,
        modules: result.map(r => ({ module: r.module, ref_count: num(r.ref_count) ?? 0 })),
      };
      if (!result.length) return emptyResult(`cross-module dependencies for "${module_name}"`, typed);

      const dirLabel = dir === 'depends_on' ? 'depends on' : 'is depended on by';
      let out = `## ${module_name} ${dirLabel}\n${typed.result_count} module(s)\n\n`;
      out += formatMarkdownTable(
        typed.modules.map(r => ({ Module: r.module, 'Reference Count': r.ref_count })),
        ['Module', 'Reference Count'],
      );
      if (typed.truncated) out += truncationNote('user', limit);
      return structuredResult(typed, out, format);
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Tool 10: xref_raw_sql — Ad-hoc read-only SQL
  // ─────────────────────────────────────────────────────────────────────────
  server.registerTool(
    'xref_raw_sql',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description: 'Execute a read-only SQL query against the XRef SQLite database. Schema: names(id,path,provider_id,module_id), refs(source_id,target_id,kind,line,col), modules(id,module), providers(id,provider).',
      inputSchema: {
        sql: z.string().min(1).max(50000).describe('SQL SELECT query (no schema prefix needed — use table names directly)'),
        limit: z.number().int().min(1).max(500).default(100).describe('Max rows (default 100, max 500)'),
        // The SHARED param (rule #5): a private z.enum(['markdown','toon'])
        // .default('toon') here pinned TOON and defeated the adaptive default.
        format: formatTextParam,
      },
      outputSchema: rawSqlOutput.shape,
    },
    async ({ sql: userSql, limit: rawLimit, format }) => {
      const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? rawLimit : 100;
      const trimmed = userSql.trim().replace(/;+$/, '');
      if (!/^\s*(SELECT|WITH|PRAGMA)\b/i.test(trimmed)) {
        return errorResult('invalid-input', 'Only SELECT, WITH, and PRAGMA queries are allowed.');
      }

      const forbidden = ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'CREATE', 'TRUNCATE', 'ATTACH', 'DETACH'];
      for (const kw of forbidden) {
        if (new RegExp(`\\b${kw}\\b`, 'i').test(trimmed)) {
          return errorResult('invalid-input', `Forbidden keyword "${kw}" detected. Only read-only queries are allowed.`);
        }
      }

      let finalSql = trimmed;
      if (!/\bLIMIT\b/i.test(finalSql)) finalSql += ` LIMIT ${limit}`;

      try {
        const result = runWithBudget('xref_raw_sql', () => q(finalSql));
        if (!result || result.length === 0) {
          return emptyResult('rows matching your query', { row_count: 0, truncated: false, columns: [], rows: [] });
        }
        const columns = Object.keys(result[0]);
        const truncated = result.length >= limit;
        const typed = { row_count: result.length, truncated, columns, rows: result };
        // structuredResult picks the smaller channel unless the caller pinned
        // one; `format` goes through untouched — rule #5.
        let md = formatMarkdownTable(result);
        if (truncated) md += truncationNote('user', limit);
        return structuredResult(typed, md, format);
      } catch (err) {
        if (err instanceof QueryBudgetExceededError) return timeoutErrorResult(err);
        return errorResult('db-error', 'Check your SQL syntax and table/column names. Only read-only SELECT queries are supported.', err);
      }
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Tool 11: xref_impact_analysis — Impact analysis for changes
  // ─────────────────────────────────────────────────────────────────────────
  server.registerTool(
    'xref_impact_analysis',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description: 'Analyze the impact of changing a D365FO object: find all direct dependents grouped by type and module. Essential before modifying shared classes, tables, or methods. Performs single-level (direct) impact analysis.',
      inputSchema: {
        object_name: z.string().min(1).max(500).describe('Object name or path'),
        limit: z.number().int().min(1).max(500).optional().default(100).describe('Max dependent objects listed (default 100, max 500). The by_kind / by_module counts always cover the full result set.'),
        format: formatTextParam,
      },
      outputSchema: xrefImpactAnalysisOutput.shape,
    },
    async ({ object_name, limit, format }) => {
      const _v = validateLikePattern(object_name);
      if (_v) return patternErrorResult(_v);
      const resolved = resolveNameId(q, object_name);
      if (!resolved) return notFoundResult('Object', object_name);
      const { id: targetId, path: targetPath } = resolved;

      const DETAIL_CAP = 500;
      // Defensive default - the test mock server bypasses Zod (contract rule #13).
      const SAMPLE_CAP = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 500) : 100;
      const subPaths = q('SELECT id FROM names WHERE path LIKE ? LIMIT 500', [targetPath + '/%']);
      const allTargetIds = [targetId, ...subPaths.map(r => r.id)];
      const { clause: inClause, params: inParams } = buildInClause(allTargetIds);

      const result = q(`
        SELECT DISTINCT n.path, r.kind, m.module
        FROM refs r
        JOIN names n ON r.source_id = n.id
        JOIN modules m ON n.module_id = m.id
        WHERE r.target_id IN (${inClause})
        ORDER BY m.module, n.path
        LIMIT ${DETAIL_CAP}
      `, inParams);

      const byKind = {};
      const byModule = {};
      for (const row of result) {
        const kn = kindName(row.kind);
        byKind[kn] = (byKind[kn] || 0) + 1;
        byModule[row.module] = (byModule[row.module] || 0) + 1;
      }

      const typed = {
        target_path: targetPath,
        total_refs: result.length,
        sample_cap: SAMPLE_CAP,
        detail_cap: DETAIL_CAP,
        sample_truncated: result.length > SAMPLE_CAP,
        by_kind: byKind,
        by_module: byModule,
        referencing_objects: result.slice(0, SAMPLE_CAP).map(r => ({
          source: r.path, kind: kindName(r.kind), module: r.module ?? null,
        })),
      };
      if (!result.length) return emptyResult(`dependents of "${targetPath}"`, typed);

      let out = `## Impact analysis for ${targetPath}\nTotal references: ${typed.total_refs}\n\n`;
      out += `## By reference kind\n`;
      for (const [k, cnt] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) out += `- ${k}: ${cnt}\n`;
      out += `\n## By module (top 15)\n`;
      for (const [mod, cnt] of Object.entries(byModule).sort((a, b) => b[1] - a[1]).slice(0, 15)) out += `- ${mod}: ${cnt}\n`;
      out += `\n## Referencing objects\n`;
      out += formatMarkdownTable(
        typed.referencing_objects.map(r => ({ Source: r.source, Kind: r.kind, Module: r.module ?? '' })),
        ['Source', 'Kind', 'Module'],
      );
      if (typed.sample_truncated) out += truncationNote('cap', SAMPLE_CAP, DETAIL_CAP);
      return structuredResult(typed, out, format);
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Tool 12: xref_list_modules — List all modules
  // ─────────────────────────────────────────────────────────────────────────
  server.registerTool(
    'xref_list_modules',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description: 'List D365FO modules in the XRef database with object counts and the build version each was scanned from (Descriptor XML provenance: version, layer, origin microsoft/isv/custom, publisher - null when the XRef build had no metadata roots configured). Filter with `origin` / `layer` / `publisher` to see only the customisation surface.',
      inputSchema: {
        origin: z.enum(['microsoft', 'isv', 'custom']).optional().describe('Only models with this build origin. Use "custom" / "isv" for the customisation surface.'),
        layer: z.string().min(1).max(20).optional().describe('Only models on this layer (SYS, SLN, ISV, VAR, USR)'),
        publisher: z.string().min(1).max(200).optional().describe('Only models whose publisher contains this text (case-insensitive)'),
        limit: z.number().int().min(1).max(500).optional().default(200).describe('Max modules to return (default 200, max 500)'),
        format: formatTextParam,
      },
      outputSchema: xrefListModulesOutput.shape,
    },
    async ({ origin, layer, publisher, limit, format }) => {
      // Defensive defaults - the test mock server bypasses Zod (contract rule #13).
      const lim = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 500) : 200;
      const originF = typeof origin === 'string' && origin.trim() ? origin.trim().toLowerCase() : null;
      const layerF = typeof layer === 'string' && layer.trim() ? layer.trim().toLowerCase() : null;
      const publisherF = typeof publisher === 'string' && publisher.trim() ? publisher.trim().toLowerCase() : null;
      const filtered = Boolean(originF || layerF || publisherF);
      const result = q(`
        SELECT m.module, COUNT(DISTINCT n.id) as object_count
        FROM modules m
        LEFT JOIN names n ON n.module_id = m.id
        GROUP BY m.module
        ORDER BY object_count DESC
      `);

      // Build provenance per package: a package can hold several models,
      // so distinct values are joined with ', '.
      const byModule = new Map();
      for (const v of queryModelVersions(q)) {
        const key = (v.module_id ?? '').toLowerCase();
        if (!byModule.has(key)) byModule.set(key, []);
        byModule.get(key).push(v);
      }
      const provenance = (moduleName, field) => {
        const vals = [...new Set(
          (byModule.get(moduleName.toLowerCase()) || []).map(r => r[field]).filter(Boolean),
        )];
        return vals.length ? vals.join(', ') : null;
      };

      // A package matches when ANY of its models does - filtering the joined
      // provenance string would drop mixed-origin packages.
      const matchesFilter = (moduleName) => {
        if (!filtered) return true;
        const rows = byModule.get(String(moduleName).toLowerCase()) || [];
        return rows.some(r =>
          (!originF || String(r.origin ?? '').toLowerCase() === originF)
          && (!layerF || String(r.layer ?? '').toLowerCase() === layerF)
          && (!publisherF || String(r.publisher ?? '').toLowerCase().includes(publisherF)));
      };
      const matched = result.filter(r => matchesFilter(r.module));
      const shown = matched.slice(0, lim);

      const typed = {
        module_count: matched.length,
        returned_count: shown.length,
        modules: shown.map(r => ({
          module: r.module,
          object_count: num(r.object_count) ?? 0,
          version: provenance(r.module, 'version'),
          origin: provenance(r.module, 'origin'),
          publisher: provenance(r.module, 'publisher'),
          layer: provenance(r.module, 'layer'),
        })),
      };
      const filterDesc = [
        originF ? `origin=${originF}` : null,
        layerF ? `layer=${layerF}` : null,
        publisherF ? `publisher~${publisherF}` : null,
      ].filter(Boolean).join(', ');
      if (!matched.length) {
        return emptyResult(filterDesc ? `modules matching ${filterDesc}` : 'modules in the XRef database', typed);
      }

      let out = `## XRef Modules (${typed.module_count}${filterDesc ? ` matching ${filterDesc}` : ' total'})\n\n`;
      out += formatMarkdownTable(
        typed.modules.map(r => ({
          Module: r.module,
          Version: r.version ?? '',
          Origin: r.origin ?? '',
          Layer: r.layer ?? '',
          'Object Count': r.object_count,
        })),
        ['Module', 'Version', 'Origin', 'Layer', 'Object Count'],
      );
      if (typed.module_count > typed.returned_count) {
        out += truncationNote('cap', typed.returned_count, 500);
      }
      return structuredResult(typed, out, format);
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Tool 13: xref_object_summary — Summary of an object's references
  // ─────────────────────────────────────────────────────────────────────────
  server.registerTool(
    'xref_object_summary',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description: "Get a compact summary of an object: incoming vs outgoing reference counts by kind, methods, sub-objects, and module. This is the recommended first call before drilling into an object — pass `object_names` to summarise up to 10 objects in one call instead of one call each.",
      inputSchema: {
        object_name: z.string().min(1).max(500).optional().describe('Object name or path. Use this or `object_names`.'),
        object_names: z.array(z.string().min(1).max(500)).min(1).max(SUMMARY_BATCH_MAX).optional()
          .describe(`Summarise several objects in one call (max ${SUMMARY_BATCH_MAX}). Names that cannot be resolved come back in \`not_found\` rather than failing the call.`),
        format: formatTextParam,
      },
      outputSchema: xrefObjectSummaryOutput.shape,
    },
    async ({ object_name, object_names, format }) => {
      // Singular and plural are unioned, deduped, and the caller's order kept.
      const requested = [...new Set([
        ...(Array.isArray(object_names) ? object_names : []),
        ...(object_name ? [object_name] : []),
      ].map(n => String(n ?? '').trim()).filter(Boolean))];

      if (!requested.length) {
        return errorResult('invalid-input', 'Provide `object_name` or `object_names`.');
      }
      // Defensive cap: Zod's .max() is bypassed by the test mock server (rule #13).
      const names = requested.slice(0, SUMMARY_BATCH_MAX);
      const batchMode = Array.isArray(object_names) && object_names.length > 0;

      for (const n of names) {
        const _v = validateLikePattern(n);
        if (_v) return patternErrorResult(_v);
      }

      /** Summarise one object, or null when the name cannot be resolved. */
      const summarise = (name) => {
        const resolved = resolveNameId(q, name);
        if (!resolved) return null;
        const { id: objId, path: objPath } = resolved;

        const modResult = q('SELECT m.module FROM names n JOIN modules m ON n.module_id = m.id WHERE n.id = ?', [objId]);
        const moduleName = modResult[0]?.module || null;

        const subObjects = q('SELECT id, path FROM names WHERE path LIKE ? ORDER BY path LIMIT 200', [objPath + '/%']);
        const allIds = [objId, ...subObjects.map(r => r.id)];
        const { clause: inClause, params: inParams } = buildInClause(allIds);
        const incoming = q(`SELECT kind, COUNT(*) as cnt FROM refs WHERE target_id IN (${inClause}) GROUP BY kind ORDER BY cnt DESC`, inParams);
        const { clause: inClause2, params: inParams2 } = buildInClause(allIds);
        const outgoing = q(`SELECT kind, COUNT(*) as cnt FROM refs WHERE source_id IN (${inClause2}) GROUP BY kind ORDER BY cnt DESC`, inParams2);

        const methods = subObjects
          .filter(r => r.path.includes('/Methods/'))
          .map(r => r.path.split('/Methods/')[1]);
        const incomingByKind = incoming.map(r => ({ kind: kindName(r.kind), count: num(r.cnt) ?? 0 }));
        const outgoingByKind = outgoing.map(r => ({ kind: kindName(r.kind), count: num(r.cnt) ?? 0 }));

        return {
          object_path: objPath,
          module: moduleName,
          sub_object_count: subObjects.length,
          methods,
          incoming_total: incomingByKind.reduce((s, r) => s + r.count, 0),
          outgoing_total: outgoingByKind.reduce((s, r) => s + r.count, 0),
          incoming_by_kind: incomingByKind,
          outgoing_by_kind: outgoingByKind,
        };
      };

      // Single mode keeps its H2 sections; batch mode demotes them so the whole
      // response still has exactly one H2 (contract rule #3).
      const renderOne = (p, h) => {
        let s = `${h} Object summary: ${p.object_path}\n`;
        s += `Module: ${p.module ?? '-'} • Sub-objects: ${p.sub_object_count}\n\n`;
        if (p.methods.length > 0) s += `${h}# Methods (${p.methods.length})\n${p.methods.join(', ')}\n\n`;
        s += `${h}# Incoming references (used by) — total ${p.incoming_total}\n`;
        for (const r of p.incoming_by_kind) s += `- ${r.kind}: ${r.count}\n`;
        s += `\n${h}# Outgoing references (uses) — total ${p.outgoing_total}\n`;
        for (const r of p.outgoing_by_kind) s += `- ${r.kind}: ${r.count}\n`;
        return s;
      };

      if (!batchMode) {
        const p = summarise(names[0]);
        if (!p) return notFoundResult('Object', names[0]);
        // Exactly the pre-batching payload — no batch keys.
        return structuredResult(p, renderOne(p, '##'), format);
      }

      const objects = [];
      const notFound = [];
      for (const n of names) {
        const p = summarise(n);
        if (p) objects.push(p);
        else notFound.push(n);
      }

      // Batch mode carries only batch keys — see the enum handler for why the
      // single-target fields are omitted rather than nulled.
      const typed = {
        requested_count: names.length,
        not_found: notFound,
        objects,
      };

      let out = `## Object summaries (${objects.length} of ${names.length})\n\n`;
      for (const p of objects) out += renderOne(p, '###') + '\n';
      if (notFound.length) out += `**Not found:** ${notFound.join(', ')}\n`;

      return structuredResult(typed, out, format);
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Tool 14: xref_find_extensions — CoC / extension classes
  // ─────────────────────────────────────────────────────────────────────────
  server.registerTool(
    'xref_find_extensions',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description: 'Find all Chain of Command (CoC) extension classes and table/form extensions for a D365FO object. Shows [ExtensionOf] classes that wrap the target with CoC methods using "next". Finds extensions by naming convention. Results may include false positives for common name prefixes.',
      inputSchema: {
        object_name: z.string().min(1).max(500).describe('Object name (e.g. "SalesTable", "CustTable", "SalesFormLetter")'),
        object_type: z.enum(['All', 'Classes', 'Tables', 'Forms', 'DataEntityViews']).default('All')
          .describe('Object type to search for extensions. Default: All'),
        limit: z.number().int().min(1).max(500).default(100).describe('Max results (default 100, max 500)'),
        format: formatTextParam,
      },
      outputSchema: xrefFindExtensionsOutput.shape,
    },
    async ({ object_name, object_type, limit: rawLimit, format }) => {
      const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? rawLimit : 100;
      const objType = object_type || 'All';
      const _v = validateLikePattern(object_name);
      if (_v) return patternErrorResult(_v);

      const patterns = [];
      if (objType === 'All' || objType === 'Classes') {
        patterns.push(`/Classes/${object_name}%_Extension`, `/Classes/${object_name}%Extension`);
      }
      if (objType === 'All' || objType === 'Tables') {
        patterns.push(`/Classes/${object_name}%_Extension`, `/Tables/${object_name}.Extension%`);
      }
      if (objType === 'All' || objType === 'Forms') {
        patterns.push(`/Classes/${object_name}Form%_Extension`, `/Forms/${object_name}.Extension%`);
      }
      if (objType === 'All' || objType === 'DataEntityViews') {
        patterns.push(`/DataEntityViews/${object_name}.Extension%`);
      }
      const uniquePatterns = [...new Set(patterns)];
      const likeClauses = uniquePatterns.map(() => 'n.path LIKE ?').join(' OR ');
      const params = [...uniquePatterns, limit];

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

      const cocClasses = [], tableExtensions = [], formExtensions = [], entityExtensions = [], other = [];
      for (const row of result) {
        const entry = { path: row.path.startsWith('/Classes/') ? row.path.replace('/Classes/', '') : row.path, module: row.module ?? null };
        if (row.path.startsWith('/Classes/')) cocClasses.push(entry);
        else if (row.path.startsWith('/Tables/') && row.path.includes('.Extension')) tableExtensions.push(entry);
        else if (row.path.startsWith('/Forms/') && row.path.includes('.Extension')) formExtensions.push(entry);
        else if (row.path.startsWith('/DataEntityViews/') && row.path.includes('.Extension')) entityExtensions.push(entry);
        else other.push(entry);
      }

      const typed = {
        object_name,
        object_type: objType,
        limit,
        total_count: result.length,
        truncated: result.length >= limit,
        coc_classes: cocClasses,
        table_extensions: tableExtensions,
        form_extensions: formExtensions,
        entity_extensions: entityExtensions,
        other,
      };
      if (!result.length) return emptyResult(`extensions for "${object_name}"`, typed, customLayerNote(object_name));

      let out = `## Extensions for ${object_name}\nTotal: ${typed.total_count}\n\n`;
      const section = (title, rows, cols) => {
        if (!rows.length) return '';
        return `## ${title} (${rows.length})\n` + formatMarkdownTable(rows.map(r => cols === 'class'
          ? ({ Class: r.path, Module: r.module ?? '' })
          : ({ Path: r.path, Module: r.module ?? '' })), cols === 'class' ? ['Class', 'Module'] : ['Path', 'Module']) + '\n\n';
      };
      out += section('CoC / [ExtensionOf] classes', cocClasses, 'class');
      out += section('Table extensions', tableExtensions, 'path');
      out += section('Form extensions', formExtensions, 'path');
      out += section('Entity extensions', entityExtensions, 'path');
      out += section('Other', other, 'path');
      if (typed.truncated) out += truncationNote('user', limit);
      return structuredResult(typed, out, format);
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Tool 15: xref_find_field_usages — "Who reads/writes this field?"
  // ─────────────────────────────────────────────────────────────────────────
  server.registerTool(
    'xref_find_field_usages',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description: 'Find all code locations that read or write a specific field on a D365FO table. Returns callers with line numbers, grouped by kind (Read vs Call/Write).',
      inputSchema: {
        table_name: z.string().min(1).max(500).describe('Table name (e.g. "CustTable", "SalesTable")'),
        field_name: z.string().min(1).max(500).describe('Field name (e.g. "AccountNum", "InvoiceId")'),
        kind: z.enum(['All', 'Read', 'Write']).default('All')
          .describe('Filter: All, Read (field value reads), Write (field assignments). Default: All'),
        limit: z.number().int().min(1).max(500).default(100).describe('Max results (default 100, max 500)'),
        format: formatTextParam,
      },
      outputSchema: xrefFindFieldUsagesOutput.shape,
    },
    async ({ table_name, field_name, kind, limit: rawLimit, format }) => {
      const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? rawLimit : 100;
      const kindFilterLabel = kind || 'All';
      const _vt = validateLikePattern(table_name);
      if (_vt) return patternErrorResult(_vt);
      const _vf = validateLikePattern(field_name);
      if (_vf) return patternErrorResult(_vf);

      const fieldPath = `/Tables/${table_name}/Fields/${field_name}`;
      const fieldResult = q('SELECT id FROM names WHERE path = ? LIMIT 1', [fieldPath]);
      if (fieldResult.length === 0) {
        const fuzzy = q('SELECT path FROM names WHERE path LIKE ? AND path LIKE ? LIMIT 10', [`%${table_name}%`, `%${field_name}%`]);
        return notFoundResult('Field', `${table_name}.${field_name}`, fuzzy.map(r => r.path));
      }

      const fieldId = fieldResult[0].id;
      let kindFilter = '';
      const params = [fieldId];
      if (kindFilterLabel === 'Read') kindFilter = ' AND r.kind = 2';
      else if (kindFilterLabel === 'Write') kindFilter = ' AND r.kind = 1';
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

      const toRow = r => ({ source: r.source, kind: kindName(r.kind), line: num(r.line), col: num(r.col), module: r.module ?? null });
      const typed = {
        table_name,
        field_name,
        kind_filter: kindFilterLabel,
        limit,
        result_count: result.length,
        truncated: result.length >= limit,
        reads: result.filter(r => r.kind === 2).map(toRow),
        calls: result.filter(r => r.kind === 1).map(toRow),
        other: result.filter(r => r.kind !== 1 && r.kind !== 2).map(toRow),
      };
      if (!result.length) return emptyResult(`usages of field "${table_name}.${field_name}"`, typed);

      let out = `## Field usages: ${table_name}.${field_name}\n${typed.result_count} result(s)\n\n`;
      const section = (title, rows) => {
        if (!rows.length) return '';
        return `## ${title} (${rows.length})\n` + formatMarkdownTable(
          rows.map(r => ({ Source: r.source, Kind: r.kind, Line: r.line ?? '', Col: r.col ?? '', Module: r.module ?? '' })),
          ['Source', 'Kind', 'Line', 'Col', 'Module'],
        ) + '\n\n';
      };
      out += section('Reads', typed.reads);
      out += section('Writes / Calls', typed.calls);
      out += section('Other references', typed.other);
      if (typed.truncated) out += truncationNote('user', limit);
      return structuredResult(typed, out, format);
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Tool 16: xref_find_event_handlers — event handlers & delegates
  // ─────────────────────────────────────────────────────────────────────────
  server.registerTool(
    'xref_find_event_handlers',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description: 'Find all event handlers and delegates for a D365FO object or method. Discovers [SubscribesTo], [DataEventHandler], [PreHandlerFor], [PostHandlerFor] subscriptions, and delegate definitions.',
      inputSchema: {
        object_name: z.string().min(1).max(500).describe('Class or table name (e.g. "SalesFormLetter", "CustTable")'),
        method_name: z.string().min(1).max(500).optional().describe('Optional: specific method/delegate name to find handlers for'),
        limit: z.number().int().min(1).max(500).default(100).describe('Max results (default 100, max 500)'),
        format: formatTextParam,
      },
      outputSchema: xrefFindEventHandlersOutput.shape,
    },
    async ({ object_name, method_name, limit: rawLimit, format }) => {
      const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? rawLimit : 100;
      const _v = validateLikePattern(object_name);
      if (_v) return patternErrorResult(_v);
      const _vm = validateLikePattern(method_name);
      if (_vm) return patternErrorResult(_vm);

      const resolved = resolveNameId(q, object_name);
      const objPath = resolved ? resolved.path : null;

      const delegateMethods = resolved ? q(`
        SELECT DISTINCT n.path
        FROM names n
        JOIN refs r ON r.source_id = n.id
        WHERE n.path LIKE ? AND r.kind = 6
        LIMIT ?
      `, [resolved.path + '/Methods/%', limit]).map(r => r.path.split('/Methods/')[1] || r.path) : [];

      const subscriberRows = q(`
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
            SELECT 1 FROM refs r2 JOIN names t2 ON r2.target_id = t2.id
            WHERE r2.source_id = n.id AND t2.path LIKE ?
          )
        ORDER BY n.path
        LIMIT ?
      `, [`%${object_name}%`, limit]);

      const dataEventRows = q(`
        SELECT DISTINCT n.path, m.module
        FROM names n
        JOIN modules m ON n.module_id = m.id
        JOIN refs r ON r.source_id = n.id
        JOIN names attr ON r.target_id = attr.id
        WHERE r.kind = 7
          AND attr.path = '/Classes/DataEventHandlerAttribute'
          AND n.path LIKE '/Classes/%/Methods/%'
          AND EXISTS (
            SELECT 1 FROM refs r2 JOIN names t2 ON r2.target_id = t2.id
            WHERE r2.source_id = n.id AND (t2.path = ? OR t2.path LIKE ?)
          )
        ORDER BY n.path
        LIMIT ?
      `, ['/Tables/' + object_name, '/Tables/' + object_name + '/%', limit]);

      const overrideRows = resolved ? q(`
        SELECT DISTINCT n.path, m.module
        FROM refs r
        JOIN names n ON r.source_id = n.id
        JOIN modules m ON n.module_id = m.id
        WHERE r.kind = 10
          AND r.target_id IN (SELECT id FROM names WHERE path LIKE ?)
        ORDER BY n.path
        LIMIT ?
      `, [resolved.path + '/Methods/%', limit]) : [];

      const mapHandler = r => ({ path: r.path, module: r.module ?? null });
      const typed = {
        object_name,
        method_name: method_name ?? null,
        object_path: objPath,
        limit,
        delegate_methods: delegateMethods,
        subscribers: subscriberRows.map(mapHandler),
        data_event_handlers: dataEventRows.map(mapHandler),
        overrides: overrideRows.map(mapHandler),
        subscribers_truncated: subscriberRows.length >= limit,
        data_event_handlers_truncated: dataEventRows.length >= limit,
        overrides_truncated: overrideRows.length >= limit,
      };

      const nothing = !delegateMethods.length && !subscriberRows.length && !dataEventRows.length && !overrideRows.length;
      if (nothing) {
        return emptyResult(`event handlers or delegates for "${object_name}"${method_name ? '.' + method_name : ''}`, typed);
      }

      let out = `## Event handlers for ${object_name}${method_name ? '.' + method_name : ''}\n\n`;
      if (delegateMethods.length) {
        out += `## Delegates defined on ${objPath}\n` + formatMarkdownTable(
          delegateMethods.map(m => ({ 'Delegate Method': m })), ['Delegate Method']) + '\n\n';
      }
      if (subscriberRows.length) {
        out += `## Event handlers subscribing (${subscriberRows.length})\n` + formatMarkdownTable(
          typed.subscribers.map(r => ({ 'Handler Method': r.path, Module: r.module ?? '' })), ['Handler Method', 'Module']);
        if (typed.subscribers_truncated) out += truncationNote('user', limit);
        out += '\n\n';
      }
      if (dataEventRows.length) {
        out += `## Data event handlers (${dataEventRows.length})\n` + formatMarkdownTable(
          typed.data_event_handlers.map(r => ({ 'Handler Method': r.path, Module: r.module ?? '' })), ['Handler Method', 'Module']);
        if (typed.data_event_handlers_truncated) out += truncationNote('user', limit);
        out += '\n\n';
      }
      if (overrideRows.length) {
        out += `## Method overrides (${overrideRows.length})\n` + formatMarkdownTable(
          typed.overrides.map(r => ({ Override: r.path, Module: r.module ?? '' })), ['Override', 'Module']);
        if (typed.overrides_truncated) out += truncationNote('user', limit);
      }
      return structuredResult(typed, out, format);
    },
  );
}
