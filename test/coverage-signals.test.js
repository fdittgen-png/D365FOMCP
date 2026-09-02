/**
 * #116 (Q3) — coverage boundaries wired into the handlers.
 *
 * `coverageNotes()` itself is covered by test/coverage-notes.test.js; this file
 * asserts that the TOOLS fire the right signal on the right condition and stay
 * silent otherwise (rule #14: a key is present only when it fires), on fixtures
 * with and without sealed-ISV data.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { z } from 'zod';

import { registerKbTools } from '../src/azure/kb-tools.js';
import { registerXrefTools } from '../src/azure/xref-tools.js';
import { ensureIsvSchema } from '../src/azure/isv-schema.js';
import { coverageKeys } from '../src/azure/output-schemas.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const COVERAGE = Object.keys(coverageKeys);
const fired = (r) => Object.fromEntries(COVERAGE.filter(k => k in r.structuredContent).map(k => [k, r.structuredContent[k]]));
/** The `_…_` signal lines directly under the H2 — the coverage block, not the body's own italics. */
const lines = (r) => {
  const out = [];
  for (const l of r.content[0].text.split('\n').slice(1)) {
    if (!/^_.*_$/.test(l)) break;
    out.push(l);
  }
  return out;
};

function mockServer() {
  const tools = new Map();
  return {
    registerTool(name, config, handler) { tools.set(name, { config, handler }); },
    tools,
    async call(name, args) {
      const t = tools.get(name);
      const r = await t.handler(args);
      // What the SDK does on send: structuredContent must satisfy the outputSchema.
      if (r.structuredContent) {
        const p = z.object(t.config.outputSchema).safeParse(r.structuredContent);
        assert.ok(p.success, `${name}: structuredContent violates its outputSchema — ${JSON.stringify(p.error?.issues?.slice(0, 3))}`);
      }
      return r;
    },
  };
}

