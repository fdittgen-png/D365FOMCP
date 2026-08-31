/**
 * Sealed-ISV tool tests (issue #82).
 *
 * Builds a small KB and XRef database in-memory from the same schema the
 * scanner writes, registers the tools against a mock server, and calls them.
 * The mock deliberately bypasses Zod, which is what makes these tests the
 * enforcement point for the handler-level defensive defaults required by
 * response-contract rule #13.
 *
 * The separation guarantee of issue #75 is asserted directly: a database with
 * ISV tables must still answer every non-ISV query exactly as it did before.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { ensureIsvSchema } from '../src/azure/isv-schema.js';
import { registerIsvKbTools } from '../src/azure/isv-kb-tools.js';
import { registerIsvXrefTools } from '../src/azure/isv-xref-tools.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

/** Minimal MCP server stand-in: records registrations, calls handlers raw. */
function mockServer() {
  const tools = new Map();
  return {
    registerTool(name, config, handler) { tools.set(name, { config, handler }); },
    tools,
    call(name, args) {
      const t = tools.get(name);
      assert.ok(t, `tool ${name} is not registered`);
      return t.handler(args);
    },
  };
}

function kbFixture() {
  const db = new Database(':memory:');
  ensureIsvSchema(db, 'kb');
  db.exec(`
    INSERT INTO isv_models (model, publisher, version, layer, source_kind, fidelity, depends_on, root, scanned_at, counts)
    VALUES ('Lasernet', 'unknown', '7.2.2.2606022', NULL, 'sealed', 'metadata',
            '["ApplicationSuite","Directory"]', 'C:/Workspace/MAIN/Metadata', '2026-08-31T00:00:00.000Z',
            '{"elements":1873,"labels":118017,"refs":109283,"coc":43,"events":179}');

    INSERT INTO isv_elements (id, module, element_type, name, blob_size)
    VALUES (1, 'Lasernet', 'AxTable', 'LACReportTable', 4096),
           (2, 'Lasernet', 'AxClass', 'LACRunController', 8192),
           (3, 'Lasernet', 'AxEdt',   'LACReportName',   64);

    INSERT INTO isv_element_props (element_id, tag, prop, value)
    VALUES (3, '0x0d', 'extends', 'String255'),
           (3, '0x0f', 'label',   '@LAC1'),
           (3, '0x17', NULL,      'unmapped-but-kept');

    INSERT INTO isv_coc (module, extension_class, target, target_type, method, is_static)
    VALUES ('Lasernet', 'SalesFormLetter_LAC_Extension', 'SalesFormLetter', 'ClassTypeId', 'run', 0),
           ('Lasernet', 'DocuViewForm_LAC_Extension', 'DocuView', 'FormTypeId', NULL, 0);

    INSERT INTO isv_event_handlers (module, delegate_element, delegate_method, handler_element, handler_method, delegate_type)
    VALUES ('Lasernet', 'SalesFormLetter', 'newFormat', 'LACCultureInfo', 'pre_newFormat', 'PreDelegateTypeId');

    INSERT INTO isv_extends (module, kind, child, parent)
    VALUES ('Lasernet', 'class', 'LACQueryItem_Query', 'LACQueryItem'),
           ('Lasernet', 'table', 'SalesTable_LAC', 'SalesFormLetter');

    INSERT INTO isv_labels (label_id, language, text, module, label_file, qualified_id)
    VALUES ('@LAC1', 'en-US', 'Custom ports', 'Lasernet', 'LAC', NULL),
           ('@LAC1', 'de',    'Benutzerdefinierte Ports', 'Lasernet', 'LAC', NULL);
  `);
  return db;
}

