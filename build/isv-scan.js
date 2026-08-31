/**
 * Sealed-ISV metadata scanner.
 *
 * Some third-party models ship no X++ source and no `Ax<Type>` metadata XML — the
 * entire model is a `bin/` directory. `build/build-kb.js` deliberately skips
 * `bin/` (it is a compiled mirror for source-shipping models), which means
 * those ISVs are invisible to every MCP service: no tables, no classes, no
 * labels, and — measurably — zero outbound cross-references.
 *
 * This scanner is a separate pass that reads *only* `bin/` and the sibling
 * `<Model>.xref` package, and writes *only* to the `isv_`-prefixed tables
 * defined in src/azure/isv-schema.js. No existing table is touched, so every
 * query that works today keeps returning exactly what it returns today.
 *
 * Nothing here decompiles anything: `.md`, `.xref`, `.runtime` and `.xml` are
 * metadata the ISV chose to ship in a deployable package — the same data the
 * D365 runtime and Visual Studio read.
 *
 * Usage:
 *   node build/isv-scan.js --kb <kb.sqlite> --xref <xref.sqlite> --roots <dir[,dir]>
 *
 * Add `--il` (or ISV_IL_SCAN=1) for the assembly-metadata signature pass of
 * issue #81 — signatures only, off by default, KB database only.
 *
 * Roots default to ISV_SCAN_PATHS, then to the customization roots already
 * configured in KB_PACKAGES_PATHS. When no root resolves, the scan is a no-op
 * and both databases are left byte-identical.
 *
 * Issues: #75 (ADR), #76, #77, #78, #79, #80, #81.
 */

import { createRequire } from 'module';
import { readdirSync, readFileSync, statSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { XMLParser } from 'fast-xml-parser';
import AdmZip from 'adm-zip';

import { ensureIsvSchema } from '../src/azure/isv-schema.js';
import {
  parseSealedMdDirectory,
  readSealedMdEntry,
  parseSealedPropertyBlob,
  scanSealedStrings,
  parseSealedLabelStore,
  parseElementReferences,
  parseModuleReferences,
  parseExtendsRuntime,
  parseDeleteActionsRuntime,
  parseChainOfCommandDoc,
  parseEventHandlersDoc,
  parseExtensionClassTargetsDoc,
  parseVersionInfoStrings,
} from './isv-parsers.js';
import { readAssemblySignatures, normalizeXppMethods } from './pe-metadata.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const XML = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

/** Property tags decoded so far, per element type. Extended only with fixture
 *  evidence — an unmapped tag is stored as its raw `0xNN`, never guessed.
 *
 *  AxTableExtension carries exactly one tag confirmed across 48 blobs from four
 *  models, and it self-validates: 0x06's value always equals the directory
 *  entry name (asserted in test/isv-parsers.test.js). The other frequent tags
 *  there (0x01/0x02/0x08/0x12 hold identifiers, 0x0b a related table) are NOT
 *  named: the evidence does not yet separate field name from relation name, and
 *  a wrong name is worse than a raw tag. */
const PROPERTY_TAGS = {
  AxEdt: { '0x0d': 'extends', '0x0f': 'label', '0x10': 'helpText', '0x11': 'name' },
  AxTableExtension: { '0x06': 'extends' },
};

/** Element types whose payload interleaves non-string entries, so the strict
 *  TLV walk yields nothing and the string scanner is used instead. Extend this
 *  as new types are shown to need it — the strict walk is preferred wherever
 *  it works, because it cannot mis-frame. */
const SCAN_STRINGS_TYPES = new Set(['AxTableExtension']);

/** `.md` files that are not element stores and must not become inventory. */
const NON_ELEMENT_MD = new Set(['AxLabelFile']);

/* ── discovery ─────────────────────────────────────────────────────────── */

/**
 * A sealed model is a directory under a metadata root that has a `bin/` and no
 * `Descriptor/`. Source-shipping models (HISOL, iExtension) have a Descriptor
 * and are already covered by the normal KB and XRef builds — they must not be
 * scanned here, or their data would be duplicated into the ISV tables.
 *
 * @param {string} root
 * @returns {Array<{model:string, dir:string, binDir:string, xrefFile:string|null}>}
 */
export function discoverSealedModels(root) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = join(root, e.name);
    const binDir = join(dir, 'bin');
    if (!existsSync(binDir)) continue;
    if (existsSync(join(dir, 'Descriptor'))) continue; // source-shipping model
    let xrefFile = null;
    try {
      const sibling = readdirSync(dir).find(f => f.toLowerCase().endsWith('.xref'));
      if (sibling) xrefFile = join(dir, sibling);
    } catch { /* unreadable model directory — recorded as no xref */ }
    found.push({ model: e.name, dir, binDir, xrefFile });
  }
  return found;
}