function kbDb({ isv = false, partialBuild = null } = {}) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE tables (table_name TEXT, module_id TEXT, label TEXT, table_group TEXT,
      save_per_company TEXT, cache_lookup TEXT, clustered_index TEXT, replacement_key TEXT, is_customized INTEGER DEFAULT 0);
    CREATE TABLE fields (table_name TEXT, field_name TEXT, field_type TEXT, edt TEXT, enum_type TEXT, label TEXT, mandatory TEXT,
      source_module TEXT, is_extension INTEGER DEFAULT 0);
    CREATE TABLE indexes_tbl (table_name TEXT, index_name TEXT, is_unique TEXT, is_clustered TEXT, fields_json TEXT);
    CREATE TABLE relations (source_table TEXT, related_table TEXT, relation_name TEXT, constraints_json TEXT, relationship_type TEXT, on_delete TEXT);
    CREATE TABLE labels (label_id TEXT PRIMARY KEY, text TEXT NOT NULL);
    CREATE TABLE enums (enum_name TEXT, module_id TEXT, label TEXT, values_json TEXT);
    CREATE TABLE kb_search (object_type TEXT, object_name TEXT, module_id TEXT, content TEXT);
    CREATE TABLE data_entities (entity_name TEXT, module_id TEXT, label TEXT, public_name TEXT, public_collection TEXT, is_public INTEGER,
      primary_table TEXT, staging_table TEXT, config_key TEXT);
    CREATE TABLE entity_fields (entity_name TEXT, field_name TEXT, data_field TEXT, data_source TEXT, is_mandatory INTEGER);
    CREATE TABLE methods (owner_type TEXT, owner_name TEXT, method_name TEXT, signature TEXT, is_static INTEGER, source_code TEXT);
    CREATE TABLE kb_metadata (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO tables (table_name, module_id, is_customized) VALUES ('CustTable', 'ApplicationSuite', 1);
    INSERT INTO fields (table_name, field_name, field_type, source_module, is_extension) VALUES
      ('CustTable', 'AccountNum', 'String', 'ApplicationSuite', 0), ('CustTable', 'CustGroup', 'String', 'ApplicationSuite', 0),
      ('CustTable', 'Name', 'String', 'ApplicationSuite', 0),
      ('CustTable', 'TBG_Segment', 'String', 'iExtension', 1), ('CustTable', 'HISOL_Code', 'String', 'HISOL', 1);
    INSERT INTO enums VALUES ('CustVendorBlocked', 'ApplicationSuite', NULL, '[{"name":"No","value":0}]');
    INSERT INTO kb_search VALUES ('table', 'CustTable', 'ApplicationSuite', 'Customer master');
    INSERT INTO data_entities VALUES ('CustCustomerV3Entity', 'ApplicationSuite', NULL, 'CustomerV3', 'CustomersV3', 1, 'CustTable', NULL, NULL);
    INSERT INTO entity_fields VALUES ('CustCustomerV3Entity', 'CustomerAccount', 'AccountNum', 'CustTable', 1),
      ('CustCustomerV3Entity', 'Segment', 'TBG_Segment', 'CustTable', 0), ('CustCustomerV3Entity', 'Code', 'HISOL_Code', 'CustTable', 0);
  `);
  if (isv) ensureIsvSchema(db, 'kb');
  if (partialBuild) db.prepare('INSERT INTO kb_metadata VALUES (?, ?)').run('partial_build', partialBuild);
  return db;
}

function xrefDb({ isv = false } = {}) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE modules (id INTEGER PRIMARY KEY, module TEXT);
    CREATE TABLE names (id INTEGER PRIMARY KEY, path TEXT, module_id INTEGER);
    CREATE TABLE refs (source_id INTEGER, target_id INTEGER, kind INTEGER, line INTEGER, col INTEGER);
    INSERT INTO modules VALUES (1, 'ApplicationSuite');
    INSERT INTO names VALUES (1, '/Tables/CustTable', 1), (2, '/Tables/SalesTable', 1), (3, '/Classes/SalesFormLetter', 1),
      (4, '/Classes/SalesFormLetter/Methods/run', 1), (5, '/Tables/CustTable/Fields/PaymMode', 1);
    INSERT INTO refs VALUES (3, 1, 1, 10, 2), (3, 2, 2, 11, 4), (4, 1, 1, 20, 6), (2, 1, 2, 5, 1);
  `);
  if (isv) {
    ensureIsvSchema(db, 'xref');
    db.exec(`
      INSERT INTO isv_models (model, publisher, version, layer, source_kind, fidelity, depends_on, root, scanned_at, counts)
      VALUES ('Lasernet', 'unknown', '7.2', NULL, 'sealed', 'metadata', '[]', 'r', '2026-08-31T00:00:00.000Z', '{}');
      INSERT INTO isv_names (id, path, module) VALUES (1, '/Classes/LACRunController/Methods/run', 'Lasernet'), (2, '/Forms/LACTutorial/Methods/init', 'Lasernet');
      INSERT INTO isv_refs (source_id, target_path, target_module, kind, line, col, tool) VALUES
        (1, '/Tables/CustTable', 'ApplicationSuite', 'TypeReference', 10, 1, 'Xppc.exe'),
        (1, '/Tables/CustTable/Fields/PaymMode', 'ApplicationSuite', 'MethodCall', 11, 2, 'Xppc.exe'),
        (2, '/Tables/CustTable', 'ApplicationSuite', 'TypeReference', 12, 3, 'Xppc.exe'),
        (2, '/Classes/SalesFormLetter', 'ApplicationSuite', 'TypeReference', 13, 3, 'Xppc.exe');
    `);
  }
  return db;
}

