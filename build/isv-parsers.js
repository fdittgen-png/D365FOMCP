/**
 * Pure parsers for the artefacts a sealed (binary-only) ISV model ships in its
 * `bin/` directory. No filesystem access, no database access — every function
 * takes a Buffer or a string and returns plain data, so all of it is testable
 * from checked-in fixtures. Filesystem walking and persistence live in
 * build/isv-scan.js.
 *
 * Formats were decoded from the models on the reference dev box and are pinned
 * by test/isv-parsers.test.js. See issue #75 for the investigation.
 */

/* ────────────────────────────────────────────────────────────────────────────
 * 1. Sealed metadata store — bin/<Model>_Ax<Type>.md   (issues #79, #78)
 * ──────────────────────────────────────────────────────────────────────────*/

/**
 * Layout:
 *
 *   [count : uint32 LE]
 *   count × [ nameLen : uint8 ][ name : utf8 ][ typeTag : uint32 LE ]
 *            [ offset : uint32 LE ][ length : uint32 LE ]
 *   payload …                       (element blobs, addressed by offset/length
 *                                    relative to the end of the directory)
 *
 * Despite the `.md` extension these are not Markdown; the extension is D365's
 * own ("metadata"). The directory is a plain, unambiguous structure — parsing
 * it carries no interpretation risk, which is why the element inventory is
 * built from the directory alone and property decoding is a separate, opt-in
 * step.
 *
 * @param {Buffer} buf
 * @returns {{entries: Array<{name:string,typeTag:number,offset:number,size:number}>,
 *            payloadBase: number}}
 * @throws {Error} when the buffer is not a well-formed store
 */
export function parseSealedMdDirectory(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) {
    throw new Error('sealed .md: buffer too small to hold a directory count');
  }
  const count = buf.readUInt32LE(0);
  // A model with tens of millions of elements does not exist; a wild count is
  // the signal that this file is not a sealed store at all.
  if (count > 5_000_000) {
    throw new Error(`sealed .md: implausible directory count ${count}`);
  }
  let o = 4;
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (o + 1 > buf.length) throw new Error(`sealed .md: directory truncated at entry ${i}`);
    const nameLen = buf.readUInt8(o);
    o += 1;
    if (o + nameLen + 12 > buf.length) {
      throw new Error(`sealed .md: directory truncated inside entry ${i}`);
    }
    const name = buf.subarray(o, o + nameLen).toString('utf8');
    o += nameLen;
    const typeTag = buf.readUInt32LE(o); o += 4;
    const offset = buf.readUInt32LE(o); o += 4;
    const size = buf.readUInt32LE(o); o += 4;
    entries.push({ name, typeTag, offset, size });
  }
  return { entries, payloadBase: o };
}

/**
 * Slice one element's raw property blob out of a sealed store.
 *
 * @param {Buffer} buf
 * @param {{offset:number,size:number}} entry
 * @param {number} payloadBase
 * @returns {Buffer} empty when the entry addresses outside the file
 */
export function readSealedMdEntry(buf, entry, payloadBase) {
  const start = payloadBase + entry.offset;
  const end = start + entry.size;
  if (start < 0 || end > buf.length || end < start) return Buffer.alloc(0);
  return buf.subarray(start, end);
}

/**
 * Decode an element property blob.
 *
 * The payload is a tag-length-value stream — `[tag:uint8][len:uint8][utf8]` —
 * behind a four-byte header. Not every tag carries a string, and the tag
 * vocabulary is per element type and only partly known, so this decoder is
 * deliberately conservative: it stops at the first byte pair that cannot be a
 * valid string TLV rather than guessing at a value it might misread. Callers
 * get what could be read for certain and `truncated: true`.
 *
 * Verified against AmcBankingFoundation_AxEdt.md, where element
 * `AmcBankSearchString` decodes to
 *   0x0d "String255" · 0x0f "@ABA33020" · 0x10 "@SYS40543" · 0x11 "AmcBankSearchString"
 *
 * @param {Buffer} blob
 * @returns {{props: Array<{tag:string,value:string}>, truncated: boolean}}
 */
export function parseSealedPropertyBlob(blob) {
  const props = [];
  if (!Buffer.isBuffer(blob) || blob.length < 4) return { props, truncated: false };
  let o = 4; // four-byte header, meaning not established — deliberately skipped
  let truncated = false;
  while (o + 2 <= blob.length) {
    const tag = blob.readUInt8(o);
    const len = blob.readUInt8(o + 1);
    const start = o + 2;
    const end = start + len;
    if (len === 0 || end > blob.length) { truncated = true; break; }
    const raw = blob.subarray(start, end);
    if (!isPlausibleText(raw)) { truncated = true; break; }
    props.push({ tag: `0x${tag.toString(16).padStart(2, '0')}`, value: raw.toString('utf8') });
    o = end;
  }
  return { props, truncated };
}

