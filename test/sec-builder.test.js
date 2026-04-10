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