describe('#116 — KB signals', () => {
  it('d365_lookup_table default: provenance_omitted (count + models) and isv_not_scanned; custom_only / include_provenance / ISV fixture silence them', async () => {
    const s = mockServer();
    registerKbTools(s, kbDb());
    const r = await s.call('d365_lookup_table', { table_name: 'CustTable' });
    assert.deepEqual(fired(r), { provenance_omitted: 2, isv_not_scanned: true });
    assert.deepEqual(lines(r), [
      '_2 of 5 fields come from extensions (models: HISOL, iExtension) — pass include_provenance or custom_only to see which._',
      '_Sealed-ISV models not scanned in this snapshot — ISV usages/extensions absent, not zero._',
    ]);
    // The signal lines sit directly under the heading, before the body.
    assert.match(r.content[0].text, /^## CustTable\n_2 of 5 fields/);
    assert.deepEqual(fired(await s.call('d365_lookup_table', { table_name: 'CustTable', custom_only: true })), { isv_not_scanned: true });
    assert.deepEqual(fired(await s.call('d365_lookup_table', { table_name: 'CustTable', include_provenance: true })), { isv_not_scanned: true });

    const withIsv = mockServer();
    registerKbTools(withIsv, kbDb({ isv: true }));
    assert.deepEqual(fired(await withIsv.call('d365_lookup_table', { table_name: 'CustTable', custom_only: true })), {}, 'nothing fires: nothing is hidden');
  });

  it('d365_lookup_table: field_limit_hit fires only when the cap actually cut rows', async () => {
    const s = mockServer();
    registerKbTools(s, kbDb({ isv: true }));
    const capped = await s.call('d365_lookup_table', { table_name: 'CustTable', field_limit: 2, include_provenance: true });
    assert.deepEqual(fired(capped), { field_limit_hit: true });
    assert.deepEqual(lines(capped), ['_Fields capped at 2 of 5 — use fields_like / custom_only / field_limit._']);
    const uncapped = await s.call('d365_lookup_table', { table_name: 'CustTable', field_limit: 5, include_provenance: true });
    assert.deepEqual(fired(uncapped), {});
  });

  it('partial_build joins EVERY KB data response when kb_metadata carries the delta-merge flag, and none otherwise', async () => {
    const s = mockServer();
    registerKbTools(s, kbDb({ isv: true, partialBuild: '2026-09-01T07:12:00.000Z' }));
    const LINE = '_KB is a delta-merged snapshot; kb_search may be stale for base tables extended since 2026-09-01._';
    for (const [tool, args] of [
      ['d365_lookup_table', { table_name: 'CustTable', include_provenance: true }],
      ['d365_get_enum', { enum_name: 'CustVendorBlocked' }],
      ['d365_search', { query: 'customer' }],
      ['d365_get_entity_sources', { entity_name: 'CustCustomerV3Entity', include_provenance: true }],
      ['d365_effective_schema', { table_name: 'CustTable' }],
    ]) {
      const r = await s.call(tool, args);
      assert.equal(r.structuredContent.partial_build, true, `${tool}: partial_build key`);
      assert.ok(lines(r).includes(LINE), `${tool}: partial_build line`);
    }
    const clean = mockServer();
    registerKbTools(clean, kbDb({ isv: true }));
    const r = await clean.call('d365_get_enum', { enum_name: 'CustVendorBlocked' });
    assert.equal('partial_build' in r.structuredContent, false);
  });

  it('d365_get_entity_sources: provenance_omitted by default, silent with custom_only / include_provenance', async () => {
    const s = mockServer();
    registerKbTools(s, kbDb({ isv: true }));
    const r = await s.call('d365_get_entity_sources', { entity_name: 'CustomersV3' });
    assert.deepEqual(fired(r), { provenance_omitted: 2 });
    assert.deepEqual(lines(r), ['_2 of 3 fields come from extensions (models: HISOL, iExtension) — pass include_provenance or custom_only to see which._']);
    assert.deepEqual(fired(await s.call('d365_get_entity_sources', { entity_name: 'CustomersV3', custom_only: true })), {});
    assert.deepEqual(fired(await s.call('d365_get_entity_sources', { entity_name: 'CustomersV3', include_provenance: true })), {});
  });

  it('d365_effective_schema: field_limit_hit and isv_not_scanned', async () => {
    const s = mockServer();
    registerKbTools(s, kbDb());
    const r = await s.call('d365_effective_schema', { table_name: 'CustTable', field_limit: 3 });
    assert.deepEqual(fired(r), { field_limit_hit: true, isv_not_scanned: true });
    assert.equal(lines(r)[0], '_Fields capped at 3 of 5 — use fields_like / custom_only / field_limit._');
    const isv = mockServer();
    registerKbTools(isv, kbDb({ isv: true }));
    assert.deepEqual(fired(await isv.call('d365_effective_schema', { table_name: 'CustTable' })), {});
  });

  it('d365_search: isv_not_scanned only on a pre-ISV database', async () => {
    const s = mockServer();
    registerKbTools(s, kbDb());
    assert.deepEqual(fired(await s.call('d365_search', { query: 'customer' })), { isv_not_scanned: true });
    const isv = mockServer();
    registerKbTools(isv, kbDb({ isv: true }));
    assert.deepEqual(fired(await isv.call('d365_search', { query: 'customer' })), {});
  });
});

describe('#116 — XRef signals', () => {
  it('xref_find_references: exact isv_excluded count by default; absent with include_isv:true; isv_not_scanned on a pre-ISV DB', async () => {
    const s = mockServer();
    registerXrefTools(s, xrefDb({ isv: true }));
    const r = await s.call('xref_find_references', { object_name: 'CustTable' });
    assert.deepEqual(fired(r), { isv_excluded: 3 }, 'two refs to the table + one to its field');
    assert.deepEqual(lines(r), ['_3 sealed-ISV usages exist — pass include_isv:true._']);
    assert.match(r.content[0].text, /^## References to \/Tables\/CustTable\n_3 sealed-ISV usages exist/);
    assert.deepEqual(fired(await s.call('xref_find_references', { object_name: 'CustTable', include_isv: true })), {});
    // Batch: summed over the resolved objects.
    const b = await s.call('xref_find_references', { objects: ['CustTable', 'SalesFormLetter', 'Ghost'] });
    assert.deepEqual(fired(b), { isv_excluded: 4 });
    assert.deepEqual(b.structuredContent.not_found, ['Ghost']);

    const plain = mockServer();
    registerXrefTools(plain, xrefDb());
    const p = await plain.call('xref_find_references', { object_name: 'CustTable' });
    assert.deepEqual(fired(p), { isv_not_scanned: true });
  });

  it('xref_find_references: 0 main references but ISV callers → the empty result carries the isv_excluded line', async () => {
    const s = mockServer();
    registerXrefTools(s, xrefDb({ isv: true }));
    const r = await s.call('xref_find_references', { object_name: 'SalesFormLetter' });
    assert.equal(r._meta.kind, 'empty', 'still a meta-response');
    assert.equal(r.structuredContent.result_count, 0);
    assert.ok(r.content[0].text.endsWith('_1 sealed-ISV usages exist — pass include_isv:true._'), r.content[0].text);
    assert.equal('isv_excluded' in r.structuredContent, false, 'no typed key on a meta-response');
  });

  it('xref_impact_analysis: isv_excluded (dependents are incoming refs); xref_find_usages: only the scan fact', async () => {
    const s = mockServer();
    registerXrefTools(s, xrefDb({ isv: true }));
    assert.deepEqual(fired(await s.call('xref_impact_analysis', { object_name: 'CustTable' })), { isv_excluded: 3 });
    assert.deepEqual(fired(await s.call('xref_find_usages', { object_name: 'SalesFormLetter' })), {},
      'outgoing listing: an ISV ref AT this object is not one of its usages');
    const plain = mockServer();
    registerXrefTools(plain, xrefDb());
    assert.deepEqual(fired(await plain.call('xref_impact_analysis', { object_name: 'CustTable' })), { isv_not_scanned: true });
    assert.deepEqual(fired(await plain.call('xref_find_usages', { object_name: 'SalesFormLetter' })), { isv_not_scanned: true });
  });

  it('xref_object_summary / xref_search_names carry no coverage keys (not in scope, schema unchanged)', async () => {
    const s = mockServer();
    registerXrefTools(s, xrefDb());
    assert.deepEqual(fired(await s.call('xref_object_summary', { object_name: 'CustTable' })), {});
    assert.deepEqual(fired(await s.call('xref_search_names', { pattern: '%Cust%' })), {});
  });
});