/** Longest plausible identifier/label in a sealed property blob. */
const MAX_SEALED_STRING = 96;

/** A sealed property string is an AOT identifier, a label id, or a dotted
 *  element name — never free prose. Anything else is a mis-framed read. */
const SEALED_IDENTIFIER = /^[A-Za-z@_][A-Za-z0-9_.@:\-/]*$/;

/**
 * Extract the length-prefixed strings from a property blob.
 *
 * `parseSealedPropertyBlob` walks the TLV stream strictly and stops at the
 * first entry it cannot frame. That is right for `AxEdt`, whose payload is
 * all-strings, but useless for element types that interleave non-string
 * entries (uint32 counts, flag bytes) whose widths are not known per tag —
 * `AxTableExtension` blobs stop the strict walker at byte 4 and yield nothing.
 *
 * This scanner instead looks for the one shape that IS unambiguous:
 * `[tag][len][len printable bytes]` where the payload reads as an AOT
 * identifier. Verified against the real store: `SalesConfirmDetailsTmp.LACExtension`
 * yields `0x06 "SalesConfirmDetailsTmp.LACExtension"`, `0x01 "LACTransRefRecId"`,
 * `0x03 "RecId"`, `0x0b "CustConfirmTrans"`.
 *
 * **This is a heuristic and is treated as one.** It can mis-frame inside a long
 * string and emit a fragment, so callers must store what it returns with the
 * tag verbatim and MUST NOT name a property from it without separate evidence
 * (issue #79). Its value is that it makes identifiers *findable* — answering
 * "is `LACTransRefRecId` real, and where does it come from?" needs no tag
 * semantics at all.
 *
 * @param {Buffer} blob
 * @returns {Array<{tag:string, value:string}>} in blob order, non-overlapping
 */
export function scanSealedStrings(blob) {
  const out = [];
  if (!Buffer.isBuffer(blob)) return out;
  for (let i = 1; i + 1 < blob.length; i++) {
    const len = blob[i];
    if (len < 2 || len > MAX_SEALED_STRING) continue;
    const end = i + 1 + len;
    if (end > blob.length) continue;

    const bytes = blob.subarray(i + 1, end);
    let printable = true;
    for (const c of bytes) {
      if (c < 0x20 || c > 0x7e) { printable = false; break; }
    }
    if (!printable) continue;

    const value = bytes.toString('utf8');
    if (!SEALED_IDENTIFIER.test(value)) continue;

    out.push({ tag: `0x${blob[i - 1].toString(16).padStart(2, '0')}`, value });
    i = end - 1; // never let one string be re-read as part of another
  }
  return out;
}

/**
 * A property value is accepted only when it is text a human could have typed:
 * no control characters, no lone bytes from the middle of a multi-byte
 * sequence. This is the guard that keeps a mis-framed TLV from being reported
 * as if it were a real property value.
 */
function isPlausibleText(buf) {
  for (const b of buf) {
    if (b < 0x20 && b !== 0x09) return false; // control bytes, tab excepted
    if (b === 0x7f) return false;
  }
  const s = buf.toString('utf8');
  return !s.includes('�');
}

/* ────────────────────────────────────────────────────────────────────────────
 * 2. Labels inside bin/<Model>_AxLabelFile.md            (issue #78)
 * ──────────────────────────────────────────────────────────────────────────*/

/**
 * A label store pairs, per language, a header entry (`LAC_en-US`) with a
 * content entry (`LAC_en-US#content`) whose blob is the **verbatim
 * `.label.txt` file**, UTF-8 with BOM. Nothing is decoded or reconstructed —
 * the payload is the text file the ISV shipped.
 *
 * @param {Buffer} buf  contents of a *_AxLabelFile.md
 * @returns {Array<{labelFile:string, language:string, labels:Array<{id:string,text:string}>}>}
 */
export function parseSealedLabelStore(buf) {
  const { entries, payloadBase } = parseSealedMdDirectory(buf);
  const out = [];
  for (const entry of entries) {
    if (!entry.name.endsWith('#content')) continue;
    // 'LAC_en-US#content' -> labelFile 'LAC', language 'en-US'
    const stem = entry.name.slice(0, -'#content'.length);
    const sep = stem.indexOf('_');
    if (sep <= 0) continue;
    const labelFile = stem.slice(0, sep);
    const language = stem.slice(sep + 1);
    const blob = readSealedMdEntry(buf, entry, payloadBase);
    if (!blob.length) continue;
    const labels = parseLabelFileText(blob.toString('utf8'), labelFile);
    if (labels.length) out.push({ labelFile, language, labels });
  }
  return out;
}

