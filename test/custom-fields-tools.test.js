/**
 * Issue #90 — resolving `_Custom` field names against a live environment.
 *
 * No module mocking: the reader's only outbound calls go through `fetch`, so
 * `globalThis.fetch` is stubbed and *counted*. That gives the two properties
 * the ADR (#87 section 5) demands, as assertions rather than as prose:
 *
 *   1. a field check with no `_Custom` name makes ZERO network calls,
 *   2. a live-source failure never propagates as an error — the caller still
 *      gets the field-class explanation.
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  resolveCustomFieldChecks,
  customFieldsForTable,
  customFieldClassNote,
  customFieldKey,
} from '../src/azure/custom-fields-tools.js';
import { clearCustomFieldsCache } from '../src/azure/custom-fields.js';
import { clearSecretCache } from '../src/azure/key-vault.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const __dirname = dirname(fileURLToPath(import.meta.url));
const METADATA = readFileSync(join(__dirname, 'fixtures', 'odata-metadata-sample.xml'), 'utf-8');

const GUID_A = '00000000-0000-0000-0000-0000000000a1';
const GUID_B = '00000000-0000-0000-0000-0000000000b2';

let db;
let realFetch;
/** Every stubbed request, so "no network call" is provable. */
let calls;
/** Per-test switch: 'ok' | 'token-fail' | 'metadata-fail'. */
let mode;

/** A minimal KB: just the two tables the entity→table attribution reads. */
function createDb() {
  const d = new Database(':memory:');
  d.exec(`
    CREATE TABLE data_entities (
      entity_name TEXT PRIMARY KEY, module_id TEXT, label TEXT,
      public_name TEXT, public_collection TEXT, is_public INTEGER DEFAULT 0,
      primary_table TEXT, staging_table TEXT, config_key TEXT
    );
    CREATE TABLE entity_fields (
      entity_name TEXT, field_name TEXT, data_field TEXT,
      data_source TEXT, is_mandatory INTEGER DEFAULT 0,
      PRIMARY KEY (entity_name, field_name)
    );
  `);
  // WidgetOrderHeader: primary table match — the strong attribution.
  d.prepare(`INSERT INTO data_entities (entity_name, public_name, primary_table) VALUES (?,?,?)`)
    .run('WidgetOrderHeaderEntity', 'WidgetOrderHeader', 'WidgetTable');
  // WidgetAddressPart: no primary table, but reachable as a data source of an
  // entity — the derived attribution.
  d.prepare(`INSERT INTO data_entities (entity_name, public_name, primary_table) VALUES (?,?,?)`)
    .run('WidgetAddressPart', 'WidgetAddressPart', null);
  d.prepare(`INSERT INTO entity_fields (entity_name, field_name, data_field, data_source) VALUES (?,?,?,?)`)
    .run('WidgetAddressPart', 'RegionCode_Custom', 'RegionCode_Custom', 'WidgetAddressTable');
  return d;
}

