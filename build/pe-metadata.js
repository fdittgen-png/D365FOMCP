/**
 * Pure-JS PE / CLI metadata reader — method signatures from sealed assemblies.
 *
 * Issue #81, option A. Sealed ISV models ship `Dynamics.AX.<Model>.dll` plus
 * `*.netmodule` files and no X++ source. Assembly metadata carries exactly one
 * thing the shipped `.md` / `.xref` / `.runtime` artefacts do not: the **method
 * signatures** of the sealed classes — parameter names, parameter types, return
 * types, static / abstract / virtual / final modifiers, visibility, attributes.
 *
 * This reader is deliberately *structurally incapable* of producing source.
 * It walks the metadata tables (ECMA-335 II.22) and decodes signature blobs
 * (II.23.2). It never touches a method body: `MethodDef.RVA` is read only to
 * distinguish "has an implementation" from "abstract / extern", and the bytes
 * at that RVA are never fetched. There is no IL instruction decoder here, no
 * string-literal extraction from bodies, and no path by which one could be
 * added without rewriting the module. That guarantee is the reason this exists
 * rather than a shelled-out decompiler — see issue #81 for the evaluation.
 *
 * Everything produced here is `fidelity: 'il'` and must stay labelled as such
 * downstream: a signature says what a method *accepts and returns*, never what
 * it does. Callers that blur the two turn a fact into a guess.
 *
 * Layout walked, in order:
 *   DOS header (e_lfanew @0x3C) -> PE signature -> COFF header
 *   -> optional header (PE32 / PE32+) -> data directory 14 (CLI header)
 *   -> section table (RVA -> file offset) -> CLI header -> metadata root
 *   -> "BSJB" -> stream headers (#~ / #-, #Strings, #Blob, #GUID, #US)
 *   -> table stream: heap-size flags, valid/sorted bitvectors, row counts
 *   -> row-size computation for every present table -> TypeDef / MethodDef /
 *      Param / CustomAttribute / TypeRef / MemberRef / NestedClass walks.
 *
 * Row sizes for *all* tables must be computed even for tables we never read:
 * a table's byte offset is the sum of the sizes of every present table before
 * it. Getting one wrong silently shifts every later table, which is why the
 * full ECMA-335 schema is transcribed below rather than only the parts used.
 */

/* ── binary primitives ─────────────────────────────────────────────────── */

/** Bounds-checked little-endian readers. A malformed or truncated assembly
 *  must throw a plain Error the caller can report, never read past the end. */
function u8(buf, off) {
  if (off < 0 || off + 1 > buf.length) throw new Error(`read u8 out of range at ${off}`);
  return buf[off];
}
function u16(buf, off) {
  if (off < 0 || off + 2 > buf.length) throw new Error(`read u16 out of range at ${off}`);
  return buf.readUInt16LE(off);
}
function u32(buf, off) {
  if (off < 0 || off + 4 > buf.length) throw new Error(`read u32 out of range at ${off}`);
  return buf.readUInt32LE(off);
}

/**
 * ECMA-335 II.23.2 compressed unsigned integer.
 * @returns {{value:number, size:number}}
 */
export function readCompressedUInt(buf, off) {
  const b0 = u8(buf, off);
  if ((b0 & 0x80) === 0) return { value: b0, size: 1 };
  if ((b0 & 0xc0) === 0x80) return { value: ((b0 & 0x3f) << 8) | u8(buf, off + 1), size: 2 };
  if ((b0 & 0xe0) === 0xc0) {
    return {
      value: ((b0 & 0x1f) << 24) | (u8(buf, off + 1) << 16)
        | (u8(buf, off + 2) << 8) | u8(buf, off + 3),
      size: 4,
    };
  }
  throw new Error(`invalid compressed integer prefix 0x${b0.toString(16)} at ${off}`);
}

/* ── metadata table schema (ECMA-335 II.22) ────────────────────────────── */

/** Table ids used by name, so the schema below reads like the spec. */
const T = {
  Module: 0x00, TypeRef: 0x01, TypeDef: 0x02, FieldPtr: 0x03, Field: 0x04,
  MethodPtr: 0x05, MethodDef: 0x06, ParamPtr: 0x07, Param: 0x08,
  InterfaceImpl: 0x09, MemberRef: 0x0a, Constant: 0x0b, CustomAttribute: 0x0c,
  FieldMarshal: 0x0d, DeclSecurity: 0x0e, ClassLayout: 0x0f, FieldLayout: 0x10,
  StandAloneSig: 0x11, EventMap: 0x12, EventPtr: 0x13, Event: 0x14,
  PropertyMap: 0x15, PropertyPtr: 0x16, Property: 0x17, MethodSemantics: 0x18,
  MethodImpl: 0x19, ModuleRef: 0x1a, TypeSpec: 0x1b, ImplMap: 0x1c,
  FieldRVA: 0x1d, EncLog: 0x1e, EncMap: 0x1f, Assembly: 0x20,
  AssemblyProcessor: 0x21, AssemblyOS: 0x22, AssemblyRef: 0x23,
  AssemblyRefProcessor: 0x24, AssemblyRefOS: 0x25, File: 0x26,
  ExportedType: 0x27, ManifestResource: 0x28, NestedClass: 0x29,
  GenericParam: 0x2a, MethodSpec: 0x2b, GenericParamConstraint: 0x2c,
};