/** A label id is an identifier, optionally `@`-prefixed, optionally in the
 *  `@Module:Id` colon form. Anything else on the left of an `=` is not an id. */
const LABEL_ID = /^@?[A-Za-z_][A-Za-z0-9_]*(?::[A-Za-z0-9_]+)?$/;

/**
 * Parse standard D365 `.label.txt` syntax. Two id conventions are in use and
 * both appear among the sealed models on the reference box:
 *
 *   legacy      `@LAC0=Custom ports`                  — id carries its own `@`
 *   contemporary `AccountStructureMissing=La config…` — bare identifier, cited
 *                                                       elsewhere as
 *                                                       `@AmcBankCashPool:AccountStructureMissing`
 *
 * Ids are returned **verbatim**, matching how the KB `labels` table already
 * stores them (it holds both `@SYS40543` and bare `AllDistributions`). The
 * owning label file is returned separately so a resolver can reconstruct the
 * colon form; inventing a prefix here would make the stored id un-joinable
 * against the metadata that cites it.
 *
 * Comment lines start with `;` after optional leading whitespace.
 *
 * @param {string} text
 * @param {string} [labelFile] owning label-file id, e.g. 'LAC', 'AmcBankCashPool'
 * @returns {Array<{id:string, text:string, qualifiedId:string|null}>}
 */
export function parseLabelFileText(text, labelFile) {
  if (typeof text !== 'string') return [];
  const out = [];
  for (const rawLine of stripBom(text).split(/\r?\n/)) {
    if (!rawLine || !rawLine.trim() || rawLine.trim().startsWith(';')) continue;
    const eq = rawLine.indexOf('=');
    if (eq <= 0) continue;
    const id = rawLine.slice(0, eq).trim();
    if (!LABEL_ID.test(id)) continue;
    out.push({
      id,
      text: rawLine.slice(eq + 1),
      qualifiedId: !id.startsWith('@') && labelFile ? `@${labelFile}:${id}` : null,
    });
  }
  return out;
}

/* ────────────────────────────────────────────────────────────────────────────
 * 3. Cross-reference package — <Model>/<Model>.xref      (issue #77)
 * ──────────────────────────────────────────────────────────────────────────*/

/** Field order of an ElementReferences line — exactly nine, pipe-delimited. */
const XREF_FIELDS = 9;

/**
 * Parse the `ElementReferences` entry of a `.xref` archive.
 *
 * UTF-16LE, newline-separated, pipe-delimited:
 *
 *   /Forms/LACCRMTestDialog|/Classes/FormRun|ClassExtended|1|1||Xppc.exe|LACCE|ApplicationPlatform
 *        source            |     target     |    kind     |ln|cl|?|tool  |srcMod|  targetMod
 *
 * Source and target paths use the same `/Classes/X/Methods/y` convention as the
 * XRef database's own `names.path`, which is why these lines slot into the
 * existing query shapes. Observed kinds: TypeReference, MethodCall, Attribute,
 * ClassExtended, MethodOverride, Property.
 *
 * @param {Buffer} buf  raw (still UTF-16LE) ElementReferences entry
 * @returns {{refs: Array<object>, skipped: number}}
 *          `skipped` counts lines that did not have nine fields — reported
 *          rather than silently dropped, so a format change is visible.
 */
export function parseElementReferences(buf) {
  const text = Buffer.isBuffer(buf) ? buf.toString('utf16le') : String(buf);
  const refs = [];
  let skipped = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.replace(/\r$/, '');
    if (!trimmed) continue;
    const f = trimmed.split('|');
    if (f.length !== XREF_FIELDS) { skipped++; continue; }
    const [sourcePath, targetPath, kind, line_, col, , tool, sourceModule, targetModule] = f;
    if (!sourcePath || !targetPath) { skipped++; continue; }
    refs.push({
      sourcePath,
      targetPath,
      kind: kind || null,
      line: toInt(line_),
      col: toInt(col),
      tool: tool || null,
      sourceModule: sourceModule || null,
      targetModule: targetModule || null,
    });
  }
  return { refs, skipped };
}

