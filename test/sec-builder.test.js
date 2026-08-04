/**
 * Tests for the security database builder (sec-builder.js)
 *
 * Focuses on: streaming XML parser, duty-privilege DMF integration.
 *
 * Run: node --test test/sec-builder.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { createRequire } from 'module';
import {
  buildSecurityDatabase,
  extractField,
  _streamParseLargeDmfXmlSync as streamParseLargeDmfXmlSync,
  getEffectivePermissionType,
  _loadLabels as loadLabels,
  _resolveLabel as resolveLabel,
} from '../src/azure/sec-builder.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

// ── extractField ─────────────────────────────────────────────────────────────

describe('extractField', () => {
  it('extracts a simple field value', () => {
    const xml = '<SECURITYDUTYIDENTIFIER>ABC-123</SECURITYDUTYIDENTIFIER><SECURITYDUTYNAME>My Duty</SECURITYDUTYNAME>';
    assert.equal(extractField(xml, 'SECURITYDUTYIDENTIFIER'), 'ABC-123');
    assert.equal(extractField(xml, 'SECURITYDUTYNAME'), 'My Duty');
  });

  it('returns null for missing field', () => {
    assert.equal(extractField('<A>1</A>', 'B'), null);
  });

  it('returns null for empty field', () => {
    assert.equal(extractField('<A></A>', 'A'), null);
  });
});

// ── loadLabels (gap #4: nested LabelResources + locale casing) ───────────────

describe('loadLabels', () => {
  let tmpDir;

  before(() => {
    tmpDir = join(tmpdir(), `sec-labels-test-${randomUUID().slice(0, 8)}`);
    // Files are nested at AxLabelFile/LabelResources/<locale>/<name>.<locale>.label.txt
    // — exactly the layout the old flat readdir missed. Cover both en-US and
    // lowercase en-us dir/file casing, and a non-en file that must be ignored.
    const usDir = join(tmpDir, 'PkgA', 'ModelA', 'AxLabelFile', 'LabelResources', 'en-US');
    const lcDir = join(tmpDir, 'PkgB', 'ModelB', 'axlabelfile', 'LabelResources', 'en-us');
    const frDir = join(tmpDir, 'PkgC', 'ModelC', 'AxLabelFile', 'LabelResources', 'fr');
    mkdirSync(usDir, { recursive: true });
    mkdirSync(lcDir, { recursive: true });
    mkdirSync(frDir, { recursive: true });
    writeFileSync(join(usDir, 'Foo.en-US.label.txt'), 'MyRole=My Role Text\nMyDuty=My Duty Text\n', 'utf-8');
    writeFileSync(join(lcDir, 'Bar.en-us.label.txt'), 'LowerId=Lowercase Locale\n', 'utf-8');
    writeFileSync(join(frDir, 'Baz.fr.label.txt'), 'FrId=Texte Francais\n', 'utf-8');
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads labels nested under LabelResources/<locale> (the gap #4 fix)', () => {
    const labels = loadLabels(tmpDir);
    assert.equal(labels.get('MyRole'), 'My Role Text');
    assert.equal(labels.get('MyDuty'), 'My Duty Text');
    assert.ok(labels.size >= 2);
  });

  it('matches the locale case-insensitively (en-us as well as en-US)', () => {
    const labels = loadLabels(tmpDir);
    assert.equal(labels.get('LowerId'), 'Lowercase Locale');
  });

  it('ignores non-en-US locales', () => {
    const labels = loadLabels(tmpDir);
    assert.equal(labels.get('FrId'), undefined);
  });

  it('namespaces keys by label-file prefix to avoid cross-module id collisions', () => {
    const labels = loadLabels(tmpDir);
    // "Foo.en-US.label.txt" -> fileModule "Foo"
    assert.equal(labels.get('Foo:MyRole'), 'My Role Text');
  });
});

// ── resolveLabel (gap #4 regression: colon form only, concatenated form and
// standard `@SYS…` ids always fell through unresolved regardless of whether
// the label text was loaded — confirmed live against the prod sec DB
// 2026-07-08: 115/385 role labels, 1002/2855 duty names, 5077/23616
// privilege labels were raw `@…` references) ────────────────────────────────

describe('resolveLabel', () => {
  it('resolves the concatenated form (@ModuleId, e.g. @SYS154926)', () => {
    const labelMap = new Map([['154926', 'Some resolved text']]);
    assert.equal(resolveLabel(labelMap, '@SYS154926'), 'Some resolved text');
  });

  it('resolves the colon-delimited form (@Module:LabelId)', () => {
    const labelMap = new Map([['CAPAViewer', 'CAPA viewer']]);
    assert.equal(resolveLabel(labelMap, '@QMS:CAPAViewer'), 'CAPA viewer');
  });

  it('prefers the module-namespaced key over a bare id to avoid collisions', () => {
    const labelMap = new Map([
      ['77', 'Wrong module text'],
      ['QMS:77', 'Correct QMS text'],
    ]);
    assert.equal(resolveLabel(labelMap, '@QMS77'), 'Correct QMS text');
    assert.equal(resolveLabel(labelMap, '@QMS:77'), 'Correct QMS text');
  });

  it('falls back to the raw reference when the id is not in the loaded map', () => {
    assert.equal(resolveLabel(new Map(), '@QMS999999'), '@QMS999999');
    assert.equal(resolveLabel(new Map(), '@QMS:Missing'), '@QMS:Missing');
  });

  it('passes plain text through unchanged', () => {
    assert.equal(resolveLabel(new Map(), 'Already resolved text'), 'Already resolved text');
  });

  it('returns null for a null/empty raw value', () => {
    assert.equal(resolveLabel(new Map(), null), null);
    assert.equal(resolveLabel(new Map(), ''), null);
  });
});

// ── streamParseLargeDmfXmlSync ───────────────────────────────────────────────

describe('streamParseLargeDmfXmlSync', () => {
  let tmpDir;

  before(() => {
    tmpDir = join(tmpdir(), `sec-builder-test-${randomUUID().slice(0, 8)}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('parses entities from a small XML file', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?><Document>` +
      `<ENTITY><ID>A</ID><NAME>Alpha</NAME></ENTITY>` +
      `<ENTITY><ID>B</ID><NAME>Beta</NAME></ENTITY>` +
      `<ENTITY><ID>C</ID><NAME>Gamma</NAME></ENTITY>` +
      `</Document>`;
    const filePath = join(tmpDir, 'small.xml');
    writeFileSync(filePath, xml, 'utf-8');

    const results = [];
    const count = streamParseLargeDmfXmlSync(filePath, 'ENTITY', (inner) => {
      results.push({ id: extractField(inner, 'ID'), name: extractField(inner, 'NAME') });
    });

    assert.equal(count, 3);
    assert.deepEqual(results, [
      { id: 'A', name: 'Alpha' },
      { id: 'B', name: 'Beta' },
      { id: 'C', name: 'Gamma' },
    ]);
  });

  it('handles entity spanning chunk boundary', () => {
    // Create XML with entities padded to ensure one spans a chunk boundary
    // Use a small enough file but verify the logic works with multi-entity content
    const entities = [];
    for (let i = 0; i < 100; i++) {
      const padding = 'X'.repeat(200); // pad to create realistic entity sizes
      entities.push(`<E><ID>${i}</ID><PAD>${padding}</PAD></E>`);
    }
    const xml = `<Document>${entities.join('')}</Document>`;
    const filePath = join(tmpDir, 'chunked.xml');
    writeFileSync(filePath, xml, 'utf-8');

    const ids = [];
    const count = streamParseLargeDmfXmlSync(filePath, 'E', (inner) => {
      ids.push(extractField(inner, 'ID'));
    });

    assert.equal(count, 100);
    assert.equal(ids[0], '0');
    assert.equal(ids[99], '99');
  });

  it('handles BOM prefix', () => {
    const xml = '\ufeff<?xml version="1.0" encoding="utf-8"?><Document>' +
      '<E><V>test</V></E></Document>';
    const filePath = join(tmpDir, 'bom.xml');
    writeFileSync(filePath, xml, 'utf-8');

    const values = [];
    const count = streamParseLargeDmfXmlSync(filePath, 'E', (inner) => {
      values.push(extractField(inner, 'V'));
    });

    assert.equal(count, 1);
    assert.equal(values[0], 'test');
  });
});

// ── buildSecurityDatabase with DMF Duty-Privilege ────────────────────────────

describe('buildSecurityDatabase — duty-privilege DMF integration', () => {
  let tmpDir;
  let dbPath;

  before(() => {
    tmpDir = join(tmpdir(), `sec-build-test-${randomUUID().slice(0, 8)}`);
    mkdirSync(tmpDir, { recursive: true });

    const dmfDir = join(tmpDir, 'dmf');
    mkdirSync(dmfDir, { recursive: true });

    // Create minimal DMF files for a working build
    // Roles
    writeFileSync(join(dmfDir, 'System Security Role.xml'),
      `<?xml version="1.0" encoding="utf-8"?><Document>` +
      `<SYSTEMSECURITYROLEENTITY>` +
        `<SECURITYROLEIDENTIFIER>ROLE-GUID-1</SECURITYROLEIDENTIFIER>` +
        `<SECURITYROLENAME>TestRole</SECURITYROLENAME>` +
        `<USERLICENSETYPE>Enterprise</USERLICENSETYPE>` +
      `</SYSTEMSECURITYROLEENTITY>` +
      `</Document>`, 'utf-8');

    // Role-Duty
    writeFileSync(join(dmfDir, 'System Security Role Duty.xml'),
      `<?xml version="1.0" encoding="utf-8"?><Document>` +
      `<SYSTEMSECURITYROLEDUTYENTITY>` +
        `<SECURITYROLEIDENTIFIER>ROLE-GUID-1</SECURITYROLEIDENTIFIER>` +
        `<SECURITYROLENAME>TestRole</SECURITYROLENAME>` +
        `<SECURITYDUTYIDENTIFIER>TESTDUTY1</SECURITYDUTYIDENTIFIER>` +
        `<SECURITYDUTYNAME>Test Duty One</SECURITYDUTYNAME>` +
      `</SYSTEMSECURITYROLEDUTYENTITY>` +
      `<SYSTEMSECURITYROLEDUTYENTITY>` +
        `<SECURITYROLEIDENTIFIER>ROLE-GUID-1</SECURITYROLEIDENTIFIER>` +
        `<SECURITYROLENAME>TestRole</SECURITYROLENAME>` +
        `<SECURITYDUTYIDENTIFIER>CUSTOM-GUID-DUTY</SECURITYDUTYIDENTIFIER>` +
        `<SECURITYDUTYNAME>Custom DMF Duty</SECURITYDUTYNAME>` +
      `</SYSTEMSECURITYROLEDUTYENTITY>` +
      `</Document>`, 'utf-8');

    // System Security Duty (duty → privilege mapping, small file for DOM parser path)
    writeFileSync(join(dmfDir, 'System Security Duty.xml'),
      `<?xml version="1.0" encoding="utf-8"?><Document>` +
      // Duty TESTDUTY1 → 2 privileges
      `<SYSTEMSECURITYDUTYENTITY>` +
        `<SECURITYDUTYIDENTIFIER>TESTDUTY1</SECURITYDUTYIDENTIFIER>` +
        `<SECURITYDUTYNAME>Test Duty One</SECURITYDUTYNAME>` +
        `<SECURITYPRIVILEGE>100</SECURITYPRIVILEGE>` +
        `<SECURITYPRIVILEGEIDENTIFIER>PRIV_A</SECURITYPRIVILEGEIDENTIFIER>` +
        `<SECURITYPRIVILEGENAME>Privilege Alpha</SECURITYPRIVILEGENAME>` +
        `<SECURITYROLEIDENTIFIER>ROLE-GUID-1</SECURITYROLEIDENTIFIER>` +
        `<SECURITYROLENAME>TestRole</SECURITYROLENAME>` +
      `</SYSTEMSECURITYDUTYENTITY>` +
      `<SYSTEMSECURITYDUTYENTITY>` +
        `<SECURITYDUTYIDENTIFIER>TESTDUTY1</SECURITYDUTYIDENTIFIER>` +
        `<SECURITYDUTYNAME>Test Duty One</SECURITYDUTYNAME>` +
        `<SECURITYPRIVILEGE>200</SECURITYPRIVILEGE>` +
        `<SECURITYPRIVILEGEIDENTIFIER>PRIV_B</SECURITYPRIVILEGEIDENTIFIER>` +
        `<SECURITYPRIVILEGENAME>Privilege Beta</SECURITYPRIVILEGENAME>` +
        `<SECURITYROLEIDENTIFIER>ROLE-GUID-1</SECURITYROLEIDENTIFIER>` +
        `<SECURITYROLENAME>TestRole</SECURITYROLENAME>` +
      `</SYSTEMSECURITYDUTYENTITY>` +
      // Custom GUID-based duty → 1 privilege
      `<SYSTEMSECURITYDUTYENTITY>` +
        `<SECURITYDUTYIDENTIFIER>CUSTOM-GUID-DUTY</SECURITYDUTYIDENTIFIER>` +
        `<SECURITYDUTYNAME>Custom DMF Duty</SECURITYDUTYNAME>` +
        `<SECURITYPRIVILEGE>300</SECURITYPRIVILEGE>` +
        `<SECURITYPRIVILEGEIDENTIFIER>PRIV_C</SECURITYPRIVILEGEIDENTIFIER>` +
        `<SECURITYPRIVILEGENAME>Privilege Custom</SECURITYPRIVILEGENAME>` +
        `<SECURITYROLEIDENTIFIER>ROLE-GUID-1</SECURITYROLEIDENTIFIER>` +
        `<SECURITYROLENAME>TestRole</SECURITYROLENAME>` +
      `</SYSTEMSECURITYDUTYENTITY>` +
      // Duplicate of first pair (should be deduplicated)
      `<SYSTEMSECURITYDUTYENTITY>` +
        `<SECURITYDUTYIDENTIFIER>TESTDUTY1</SECURITYDUTYIDENTIFIER>` +
        `<SECURITYDUTYNAME>Test Duty One</SECURITYDUTYNAME>` +
        `<SECURITYPRIVILEGE>100</SECURITYPRIVILEGE>` +
        `<SECURITYPRIVILEGEIDENTIFIER>PRIV_A</SECURITYPRIVILEGEIDENTIFIER>` +
        `<SECURITYPRIVILEGENAME>Privilege Alpha</SECURITYPRIVILEGENAME>` +
        `<SECURITYROLEIDENTIFIER>ROLE-GUID-1</SECURITYROLEIDENTIFIER>` +
        `<SECURITYROLENAME>TestRole</SECURITYROLENAME>` +
      `</SYSTEMSECURITYDUTYENTITY>` +
      `</Document>`, 'utf-8');

    // User info (minimal)
    writeFileSync(join(dmfDir, 'User information.xml'),
      `<?xml version="1.0" encoding="utf-8"?><Document>` +
      `<SYSTEMUSERENTITY><USERID>testuser</USERID><ENABLE>Yes</ENABLE>` +
      `<PERSONNAME>Test User</PERSONNAME></SYSTEMUSERENTITY></Document>`, 'utf-8');

    // User-role (minimal)
    writeFileSync(join(dmfDir, 'SystemSecurityUserRoleEntity.xml'),
      `<?xml version="1.0" encoding="utf-8"?><Document>` +
      `<SYSTEMSECURITYUSERROLEENTITY><USERID>testuser</USERID>` +
      `<SECURITYROLEIDENTIFIER>ROLE-GUID-1</SECURITYROLEIDENTIFIER>` +
      `<ASSIGNMENTSTATUS>Enabled</ASSIGNMENTSTATUS>` +
      `</SYSTEMSECURITYUSERROLEENTITY></Document>`, 'utf-8');

    dbPath = join(tmpDir, 'test-sec.sqlite');
    buildSecurityDatabase({
      packagesPathArg: 'skip',
      dmfInputDir: dmfDir,
      outputPath: dbPath,
      log: () => {}, // silent
    });
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates the database file', () => {
    assert.ok(statSync(dbPath).size > 0);
  });

  it('populates duty_privileges from DMF', () => {
    const db = new Database(dbPath, { readonly: true });

    const rows = db.prepare('SELECT duty_id, privilege_name FROM duty_privileges ORDER BY duty_id, privilege_name').all();
    db.close();

    // 4 entities in XML, but 1 duplicate → 3 unique pairs
    assert.equal(rows.length, 3);

    // TESTDUTY1 → PRIV_A, PRIV_B
    assert.deepEqual(rows.filter(r => r.duty_id === 'TESTDUTY1').map(r => r.privilege_name),
      ['PRIV_A', 'PRIV_B']);

    // Custom GUID duty → PRIV_C
    assert.deepEqual(rows.filter(r => r.duty_id === 'CUSTOM-GUID-DUTY').map(r => r.privilege_name),
      ['PRIV_C']);
  });

  it('creates privilege entries from DMF duty data', () => {
    const db = new Database(dbPath, { readonly: true });

    const privA = db.prepare("SELECT label FROM privileges WHERE privilege_name = 'PRIV_A'").get();
    const privC = db.prepare("SELECT label FROM privileges WHERE privilege_name = 'PRIV_C'").get();
    db.close();

    assert.equal(privA.label, 'Privilege Alpha');
    assert.equal(privC.label, 'Privilege Custom');
  });

  it('tracks duty-privilege count in metadata', () => {
    const db = new Database(dbPath, { readonly: true });

    const count = db.prepare("SELECT value FROM sec_metadata WHERE key = 'dutyPrivileges'").get();
    db.close();

    assert.equal(count.value, '3');
  });
});

// ── P4-01 — System Security Duty V2 ingestion ───────────────────────────────

describe('buildSecurityDatabase — System Security Duty V2 (CR-SEC-006)', () => {
  let tmpDir;
  let dbPath;
  let dmfDir;

  before(() => {
    tmpDir = join(tmpdir(), `sec-build-v2-test-${randomUUID().slice(0, 8)}`);
    mkdirSync(tmpDir, { recursive: true });
    dmfDir = join(tmpDir, 'dmf');
    mkdirSync(dmfDir, { recursive: true });

    // Minimal role + role-duty so the build pipeline runs cleanly.
    writeFileSync(join(dmfDir, 'System Security Role.xml'),
      `<?xml version="1.0" encoding="utf-8"?><Document>` +
      `<SYSTEMSECURITYROLEENTITY>` +
        `<SECURITYROLEIDENTIFIER>R1</SECURITYROLEIDENTIFIER>` +
        `<SECURITYROLENAME>RoleOne</SECURITYROLENAME>` +
        `<USERLICENSETYPE>Enterprise</USERLICENSETYPE>` +
      `</SYSTEMSECURITYROLEENTITY>` +
      `</Document>`, 'utf-8');
    writeFileSync(join(dmfDir, 'System Security Role Duty.xml'),
      `<?xml version="1.0" encoding="utf-8"?><Document>` +
      `<SYSTEMSECURITYROLEDUTYENTITY>` +
        `<SECURITYROLEIDENTIFIER>R1</SECURITYROLEIDENTIFIER>` +
        `<SECURITYROLENAME>RoleOne</SECURITYROLENAME>` +
        `<SECURITYDUTYIDENTIFIER>COLLECTIONLETTERSDUTY</SECURITYDUTYIDENTIFIER>` +
        `<SECURITYDUTYNAME>Collection letters duty</SECURITYDUTYNAME>` +
      `</SYSTEMSECURITYROLEDUTYENTITY>` +
      `</Document>`, 'utf-8');

    // System Security Duty V2 — duty→privilege pairs that V1 does NOT cover.
    // Duplicate entries to verify dedupe.
    writeFileSync(join(dmfDir, 'System Security Duty V2.xml'),
      `<?xml version="1.0" encoding="utf-8"?><Document>` +
      `<SYSTEMSECURITYDUTYV2ENTITY>` +
        `<SECURITYDUTYIDENTIFIER>COLLECTIONLETTERSDUTY</SECURITYDUTYIDENTIFIER>` +
        `<SECURITYDUTYNAME>Collection letters duty</SECURITYDUTYNAME>` +
        `<SECURITYPRIVILEGEIDENTIFIER>CustCollectionLettersView</SECURITYPRIVILEGEIDENTIFIER>` +
        `<SECURITYPRIVILEGENAME>View collection letters</SECURITYPRIVILEGENAME>` +
      `</SYSTEMSECURITYDUTYV2ENTITY>` +
      `<SYSTEMSECURITYDUTYV2ENTITY>` +
        `<SECURITYDUTYIDENTIFIER>COLLECTIONLETTERSDUTY</SECURITYDUTYIDENTIFIER>` +
        `<SECURITYDUTYNAME>Collection letters duty</SECURITYDUTYNAME>` +
        `<SECURITYPRIVILEGEIDENTIFIER>CustCollectionLettersMaintain</SECURITYPRIVILEGEIDENTIFIER>` +
        `<SECURITYPRIVILEGENAME>Maintain collection letters</SECURITYPRIVILEGENAME>` +
      `</SYSTEMSECURITYDUTYV2ENTITY>` +
      `<SYSTEMSECURITYDUTYV2ENTITY>` +
        // duplicate of the first row — must be deduplicated
        `<SECURITYDUTYIDENTIFIER>COLLECTIONLETTERSDUTY</SECURITYDUTYIDENTIFIER>` +
        `<SECURITYDUTYNAME>Collection letters duty</SECURITYDUTYNAME>` +
        `<SECURITYPRIVILEGEIDENTIFIER>CustCollectionLettersView</SECURITYPRIVILEGEIDENTIFIER>` +
        `<SECURITYPRIVILEGENAME>View collection letters</SECURITYPRIVILEGENAME>` +
      `</SYSTEMSECURITYDUTYV2ENTITY>` +
      `<SYSTEMSECURITYDUTYV2ENTITY>` +
        // missing privilege id — must be skipped
        `<SECURITYDUTYIDENTIFIER>COLLECTIONLETTERSDUTY</SECURITYDUTYIDENTIFIER>` +
        `<SECURITYDUTYNAME>Collection letters duty</SECURITYDUTYNAME>` +
      `</SYSTEMSECURITYDUTYV2ENTITY>` +
      `</Document>`, 'utf-8');

    dbPath = join(tmpDir, 'v2-sec.sqlite');
    buildSecurityDatabase({
      packagesPathArg: 'skip',
      dmfInputDir: dmfDir,
      outputPath: dbPath,
      log: () => {},
    });
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('given a Duty V2 DMF file, when building, then duty_privileges is populated', () => {
    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare(
      `SELECT privilege_name FROM duty_privileges WHERE duty_id = 'COLLECTIONLETTERSDUTY' COLLATE NOCASE ORDER BY privilege_name`
    ).all();
    db.close();
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map(r => r.privilege_name).sort(),
      ['CustCollectionLettersMaintain', 'CustCollectionLettersView']);
  });

  it('given duplicate duty-privilege entries, then only one row is inserted', () => {
    const db = new Database(dbPath, { readonly: true });
    const cnt = db.prepare(
      `SELECT COUNT(*) c FROM duty_privileges
       WHERE duty_id = 'COLLECTIONLETTERSDUTY' COLLATE NOCASE
         AND privilege_name = 'CustCollectionLettersView' COLLATE NOCASE`
    ).get();
    db.close();
    assert.equal(cnt.c, 1);
  });

  it('given a V2 entity missing a privilege id, when ingested, then it is skipped without crashing', () => {
    // The "skipped" row in the fixture had no SECURITYPRIVILEGEIDENTIFIER.
    // It should be excluded; the build must not throw and the COLLECTIONLETTERSDUTY
    // total stays at 2 grants (verified by the test above).
    const db = new Database(dbPath, { readonly: true });
    const cnt = db.prepare(
      `SELECT COUNT(*) c FROM duty_privileges WHERE duty_id = 'COLLECTIONLETTERSDUTY' COLLATE NOCASE`
    ).get();
    db.close();
    assert.equal(cnt.c, 2);
  });

  it('given V2 ingestion, then privileges table carries the V2 labels', () => {
    const db = new Database(dbPath, { readonly: true });
    const view = db.prepare("SELECT label FROM privileges WHERE privilege_name = 'CustCollectionLettersView'").get();
    const maintain = db.prepare("SELECT label FROM privileges WHERE privilege_name = 'CustCollectionLettersMaintain'").get();
    db.close();
    assert.equal(view?.label, 'View collection letters');
    assert.equal(maintain?.label, 'Maintain collection letters');
  });
});

// ── P4-05 — getEffectivePermissionType (CR-SEC-005) ─────────────────────────

describe('getEffectivePermissionType (P4-05)', () => {
  it('given a DMF "Grant" value, when called, then returns Grant regardless of name', () => {
    assert.equal(getEffectivePermissionType('Grant', 'Deny_Buyer'), 'Grant');
  });

  it('given a DMF "Deny" value, when called, then returns Deny regardless of name', () => {
    assert.equal(getEffectivePermissionType('Deny', 'NormalRoleName'), 'Deny');
  });

  it('given a DMF "Allow" value (alternative casing), when called, then returns Grant', () => {
    assert.equal(getEffectivePermissionType('allow', 'Anything'), 'Grant');
  });

  it('given a NULL DMF value and a name matching the Deny regex, when called, then returns Deny via fallback', () => {
    assert.equal(getEffectivePermissionType(null, 'Deny_Buyer'), 'Deny');
    assert.equal(getEffectivePermissionType(null, 'TBG_Deny_Posting'), 'Deny');
  });

  it('given a NULL DMF value and a normal name, when called, then returns Grant (default)', () => {
    assert.equal(getEffectivePermissionType(null, 'AccountsPayableClerk'), 'Grant');
  });

  it('given an empty-string DMF value, when called, then falls through to the regex', () => {
    assert.equal(getEffectivePermissionType('', 'Deny_Buyer'), 'Deny');
  });

  it('given an unknown DMF value, when called, then falls back to the regex without throwing', () => {
    // Non-English / typo / new enum value — fallback is the safety net.
    assert.equal(getEffectivePermissionType('Verboten', 'Deny_Buyer'), 'Deny');
    assert.equal(getEffectivePermissionType('Verboten', 'NormalRole'), 'Grant');
  });
});

// ── P4-04 — Role import diagnostics (CR-SEC-003) ────────────────────────────

describe('buildSecurityDatabase — role import diagnostics (P4-04)', () => {
  let tmpDir;

  before(() => {
    tmpDir = join(tmpdir(), `sec-build-diag-test-${randomUUID().slice(0, 8)}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function buildWithDmfRoles(label, rolesXmlBody) {
    const dmfDir = join(tmpDir, label);
    mkdirSync(dmfDir, { recursive: true });
    writeFileSync(join(dmfDir, 'System Security Role.xml'),
      `<?xml version="1.0" encoding="utf-8"?><Document>${rolesXmlBody}</Document>`, 'utf-8');
    writeFileSync(join(dmfDir, 'System Security Role Duty.xml'),
      `<?xml version="1.0" encoding="utf-8"?><Document></Document>`, 'utf-8');
    const dbPath = join(dmfDir, 'out.sqlite');
    return buildSecurityDatabase({
      packagesPathArg: 'skip',
      dmfInputDir: dmfDir,
      outputPath: dbPath,
      log: () => {},
    });
  }

  function makeRole(id, name) {
    let inner = '';
    if (id !== null) inner += `<SECURITYROLEIDENTIFIER>${id}</SECURITYROLEIDENTIFIER>`;
    if (name !== null) inner += `<SECURITYROLENAME>${name}</SECURITYROLENAME>`;
    inner += '<USERLICENSETYPE>Enterprise</USERLICENSETYPE>';
    return `<SYSTEMSECURITYROLEENTITY>${inner}</SYSTEMSECURITYROLEENTITY>`;
  }

  it('given DMF with 5 valid roles, when building, then totalInDmf=5, imported=5, skipped=0', () => {
    const body = [
      makeRole('R1', 'RoleOne'),
      makeRole('R2', 'RoleTwo'),
      makeRole('R3', 'RoleThree'),
      makeRole('R4', 'RoleFour'),
      makeRole('R5', 'RoleFive'),
    ].join('');
    const result = buildWithDmfRoles('all-valid', body);
    assert.equal(result.stats.roles.totalInDmf, 5);
    assert.equal(result.stats.roles.imported, 5);
    assert.equal(result.stats.roles.skipped, 0);
    assert.equal(result.stats.skippedRoles.length, 0);
  });

  it('given DMF with malformed rows, when building, then stats.roles.skipped reports them with reasons', () => {
    const body = [
      makeRole('R1', 'GoodRole'),
      makeRole(null, 'NoIdRole'),       // missing-id
      makeRole('R3', null),              // missing-name
      makeRole('R1', 'DuplicateRole'),   // duplicate
      makeRole('R5', 'GoodRoleTwo'),
    ].join('');
    const result = buildWithDmfRoles('malformed', body);
    assert.equal(result.stats.roles.totalInDmf, 5);
    assert.equal(result.stats.roles.imported, 2);
    assert.equal(result.stats.roles.skipped, 3);
    const reasons = result.stats.skippedRoles.map(s => s.reason).sort();
    assert.deepEqual(reasons, ['duplicate', 'missing-id', 'missing-name']);
  });

  it('given the missing-id case, then stats.skippedRoles records the role name even with no id', () => {
    const body = makeRole(null, 'NoIdRole');
    const result = buildWithDmfRoles('no-id', body);
    assert.equal(result.stats.roles.skipped, 1);
    assert.equal(result.stats.skippedRoles[0].id, null);
    assert.equal(result.stats.skippedRoles[0].name, 'NoIdRole');
    assert.equal(result.stats.skippedRoles[0].reason, 'missing-id');
  });

  it('given a real-world missing-role hunt (TBG Ledger Calendar Security Role), then a duplicate id is the typical root cause', () => {
    // Simulate the production scenario: two DMF rows with the same id
    // (one well-named, one with the canonical name). The second is logged
    // as skipped — duplicate. This is what the CR-SEC-003 ticket actually
    // reports for "TBG Ledger Calendar Security Role".
    const body = [
      makeRole('TBGLEDGERCAL', 'TBG Ledger Calendar Helper'),
      makeRole('TBGLEDGERCAL', 'TBG Ledger Calendar Security Role'),
    ].join('');
    const result = buildWithDmfRoles('tbg-ledger-cal', body);
    assert.equal(result.stats.roles.imported, 1);
    assert.equal(result.stats.roles.skipped, 1);
    assert.equal(result.stats.skippedRoles[0].name, 'TBG Ledger Calendar Security Role');
    assert.equal(result.stats.skippedRoles[0].reason, 'duplicate');
  });
});

// ── P4-01 — Build completes without V2 file (missing-file path) ─────────────

describe('buildSecurityDatabase — Duty V2 missing (graceful degrade)', () => {
  let tmpDir;
  let dbPath;

  before(() => {
    tmpDir = join(tmpdir(), `sec-build-no-v2-test-${randomUUID().slice(0, 8)}`);
    mkdirSync(tmpDir, { recursive: true });
    const dmfDir = join(tmpDir, 'dmf');
    mkdirSync(dmfDir, { recursive: true });
    // Only the bare-minimum role files; no V2 file at all.
    writeFileSync(join(dmfDir, 'System Security Role.xml'),
      `<?xml version="1.0" encoding="utf-8"?><Document>` +
      `<SYSTEMSECURITYROLEENTITY>` +
        `<SECURITYROLEIDENTIFIER>R1</SECURITYROLEIDENTIFIER>` +
        `<SECURITYROLENAME>RoleOne</SECURITYROLENAME>` +
      `</SYSTEMSECURITYROLEENTITY>` +
      `</Document>`, 'utf-8');
    writeFileSync(join(dmfDir, 'System Security Role Duty.xml'),
      `<?xml version="1.0" encoding="utf-8"?><Document></Document>`, 'utf-8');
    dbPath = join(tmpDir, 'no-v2.sqlite');
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('given no V2 file, when building, then the build completes without throwing', () => {
    assert.doesNotThrow(() => buildSecurityDatabase({
      packagesPathArg: 'skip',
      dmfInputDir: join(tmpDir, 'dmf'),
      outputPath: dbPath,
      log: () => {},
    }));
    // Database file was created
    assert.ok(statSync(dbPath).size > 0);
  });
});

// ── CR-SEC-007 — Direct role→privilege (System Security Privilege.xml) ─────

describe('buildSecurityDatabase — System Security Privilege.xml (CR-SEC-007)', () => {
  let tmpDir;
  let dbPath;

  before(() => {
    tmpDir = join(tmpdir(), `sec-build-priv-${randomUUID().slice(0, 8)}`);
    mkdirSync(tmpDir, { recursive: true });
    const dmfDir = join(tmpDir, 'dmf');
    mkdirSync(dmfDir, { recursive: true });

    writeFileSync(join(dmfDir, 'System Security Role.xml'),
      `<?xml version="1.0" encoding="utf-8"?><Document>` +
      `<SYSTEMSECURITYROLEENTITY>` +
        `<SECURITYROLEIDENTIFIER>ROLE-GUID-1</SECURITYROLEIDENTIFIER>` +
        `<SECURITYROLENAME>TestRole</SECURITYROLENAME>` +
      `</SYSTEMSECURITYROLEENTITY>` +
      `</Document>`, 'utf-8');
    writeFileSync(join(dmfDir, 'System Security Role Duty.xml'),
      `<?xml version="1.0" encoding="utf-8"?><Document></Document>`, 'utf-8');

    // Direct role→privilege export. Two unique privileges + one duplicate
    // + one orphan with no role (must be skipped).
    writeFileSync(join(dmfDir, 'System Security Privilege.xml'),
      `<?xml version="1.0" encoding="utf-8"?><Document>` +
      `<SYSTEMSECURITYPRIVILEGEENTITY>` +
        `<SECURITYPRIVILEGEIDENTIFIER>PRIV_X</SECURITYPRIVILEGEIDENTIFIER>` +
        `<SECURITYPRIVILEGENAME>Privilege X</SECURITYPRIVILEGENAME>` +
        `<SECURITYROLEIDENTIFIER>ROLE-GUID-1</SECURITYROLEIDENTIFIER>` +
        `<SECURITYROLENAME>TestRole</SECURITYROLENAME>` +
      `</SYSTEMSECURITYPRIVILEGEENTITY>` +
      `<SYSTEMSECURITYPRIVILEGEENTITY>` +
        `<SECURITYPRIVILEGEIDENTIFIER>PRIV_Y</SECURITYPRIVILEGEIDENTIFIER>` +
        `<SECURITYPRIVILEGENAME>Privilege Y</SECURITYPRIVILEGENAME>` +
        `<SECURITYROLEIDENTIFIER>ROLE-GUID-1</SECURITYROLEIDENTIFIER>` +
        `<SECURITYROLENAME>TestRole</SECURITYROLENAME>` +
      `</SYSTEMSECURITYPRIVILEGEENTITY>` +
      `<SYSTEMSECURITYPRIVILEGEENTITY>` +
        // duplicate of first row (role_id, privilege_name) — must be idempotent
        `<SECURITYPRIVILEGEIDENTIFIER>PRIV_X</SECURITYPRIVILEGEIDENTIFIER>` +
        `<SECURITYPRIVILEGENAME>Privilege X</SECURITYPRIVILEGENAME>` +
        `<SECURITYROLEIDENTIFIER>ROLE-GUID-1</SECURITYROLEIDENTIFIER>` +
      `</SYSTEMSECURITYPRIVILEGEENTITY>` +
      `<SYSTEMSECURITYPRIVILEGEENTITY>` +
        // missing role id — must be skipped
        `<SECURITYPRIVILEGEIDENTIFIER>PRIV_ORPHAN</SECURITYPRIVILEGEIDENTIFIER>` +
      `</SYSTEMSECURITYPRIVILEGEENTITY>` +
      `</Document>`, 'utf-8');

    dbPath = join(tmpDir, 'priv-sec.sqlite');
    buildSecurityDatabase({
      packagesPathArg: 'skip',
      dmfInputDir: dmfDir,
      outputPath: dbPath,
      log: () => {},
    });
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('populates role_direct_privileges with direct role→privilege pairs', () => {
    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare(
      `SELECT role_id, privilege_name FROM role_direct_privileges ORDER BY privilege_name`
    ).all();
    db.close();
    assert.equal(rows.length, 2);
    assert.deepEqual(rows, [
      { role_id: 'ROLE-GUID-1', privilege_name: 'PRIV_X' },
      { role_id: 'ROLE-GUID-1', privilege_name: 'PRIV_Y' },
    ]);
  });

  it('creates privilege rows (with labels) for unseen privilege names', () => {
    const db = new Database(dbPath, { readonly: true });
    const x = db.prepare("SELECT label FROM privileges WHERE privilege_name = 'PRIV_X'").get();
    const y = db.prepare("SELECT label FROM privileges WHERE privilege_name = 'PRIV_Y'").get();
    db.close();
    assert.equal(x?.label, 'Privilege X');
    assert.equal(y?.label, 'Privilege Y');
  });

  it('skips entities missing role id without breaking the build', () => {
    const db = new Database(dbPath, { readonly: true });
    const orphan = db.prepare(
      "SELECT COUNT(*) c FROM role_direct_privileges WHERE privilege_name = 'PRIV_ORPHAN'"
    ).get();
    db.close();
    assert.equal(orphan.c, 0);
  });
});

// ── CR-SEC-007 — Direct role→entity permissions (System Security Permissions.xml)

describe('buildSecurityDatabase — System Security Permissions.xml (CR-SEC-007)', () => {
  let tmpDir;
  let dbPath;

  before(() => {
    tmpDir = join(tmpdir(), `sec-build-perm-${randomUUID().slice(0, 8)}`);
    mkdirSync(tmpDir, { recursive: true });
    const dmfDir = join(tmpDir, 'dmf');
    mkdirSync(dmfDir, { recursive: true });

    writeFileSync(join(dmfDir, 'System Security Role.xml'),
      `<?xml version="1.0" encoding="utf-8"?><Document>` +
      `<SYSTEMSECURITYROLEENTITY>` +
        `<SECURITYROLEIDENTIFIER>ROLE-GUID-1</SECURITYROLEIDENTIFIER>` +
        `<SECURITYROLENAME>TestRole</SECURITYROLENAME>` +
      `</SYSTEMSECURITYROLEENTITY>` +
      `</Document>`, 'utf-8');
    writeFileSync(join(dmfDir, 'System Security Role Duty.xml'),
      `<?xml version="1.0" encoding="utf-8"?><Document></Document>`, 'utf-8');

    // DMF codes: 0=Unset, 1=Grant, 2=Deny.
    writeFileSync(join(dmfDir, 'System Security Permissions.xml'),
      `<?xml version="1.0" encoding="utf-8"?><Document>` +
      `<SYSTEMSECURITYPERMISSIONENTITY>` +
        `<CORRECTACCESS>0</CORRECTACCESS>` +
        `<CREATEACCESS>2</CREATEACCESS>` +
        `<DELETEACCESS>2</DELETEACCESS>` +
        `<INVOKEACCESS>0</INVOKEACCESS>` +
        `<READACCESS>1</READACCESS>` +
        `<UPDATEACCESS>2</UPDATEACCESS>` +
        `<RESOURCENAME>VENDTABLELISTPAGE</RESOURCENAME>` +
        `<RESOURCETYPE>MenuItemDisplay</RESOURCETYPE>` +
        `<SECURITYROLEIDENTIFIER>ROLE-GUID-1</SECURITYROLEIDENTIFIER>` +
        `<SECURITYROLENAME>TestRole</SECURITYROLENAME>` +
      `</SYSTEMSECURITYPERMISSIONENTITY>` +
      `<SYSTEMSECURITYPERMISSIONENTITY>` +
        // missing role id — must be skipped
        `<READACCESS>1</READACCESS>` +
        `<RESOURCENAME>ORPHANED_RESOURCE</RESOURCENAME>` +
      `</SYSTEMSECURITYPERMISSIONENTITY>` +
      `</Document>`, 'utf-8');

    dbPath = join(tmpDir, 'perm-sec.sqlite');
    buildSecurityDatabase({
      packagesPathArg: 'skip',
      dmfInputDir: dmfDir,
      outputPath: dbPath,
      log: () => {},
    });
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('maps DMF access codes: 1→Allow, 2→Deny, 0→null', () => {
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare(
      `SELECT resource_type, grant_read, grant_create, grant_update, grant_delete,
              grant_correct, grant_invoke
         FROM role_direct_entity_permissions
        WHERE role_id = 'ROLE-GUID-1' AND entity_name = 'VENDTABLELISTPAGE'`
    ).get();
    db.close();
    assert.ok(row, 'expected a row for ROLE-GUID-1 / VENDTABLELISTPAGE');
    assert.equal(row.grant_read, 'Allow');
    assert.equal(row.grant_create, 'Deny');
    assert.equal(row.grant_update, 'Deny');
    assert.equal(row.grant_delete, 'Deny');
    assert.equal(row.grant_correct, null);
    assert.equal(row.grant_invoke, null);
    assert.equal(row.resource_type, 'MenuItemDisplay');
  });

  it('skips entities missing role id or resource name', () => {
    const db = new Database(dbPath, { readonly: true });
    const orphan = db.prepare(
      "SELECT COUNT(*) c FROM role_direct_entity_permissions WHERE entity_name = 'ORPHANED_RESOURCE'"
    ).get();
    db.close();
    assert.equal(orphan.c, 0);
  });
});

// ── buildSecurityDatabase — AOT label resolution end-to-end (gap #4 regression) ──
//
// No prior test exercised the AOT path's Label properties through the full
// build — every other AOT-path test here passes packagesPathArg: 'skip'. That
// gap is exactly how the colon-only resolveLabel() regex shipped undetected:
// "labels loaded" only checks that label FILES were found, never that a real
// `@…` reference on a role/duty/privilege actually resolved to text.

describe('buildSecurityDatabase — AOT label resolution end-to-end', () => {
  let tmpDir;
  let dbPath;
  let buildResult;

  before(() => {
    tmpDir = join(tmpdir(), `sec-build-labels-test-${randomUUID().slice(0, 8)}`);
    const modelDir = join(tmpDir, 'PkgA', 'ModelA');

    const roleDir = join(modelDir, 'AxSecurityRole');
    const dutyDir = join(modelDir, 'AxSecurityDuty');
    const privDir = join(modelDir, 'AxSecurityPrivilege');
    const sysLabelDir = join(modelDir, 'AxLabelFile', 'LabelResources', 'en-US');
    const qmsLabelDir = join(modelDir, 'AxLabelFile', 'LabelResources', 'en-US');
    mkdirSync(roleDir, { recursive: true });
    mkdirSync(dutyDir, { recursive: true });
    mkdirSync(privDir, { recursive: true });
    mkdirSync(sysLabelDir, { recursive: true });
    mkdirSync(qmsLabelDir, { recursive: true });

    // Concatenated form (@SYS154926) — the common Microsoft-standard shape.
    writeFileSync(join(roleDir, 'TestRole.xml'),
      `<?xml version="1.0" encoding="utf-8"?>` +
      `<AxSecurityRole><Name>TESTROLE</Name><Label>@SYS154926</Label></AxSecurityRole>`, 'utf-8');

    // Colon-delimited form (@QMS:CAPAViewer) — the common ISV/custom shape.
    writeFileSync(join(dutyDir, 'TestDuty.xml'),
      `<?xml version="1.0" encoding="utf-8"?>` +
      `<AxSecurityDuty><Name>TESTDUTYID</Name><Label>@QMS:CAPAViewer</Label></AxSecurityDuty>`, 'utf-8');

    // Concatenated form on a custom module (@QMS338).
    writeFileSync(join(privDir, 'TestPriv.xml'),
      `<?xml version="1.0" encoding="utf-8"?>` +
      `<AxSecurityPrivilege><Name>TESTPRIVID</Name><Label>@QMS338</Label></AxSecurityPrivilege>`, 'utf-8');

    writeFileSync(join(sysLabelDir, 'SYS.en-US.label.txt'), '154926=Resolved SYS Role Text\n', 'utf-8');
    writeFileSync(join(qmsLabelDir, 'QMS.en-US.label.txt'), 'CAPAViewer=Resolved QMS Duty Text\n338=Resolved QMS Priv Text\n', 'utf-8');

    dbPath = join(tmpDir, 'labels-sec.sqlite');
    buildResult = buildSecurityDatabase({
      packagesPathArg: tmpDir,
      dmfInputDir: 'skip',
      outputPath: dbPath,
      log: () => {},
    });
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resolves a concatenated-form role label (@SYS154926)', () => {
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare('SELECT label FROM roles WHERE role_id = ?').get('TESTROLE');
    db.close();
    assert.equal(row.label, 'Resolved SYS Role Text');
  });

  it('resolves a colon-form duty label into duty_name (@QMS:CAPAViewer)', () => {
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare('SELECT duty_name FROM duties WHERE duty_id = ?').get('TESTDUTYID');
    db.close();
    assert.equal(row.duty_name, 'Resolved QMS Duty Text');
  });

  it('resolves a concatenated-form privilege label on a custom module (@QMS338)', () => {
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare('SELECT label FROM privileges WHERE privilege_name = ?').get('TESTPRIVID');
    db.close();
    assert.equal(row.label, 'Resolved QMS Priv Text');
  });

  it('reports the "labels resolved" data-quality check as PASS with zero leaks', () => {
    const check = buildResult.checks.find(c => c.name === 'labels resolved');
    assert.ok(check, 'expected a "labels resolved" check');
    assert.equal(check.pass, true);
    assert.match(check.detail, /^0 role \/ 0 duty \/ 0 privilege/);
  });
});

