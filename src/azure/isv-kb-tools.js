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
  hasIsvIlData,
  isvProvenance,
  isvProvenanceNote,
  isvIlProvenance,
  isvIlProvenanceNote,
  noIsvDataProvenance,
} from './isv-schema.js';
import {
  d365IsvListModelsOutput,
  d365IsvLookupOutput,
  d365IsvExtensionPointsOutput,
} from './output-schemas.js';

/** Hard safety ceiling for the extension-point listing. */
const EXT_HARD_MAX = 500;

/** Hard ceiling on signature rows in one response (issue #81). A sealed type
 *  can carry hundreds of methods and the point is to answer a contract
 *  question, not to dump an assembly. */
const SIG_HARD_MAX = 300;

/**
 * Render one `isv_il_methods` row as the typed signature payload.
 *
 * Deliberately dumb: it reshapes a row and does not interpret it. There is no
 * "what this method probably does" field, because the row does not contain that
 * and a plausible guess in a typed payload is indistinguishable from a fact.
 */
function toSignature(row) {
  return {
    module: String(row.module),
    assembly: row.assembly ?? null,
    namespace: row.namespace ?? null,
    type_name: String(row.type_name),
    method_name: String(row.method_name),
    kind: row.kind ?? null,
    return_type: row.return_type ?? null,
    parameters: parseJson(row.parameters, []),
    visibility: row.visibility ?? null,
    is_static: Boolean(row.is_static),
    is_abstract: Boolean(row.is_abstract),
    is_virtual: Boolean(row.is_virtual),
    is_final: Boolean(row.is_final),
    has_implementation: Boolean(row.has_implementation),
    attributes: parseJson(row.attributes, []),
    fidelity: 'il',
  };
}

/** `public static void Foo.bar(int _a, str _b [optional])` — one line, the way
 *  a developer would write the declaration. */
function formatSignature(sig) {
  const mods = [
    sig.visibility,
    sig.is_static ? 'static' : null,
    sig.is_abstract ? 'abstract' : null,
    sig.is_final ? 'final' : null,
  ].filter(Boolean).join(' ');
  const params = sig.parameters
    .map(p => `${p.type} ${p.name}${p.optional ? ' [optional]' : ''}`)
    .join(', ');
  return `${mods} ${sig.return_type ?? '?'} ${sig.method_name}(${params})`.trim();
}

/**
 * Typical Windows SDK location of `ildasm.exe`. Emitted as a hint, not as an
 * assertion: the SDK version directory varies per machine, so the command also
 * works from a Developer Command Prompt where `ildasm` is already on PATH.
 */
const ILDASM_HINT =
  'C:\\Program Files (x86)\\Microsoft SDKs\\Windows\\v10.0A\\bin\\NETFX 4.8 Tools\\x64\\ildasm.exe';