/**
 * Parse the `ModuleReferences` entry — UTF-16LE, one module name per line.
 * This is the sealed model's declared dependency list.
 *
 * @param {Buffer} buf
 * @returns {string[]}
 */
export function parseModuleReferences(buf) {
  const text = Buffer.isBuffer(buf) ? buf.toString('utf16le') : String(buf);
  return text.split('\n').map(s => s.replace(/\r$/, '').trim()).filter(Boolean);
}

function toInt(v) {
  const n = Number.parseInt(v, 10);
  return Number.isInteger(n) ? n : null;
}

/* ────────────────────────────────────────────────────────────────────────────
 * 4. Structural descriptors — bin/*.runtime and bin/*.xml   (issue #80)
 * ──────────────────────────────────────────────────────────────────────────*/

/**
 * Parse a `*Extends.runtime` file: TSV, `child<TAB>parent`, an optional
 * `VERSION=…;` header line and a UTF-8 BOM. An empty parent is legitimate (the
 * type extends nothing) and is preserved as null rather than dropped.
 *
 * @param {string} text
 * @returns {Array<{child:string,parent:string|null}>}
 */
export function parseExtendsRuntime(text) {
  if (typeof text !== 'string') return [];
  const out = [];
  for (const line of stripBom(text).split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('VERSION=')) continue;
    const cols = line.split('\t');
    const child = (cols[0] || '').trim();
    if (!child) continue;
    const parent = (cols[1] || '').trim();
    out.push({ child, parent: parent || null });
  }
  return out;
}

/**
 * Parse `*.DeleteActions.runtime`.
 *
 * Row shape, per the file's own header comment:
 *   HeaderTable  LineTable1  LineRelation1  LineDeleteAction1  LineTable2 …
 * i.e. a header table followed by repeating (table, relation, action) triples.
 *
 * @param {string} text
 * @returns {Array<{table:string,target:string,relation:string|null,action:string|null}>}
 */
export function parseDeleteActionsRuntime(text) {
  if (typeof text !== 'string') return [];
  const out = [];
  for (const line of stripBom(text).split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('VERSION=')) continue;
    const cols = line.split('\t');
    const table = (cols[0] || '').trim();
    if (!table) continue;
    for (let i = 1; i + 0 < cols.length; i += 3) {
      const target = (cols[i] || '').trim();
      if (!target) continue;
      out.push({
        table,
        target,
        relation: (cols[i + 1] || '').trim() || null,
        action: (cols[i + 2] || '').trim() || null,
      });
    }
  }
  return out;
}

/**
 * Parse `Dynamics.AX.<Model>.ChainOfCommand.xml` — the record of every
 * Microsoft method this ISV wraps. Operationally this is the most valuable
 * artefact in `bin/`: it is the direct answer to "where has this ISV injected
 * itself into standard code", which is the first question in any upgrade-risk
 * or defect-triage conversation.
 *
 * @param {object} doc  fast-xml-parser output, attributes prefixed with '@_'
 * @returns {Array<{extensionClass:string,target:string|null,targetType:string|null,
 *                  method:string|null,isStatic:boolean}>}
 */
export function parseChainOfCommandDoc(doc) {
  const classes = asArray(doc?.ChainOfCommand?.ExtensionClass);
  const out = [];
  for (const c of classes) {
    const extensionClass = attr(c, 'Name');
    if (!extensionClass) continue;
    const target = attr(c, 'ExtensionTarget');
    const targetType = attr(c, 'ExtensionTargetType');
    const methods = asArray(c?.Method);
    if (!methods.length) {
      out.push({ extensionClass, target, targetType, method: null, isStatic: false });
      continue;
    }
    for (const m of methods) {
      // A <Method> node carries its name as element text and its flags as
      // attributes, so it is an object when attributes are present and a bare
      // string when they are not.
      const method = typeof m === 'object' && m !== null ? textOf(m) : String(m);
      out.push({
        extensionClass,
        target: attr(m, 'ActualExtensionTarget') || target,
        targetType,
        method: method || null,
        isStatic: attr(m, 'IsStatic') === 'True',
      });
    }
  }
  return out;
}

/**
 * Parse `Dynamics.AX.<Model>.<n>.netmodule.xml` — the ISV's delegate and event
 * subscriptions, with pre/post direction.
 *
 * @param {object} doc  fast-xml-parser output
 * @returns {Array<object>}
 */
