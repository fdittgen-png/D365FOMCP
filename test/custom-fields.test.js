/**
 * Issue #89 — live custom-field reader.
 *
 * Everything here runs without a network. The scanner is a pure state machine
 * fed strings, which is the whole reason it is exported separately from
 * `fetchCustomFields`.
 *
 * The load-bearing test is the chunk-boundary one: `$metadata` arrives as a
 * stream of arbitrary chunks, so a `<Property …>` tag can be split anywhere.
 * That is the one defect this design can plausibly have, so it is asserted at
 * every offset rather than at a couple of hand-picked ones.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  CUSTOM_FIELD_SUFFIX,
  isCustomFieldName,
  createMetadataScanner,
  scanMetadata,
  resolveSources,
  selectSource,
  getCacheState,
  clearCustomFieldsCache,
  CustomFieldsError,
} from '../src/azure/custom-fields.js';
import { getSecretCacheState, clearSecretCache, KeyVaultError, getSecret } from '../src/azure/key-vault.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(join(__dirname, 'fixtures', 'odata-metadata-sample.xml'), 'utf-8');

/** Env vars this suite manipulates; restored after each test that touches them. */
const ENV_KEYS = [
  'CUSTOM_FIELDS_SOURCES', 'D365_ENV_URL', 'D365_TENANT_ID', 'D365_CLIENT_ID',
  'D365_ENV_KEY', 'D365_ENV_TITLE', 'D365_CLIENT_SECRET_NAME', 'KEY_VAULT_NAME',
];
function withEnv(overrides, fn) {
  const saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
  try {
    for (const k of ENV_KEYS) delete process.env[k];
    Object.assign(process.env, overrides);
    clearCustomFieldsCache();
    clearSecretCache();
    return fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    clearCustomFieldsCache();
    clearSecretCache();
  }
}

const GUID_A = '00000000-0000-0000-0000-0000000000a1';
const GUID_B = '00000000-0000-0000-0000-0000000000b2';

/* ── suffix detection ────────────────────────────────────────────────────── */

test('given the framework suffix, when field names are tested, then only names ending with it match', () => {
  assert.equal(CUSTOM_FIELD_SUFFIX, '_Custom');
  assert.equal(isCustomFieldName('TBGSecondaryContact_Custom'), true);
  // The suffix comparison is case-insensitive: D365 field names are matched
  // NOCASE everywhere else in this codebase.
  assert.equal(isCustomFieldName('tbgsecondarycontact_custom'), true);
  assert.equal(isCustomFieldName('Custom_NotASuffixMatch'), false);
  assert.equal(isCustomFieldName('SalesId'), false);
  assert.equal(isCustomFieldName(''), false);
  assert.equal(isCustomFieldName(null), false);
  assert.equal(isCustomFieldName(undefined), false);
});

/* ── the scanner ─────────────────────────────────────────────────────────── */

test('given the EDMX fixture, when scanned whole, then every custom property is found and attributed', () => {
  const r = scanMetadata(FIXTURE);

  const found = r.fields.map(f => `${f.entity_name}.${f.property_name}`).sort();
  // Sorted: 'P' (0x50) precedes '_' (0x5F), so …ContactPhone_Custom comes
  // before …Contact_Custom.
  assert.deepEqual(found, [
    'WidgetAddressPart.RegionCode_Custom',
    'WidgetOrderHeader.HandlingCode_Custom',
    'WidgetOrderHeader.IsFlagged_Custom',
    'WidgetOrderHeader.OrderCount_Custom',
    'WidgetOrderHeader.ReviewedDate_Custom',
    'WidgetOrderHeader.ReviewedOn_Custom',
    'WidgetOrderHeader.SecondaryContactPhone_Custom',
    'WidgetOrderHeader.SecondaryContact_Custom',
    'WidgetOrderHeader.Weighting_Custom',
    'WidgetOrderHeaderStaging.SecondaryContact_Custom',
  ]);
  assert.equal(r.property_count, 10);
  assert.equal(r.entity_count, 3);
  assert.equal(r.truncated_tail, false);
});

test('given the EDMX fixture, when scanned, then attributes are carried through', () => {
  const r = scanMetadata(FIXTURE);
  const contact = r.fields.find(f =>
    f.entity_name === 'WidgetOrderHeader' && f.property_name === 'SecondaryContact_Custom');
  assert.equal(contact.type, 'Edm.String');
  assert.equal(contact.max_length, 100);
  assert.equal(contact.nullable, true);

  // Attribute order and extra whitespace must not matter.
  const staged = r.fields.find(f => f.entity_name === 'WidgetOrderHeaderStaging');
  assert.equal(staged.property_name, 'SecondaryContact_Custom');
  assert.equal(staged.type, 'Edm.String');
  assert.equal(staged.max_length, 100);

  // Nullable="false" must read as false, not as "absent".
  const region = r.fields.find(f => f.entity_name === 'WidgetAddressPart');
  assert.equal(region.nullable, false);

  const phone = r.fields.find(f => f.property_name === 'SecondaryContactPhone_Custom'
    && f.entity_name === 'WidgetOrderHeader');
  assert.equal(phone.max_length, 30);
  // OData 4.0: an omitted Nullable defaults to true. Apply the spec rather than
  // reporting null and making every caller re-derive it.
  assert.equal(phone.nullable, true);
});

