/**
 * PE / CLI metadata reader tests (issue #81).
 *
 * Two jobs, and the second matters more than the first.
 *
 * 1. The reader decodes ECMA-335 structures correctly. The fixtures here are
 *    hand-built PE images rather than a checked-in assembly: a real `.dll`
 *    cannot be committed (it is a vendor's licensed binary), and a synthetic
 *    image pins the *format* rather than one vendor's build of it. Where the
 *    format is documented, the fixture follows the spec section named in the
 *    test.
 *
 * 2. The reader cannot produce source. This is the constraint that justified
 *    option A over a decompiler in issue #81, so it is asserted as a static
 *    scan over the module's own text, not merely as an absence of output. A
 *    future change that adds an IL-body decoder will fail these tests, which is
 *    the entire point of writing them this way.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';

import {
  readCompressedUInt,
  parsePeHeaders,
  parseMetadataRoot,
  parseTableStream,
  decodeType,
  decodeMethodSignature,
  readAssemblySignatures,
  normalizeXppMethods,
  rvaToOffset,
} from '../build/pe-metadata.js';

/* ── compressed integers (II.23.2) ─────────────────────────────────────── */

test('readCompressedUInt decodes the three width forms', () => {
  // 1-byte: high bit clear.
  assert.deepEqual(readCompressedUInt(Buffer.from([0x03]), 0), { value: 0x03, size: 1 });
  assert.deepEqual(readCompressedUInt(Buffer.from([0x7f]), 0), { value: 0x7f, size: 1 });
  // 2-byte: 10xxxxxx.
  assert.deepEqual(readCompressedUInt(Buffer.from([0x80, 0x80]), 0), { value: 0x80, size: 2 });
  assert.deepEqual(readCompressedUInt(Buffer.from([0xbf, 0xff]), 0), { value: 0x3fff, size: 2 });
  // 4-byte: 110xxxxx.
  assert.deepEqual(
    readCompressedUInt(Buffer.from([0xc0, 0x00, 0x40, 0x00]), 0),
    { value: 0x4000, size: 4 });
});

test('readCompressedUInt rejects the reserved prefix rather than guessing a width', () => {
  // 111xxxxx is not a valid compressed-integer prefix. Guessing a width here
  // would silently shift every later field of the signature.
  assert.throws(() => readCompressedUInt(Buffer.from([0xf0, 0, 0, 0]), 0), /invalid compressed/);
});

test('readCompressedUInt refuses to read past the end of the buffer', () => {
  assert.throws(() => readCompressedUInt(Buffer.from([0x80]), 0), /out of range/);
});

/* ── type signatures (II.23.2.12) ──────────────────────────────────────── */

/** Resolver stand-in: names a TypeDef/TypeRef row as `T<table>:<row>`. */
const namer = (table, row) => `T${table}:${row}`;

test('decodeType decodes the primitive element types', () => {
  const cases = [
    [0x01, 'void'], [0x02, 'boolean'], [0x08, 'int'], [0x0a, 'int64'],
    [0x0e, 'str'], [0x1c, 'object'],
  ];
  for (const [byte, expected] of cases) {
    assert.deepEqual(decodeType(Buffer.from([byte]), 0, namer), { name: expected, size: 1 });
  }
});

test('decodeType resolves CLASS and VALUETYPE through the TypeDefOrRef encoding', () => {
  // ELEMENT_TYPE_CLASS (0x12) + coded index: (row << 2) | tag, tag 1 = TypeRef.
  const sig = Buffer.from([0x12, (7 << 2) | 1]);
  assert.equal(decodeType(sig, 0, namer).name, 'T1:7');
  // tag 0 = TypeDef.
  assert.equal(decodeType(Buffer.from([0x11, (3 << 2) | 0]), 0, namer).name, 'T2:3');
});

test('decodeType handles BYREF, SZARRAY and multi-dimensional ARRAY', () => {
  assert.equal(decodeType(Buffer.from([0x10, 0x08]), 0, namer).name, 'int&');
  assert.equal(decodeType(Buffer.from([0x1d, 0x0e]), 0, namer).name, 'str[]');
  // ARRAY int, rank 2, 0 sizes, 0 lo-bounds.
  const arr = Buffer.from([0x14, 0x08, 0x02, 0x00, 0x00]);
  const got = decodeType(arr, 0, namer);
  assert.equal(got.name, 'int[,]');
  assert.equal(got.size, arr.length, 'the whole array shape must be consumed');
});