export function parseEventHandlersDoc(doc) {
  const root = doc?.EventHandlers;
  if (!root) return [];
  // The file groups handlers under one or more category elements
  // (BusinessEventHandlers and friends); take every EventHandler under any.
  const groups = Object.values(root).filter(v => v && typeof v === 'object');
  const out = [];
  for (const g of groups) {
    for (const h of asArray(g.EventHandler)) {
      const delegateElement = attr(h, 'delegateElementName');
      const handlerElement = attr(h, 'eventHandlerElementName');
      if (!delegateElement && !handlerElement) continue;
      out.push({
        delegateElement,
        delegateElementType: attr(h, 'delegateElementTypeId'),
        delegateMethod: attr(h, 'delegateMethodName'),
        handlerElement,
        handlerElementType: attr(h, 'eventHandlerElementTypeId'),
        handlerMethod: attr(h, 'eventHandlerMethodName'),
        delegateType: attr(h, 'delegateTypeId'),
      });
    }
  }
  return out;
}

/**
 * Parse `Dynamics.AX.<Model>.ExtensionsClassTargets.xml` — the extension class
 * to target index.
 *
 * @param {object} doc
 * @returns {Array<{extensionClass:string,target:string|null,targetType:string|null}>}
 */
export function parseExtensionClassTargetsDoc(doc) {
  return asArray(doc?.ExtensionClasses?.ExtensionClass)
    .map(c => ({
      extensionClass: attr(c, 'ExtensionClassName'),
      target: attr(c, 'ExtensionTargetName'),
      targetType: attr(c, 'ExtensionTargetTypeId'),
    }))
    .filter(r => r.extensionClass);
}

/* ────────────────────────────────────────────────────────────────────────────
 * 5. Model identity from the assembly version resource        (issue #76)
 * ──────────────────────────────────────────────────────────────────────────*/

/** Version-resource keys worth recovering; everything else is ignored. */
const VERSION_INFO_KEYS = ['CompanyName', 'FileVersion', 'ProductVersion', 'ProductName'];

/**
 * Recover publisher and version for a sealed model.
 *
 * Sealed models ship no `Descriptor/<Model>.xml`, so `readModelDescriptors()`
 * finds nothing for them and they are absent from `model_versions` entirely.
 * The identity is still on disk: `Dynamics.AX.<Model>.dll` carries a Win32
 * VS_VERSION_INFO resource whose StringFileInfo block stores key and value as
 * consecutive UTF-16LE strings.
 *
  * Rather than implement a full PE resource-directory walk for four strings,
 * this locates each key and reads its value using the `String` structure that
 * precedes it:
 *
 *   wLength : uint16 | wValueLength : uint16 | wType : uint16 | szKey ... | pad | Value
 *
 * `wValueLength` is the value's length in UTF-16 code units including the
 * terminator, so the value is read by declared length rather than by scanning
 * for the next NUL -- which is what stops a following struct's length field
 * from being mistaken for text. A key whose `wValueLength` is 0 has no value:
 * on the reference box `CompanyName` is empty in every sealed model's assembly,
 * so the publisher genuinely is not recorded there and callers store the
 * literal 'unknown'. An honest gap beats an invented publisher.
 *
 * @param {Buffer} buf  contents of a .dll
 * @returns {{CompanyName?:string, FileVersion?:string, ProductVersion?:string, ProductName?:string}}
 */
export function parseVersionInfoStrings(buf) {
  const out = {};
  if (!Buffer.isBuffer(buf)) return out;
  for (const key of VERSION_INFO_KEYS) {
    const needle = Buffer.from(key + ' ', 'utf16le');
    const at = buf.indexOf(needle);
    if (at < 6) continue;

    const wValueLength = buf.readUInt16LE(at - 4);
    const wType = buf.readUInt16LE(at - 2);
    // wType 1 == text. wValueLength 0 means the key ships no value at all.
    if (wType !== 1 || wValueLength === 0) continue;

    // The value starts at the next 32-bit boundary after the key.
    let p = at + needle.length;
    if (p % 4 !== 0) p += 4 - (p % 4);
    const bytes = (wValueLength - 1) * 2; // drop the terminator
    if (bytes <= 0 || p + bytes > buf.length) continue;

    const value = buf.subarray(p, p + bytes).toString('utf16le').replace(/ +$/, '').trim();
    // Printable text only -- never control bytes from a mis-located struct.
    if (value && !/[ -]/.test(value)) out[key] = value;
  }
  return out;
}

function stripBom(s) {
  return s.replace(/^﻿/, '');
}

function asArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function attr(node, name) {
  if (!node || typeof node !== 'object') return null;
  const v = node[`@_${name}`];
  return v == null || v === '' ? null : String(v);
}

function textOf(node) {
  const v = node['#text'];
  return v == null ? '' : String(v).trim();
}
