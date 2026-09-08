/**
 * Labels service tools — `d365fo-labels` (docs/Labels-Service-Concept-2026-09-08.md §3.2).
 *
 *   labels_lookup      ids → text in every stored language + the description (always)
 *   labels_search      text → label ids (FTS5 over every stored language)
 *   labels_where_used  id → XRef usages grouped by property (Label/HelpText/Caption/…/Code)
 *   labels_for_object  object → the label ids it carries, per property, with text
 *
 * Two databases: `db` is d365fo_labels.sqlite (this service's snapshot); `xrefDb`
 * is the XRef snapshot, read-only, optional — the two where-used tools need it and
 * say so (`errorResult('db-error')`) when it is not configured. Nothing here
 * writes, and no label text is ever produced from the KB: the KB kept the resolved
 * en-US text only, the id lives in the XRef graph (`Type/Object[/Element]?Property`).
 *
 * Casing: `labels` has ~29M rows under a BINARY unique index, so a case-tolerant
 * lookup goes through `label_meta` (383k rows, NOCASE index) to recover the
 * canonical id, then hits `labels` with the exact id.
 */
import { z } from 'zod';
import {
  query, formatMarkdownTable, structuredResult, emptyResult, notFoundResult, errorResult,
  coverageNotes, READ_ONLY_DB_ANNOTATIONS, formatTextParam, modulesFilterParam, sanitizeModulesFilter, truncationNote,
} from './shared.js';
import { installToolGuards } from './tool-guards.js';
import { cursorParam, decodeCursor, pageMeta, pageNote, probeLimit, takePage } from './pagination.js';
import { labelsLookupOutput, labelsSearchOutput, labelsWhereUsedOutput, labelsForObjectOutput } from './output-schemas.js';
import { normalizeLabelIdInput } from '../../build/label-files.js';

const LABEL_ID_INPUT = z.string().min(2).max(200);

/** XRef path prefixes per friendly object type. `null` = the caller passed a raw XRef type token. */
const OBJECT_TYPE_PREFIXES = Object.freeze({
  table: ['Table'], form: ['Form'], enum: ['Enum'], view: ['View'], report: ['Report'], query: ['Query'],
  map: ['Map'], entity: ['DataEntityView'], data_entity: ['DataEntityView'], menu: ['Menu'],
  menu_item: ['MenuItemDisplay', 'MenuItemAction', 'MenuItemOutput'],
  privilege: ['SecurityPrivilege'], duty: ['SecurityDuty'], role: ['SecurityRole'],
  edt: ['EdtString', 'EdtInt', 'EdtInt64', 'EdtReal', 'EdtDate', 'EdtUtcDateTime', 'EdtEnum', 'EdtContainer', 'EdtGuid', 'EdtTime'],
  class: ['/Classes'],
});

/** XRef code-path type folders → the singular token the metadata paths use. */
const CODE_TYPE_SINGULAR = Object.freeze({
  Classes: 'Class', Tables: 'Table', Forms: 'Form', Enums: 'Enum', Queries: 'Query', Views: 'View', Maps: 'Map',
  DataEntityViews: 'DataEntityView', Reports: 'Report', Edts: 'Edt',
});

/**
 * `Table/CustTable/TableFieldString/AccountNum?Label` → object_type/name/element/property.
 * `/Classes/Foo/Methods/bar` (a code use) → element = method, property null, kind Code.
 * Exported for tests.
 */
export function parseXrefSourcePath(path) {
  const p = String(path ?? '');
  if (p.startsWith('/')) {
    const seg = p.split('/').filter(Boolean); // ['Classes','Foo','Methods','bar']
    const type = CODE_TYPE_SINGULAR[seg[0]] ?? (seg[0] ?? '').replace(/s$/, '');
    return { object_type: type || null, object_name: seg[1] ?? null, element: seg.length > 3 ? seg.slice(3).join('/') : (seg[2] ?? null), property: null, kind: 'Code' };
  }
  const qi = p.indexOf('?');
  const property = qi >= 0 ? p.slice(qi + 1) : null;
  const seg = (qi >= 0 ? p.slice(0, qi) : p).split('/');
  return {
    object_type: seg[0] || null,
    object_name: seg[1] ?? null,
    element: seg.length > 2 ? seg[seg.length - 1] : null,
    property,
    kind: 'Property',
  };
}