/* ── per-model readers ─────────────────────────────────────────────────── */

/**
 * Recover publisher / version without a Descriptor (issue #76).
 * Returns 'unknown' rather than a guess when the assembly yields nothing.
 */
function readIdentity(model, binDir) {
  const candidates = [`Dynamics.AX.${model}.dll`];
  try {
    for (const f of readdirSync(binDir)) {
      if (/^Dynamics\.AX\..*\.dll$/i.test(f) && !candidates.includes(f)) candidates.push(f);
    }
  } catch { /* handled by the empty-result path below */ }
  for (const c of candidates) {
    const p = join(binDir, c);
    if (!existsSync(p)) continue;
    let info;
    try {
      info = parseVersionInfoStrings(readFileSync(p));
    } catch {
      continue;
    }
    if (info.CompanyName || info.FileVersion) {
      return {
        publisher: info.CompanyName || 'unknown',
        version: info.FileVersion || info.ProductVersion || 'unknown',
      };
    }
  }
  return { publisher: 'unknown', version: 'unknown' };
}

/**
 * Element inventory + decoded properties from the sealed `.md` stores.
 * A file that fails to parse costs that file only — never the build (rule #7).
 */
function readElements(model, binDir, prefix, warn) {
  const elements = [];
  const props = [];
  let files;
  try {
    const lead = `${prefix}_`.toLowerCase();
    files = readdirSync(binDir)
      .filter(f => f.endsWith('.md') && f.toLowerCase().startsWith(lead));
  } catch {
    return { elements, props };
  }
  for (const file of files) {
    const elementType = basename(file, '.md').slice(prefix.length + 1);
    if (NON_ELEMENT_MD.has(elementType)) continue;
    let buf;
    let dir;
    try {
      buf = readFileSync(join(binDir, file));
      dir = parseSealedMdDirectory(buf);
    } catch (err) {
      warn(`${model}/${file}: unreadable sealed store (${err.message}) — skipped`);
      continue;
    }
    const tagMap = PROPERTY_TAGS[elementType] || null;
    const useScanner = SCAN_STRINGS_TYPES.has(elementType);
    for (const entry of dir.entries) {
      const index = elements.length;
      elements.push({ module: model, elementType, name: entry.name, blobSize: entry.size });
      if (!tagMap && !useScanner) continue;
      const blob = readSealedMdEntry(buf, entry, dir.payloadBase);
      const decoded = useScanner
        ? scanSealedStrings(blob)
        : parseSealedPropertyBlob(blob).props;
      for (const p of decoded) {
        props.push({ index, tag: p.tag, prop: tagMap?.[p.tag] || null, value: p.value });
      }
    }
  }
  return { elements, props };
}

/**
 * The `.md` filename prefix is the model's *metadata* name, which is not always
 * the directory name: on the reference box `MindQuadClearTaxEinvoicing/` holds
 * `MindQuadClearTaxEInvoicing_Ax*.md` (capital I). Matching the directory name
 * case-sensitively silently yielded a zero-element inventory for that model, so
 * the prefix is recovered from the files themselves.
 *
 * @returns {string} the canonical prefix, falling back to the directory name
 */
function resolveMdPrefix(model, binDir) {
  try {
    const md = readdirSync(binDir).find(f => /_Ax[A-Za-z]+\.md$/.test(f));
    if (md) {
      const cut = md.search(/_Ax[A-Za-z]+\.md$/);
      if (cut > 0) return md.slice(0, cut);
    }
  } catch { /* fall through to the directory name */ }
  return model;
}

