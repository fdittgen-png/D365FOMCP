/**
 * Authoring-loop read tools (#123–#128) — the read side of the X++ authoring
 * loop, added after the 2026-09-03 comparison with dynamics365ninja's
 * d365fo-mcp-server. That server writes code; this one never will. What it
 * does share is the QUESTIONS a developer asks before writing:
 *
 *   d365_find_method_implementations  "how do others implement validateWrite"   (#125)
 *   d365_lookup_object                queries, reports, maps, macros, config keys,
 *                                     services, security policies, menus         (#123)
 *   d365_lookup_form / d365_find_forms  form patterns, controls, clone-from      (#124)
 *   d365_preflight                    exists · signature · CoC-wrappable ·
 *                                     collisions · naming, in one call           (#126)
 *   d365_knowledge                    the curated X++ rulebook, served to
 *                                     connector clients that never see the
 *                                     plugin skills                              (#128)
 *
 * Every tool degrades on a pre-#123 snapshot: a missing table or column is a
 * coverage fact (`patterns_indexed: false`, an explicit error naming the
 * rebuild), never a crash. Registered from the end of registerKbTools() so
 * tool-sets.js and every entry point stay untouched.
 */

import { z } from 'zod';
import { readdirSync, readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  query,
  formatMarkdownTable,
  emptyResult,
  notFoundResult,
  errorResult,
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
  closestNames,
  READ_ONLY_DB_ANNOTATIONS,
} from './shared.js';
import { hasIsvData } from './isv-schema.js';
import { semanticStore, recordContextHint, functionalContextParam } from './tool-guards.js';
import { cursorParam, decodeCursor, pageMeta, pageNote, probeLimit, takePage } from './pagination.js';
import {
  d365FindMethodImplementationsOutput,
  d365LookupObjectOutput,
  d365LookupFormOutput,
  d365FindFormsOutput,
  d365PreflightOutput,
  d365KnowledgeOutput,
} from './output-schemas.js';

/** AOT types the `objects_meta` catalogue carries (build-kb.js extractors). */
export const OBJECT_META_TYPES = Object.freeze([
  'query', 'report', 'map', 'macro', 'config_key', 'service', 'service_group', 'security_policy', 'menu',
]);

/** First-class KB tables per object kind: [table, name column, label column]. */
const KIND_TABLES = Object.freeze({
  table: ['tables', 'table_name', 'label'],
  class: ['classes', 'class_name', null],
  entity: ['data_entities', 'entity_name', 'label'],
  enum: ['enums', 'enum_name', 'label'],
  edt: ['edts', 'edt_name', 'label'],
  form: ['forms', 'form_name', 'label'],
  view: ['views', 'view_name', 'label'],
  menu_item: ['menu_items', 'menu_item_name', 'label'],
});
const PREFLIGHT_TYPES = Object.freeze([...Object.keys(KIND_TABLES), ...OBJECT_META_TYPES]);

const KNOWLEDGE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'knowledge');

const escapeLike = (s) => String(s).replace(/[\\%_]/g, ch => `\\${ch}`);
const toStr = (v) => (v == null ? null : String(v));
const toNum = (v) => { const n = Number(v); return v == null || !Number.isFinite(n) ? null : n; };
const parseJson = (s, dflt) => { try { return JSON.parse(s || 'null') ?? dflt; } catch { return dflt; } };

/**
 * Parse the modifiers of an X++ method signature as the KB stores it
 * (`[Hookable(false)] internal static boolean exist(...)`) and apply the
 * Microsoft wrappability table (extensibility-attributes, method-wrapping-coc):
 * private / internal → no; [Hookable(false)] or [Wrappable(false)] → no;
 * final without [Wrappable(true)] → no; protected internal (PU25+), protected,
 * public → yes. Exported for tests.
 */
export function analyzeSignature(signature) {
  const sig = String(signature ?? '');
  const attrBlock = sig.match(/^\s*\[([^\]]*)\]/)?.[1] ?? '';
  const head = sig.replace(/^\s*\[[^\]]*\]\s*/, '');
  const beforeParen = head.split('(')[0];
  const has = (kw) => new RegExp(`(^|\\s)${kw}(\\s|$)`).test(beforeParen);
  const visibility = has('private') ? 'private'
    : (has('protected') && has('internal')) ? 'protected internal'
      : has('protected') ? 'protected'
        : has('internal') ? 'internal'
          : has('public') ? 'public' : null;
  const attr = (name) => {
    const m = attrBlock.match(new RegExp(`\\b${name}\\s*\\(\\s*(true|false)\\s*\\)`, 'i'));
    return m ? m[1].toLowerCase() === 'true' : null;
  };
  const hookable = attr('Hookable');
  const wrappable = attr('Wrappable');
  const replaceable = /\bReplaceable\b/i.test(attrBlock);
  const isFinal = has('final');
  const isStatic = has('static');
  const isAbstract = has('abstract');

  let cocWrappable = null;
  let reason = null;
  if (!sig) { reason = 'no signature in the snapshot'; }
  else if (visibility === 'private') { cocWrappable = false; reason = 'private methods cannot be wrapped'; }
  else if (visibility === 'internal') { cocWrappable = false; reason = 'internal methods cannot be wrapped (same-model only)'; }
  else if (hookable === false) { cocWrappable = false; reason = '[Hookable(false)] disables Chain of Command'; }
  else if (wrappable === false) { cocWrappable = false; reason = '[Wrappable(false)] opts the method out'; }
  else if (isFinal && wrappable !== true) { cocWrappable = false; reason = 'final method without [Wrappable(true)]'; }
  else if (visibility === 'protected internal') { cocWrappable = true; reason = 'protected internal: wrappable from Platform update 25'; }
  else if (visibility === 'protected' || visibility === 'public') { cocWrappable = true; reason = `${visibility}${isFinal ? ' final + [Wrappable(true)]' : ''}: wrappable; next must be called${replaceable ? ' (Replaceable: next may be skipped)' : ''}`; }
  else { cocWrappable = true; reason = 'no access modifier (defaults to public in X++): wrappable'; }

  return {
    visibility, is_static: isStatic, is_final: isFinal, is_abstract: isAbstract,
    hookable, wrappable_attribute: wrappable, replaceable,
    coc_wrappable: cocWrappable, coc_reason: reason,
  };
}