test('decodeType expands a generic instantiation', () => {
  // GENERICINST CLASS(TypeRef 5) <int, str>
  const sig = Buffer.from([0x15, 0x12, (5 << 2) | 1, 0x02, 0x08, 0x0e]);
  assert.equal(decodeType(sig, 0, namer).name, 'T1:5<int, str>');
});

test('decodeType skips custom modifiers instead of reporting them as the type', () => {
  // CMOD_OPT <TypeRef 9> int  ->  the type is int; the modifier is not a type.
  const sig = Buffer.from([0x20, (9 << 2) | 1, 0x08]);
  const got = decodeType(sig, 0, namer);
  assert.equal(got.name, 'int');
  assert.equal(got.size, 3);
});

test('decodeType degrades an unknown element type to a marker, not an exception', () => {
  // One odd parameter must not discard an otherwise usable signature.
  assert.match(decodeType(Buffer.from([0x2f]), 0, namer).name, /^\?0x2f$/);
});

/* ── method signatures (II.23.2.1) ─────────────────────────────────────── */

test('decodeMethodSignature reads calling convention, return type and parameters', () => {
  // HASTHIS (0x20), 2 params, returns boolean, takes (int, str).
  const sig = Buffer.from([0x20, 0x02, 0x02, 0x08, 0x0e]);
  assert.deepEqual(decodeMethodSignature(sig, namer), {
    returnType: 'boolean',
    params: ['int', 'str'],
    hasThis: true,
    genericCount: 0,
  });
});

test('decodeMethodSignature reads the generic parameter count', () => {
  // DEFAULT|GENERIC (0x10), 1 generic param, 1 param, returns !!0, takes int.
  const sig = Buffer.from([0x10, 0x01, 0x01, 0x1e, 0x00, 0x08]);
  const got = decodeMethodSignature(sig, namer);
  assert.equal(got.genericCount, 1);
  assert.equal(got.returnType, '!!0');
  assert.deepEqual(got.params, ['int']);
});

test('decodeMethodSignature treats a static method as hasThis=false', () => {
  const sig = Buffer.from([0x00, 0x00, 0x01]); // DEFAULT, 0 params, void
  assert.equal(decodeMethodSignature(sig, namer).hasThis, false);
});

test('decodeMethodSignature returns a shaped result for an empty blob', () => {
  // Some rows carry no signature. That is a missing fact, not a crash.
  assert.deepEqual(decodeMethodSignature(Buffer.alloc(0), namer), {
    returnType: 'unknown', params: [], hasThis: false, genericCount: 0,
  });
});

/* ── PE container ──────────────────────────────────────────────────────── */

/**
 * Build a minimal PE32 image with one section, a CLI header, a metadata root
 * with a `#Strings` / `#Blob` / `#~` stream, and the table rows given.
 *
 * Deliberately assembled by hand: it is the only way to assert that the reader
 * computes table offsets from row counts rather than from a fixed layout.
 */
