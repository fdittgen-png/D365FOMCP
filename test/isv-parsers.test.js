/**
 * Sealed-ISV parser tests (issues #75–#80).
 *
 * The formats these parsers read are undocumented D365 build artefacts, so the
 * shapes here are pinned from real files on the reference dev box and encoded
 * as synthetic fixtures. If a future D365 release changes a format, these tests
 * are what will say so.
 *
 * The property-tag map for AxEdt is asserted against the byte sequence actually
 * observed in AmcBankingFoundation_AxEdt.md — that is the evidence the map
 * rests on, and it must not drift into a guess.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { XMLParser } from 'fast-xml-parser';

import {
  parseSealedMdDirectory,
  readSealedMdEntry,
  parseSealedPropertyBlob,
  scanSealedStrings,
  parseSealedLabelStore,
  parseLabelFileText,
  parseElementReferences,
  parseModuleReferences,
  parseExtendsRuntime,
  parseDeleteActionsRuntime,
  parseChainOfCommandDoc,
  parseEventHandlersDoc,
  parseExtensionClassTargetsDoc,
  parseVersionInfoStrings,
} from '../build/isv-parsers.js';

const XML = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

/* ── helpers: build a sealed .md store the way D365 writes one ───────────── */

function buildSealedMd(entries) {
  const dirParts = [];
  const payloads = [];
  let offset = 0;
  const count = Buffer.alloc(4);
  count.writeUInt32LE(entries.length, 0);
  dirParts.push(count);

  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const head = Buffer.alloc(1);
    head.writeUInt8(name.length, 0);
    const tail = Buffer.alloc(12);
    tail.writeUInt32LE(e.typeTag ?? 0x3567e243, 0);
    tail.writeUInt32LE(offset, 4);
    tail.writeUInt32LE(e.payload.length, 8);
    dirParts.push(head, name, tail);
    payloads.push(e.payload);
    offset += e.payload.length;
  }
  return Buffer.concat([...dirParts, ...payloads]);
}

/** A TLV property blob: 4-byte header, then [tag][len][utf8] triples. */
function buildPropertyBlob(props, header = Buffer.from([0xd1, 0x00, 0x79, 0x00])) {
  const parts = [header];
  for (const [tag, value] of props) {
    const v = Buffer.from(value, 'utf8');
    parts.push(Buffer.from([tag, v.length]), v);
  }
  return Buffer.concat(parts);
}

/* ── sealed .md directory ────────────────────────────────────────────────── */

test('parseSealedMdDirectory reads names, offsets and sizes', () => {
  const buf = buildSealedMd([
    { name: 'AmcBankSearchString', payload: Buffer.alloc(64, 1) },
    { name: 'AmcBankMatchClassName', payload: Buffer.alloc(69, 2) },
  ]);
  const { entries, payloadBase } = parseSealedMdDirectory(buf);

  assert.equal(entries.length, 2);
  assert.equal(entries[0].name, 'AmcBankSearchString');
  assert.equal(entries[0].offset, 0);
  assert.equal(entries[0].size, 64);
  assert.equal(entries[1].name, 'AmcBankMatchClassName');
  assert.equal(entries[1].offset, 64);
  assert.equal(entries[1].size, 69);
  // 4 count + (1+19+12) + (1+21+12)
  assert.equal(payloadBase, 70);
});

test('parseSealedMdDirectory rejects a file that is not a sealed store', () => {
  const notAStore = Buffer.from('## Actually markdown\n\nhello', 'utf8');
  assert.throws(() => parseSealedMdDirectory(notAStore), /implausible|truncated/);
  assert.throws(() => parseSealedMdDirectory(Buffer.alloc(2)), /too small/);
});

test('readSealedMdEntry refuses to read outside the buffer', () => {
  const buf = buildSealedMd([{ name: 'A', payload: Buffer.from('xyz') }]);
  const { payloadBase } = parseSealedMdDirectory(buf);
  const runaway = readSealedMdEntry(buf, { offset: 0, size: 1_000_000 }, payloadBase);
  assert.equal(runaway.length, 0, 'an over-long entry yields nothing, never adjacent bytes');
});

/* ── sealed .md property blob ────────────────────────────────────────────── */