function xrefFixture() {
  const db = new Database(':memory:');
  ensureIsvSchema(db, 'xref');
  db.exec(`
    INSERT INTO isv_models (model, publisher, version, layer, source_kind, fidelity, depends_on, root, scanned_at, counts)
    VALUES ('Lasernet', 'unknown', '7.2.2.2606022', NULL, 'sealed', 'metadata', '[]', 'r', '2026-08-31T00:00:00.000Z', '{}'),
           ('LACCE',    'unknown', '1.0',           NULL, 'sealed', 'metadata', '[]', 'r', '2026-08-31T00:00:00.000Z', '{}');

    INSERT INTO isv_names (id, path, module) VALUES
      (1, '/Classes/LACRunController/Methods/run', 'Lasernet'),
      (2, '/Forms/LACTutorial/Methods/init',       'Lasernet'),
      (3, '/Classes/LACCRMContract/Methods/init',  'LACCE');

    INSERT INTO isv_refs (source_id, target_path, target_module, kind, line, col, tool) VALUES
      (1, '/Tables/CustTable',                'ApplicationSuite', 'TypeReference', 107, 17, 'Xppc.exe'),
      (1, '/Tables/CustTable/Fields/PaymMode','ApplicationSuite', 'MethodCall',    110, 22, 'Xppc.exe'),
      (2, '/Tables/CustTable',                'ApplicationSuite', 'TypeReference', 12,  3,  'Xppc.exe'),
      (3, '/Tables/CustTable',                'ApplicationSuite', 'MethodCall',    44,  9,  'Xppc.exe'),
      (2, '/Tables/CustTableExtended',        'ApplicationSuite', 'TypeReference', 15,  3,  'Xppc.exe'),
      (1, '/Classes/SalesFormLetter/Methods/run', 'ApplicationSuite', 'MethodCall', 90, 5, 'Xppc.exe');
  `);
  return db;
}

/* ── registration contract ───────────────────────────────────────────────── */

