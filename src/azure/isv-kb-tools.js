/**
 * Sealed-ISV KB tools (issues #75, #76, #79, #80, #82).
 *
 * Registered into the KB server alongside `registerKbTools`. They read only the
 * `isv_*` tables, so the existing 17 KB tools are untouched and their answers
 * are byte-identical to before this existed.
 *
 * These are deliberately separate, explicitly named tools rather than a flag on
 * the existing ones. Sealed-ISV data answers a narrower question — it says what
 * an ISV declares and where it hooks in, never what its code does — and mixing
 * those rows into a `d365_lookup_table` result would make that distinction
 * invisible at exactly the moment it matters.
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
  READ_ONLY_DB_ANNOTATIONS,
} from './shared.js';
import {
  hasIsvData,
  isvProvenance,
  isvProvenanceNote,
  noIsvDataProvenance,
} from './isv-schema.js';
import {
  d365IsvListModelsOutput,
  d365IsvLookupOutput,
  d365IsvExtensionPointsOutput,
} from './output-schemas.js';

/** Hard safety ceiling for the extension-point listing. */
const EXT_HARD_MAX = 500;

function parseJson(value, fallback) {
  if (value == null) return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

export function registerIsvKbTools(server, db) {
  const q = (sql, params = []) => query(db, sql, params);
  const available = () => hasIsvData(db);

  // ── d365_isv_list_models ──────────────────────────────────────────────────
  server.registerTool(
    'd365_isv_list_models',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description: 'List the sealed (binary-only) ISV models scanned into this KB — publisher, version, declared dependencies, and what was recovered from each. Sealed models ship no X++ source and no Ax<Type> XML, so they are absent from every other KB tool. Use this to find out which third-party models exist and how much is known about them. Returns both a typed JSON payload (structuredContent) and a Markdown rendering.',
      inputSchema: { format: formatTextParam },
      outputSchema: d365IsvListModelsOutput.shape,
    },
    async ({ format }) => {
      if (!available()) {
        return emptyResult('sealed ISV models scanned into this database', {
          isv_data_available: false,
          model_count: 0,
          models: [],
          provenance: noIsvDataProvenance(),
        });
      }

      let rows;
      try {
        rows = q(`SELECT model, publisher, version, layer, source_kind, fidelity,
                         depends_on, scanned_at, counts
                  FROM isv_models ORDER BY model COLLATE NOCASE`);
      } catch (err) {
        return errorResult('db-error', 'Could not read the sealed-ISV registry.', err);
      }

      if (!rows.length) {
        return emptyResult('sealed ISV models scanned into this database', {
          isv_data_available: true,
          model_count: 0,
          models: [],
          provenance: isvProvenance(db),
        });
      }

      const typed = {
        isv_data_available: true,
        model_count: rows.length,
        models: rows.map(r => ({
          model: String(r.model),
          publisher: r.publisher ?? null,
          version: r.version ?? null,
          layer: r.layer ?? null,
          source_kind: String(r.source_kind ?? 'sealed'),
          fidelity: String(r.fidelity ?? 'metadata'),
          depends_on: parseJson(r.depends_on, []),
          scanned_at: r.scanned_at ?? null,
          counts: parseJson(r.counts, {}),
        })),
        provenance: isvProvenance(db),
      };

      let out = '## Sealed ISV models\n\n';
      out += formatMarkdownTable(typed.models.map(m => ({
        Model: m.model,
        Publisher: m.publisher ?? '',
        Version: m.version ?? '',
        Elements: m.counts.elements ?? 0,
        Labels: m.counts.labels ?? 0,
        References: m.counts.refs ?? 0,
        'CoC': m.counts.coc ?? 0,
        Events: m.counts.events ?? 0,
        Depends: (m.depends_on || []).length,
      })), ['Model', 'Publisher', 'Version', 'Elements', 'Labels', 'References', 'CoC', 'Events', 'Depends']);
      out += isvProvenanceNote(typed.model_count, typed.models.map(m => m.model));

      return structuredResult(typed, out, format);
    }
  );

  // ── d365_isv_lookup ───────────────────────────────────────────────────────
  server.registerTool(
    'd365_isv_lookup',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description: 'Look up an object inside the sealed ISV models: does it exist, in which model, and as which AOT type. Use when a table, class, form, enum — or a FIELD an ISV added to a Microsoft table — is reported as not found by the normal KB tools but is suspected to belong to a third-party model. Set `search_properties` to find an identifier that appears inside an element rather than as its name: that is how an ISV extension field such as `LACTransRefRecId` on `SalesConfirmDetailsTmp` is located, since the KB has no row for it. Sealed models publish an element inventory and the identifiers inside each element, not a resolved field list. Returns both a typed JSON payload (structuredContent) and a Markdown rendering.',
      inputSchema: {
        name: z.string().min(1).max(500).describe('Object name to look for, e.g. "LACReportTable". Matched case-insensitively, exact by default.'),
        element_type: z.string().min(1).max(100).optional().describe('Restrict to one AOT type, e.g. "AxTable", "AxClass", "AxForm", "AxTableExtension".'),
        modules: z.array(z.string().min(1).max(100)).max(20).optional().describe('Restrict to specific sealed ISV models.'),
        prefix_match: z.boolean().optional().default(false).describe('Match names starting with `name` instead of exactly. Useful for exploring an ISV prefix such as "LAC".'),
        search_properties: z.boolean().optional().default(false).describe('Also find elements whose decoded properties contain `name` — use this to locate an ISV-added field on a Microsoft table. Results say which element carries it, never that the name is a field of a given type: sealed metadata proves the identifier is there, not its role.'),
        format: formatTextParam,
      },
      outputSchema: d365IsvLookupOutput.shape,
    },
    async ({ name, element_type, modules, prefix_match, search_properties, format }) => {
      const target = String(name ?? '').trim();
      if (!target) {
        return errorResult('invalid-input', 'Provide an object name to look up.');
      }
      // Defensive defaults: the test mock server bypasses Zod (contract item 13).
      const prefix = prefix_match === true;
      const byProps = search_properties === true;

      if (!available()) {
        return emptyResult(`sealed ISV data for "${target}"`, {
          isv_data_available: false,
          name: target,
          found: false,
          match_count: 0,
          matches: [],
          provenance: noIsvDataProvenance(),
        });
      }

      const where = [prefix ? 'e.name LIKE ? COLLATE NOCASE' : 'e.name = ? COLLATE NOCASE'];
      const params = [prefix ? `${target}%` : target];
      if (element_type) {
        where.push('e.element_type = ? COLLATE NOCASE');
        params.push(String(element_type).trim());
      }
      const mods = Array.isArray(modules) ? modules.filter(Boolean) : [];
      if (mods.length) {
        where.push(`e.module IN (${mods.map(() => '?').join(', ')}) COLLATE NOCASE`);
        params.push(...mods);
      }

      // Matching on the element's own name and on the identifiers inside it are
      // two different questions; the second is what finds an ISV field added to
      // a Microsoft table, so it is a union rather than a fallback.
      const propClause = byProps
        ? ` OR e.id IN (SELECT element_id FROM isv_element_props
                        WHERE value = ? COLLATE NOCASE)`
        : '';
      const propParams = byProps ? [target] : [];

      let rows;
      try {
        rows = q(`SELECT e.id, e.module, e.element_type, e.name, e.blob_size
                  FROM isv_elements e
                  WHERE (${where.join(' AND ')})${propClause}
                  ORDER BY e.module COLLATE NOCASE, e.name COLLATE NOCASE
                  LIMIT ${EXT_HARD_MAX}`, [...params, ...propParams]);
      } catch (err) {
        return errorResult('db-error', `Could not search the sealed-ISV inventory for "${target}".`, err);
      }

      if (!rows.length) {
        // Not an error: "this name is in no sealed ISV model" is a real answer,
        // and the caller usually got here from a not-found elsewhere.
        return emptyResult(`"${target}" in any sealed ISV model`, {
          isv_data_available: true,
          name: target,
          found: false,
          match_count: 0,
          matches: [],
          provenance: isvProvenance(db),
        });
      }

      let props = [];
      try {
        props = q(`SELECT element_id, tag, prop, value FROM isv_element_props
                   WHERE element_id IN (${rows.map(() => '?').join(', ')})`,
        rows.map(r => r.id));
      } catch { /* property decoding is optional — the inventory still stands */ }
      const propsById = new Map();
      for (const p of props) {
        if (!propsById.has(p.element_id)) propsById.set(p.element_id, []);
        propsById.get(p.element_id).push({
          property: p.prop ?? null,
          tag: String(p.tag),
          value: p.value ?? null,
        });
      }

      const typed = {
        isv_data_available: true,
        name: target,
        found: true,
        match_count: rows.length,
        matches: rows.map(r => ({
          module: String(r.module),
          element_type: String(r.element_type),
          name: String(r.name),
          blob_size: r.blob_size == null ? null : Number(r.blob_size),
          properties: propsById.get(r.id) ?? [],
        })),
        provenance: isvProvenance(db),
      };

      let out = `## Sealed ISV lookup: \`${target}\`\n\n`;
      out += formatMarkdownTable(typed.matches.map(m => ({
        Model: m.module,
        Type: m.element_type,
        Name: m.name,
        'Blob bytes': m.blob_size ?? '',
        Properties: m.properties.length,
      })), ['Model', 'Type', 'Name', 'Blob bytes', 'Properties']);

      for (const m of typed.matches) {
        if (!m.properties.length) continue;
        out += `\n### ${m.module} · ${m.element_type} · ${m.name}\n\n`;
        out += formatMarkdownTable(m.properties.map(p => ({
          Property: p.property ?? `(tag ${p.tag})`,
          Value: p.value ?? '',
        })), ['Property', 'Value']);
      }
      if (typed.match_count >= EXT_HARD_MAX) out += truncationNote('hard', EXT_HARD_MAX);
      out += isvProvenanceNote(typed.match_count, [...new Set(typed.matches.map(m => m.module))]);

      return structuredResult(typed, out, format);
    }
  );

  // ── d365_isv_extension_points ─────────────────────────────────────────────
  server.registerTool(
    'd365_isv_extension_points',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description: 'Show where sealed ISV models hook into standard D365FO code: Chain-of-Command wrappers, delegate/event subscriptions, and class/table/EDT extensions. Ask by standard object (which ISVs touch SalesFormLetter?) or by module (everything Lasernet hooks). This is the first question in any upgrade-risk or defect-triage review and cannot be answered by the normal XRef tools for binary-only models. Returns both a typed JSON payload (structuredContent) and a Markdown rendering.',
      inputSchema: {
        target: z.string().min(1).max(500).optional().describe('Standard object the ISV extends, e.g. "SalesFormLetter", "CustTable", "DocuView".'),
        module: z.string().min(1).max(100).optional().describe('Sealed ISV model to list, e.g. "Lasernet". Combine with `target` to narrow further.'),
        limit: z.number().int().min(1).max(EXT_HARD_MAX).optional().default(100).describe(`Max rows per section (default 100, max ${EXT_HARD_MAX}).`),
        format: formatTextParam,
      },
      outputSchema: d365IsvExtensionPointsOutput.shape,
    },
    async ({ target, module, limit, format }) => {
      // Defensive default: Zod's .default() is bypassed by the test mock server.
      const cap = Number.isInteger(limit) && limit > 0 && limit <= EXT_HARD_MAX ? limit : 100;
      const tgt = target ? String(target).trim() : null;
      const mod = module ? String(module).trim() : null;

      if (!tgt && !mod) {
        return errorResult('invalid-input',
          'Provide `target` (a standard object) or `module` (a sealed ISV model), or both.');
      }

      if (!available()) {
        return emptyResult('sealed ISV extension points', {
          isv_data_available: false,
          target: tgt,
          module_filter: mod,
          coc_count: 0,
          event_count: 0,
          extends_count: 0,
          chain_of_command: [],
          event_handlers: [],
          extends: [],
          truncated: false,
          provenance: noIsvDataProvenance(),
        });
      }

      const build = (targetCol) => {
        const w = [];
        const p = [];
        if (tgt) { w.push(`${targetCol} = ? COLLATE NOCASE`); p.push(tgt); }
        if (mod) { w.push('module = ? COLLATE NOCASE'); p.push(mod); }
        return { clause: w.length ? `WHERE ${w.join(' AND ')}` : '', params: p };
      };

      let coc = [];
      let events = [];
      let ext = [];
      try {
        const c = build('target');
        coc = q(`SELECT module, extension_class, target, target_type, method, is_static
                 FROM isv_coc ${c.clause}
                 ORDER BY module COLLATE NOCASE, extension_class COLLATE NOCASE
                 LIMIT ${cap + 1}`, c.params);

        const e = build('delegate_element');
        events = q(`SELECT module, delegate_element, delegate_method,
                           handler_element, handler_method, delegate_type
                    FROM isv_event_handlers ${e.clause}
                    ORDER BY module COLLATE NOCASE, delegate_element COLLATE NOCASE
                    LIMIT ${cap + 1}`, e.params);

        const x = build('parent');
        ext = q(`SELECT module, kind, child, parent
                 FROM isv_extends ${x.clause}
                 ORDER BY module COLLATE NOCASE, child COLLATE NOCASE
                 LIMIT ${cap + 1}`, x.params);
      } catch (err) {
        return errorResult('db-error',
          `Could not read sealed-ISV extension points for ${tgt ?? mod}.`, err);
      }

      const truncated = coc.length > cap || events.length > cap || ext.length > cap;
      coc = coc.slice(0, cap);
      events = events.slice(0, cap);
      ext = ext.slice(0, cap);

      if (!coc.length && !events.length && !ext.length) {
        return emptyResult(
          `sealed ISV extension points for ${tgt ? `\`${tgt}\`` : `module \`${mod}\``}`, {
            isv_data_available: true,
            target: tgt,
            module_filter: mod,
            coc_count: 0,
            event_count: 0,
            extends_count: 0,
            chain_of_command: [],
            event_handlers: [],
            extends: [],
            truncated: false,
            provenance: isvProvenance(db),
          });
      }

      const typed = {
        isv_data_available: true,
        target: tgt,
        module_filter: mod,
        coc_count: coc.length,
        event_count: events.length,
        extends_count: ext.length,
        chain_of_command: coc.map(r => ({
          module: String(r.module),
          extension_class: String(r.extension_class),
          target: r.target ?? null,
          target_type: r.target_type ?? null,
          method: r.method ?? null,
          is_static: r.is_static === 1,
        })),
        event_handlers: events.map(r => ({
          module: String(r.module),
          delegate_element: r.delegate_element ?? null,
          delegate_method: r.delegate_method ?? null,
          handler_element: r.handler_element ?? null,
          handler_method: r.handler_method ?? null,
          direction: r.delegate_type ?? null,
        })),
        extends: ext.map(r => ({
          module: String(r.module),
          kind: String(r.kind),
          child: String(r.child),
          parent: r.parent ?? null,
        })),
        truncated,
        provenance: isvProvenance(db),
      };

      const heading = tgt
        ? `## Sealed ISV extension points for \`${tgt}\``
        : `## Sealed ISV extension points in \`${mod}\``;
      let out = `${heading}\n\n`;

      if (typed.coc_count) {
        out += `### Chain of Command (${typed.coc_count})\n\n`;
        out += formatMarkdownTable(typed.chain_of_command.map(r => ({
          Model: r.module,
          'Extension class': r.extension_class,
          Target: r.target ?? '',
          Method: r.method ?? '(class-level)',
          Static: r.is_static ? 'Y' : '',
        })), ['Model', 'Extension class', 'Target', 'Method', 'Static']);
        out += '\n';
      }
      if (typed.event_count) {
        out += `### Event and delegate subscriptions (${typed.event_count})\n\n`;
        out += formatMarkdownTable(typed.event_handlers.map(r => ({
          Model: r.module,
          Delegate: `${r.delegate_element ?? ''}${r.delegate_method ? `.${r.delegate_method}` : ''}`,
          Handler: `${r.handler_element ?? ''}${r.handler_method ? `.${r.handler_method}` : ''}`,
          Direction: r.direction ?? '',
        })), ['Model', 'Delegate', 'Handler', 'Direction']);
        out += '\n';
      }
      if (typed.extends_count) {
        out += `### Extends (${typed.extends_count})\n\n`;
        out += formatMarkdownTable(typed.extends.map(r => ({
          Model: r.module, Kind: r.kind, Child: r.child, Parent: r.parent ?? '',
        })), ['Model', 'Kind', 'Child', 'Parent']);
      }
      if (truncated) out += truncationNote('cap', cap, EXT_HARD_MAX);

      const modules = [...new Set([
        ...typed.chain_of_command.map(r => r.module),
        ...typed.event_handlers.map(r => r.module),
        ...typed.extends.map(r => r.module),
      ])];
      out += isvProvenanceNote(
        typed.coc_count + typed.event_count + typed.extends_count, modules);

      return structuredResult(typed, out, format);
    }
  );
}