/** Labels from the sealed label store (issue #78). */
function readLabels(model, binDir, prefix, warn) {
  const file = join(binDir, `${prefix}_AxLabelFile.md`);
  if (!existsSync(file)) return [];
  let stores;
  try {
    stores = parseSealedLabelStore(readFileSync(file));
  } catch (err) {
    warn(`${model}: label store unreadable (${err.message}) — skipped`);
    return [];
  }
  const rows = [];
  for (const s of stores) {
    for (const l of s.labels) {
      rows.push({
        labelId: l.id,
        language: s.language,
        text: l.text,
        module: model,
        labelFile: s.labelFile,
        qualifiedId: l.qualifiedId,
      });
    }
  }
  return rows;
}

/** Cross-references and declared dependencies (issue #77). */
function readXref(model, xrefFile, warn) {
  if (!xrefFile) return { refs: [], deps: [], skipped: 0 };
  let zip;
  try {
    zip = new AdmZip(xrefFile);
  } catch (err) {
    warn(`${model}: .xref package unreadable (${err.message}) — skipped`);
    return { refs: [], deps: [], skipped: 0 };
  }
  const get = (name) => {
    const e = zip.getEntries().find(x => x.entryName === name);
    return e ? zip.readFile(e) : null;
  };
  const elementBuf = get('ElementReferences');
  const moduleBuf = get('ModuleReferences');
  const { refs, skipped } = elementBuf
    ? parseElementReferences(elementBuf)
    : { refs: [], skipped: 0 };
  if (skipped) warn(`${model}: ${skipped} malformed ElementReferences line(s) skipped`);
  return { refs, deps: moduleBuf ? parseModuleReferences(moduleBuf) : [], skipped };
}

/** CoC, event handlers, extends and delete actions (issue #80). */
function readStructure(model, binDir, warn) {
  const coc = [];
  const events = [];
  const extendsRows = [];
  const deleteActions = [];
  let files;
  try {
    files = readdirSync(binDir);
  } catch {
    return { coc, events, extendsRows, deleteActions };
  }

  const readText = (f) => {
    try {
      return readFileSync(join(binDir, f), 'utf8');
    } catch (err) {
      warn(`${model}/${f}: unreadable (${err.message}) — skipped`);
      return null;
    }
  };
  const readXml = (f) => {
    const text = readText(f);
    if (text == null) return null;
    try {
      return XML.parse(text);
    } catch (err) {
      warn(`${model}/${f}: malformed XML (${err.message}) — skipped`);
      return null;
    }
  };

  for (const f of files) {
    const m = /\.(\w+)Extends\.runtime$/.exec(f);
    if (m) {
      const kind = m[1].toLowerCase(); // Class | Table | Edt | OData | ODataExtensions
      const text = readText(f);
      if (text != null) {
        for (const r of parseExtendsRuntime(text)) {
          extendsRows.push({ module: model, kind, child: r.child, parent: r.parent });
        }
      }
      continue;
    }
    if (f.endsWith('.DeleteActions.runtime')) {
      const text = readText(f);
      if (text != null) {
        for (const r of parseDeleteActionsRuntime(text)) {
          deleteActions.push({ module: model, ...r });
        }
      }
      continue;
    }
    if (f.endsWith('.ChainOfCommand.xml')) {
      const doc = readXml(f);
      if (doc) for (const r of parseChainOfCommandDoc(doc)) coc.push({ module: model, ...r });
      continue;
    }
    if (f.endsWith('.netmodule.xml')) {
      const doc = readXml(f);
      if (doc) for (const r of parseEventHandlersDoc(doc)) events.push({ module: model, ...r });
      continue;
    }
    if (f.endsWith('.ExtensionsClassTargets.xml')) {
      const doc = readXml(f);
      // Recorded as CoC rows without a method: an extension class whose wrapped
      // methods are not listed here still tells us the ISV targets that object.
      if (doc) {
        for (const r of parseExtensionClassTargetsDoc(doc)) {
          coc.push({
            module: model,
            extensionClass: r.extensionClass,
            target: r.target,
            targetType: r.targetType,
            method: null,
            isStatic: false,
          });
        }
      }
    }
  }
  return { coc, events, extendsRows, deleteActions };
}