function tableExists(db, name) {
  try { return !!db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(name); } catch { return false; }
}

function metaValue(db, key) {
  try { return db.prepare('SELECT value FROM labels_metadata WHERE key = ?').get(key)?.value ?? null; } catch { return null; }
}

/** Half-open range that the BINARY `idx_names_path` can serve: `P`, `P/…`, `P?…`. */
function pathRangeClause(prefixes) {
  return { sql: `(${prefixes.map(() => '(n2.path >= ? AND n2.path < ?)').join(' OR ')})`, params: prefixes.flatMap(p => [p, `${p}~`]) };
}

/**
 * @param {any} server  McpServer (or a compatible mock)
 * @param {any} db      better-sqlite3 handle on d365fo_labels.sqlite
 * @param {{ xrefDb?: any|null }} [opts]
 */
export function registerLabelsTools(server, db, { xrefDb = null } = {}) {
  server = installToolGuards(server, { service: 'labels', db });
  const q = (sql, params = []) => query(db, sql, params);
  const xq = (sql, params = []) => query(xrefDb, sql, params);

  const partialSince = metaValue(db, 'partial_build');
  const cov = (signals = {}) => coverageNotes({ ...signals, partial_build: partialSince ? { since: partialSince, service: 'labels' } : null });
  const hasFts = tableExists(db, 'labels_fts');

  /** Canonical meta rows for a list of ids (case-tolerant via label_meta). */
  const metaFor = (ids) => {
    if (!ids.length) return [];
    return q(`SELECT label_id, label_file, module, origin, description FROM label_meta
              WHERE label_id COLLATE NOCASE IN (${ids.map(() => '?').join(', ')}) ORDER BY label_id`, ids);
  };
  const textsFor = (canonicalIds, langs) => {
    if (!canonicalIds.length) return [];
    const params = [...canonicalIds];
    let sql = `SELECT label_id, language, text FROM labels WHERE label_id IN (${canonicalIds.map(() => '?').join(', ')})`;
    if (langs && langs.length) { sql += ` AND language COLLATE NOCASE IN (${langs.map(() => '?').join(', ')})`; params.push(...langs); }
    sql += ' ORDER BY label_id, language';
    return q(sql, params);
  };
  const noXref = () => errorResult('db-error', 'XRef database not available on this server — label where-used needs XREF_DB_PATH (the XRef snapshot) next to the labels snapshot.');

  // ── 1. labels_lookup ─────────────────────────────────────────────────────────
  server.registerTool(
    'labels_lookup',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description: 'Label ids → text in every stored language (or the languages given) plus the developer description, file, module and origin. Accepts @SYS154828, SYS154828, @File:Key. One id is a batch of one.',
      inputSchema: {
        label_ids: z.array(LABEL_ID_INPUT).min(1).max(100),
        languages: z.array(z.string().min(2).max(10)).min(1).max(80).optional().describe('Omit for every stored language.'),
        format: formatTextParam,
      },
      outputSchema: labelsLookupOutput.shape,
    },
    async ({ label_ids, languages, format }) => {
      const raw = Array.isArray(label_ids) ? label_ids : [];
      const invalid = [];
      const ids = [...new Set(raw.map(s => { const n = normalizeLabelIdInput(s); if (!n) invalid.push(String(s)); return n; }).filter(Boolean))];
      if (!ids.length) return errorResult('invalid-input', 'No valid label id: expected "@SYS154828", "SYS154828" or "@File:Key".');
      const langs = Array.isArray(languages) && languages.length ? [...new Set(languages.map(String))] : null;

      const meta = metaFor(ids);
      if (!meta.length) return notFoundResult('label', ids.join(', '), []);
      const foundLower = new Set(meta.map(m => m.label_id.toLowerCase()));
      const notFound = [...ids.filter(i => !foundLower.has(i.toLowerCase())), ...invalid];
      const rows = textsFor(meta.map(m => m.label_id), langs);

      const typed = {
        requested_count: ids.length + invalid.length,
        found_count: meta.length,
        not_found: notFound,
        languages_present: [...new Set(rows.map(r => r.language))].sort(),
        meta: meta.map(m => ({ label_id: m.label_id, label_file: m.label_file, module: m.module, origin: m.origin, description: m.description ?? null })),
        labels: rows.map(r => ({ label_id: r.label_id, language: r.language, text: r.text })),
      };
      if (langs) {
        const have = new Map();
        for (const r of rows) { if (!have.has(r.label_id)) have.set(r.label_id, new Set()); have.get(r.label_id).add(r.language.toLowerCase()); }
        typed.languages_missing = meta
          .map(m => ({ label_id: m.label_id, languages: langs.filter(l => !(have.get(m.label_id)?.has(l.toLowerCase()))) }))
          .filter(x => x.languages.length);
      }

      let out = '## Label lookup\n\n';
      out += formatMarkdownTable(typed.meta.map(m => ({ 'Label ID': m.label_id, File: m.label_file, Module: m.module, Origin: m.origin, Description: m.description ?? '' })));
      out += '\n\n';
      out += formatMarkdownTable(typed.labels.map(r => ({ 'Label ID': r.label_id, Language: r.language, Text: r.text })));
      out += '\n';
      if (typed.not_found.length) out += `\n**Not found:** ${typed.not_found.join(', ')}`;
      if (typed.languages_missing?.length) out += `\n**Missing translations:** ${typed.languages_missing.map(x => `${x.label_id} (${x.languages.join(', ')})`).join('; ')}`;
      return structuredResult(typed, out, format, { coverage: cov() });
    }
  );

  // ── 2. labels_search ─────────────────────────────────────────────────────────
  server.registerTool(
    'labels_search',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description: 'Reverse lookup: label TEXT → label ids, across every stored language (full-text, prefix match per word). Narrow with language, label_file, modules or origin; page with cursor.',
      inputSchema: {
        text: z.string().min(2).max(200),
        language: z.string().min(2).max(10).optional(),
        label_file: z.string().min(1).max(100).optional(),
        modules: modulesFilterParam,
        origin: z.enum(['microsoft', 'isv', 'custom']).optional(),
        limit: z.number().int().min(1).max(100).default(20),
        cursor: cursorParam,
        format: formatTextParam,
      },
      outputSchema: labelsSearchOutput.shape,
    },
    async ({ text, language, label_file, modules, origin, limit, cursor, format }) => {
      const lim = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 20;
      const term = String(text ?? '').trim();
      if (term.length < 2) return errorResult('invalid-input', 'Search text needs at least 2 characters.');
      const page = decodeCursor(cursor);
      if (!page.ok) return page.error;
      const moduleFilter = sanitizeModulesFilter(modules);

      const where = [];
      const params = [];
      if (language) { where.push('l.language = ? COLLATE NOCASE'); params.push(language); }
      if (label_file) { where.push('m.label_file = ? COLLATE NOCASE'); params.push(label_file); }
      if (moduleFilter.length) { where.push(`m.module COLLATE NOCASE IN (${moduleFilter.map(() => '?').join(', ')})`); params.push(...moduleFilter); }
      if (origin) { where.push('m.origin = ?'); params.push(origin); }
      const extra = where.length ? ` AND ${where.join(' AND ')}` : '';

      let rows;
      try {
        if (hasFts) {
          const ftsExpr = term.split(/\s+/).filter(Boolean).map(t => `"${t.replace(/"/g, '""')}"*`).join(' ');
          rows = q(`SELECT l.label_id, l.language, l.text, m.label_file, m.module, m.description
                    FROM labels_fts f JOIN labels l ON l.rowid = f.rowid JOIN label_meta m ON m.label_id = l.label_id
                    WHERE labels_fts MATCH ?${extra} ORDER BY f.rank, l.rowid LIMIT ? OFFSET ?`,
          [ftsExpr, ...params, probeLimit(lim), page.offset]);
        } else {
          rows = q(`SELECT l.label_id, l.language, l.text, m.label_file, m.module, m.description
                    FROM labels l JOIN label_meta m ON m.label_id = l.label_id
                    WHERE l.text LIKE ? ESCAPE '\\'${extra} ORDER BY l.rowid LIMIT ? OFFSET ?`,
          [`%${term.replace(/[\\%_]/g, '\\$&')}%`, ...params, probeLimit(lim), page.offset]);
        }
      } catch (err) {
        return errorResult('db-error', 'Try a shorter or more specific search text.', err);
      }
      const { rows: pageRows, has_more } = takePage(rows, lim);
      const typed = {
        query: term,
        language: language ?? null,
        result_count: pageRows.length,
        results: pageRows.map(r => ({ label_id: r.label_id, language: r.language, text: r.text, label_file: r.label_file, module: r.module, description: r.description ?? null })),
        ...pageMeta(null, page.offset, pageRows.length, lim, has_more),
      };
      if (!pageRows.length) return emptyResult(`labels matching "${term}"`, typed);
      let out = `## Label search: ${term}\n\n`;
      out += formatMarkdownTable(typed.results.map(r => ({ 'Label ID': r.label_id, Language: r.language, Text: r.text, File: r.label_file, Description: r.description ?? '' })));
      out += '\n';
      if (typed.has_more) out += pageNote(typed.result_count, page.offset, typed.next_cursor);
      return structuredResult(typed, out, format, { coverage: cov() });
    }
  );

  // ── 3. labels_where_used ─────────────────────────────────────────────────────
  server.registerTool(
    'labels_where_used',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description: 'Where a label is used (XRef graph): object, element and PROPERTY (Label, HelpText, Caption, DeveloperDocumentation, …, or Code for X++ uses), with counts per property and the label text + description. Filter by property or object_type; page with cursor.',
      inputSchema: {
        label_id: LABEL_ID_INPUT,
        property: z.string().min(1).max(60).optional().describe('e.g. Label, HelpText, Caption, Code'),
        object_type: z.string().min(1).max(40).optional().describe('XRef type token or friendly name: table, form, enum, class, entity, menu_item, privilege, duty, edt'),
        limit: z.number().int().min(1).max(200).default(50),
        cursor: cursorParam,
        format: formatTextParam,
      },
      outputSchema: labelsWhereUsedOutput.shape,
    },
    async ({ label_id, property, object_type, limit, cursor, format }) => {
      const lim = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 200) : 50;
      const id = normalizeLabelIdInput(label_id);
      if (!id) return errorResult('invalid-input', 'Expected a label id like "@SYS154828" or "@File:Key".');
      if (!xrefDb) return noXref();
      const page = decodeCursor(cursor);
      if (!page.ok) return page.error;

      const meta = metaFor([id])[0] ?? null;
      const canonical = meta?.label_id ?? id;
      const name = xq('SELECT id, path FROM names WHERE path = ? LIMIT 1', [`/Labels/${canonical}`])[0]
        ?? xq('SELECT id, path FROM names WHERE path = ? COLLATE NOCASE LIMIT 1', [`/Labels/${id}`])[0];
      if (!name && !meta) return notFoundResult('label', id, []);

      const text = meta ? (textsFor([canonical], ['en-US'])[0]?.text ?? textsFor([canonical], null)[0]?.text ?? null) : null;
      const head = { label_id: canonical, text, description: meta?.description ?? null };
      if (!name) {
        return emptyResult(`usages of ${canonical} in the XRef snapshot`, { ...head, total_count: 0, property_counts: [], usages: [], has_more: false });
      }

      const where = ['r.target_id = ?'];
      const params = [name.id];
      if (property) {
        if (property.toLowerCase() === 'code') where.push("n2.path LIKE '/%'");
        else { where.push("n2.path LIKE ? ESCAPE '\\'"); params.push(`%?${property.replace(/[\\%_]/g, '\\$&')}`); }
      }
      if (object_type) {
        const prefixes = OBJECT_TYPE_PREFIXES[object_type.toLowerCase()] ?? [object_type];
        where.push(`(${prefixes.map(() => "n2.path LIKE ? ESCAPE '\\'").join(' OR ')})`);
        params.push(...prefixes.map(p => `${p.replace(/[\\%_]/g, '\\$&')}${p.startsWith('/') ? '/' : ''}%`));
      }
      const w = where.join(' AND ');
      let total, counts, rows;
      try {
        total = xq(`SELECT COUNT(*) n FROM refs r JOIN names n2 ON n2.id = r.source_id WHERE ${w}`, params)[0]?.n ?? 0;
        counts = xq(`SELECT CASE WHEN instr(n2.path, '?') > 0 THEN substr(n2.path, instr(n2.path, '?') + 1) ELSE 'Code' END AS property, COUNT(*) AS count
                     FROM refs r JOIN names n2 ON n2.id = r.source_id WHERE r.target_id = ? GROUP BY 1 ORDER BY count DESC, property`, [name.id]);
        rows = xq(`SELECT n2.path AS source, r.kind FROM refs r JOIN names n2 ON n2.id = r.source_id WHERE ${w} ORDER BY n2.path, r.kind LIMIT ? OFFSET ?`,
          [...params, probeLimit(lim), page.offset]);
      } catch (err) {
        return errorResult('db-error', 'XRef query failed — retry with a property or object_type filter.', err);
      }
      const { rows: pageRows, has_more } = takePage(rows, lim);
      const typed = {
        ...head,
        total_count: Number(total),
        property_counts: counts.map(c => ({ property: c.property, count: Number(c.count) })),
        usages: pageRows.map(r => parseXrefSourcePath(r.source)),
        ...pageMeta(null, page.offset, pageRows.length, lim, has_more),
      };
      if (!pageRows.length) return emptyResult(`usages of ${canonical}${property || object_type ? ' with that filter' : ''}`, typed);

      let out = `## Label where-used: ${canonical}\n\n`;
      out += `**Text:** ${text ?? '(not in labels snapshot)'}  \n**Description:** ${head.description ?? '—'}  \n**Usages:** ${typed.total_count}\n\n`;
      out += formatMarkdownTable(typed.property_counts.map(c => ({ Property: c.property, Count: c.count })));
      out += '\n\n';
      out += formatMarkdownTable(typed.usages.map(u => ({ Type: u.object_type ?? '', Object: u.object_name ?? '', Element: u.element ?? '', Property: u.property ?? '', Kind: u.kind })));
      out += '\n';
      if (typed.has_more) out += pageNote(typed.usages.length, page.offset, typed.next_cursor);
      return structuredResult(typed, out, format, { coverage: cov() });
    }
  );

  // ── 4. labels_for_object ─────────────────────────────────────────────────────
  server.registerTool(
    'labels_for_object',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description: 'The labels an object carries (XRef graph): element, property, label id and text per language (default en-US) with the description. object_type: table, form, enum, class, entity, menu_item, privilege, duty, edt, or an XRef type token.',
      inputSchema: {
        object_type: z.string().min(1).max(40),
        object_name: z.string().min(1).max(200),
        languages: z.array(z.string().min(2).max(10)).min(1).max(80).default(['en-US']),
        properties: z.array(z.string().min(1).max(60)).min(1).max(20).optional(),
        limit: z.number().int().min(1).max(500).default(200),
        format: formatTextParam,
      },
      outputSchema: labelsForObjectOutput.shape,
    },
    async ({ object_type, object_name, languages, properties, limit, format }) => {
      const lim = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 500) : 200;
      const langs = Array.isArray(languages) && languages.length ? [...new Set(languages.map(String))] : ['en-US'];
      if (!xrefDb) return noXref();
      const typeKey = String(object_type ?? '').toLowerCase();
      const prefixes = OBJECT_TYPE_PREFIXES[typeKey] ?? [String(object_type)];
      const name = String(object_name ?? '').trim();
      if (!name) return errorResult('invalid-input', 'object_name is required.');
      const roots = prefixes.map(p => (p.startsWith('/') ? `${p}/${name}` : `${p}/${name}`));
      const range = pathRangeClause(roots);

      let rows;
      try {
        rows = xq(`SELECT n2.path AS source, n.path AS label_path FROM refs r
                   JOIN names n2 ON n2.id = r.source_id JOIN names n ON n.id = r.target_id
                   WHERE ${range.sql} AND n.path >= '/Labels/' AND n.path < '/Labels0'
                   ORDER BY n2.path LIMIT ?`, [...range.params, 5000]);
      } catch (err) {
        return errorResult('db-error', 'XRef query failed for that object.', err);
      }
      // The range also admits `Table/CustTableX…` — keep exact object paths only.
      const isOurs = (src) => roots.some(r => src === r || src.startsWith(`${r}/`) || src.startsWith(`${r}?`));
      let usages = rows.filter(r => isOurs(r.source)).map(r => ({ ...parseXrefSourcePath(r.source), label_id: r.label_path.slice('/Labels/'.length) }));
      // Object-level properties first, then elements alphabetically — the path order
      // would put `Table/X/Field?…` ('/') before `Table/X?Label` ('?').
      usages.sort((a, b) => (a.element === null) === (b.element === null)
        ? `${a.element ?? ''} ${a.property ?? ''}`.localeCompare(`${b.element ?? ''} ${b.property ?? ''}`)
        : (a.element === null ? -1 : 1));
      if (properties?.length) {
        const want = new Set(properties.map(p => p.toLowerCase()));
        usages = usages.filter(u => want.has((u.property ?? 'code').toLowerCase()));
      }
      if (!usages.length) {
        const exists = xq(`SELECT 1 FROM names n2 WHERE ${range.sql} LIMIT 1`, range.params).length > 0;
        if (!exists) return notFoundResult('object', `${object_type} ${name}`, []);
        return emptyResult(`labels on ${object_type} ${name}`, { object_type: String(object_type), object_name: name, languages: langs, label_count: 0, labels: [] });
      }
      const truncated = usages.length > lim;
      usages = usages.slice(0, lim);
      const ids = [...new Set(usages.map(u => u.label_id))];
      const texts = new Map(textsFor(ids, langs).map(r => [`${r.label_id}\u0000${r.language}`, r.text]));
      const desc = new Map(metaFor(ids).map(m => [m.label_id.toLowerCase(), m.description ?? null]));
      const labels = [];
      for (const u of usages) {
        for (const lang of langs) {
          labels.push({ element: u.element ?? null, property: u.property ?? 'Code', label_id: u.label_id, language: lang, text: texts.get(`${u.label_id}\u0000${lang}`) ?? null, description: desc.get(u.label_id.toLowerCase()) ?? null });
        }
      }
      const typed = { object_type: String(object_type), object_name: name, languages: langs, label_count: usages.length, truncated, labels };
      let out = `## Labels on ${object_type} ${name}\n\n`;
      out += formatMarkdownTable(labels.map(l => ({ Element: l.element ?? '', Property: l.property, 'Label ID': l.label_id, Language: l.language, Text: l.text ?? '', Description: l.description ?? '' })));
      out += '\n';
      if (truncated) out += truncationNote('user', lim);
      return structuredResult(typed, out, format, { coverage: cov() });
    }
  );
}