/**
 * Coded-index definitions (II.24.2.6). `tables` may contain null for the
 * reserved tags a tag space leaves unused — those still consume a tag value and
 * therefore still affect the index width, so they must be kept.
 */
const CODED = {
  TypeDefOrRef: { tables: [T.TypeDef, T.TypeRef, T.TypeSpec], bits: 2 },
  HasConstant: { tables: [T.Field, T.Param, T.Property], bits: 2 },
  HasCustomAttribute: {
    tables: [T.MethodDef, T.Field, T.TypeRef, T.TypeDef, T.Param, T.InterfaceImpl,
      T.MemberRef, T.Module, T.DeclSecurity, T.Property, T.Event, T.StandAloneSig,
      T.ModuleRef, T.TypeSpec, T.Assembly, T.AssemblyRef, T.File, T.ExportedType,
      T.ManifestResource, T.GenericParam, T.GenericParamConstraint, T.MethodSpec],
    bits: 5,
  },
  HasFieldMarshal: { tables: [T.Field, T.Param], bits: 1 },
  HasDeclSecurity: { tables: [T.TypeDef, T.MethodDef, T.Assembly], bits: 2 },
  MemberRefParent: {
    tables: [T.TypeDef, T.TypeRef, T.ModuleRef, T.MethodDef, T.TypeSpec], bits: 3,
  },
  HasSemantics: { tables: [T.Event, T.Property], bits: 1 },
  MethodDefOrRef: { tables: [T.MethodDef, T.MemberRef], bits: 1 },
  MemberForwarded: { tables: [T.Field, T.MethodDef], bits: 1 },
  Implementation: { tables: [T.File, T.AssemblyRef, T.ExportedType], bits: 2 },
  CustomAttributeType: { tables: [null, null, T.MethodDef, T.MemberRef, null], bits: 3 },
  ResolutionScope: { tables: [T.Module, T.ModuleRef, T.AssemblyRef, T.TypeRef], bits: 2 },
  TypeOrMethodDef: { tables: [T.TypeDef, T.MethodDef], bits: 1 },
};

/**
 * Column layouts. Encoding: `u1`/`u2`/`u4` fixed width; `str`/`blob`/`guid`
 * heap index; `['idx', table]` simple table index; `['cidx', codedName]`.
 * Transcribed complete — unread tables still contribute to later offsets.
 */
const TABLE_SCHEMA = {
  [T.Module]: ['u2', 'str', 'guid', 'guid', 'guid'],
  [T.TypeRef]: [['cidx', 'ResolutionScope'], 'str', 'str'],
  [T.TypeDef]: ['u4', 'str', 'str', ['cidx', 'TypeDefOrRef'], ['idx', T.Field], ['idx', T.MethodDef]],
  [T.FieldPtr]: [['idx', T.Field]],
  [T.Field]: ['u2', 'str', 'blob'],
  [T.MethodPtr]: [['idx', T.MethodDef]],
  [T.MethodDef]: ['u4', 'u2', 'u2', 'str', 'blob', ['idx', T.Param]],
  [T.ParamPtr]: [['idx', T.Param]],
  [T.Param]: ['u2', 'u2', 'str'],
  [T.InterfaceImpl]: [['idx', T.TypeDef], ['cidx', 'TypeDefOrRef']],
  [T.MemberRef]: [['cidx', 'MemberRefParent'], 'str', 'blob'],
  [T.Constant]: ['u1', 'u1', ['cidx', 'HasConstant'], 'blob'],
  [T.CustomAttribute]: [['cidx', 'HasCustomAttribute'], ['cidx', 'CustomAttributeType'], 'blob'],
  [T.FieldMarshal]: [['cidx', 'HasFieldMarshal'], 'blob'],
  [T.DeclSecurity]: ['u2', ['cidx', 'HasDeclSecurity'], 'blob'],
  [T.ClassLayout]: ['u2', 'u4', ['idx', T.TypeDef]],
  [T.FieldLayout]: ['u4', ['idx', T.Field]],
  [T.StandAloneSig]: ['blob'],
  [T.EventMap]: [['idx', T.TypeDef], ['idx', T.Event]],
  [T.EventPtr]: [['idx', T.Event]],
  [T.Event]: ['u2', 'str', ['cidx', 'TypeDefOrRef']],
  [T.PropertyMap]: [['idx', T.TypeDef], ['idx', T.Property]],
  [T.PropertyPtr]: [['idx', T.Property]],
  [T.Property]: ['u2', 'str', 'blob'],
  [T.MethodSemantics]: ['u2', ['idx', T.MethodDef], ['cidx', 'HasSemantics']],
  [T.MethodImpl]: [['idx', T.TypeDef], ['cidx', 'MethodDefOrRef'], ['cidx', 'MethodDefOrRef']],
  [T.ModuleRef]: ['str'],
  [T.TypeSpec]: ['blob'],
  [T.ImplMap]: ['u2', ['cidx', 'MemberForwarded'], 'str', ['idx', T.ModuleRef]],
  [T.FieldRVA]: ['u4', ['idx', T.Field]],
  [T.EncLog]: ['u4', 'u4'],
  [T.EncMap]: ['u4'],
  [T.Assembly]: ['u4', 'u2', 'u2', 'u2', 'u2', 'u4', 'blob', 'str', 'str'],
  [T.AssemblyProcessor]: ['u4'],
  [T.AssemblyOS]: ['u4', 'u4', 'u4'],
  [T.AssemblyRef]: ['u2', 'u2', 'u2', 'u2', 'u4', 'blob', 'str', 'str', 'blob'],
  [T.AssemblyRefProcessor]: ['u4', ['idx', T.AssemblyRef]],
  [T.AssemblyRefOS]: ['u4', 'u4', 'u4', ['idx', T.AssemblyRef]],
  [T.File]: ['u4', 'str', 'blob'],
  [T.ExportedType]: ['u4', 'u4', 'str', 'str', ['cidx', 'Implementation']],
  [T.ManifestResource]: ['u4', 'u4', 'str', ['cidx', 'Implementation']],
  [T.NestedClass]: [['idx', T.TypeDef], ['idx', T.TypeDef]],
  [T.GenericParam]: ['u2', 'u2', ['cidx', 'TypeOrMethodDef'], 'str'],
  [T.MethodSpec]: [['cidx', 'MethodDefOrRef'], 'blob'],
  [T.GenericParamConstraint]: [['idx', T.GenericParam], ['cidx', 'TypeDefOrRef']],
};