/**
 * Method signatures from the model's own assemblies (issue #81).
 *
 * Off unless asked for. Everything else this scanner reads is metadata the ISV
 * shipped for the runtime and Visual Studio to consume; assembly metadata is
 * the same package's compiled half, and while reading its *tables* is no more
 * invasive, it is a different claim about a different artefact and gets its own
 * switch rather than riding along on ISV_SCAN_PATHS.
 *
 * Only `Dynamics.AX.*` images are read. Sealed models vendor third-party
 * libraries into the same `bin/` (`AngleSharp.dll`, `HtmlSanitizer.dll`,
 * `ChilkatDotNet46.dll`, …) which are neither the ISV's own surface nor ours to
 * catalogue.
 *
 * @param {string} model
 * @param {string} binDir
 * @param {(msg:string)=>void} warn
 * @returns {Array<object>} normalised signature rows, `[]` when disabled
 */
function readIlSignatures(model, binDir, warn) {
  let files;
  try {
    files = readdirSync(binDir)
      .filter(f => /^Dynamics\.AX\..*\.(dll|netmodule)$/i.test(f));
  } catch {
    return [];
  }

  const raw = [];
  for (const f of files) {
    try {
      const { methods } = readAssemblySignatures(readFileSync(join(binDir, f)));
      for (const m of methods) raw.push({ ...m, assembly: f });
    } catch (err) {
      // A native or malformed image is skipped, never fatal: the other
      // assemblies of the model still carry a usable surface.
      warn(`${model}: ${f} — no signatures read (${err.message})`);
    }
  }
  return normalizeXppMethods(raw).map(m => ({ ...m, module: model }));
}

/* ── scan ──────────────────────────────────────────────────────────────── */

/**
 * Read every sealed model under the given roots. Pure of any database work so
 * it can be exercised on its own.
 *
 * @param {string[]} roots
 * @param {(msg:string)=>void} warn
 * @param {{il?:boolean}} [opts]  `il: true` also reads assembly signatures (#81)
 * @returns {Array<object>} one record per sealed model
 */
export function scanSealedModels(roots, warn = m => console.warn('Warning:', m), opts = {}) {
  const out = [];
  for (const root of roots) {
    for (const found of discoverSealedModels(root)) {
      const { model, binDir, xrefFile } = found;
      const prefix = resolveMdPrefix(model, binDir);
      const identity = readIdentity(model, binDir);
      const { elements, props } = readElements(model, binDir, prefix, warn);
      const labels = readLabels(model, binDir, prefix, warn);
      const { refs, deps } = readXref(model, xrefFile, warn);
      const structure = readStructure(model, binDir, warn);
      const ilMethods = opts.il === true ? readIlSignatures(model, binDir, warn) : [];
      out.push({
        model,
        root,
        publisher: identity.publisher,
        version: identity.version,
        layer: null, // no Descriptor ships a layer for a sealed model
        elements,
        props,
        labels,
        refs,
        deps,
        ilMethods,
        ...structure,
      });
    }
  }
  return out;
}

/* ── persistence ───────────────────────────────────────────────────────── */

/**
 * Write a scan into a KB database: registry, element inventory, decoded
 * properties, structural descriptors and labels.
 *
 * @param {object} db       open, writable better-sqlite3 handle
 * @param {Array<object>} models  output of scanSealedModels()
 */