test('parseSealedPropertyBlob decodes the AxEdt tags observed in the real store', () => {
  // Byte-for-byte the shape of AmcBankSearchString in AmcBankingFoundation_AxEdt.md.
  const blob = buildPropertyBlob([
    [0x0d, 'String255'],
    [0x0f, '@ABA33020'],
    [0x10, '@SYS40543'],
    [0x11, 'AmcBankSearchString'],
  ]);
  const { props, truncated } = parseSealedPropertyBlob(blob);

  assert.deepEqual(props, [
    { tag: '0x0d', value: 'String255' },
    { tag: '0x0f', value: '@ABA33020' },
    { tag: '0x10', value: '@SYS40543' },
    { tag: '0x11', value: 'AmcBankSearchString' },
  ]);
  assert.equal(truncated, false);
});

test('parseSealedPropertyBlob stops rather than inventing a value it cannot frame', () => {
  const good = buildPropertyBlob([[0x11, 'RealName']]);
  // Append a tag claiming a length that runs past the end of the blob.
  const blob = Buffer.concat([good, Buffer.from([0x17, 0xff])]);
  const { props, truncated } = parseSealedPropertyBlob(blob);

  assert.deepEqual(props, [{ tag: '0x11', value: 'RealName' }]);
  assert.equal(truncated, true, 'the un-framable tail is reported, not guessed at');
});

test('parseSealedPropertyBlob rejects binary that would decode as mojibake', () => {
  const blob = Buffer.concat([
    Buffer.from([0xd1, 0x00, 0x79, 0x00]),
    Buffer.from([0x05, 0x03, 0x00, 0x01, 0x02]), // control bytes, not text
  ]);
  const { props, truncated } = parseSealedPropertyBlob(blob);
  assert.deepEqual(props, []);
  assert.equal(truncated, true);
});

/* ── labels ──────────────────────────────────────────────────────────────── */

test('parseLabelFileText reads the legacy @-prefixed form', () => {
  const text = '﻿@LAC0=Label files created on 24/6/2011\r\n ;By user Admin\r\n'
    + '@LAC1=Custom ports\r\n@LAC2=Setup email bodies\r\n';
  const labels = parseLabelFileText(text, 'LAC');

  assert.equal(labels.length, 3);
  assert.deepEqual(labels[1], { id: '@LAC1', text: 'Custom ports', qualifiedId: null });
});

test('parseLabelFileText reads the contemporary bare-identifier form', () => {
  const text = 'AccountStructureMissingForIntercompany=La configuration est manquante\r\n'
    + 'BankAccountDoesNotExistForCashPool=Le compte bancaire\r\n';
  const labels = parseLabelFileText(text, 'AmcBankCashPool');

  assert.equal(labels.length, 2);
  assert.equal(labels[0].id, 'AccountStructureMissingForIntercompany');
  assert.equal(
    labels[0].qualifiedId,
    '@AmcBankCashPool:AccountStructureMissingForIntercompany',
    'the colon form is derived, but the stored id stays verbatim so it joins against metadata'
  );
});

test('parseLabelFileText keeps "=" inside label text', () => {
  const [label] = parseLabelFileText('@LAC9=a = b\r\n', 'LAC');
  assert.equal(label.text, 'a = b');
});

test('parseLabelFileText ignores comments and non-identifier left-hand sides', () => {
  const text = ' ;a comment\r\n\r\nnot an id at all=value\r\n@LAC1=ok\r\n';
  const labels = parseLabelFileText(text, 'LAC');
  assert.deepEqual(labels.map(l => l.id), ['@LAC1']);
});

test('parseSealedLabelStore pairs #content entries with file and language', () => {
  const buf = buildSealedMd([
    { name: 'LAC_en-US', payload: Buffer.from('header', 'utf8') },
    { name: 'LAC_en-US#content', payload: Buffer.from('@LAC1=Custom ports\r\n', 'utf8') },
    { name: 'LAC_de#content', payload: Buffer.from('@LAC1=Eigene Ports\r\n', 'utf8') },
  ]);
  const stores = parseSealedLabelStore(buf);

  assert.equal(stores.length, 2);
  const de = stores.find(s => s.language === 'de');
  assert.equal(de.labelFile, 'LAC');
  assert.deepEqual(de.labels[0], { id: '@LAC1', text: 'Eigene Ports', qualifiedId: null });
});