test('given the D365 custom-field type range, when scanned, then the EDM type is carried and max_length is null off strings', () => {
  // What a caller asking "and its data type?" actually receives. The D365 UI
  // offers Text / Integer / Real / Date / Date and time / Checkbox / Picklist;
  // each lands as a different EDM type here. A picklist is indistinguishable
  // from Text in $metadata (its EDT is SysCustomFieldPicklistValue) and its
  // allowed values are NOT in this document — they live in
  // SysCustomFieldPicklist(Values), reachable via the CustomFieldPicklistValue
  // OData entity. Do not claim to know a picklist's values from $metadata.
  const byName = Object.fromEntries(
    scanMetadata(FIXTURE).fields
      .filter(f => f.entity_name === 'WidgetOrderHeader')
      .map(f => [f.property_name, f]));

  assert.equal(byName.OrderCount_Custom.type, 'Edm.Int32');
  assert.equal(byName.Weighting_Custom.type, 'Edm.Decimal');
  assert.equal(byName.ReviewedOn_Custom.type, 'Edm.DateTimeOffset');
  assert.equal(byName.ReviewedDate_Custom.type, 'Edm.Date');
  // A checkbox custom field is a NoYes enum, so the type is a namespaced enum
  // reference, not an Edm.* primitive. Carried through verbatim.
  assert.equal(byName.IsFlagged_Custom.type, 'Fixture.DataEntities.NoYes');

  // The regression this test was written for: MaxLength is absent on every
  // non-string type, and Number(null) is 0 — which reported `max_length: 0`
  // for an Edm.Int32, a plausible-looking wrong answer.
  for (const n of ['OrderCount_Custom', 'Weighting_Custom', 'ReviewedOn_Custom',
                   'ReviewedDate_Custom', 'IsFlagged_Custom']) {
    assert.equal(byName[n].max_length, null, `${n} must report max_length null, not 0`);
  }
  assert.equal(byName.HandlingCode_Custom.max_length, 10);

  // Nullable="false" survives as false on a non-string type too.
  assert.equal(byName.OrderCount_Custom.nullable, false);
  assert.equal(byName.IsFlagged_Custom.nullable, false);
});

test('given properties outside any type, when scanned, then they are ignored rather than mis-attributed', () => {
  const r = scanMetadata(FIXTURE);
  // OrphanBefore_Custom and OrphanBetween_Custom sit outside every type. The
  // second one is the dangerous case: it follows a self-closing EntityType, so
  // a scanner that leaves the previous type "current" would attach it to
  // SelfClosingThing (or worse, to WidgetOrderHeaderStaging).
  assert.equal(r.fields.some(f => f.property_name.startsWith('Orphan')), false);
  assert.equal(r.fields.some(f => f.entity_name === 'SelfClosingThing'), false);
});

test('given the fixture split at every offset, when streamed chunk by chunk, then the result never changes', () => {
  const expected = scanMetadata(FIXTURE);

  // Every split point inside the document — not just inside one tag. This is
  // ~4 k scans of a small fixture; it runs in well under a second and covers
  // splits mid-tag, mid-attribute, mid-name and between tags.
  for (let i = 0; i <= FIXTURE.length; i++) {
    const scanner = createMetadataScanner();
    scanner.push(FIXTURE.slice(0, i));
    scanner.push(FIXTURE.slice(i));
    const got = scanner.finish();
    assert.deepEqual(
      got.fields, expected.fields,
      `split at offset ${i} changed the result\n` +
      `  around: ${JSON.stringify(FIXTURE.slice(Math.max(0, i - 30), i + 30))}`,
    );
  }
});

test('given a three-way split inside a Property tag, when streamed, then the tag is still recovered', () => {
  const target = '<Property Name="SecondaryContact_Custom" Type="Edm.String" Nullable="true" MaxLength="100" />';
  const at = FIXTURE.indexOf(target);
  assert.ok(at > 0, 'fixture must contain the target tag');

  // Split so that one chunk boundary falls inside the attribute name and
  // another inside the value — a single-character-at-a-time feed is the
  // harshest version of the same thing.
  const scanner = createMetadataScanner();
  for (const ch of FIXTURE) scanner.push(ch);
  const got = scanner.finish();
  assert.deepEqual(got.fields, scanMetadata(FIXTURE).fields);
});