test('every ISV tool is read-only annotated and declares an output schema', () => {
  const kb = mockServer();
  const xr = mockServer();
  registerIsvKbTools(kb, kbFixture());
  registerIsvXrefTools(xr, xrefFixture());

  const all = [...kb.tools.entries(), ...xr.tools.entries()];
  assert.ok(all.length >= 4, 'expected at least four ISV tools');
  for (const [name, { config }] of all) {
    assert.deepEqual(config.annotations,
      { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      `${name} must carry READ_ONLY_DB_ANNOTATIONS`);
    assert.ok(config.outputSchema, `${name} must declare an outputSchema`);
    assert.ok(config.description.length > 60, `${name} needs a description that says when to use it`);
  }
});

/* ── d365_isv_list_models ────────────────────────────────────────────────── */

test('d365_isv_list_models reports the registry with parsed dependencies and counts', async () => {
  const s = mockServer();
  registerIsvKbTools(s, kbFixture());
  const r = await s.call('d365_isv_list_models', {});

  const t = r.structuredContent;
  assert.equal(t.isv_data_available, true);
  assert.equal(t.model_count, 1);
  assert.deepEqual(t.models[0].depends_on, ['ApplicationSuite', 'Directory']);
  assert.equal(t.models[0].counts.refs, 109283);
  assert.equal(t.provenance.fidelity, 'metadata');
  assert.equal(t.provenance.source_kind, 'sealed');
  assert.ok(!r.isError);
});

test('ISV tools degrade to an empty success on a database built before the ISV scan', async () => {
  const bare = new Database(':memory:'); // no isv_ tables at all
  const s = mockServer();
  registerIsvKbTools(s, bare);
  const r = await s.call('d365_isv_list_models', {});

  assert.ok(!r.isError, 'an un-scanned database is not an error condition');
  assert.equal(r.structuredContent.isv_data_available, false);
  assert.equal(r.structuredContent.model_count, 0);
  assert.match(r.structuredContent.provenance.caveat, /ISV_SCAN_PATHS/);
});

/* ── d365_isv_lookup ─────────────────────────────────────────────────────── */

test('d365_isv_lookup finds an object the normal KB tools cannot see', async () => {
  const s = mockServer();
  registerIsvKbTools(s, kbFixture());
  const r = await s.call('d365_isv_lookup', { name: 'LACReportTable' });

  const t = r.structuredContent;
  assert.equal(t.found, true);
  assert.equal(t.match_count, 1);
  assert.equal(t.matches[0].module, 'Lasernet');
  assert.equal(t.matches[0].element_type, 'AxTable');
});

test('d365_isv_lookup keeps an unmapped property tag instead of dropping it', async () => {
  const s = mockServer();
  registerIsvKbTools(s, kbFixture());
  const r = await s.call('d365_isv_lookup', { name: 'LACReportName' });

  const props = r.structuredContent.matches[0].properties;
  const byTag = Object.fromEntries(props.map(p => [p.tag, p]));
  assert.equal(byTag['0x0d'].property, 'extends');
  assert.equal(byTag['0x0f'].value, '@LAC1');
  assert.equal(byTag['0x17'].property, null, 'an unconfirmed tag is surfaced as raw, never named');
  assert.equal(byTag['0x17'].value, 'unmapped-but-kept');
});

test('d365_isv_lookup treats "absent from every ISV model" as an empty success', async () => {
  const s = mockServer();
  registerIsvKbTools(s, kbFixture());
  const r = await s.call('d365_isv_lookup', { name: 'CustTable' });

  assert.ok(!r.isError, 'not-found here is information, not a failure');
  assert.equal(r.structuredContent.found, false);
  assert.equal(r.structuredContent.match_count, 0);
});

test('d365_isv_lookup honours prefix_match and rejects a blank name', async () => {
  const s = mockServer();
  registerIsvKbTools(s, kbFixture());

  const pref = await s.call('d365_isv_lookup', { name: 'LAC', prefix_match: true });
  assert.equal(pref.structuredContent.match_count, 3);

  const exact = await s.call('d365_isv_lookup', { name: 'LAC' });
  assert.equal(exact.structuredContent.match_count, 0, 'exact is the default, not prefix');

  const blank = await s.call('d365_isv_lookup', { name: '   ' });
  assert.equal(blank.isError, true);
});

/* ── d365_isv_extension_points ───────────────────────────────────────────── */

test('d365_isv_extension_points answers "which ISVs touch this object"', async () => {
  const s = mockServer();
  registerIsvKbTools(s, kbFixture());
  const r = await s.call('d365_isv_extension_points', { target: 'SalesFormLetter' });

  const t = r.structuredContent;
  assert.equal(t.coc_count, 1);
  assert.equal(t.chain_of_command[0].method, 'run');
  assert.equal(t.event_count, 1);
  assert.equal(t.event_handlers[0].direction, 'PreDelegateTypeId');
  assert.equal(t.extends_count, 1, 'table extension whose parent is the target');
});

test('d365_isv_extension_points lists a whole module when no target is given', async () => {
  const s = mockServer();
  registerIsvKbTools(s, kbFixture());
  const r = await s.call('d365_isv_extension_points', { module: 'Lasernet' });

  assert.equal(r.structuredContent.coc_count, 2);
  assert.equal(r.structuredContent.extends_count, 2);
});

test('d365_isv_extension_points requires at least one of target or module', async () => {
  const s = mockServer();
  registerIsvKbTools(s, kbFixture());
  const r = await s.call('d365_isv_extension_points', {});
  assert.equal(r.isError, true);
});

test('d365_isv_extension_points applies a defensive default when Zod is bypassed', async () => {
  const s = mockServer();
  registerIsvKbTools(s, kbFixture());
  // limit is undefined / nonsense: the handler must not emit "LIMIT undefined".
  for (const limit of [undefined, 0, -5, 99999, 'ten']) {
    const r = await s.call('d365_isv_extension_points', { module: 'Lasernet', limit });
    assert.ok(!r.isError, `limit=${String(limit)} must be clamped, not fail`);
    assert.equal(r.structuredContent.coc_count, 2);
  }
});

/* ── xref_isv_find_usages ────────────────────────────────────────────────── */

test('xref_isv_find_usages returns the ISV callers the main XRef tables lack', async () => {
  const s = mockServer();
  registerIsvXrefTools(s, xrefFixture());
  const r = await s.call('xref_isv_find_usages', { object_name: 'CustTable', object_type: 'Tables' });

  const t = r.structuredContent;
  assert.equal(t.usage_count, 4, 'the object itself plus its member references');
  assert.deepEqual(t.module_summary, [
    { module: 'Lasernet', reference_count: 3 },
    { module: 'LACCE', reference_count: 1 },
  ]);
  assert.ok(t.usages.every(u => u.target_path.startsWith('/Tables/CustTable')));
  assert.deepEqual(
    [...new Set(t.usages.map(u => u.kind))].sort(),
    ['MethodCall', 'TypeReference'],
    'both reference kinds present in the sample survive to the detail list'
  );
  // Detail rows are ordered by module, then path, then line — LACCE before
  // Lasernet under NOCASE collation.
  assert.equal(t.usages[0].module, 'LACCE');
});

test('xref_isv_find_usages does not match a differently-named sibling object', async () => {
  const s = mockServer();
  registerIsvXrefTools(s, xrefFixture());
  const r = await s.call('xref_isv_find_usages', { object_name: 'CustTable', object_type: 'Tables' });

  assert.ok(
    !r.structuredContent.usages.some(u => u.target_path.includes('CustTableExtended')),
    'CustTableExtended is a different object and must not be folded in'
  );
});

test('xref_isv_find_usages filters by module and by reference kind', async () => {
  const s = mockServer();
  registerIsvXrefTools(s, xrefFixture());

  const byModule = await s.call('xref_isv_find_usages',
    { object_name: 'CustTable', object_type: 'Tables', modules: ['LACCE'] });
  assert.equal(byModule.structuredContent.usage_count, 1);

  const byKind = await s.call('xref_isv_find_usages',
    { object_name: 'CustTable', object_type: 'Tables', kind: 'TypeReference' });
  assert.equal(byKind.structuredContent.usage_count, 2);
});

test('xref_isv_find_usages caps the detail list but still reports the true total', async () => {
  const s = mockServer();
  registerIsvXrefTools(s, xrefFixture());
  const r = await s.call('xref_isv_find_usages',
    { object_name: 'CustTable', object_type: 'Tables', limit: 2 });

  const t = r.structuredContent;
  assert.equal(t.usages.length, 2);
  assert.equal(t.truncated, true);
  assert.equal(t.usage_count, 4, 'a truncated detail list must not shrink the blast radius');
});

test('xref_isv_find_usages reports no ISV callers as an empty success', async () => {
  const s = mockServer();
  registerIsvXrefTools(s, xrefFixture());
  const r = await s.call('xref_isv_find_usages', { object_name: 'InventTable', object_type: 'Tables' });

  assert.ok(!r.isError);
  assert.equal(r.structuredContent.usage_count, 0);
});

/* ── separation guarantee (issue #75) ────────────────────────────────────── */

test('the ISV schema adds only isv_-prefixed tables', () => {
  for (const target of ['kb', 'xref']) {
    const db = new Database(':memory:');
    ensureIsvSchema(db, target);
    const names = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    ).all().map(r => r.name);

    assert.ok(names.length > 0, `${target} schema created no tables`);
    for (const n of names) {
      assert.match(n, /^isv_/, `${target}: table ${n} is outside the isv_ namespace`);
    }
  }
});