test('parseSealedLabelStore splits a label-file id that itself contains underscores', () => {
  const buf = buildSealedMd([
    { name: 'AmcBankCashPool_fr#content', payload: Buffer.from('Missing=manquante\r\n', 'utf8') },
  ]);
  const [store] = parseSealedLabelStore(buf);
  assert.equal(store.labelFile, 'AmcBankCashPool');
  assert.equal(store.language, 'fr');
});

/* ── .xref package ───────────────────────────────────────────────────────── */

const XREF_SAMPLE = [
  '/Forms/LACCRMTestDialog|/Classes/FormRun|ClassExtended|1|1||Xppc.exe|LACCE|ApplicationPlatform',
  '/Classes/LACCRMReportExecuteContract/Methods/initResultsArray|/Classes/Map/Methods/getEnumerator|MethodCall|124|62||Xppc.exe|LACCE|KernelTypeModule',
].join('\n');

test('parseElementReferences decodes UTF-16LE pipe-delimited lines', () => {
  const { refs, skipped } = parseElementReferences(Buffer.from(XREF_SAMPLE, 'utf16le'));

  assert.equal(skipped, 0);
  assert.equal(refs.length, 2);
  assert.deepEqual(refs[0], {
    sourcePath: '/Forms/LACCRMTestDialog',
    targetPath: '/Classes/FormRun',
    kind: 'ClassExtended',
    line: 1,
    col: 1,
    tool: 'Xppc.exe',
    sourceModule: 'LACCE',
    targetModule: 'ApplicationPlatform',
  });
  assert.equal(refs[1].line, 124);
  assert.equal(refs[1].col, 62);
});

test('parseElementReferences counts malformed lines instead of dropping them silently', () => {
  const text = XREF_SAMPLE + '\n' + 'not|enough|fields\n';
  const { refs, skipped } = parseElementReferences(Buffer.from(text, 'utf16le'));

  assert.equal(refs.length, 2);
  assert.equal(skipped, 1, 'a format change must be visible in the build output');
});

test('parseModuleReferences reads the dependency list', () => {
  const buf = Buffer.from('ApplicationCommon\nApplicationFoundation\nDirectory\n', 'utf16le');
  assert.deepEqual(parseModuleReferences(buf),
    ['ApplicationCommon', 'ApplicationFoundation', 'Directory']);
});

/* ── structural descriptors ──────────────────────────────────────────────── */

test('parseExtendsRuntime keeps a missing parent as null rather than dropping the row', () => {
  const text = '﻿LACEmailEditorAttribute\tSysAttribute\nLACQueryNode\t\nLACRangePack\t\n';
  const rows = parseExtendsRuntime(text);

  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], { child: 'LACEmailEditorAttribute', parent: 'SysAttribute' });
  assert.deepEqual(rows[1], { child: 'LACQueryNode', parent: null });
});

test('parseExtendsRuntime skips the VERSION header line', () => {
  const rows = parseExtendsRuntime('VERSION=1; header\nA\tB\n');
  assert.deepEqual(rows, [{ child: 'A', parent: 'B' }]);
});

test('parseDeleteActionsRuntime expands the repeating table/relation/action triples', () => {
  const text = '﻿VERSION=1; HeaderTable\tLineTable1\n'
    + 'LACPrinters\tLACNetworkPrinters\tLACPrinters\tC\tLACPrinterProfiles\tLACPrinters\tR\n';
  const rows = parseDeleteActionsRuntime(text);

  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    table: 'LACPrinters', target: 'LACNetworkPrinters', relation: 'LACPrinters', action: 'C',
  });
  assert.equal(rows[1].target, 'LACPrinterProfiles');
  assert.equal(rows[1].action, 'R');
});