test('given an unterminated tag beyond the tail budget, when scanned, then truncated_tail is reported', () => {
  // 64 KB tail budget: a `<` followed by more than that without a `>` must not
  // grow the buffer forever. The scanner drops it and says so, and
  // fetchCustomFields turns that into a parse-error rather than reporting a
  // partial inventory as complete.
  const scanner = createMetadataScanner();
  scanner.push('<EntityType Name="Foo"><Property Name="A_Custom" Type="Edm.String" />');
  scanner.push('<' + 'x'.repeat(70_000));
  const got = scanner.finish();
  assert.equal(got.truncated_tail, true);
  // What was already parsed is still there — the drop is of unparseable tail.
  assert.equal(got.property_count, 1);
});

test('given truncated but well-formed-so-far EDMX, when scanned, then what was seen is returned', () => {
  // A stream cut short mid-document is not a parse error at the scanner level:
  // the scanner reports what it saw. fetchCustomFields is what decides whether
  // a short read is acceptable (it is not — the HTTP layer surfaces it).
  const half = FIXTURE.slice(0, FIXTURE.indexOf('WidgetOrderHeaderStaging'));
  const r = scanMetadata(half);
  assert.equal(r.truncated_tail, false);
  assert.ok(r.property_count >= 2);
  assert.equal(r.fields.some(f => f.entity_name === 'WidgetOrderHeaderStaging'), false);
});

test('given EDMX with no custom properties, when scanned, then the result is empty rather than an error', () => {
  const r = scanMetadata(`
    <Schema>
      <EntityType Name="Plain">
        <Property Name="Id" Type="Edm.String" />
      </EntityType>
    </Schema>`);
  assert.deepEqual(r.fields, []);
  assert.equal(r.property_count, 0);
  assert.equal(r.entity_count, 0);
});

/* ── source registry ────────────────────────────────────────────────────── */

test('given CUSTOM_FIELDS_SOURCES, when resolved, then it wins over the config file', () => {
  withEnv({
    CUSTOM_FIELDS_SOURCES: JSON.stringify([
      { key: 'uat', title: 'UAT', url: 'https://uat.example.dynamics.com/', tenantId: GUID_A, clientId: GUID_B },
    ]),
  }, () => {
    const sources = resolveSources();
    assert.equal(sources.length, 1);
    assert.equal(sources[0].key, 'uat');
    // Trailing slash stripped so `${url}/data/$metadata` cannot double up.
    assert.equal(sources[0].url, 'https://uat.example.dynamics.com');
    // Secret name defaulted from the key, and it is a NAME, not a value.
    assert.equal(sources[0].secretName, 'd365-cf-uat-client-secret');
    // A single source is the default even without the flag.
    assert.equal(sources[0].is_default, true);
  });
});

test('given several sources, when one is flagged default, then exactly one default survives', () => {
  withEnv({
    CUSTOM_FIELDS_SOURCES: JSON.stringify([
      { key: 'a', url: 'https://a.example.com', tenantId: GUID_A, clientId: GUID_B },
      { key: 'b', url: 'https://b.example.com', tenantId: GUID_A, clientId: GUID_B, default: true },
      { key: 'c', url: 'https://c.example.com', tenantId: GUID_A, clientId: GUID_B, default: true },
    ]),
  }, () => {
    const sources = resolveSources();
    assert.equal(sources.filter(s => s.is_default).length, 1);
    assert.equal(sources.find(s => s.is_default).key, 'b');
    assert.equal(selectSource().key, 'b');
    assert.equal(selectSource('c').key, 'c');
  });
});

test('given a non-https or incomplete source, when resolved, then it is dropped', () => {
  withEnv({
    CUSTOM_FIELDS_SOURCES: JSON.stringify([
      { key: 'insecure', url: 'http://plain.example.com', tenantId: GUID_A, clientId: GUID_B },
      { key: 'nourl', tenantId: GUID_A, clientId: GUID_B },
      { key: 'notenant', url: 'https://x.example.com', clientId: GUID_B },
      { key: 'good', url: 'https://good.example.com', tenantId: GUID_A, clientId: GUID_B },
    ]),
  }, () => {
    const sources = resolveSources();
    assert.deepEqual(sources.map(s => s.key), ['good']);
  });
});

test('given malformed registry JSON, when resolved, then it degrades to no sources rather than throwing', () => {
  withEnv({ CUSTOM_FIELDS_SOURCES: '{not json' }, () => {
    // Falls through to the config file, which ships as `[]`, then to the
    // single-env shape, which is unset here.
    assert.deepEqual(resolveSources(), []);
  });
});