/** Parse one knowledge file: `---` frontmatter (key: value, comma lists) + body. */
export function parseKnowledgeFile(text, fallbackTopic) {
  const m = String(text).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  const meta = {};
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const i = line.indexOf(':');
      if (i > 0) meta[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
  }
  const list = (v) => (v ? String(v).split(',').map(s => s.trim()).filter(Boolean) : []);
  return {
    topic: meta.topic || fallbackTopic,
    title: meta.title || fallbackTopic,
    aliases: list(meta.aliases),
    tags: list(meta.tags),
    sources: list(meta.sources),
    body: (m ? m[2] : String(text)).trim(),
  };
}

/** Load every `knowledge/*.md` once per process; `dir` is a test seam. */
export function loadKnowledge(dir = KNOWLEDGE_DIR) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.toLowerCase().endsWith('.md'))
    .sort()
    .map(f => parseKnowledgeFile(readFileSync(join(dir, f), 'utf8'), f.replace(/\.md$/i, '')));
}

/** @param {{ semanticDb?: any, knowledgeDir?: string }} [opts] test seams */
export function registerAuthoringTools(server, db, opts = {}) {
  const { semanticDb, knowledgeDir } = opts;
  const q = (sql, params = []) => query(db, sql, params);
  const tableNames = (() => {
    try { return new Set(q("SELECT name FROM sqlite_master WHERE type IN ('table','view')").map(r => String(r.name).toLowerCase())); }
    catch { return new Set(); }
  })();
  const hasTable = (t) => tableNames.has(t.toLowerCase());
  const hasColumn = (t, c) => { try { return q(`PRAGMA table_info(${t})`).some(col => col.name === c); } catch { return false; } };
  const semDb = () => semanticDb ?? semanticStore();
  const hint = (functional_context, object_type, object_name) => {
    if (!functional_context || !object_name) return;
    recordContextHint(semDb(), { functional_context, object_type, object_name });
  };
  const partialBuildSince = readKbMetadataFlag(db, 'partial_build');
  const kbCov = () => coverageNotes({ partial_build: partialBuildSince ? { since: partialBuildSince } : null });
  const isvScanned = hasIsvData(db);
  const formsHavePattern = hasTable('forms') && hasColumn('forms', 'pattern');
  const hasFormControls = hasTable('form_controls');
  const hasObjectsMeta = hasTable('objects_meta');
  const fieldsHaveExtension = hasTable('fields') && hasColumn('fields', 'is_extension');

  /** module → origin (microsoft/isv/custom) from the Descriptor provenance. */
  const modelOriginResolver = () => {
    const byModule = new Map();
    try {
      for (const v of queryModelVersions(q)) {
        if (v.module_id) byModule.set(String(v.module_id).toLowerCase(), v.origin ?? null);
        if (v.model_name) byModule.set(String(v.model_name).toLowerCase(), v.origin ?? null);
      }
    } catch { /* pre-provenance DB */ }
    return (m) => (m ? byModule.get(String(m).toLowerCase()) ?? null : null);
  };
  const menuItemsFor = (objectName) => {
    if (!hasTable('menu_items')) return [];
    return q('SELECT menu_item_name, menu_item_type FROM menu_items WHERE object_name = ? COLLATE NOCASE ORDER BY menu_item_type, menu_item_name', [objectName])
      .map(r => ({ menu_item_name: String(r.menu_item_name), menu_item_type: toStr(r.menu_item_type) }));
  };
  const renderMenuItems = (items) => (items.length
    ? formatMarkdownTable(items.map(m => ({ 'Menu item': m.menu_item_name, Type: m.menu_item_type ?? '' })), ['Menu item', 'Type'])
    : '_No menu item points at this object._');

  // ── d365_find_method_implementations (#125) ────────────────────────────────
  server.registerTool(
    'd365_find_method_implementations',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description: 'Every class, table or data entity implementing a method of this name — signature, module and body line count, no source (TIER 1). Follow with d365_get_method_source for the bodies you pick.',
      inputSchema: {
        method_name: z.string().min(1).max(200).describe('Method name, e.g. validateWrite (case-insensitive).'),
        owner_type: z.enum(['class', 'table', 'entity']).optional().describe('Restrict to one owner kind.'),
        modules: modulesFilterParam,
        exclude_extensions: z.boolean().optional().default(false)
          .describe('Skip owners named *_Extension (CoC wrappers) to see original implementations only.'),
        limit: z.number().int().min(1).max(200).optional().default(20).describe('Max owners per page.'),
        cursor: cursorParam,
        format: formatTextParam,
      },
      outputSchema: d365FindMethodImplementationsOutput.shape,
    },
    async ({ method_name, owner_type, modules, exclude_extensions, limit: rawLimit, cursor, format }) => {
      const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? rawLimit : 20;
      const excludeExt = exclude_extensions === true;
      const moduleFilter = sanitizeModulesFilter(modules);
      const page = decodeCursor(cursor);
      if (!page.ok) return page.error;
      const _v = validateLikePattern(method_name);
      if (_v) return patternErrorResult(_v);
      const modelOrigin = modelOriginResolver();

      const where = ['m.method_name = ? COLLATE NOCASE'];
      const params = [method_name];
      if (owner_type) { where.push('m.owner_type = ?'); params.push(owner_type); }
      if (excludeExt) { where.push("m.owner_name NOT LIKE '%\\_Extension' ESCAPE '\\'"); }
      const moduleExpr = 'COALESCE(c.module_id, t.module_id, e.module_id)';
      if (moduleFilter.length) {
        where.push(`${moduleExpr} COLLATE NOCASE IN (${moduleFilter.map(() => '?').join(', ')})`);
        params.push(...moduleFilter);
      }
      const from = `FROM methods m
        LEFT JOIN classes c ON m.owner_type = 'class' AND c.class_name = m.owner_name
        LEFT JOIN tables t ON m.owner_type = 'table' AND t.table_name = m.owner_name
        LEFT JOIN data_entities e ON m.owner_type = 'entity' AND e.entity_name = m.owner_name
        WHERE ${where.join(' AND ')}`;

      let rows;
      let total;
      try {
        total = toNum(q(`SELECT COUNT(*) AS n ${from}`, params)[0]?.n) ?? 0;
        // Line count computed in SQL so the source blobs never leave the DB (tier 1).
        rows = q(`SELECT m.owner_type, m.owner_name, m.signature, m.is_static, ${moduleExpr} AS module_id,
                         CASE WHEN m.source_code IS NULL THEN NULL
                              ELSE LENGTH(m.source_code) - LENGTH(REPLACE(m.source_code, char(10), '')) + 1 END AS source_lines
                  ${from}
                  ORDER BY m.owner_type, m.owner_name COLLATE NOCASE
                  LIMIT ? OFFSET ?`, [...params, probeLimit(limit), page.offset]);
      } catch (err) {
        return errorResult('db-error', 'Method implementation lookup failed; check the method name.', err);
      }
      const { rows: shown, has_more } = takePage(rows, limit);
      const typed = {
        method_name,
        owner_type: owner_type ?? null,
        modules: moduleFilter.length ? moduleFilter : null,
        exclude_extensions: excludeExt,
        owner_count: total,
        result_count: shown.length,
        implementations: shown.map(r => ({
          owner_type: String(r.owner_type),
          owner_name: String(r.owner_name),
          module_id: toStr(r.module_id),
          model_origin: modelOrigin(r.module_id),
          signature: toStr(r.signature),
          is_static: toNum(r.is_static) === 1,
          source_lines: toNum(r.source_lines),
        })),
        // owner_count is the tool's own exact count key, so pageMeta carries none (rule #15).
        ...pageMeta(null, page.offset, shown.length, limit, has_more),
      };
      if (!typed.result_count) return emptyResult(`implementations of ${method_name}`, typed);

      let out = `## Implementations of ${method_name} (${typed.owner_count})\n`;
      if (typed.owner_type) out += `_Owner type: ${typed.owner_type}_\n`;
      if (typed.modules) out += `_Scope: modules ${typed.modules.join(', ')}_\n`;
      out += '\n' + formatMarkdownTable(typed.implementations.map(i => ({
        Owner: i.owner_name, Type: i.owner_type, Module: i.module_id ?? '', Origin: i.model_origin ?? '',
        Static: i.is_static ? 'Y' : '', Lines: i.source_lines ?? '', Signature: i.signature ?? '',
      })), ['Owner', 'Type', 'Module', 'Origin', 'Static', 'Lines', 'Signature']);
      if (typed.has_more) out += pageNote(typed.result_count, page.offset, typed.next_cursor);
      out += '\n_Bodies: d365_get_method_source(owner_name, method_names)._\n';
      return structuredResult(typed, out, format, { coverage: kbCov() });
    },
  );

  // ── d365_lookup_object (#123) ──────────────────────────────────────────────
  server.registerTool(
    'd365_lookup_object',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description: 'Metadata of an AOT object outside the first-class tables: query, report, map, macro, configuration key, service, service group, security policy (XDS), menu — module, label, type-specific properties, menu items pointing at it.',
      inputSchema: {
        object_type: z.enum(OBJECT_META_TYPES).describe('AOT type of the object.'),
        object_name: z.string().min(1).max(500).describe('Object name (case-insensitive).'),
        functional_context: functionalContextParam,
        format: formatTextParam,
      },
      outputSchema: d365LookupObjectOutput.shape,
    },
    async ({ object_type, object_name, functional_context, format }) => {
      if (!OBJECT_META_TYPES.includes(object_type)) {
        return errorResult('invalid-input', `object_type must be one of ${OBJECT_META_TYPES.join(', ')}.`);
      }
      if (!hasObjectsMeta) {
        return errorResult('db-error', 'This KB snapshot has no object catalogue (objects_meta, schema 1.2) — rebuild it with `npm run build:kb`.');
      }
      const _v = validateLikePattern(object_name);
      if (_v) return patternErrorResult(_v);
      const row = q('SELECT object_type, object_name, module_id, label, properties_json FROM objects_meta WHERE object_type = ? AND object_name = ? COLLATE NOCASE LIMIT 1',
        [object_type, object_name])[0];
      if (!row) {
        const stem = escapeLike(object_name.slice(0, 4));
        const near = q("SELECT object_name FROM objects_meta WHERE object_type = ? AND object_name LIKE ? ESCAPE '\\' ORDER BY object_name LIMIT 5",
          [object_type, `${stem}%`]).map(r => String(r.object_name));
        return notFoundResult(object_type.replace('_', ' '), object_name, near, { functional_context, semanticDb: semDb() });
      }
      hint(functional_context, object_type, String(row.object_name));
      const resolve = makeLabelResolver(db);
      const modelOrigin = modelOriginResolver();
      const typed = {
        object_type,
        object_name: String(row.object_name),
        module_id: toStr(row.module_id),
        model_origin: modelOrigin(row.module_id),
        label: row.label ? resolve(String(row.label)) : null,
        properties: parseJson(row.properties_json, {}),
        menu_items: menuItemsFor(String(row.object_name)),
      };
      let out = `## ${object_type.replace('_', ' ')}: ${typed.object_name}\n`;
      out += `Module: ${typed.module_id ?? '-'}${typed.model_origin ? ` (${typed.model_origin})` : ''}`;
      if (typed.label) out += ` | Label: ${typed.label}`;
      out += '\n\n### Properties\n';
      const propRows = Object.entries(typed.properties).map(([k, v]) => ({
        Property: k, Value: Array.isArray(v) || (v && typeof v === 'object') ? JSON.stringify(v) : String(v ?? ''),
      }));
      out += propRows.length ? formatMarkdownTable(propRows, ['Property', 'Value']) : '_No properties captured._';
      out += `\n\n### Menu items (${typed.menu_items.length})\n${renderMenuItems(typed.menu_items)}\n`;
      return structuredResult(typed, out, format, { coverage: kbCov() });
    },
  );

  // ── d365_lookup_form (#124) ────────────────────────────────────────────────
  server.registerTool(
    'd365_lookup_form',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description: 'One form: design pattern + version, data-source tables, menu items that open it and, on request, its control tree (type, pattern, data binding) — the clone-from and "which control shows this field" questions.',
      inputSchema: {
        form_name: z.string().min(1).max(500).describe('Form name (case-insensitive).'),
        include_controls: z.boolean().optional().default(false).describe('List controls (name, type, pattern, binding). Off by default: a details form has hundreds.'),
        controls_like: z.string().min(1).max(100).optional().describe('Only controls whose name or bound field contains this text (implies include_controls).'),
        control_limit: z.number().int().min(1).max(2000).optional().default(200).describe('Max controls listed.'),
        functional_context: functionalContextParam,
        format: formatTextParam,
      },
      outputSchema: d365LookupFormOutput.shape,
    },
    async ({ form_name, include_controls, controls_like, control_limit, functional_context, format }) => {
      const controlLimit = Number.isInteger(control_limit) && control_limit > 0 ? control_limit : 200;
      const wantControls = include_controls === true || !!controls_like;
      const _v = validateLikePattern(form_name) || (controls_like ? validateLikePattern(controls_like) : null);
      if (_v) return patternErrorResult(_v);
      const patternCols = formsHavePattern ? 'pattern, pattern_version, controls_count' : 'NULL AS pattern, NULL AS pattern_version, NULL AS controls_count';
      const row = q(`SELECT form_name, module_id, label, data_sources_json, ${patternCols} FROM forms WHERE form_name = ? COLLATE NOCASE LIMIT 1`, [form_name])[0];
      if (!row) return notFoundResult('Form', form_name, undefined, { db, kind: 'form', functional_context, semanticDb: semDb() });
      hint(functional_context, 'form', String(row.form_name));
      const resolve = makeLabelResolver(db);
      const modelOrigin = modelOriginResolver();

      const typed = {
        form_name: String(row.form_name),
        module_id: toStr(row.module_id),
        model_origin: modelOrigin(row.module_id),
        label: row.label ? resolve(String(row.label)) : null,
        pattern: toStr(row.pattern),
        pattern_version: toStr(row.pattern_version),
        patterns_indexed: formsHavePattern,
        data_sources: parseJson(row.data_sources_json, []).map(String),
        controls_count: toNum(row.controls_count),
        menu_items: menuItemsFor(String(row.form_name)),
      };
      if (typed.controls_count == null && hasFormControls) {
        typed.controls_count = toNum(q('SELECT COUNT(*) AS n FROM form_controls WHERE form_name = ? COLLATE NOCASE', [typed.form_name])[0]?.n);
      }
      if (wantControls && hasFormControls) {
        const where = ['form_name = ? COLLATE NOCASE'];
        const params = [typed.form_name];
        if (controls_like) {
          const like = `%${escapeLike(controls_like)}%`;
          where.push("(control_name LIKE ? ESCAPE '\\' OR data_field LIKE ? ESCAPE '\\')");
          params.push(like, like);
        }
        const rows = q(`SELECT control_name, control_type, pattern, pattern_version, data_source, data_field, parent_control
                        FROM form_controls WHERE ${where.join(' AND ')} ORDER BY rowid LIMIT ?`, [...params, controlLimit + 1]);
        const shown = rows.slice(0, controlLimit);
        typed.controls = shown.map(c => ({
          name: String(c.control_name), type: toStr(c.control_type), pattern: toStr(c.pattern), pattern_version: toStr(c.pattern_version),
          data_source: toStr(c.data_source), data_field: toStr(c.data_field), parent: toStr(c.parent_control),
        }));
        typed.controls_shown = shown.length;
        typed.controls_truncated = rows.length > controlLimit;
      }

      let out = `## Form: ${typed.form_name}\n`;
      out += `Module: ${typed.module_id ?? '-'}${typed.model_origin ? ` (${typed.model_origin})` : ''}`;
      if (typed.label) out += ` | Label: ${typed.label}`;
      out += `\nPattern: ${typed.pattern ?? (typed.patterns_indexed ? '(none)' : 'not indexed in this snapshot')}${typed.pattern_version ? ` v${typed.pattern_version}` : ''}`;
      if (typed.controls_count != null) out += ` | Controls: ${typed.controls_count}`;
      out += `\nData sources: ${typed.data_sources.length ? typed.data_sources.join(', ') : '-'}\n`;
      out += `\n### Menu items (${typed.menu_items.length})\n${renderMenuItems(typed.menu_items)}\n`;
      if (typed.controls) {
        out += `\n### Controls (${typed.controls_shown}${typed.controls_count != null ? ` of ${typed.controls_count}` : ''})\n`;
        out += typed.controls.length
          ? formatMarkdownTable(typed.controls.map(c => ({
            Control: c.name, Type: (c.type ?? '').replace(/^AxForm/, '').replace(/Control$/, ''), Pattern: c.pattern ?? '',
            Binding: c.data_source ? `${c.data_source}${c.data_field ? '.' + c.data_field : ''}` : '', Parent: c.parent ?? '',
          })), ['Control', 'Type', 'Pattern', 'Binding', 'Parent'])
          : '_No controls match._';
        if (typed.controls_truncated) out += truncationNote('cap', typed.controls_shown, 2000);
        out += '\n';
      } else if (wantControls && !hasFormControls) {
        out += '\n_Control tree not in this snapshot (built before schema 1.2)._\n';
      }
      return structuredResult(typed, out, format, { coverage: kbCov() });
    },
  );

  // ── d365_find_forms (#124) ─────────────────────────────────────────────────
  server.registerTool(
    'd365_find_forms',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description: 'Forms by design pattern and/or data-source table ("which standard forms are DetailsMaster on CustTable" — the clone-from question). With no filter: the pattern catalogue with counts and an example form each.',
      inputSchema: {
        pattern: z.string().min(1).max(100).optional().describe('Design pattern, e.g. DetailsMaster, SimpleList, ListPage.'),
        table: z.string().min(1).max(500).optional().describe('A table among the form data sources.'),
        modules: modulesFilterParam,
        limit: z.number().int().min(1).max(500).optional().default(50).describe('Max forms per page.'),
        cursor: cursorParam,
        format: formatTextParam,
      },
      outputSchema: d365FindFormsOutput.shape,
    },
    async ({ pattern, table, modules, limit: rawLimit, cursor, format }) => {
      const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? rawLimit : 50;
      const moduleFilter = sanitizeModulesFilter(modules);
      const page = decodeCursor(cursor);
      if (!page.ok) return page.error;
      for (const s of [pattern, table]) {
        if (s) { const _v = validateLikePattern(s); if (_v) return patternErrorResult(_v); }
      }
      if (!formsHavePattern && (pattern || (!pattern && !table))) {
        return errorResult('db-error', 'Form patterns are not in this KB snapshot (schema 1.2) — rebuild it with `npm run build:kb`; `table` filtering still works.');
      }
      const modelOrigin = modelOriginResolver();
      const resolve = makeLabelResolver(db);

      if (!pattern && !table) {
        const rows = q(`SELECT pattern, COUNT(*) AS n, MIN(form_name) AS example FROM forms
                        WHERE pattern IS NOT NULL AND pattern <> '' ${moduleFilter.length ? `AND module_id COLLATE NOCASE IN (${moduleFilter.map(() => '?').join(', ')})` : ''}
                        GROUP BY pattern ORDER BY n DESC, pattern`, moduleFilter);
        const typed = {
          mode: 'patterns',
          pattern_filter: null,
          table_filter: null,
          modules: moduleFilter.length ? moduleFilter : null,
          result_count: rows.length,
          patterns: rows.map(r => ({ pattern: String(r.pattern), form_count: toNum(r.n) ?? 0, example_form: toStr(r.example) })),
        };
        if (!rows.length) return emptyResult('form patterns', typed);
        let out = `## Form patterns (${typed.result_count})\n\n`;
        out += formatMarkdownTable(typed.patterns.map(p => ({ Pattern: p.pattern, Forms: p.form_count, Example: p.example_form ?? '' })), ['Pattern', 'Forms', 'Example']);
        out += '\n_Pass `pattern` and/or `table` to list the forms._\n';
        return structuredResult(typed, out, format, { coverage: kbCov() });
      }

      const where = [];
      const params = [];
      if (pattern) { where.push('pattern = ? COLLATE NOCASE'); params.push(pattern); }
      if (table) { where.push("data_sources_json LIKE ? ESCAPE '\\'"); params.push(`%"${escapeLike(table)}"%`); }
      if (moduleFilter.length) { where.push(`module_id COLLATE NOCASE IN (${moduleFilter.map(() => '?').join(', ')})`); params.push(...moduleFilter); }
      const patternCols = formsHavePattern ? 'pattern, pattern_version' : 'NULL AS pattern, NULL AS pattern_version';
      const rows = q(`SELECT form_name, module_id, label, data_sources_json, ${patternCols} FROM forms
                      WHERE ${where.join(' AND ')} ORDER BY form_name COLLATE NOCASE LIMIT ? OFFSET ?`, [...params, probeLimit(limit), page.offset]);
      const { rows: shown, has_more } = takePage(rows, limit);
      const typed = {
        mode: 'forms',
        pattern_filter: pattern ?? null,
        table_filter: table ?? null,
        modules: moduleFilter.length ? moduleFilter : null,
        result_count: shown.length,
        forms: shown.map(r => ({
          form_name: String(r.form_name), module_id: toStr(r.module_id), model_origin: modelOrigin(r.module_id),
          label: r.label ? resolve(String(r.label)) : null, pattern: toStr(r.pattern), pattern_version: toStr(r.pattern_version),
          data_sources: parseJson(r.data_sources_json, []).map(String),
        })),
        ...pageMeta(null, page.offset, shown.length, limit, has_more),
      };
      if (!typed.result_count) return emptyResult(`forms${pattern ? ` with pattern ${pattern}` : ''}${table ? ` on ${table}` : ''}`, typed);
      let out = `## Forms${pattern ? `: pattern ${pattern}` : ''}${table ? ` on ${table}` : ''} (${typed.result_count}${typed.has_more ? '+' : ''})\n`;
      if (typed.modules) out += `_Scope: modules ${typed.modules.join(', ')}_\n`;
      out += '\n' + formatMarkdownTable(typed.forms.map(f => ({
        Form: f.form_name, Module: f.module_id ?? '', Origin: f.model_origin ?? '', Pattern: f.pattern ?? '', Label: f.label ?? '',
        'Data sources': f.data_sources.join(', '),
      })), ['Form', 'Module', 'Origin', 'Pattern', 'Label', 'Data sources']);
      if (typed.has_more) out += pageNote(typed.result_count, page.offset, typed.next_cursor);
      return structuredResult(typed, out, format, { coverage: kbCov() });
    },
  );

  // ── d365_preflight (#126) ──────────────────────────────────────────────────
  server.registerTool(
    'd365_preflight',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description: 'One call before writing X++: does the object exist and where (module, origin, sealed ISV) · method signature and whether Chain of Command can wrap it · existing extension classes · collisions and prefix rule for proposed new names.',
      inputSchema: {
        object_type: z.enum(PREFLIGHT_TYPES).optional().describe('Narrows the lookup; omitted = every kind.'),
        object_name: z.string().min(1).max(500).optional().describe('Object to extend or check. This or proposed_names.'),
        method_name: z.string().min(1).max(200).optional().describe('Method on the object to wrap (class, table, entity).'),
        proposed_names: z.array(z.string().min(1).max(200)).min(1).max(20).optional()
          .describe('New object names to check for collisions and the KB_NAMING_PREFIXES rule.'),
        functional_context: functionalContextParam,
        format: formatTextParam,
      },
      outputSchema: d365PreflightOutput.shape,
    },
    async ({ object_type, object_name, method_name, proposed_names, functional_context, format }) => {
      const proposed = Array.isArray(proposed_names) ? [...new Set(proposed_names.map(s => String(s).trim()).filter(Boolean))].slice(0, 20) : [];
      if (!object_name && !proposed.length) return errorResult('invalid-input', 'Provide `object_name` and/or `proposed_names`.');
      for (const s of [object_name, method_name, ...proposed]) {
        if (s) { const _v = validateLikePattern(s); if (_v) return patternErrorResult(_v); }
      }
      if (object_type && !PREFLIGHT_TYPES.includes(object_type)) {
        return errorResult('invalid-input', `object_type must be one of ${PREFLIGHT_TYPES.join(', ')}.`);
      }
      const resolve = makeLabelResolver(db);
      const modelOrigin = modelOriginResolver();
      const prefixes = String(process.env.KB_NAMING_PREFIXES ?? '').split(',').map(s => s.trim()).filter(Boolean);
      const typed = { naming_prefixes: prefixes.length ? prefixes : null, verdict: '' };
      const verdictParts = [];

      // 1. The object.
      if (object_name) {
        const kinds = object_type ? [object_type] : PREFLIGHT_TYPES;
        let found = null;
        for (const kind of kinds) {
          const spec = KIND_TABLES[kind];
          if (spec) {
            const [tbl, col, labelCol] = spec;
            if (!hasTable(tbl)) continue;
            const r = q(`SELECT ${col} AS name, module_id${labelCol ? `, ${labelCol} AS label` : ''} FROM ${tbl} WHERE ${col} = ? COLLATE NOCASE LIMIT 1`, [object_name])[0];
            if (r) { found = { kind, name: String(r.name), module_id: toStr(r.module_id), label: labelCol ? toStr(r.label) : null }; break; }
          } else if (hasObjectsMeta) {
            const r = q('SELECT object_name AS name, module_id, label FROM objects_meta WHERE object_type = ? AND object_name = ? COLLATE NOCASE LIMIT 1', [kind, object_name])[0];
            if (r) { found = { kind, name: String(r.name), module_id: toStr(r.module_id), label: toStr(r.label) }; break; }
          }
        }
        if (found) {
          typed.object = {
            exists: true, object_type: found.kind, object_name: found.name, module_id: found.module_id,
            model_origin: modelOrigin(found.module_id), label: found.label ? resolve(found.label) : null,
          };
          hint(functional_context, found.kind, found.name);
          verdictParts.push(`${found.kind} ${found.name} exists in ${found.module_id ?? 'an unknown module'}${typed.object.model_origin ? ` (${typed.object.model_origin})` : ''}`);
        } else {
          typed.object = { exists: false, object_type: object_type ?? null, object_name, module_id: null, model_origin: null, label: null };
          if (isvScanned) {
            typed.object.sealed_isv = q('SELECT module, element_type FROM isv_elements WHERE name = ? COLLATE NOCASE ORDER BY module, element_type LIMIT 10', [object_name])
              .map(r => ({ module: String(r.module), element_type: String(r.element_type) }));
          }
          typed.object.suggestions = closestNames(db, object_name, KIND_TABLES[object_type] ? object_type : 'object', 3);
          verdictParts.push(typed.object.sealed_isv?.length
            ? `${object_name} is not in the scanned source but a sealed ISV model declares it (${typed.object.sealed_isv.map(s => s.module).join(', ')}) — metadata only, no source to wrap`
            : `${object_name} does not exist in this snapshot`);
        }

        // 2. The method (class / table / entity owners only — the methods table).
        if (method_name) {
          const ownerKind = typed.object.exists ? typed.object.object_type : null;
          if (ownerKind && ['class', 'table', 'entity'].includes(ownerKind) && hasTable('methods')) {
            const m = q('SELECT method_name, signature, is_static FROM methods WHERE owner_type = ? AND owner_name = ? COLLATE NOCASE AND method_name = ? COLLATE NOCASE LIMIT 1',
              [ownerKind, typed.object.object_name, method_name])[0];
            if (m) {
              const a = analyzeSignature(m.signature);
              typed.method = { exists: true, method_name: String(m.method_name), signature: toStr(m.signature), ...a, is_static: a.is_static || toNum(m.is_static) === 1 };
              verdictParts.push(`${typed.method.method_name}: ${a.coc_wrappable ? 'CoC-wrappable' : 'NOT CoC-wrappable'} — ${a.coc_reason}`);
            } else {
              const stem = escapeLike(method_name.slice(0, 3));
              const near = q("SELECT method_name FROM methods WHERE owner_type = ? AND owner_name = ? COLLATE NOCASE AND method_name LIKE ? ESCAPE '\\' ORDER BY method_name LIMIT 5",
                [ownerKind, typed.object.object_name, `${stem}%`]).map(r => String(r.method_name));
              typed.method = { exists: false, method_name, signature: null, visibility: null, hookable: null, wrappable_attribute: null, coc_wrappable: null, coc_reason: 'method not found on this owner', suggestions: near };
              verdictParts.push(`${method_name} is not a method of ${typed.object.object_name}${near.length ? ` (did you mean ${near.join(', ')}?)` : ''}`);
            }
          } else {
            typed.method = { exists: false, method_name, signature: null, visibility: null, hookable: null, wrappable_attribute: null, coc_wrappable: null,
              coc_reason: typed.object.exists ? `method signatures are indexed for classes, tables and entities, not ${ownerKind}s` : 'owner does not exist' };
          }
        }

        // 3. Existing extensions — the same naming heuristic xref_find_extensions
        //    uses, so the two tools agree; sealed-ISV CoC descriptors are exact.
        if (typed.object.exists) {
          const base = escapeLike(typed.object.object_name);
          const classes = hasTable('classes')
            ? q("SELECT class_name, module_id FROM classes WHERE class_name LIKE ? ESCAPE '\\' OR class_name LIKE ? ESCAPE '\\' ORDER BY class_name LIMIT 50",
              [`${base}%\\_Extension`, `${base}%Extension`]).map(r => ({ class_name: String(r.class_name), module_id: toStr(r.module_id) }))
            : [];
          const extModels = (typed.object.object_type === 'table' && fieldsHaveExtension)
            ? q('SELECT DISTINCT source_module FROM fields WHERE table_name = ? COLLATE NOCASE AND is_extension = 1 AND source_module IS NOT NULL ORDER BY source_module', [typed.object.object_name])
              .map(r => String(r.source_module))
            : [];
          typed.existing_extensions = {
            classes, table_extension_models: extModels,
            heuristic_note: 'Extension classes are matched by name (<Object>*Extension) — confirm with xref_find_extensions; sealed-ISV wrappers are exact.',
          };
          if (isvScanned) {
            typed.existing_extensions.sealed_isv_coc = q(`SELECT module, extension_class, method FROM isv_coc WHERE target = ? COLLATE NOCASE ${method_name ? 'AND method = ? COLLATE NOCASE' : ''} ORDER BY module, extension_class LIMIT 50`,
              method_name ? [typed.object.object_name, method_name] : [typed.object.object_name])
              .map(r => ({ module: String(r.module), extension_class: String(r.extension_class), method: toStr(r.method) }));
          }
          const n = classes.length + (typed.existing_extensions.sealed_isv_coc?.length ?? 0);
          if (n) verdictParts.push(`${n} existing extension class(es)/wrapper(s) — read them before adding another`);
        }
      }

      // 4. Proposed names: collisions across every catalogued name + prefix rule.
      if (proposed.length) {
        typed.proposed_names = proposed.map(name => {
          const collisions = [];
          if (hasTable('object_paths')) {
            for (const r of q('SELECT object_type FROM object_paths WHERE object_name = ? COLLATE NOCASE', [name])) collisions.push({ object_type: String(r.object_type), source: 'kb', module: null });
          }
          if (hasTable('menu_items')) {
            for (const r of q('SELECT menu_item_type, module_id FROM menu_items WHERE menu_item_name = ? COLLATE NOCASE', [name])) collisions.push({ object_type: `menu_item_${String(r.menu_item_type ?? '').toLowerCase()}`, source: 'kb', module: toStr(r.module_id) });
          }
          if (hasObjectsMeta) {
            for (const r of q('SELECT object_type, module_id FROM objects_meta WHERE object_name = ? COLLATE NOCASE', [name])) collisions.push({ object_type: String(r.object_type), source: 'kb', module: toStr(r.module_id) });
          }
          if (isvScanned) {
            for (const r of q('SELECT element_type, module FROM isv_elements WHERE name = ? COLLATE NOCASE LIMIT 20', [name])) collisions.push({ object_type: String(r.element_type), source: 'sealed-isv', module: toStr(r.module) });
          }
          const validIdentifier = /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
          const prefixOk = prefixes.length ? prefixes.some(p => name.toLowerCase().startsWith(p.toLowerCase())) : null;
          return { name, valid_identifier: validIdentifier, collisions, prefix_ok: prefixOk };
        });
        const bad = typed.proposed_names.filter(p => p.collisions.length || !p.valid_identifier || p.prefix_ok === false);
        verdictParts.push(bad.length
          ? `${bad.length} of ${proposed.length} proposed name(s) need attention: ${bad.map(p => p.name).join(', ')}`
          : `${proposed.length} proposed name(s) are free${prefixes.length ? ' and follow the prefix rule' : ''}`);
      }
      typed.verdict = verdictParts.join('. ') + '.';

      let out = `## Preflight${object_name ? `: ${object_name}${method_name ? `.${method_name}` : ''}` : ''}\n${typed.verdict}\n`;
      if (typed.object) {
        const o = typed.object;
        out += `\n### Object\n${o.exists ? `${o.object_type} **${o.object_name}** — module ${o.module_id ?? '-'}${o.model_origin ? ` (${o.model_origin})` : ''}${o.label ? ` — ${o.label}` : ''}` : `Not in the scanned source.`}\n`;
        if (o.sealed_isv?.length) out += formatMarkdownTable(o.sealed_isv.map(s => ({ 'Sealed ISV model': s.module, 'Element type': s.element_type })), ['Sealed ISV model', 'Element type']) + '\n';
        if (o.suggestions?.length) out += `Did you mean: ${o.suggestions.map(s => `\`${s}\``).join(', ')}\n`;
      }
      if (typed.method) {
        const m = typed.method;
        out += `\n### Method\n`;
        if (m.exists) {
          out += `\`${m.signature}\`\n\n`;
          out += formatMarkdownTable([{
            Visibility: m.visibility ?? '(default public)', Static: m.is_static ? 'Y' : '', Final: m.is_final ? 'Y' : '', Abstract: m.is_abstract ? 'Y' : '',
            Hookable: m.hookable == null ? '' : String(m.hookable), Wrappable: m.wrappable_attribute == null ? '' : String(m.wrappable_attribute),
            'CoC wrappable': m.coc_wrappable ? 'YES' : 'NO', Reason: m.coc_reason ?? '',
          }], ['Visibility', 'Static', 'Final', 'Abstract', 'Hookable', 'Wrappable', 'CoC wrappable', 'Reason']) + '\n';
        } else {
          out += `${m.coc_reason}${m.suggestions?.length ? ` — did you mean ${m.suggestions.map(s => `\`${s}\``).join(', ')}?` : ''}\n`;
        }
      }
      if (typed.existing_extensions) {
        const e = typed.existing_extensions;
        out += `\n### Existing extensions\n`;
        out += e.classes.length ? formatMarkdownTable(e.classes.map(c => ({ 'Extension class': c.class_name, Module: c.module_id ?? '' })), ['Extension class', 'Module']) : '_No extension class matches the naming heuristic._';
        if (e.table_extension_models.length) out += `\nTable extension models: ${e.table_extension_models.join(', ')}`;
        if (e.sealed_isv_coc?.length) out += '\n\n' + formatMarkdownTable(e.sealed_isv_coc.map(c => ({ 'Sealed ISV wrapper': c.extension_class, Module: c.module, Method: c.method ?? '' })), ['Sealed ISV wrapper', 'Module', 'Method']);
        out += `\n_${e.heuristic_note}_\n`;
      }
      if (typed.proposed_names) {
        out += `\n### Proposed names\n`;
        out += formatMarkdownTable(typed.proposed_names.map(p => ({
          Name: p.name, Identifier: p.valid_identifier ? 'ok' : 'INVALID',
          Collisions: p.collisions.length ? p.collisions.map(c => `${c.object_type}${c.module ? `@${c.module}` : ''}${c.source === 'sealed-isv' ? ' (sealed ISV)' : ''}`).join(', ') : 'none',
          Prefix: p.prefix_ok == null ? 'n/a' : (p.prefix_ok ? 'ok' : 'MISSING'),
        })), ['Name', 'Identifier', 'Collisions', 'Prefix']);
        out += `\n_Prefix rule: ${prefixes.length ? prefixes.join(', ') : 'not configured (KB_NAMING_PREFIXES)'}._\n`;
      }
      return structuredResult(typed, out, format, { coverage: kbCov() });
    },
  );

  // ── d365_knowledge (#128) ──────────────────────────────────────────────────
  let knowledgeCache = null;
  const knowledge = () => (knowledgeCache ??= loadKnowledge(knowledgeDir));
  server.registerTool(
    'd365_knowledge',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description: 'Curated X++ rulebook: Chain of Command rules, extensibility attributes, crossCompany, event handlers vs CoC, SysOperation, form/table extension rules, label ids, common compiler errors. No topic = the topic list.',
      inputSchema: {
        topic: z.string().min(1).max(100).optional().describe('Topic id, alias or keywords (e.g. coc-rules, "next call", crossCompany).'),
        limit: z.number().int().min(1).max(20).optional().default(5).describe('Max matches when searching by keywords.'),
        format: formatTextParam,
      },
      outputSchema: d365KnowledgeOutput.shape,
    },
    async ({ topic, limit: rawLimit, format }) => {
      const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? rawLimit : 5;
      const entries = knowledge();
      const sourceKind = 'curated rulebook shipped with the server code (src/azure/knowledge), independent of the KB snapshot';
      const listRows = (items, withScore) => items.map(e => ({ topic: e.topic, title: e.title, tags: e.tags, ...(withScore ? { score: e.score } : {}) }));
      const renderList = (items) => formatMarkdownTable(items.map(t => ({ Topic: t.topic, Title: t.title, Tags: t.tags.join(', '), ...(t.score != null ? { Score: t.score } : {}) })));

      if (!topic) {
        const typed = { source_kind: sourceKind, query: null, topic_count: entries.length, topics: listRows(entries, false) };
        if (!entries.length) return emptyResult('knowledge topics', typed);
        return structuredResult(typed, `## Knowledge topics (${entries.length})\n\n${renderList(typed.topics)}\n\n_Pass \`topic\` for the full text._\n`, format);
      }
      const key = topic.trim().toLowerCase();
      const exact = entries.find(e => e.topic.toLowerCase() === key || e.aliases.some(a => a.toLowerCase() === key));
      if (exact) {
        const typed = { source_kind: sourceKind, query: topic, topic: exact.topic, title: exact.title, aliases: exact.aliases, tags: exact.tags, sources: exact.sources, body: exact.body };
        let out = `## ${exact.title}\n_Topic: ${exact.topic}${exact.tags.length ? ` · ${exact.tags.join(', ')}` : ''}_\n\n${exact.body}\n`;
        if (exact.sources.length) out += `\nSources: ${exact.sources.join(' · ')}\n`;
        return structuredResult(typed, out, format);
      }
      const terms = key.split(/[\s,;]+/).filter(t => t.length >= 2);
      const scored = entries.map(e => {
        const hay = `${e.topic} ${e.title} ${e.aliases.join(' ')} ${e.tags.join(' ')}`.toLowerCase();
        const body = e.body.toLowerCase();
        let score = 0;
        for (const t of terms) { if (hay.includes(t)) score += 3; if (body.includes(t)) score += 1; }
        return { ...e, score };
      }).filter(e => e.score > 0).sort((a, b) => b.score - a.score || a.topic.localeCompare(b.topic));
      const shown = scored.slice(0, limit);
      const typed = { source_kind: sourceKind, query: topic, topic_count: scored.length, topics: listRows(shown, true) };
      if (!shown.length) return emptyResult(`knowledge topics matching "${topic}"`, typed);
      let out = `## Knowledge topics matching "${topic}" (${scored.length})\n\n${renderList(typed.topics)}\n`;
      if (scored.length > shown.length) out += truncationNote('user', shown.length);
      out += '\n_Pass the topic id for the full text._\n';
      return structuredResult(typed, out, format);
    },
  );
}