export function writeKb(db, models) {
  ensureIsvSchema(db, 'kb');
  const scannedAt = new Date().toISOString();

  const clear = (t) => db.prepare(`DELETE FROM ${t}`).run();
  ['isv_models', 'isv_elements', 'isv_element_props', 'isv_coc',
    'isv_event_handlers', 'isv_extends', 'isv_delete_actions', 'isv_labels',
    'isv_il_methods'].forEach(clear);

  const insModel = db.prepare(`INSERT INTO isv_models
    (model, publisher, version, layer, source_kind, fidelity, depends_on, root, scanned_at, counts)
    VALUES (?,?,?,?,'sealed','metadata',?,?,?,?)`);
  const insElement = db.prepare(
    'INSERT INTO isv_elements (module, element_type, name, blob_size) VALUES (?,?,?,?)');
  const insProp = db.prepare(
    'INSERT INTO isv_element_props (element_id, tag, prop, value) VALUES (?,?,?,?)');
  const insCoc = db.prepare(`INSERT INTO isv_coc
    (module, extension_class, target, target_type, method, is_static) VALUES (?,?,?,?,?,?)`);
  const insEvt = db.prepare(`INSERT INTO isv_event_handlers
    (module, delegate_element, delegate_element_type, delegate_method,
     handler_element, handler_element_type, handler_method, delegate_type)
    VALUES (?,?,?,?,?,?,?,?)`);
  const insExt = db.prepare(
    'INSERT INTO isv_extends (module, kind, child, parent) VALUES (?,?,?,?)');
  const insDel = db.prepare(`INSERT INTO isv_delete_actions
    (module, table_name, target, relation, action) VALUES (?,?,?,?,?)`);
  const insLabel = db.prepare(`INSERT OR REPLACE INTO isv_labels
    (label_id, language, text, module, label_file, qualified_id) VALUES (?,?,?,?,?,?)`);
  const insIl = db.prepare(`INSERT INTO isv_il_methods
    (module, assembly, namespace, type_name, base_type, method_name, kind,
     return_type, parameters, param_count, generic_count, visibility, is_static,
     is_abstract, is_virtual, is_final, has_implementation, attributes, fidelity)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'il')`);

  db.transaction(() => {
    for (const m of models) {
      insModel.run(m.model, m.publisher, m.version, m.layer,
        JSON.stringify(m.deps || []), m.root, scannedAt,
        JSON.stringify({
          elements: m.elements.length,
          labels: m.labels.length,
          coc: m.coc.length,
          events: m.events.length,
          refs: m.refs.length,
          il_methods: (m.ilMethods || []).length,
        }));

      // Element ids are assigned by SQLite, so map scan-order index -> row id
      // to attach the decoded properties.
      const ids = [];
      for (const e of m.elements) {
        ids.push(insElement.run(e.module, e.elementType, e.name, e.blobSize).lastInsertRowid);
      }
      for (const p of m.props) {
        const id = ids[p.index];
        if (id != null) insProp.run(id, p.tag, p.prop, p.value);
      }
      for (const c of m.coc) {
        insCoc.run(c.module, c.extensionClass, c.target, c.targetType, c.method, c.isStatic ? 1 : 0);
      }
      for (const e of m.events) {
        insEvt.run(e.module, e.delegateElement, e.delegateElementType, e.delegateMethod,
          e.handlerElement, e.handlerElementType, e.handlerMethod, e.delegateType);
      }
      for (const x of m.extendsRows) insExt.run(x.module, x.kind, x.child, x.parent);
      for (const d of m.deleteActions) {
        insDel.run(d.module, d.table, d.target, d.relation, d.action);
      }
      for (const l of m.labels) {
        insLabel.run(l.labelId, l.language, l.text, l.module, l.labelFile, l.qualifiedId);
      }
      for (const sig of m.ilMethods || []) {
        insIl.run(sig.module, sig.assembly ?? null, sig.namespace ?? null, sig.typeName,
          sig.baseType ?? null, sig.methodName, sig.kind ?? null, sig.returnType ?? null,
          JSON.stringify(sig.parameters ?? []), sig.paramCount ?? 0, sig.genericCount ?? 0,
          sig.visibility ?? null, sig.isStatic ? 1 : 0, sig.isAbstract ? 1 : 0,
          sig.isVirtual ? 1 : 0, sig.isFinal ? 1 : 0, sig.hasImplementation ? 1 : 0,
          JSON.stringify(sig.attributes ?? []));
      }
    }
  })();
}

/**
 * Write a scan into an XRef database: registry plus the cross-references the
 * main build cannot see.
 *
 * @param {object} db  open, writable better-sqlite3 handle
 * @param {Array<object>} models
 */
export function writeXref(db, models) {
  ensureIsvSchema(db, 'xref');
  const scannedAt = new Date().toISOString();

  ['isv_models', 'isv_names', 'isv_refs', 'isv_module_deps']
    .forEach(t => db.prepare(`DELETE FROM ${t}`).run());

  const insModel = db.prepare(`INSERT INTO isv_models
    (model, publisher, version, layer, source_kind, fidelity, depends_on, root, scanned_at, counts)
    VALUES (?,?,?,?,'sealed','metadata',?,?,?,?)`);
  const insName = db.prepare('INSERT INTO isv_names (path, module) VALUES (?,?)');
  const insRef = db.prepare(`INSERT INTO isv_refs
    (source_id, target_path, target_module, kind, line, col, tool) VALUES (?,?,?,?,?,?,?)`);
  const insDep = db.prepare('INSERT INTO isv_module_deps (module, depends_on) VALUES (?,?)');

  db.transaction(() => {
    for (const m of models) {
      insModel.run(m.model, m.publisher, m.version, m.layer,
        JSON.stringify(m.deps || []), m.root, scannedAt,
        JSON.stringify({ refs: m.refs.length, deps: (m.deps || []).length }));

      for (const d of m.deps || []) insDep.run(m.model, d);

      // One row per distinct source path; the reference rows point at it. The
      // source module comes from the line itself rather than the model name,
      // because a .xref package can carry rows attributed to a sibling module.
      const nameIds = new Map();
      for (const r of m.refs) {
        const mod = r.sourceModule || m.model;
        const key = `${mod} ${r.sourcePath}`;
        let id = nameIds.get(key);
        if (id == null) {
          id = insName.run(r.sourcePath, mod).lastInsertRowid;
          nameIds.set(key, id);
        }
        insRef.run(id, r.targetPath, r.targetModule, r.kind, r.line, r.col, r.tool);
      }
    }
  })();
}

