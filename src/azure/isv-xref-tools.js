/**
 * Sealed-ISV XRef tools (issues #75, #77, #82).
 *
 * The XRef SQL source carries no rows for binary-only ISV models. Measured on
 * the reference dev box: `Lasernet` has **0** outbound references in the XRef
 * database and 334 inbound ones — the 153 `Lasernet` names that exist are there
 * only because Microsoft code points at them. Six sealed models are absent
 * entirely. The ISVs' own `.xref` packages hold 199,392 reference lines that
 * never reached `DYNAMICSXREFDB`.
 *
 * These tools query those lines from the separate `isv_names` / `isv_refs`
 * tables. The main `names` / `refs` tables are never read or written here, so
 * every existing XRef answer is unchanged.
 */

import { z } from 'zod';
import {
  query,
  formatMarkdownTable,
  structuredResult,
  emptyResult,
  errorResult,
  truncationNote,
  formatTextParam,
  validateLikePattern,
  patternErrorResult,
  READ_ONLY_DB_ANNOTATIONS,
} from './shared.js';
import {
  hasIsvData,
  isvProvenance,
  isvProvenanceNote,
  noIsvDataProvenance,
} from './isv-schema.js';
import { xrefIsvFindUsagesOutput } from './output-schemas.js';

/** Non-overridable ceiling: a broad target can match tens of thousands of rows. */
const USAGE_HARD_MAX = 1000;

export function registerIsvXrefTools(server, db) {
  const q = (sql, params = []) => query(db, sql, params);

  server.registerTool(
    'xref_isv_find_usages',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description: 'Where sealed (binary-only) ISV models reference a standard D365FO object — cross-references the main XRef database lacks for every model without X++ source. Use with xref_find_usages before changing or deprecating an object: the main tool cannot see ISV callers.',
      inputSchema: {
        object_name: z.string().min(1).max(500).describe('Object to find ISV references to, e.g. "CustTable", "SalesFormLetter". Matched against the reference target path.'),
        object_type: z.enum(['Tables', 'Classes', 'Forms', 'Enums', 'Edts', 'Queries', 'Views', 'any'])
          .optional().default('any')
          .describe('Restrict to one AOT path segment. "any" matches the name wherever it appears as a target.'),
        modules: z.array(z.string().min(1).max(100)).max(20).optional().describe('Restrict to specific sealed ISV models.'),
        kind: z.string().min(1).max(50).optional().describe('Reference kind: TypeReference, MethodCall, Attribute, ClassExtended, MethodOverride, Property.'),
        limit: z.number().int().min(1).max(USAGE_HARD_MAX).optional().default(100).describe(`Max usage rows returned. The module summary always covers every match.`),
        format: formatTextParam,
      },
      outputSchema: xrefIsvFindUsagesOutput.shape,
    },
    async ({ object_name, object_type, modules, kind, limit, format }) => {
      const name = String(object_name ?? '').trim();
      if (!name) return errorResult('invalid-input', 'Provide an object name.');

      // Defensive defaults: the test mock server bypasses Zod (contract item 13).
      const cap = Number.isInteger(limit) && limit > 0 && limit <= USAGE_HARD_MAX ? limit : 100;
      const type = typeof object_type === 'string' && object_type ? object_type : 'any';

      // The name goes into a LIKE pattern, so it is length-gated like every
      // other wildcard input in the XRef service.
      const patternCheck = validateLikePattern(name);
      if (patternCheck) return patternErrorResult(patternCheck);

      if (!hasIsvData(db)) {
        return emptyResult(`sealed ISV references to "${name}"`, {
          isv_data_available: false,
          object_name: name,
          usage_count: 0,
          module_summary: [],
          usages: [],
          truncated: false,
          provenance: noIsvDataProvenance(),
        });
      }

      // Target paths look like /Tables/CustTable or /Tables/CustTable/Fields/X,
      // so an exact match plus a child match covers both the object and its
      // members without also matching CustTableExtended.
      const where = [];
      const params = [];
      if (type === 'any') {
        where.push("(r.target_path LIKE ? COLLATE NOCASE OR r.target_path LIKE ? COLLATE NOCASE)");
        params.push(`%/${name}`, `%/${name}/%`);
      } else {
        where.push("(r.target_path = ? COLLATE NOCASE OR r.target_path LIKE ? COLLATE NOCASE)");
        params.push(`/${type}/${name}`, `/${type}/${name}/%`);
      }
      if (kind) {
        where.push('r.kind = ? COLLATE NOCASE');
        params.push(String(kind).trim());
      }
      const mods = Array.isArray(modules) ? modules.filter(Boolean) : [];
      if (mods.length) {
        where.push(`n.module IN (${mods.map(() => '?').join(', ')}) COLLATE NOCASE`);
        params.push(...mods);
      }
      const clause = `WHERE ${where.join(' AND ')}`;

      let summary;
      let rows;
      try {
        // The summary counts every match; only the detail list is capped, so a
        // truncated response still reports the true blast radius per model.
        summary = q(`SELECT n.module AS module, COUNT(*) AS c
                     FROM isv_refs r JOIN isv_names n ON n.id = r.source_id
                     ${clause}
                     GROUP BY n.module ORDER BY c DESC`, params);
        rows = q(`SELECT n.module AS module, n.path AS source_path,
                         r.target_path, r.kind, r.line, r.col
                  FROM isv_refs r JOIN isv_names n ON n.id = r.source_id
                  ${clause}
                  ORDER BY n.module COLLATE NOCASE, n.path COLLATE NOCASE, r.line
                  LIMIT ${cap + 1}`, params);
      } catch (err) {
        return errorResult('db-error', `Could not search sealed-ISV references to "${name}".`, err);
      }

      if (!rows.length) {
        return emptyResult(`sealed ISV references to "${name}"`, {
          isv_data_available: true,
          object_name: name,
          usage_count: 0,
          module_summary: [],
          usages: [],
          truncated: false,
          provenance: isvProvenance(db),
        });
      }

      const truncated = rows.length > cap;
      const shown = rows.slice(0, cap);
      const total = summary.reduce((n, s) => n + Number(s.c || 0), 0);

      const typed = {
        isv_data_available: true,
        object_name: name,
        usage_count: total,
        module_summary: summary.map(s => ({
          module: String(s.module),
          reference_count: Number(s.c || 0),
        })),
        usages: shown.map(r => ({
          module: String(r.module),
          source_path: String(r.source_path),
          target_path: String(r.target_path),
          kind: r.kind ?? null,
          line: r.line == null ? null : Number(r.line),
          col: r.col == null ? null : Number(r.col),
        })),
        truncated,
        provenance: isvProvenance(db),
      };

      let out = `## Sealed ISV references to \`${name}\`\n\n`;
      out += `${typed.usage_count} reference(s) across ${typed.module_summary.length} sealed ISV model(s).\n\n`;
      out += formatMarkdownTable(typed.module_summary.map(s => ({
        Model: s.module, References: s.reference_count,
      })), ['Model', 'References']);
      out += `\n### Call sites (${typed.usages.length} shown)\n\n`;
      out += formatMarkdownTable(typed.usages.map(u => ({
        Model: u.module,
        From: u.source_path,
        To: u.target_path,
        Kind: u.kind ?? '',
        Line: u.line ?? '',
      })), ['Model', 'From', 'To', 'Kind', 'Line']);
      if (truncated) out += truncationNote('user', cap);
      out += isvProvenanceNote(typed.usage_count, typed.module_summary.map(s => s.module));

      return structuredResult(typed, out, format);
    }
  );
}