test('applying the ISV schema leaves an existing table untouched', () => {
  const db = new Database(':memory:');
  db.exec("CREATE TABLE labels (label_id TEXT PRIMARY KEY, text TEXT NOT NULL);"
    + "INSERT INTO labels VALUES ('@SYS40543','Search string');");

  ensureIsvSchema(db, 'kb');

  assert.equal(db.prepare('SELECT COUNT(*) c FROM labels').get().c, 1);
  assert.equal(
    db.prepare("SELECT text FROM labels WHERE label_id='@SYS40543'").get().text,
    'Search string');
});

test('ensureIsvSchema is idempotent', () => {
  const db = new Database(':memory:');
  ensureIsvSchema(db, 'kb');
  ensureIsvSchema(db, 'kb');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM isv_models').get().c, 0);
});

/* ── IL signatures on the tools (issue #81) ────────────────────────────── */

/**
 * The IL pass is off by default, so `kbFixture()` above deliberately leaves
 * `isv_il_methods` empty. That is the common shape in production, and the tools
 * must degrade to "signatures not available" rather than to an error — which is
 * what the last two tests in this block pin.
 */
function withIlRows(db) {
  db.exec(`
    INSERT INTO isv_il_methods
      (module, assembly, namespace, type_name, base_type, method_name, kind,
       return_type, parameters, param_count, generic_count, visibility,
       is_static, is_abstract, is_virtual, is_final, has_implementation, attributes)
    VALUES
      ('Lasernet', 'Dynamics.AX.Lasernet.0.netmodule', 'Dynamics.AX.Application',
       'LACRunController', 'SysOperationServiceController', 'run', 'method',
       'void', '[]', 0, 0, 'public', 0, 0, 1, 0, 1, '[]'),
      ('Lasernet', 'Dynamics.AX.Lasernet.0.netmodule', 'Dynamics.AX.Application',
       'LACRunController', NULL, 'find', 'method',
       'LACReportTable',
       '[{"name":"_reportName","type":"str"},{"name":"_update","type":"boolean","optional":true}]',
       2, 0, 'public', 1, 0, 0, 0, 1, '["DebuggerHiddenAttribute"]'),
      ('Lasernet', 'Dynamics.AX.Lasernet.0.netmodule', 'Dynamics.AX.Application',
       'LACRunController', NULL, 'get_ReportName', 'accessor',
       'str', '[]', 0, 0, 'public', 0, 0, 0, 0, 1, '[]'),
      ('Lasernet', 'Dynamics.AX.Lasernet.0.netmodule', 'Dynamics.AX.Application',
       'SalesFormLetter', NULL, 'run', 'method',
       'void', '[{"name":"_args","type":"xArgs"}]', 1, 0, 'protected',
       0, 0, 1, 0, 1, '[]');
  `);
  return db;
}