test('parseChainOfCommandDoc lists every wrapped method with its target', () => {
  const doc = XML.parse(`<ChainOfCommand>
    <ExtensionClass Name="SalesFormLetter_LAC_Extension" ExtensionTarget="SalesFormLetter" ExtensionTargetType="ClassTypeId">
      <Method ActualExtensionTarget="SalesFormLetter" IsStatic="False">run</Method>
      <Method ActualExtensionTarget="SalesFormLetter" IsStatic="True">construct</Method>
    </ExtensionClass>
  </ChainOfCommand>`);
  const rows = parseChainOfCommandDoc(doc);

  assert.equal(rows.length, 2);
  assert.equal(rows[0].extensionClass, 'SalesFormLetter_LAC_Extension');
  assert.equal(rows[0].target, 'SalesFormLetter');
  assert.equal(rows[0].method, 'run');
  assert.equal(rows[0].isStatic, false);
  assert.equal(rows[1].isStatic, true);
});

test('parseChainOfCommandDoc still records an extension class that wraps nothing', () => {
  const doc = XML.parse(
    '<ChainOfCommand><ExtensionClass Name="X_Extension" ExtensionTarget="Y" ExtensionTargetType="ClassTypeId"/></ChainOfCommand>');
  const rows = parseChainOfCommandDoc(doc);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].method, null);
});

test('parseEventHandlersDoc reads delegate subscriptions with pre/post direction', () => {
  const doc = XML.parse(`<EventHandlers><BusinessEventHandlers>
    <EventHandler delegateElementName="LACNumberFormat" delegateElementTypeId="ClassTypeId"
      delegateMethodName="newFormat" eventHandlerElementName="LACCultureInfo"
      eventHandlerElementTypeId="TableTypeId" eventHandlerMethodName="LACNumberFormat_Pre_newFormat"
      delegateTypeId="PreDelegateTypeId" />
  </BusinessEventHandlers></EventHandlers>`);
  const [row] = parseEventHandlersDoc(doc);

  assert.equal(row.delegateElement, 'LACNumberFormat');
  assert.equal(row.delegateMethod, 'newFormat');
  assert.equal(row.handlerElement, 'LACCultureInfo');
  assert.equal(row.delegateType, 'PreDelegateTypeId');
});

test('parseExtensionClassTargetsDoc maps extension classes to their targets', () => {
  const doc = XML.parse(`<ExtensionClasses>
    <ExtensionClass ExtensionClassName="SysOperationController_LAC_Extension"
      ExtensionTargetName="SysOperationController" ExtensionTargetTypeId="ClassTypeId"
      ExtensionNestedTargetName="" />
  </ExtensionClasses>`);
  const [row] = parseExtensionClassTargetsDoc(doc);

  assert.equal(row.extensionClass, 'SysOperationController_LAC_Extension');
  assert.equal(row.target, 'SysOperationController');
  assert.equal(row.targetType, 'ClassTypeId');
});

test('structural parsers return an empty list rather than throwing on junk input', () => {
  assert.deepEqual(parseExtendsRuntime(null), []);
  assert.deepEqual(parseDeleteActionsRuntime(undefined), []);
  assert.deepEqual(parseChainOfCommandDoc({}), []);
  assert.deepEqual(parseEventHandlersDoc({}), []);
  assert.deepEqual(parseExtensionClassTargetsDoc({}), []);
});

/* ── model identity ──────────────────────────────────────────────────────── */

/**
 * Build one VS_VERSION_INFO `String` entry, the way a real PE stores it:
 *   wLength | wValueLength | wType | szKey (UTF-16, NUL) | pad to 4 | Value
 * `wValueLength` counts UTF-16 code units of Value including its terminator.
 */
function buildVersionString(key, value) {
  const szKey = Buffer.from(key + '\0', 'utf16le');
  const head = Buffer.alloc(6);
  const val = value === null ? Buffer.alloc(0) : Buffer.from(value + '\0', 'utf16le');
  const beforePad = 6 + szKey.length;
  const pad = Buffer.alloc((4 - (beforePad % 4)) % 4);
  head.writeUInt16LE(beforePad + pad.length + val.length, 0);
  head.writeUInt16LE(value === null ? 0 : value.length + 1, 2);
  head.writeUInt16LE(1, 4); // wType: text
  return Buffer.concat([head, szKey, pad, val]);
}