/* ── build-pipeline entry point ────────────────────────────────────────── */

/**
 * Refresh the sealed-ISV tables of a database that a main build has just
 * finished writing.
 *
 * `build/build-kb.js` and `build/build-xref-db.js` scan the Microsoft
 * application and the source-shipping customization models (iExtension, HISOL)
 * — neither of them can see the sealed models, because the KB walk skips `bin/`
 * and the XRef SQL source has no rows for them. Calling this at the end of each
 * build keeps the two in step: a rebuild of the standard application refreshes
 * the ISV metadata alongside it, rather than leaving it dated from whenever the
 * scanner was last run by hand.
 *
 * Deliberately **non-fatal**. The main build's output is already on disk and
 * already correct; a failure here must be reported and must not turn a
 * successful build into a failed one. Equally, when no root is configured this
 * is a silent no-op — an unconfigured box builds exactly as it did before.
 *
 * @param {object} opts
 * @param {string} opts.dbPath          database the main build just closed
 * @param {'kb'|'xref'} opts.target     which schema set to write
 * @param {string[]} [opts.roots]       override; otherwise ISV_SCAN_PATHS etc.
 * @param {boolean} [opts.il]           override the ISV_IL_SCAN flag (#81)
 * @param {(msg:string)=>void} [opts.log]
 * @returns {Promise<{scanned:number, models:string[], skipped?:string}>}
 */
export async function refreshIsvMetadata({ dbPath, target, roots, il, log = console.log } = {}) {
  const resolved = (roots && roots.length ? roots : resolveRoots([])).filter(r => {
    try { return statSync(r).isDirectory(); } catch { return false; }
  });
  if (!dbPath || !resolved.length) {
    return { scanned: 0, models: [], skipped: 'no ISV metadata root configured' };
  }

  let models = [];
  try {
    // The IL pass costs nothing for the XRef database — it writes only to KB
    // tables — so it is skipped entirely on that target.
    const wantIl = target !== 'xref' && ilScanEnabled(il === undefined ? null : il);
    models = scanSealedModels(resolved, m => log(`  ISV warn: ${m}`), { il: wantIl });
    if (!models.length) return { scanned: 0, models: [], skipped: 'no sealed models found' };

    const db = new Database(dbPath);
    try {
      if (target === 'xref') writeXref(db, models);
      else writeKb(db, models);
    } finally {
      db.close();
    }
  } catch (err) {
    log(`  ISV refresh FAILED (main build is unaffected): ${err.message}`);
    return { scanned: 0, models: [], skipped: err.message };
  }

  const totals = models.reduce((a, m) => ({
    elements: a.elements + m.elements.length,
    labels: a.labels + m.labels.length,
    refs: a.refs + m.refs.length,
    il: a.il + (m.ilMethods || []).length,
  }), { elements: 0, labels: 0, refs: 0, il: 0 });

  log(`  ISV refresh: ${models.length} sealed model(s) — `
    + `${totals.elements.toLocaleString()} elements, `
    + `${totals.labels.toLocaleString()} labels, `
    + `${totals.refs.toLocaleString()} references`
    + (totals.il ? `, ${totals.il.toLocaleString()} IL signatures` : ''));

  return { scanned: models.length, models: models.map(m => m.model) };
}

/* ── CLI ───────────────────────────────────────────────────────────────── */