/* ── PE / CLI headers ──────────────────────────────────────────────────── */

/**
 * Parse enough of the PE container to locate the CLI metadata root.
 *
 * Handles PE32 and PE32+ (the data-directory offset differs by 16 bytes) and
 * both `.dll` and `.netmodule` — a netmodule is an ordinary PE with CLI
 * metadata and no `Assembly` table row, which matters not at all here.
 *
 * @param {Buffer} buf
 * @returns {{sections:Array, metaOffset:number, metaSize:number}}
 */
export function parsePeHeaders(buf) {
  if (buf.length < 0x40 || u16(buf, 0) !== 0x5a4d) throw new Error('not a PE file (no MZ)');
  const peOff = u32(buf, 0x3c);
  if (u32(buf, peOff) !== 0x00004550) throw new Error('not a PE file (no PE\\0\\0)');

  const coff = peOff + 4;
  const numSections = u16(buf, coff + 2);
  const optSize = u16(buf, coff + 16);
  const opt = coff + 20;
  if (optSize === 0) throw new Error('PE has no optional header (object file, not an image)');

  const magic = u16(buf, opt);
  // 0x10b = PE32, 0x20b = PE32+. Only the offset of the data directories moves.
  const dirsOff = magic === 0x20b ? opt + 112 : opt + 96;
  if (magic !== 0x10b && magic !== 0x20b) {
    throw new Error(`unknown optional-header magic 0x${magic.toString(16)}`);
  }

  const sections = [];
  const secTable = opt + optSize;
  for (let i = 0; i < numSections; i++) {
    const s = secTable + i * 40;
    sections.push({
      virtualSize: u32(buf, s + 8),
      virtualAddress: u32(buf, s + 12),
      rawSize: u32(buf, s + 16),
      rawOffset: u32(buf, s + 20),
    });
  }

  // Data directory 14 is the CLI header (II.25.3.3). Absent => native PE.
  const cliRva = u32(buf, dirsOff + 14 * 8);
  if (!cliRva) throw new Error('no CLI header — native assembly, nothing to read');

  const cliOff = rvaToOffset(sections, cliRva);
  // CLI header: cb(4) major(2) minor(2) MetaData(rva 4 + size 4) ...
  const metaRva = u32(buf, cliOff + 8);
  const metaSize = u32(buf, cliOff + 12);
  return { sections, metaOffset: rvaToOffset(sections, metaRva), metaSize };
}

/** Map a virtual address to a file offset through the section table. */
export function rvaToOffset(sections, rva) {
  for (const s of sections) {
    // virtualSize can exceed rawSize (bss-like tail); clamp on the raw extent.
    const span = Math.max(s.virtualSize, s.rawSize);
    if (rva >= s.virtualAddress && rva < s.virtualAddress + span) {
      return s.rawOffset + (rva - s.virtualAddress);
    }
  }
  throw new Error(`RVA 0x${rva.toString(16)} is in no section`);
}