function buildPe({ tables = {}, strings = ['', 'Widget', 'doThing', '_qty'], blobs = [] } = {}) {
  const SECTION_RVA = 0x2000;
  const SECTION_RAW = 0x400;

  // #Strings heap: NUL-separated, first entry empty.
  const stringOffsets = new Map();
  const stringParts = [];
  let strCursor = 0;
  for (const s of strings) {
    stringOffsets.set(s, strCursor);
    const b = Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])]);
    stringParts.push(b);
    strCursor += b.length;
  }
  const stringHeap = Buffer.concat(stringParts);

  // #Blob heap: each entry length-prefixed; index 0 is a single zero byte.
  const blobOffsets = [];
  const blobParts = [Buffer.from([0])];
  let blobCursor = 1;
  for (const b of blobs) {
    blobOffsets.push(blobCursor);
    const entry = Buffer.concat([Buffer.from([b.length]), b]);
    blobParts.push(entry);
    blobCursor += entry.length;
  }
  const blobHeap = Buffer.concat(blobParts);

  // #~ stream. 2-byte heap indexes throughout (heapSizes = 0).
  const present = Object.keys(tables).map(Number).sort((a, b) => a - b);
  let validLo = 0;
  let validHi = 0;
  for (const t of present) {
    if (t < 32) validLo |= (1 << t); else validHi |= (1 << (t - 32));
  }
  const header = Buffer.alloc(24 + present.length * 4);
  header.writeUInt32LE(0, 0);          // reserved
  header[4] = 2; header[5] = 0;        // major/minor
  header[6] = 0;                       // heapSizes: all 2-byte
  header[7] = 1;                       // reserved
  header.writeUInt32LE(validLo, 8);
  header.writeUInt32LE(validHi, 12);
  header.writeUInt32LE(validLo, 16);   // sorted (unused by the reader)
  header.writeUInt32LE(validHi, 20);
  present.forEach((t, i) => header.writeUInt32LE(tables[t].length, 24 + i * 4));
  const rowBytes = Buffer.concat(present.flatMap(t => tables[t]));
  const tableStream = Buffer.concat([header, rowBytes]);

  // Metadata root: BSJB, version, 3 stream headers.
  const version = Buffer.from('v4.0.30319\0\0', 'utf8'); // padded to 12 = %4
  const streamNames = ['#Strings', '#Blob', '#~'];
  const streamData = [stringHeap, blobHeap, tableStream];
  const nameBufs = streamNames.map((n) => {
    const raw = Buffer.concat([Buffer.from(n, 'ascii'), Buffer.from([0])]);
    return Buffer.concat([raw, Buffer.alloc((4 - (raw.length % 4)) % 4)]);
  });
  const dirSize = nameBufs.reduce((a, b) => a + b.length + 8, 0);
  const rootPrefix = 16 + version.length + 2 + 2;
  let dataCursor = rootPrefix + dirSize;
  const dirParts = [];
  streamData.forEach((d, i) => {
    const h = Buffer.alloc(8);
    h.writeUInt32LE(dataCursor, 0);
    h.writeUInt32LE(d.length, 4);
    dirParts.push(h, nameBufs[i]);
    dataCursor += d.length;
  });
  const root = Buffer.concat([
    Buffer.from([0x42, 0x53, 0x4a, 0x42]),                      // BSJB
    Buffer.from([1, 0, 1, 0]),                                  // major/minor
    Buffer.alloc(4),                                            // reserved
    (() => { const b = Buffer.alloc(4); b.writeUInt32LE(version.length, 0); return b; })(),
    version,
    Buffer.alloc(2),                                            // flags
    (() => { const b = Buffer.alloc(2); b.writeUInt16LE(3, 0); return b; })(),
    ...dirParts,
    ...streamData,
  ]);

  // CLI header (72 bytes; only cb and the MetaData directory are read).
  const cli = Buffer.alloc(72);
  cli.writeUInt32LE(72, 0);
  cli.writeUInt32LE(2, 4);
  cli.writeUInt32LE(SECTION_RVA + 72, 8);   // metadata RVA, just past this header
  cli.writeUInt32LE(root.length, 12);

  const sectionBody = Buffer.concat([cli, root]);

  // DOS + PE + COFF + optional (PE32) + one section header.
  const OPT_SIZE = 224;
  const dos = Buffer.alloc(0x40);
  dos.writeUInt16LE(0x5a4d, 0);
  dos.writeUInt32LE(0x40, 0x3c);

  const coffAndOpt = Buffer.alloc(4 + 20 + OPT_SIZE);
  coffAndOpt.writeUInt32LE(0x00004550, 0);   // "PE\0\0"
  coffAndOpt.writeUInt16LE(0x14c, 4);        // machine i386
  coffAndOpt.writeUInt16LE(1, 6);            // 1 section
  coffAndOpt.writeUInt16LE(OPT_SIZE, 4 + 16);
  coffAndOpt.writeUInt16LE(0x10b, 4 + 20);   // PE32 magic
  // Data directory 14 = CLI header, at opt + 96.
  coffAndOpt.writeUInt32LE(SECTION_RVA, 4 + 20 + 96 + 14 * 8);
  coffAndOpt.writeUInt32LE(72, 4 + 20 + 96 + 14 * 8 + 4);

  const sectionHeader = Buffer.alloc(40);
  sectionHeader.write('.text\0\0\0', 0, 'ascii');
  sectionHeader.writeUInt32LE(sectionBody.length, 8);   // virtual size
  sectionHeader.writeUInt32LE(SECTION_RVA, 12);
  sectionHeader.writeUInt32LE(sectionBody.length, 16);  // raw size
  sectionHeader.writeUInt32LE(SECTION_RAW, 20);

  const head = Buffer.concat([dos, coffAndOpt, sectionHeader]);
  const pad = Buffer.alloc(Math.max(0, SECTION_RAW - head.length));
  return {
    buffer: Buffer.concat([head, pad, sectionBody]),
    stringOffsets,
    blobOffsets,
  };
}