function parseArgs(argv) {
  const out = { kb: null, xref: null, roots: [], il: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--kb') out.kb = argv[++i];
    else if (a === '--xref') out.xref = argv[++i];
    else if (a === '--roots') out.roots = splitPaths(argv[++i]);
    else if (a === '--il') out.il = true;
    else if (a === '--no-il') out.il = false;
  }
  return out;
}

/**
 * Is the IL signature pass on? (issue #81)
 *
 * Off by default and deliberately not folded into ISV_SCAN_PATHS: with the flag
 * unset the scan writes no `isv_il_methods` row, so a database built without it
 * is byte-identical to one built before this pass existed. `--il` / `--no-il`
 * override the environment.
 *
 * @param {boolean|null} [argValue]
 * @returns {boolean}
 */
export function ilScanEnabled(argValue = null) {
  if (argValue === true || argValue === false) return argValue;
  const v = String(process.env.ISV_IL_SCAN ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function splitPaths(s) {
  return String(s || '').split(/[;,]/).map(x => x.trim()).filter(Boolean);
}

/** Roots to scan: explicit arg, then ISV_SCAN_PATHS, then the customization
 *  roots already configured for the KB build. Never the standard
 *  PackagesLocalDirectory — Microsoft models are not sealed ISVs. */
function resolveRoots(argRoots) {
  if (argRoots.length) return argRoots;
  if (process.env.ISV_SCAN_PATHS) return splitPaths(process.env.ISV_SCAN_PATHS);
  return splitPaths(process.env.KB_PACKAGES_PATHS)
    .filter(p => !/PackagesLocalDirectory$/i.test(p));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const roots = resolveRoots(args.roots).filter(r => {
    try { return statSync(r).isDirectory(); } catch { return false; }
  });

  if (!roots.length) {
    console.log('ISV scan: no metadata root resolved (set ISV_SCAN_PATHS or pass --roots). Nothing to do.');
    return;
  }
  console.log(`ISV scan: roots ${roots.join(', ')}`);

  const il = ilScanEnabled(args.il);
  console.log(`ISV scan: IL signature pass ${il ? 'ON' : 'off'}`
    + (il ? '' : ' (enable with --il or ISV_IL_SCAN=1)'));

  const warnings = [];
  const models = scanSealedModels(
    roots, m => { warnings.push(m); console.warn('  warn:', m); }, { il });

  if (!models.length) {
    console.log('ISV scan: no sealed models found (a sealed model has bin/ and no Descriptor/).');
    return;
  }

  console.log(`\nISV scan: ${models.length} sealed model(s)\n`);
  console.log('  model                          elements   labels     refs      coc   events    il-sig');
  console.log('  ' + '-'.repeat(85));
  for (const m of models) {
    console.log('  ' + m.model.padEnd(28) +
      String(m.elements.length).padStart(9) +
      String(m.labels.length).padStart(9) +
      String(m.refs.length).padStart(9) +
      String(m.coc.length).padStart(9) +
      String(m.events.length).padStart(9) +
      String((m.ilMethods || []).length).padStart(10));
  }
  const total = (k) => models.reduce((n, m) => n + (m[k] || []).length, 0);
  console.log('  ' + '-'.repeat(85));
  console.log('  ' + 'TOTAL'.padEnd(28) +
    String(total('elements')).padStart(9) +
    String(total('labels')).padStart(9) +
    String(total('refs')).padStart(9) +
    String(total('coc')).padStart(9) +
    String(total('events')).padStart(9) +
    String(total('ilMethods')).padStart(10));

  if (args.kb) {
    const db = new Database(args.kb);
    try { writeKb(db, models); } finally { db.close(); }
    console.log(`\nISV scan: KB tables written to ${args.kb}`);
  }
  if (args.xref) {
    const db = new Database(args.xref);
    try { writeXref(db, models); } finally { db.close(); }
    console.log(`ISV scan: XRef tables written to ${args.xref}`);
  }
  if (!args.kb && !args.xref) {
    console.log('\n(dry run — pass --kb and/or --xref to persist)');
  }
  if (warnings.length) console.log(`\n${warnings.length} warning(s) during scan.`);
}

const invokedDirectly = process.argv[1] &&
  process.argv[1].replace(/\\/g, '/').endsWith('build/isv-scan.js');
if (invokedDirectly) {
  main().catch(err => {
    console.error('ISV scan failed:', err.message);
    process.exitCode = 1;
  });
}