/** Stub `fetch`: token endpoint, then `$metadata` as a byte stream. */
function installFetchStub() {
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET' });

    if (String(url).includes('login.microsoftonline.com')) {
      if (mode === 'token-fail') {
        return new Response('{"error":"invalid_client","error_description":"secret expired for tenant X"}',
          { status: 401 });
      }
      return new Response(JSON.stringify({ access_token: 'stub-token', expires_in: 3600 }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }

    if (String(url).includes('$metadata')) {
      if (mode === 'metadata-fail') return new Response('forbidden', { status: 403 });
      const bytes = new TextEncoder().encode(METADATA);
      // Deliberately chunked so the streaming path (not a buffered read) runs.
      const stream = new ReadableStream({
        start(controller) {
          for (let i = 0; i < bytes.length; i += 997) controller.enqueue(bytes.subarray(i, i + 997));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'application/xml' } });
    }

    throw new Error(`unexpected fetch: ${url}`);
  };
}

before(() => {
  db = createDb();
  installFetchStub();
  process.env.CUSTOM_FIELDS_SOURCES = JSON.stringify([{
    key: 'stub-uat', title: 'Stub UAT', url: 'https://stub-uat.example.dynamics.com',
    tenantId: GUID_A, clientId: GUID_B, secretName: 'stub-secret', default: true,
  }]);
  delete process.env.KEY_VAULT_NAME;
  process.env.CUSTOM_FIELDS_CLIENT_SECRET_STUB_SECRET = 'not-a-real-secret';
});

after(() => {
  globalThis.fetch = realFetch;
  delete process.env.CUSTOM_FIELDS_SOURCES;
  delete process.env.CUSTOM_FIELDS_CLIENT_SECRET_STUB_SECRET;
  try { db.close(); } catch { /* already closed */ }
});

beforeEach(() => {
  calls = [];
  mode = 'ok';
  clearCustomFieldsCache();
  clearSecretCache();
});

describe('resolveCustomFieldChecks', () => {
  test('given no suffixed field name, when resolved, then no network call is made at all', async () => {
    const r = await resolveCustomFieldChecks(db, []);
    assert.equal(calls.length, 0, 'a check without a _Custom name must not touch the network');
    assert.equal(r.resolved.size, 0);
    assert.equal(r.note, null);
  });

  test('given a custom field on the entity primary table, when resolved, then it is found and attributed', async () => {
    const r = await resolveCustomFieldChecks(db, [
      { table_name: 'WidgetTable', field_name: 'SecondaryContact_Custom' },
    ]);
    const hit = r.resolved.get(customFieldKey('WidgetTable', 'SecondaryContact_Custom'));
    assert.ok(hit, 'expected the field to resolve');
    assert.equal(hit.entity_name, 'WidgetOrderHeader');
    assert.equal(hit.property_name, 'SecondaryContact_Custom');
    assert.equal(hit.type, 'Edm.String');
    assert.equal(hit.max_length, 100);
    assert.equal(hit.attribution, 'primary-table');
    assert.equal(hit.environment, 'stub-uat');
    assert.ok(hit.fetched_at, 'must carry a fetch timestamp');
    // Token + $metadata, once each.
    assert.equal(calls.length, 2);
  });

  test('given a custom field reachable only as a data source, when resolved, then attribution says derived', async () => {
    const r = await resolveCustomFieldChecks(db, [
      { table_name: 'WidgetAddressTable', field_name: 'RegionCode_Custom' },
    ]);
    const hit = r.resolved.get(customFieldKey('WidgetAddressTable', 'RegionCode_Custom'));
    assert.ok(hit);
    assert.equal(hit.attribution, 'derived');
  });

  test('given a suffixed field that is genuinely absent, when resolved, then nothing is fabricated', async () => {
    const r = await resolveCustomFieldChecks(db, [
      { table_name: 'WidgetTable', field_name: 'NotThere_Custom' },
    ]);
    assert.equal(r.resolved.size, 0);
    // An evidenced negative: the environment was named and read.
    assert.equal(r.environment, 'stub-uat');
    assert.ok(r.fetched_at);
    assert.equal(r.note, null);
  });

  test('given two calls, when the cache is warm, then the environment is read once', async () => {
    await resolveCustomFieldChecks(db, [{ table_name: 'WidgetTable', field_name: 'SecondaryContact_Custom' }]);
    const afterFirst = calls.length;
    await resolveCustomFieldChecks(db, [{ table_name: 'WidgetTable', field_name: 'SecondaryContactPhone_Custom' }]);
    assert.equal(calls.length, afterFirst, 'second lookup must be served from the TTL cache');
  });

  test('given a token failure, when resolved, then it degrades to the class note and never throws', async () => {
    mode = 'token-fail';
    const r = await resolveCustomFieldChecks(db, [
      { table_name: 'WidgetTable', field_name: 'SecondaryContact_Custom' },
    ]);
    assert.equal(r.resolved.size, 0);
    assert.ok(r.note, 'a failure must still explain the field class');
    assert.match(r.note, /UI custom field/);
    // The environment's error body named a tenant — it must not surface.
    assert.doesNotMatch(r.note, /invalid_client|secret expired|tenant X/);
  });

  test('given a $metadata failure, when resolved, then it degrades to the class note', async () => {
    mode = 'metadata-fail';
    const r = await resolveCustomFieldChecks(db, [
      { table_name: 'WidgetTable', field_name: 'SecondaryContact_Custom' },
    ]);
    assert.equal(r.resolved.size, 0);
    assert.match(r.note, /UI custom field/);
    assert.match(r.note, /403/);
  });

  test('given no configured source, when resolved, then the note says how to configure one', async () => {
    const saved = process.env.CUSTOM_FIELDS_SOURCES;
    delete process.env.CUSTOM_FIELDS_SOURCES;
    clearCustomFieldsCache();
    try {
      const r = await resolveCustomFieldChecks(db, [
        { table_name: 'WidgetTable', field_name: 'SecondaryContact_Custom' },
      ]);
      assert.equal(calls.length, 0, 'nothing to call when nothing is configured');
      assert.match(r.note, /UI custom field/);
      assert.match(r.note, /Set-D365CustomFieldsSource/);
    } finally {
      process.env.CUSTOM_FIELDS_SOURCES = saved;
      clearCustomFieldsCache();
    }
  });
});

describe('customFieldsForTable', () => {
  test('given a table with custom fields, when listed, then only its fields come back', async () => {
    const r = await customFieldsForTable(db, 'WidgetTable');
    assert.equal(r.environment, 'stub-uat');
    assert.equal(r.note, null);
    const names = r.fields.map(f => f.property_name).sort();
    assert.deepEqual(names, [
      'HandlingCode_Custom',
      'IsFlagged_Custom',
      'OrderCount_Custom',
      'ReviewedDate_Custom',
      'ReviewedOn_Custom',
      'SecondaryContactPhone_Custom',
      'SecondaryContact_Custom',
      'Weighting_Custom',
    ]);
    // The type surface reaches the tool layer intact — this is what a caller
    // asking "and its data type?" gets back.
    const byName = Object.fromEntries(r.fields.map(f => [f.property_name, f]));
    assert.equal(byName.OrderCount_Custom.type, 'Edm.Int32');
    assert.equal(byName.OrderCount_Custom.max_length, null);
    assert.equal(byName.SecondaryContact_Custom.type, 'Edm.String');
    assert.equal(byName.SecondaryContact_Custom.max_length, 100);
    // The staging entity is not attributed to this table by the fixture KB, and
    // must not be invented into the result.
    assert.equal(r.fields.every(f => f.table_name === 'WidgetTable'), true);
  });

  test('given a table with none, when listed, then an empty list and no note', async () => {
    const r = await customFieldsForTable(db, 'UnrelatedTable');
    assert.deepEqual(r.fields, []);
    assert.equal(r.note, null);
  });

  test('given an unreachable environment, when listed, then a note replaces the fields', async () => {
    mode = 'metadata-fail';
    const r = await customFieldsForTable(db, 'WidgetTable');
    assert.deepEqual(r.fields, []);
    assert.ok(r.note);
    assert.equal(r.environment, null);
  });
});

describe('customFieldKey', () => {
  test('given a table and field, when keyed, then it is case-insensitive and stable', () => {
    // kb-tools.js reads this map with the same function. When the key was
    // spelled out as a template literal in both files the two drifted, and the
    // map was filled with keys the reader could never find — silently, because
    // a miss is indistinguishable from "field not present".
    assert.equal(customFieldKey('SalesTable', 'Foo_Custom'), customFieldKey('salestable', 'foo_custom'));
    assert.match(customFieldKey('SalesTable', 'Foo_Custom'), /^SALESTABLE::FOO_CUSTOM$/);
  });
});

describe('customFieldClassNote', () => {
  test('given the note, when rendered, then it explains the class and refuses to imply absence', async () => {
    const note = customFieldClassNote();
    assert.match(note, /_Custom/);
    assert.match(note, /System administration > Setup > Custom fields/);
    // The load-bearing sentence: absence from the snapshot is not evidence.
    assert.match(note, /not evidence/);
  });
});