/** 2-byte little-endian, for hand-built rows. */
const w2 = (...vals) => {
  const b = Buffer.alloc(vals.length * 2);
  vals.forEach((v, i) => b.writeUInt16LE(v, i * 2));
  return b;
};

test('parsePeHeaders locates the CLI metadata root through the section table', () => {
  const { buffer } = buildPe({ tables: { 0x02: [] } });
  const { sections, metaOffset, metaSize } = parsePeHeaders(buffer);
  assert.equal(sections.length, 1);
  assert.ok(metaOffset > 0 && metaOffset < buffer.length);
  assert.ok(metaSize > 0);
  assert.equal(parseMetadataRoot(buffer, metaOffset).version, 'v4.0.30319');
});

test('parsePeHeaders rejects a non-PE buffer', () => {
  assert.throws(() => parsePeHeaders(Buffer.from('not an assembly at all, really')), /not a PE/);
});

test('rvaToOffset maps through the section table and rejects an unmapped RVA', () => {
  const sections = [{ virtualAddress: 0x2000, virtualSize: 0x100, rawSize: 0x100, rawOffset: 0x400 }];
  assert.equal(rvaToOffset(sections, 0x2010), 0x410);
  assert.throws(() => rvaToOffset(sections, 0x9999), /is in no section/);
});

test('parseTableStream computes each table offset from the row counts before it', () => {
  // Two tables: Module (0x00) with 3 rows, TypeDef (0x02) with 1. TypeDef's
  // offset must sit exactly 3 Module rows past the start, which is the property
  // that breaks silently if a row size is wrong.
  const moduleRow = () => w2(0, 0, 0, 0, 0); // u2 + str + 3 guid, all 2 bytes
  const typeDefRow = () => Buffer.concat([Buffer.alloc(4), w2(0, 0, 0, 0, 0)]);
  const { buffer } = buildPe({
    tables: { 0x00: [moduleRow(), moduleRow(), moduleRow()], 0x02: [typeDefRow()] },
  });
  const { metaOffset } = parsePeHeaders(buffer);
  const { streams } = parseMetadataRoot(buffer, metaOffset);
  const { tables } = parseTableStream(buffer, streams['#~']);

  assert.equal(tables[0x00].rowCount, 3);
  assert.equal(tables[0x00].rowSize, 10);
  assert.equal(tables[0x02].rowCount, 1);
  assert.equal(tables[0x02].rowSize, 14);
  assert.equal(tables[0x02].offset, tables[0x00].offset + 3 * 10);
});

test('parseTableStream refuses an unknown table id rather than shifting later offsets', () => {
  // Bit 0x30 is not a defined table. Sizing it is impossible, so every table
  // after it would be misread — the reader must say so instead.
  const { buffer } = buildPe({ tables: { 0x30: [Buffer.alloc(4)] } });
  const { metaOffset } = parsePeHeaders(buffer);
  const { streams } = parseMetadataRoot(buffer, metaOffset);
  assert.throws(() => parseTableStream(buffer, streams['#~']), /not in the schema/);
});

/* ── end-to-end over a synthetic assembly ──────────────────────────────── */