/**
 * Parse the metadata root and its stream directory (II.24.2.1–2).
 * @returns {{version:string, streams:Object<string,{offset:number,size:number}>}}
 */
export function parseMetadataRoot(buf, metaOffset) {
  if (u32(buf, metaOffset) !== 0x424a5342) throw new Error('metadata root is not BSJB');
  const versionLen = u32(buf, metaOffset + 12);
  // Version string is padded to a 4-byte boundary.
  let p = metaOffset + 16 + ((versionLen + 3) & ~3);
  const version = buf
    .subarray(metaOffset + 16, metaOffset + 16 + versionLen)
    .toString('utf8').replace(/\0.*$/, '');
  p += 2; // flags
  const numStreams = u16(buf, p);
  p += 2;

  const streams = {};
  for (let i = 0; i < numStreams; i++) {
    const offset = u32(buf, p);
    const size = u32(buf, p + 4);
    p += 8;
    let end = p;
    while (end < buf.length && buf[end] !== 0) end++;
    const name = buf.subarray(p, end).toString('ascii');
    streams[name] = { offset: metaOffset + offset, size };
    p = end + 1;
    p = (p + 3) & ~3; // names are padded to 4 bytes
  }
  return { version, streams };
}

/* ── table stream ──────────────────────────────────────────────────────── */

/**
 * Decode the `#~` (or `#-`) table stream header and compute, for every present
 * table, its row count, row size and absolute file offset.
 *
 * The row-size pass is the load-bearing part: index widths depend on row counts
 * elsewhere in the same stream, so all counts must be read before any size can
 * be computed, and every present table's size contributes to the offsets of the
 * tables after it.
 */
export function parseTableStream(buf, stream) {
  const base = stream.offset;
  const heapSizes = u8(buf, base + 6);
  const strWide = (heapSizes & 0x01) ? 4 : 2;
  const guidWide = (heapSizes & 0x02) ? 4 : 2;
  const blobWide = (heapSizes & 0x04) ? 4 : 2;

  const validLo = u32(buf, base + 8);
  const validHi = u32(buf, base + 12);
  const sortedLo = u32(buf, base + 16); // read for completeness; unused
  const sortedHi = u32(buf, base + 20);
  void sortedLo; void sortedHi;

  const present = [];
  for (let t = 0; t < 64; t++) {
    const bit = t < 32 ? (validLo >>> t) & 1 : (validHi >>> (t - 32)) & 1;
    if (bit) present.push(t);
  }

  let p = base + 24;
  const rows = {};
  for (const t of present) {
    rows[t] = u32(buf, p);
    p += 4;
  }

  const idxWidth = (table) => ((rows[table] || 0) > 0xffff ? 4 : 2);
  const codedWidth = (name) => {
    const def = CODED[name];
    if (!def) throw new Error(`unknown coded index ${name}`);
    const max = Math.max(...def.tables.map(t => (t == null ? 0 : rows[t] || 0)));
    // 2 bytes hold (16 - bits) rows worth of index; beyond that widen to 4.
    return max < (1 << (16 - def.bits)) ? 2 : 4;
  };
  const colWidth = (col) => {
    if (col === 'u1') return 1;
    if (col === 'u2') return 2;
    if (col === 'u4') return 4;
    if (col === 'str') return strWide;
    if (col === 'guid') return guidWide;
    if (col === 'blob') return blobWide;
    if (Array.isArray(col) && col[0] === 'idx') return idxWidth(col[1]);
    if (Array.isArray(col) && col[0] === 'cidx') return codedWidth(col[1]);
    throw new Error(`unknown column spec ${JSON.stringify(col)}`);
  };

  const tables = {};
  let cursor = p;
  for (const t of present) {
    const schema = TABLE_SCHEMA[t];
    if (!schema) {
      // An unknown table id cannot be sized, so every later offset is unknown
      // too. Stop honestly rather than return silently-shifted rows.
      throw new Error(`metadata table 0x${t.toString(16)} is not in the schema`);
    }
    const widths = schema.map(colWidth);
    const rowSize = widths.reduce((a, b) => a + b, 0);
    tables[t] = {
      rowCount: rows[t],
      rowSize,
      offset: cursor,
      widths,
      schema,
      colOffsets: widths.reduce((acc, w) => { acc.push(acc[acc.length - 1] + w); return acc; }, [0]),
    };
    cursor += rowSize * rows[t];
  }

  return { tables, strWide, guidWide, blobWide, heapSizes };
}

/* ── heap accessors ────────────────────────────────────────────────────── */

function makeStringReader(buf, streams) {
  const s = streams['#Strings'];
  if (!s) return () => '';
  return (index) => {
    if (!index) return '';
    const start = s.offset + index;
    if (start >= buf.length) return '';
    let end = start;
    const hardEnd = Math.min(buf.length, s.offset + s.size);
    while (end < hardEnd && buf[end] !== 0) end++;
    return buf.subarray(start, end).toString('utf8');
  };
}