test('parseVersionInfoStrings recovers publisher and version from a version resource', () => {
  const block = Buffer.concat([
    Buffer.alloc(128), // stand-in for the rest of the PE; keeps structs 4-aligned
    buildVersionString('CompanyName', 'Formpipe Software'),
    buildVersionString('FileVersion', '7.2.2.2606022'),
  ]);
  const info = parseVersionInfoStrings(block);

  assert.equal(info.CompanyName, 'Formpipe Software');
  assert.equal(info.FileVersion, '7.2.2.2606022');
});

test('parseVersionInfoStrings treats an empty CompanyName as absent, not as junk', () => {
  // Exactly the shape found in every sealed model's assembly on the reference
  // box: the key is present but ships no value, and the next struct follows
  // immediately. Reading by declared length is what stops that struct's
  // wLength field being reported as the publisher.
  const block = Buffer.concat([
    Buffer.alloc(128),
    buildVersionString('CompanyName', null),
    buildVersionString('FileVersion', '7.2.2.2606022'),
  ]);
  const info = parseVersionInfoStrings(block);

  assert.equal(info.CompanyName, undefined, 'no publisher is reported rather than a wrong one');
  assert.equal(info.FileVersion, '7.2.2.2606022');
});

test('parseVersionInfoStrings yields nothing when the keys are absent', () => {
  assert.deepEqual(parseVersionInfoStrings(Buffer.alloc(4096)), {});
  assert.deepEqual(parseVersionInfoStrings('not a buffer'), {});
});

/* ── length-prefixed string scanner (issue #79 phase 2, Lasernet) ────────── */

test('scanSealedStrings recovers identifiers the strict TLV walk cannot reach', () => {
  // Byte-for-byte the shape of SalesConfirmDetailsTmp.LACExtension in
  // Lasernet_AxTableExtension.md: string entries interleaved with non-string
  // ones (uint32 counts, flag bytes) whose widths are not known per tag. The
  // strict walker stops at byte 4 and yields nothing; this is what makes an
  // ISV field added to a Microsoft table findable at all.
  const blob = Buffer.concat([
    Buffer.from([0xd2, 0x00, 0xcb, 0x01]),          // header
    Buffer.from([0x03, 0x01, 0x00, 0x00, 0x00]),    // non-string entry
    Buffer.from([0xd4, 0x01]),
    Buffer.from([0x08, 0x10]), Buffer.from('LACTransRefRecId'),
    Buffer.from([0x06, 0x23]), Buffer.from('SalesConfirmDetailsTmp.LACExtension'),
    Buffer.from([0x03, 0x05]), Buffer.from('RecId'),
    Buffer.from([0x0b, 0x10]), Buffer.from('CustConfirmTrans'),
    Buffer.from([0xff, 0xff]),
  ]);

  assert.deepEqual(parseSealedPropertyBlob(blob).props, [],
    'precondition: the strict walker recovers nothing from this shape');

  const found = scanSealedStrings(blob);
  assert.deepEqual(found, [
    { tag: '0x08', value: 'LACTransRefRecId' },
    { tag: '0x06', value: 'SalesConfirmDetailsTmp.LACExtension' },
    { tag: '0x03', value: 'RecId' },
    { tag: '0x0b', value: 'CustConfirmTrans' },
  ]);
});

test('scanSealedStrings rejects free prose and binary, keeping only identifiers', () => {
  const withProse = Buffer.concat([
    Buffer.from([0x00, 0x05, 0x0c]), Buffer.from('hello world!'), // has a space and !
    Buffer.from([0x07, 0x09]), Buffer.from('LACReport'),
  ]);
  assert.deepEqual(scanSealedStrings(withProse).map(s => s.value), ['LACReport']);

  assert.deepEqual(scanSealedStrings(Buffer.from([0x01, 0x04, 0x00, 0x01, 0x02, 0x03])), []);
  assert.deepEqual(scanSealedStrings('not a buffer'), []);
});

test('scanSealedStrings never lets one string be re-read inside another', () => {
  // A length byte occurring inside an already-consumed string must not start a
  // second, overlapping match — that is what produced fragment noise before.
  const blob = Buffer.concat([
    Buffer.from([0x00]),
    Buffer.from([0x06, 0x10]), Buffer.from('LACTransRefRecId'),
  ]);
  const found = scanSealedStrings(blob);
  assert.equal(found.length, 1);
  assert.equal(found[0].value, 'LACTransRefRecId');
});