test('readAssemblySignatures reads a method with its parameter names and modifiers', () => {
  const strings = ['', 'Widget', 'doThing', '_qty', 'Ns'];
  // DEFAULT, 1 param, returns boolean, takes int.
  const sigBlob = Buffer.from([0x00, 0x01, 0x02, 0x08]);
  const built = buildPe({ tables: { 0x02: [], 0x06: [], 0x08: [] }, strings, blobs: [sigBlob] });
  const so = built.stringOffsets;

  // Rebuild with real rows now that heap offsets are known.
  const typeDefRow = Buffer.concat([
    (() => { const b = Buffer.alloc(4); b.writeUInt32LE(0x00100001, 0); return b; })(), // Flags
    w2(so.get('Widget'), so.get('Ns'), 0, 1, 1),  // Name, Namespace, Extends, FieldList, MethodList
  ]);
  const methodDefRow = Buffer.concat([
    (() => { const b = Buffer.alloc(4); b.writeUInt32LE(0x2050, 0); return b; })(), // RVA
    w2(0,                                    // ImplFlags
      0x0016,                                // Flags: public (6) | static (0x10)
      so.get('doThing'),
      1,                                     // Signature -> blob index 1
      1),                                    // ParamList -> Param row 1
  ]);
  const paramRow = w2(0, 1, so.get('_qty'));  // Flags, Sequence 1, Name

  const { buffer } = buildPe({
    tables: { 0x02: [typeDefRow], 0x06: [methodDefRow], 0x08: [paramRow] },
    strings,
    blobs: [sigBlob],
  });

  const { methods, typeCount } = readAssemblySignatures(buffer);
  assert.equal(typeCount, 1);
  assert.equal(methods.length, 1);
  const m = methods[0];
  assert.equal(m.typeName, 'Widget');
  assert.equal(m.namespace, 'Ns');
  assert.equal(m.methodName, 'doThing');
  assert.equal(m.returnType, 'boolean');
  assert.deepEqual(m.parameters, [{ name: '_qty', type: 'int' }]);
  assert.equal(m.visibility, 'public');
  assert.equal(m.isStatic, true);
  assert.equal(m.isAbstract, false);
  assert.equal(m.kind, 'method');
  assert.equal(m.hasImplementation, true, 'RVA != 0 means the image has a body');
});

test('readAssemblySignatures reports hasImplementation=false for a zero RVA', () => {
  // An abstract or extern method has RVA 0. The reader must distinguish that
  // *without* reading anything at the RVA.
  const strings = ['', 'Widget', 'doThing'];
  const sigBlob = Buffer.from([0x00, 0x00, 0x01]);
  const probe = buildPe({ tables: { 0x02: [], 0x06: [] }, strings, blobs: [sigBlob] });
  const so = probe.stringOffsets;
  const typeDefRow = Buffer.concat([Buffer.alloc(4), w2(so.get('Widget'), 0, 0, 1, 1)]);
  const methodDefRow = Buffer.concat([
    Buffer.alloc(4),                                    // RVA = 0
    w2(0, 0x0406, so.get('doThing'), 1, 1),             // abstract | public
  ]);
  const { buffer } = buildPe({
    tables: { 0x02: [typeDefRow], 0x06: [methodDefRow] }, strings, blobs: [sigBlob],
  });
  const m = readAssemblySignatures(buffer).methods[0];
  assert.equal(m.hasImplementation, false);
  assert.equal(m.isAbstract, true);
});

/* ── X++ normalisation ─────────────────────────────────────────────────── */

const stub = (over = {}) => ({
  namespace: 'Dynamics.AX.Application',
  typeName: 'Foo',
  baseType: null,
  methodName: 'bar',
  kind: 'method',
  returnType: 'void',
  parameters: [],
  paramCount: 0,
  genericCount: 0,
  visibility: 'public',
  isStatic: false,
  isAbstract: false,
  isVirtual: false,
  isFinal: false,
  hasImplementation: true,
  attributes: [],
  ...over,
});

test('normalizeXppMethods strips the backtick twin and keeps the developer-facing row', () => {
  const out = normalizeXppMethods([
    stub({ methodName: '`bar', returnType: 'int' }),
    stub({ methodName: 'bar', returnType: 'void' }),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].methodName, 'bar');
  assert.equal(out[0].returnType, 'void',
    'the non-backtick row must win, so the survivor is deterministic');
});

test('normalizeXppMethods keeps a backtick method that has no twin', () => {
  // 1,647 rows on AmcBankingFoundation are backtick-only (generated CoCHelper
  // types). Dropping them would lose the only record of those methods.
  const out = normalizeXppMethods([stub({ typeName: 'FooCoCHelper', methodName: '`only' })]);
  assert.equal(out.length, 1);
  assert.equal(out[0].methodName, 'only');
});