function makeBlobReader(buf, streams) {
  const s = streams['#Blob'];
  if (!s) return () => Buffer.alloc(0);
  return (index) => {
    if (!index) return Buffer.alloc(0);
    const at = s.offset + index;
    if (at >= buf.length) return Buffer.alloc(0);
    const { value, size } = readCompressedUInt(buf, at);
    const start = at + size;
    return buf.subarray(start, Math.min(start + value, buf.length));
  };
}

/* ── row access ────────────────────────────────────────────────────────── */

/**
 * Read one column of one row (1-based row index, as tokens are).
 * @returns {number} the raw column value
 */
function cell(buf, table, row, col) {
  const off = table.offset + (row - 1) * table.rowSize + table.colOffsets[col];
  const w = table.widths[col];
  if (w === 1) return u8(buf, off);
  if (w === 2) return u16(buf, off);
  return u32(buf, off);
}

/** Decode a coded index value into {table, row}; row 0 means "none". */
function decodeCoded(name, value) {
  const def = CODED[name];
  const tag = value & ((1 << def.bits) - 1);
  const row = value >>> def.bits;
  return { table: def.tables[tag] ?? null, row };
}

/* ── signature decoding (II.23.2) ──────────────────────────────────────── */

/** Primitive ELEMENT_TYPE names, rendered the way a D365 developer reads them.
 *  X++ types survive as their own value classes, so these are mostly the CLR
 *  primitives X++ maps onto (`int` -> Int32, `str` -> String, `real` ->
 *  a value class, `boolean` -> Boolean). */
const PRIMITIVE = {
  0x01: 'void', 0x02: 'boolean', 0x03: 'char', 0x04: 'int8', 0x05: 'uint8',
  0x06: 'int16', 0x07: 'uint16', 0x08: 'int', 0x09: 'uint', 0x0a: 'int64',
  0x0b: 'uint64', 0x0c: 'float32', 0x0d: 'float64', 0x0e: 'str',
  0x16: 'typedref', 0x18: 'nativeint', 0x19: 'nativeuint', 0x1c: 'object',
};

/**
 * Decode one Type from a signature blob.
 *
 * Returns a *name*, never anything executable. Unresolvable or malformed
 * encodings degrade to a marker string like `?0x2f` rather than throwing: one
 * odd parameter type must not lose an otherwise good signature.
 *
 * @param {Buffer} sig
 * @param {number} off
 * @param {(t:number,row:number)=>string} typeName  resolver for TypeDef/Ref/Spec
 * @returns {{name:string, size:number}}
 */
export function decodeType(sig, off, typeName) {
  const start = off;
  const et = u8(sig, off);
  off += 1;

  if (PRIMITIVE[et]) return { name: PRIMITIVE[et], size: off - start };

  switch (et) {
    case 0x0f: { // PTR
      const inner = decodeType(sig, off, typeName);
      return { name: `${inner.name}*`, size: off - start + inner.size };
    }
    case 0x10: { // BYREF
      const inner = decodeType(sig, off, typeName);
      return { name: `${inner.name}&`, size: off - start + inner.size };
    }
    case 0x11: // VALUETYPE
    case 0x12: { // CLASS
      const { value, size } = readCompressedUInt(sig, off);
      const tag = value & 3;
      const row = value >>> 2;
      const table = tag === 0 ? T.TypeDef : tag === 1 ? T.TypeRef : T.TypeSpec;
      return { name: typeName(table, row), size: off - start + size };
    }
    case 0x13: { // VAR (class generic parameter)
      const { value, size } = readCompressedUInt(sig, off);
      return { name: `!${value}`, size: off - start + size };
    }
    case 0x1e: { // MVAR (method generic parameter)
      const { value, size } = readCompressedUInt(sig, off);
      return { name: `!!${value}`, size: off - start + size };
    }
    case 0x1d: { // SZARRAY
      const inner = decodeType(sig, off, typeName);
      return { name: `${inner.name}[]`, size: off - start + inner.size };
    }
    case 0x14: { // ARRAY <Type><rank><numSizes><sizes><numLoBounds><loBounds>
      const inner = decodeType(sig, off, typeName);
      let p = off + inner.size;
      const rank = readCompressedUInt(sig, p); p += rank.size;
      const numSizes = readCompressedUInt(sig, p); p += numSizes.size;
      for (let i = 0; i < numSizes.value; i++) p += readCompressedUInt(sig, p).size;
      const numLo = readCompressedUInt(sig, p); p += numLo.size;
      for (let i = 0; i < numLo.value; i++) p += readCompressedUInt(sig, p).size;
      const dims = rank.value > 1 ? ','.repeat(rank.value - 1) : '';
      return { name: `${inner.name}[${dims}]`, size: p - start };
    }
    case 0x15: { // GENERICINST <Type><argCount><args>
      const outer = decodeType(sig, off, typeName);
      let p = off + outer.size;
      const argc = readCompressedUInt(sig, p); p += argc.size;
      const args = [];
      for (let i = 0; i < argc.value; i++) {
        const a = decodeType(sig, p, typeName);
        args.push(a.name);
        p += a.size;
      }
      return { name: `${outer.name}<${args.join(', ')}>`, size: p - start };
    }
    case 0x1f: // CMOD_REQD
    case 0x20: { // CMOD_OPT — a modifier prefixing the real type; skip it
      const { size } = readCompressedUInt(sig, off);
      const inner = decodeType(sig, off + size, typeName);
      return { name: inner.name, size: off - start + size + inner.size };
    }
    case 0x1b: { // FNPTR — a method signature as a type; not named further
      return { name: 'method_ptr', size: off - start };
    }
    case 0x45: { // PINNED
      const inner = decodeType(sig, off, typeName);
      return { name: inner.name, size: off - start + inner.size };
    }
    default:
      return { name: `?0x${et.toString(16)}`, size: off - start };
  }
}