test('given single-environment env vars, when resolved, then the local-dev shape works', () => {
  withEnv({
    D365_ENV_URL: 'https://dev.example.dynamics.com',
    D365_TENANT_ID: GUID_A,
    D365_CLIENT_ID: GUID_B,
    D365_ENV_KEY: 'dev',
  }, () => {
    const sources = resolveSources();
    assert.equal(sources.length, 1);
    assert.equal(sources[0].key, 'dev');
    assert.equal(sources[0].origin, 'env');
  });
});

test('given no configured source, when selected, then an invalid-input error explains how to configure one', () => {
  withEnv({}, () => {
    assert.throws(() => selectSource(), (err) => {
      assert.ok(err instanceof CustomFieldsError);
      assert.equal(err.category, 'invalid-input');
      assert.equal(err.stage, 'config');
      assert.match(err.message, /Set-D365CustomFieldsSource/);
      return true;
    });
  });
});

test('given an unknown environment key, when selected, then the error lists the configured keys', () => {
  withEnv({
    CUSTOM_FIELDS_SOURCES: JSON.stringify([
      { key: 'uat', url: 'https://uat.example.com', tenantId: GUID_A, clientId: GUID_B },
    ]),
  }, () => {
    assert.throws(() => selectSource('prod'), (err) => {
      assert.equal(err.category, 'invalid-input');
      assert.match(err.message, /Configured: uat/);
      return true;
    });
  });
});

/* ── diagnostics must not leak ───────────────────────────────────────────── */

test('given cache state, when reported, then it names environments but carries no secret material', () => {
  withEnv({
    CUSTOM_FIELDS_SOURCES: JSON.stringify([
      { key: 'uat', title: 'UAT', url: 'https://uat.example.com', tenantId: GUID_A, clientId: GUID_B,
        secretName: 'd365-cf-uat-client-secret' },
    ]),
  }, () => {
    const state = getCacheState();
    assert.equal(state.length, 1);
    assert.equal(state[0].environment, 'uat');
    assert.equal(state[0].cached, false);

    const serialised = JSON.stringify(state);
    // The secret NAME is fine to expose; a client secret, a token or the
    // tenant/client id must not appear in a diagnostics payload.
    assert.doesNotMatch(serialised, /client_secret|access_token|Bearer/i);
    assert.equal(serialised.includes(GUID_A), false, 'tenantId must not be exposed');
    assert.equal(serialised.includes(GUID_B), false, 'clientId must not be exposed');
  });
});

test('given no vault and no fallback, when a secret is requested, then a typed not-configured error is raised', async () => {
  const savedVault = process.env.KEY_VAULT_NAME;
  const savedFallback = process.env.CUSTOM_FIELDS_CLIENT_SECRET_D365_CF_UAT_CLIENT_SECRET;
  delete process.env.KEY_VAULT_NAME;
  delete process.env.CUSTOM_FIELDS_CLIENT_SECRET_D365_CF_UAT_CLIENT_SECRET;
  clearSecretCache();
  try {
    await assert.rejects(() => getSecret('d365-cf-uat-client-secret'), (err) => {
      assert.ok(err instanceof KeyVaultError);
      assert.equal(err.stage, 'not-configured');
      // The hint must name the fallback variable so local dev is diagnosable.
      assert.match(err.message, /CUSTOM_FIELDS_CLIENT_SECRET_D365_CF_UAT_CLIENT_SECRET/);
      return true;
    });
    const state = getSecretCacheState();
    assert.equal(state.vault_configured, false);
    assert.equal(state.cached_secret_count, 0);
  } finally {
    if (savedVault === undefined) delete process.env.KEY_VAULT_NAME;
    else process.env.KEY_VAULT_NAME = savedVault;
    if (savedFallback === undefined) delete process.env.CUSTOM_FIELDS_CLIENT_SECRET_D365_CF_UAT_CLIENT_SECRET;
    else process.env.CUSTOM_FIELDS_CLIENT_SECRET_D365_CF_UAT_CLIENT_SECRET = savedFallback;
    clearSecretCache();
  }
});

test('given the dev-only env fallback, when no vault is configured, then it is used and reported as such', async () => {
  const savedVault = process.env.KEY_VAULT_NAME;
  delete process.env.KEY_VAULT_NAME;
  process.env.CUSTOM_FIELDS_CLIENT_SECRET_LOCAL_TEST = 'not-a-real-secret';
  clearSecretCache();
  try {
    const value = await getSecret('local-test');
    assert.equal(value, 'not-a-real-secret');
    assert.match(getSecretCacheState().last_source, /^env:CUSTOM_FIELDS_CLIENT_SECRET_LOCAL_TEST$/);
    assert.equal(getSecretCacheState().cached_secret_count, 1);
  } finally {
    delete process.env.CUSTOM_FIELDS_CLIENT_SECRET_LOCAL_TEST;
    if (savedVault !== undefined) process.env.KEY_VAULT_NAME = savedVault;
    clearSecretCache();
  }
});