test('normalizeXppMethods keeps same-named types in different namespaces apart', () => {
  // A sealed model routinely declares `Foo` as both a table and the form of that
  // name. They are different objects and must not de-duplicate into one.
  const out = normalizeXppMethods([
    stub({ namespace: 'Dynamics.AX.Application', methodName: 'init' }),
    stub({ namespace: 'Dynamics.AX.Application.Forms', methodName: 'init' }),
  ]);
  assert.equal(out.length, 2);
});

test('normalizeXppMethods folds the optional-parameter overload into optional flags', () => {
  const real = stub({
    methodName: 'add',
    parameters: [{ name: '_id', type: 'int' }, { name: '_url', type: 'str' }],
    paramCount: 2,
  });
  const generated = stub({
    methodName: 'add',
    parameters: [
      { name: '_id', type: 'int' },
      { name: '_url', type: 'str' },
      { name: '@_url_IsDefaultSet', type: 'boolean' },
    ],
    paramCount: 3,
    attributes: ['OptionalParameterGeneratedMethodAttribute'],
  });
  const out = normalizeXppMethods([real, generated]);
  assert.equal(out.length, 1, 'the generated overload is consumed, not returned');
  assert.deepEqual(out[0].parameters, [
    { name: '_id', type: 'int' },
    { name: '_url', type: 'str', optional: true },
  ]);
});

test('normalizeXppMethods keeps a generated overload when it is the only row', () => {
  const only = stub({
    methodName: 'add',
    parameters: [{ name: '@_x_IsDefaultSet', type: 'boolean' }],
    paramCount: 1,
    attributes: ['OptionalParameterGeneratedMethodAttribute'],
  });
  assert.equal(normalizeXppMethods([only]).length, 1,
    'reporting an artefact beats reporting nothing');
});

/* ── the constraint that justified option A (issue #81) ────────────────── */

test('pe-metadata.js contains no IL body decoder', () => {
  // The guarantee is "structurally incapable of emitting source". Asserting it
  // over the module text is what makes it hold for future edits too, rather
  // than only for today's output shape.
  const src = readFileSync(join(import.meta.dirname, '..', 'build', 'pe-metadata.js'), 'utf8');

  // IL opcode mnemonics that only appear in a body decoder.
  for (const opcode of [
    'ldstr', 'ldarg', 'stloc', 'callvirt', 'brtrue', 'ret\'', 'newobj', 'ldfld',
  ]) {
    assert.ok(!src.includes(opcode), `must not decode IL opcodes (found ${opcode})`);
  }

  // The method-body header is at MethodDef.RVA. Resolving that RVA to an offset
  // would be the first step of reading a body; the reader must never do it.
  assert.ok(!/rvaToOffset\s*\(\s*sections\s*,\s*rva\b/.test(
    src.replace(/export function rvaToOffset[\s\S]*?\n}/, '')),
  'must not resolve a MethodDef RVA to a file offset');

  // Method bodies live in the section data; the only heaps read are the
  // metadata heaps.
  const heapReads = [...src.matchAll(/streams\['(#[A-Za-z~-]+)'\]/g)].map(m => m[1]);
  for (const h of heapReads) {
    assert.ok(['#Strings', '#Blob', '#~', '#-', '#GUID', '#US'].includes(h),
      `unexpected stream read: ${h}`);
  }
  // #US is the user-string heap — literals. It must not be read.
  assert.ok(!heapReads.includes('#US'), 'must not read the user-string (literal) heap');
});

test('the IL schema stores no body, source or literal column', () => {
  const src = readFileSync(
    join(import.meta.dirname, '..', 'src', 'azure', 'isv-schema.js'), 'utf8');
  const ddl = /ISV_IL_SCHEMA = `([\s\S]*?)`;/.exec(src);
  assert.ok(ddl, 'ISV_IL_SCHEMA must exist');
  for (const forbidden of ['body', 'source', 'il_code', 'literal', 'decompil', 'instructions']) {
    assert.ok(!new RegExp(forbidden, 'i').test(ddl[1]),
      `isv_il_methods must not carry a "${forbidden}" column`);
  }
});