/**
 * Decode a MethodDefSig into a return type and parameter type list.
 *
 * Nothing here reads a method *body*: a MethodDefSig lives in the `#Blob` heap
 * and describes the calling contract only.
 *
 * @returns {{returnType:string, params:string[], hasThis:boolean, genericCount:number}}
 */
export function decodeMethodSignature(sig, typeName) {
  if (!sig || !sig.length) {
    return { returnType: 'unknown', params: [], hasThis: false, genericCount: 0 };
  }
  let p = 0;
  const cc = u8(sig, p); p += 1;
  const hasThis = (cc & 0x20) !== 0;
  let genericCount = 0;
  if (cc & 0x10) { // GENERIC
    const g = readCompressedUInt(sig, p); p += g.size;
    genericCount = g.value;
  }
  const pc = readCompressedUInt(sig, p); p += pc.size;

  const ret = decodeType(sig, p, typeName); p += ret.size;

  const params = [];
  for (let i = 0; i < pc.value; i++) {
    if (p >= sig.length) break;
    if (u8(sig, p) === 0x41) { p += 1; continue; } // SENTINEL (vararg boundary)
    const t = decodeType(sig, p, typeName);
    params.push(t.name);
    p += t.size;
  }
  return { returnType: ret.name, params, hasThis, genericCount };
}

/* ── flag decoding (II.23.1.10) ────────────────────────────────────────── */

const VISIBILITY = ['compiler-controlled', 'private', 'protected internal',
  'internal', 'protected', 'protected or internal', 'public'];

function methodFlags(flags) {
  return {
    visibility: VISIBILITY[flags & 0x0007] ?? 'unknown',
    isStatic: (flags & 0x0010) !== 0,
    isFinal: (flags & 0x0020) !== 0,
    isVirtual: (flags & 0x0040) !== 0,
    isAbstract: (flags & 0x0400) !== 0,
    isSpecialName: (flags & 0x0800) !== 0,
  };
}

/* ── the public reader ─────────────────────────────────────────────────── */

/**
 * Compiler-generated names, measured against `AmcBankingFoundation` (16,961
 * normalised rows). None of these is callable from X++ and all of them would
 * crowd out the methods that are:
 *
 *  - angle brackets — closures, iterators, display classes
 *  - `$name$` / `$name$other` — **1,373 rows**, the Chain-of-Command dispatch
 *    plumbing the compiler injects per extensible method (`$getNextStack$`,
 *    `$deallocateNextStack$`, `$get_$find`, `$set_$find`)
 *  - `.cctor` — the static initialiser; `.ctor` is kept, it is X++ `new()`
 *  - `__`-prefixed, including behind an accessor prefix (`get___Extensions`)
 */
function isCompilerGenerated(name) {
  if (name.includes('<') || name.includes('>')) return true;
  if (name.includes('$')) return true;
  if (name === '.cctor') return true;
  if (name.startsWith('__')) return true;
  // `get___Extensions` / `set___Extensions`: an accessor over a generated
  // property is as generated as the property.
  const bare = name.replace(/^(get|set)_/, '');
  return bare.startsWith('__');
}

/**
 * What kind of member this is, so a caller can filter without re-parsing names.
 *
 * The distinction earns its place on sealed models specifically: `accessor`
 * rows are the CLR property accessors the compiler emits for table fields and
 * form data sources, which makes them the closest thing to a **field list** that
 * exists for a model shipping no `Ax<Type>` XML — worth keeping, and worth
 * being able to exclude, since they arrive in get/set pairs.
 *
 * @returns {'constructor'|'accessor'|'method'}
 */
function memberKind(name) {
  if (name === '.ctor') return 'constructor';
  if (/^(get|set)_/.test(name)) return 'accessor';
  return 'method';
}

/** Drop the CLR generic-arity suffix: `Stack`1<int>` reads as `Stack<int>` to
 *  the X++ audience, and the arity is already implied by the argument list. */