test('d365_isv_lookup omits the signature block unless it is asked for', async () => {
  const server = mockServer();
  registerIsvKbTools(server, withIlRows(kbFixture()));
  const res = await server.call('d365_isv_lookup', { name: 'LACRunController' });

  assert.equal(res.structuredContent.signatures_available, false);
  assert.equal(res.structuredContent.signature_count, 0);
  assert.deepEqual(res.structuredContent.signatures, []);
  assert.equal(res.structuredContent.il_provenance, null,
    'no IL provenance when no IL rows were returned');
  assert.ok(!res.content[0].text.includes('fidelity=il'));
});

test('d365_isv_lookup returns signatures with parameter names, types and optional flags', async () => {
  const server = mockServer();
  registerIsvKbTools(server, withIlRows(kbFixture()));
  const res = await server.call('d365_isv_lookup',
    { name: 'LACRunController', include_signatures: true, format: 'markdown' });

  const sc = res.structuredContent;
  assert.equal(sc.signatures_available, true);
  const find = sc.signatures.find(s => s.method_name === 'find');
  assert.ok(find, 'the find() signature must be present');
  assert.equal(find.return_type, 'LACReportTable');
  assert.equal(find.is_static, true);
  assert.deepEqual(find.parameters, [
    { name: '_reportName', type: 'str' },
    { name: '_update', type: 'boolean', optional: true },
  ]);
  assert.equal(find.fidelity, 'il');
  assert.deepEqual(find.attributes, ['DebuggerHiddenAttribute']);

  // The text channel must show the declaration and label the fidelity.
  assert.match(res.content[0].text,
    /public static LACReportTable find\(str _reportName, boolean _update \[optional\]\)/);
  assert.match(res.content[0].text, /fidelity=il/);
});

test('d365_isv_lookup never returns property accessors as method signatures', async () => {
  // A get_/set_ pair is a field-list question, not a signature question, and
  // accessors outnumber real methods — they must not crowd out the answer.
  const server = mockServer();
  registerIsvKbTools(server, withIlRows(kbFixture()));
  const res = await server.call('d365_isv_lookup',
    { name: 'LACRunController', include_signatures: true });

  assert.ok(res.structuredContent.signatures.length > 0);
  for (const sig of res.structuredContent.signatures) {
    assert.notEqual(sig.kind, 'accessor');
    assert.ok(!/^(get|set)_/.test(sig.method_name), `accessor leaked: ${sig.method_name}`);
  }
});

test('d365_isv_lookup carries the distinct IL provenance, not the metadata one', async () => {
  const server = mockServer();
  registerIsvKbTools(server, withIlRows(kbFixture()));
  const res = await server.call('d365_isv_lookup',
    { name: 'LACRunController', include_signatures: true });

  const { il_provenance: il, provenance: meta } = res.structuredContent;
  assert.equal(il.fidelity, 'il');
  assert.equal(meta.fidelity, 'metadata');
  assert.notEqual(il.caveat, meta.caveat,
    'the two fidelities must not render an identical caveat');
  // The caveat must state the limit explicitly: this is what stops a caller
  // reading behaviour out of a signature.
  assert.match(il.caveat, /silent about what it does/i);
  assert.match(il.caveat, /no method body/i);
});