/** Windows-style path for a command line the operator will paste into a shell. */
function winPath(...parts) {
  return parts.filter(Boolean).join('/').replace(/\/+/g, '/').replace(/\//g, '\\');
}

/**
 * Build the local disassembly commands for a sealed type (issue #81).
 *
 * This deliberately returns *commands*, never output. The KB stores no IL body
 * and this project decompiles nothing — see the constraint in issue #81 and the
 * static-scan tests in `test/pe-metadata.test.js`. What it can usefully do is
 * stop the trail going cold: when a caller has the signature and needs the
 * behaviour, the honest next step is a one-off local read they run themselves,
 * under their own authority and their vendor agreement, and this hands them the
 * exact invocation for the exact assembly instead of leaving them to find it.
 *
 * Gated behind an explicit `include_il_command` on every tool that emits it, so
 * a normal lookup never carries it.
 *
 * Two tools because they answer different questions:
 *   - `ildasm` emits **IL assembly** and reads a `.netmodule` directly, which is
 *     where X++ classes actually live. Ships with the Windows SDK.
 *   - `ilspycmd` emits **reconstructed C#**, which is easier to read but is a
 *     translation, not the artefact. It targets the `.dll`; a bare `.netmodule`
 *     is commonly not loadable on its own.
 *
 * @param {Array<object>} sigs   signature rows (for module / assembly / type)
 * @param {Map<string,string>} rootByModule  isv_models.root per module
 * @returns {{available:boolean, note:string, targets:Array<object>}}
 */
function buildIlCommands(sigs, rootByModule) {
  const seen = new Set();
  const targets = [];
  for (const sig of sigs) {
    if (!sig.assembly) continue;
    const key = `${sig.module}|${sig.assembly}|${sig.namespace ?? ''}|${sig.type_name}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const root = rootByModule.get(String(sig.module).toLowerCase());
    const assemblyPath = root
      ? winPath(root, sig.module, 'bin', sig.assembly)
      : winPath('<metadata-root>', sig.module, 'bin', sig.assembly);
    const qualified = sig.namespace ? `${sig.namespace}.${sig.type_name}` : sig.type_name;
    const isNetmodule = /\.netmodule$/i.test(sig.assembly);
    const dll = `Dynamics.AX.${sig.module}.dll`;

    targets.push({
      module: String(sig.module),
      assembly: String(sig.assembly),
      assembly_path: assemblyPath,
      qualified_type: qualified,
      // Options before the filename make ildasm report "MULTIPLE INPUT FILES
      // SPECIFIED"; the file must come first.
      ildasm: `& "${ILDASM_HINT}" "${assemblyPath}" /text /noca /item="${qualified}"`,
      ilspycmd_install: 'dotnet tool install -g ilspycmd',
      ilspycmd: `ilspycmd -t ${qualified} "${root ? winPath(root, sig.module, 'bin', dll) : dll}"`,
      ilspycmd_caveat: isNetmodule
        ? `The declaring image is a .netmodule; ILSpy commonly cannot load one standalone, `
          + `so the ilspycmd line targets ${dll} and may not resolve this type. `
          + `Prefer the ildasm line for a .netmodule.`
        : null,
    });
  }
  return {
    available: targets.length > 0,
    note: 'This database contains no IL, no method body and no source text — only signatures. '
      + 'These commands are for the operator to run locally, on a machine that already holds '
      + 'the vendor package, and their use is subject to the vendor licence agreement. '
      + 'ildasm emits IL assembly; ilspycmd emits reconstructed C#, which is a translation '
      + 'rather than the shipped artefact.',
    targets,
  };
}

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

  /** module (lower-cased) -> the metadata root it was scanned from, so an IL
   *  command can name the real assembly path rather than a placeholder. */
  const rootByModule = () => {
    const map = new Map();
    try {
      for (const r of q('SELECT model, root FROM isv_models')) {
        if (r.root) map.set(String(r.model).toLowerCase(), String(r.root));
      }
    } catch { /* pre-ISV database — commands fall back to <metadata-root> */ }
    return map;
  };

  // ── d365_isv_list_models ──────────────────────────────────────────────────
  server.registerTool(
    'd365_isv_list_models',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description: 'List the sealed (binary-only) ISV models scanned into this KB — publisher, version, declared dependencies, what was recovered. Sealed models ship no X++ source and no Ax<Type> XML, so they are absent from every other KB tool.',
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
      description: 'Look up an object in the sealed ISV models: exists, in which model, as which AOT type. Use when the normal KB tools report a table, class, form, enum — or an ISV-added FIELD on a Microsoft table — as not found. `search_properties` finds an identifier inside an element, which is how an ISV extension field is located (sealed models publish no resolved field list).',
      inputSchema: {
        name: z.string().min(1).max(500).describe('Object name to look for, e.g. "LACReportTable". Matched case-insensitively, exact by default.'),
        element_type: z.string().min(1).max(100).optional().describe('Restrict to one AOT type, e.g. "AxTable", "AxClass", "AxForm", "AxTableExtension".'),
        modules: z.array(z.string().min(1).max(100)).max(20).optional().describe('Restrict to specific sealed ISV models.'),
        prefix_match: z.boolean().optional().default(false).describe('Match names starting with `name` instead of exactly. Useful for exploring an ISV prefix such as "LAC".'),
        search_properties: z.boolean().optional().default(false).describe('Also match elements whose decoded properties contain `name` — locates an ISV-added field on a Microsoft table. Proves the identifier is there, not its role.'),
        include_signatures: z.boolean().optional().default(false).describe('Also return method signatures from the sealed assembly metadata (fidelity=il): parameter names/types, return type, modifiers — what a CoC wrapper must match. Signatures only: no body is decompiled or stored, so behaviour is unknown.'),
        include_il_command: z.boolean().optional().default(false).describe('Return the local disassembly command for the matched type — ONLY when the user explicitly asked for IL or a method body. Commands, not code: this database holds no IL or source; running them is the operator\'s own action under the vendor licence.'),
        format: formatTextParam,
      },
      outputSchema: d365IsvLookupOutput.shape,
    },
    async ({ name, element_type, modules, prefix_match, search_properties, include_signatures, include_il_command, format }) => {
      const target = String(name ?? '').trim();
      if (!target) {
        return errorResult('invalid-input', 'Provide an object name to look up.');
      }
      // Defensive defaults: the test mock server bypasses Zod (contract item 13).
      const prefix = prefix_match === true;
      const byProps = search_properties === true;
      // Asking for the IL command implies wanting the signatures it targets:
      // the command is built from the declaring assembly, which only the
      // signature rows know. Requesting it alone would silently return nothing.
      const wantIlCmd = include_il_command === true;
      const wantSigs = include_signatures === true || wantIlCmd;

      if (!available()) {
        return emptyResult(`sealed ISV data for "${target}"`, {
          isv_data_available: false,
          name: target,
          found: false,
          match_count: 0,
          matches: [],
          signatures_available: false,
          signature_count: 0,
          signatures: [],
          il_provenance: null,
          il_command: null,
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
          signatures_available: false,
          signature_count: 0,
          signatures: [],
          il_provenance: null,
          il_command: null,
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

      // Signatures are keyed by *type name*, not by element row: the assembly
      // knows `AmcBankWSRequestPaym`, not "the AxClass element whose row id is
      // 42". Matching on the names already found keeps the two passes
      // independent, so a database with only one of them still answers.
      let signatures = [];
      const sigsAvailable = wantSigs && hasIsvIlData(db);
      if (sigsAvailable) {
        const names = [...new Set(rows.map(r => String(r.name)))];
        try {
          // Accessors are excluded: a get/set pair is not an answer to "what
          // does this method take", and they outnumber the real methods. The
          // rows stay in the database for the field-list question, which is a
          // different question and needs its own tool.
          signatures = q(
            `SELECT module, assembly, namespace, type_name, method_name, kind,
                    return_type, parameters, visibility, is_static, is_abstract,
                    is_virtual, is_final, has_implementation, attributes
             FROM isv_il_methods
             WHERE type_name IN (${names.map(() => '?').join(', ')}) COLLATE NOCASE
               AND (kind IS NULL OR kind <> 'accessor')
             ORDER BY namespace COLLATE NOCASE, type_name COLLATE NOCASE,
                      method_name COLLATE NOCASE, param_count
             LIMIT ${SIG_HARD_MAX}`, names).map(toSignature);
        } catch {
          // A database predating the IL pass, or a partially built one: the
          // metadata answer above stands on its own and is still returned.
          signatures = [];
        }
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
        signatures_available: sigsAvailable,
        signature_count: signatures.length,
        signatures,
        il_provenance: signatures.length ? isvIlProvenance(db) : null,
        il_command: (wantIlCmd && signatures.length)
          ? buildIlCommands(signatures, rootByModule())
          : null,
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

      if (wantSigs && !sigsAvailable) {
        out += '\n_No IL signatures in this database: the assembly-metadata pass '
          + '(issue #81) is off by default. Rebuild with `ISV_IL_SCAN=1`, or run '
          + '`node build/isv-scan.js --il --kb <db>`, to populate it._\n';
      } else if (typed.signatures.length) {
        // Its own section under its own heading, never interleaved with the
        // metadata rows above: the two fidelities answer different questions
        // and a merged table would hide which is which.
        // Grouped by namespace *and* type: a sealed model routinely declares
        // `Foo` as both a table (Dynamics.AX.Application) and the form of the
        // same name (…​.Application.Forms). Grouping on the bare type name makes
        // two different objects look like one with duplicate methods.
        const byType = new Map();
        for (const sig of typed.signatures) {
          const key = sig.namespace ? `${sig.namespace}.${sig.type_name}` : sig.type_name;
          if (!byType.has(key)) byType.set(key, []);
          byType.get(key).push(sig);
        }
        for (const [typeName, sigs] of byType) {
          out += `\n### Method signatures · ${typeName} _(fidelity=il)_\n\n`;
          out += formatMarkdownTable(sigs.map(sig => ({
            Signature: formatSignature(sig),
            Virtual: sig.is_virtual ? 'Y' : '',
            Final: sig.is_final ? 'Y' : '',
            Attributes: sig.attributes.join(', '),
          })), ['Signature', 'Virtual', 'Final', 'Attributes']);
          out += '\n';
        }
        if (typed.signatures.length >= SIG_HARD_MAX) out += truncationNote('hard', SIG_HARD_MAX);
        out += isvIlProvenanceNote(typed.signatures.length,
          [...new Set(typed.signatures.map(sig => sig.module))]);
      }

      if (typed.il_command?.available) {
        out += '\n### Obtaining the IL locally\n\n';
        out += `_${typed.il_command.note}_\n`;
        for (const t of typed.il_command.targets) {
          out += `\n#### ${t.qualified_type}\n\nDeclared in \`${t.assembly}\`.\n`;
          // Labels go in prose rather than as shell comments inside the fence:
          // a line-initial '#' in a PowerShell comment reads as a Markdown H1
          // to the response-format scan (contract rule #3), and prose is the
          // better place for them anyway.
          out += '\nIL assembly, via the Windows SDK — reads a `.netmodule` directly:\n\n';
          out += `\`\`\`powershell\n${t.ildasm}\n\`\`\`\n`;
          out += '\nReconstructed C#, via ILSpy — a translation, not the shipped artefact:\n\n';
          out += `\`\`\`powershell\n${t.ilspycmd_install}\n${t.ilspycmd}\n\`\`\`\n`;
          if (t.ilspycmd_caveat) out += `\n_${t.ilspycmd_caveat}_\n`;
        }
      }

      return structuredResult(typed, out, format);
    }
  );

  // ── d365_isv_extension_points ─────────────────────────────────────────────
  server.registerTool(
    'd365_isv_extension_points',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description: 'Where sealed ISV models hook into standard code: Chain-of-Command wrappers, delegate/event subscriptions, class/table/EDT extensions — by standard object (who touches SalesFormLetter?) or by module (everything Lasernet hooks). The normal XRef tools cannot answer this for binary-only models.',
      inputSchema: {
        target: z.string().min(1).max(500).optional().describe('Standard object the ISV extends, e.g. "SalesFormLetter", "CustTable", "DocuView".'),
        module: z.string().min(1).max(100).optional().describe('Sealed ISV model to list, e.g. "Lasernet". Combine with `target` to narrow further.'),
        limit: z.number().int().min(1).max(EXT_HARD_MAX).optional().default(100).describe(`Max rows per section.`),
        include_signatures: z.boolean().optional().default(false).describe('Attach the wrapped method\'s signature (fidelity=il) to each CoC row — what a coexisting wrapper must match. Calling contract only; no body is decompiled or stored.'),
        format: formatTextParam,
      },
      outputSchema: d365IsvExtensionPointsOutput.shape,
    },
    async ({ target, module, limit, include_signatures, format }) => {
      // Defensive default: Zod's .default() is bypassed by the test mock server.
      const cap = Number.isInteger(limit) && limit > 0 && limit <= EXT_HARD_MAX ? limit : 100;
      const tgt = target ? String(target).trim() : null;
      const mod = module ? String(module).trim() : null;
      const wantSigs = include_signatures === true;

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
          signatures_available: false,
          il_provenance: null,
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
            signatures_available: false,
            il_provenance: null,
            truncated: false,
            provenance: isvProvenance(db),
          });
      }

      // The wrapped method's signature, looked up per (target, method) pair.
      // isv_coc names the target and the method; only the assembly carries the
      // parameter list, which is the part a wrapper has to match.
      const sigsAvailable = wantSigs && hasIsvIlData(db);
      const sigByKey = new Map();
      if (sigsAvailable) {
        const pairs = coc.filter(r => r.target && r.method);
        if (pairs.length) {
          const clause = pairs
            .map(() => '(type_name = ? COLLATE NOCASE AND method_name = ? COLLATE NOCASE)')
            .join(' OR ');
          const params = pairs.flatMap(r => [String(r.target), String(r.method)]);
          try {
            for (const row of q(
              `SELECT module, assembly, namespace, type_name, method_name, kind,
                      return_type, parameters, visibility, is_static, is_abstract,
                      is_virtual, is_final, has_implementation, attributes
               FROM isv_il_methods
               WHERE (${clause})
                 AND (kind IS NULL OR kind <> 'accessor')
               ORDER BY param_count
               LIMIT ${SIG_HARD_MAX}`, params)) {
              // Keep the lowest-arity overload: it is the declaration a
              // developer wrote, before the optional-parameter machinery.
              const key = `${String(row.type_name).toLowerCase()}|${String(row.method_name).toLowerCase()}`;
              if (!sigByKey.has(key)) sigByKey.set(key, toSignature(row));
            }
          } catch { /* no IL rows for these pairs — CoC listing still stands */ }
        }
      }
      const sigFor = (r) => (r.target && r.method
        ? sigByKey.get(`${String(r.target).toLowerCase()}|${String(r.method).toLowerCase()}`) ?? null
        : null);

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
          signature: sigsAvailable ? sigFor(r) : null,
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
        signatures_available: sigsAvailable,
        il_provenance: sigByKey.size ? isvIlProvenance(db) : null,
        truncated,
        provenance: isvProvenance(db),
      };

      const heading = tgt
        ? `## Sealed ISV extension points for \`${tgt}\``
        : `## Sealed ISV extension points in \`${mod}\``;
      let out = `${heading}\n\n`;

      if (typed.coc_count) {
        out += `### Chain of Command (${typed.coc_count})\n\n`;
        const cols = ['Model', 'Extension class', 'Target', 'Method', 'Static'];
        // The signature column appears only when signatures were asked for and
        // found, so a caller who did not ask sees a byte-identical table.
        if (sigsAvailable) cols.push('Wrapped signature (il)');
        out += formatMarkdownTable(typed.chain_of_command.map(r => {
          const row = {
            Model: r.module,
            'Extension class': r.extension_class,
            Target: r.target ?? '',
            Method: r.method ?? '(class-level)',
            Static: r.is_static ? 'Y' : '',
          };
          if (sigsAvailable) {
            row['Wrapped signature (il)'] = r.signature ? formatSignature(r.signature) : '';
          }
          return row;
        }), cols);
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

      if (wantSigs && !sigsAvailable) {
        out += '\n_No IL signatures in this database: the assembly-metadata pass '
          + '(issue #81) is off by default. Rebuild with `ISV_IL_SCAN=1`, or run '
          + '`node build/isv-scan.js --il --kb <db>`, to populate it._\n';
      } else if (sigByKey.size) {
        out += isvIlProvenanceNote(sigByKey.size,
          [...new Set([...sigByKey.values()].map(sig => sig.module))]);
      }

      return structuredResult(typed, out, format);
    }
  );
}