function tidyTypeName(name) {
  return typeof name === 'string' ? name.replace(/`\d+/g, '') : name;
}

/**
 * Read method signatures out of one assembly image.
 *
 * @param {Buffer} buf                 the whole `.dll` / `.netmodule`
 * @param {object} [opts]
 * @param {boolean} [opts.includeCompilerGenerated=false]
 * @returns {{methods:Array<object>, typeCount:number, version:string}}
 */
export function readAssemblySignatures(buf, opts = {}) {
  const includeGenerated = opts.includeCompilerGenerated === true;
  const { sections, metaOffset } = parsePeHeaders(buf);
  void sections;
  const { version, streams } = parseMetadataRoot(buf, metaOffset);
  const tableStream = streams['#~'] || streams['#-'];
  if (!tableStream) throw new Error('no #~ / #- table stream');

  const { tables } = parseTableStream(buf, tableStream);
  const str = makeStringReader(buf, streams);
  const blob = makeBlobReader(buf, streams);

  const typeDef = tables[T.TypeDef];
  const methodDef = tables[T.MethodDef];
  if (!typeDef || !methodDef) return { methods: [], typeCount: 0, version };
  const paramTable = tables[T.Param];

  /* Resolve a TypeDef / TypeRef / TypeSpec row to a readable name. A TypeSpec
   * is a signature blob rather than a name; it is reported as such rather than
   * expanded, because a nested generic instantiation adds noise, not answers. */
  const typeNameCache = new Map();
  const typeName = (table, row) => {
    if (!row) return 'unknown';
    const key = `${table}:${row}`;
    const hit = typeNameCache.get(key);
    if (hit) return hit;
    let name = 'unknown';
    try {
      if (table === T.TypeDef && typeDef && row <= typeDef.rowCount) {
        name = str(cell(buf, typeDef, row, 1));
      } else if (table === T.TypeRef && tables[T.TypeRef] && row <= tables[T.TypeRef].rowCount) {
        name = str(cell(buf, tables[T.TypeRef], row, 1));
      } else if (table === T.TypeSpec) {
        name = 'generic_instance';
      }
    } catch { /* unreadable row — reported as 'unknown', never thrown */ }
    typeNameCache.set(key, name);
    return name;
  };

  /* Parameter names live in a separate table addressed by a run: TypeDef and
   * MethodDef both use the "list" pattern where a row's range ends where the
   * next row's begins. Param.Sequence is 1-based, 0 meaning the return value. */
  const paramNames = (methodRow) => {
    if (!paramTable) return new Map();
    const first = cell(buf, methodDef, methodRow, 5);
    const last = methodRow < methodDef.rowCount
      ? cell(buf, methodDef, methodRow + 1, 5)
      : paramTable.rowCount + 1;
    const out = new Map();
    for (let r = first; r < last && r <= paramTable.rowCount; r++) {
      const seq = cell(buf, paramTable, r, 1);
      if (seq > 0) out.set(seq, str(cell(buf, paramTable, r, 2)));
    }
    return out;
  };

  /* Custom attributes on methods, by MethodDef row. Only the attribute *type
   * name* is taken — the value blob is deliberately not decoded. */
  const attrsByMethod = new Map();
  const ca = tables[T.CustomAttribute];
  if (ca) {
    for (let r = 1; r <= ca.rowCount; r++) {
      let parent, type;
      try {
        parent = decodeCoded('HasCustomAttribute', cell(buf, ca, r, 0));
        if (parent.table !== T.MethodDef || !parent.row) continue;
        type = decodeCoded('CustomAttributeType', cell(buf, ca, r, 1));
      } catch { continue; }
      let name = null;
      try {
        if (type.table === T.MemberRef && tables[T.MemberRef]) {
          const cls = decodeCoded('MemberRefParent', cell(buf, tables[T.MemberRef], type.row, 0));
          name = typeName(cls.table, cls.row);
        } else if (type.table === T.MethodDef) {
          name = 'declared_in_module';
        }
      } catch { /* attribute type unresolvable — skipped, never guessed */ }
      if (!name) continue;
      if (!attrsByMethod.has(parent.row)) attrsByMethod.set(parent.row, []);
      const list = attrsByMethod.get(parent.row);
      if (!list.includes(name)) list.push(name);
    }
  }

  const methods = [];
  let typeCount = 0;

  for (let t = 1; t <= typeDef.rowCount; t++) {
    const tName = str(cell(buf, typeDef, t, 1));
    const tNamespace = str(cell(buf, typeDef, t, 2));
    if (!includeGenerated && isCompilerGenerated(tName)) continue;
    typeCount++;

    const extendsIdx = decodeCoded('TypeDefOrRef', cell(buf, typeDef, t, 3));
    const baseType = extendsIdx.row ? typeName(extendsIdx.table, extendsIdx.row) : null;

    const firstMethod = cell(buf, typeDef, t, 5);
    const lastMethod = t < typeDef.rowCount
      ? cell(buf, typeDef, t + 1, 5)
      : methodDef.rowCount + 1;

    for (let m = firstMethod; m < lastMethod && m <= methodDef.rowCount; m++) {
      let name, flags, sigBlob, rva;
      try {
        rva = cell(buf, methodDef, m, 0);
        flags = cell(buf, methodDef, m, 2);
        name = str(cell(buf, methodDef, m, 3));
        sigBlob = blob(cell(buf, methodDef, m, 4));
      } catch { continue; }
      if (!name) continue;
      if (!includeGenerated && isCompilerGenerated(name)) continue;

      const f = methodFlags(flags);
      let sig;
      try {
        sig = decodeMethodSignature(sigBlob, typeName);
      } catch {
        sig = { returnType: 'unknown', params: [], hasThis: !f.isStatic, genericCount: 0 };
      }

      const names = paramNames(m);
      const parameters = sig.params.map((type, i) => ({
        name: names.get(i + 1) || `_arg${i + 1}`,
        type: tidyTypeName(type),
      }));

      methods.push({
        namespace: tNamespace || null,
        typeName: tidyTypeName(tName),
        baseType: tidyTypeName(baseType),
        methodName: name,
        kind: memberKind(name),
        returnType: tidyTypeName(sig.returnType),
        parameters,
        paramCount: parameters.length,
        genericCount: sig.genericCount,
        visibility: f.visibility,
        isStatic: f.isStatic,
        isAbstract: f.isAbstract,
        isVirtual: f.isVirtual,
        isFinal: f.isFinal,
        // RVA is read as a *boolean*: 0 means abstract or extern, i.e. no
        // implementation in this image. The bytes it points at are never read.
        hasImplementation: rva !== 0,
        attributes: attrsByMethod.get(m) ?? [],
      });
    }
  }

  return { methods, typeCount, version };
}

/* ── X++ IL normalisation ──────────────────────────────────────────────── */

/**
 * Fold the X++ compiler's IL naming artefacts into the shape a developer wrote.
 *
 * Two artefacts dominate a raw read and are pure noise if left in:
 *
 * 1. **Backtick twins.** The X++ compiler emits most methods twice — a virtual
 *    dispatch entry `foo` and a direct-call entry `` `foo ``. Measured on
 *    `AmcBankingFoundation`: 3,586 backtick rows, of which 1,938 have a
 *    contract-identical twin and 1,647 are the only row for their method (they
 *    sit on generated `*CoCHelper` types). The backtick is not part of any
 *    name a developer can write, so it is stripped and the pair de-duplicated,
 *    preferring the row that arrived without one.
 *
 * 2. **Optional-parameter overloads.** X++ optional arguments compile to an
 *    extra overload carrying `OptionalParameterGeneratedMethodAttribute` plus a
 *    companion `@<param>_IsDefaultSet` boolean per optional argument. That
 *    overload is not callable from X++, but it is the only place the metadata
 *    records *which* arguments are optional. So it is consumed rather than
 *    dropped: the flags mark `optional: true` on the real method's parameters,
 *    then the generated overload is removed.
 *
 * @param {Array<object>} methods  rows from readAssemblySignatures()
 * @returns {Array<object>} normalised rows
 */
export function normalizeXppMethods(methods) {
  // Backtick strip + dedupe. Sorting non-backtick first makes the survivor
  // deterministic: the developer-facing row wins any contract disagreement.
  const ordered = [...methods].sort(
    (a, b) => (a.methodName.startsWith('`') ? 1 : 0) - (b.methodName.startsWith('`') ? 1 : 0));
  const seen = new Set();
  const deduped = [];
  for (const m of ordered) {
    const methodName = m.methodName.replace(/^`+/, '');
    if (!methodName) continue;
    const key = [m.namespace ?? '', m.typeName, methodName, m.paramCount, m.isStatic].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push({ ...m, methodName });
  }

  // Optional-parameter fold.
  const groups = new Map();
  for (const m of deduped) {
    const key = `${m.namespace ?? ''}|${m.typeName}|${m.methodName}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }

  const out = [];
  for (const group of groups.values()) {
    const generated = group.filter(
      m => m.attributes.includes('OptionalParameterGeneratedMethodAttribute'));
    const real = group.filter(m => !generated.includes(m));

    const optional = new Set();
    for (const g of generated) {
      for (const p of g.parameters) {
        const hit = /^@?(.+)_IsDefaultSet$/.exec(p.name);
        if (hit) optional.add(hit[1].replace(/^@/, ''));
      }
    }

    // Keep the generated overloads only when removing them would lose the
    // method entirely — reporting an artefact beats reporting nothing.
    const keep = real.length ? real : group;
    for (const m of keep) {
      out.push(optional.size
        ? {
          ...m,
          parameters: m.parameters.map(
            p => (optional.has(p.name.replace(/^@/, '')) ? { ...p, optional: true } : p)),
        }
        : m);
    }
  }
  return out;
}