test('d365_isv_lookup reports the IL pass as off rather than failing', async () => {
  const server = mockServer();
  registerIsvKbTools(server, kbFixture()); // no IL rows — the default shape
  const res = await server.call('d365_isv_lookup',
    { name: 'LACRunController', include_signatures: true, format: 'markdown' });

  assert.ok(!res.isError, 'an unpopulated IL table is not an error');
  assert.equal(res.structuredContent.signatures_available, false);
  assert.equal(res.structuredContent.found, true, 'the metadata answer still stands');
  assert.match(res.content[0].text, /ISV_IL_SCAN=1/,
    'the response must say how to populate it');
});

test('d365_isv_extension_points attaches the wrapped signature a CoC wrapper must match', async () => {
  const server = mockServer();
  registerIsvKbTools(server, withIlRows(kbFixture()));
  const res = await server.call('d365_isv_extension_points',
    { target: 'SalesFormLetter', include_signatures: true, format: 'markdown' });

  const coc = res.structuredContent.chain_of_command.find(r => r.method === 'run');
  assert.ok(coc, 'the CoC row for SalesFormLetter.run must be present');
  assert.ok(coc.signature, 'the wrapped signature must be attached');
  assert.deepEqual(coc.signature.parameters, [{ name: '_args', type: 'xArgs' }]);
  assert.equal(coc.signature.fidelity, 'il');
  assert.equal(res.structuredContent.signatures_available, true);
  assert.match(res.content[0].text, /Wrapped signature \(il\)/);

  // A class-level row has no method, so it must carry no signature rather than
  // borrowing one from a sibling row on the same target.
  const classLevel = res.structuredContent.chain_of_command.find(r => r.method === null);
  if (classLevel) assert.equal(classLevel.signature, null);
});

test('d365_isv_extension_points leaves the CoC table unchanged when signatures are not requested', async () => {
  const server = mockServer();
  registerIsvKbTools(server, withIlRows(kbFixture()));

  const res = await server.call('d365_isv_extension_points',
    { target: 'SalesFormLetter', format: 'markdown' });
  assert.ok(!res.content[0].text.includes('Wrapped signature'),
    'the signature column must not appear unless asked for');
  for (const r of res.structuredContent.chain_of_command) {
    assert.equal(r.signature, null);
  }
  assert.equal(res.structuredContent.signatures_available, false);
});

test('hasIsvIlData distinguishes an absent table from an empty one', async () => {
  const { hasIsvIlData } = await import('../src/azure/isv-schema.js');
  assert.equal(hasIsvIlData(new Database(':memory:')), false, 'no table at all');
  assert.equal(hasIsvIlData(kbFixture()), false,
    'table present but empty — the IL pass was not run, which is the default');
  assert.equal(hasIsvIlData(withIlRows(kbFixture())), true);
});

/* ── the local-IL command escape hatch (issue #81) ─────────────────────── */

test('d365_isv_lookup emits no IL command unless it is explicitly requested', async () => {
  // The gate matters: this is the one field that points a caller at a
  // disassembler, so it must never appear speculatively — not on a plain
  // lookup, and not merely because signatures were asked for.
  const server = mockServer();
  registerIsvKbTools(server, withIlRows(kbFixture()));

  const plain = await server.call('d365_isv_lookup', { name: 'LACRunController' });
  assert.equal(plain.structuredContent.il_command, null);

  const withSigs = await server.call('d365_isv_lookup',
    { name: 'LACRunController', include_signatures: true, format: 'markdown' });
  assert.equal(withSigs.structuredContent.il_command, null,
    'asking for signatures must not imply asking for a disassembly command');
  assert.ok(!withSigs.content[0].text.includes('ildasm'));
});

test('d365_isv_lookup builds the IL command against the real scanned assembly path', async () => {
  const server = mockServer();
  registerIsvKbTools(server, withIlRows(kbFixture()));
  const res = await server.call('d365_isv_lookup',
    { name: 'LACRunController', include_il_command: true, format: 'markdown' });

  const cmd = res.structuredContent.il_command;
  assert.ok(cmd?.available);
  assert.equal(cmd.targets.length, 1, 'one target per distinct assembly + type');

  const t = cmd.targets[0];
  assert.equal(t.module, 'Lasernet');
  assert.equal(t.assembly, 'Dynamics.AX.Lasernet.0.netmodule');
  assert.equal(t.qualified_type, 'Dynamics.AX.Application.LACRunController');
  // Path comes from isv_models.root, so the command names a real file.
  assert.equal(t.assembly_path,
    'C:\\Workspace\\MAIN\\Metadata\\Lasernet\\bin\\Dynamics.AX.Lasernet.0.netmodule');

  // The filename must precede the options, or ildasm reports MULTIPLE INPUT
  // FILES SPECIFIED — a mistake already made once by hand.
  assert.ok(t.ildasm.indexOf(t.assembly_path) < t.ildasm.indexOf('/item='),
    'the assembly must come before /item= in the ildasm command');
  assert.match(t.ildasm, /\/item="Dynamics\.AX\.Application\.LACRunController"/);

  // A .netmodule cannot generally be loaded by ILSpy standalone; say so.
  assert.match(t.ilspycmd_install, /dotnet tool install -g ilspycmd/);
  assert.ok(t.ilspycmd_caveat, 'a .netmodule target must carry the ILSpy caveat');
  assert.match(t.ilspycmd_caveat, /netmodule/i);

  assert.match(res.content[0].text, /Obtaining the IL locally/);
});

test('the IL command block returns commands only — never IL, a body or source', async () => {
  // The whole point of the feature is that it hands over an invocation and
  // nothing more. If a future change starts shelling out and embedding output,
  // this fails.
  const server = mockServer();
  registerIsvKbTools(server, withIlRows(kbFixture()));
  const res = await server.call('d365_isv_lookup',
    { name: 'LACRunController', include_il_command: true, format: 'markdown' });

  const json = JSON.stringify(res.structuredContent);
  for (const opcode of ['ldarg', 'callvirt', 'stloc', 'IL_0000', 'ldstr', '.maxstack']) {
    assert.ok(!json.includes(opcode), `payload must carry no IL (found ${opcode})`);
  }
  // And it must state the limit rather than leaving it implied.
  assert.match(res.structuredContent.il_command.note, /no IL, no method body and no source text/);
  assert.match(res.structuredContent.il_command.note, /vendor licence agreement/i);
});

test('include_il_command implies the signatures it targets', async () => {
  // The command is built from the declaring assembly, which only the signature
  // rows know. Requesting the command alone must not silently return nothing.
  const server = mockServer();
  registerIsvKbTools(server, withIlRows(kbFixture()));
  const res = await server.call('d365_isv_lookup',
    { name: 'LACRunController', include_il_command: true });

  assert.equal(res.structuredContent.signatures_available, true);
  assert.ok(res.structuredContent.signature_count > 0);
  assert.ok(res.structuredContent.il_command.available);
});

test('the IL command falls back to a placeholder root rather than a wrong path', async () => {
  const db = withIlRows(kbFixture());
  db.prepare('UPDATE isv_models SET root = NULL').run();
  const server = mockServer();
  registerIsvKbTools(server, db);
  const res = await server.call('d365_isv_lookup',
    { name: 'LACRunController', include_il_command: true });

  const t = res.structuredContent.il_command.targets[0];
  assert.match(t.assembly_path, /^<metadata-root>\\/,
    'an unknown root must be visible as a placeholder, not guessed');
});

test('no IL command when the IL pass never ran, even if explicitly asked', async () => {
  const server = mockServer();
  registerIsvKbTools(server, kbFixture()); // no isv_il_methods rows
  const res = await server.call('d365_isv_lookup',
    { name: 'LACRunController', include_il_command: true, format: 'markdown' });

  assert.ok(!res.isError);
  assert.equal(res.structuredContent.il_command, null,
    'nothing to point a disassembler at without a known declaring assembly');
  assert.match(res.content[0].text, /ISV_IL_SCAN=1/);
});
