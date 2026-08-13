/**
 * Tests for the model descriptor reader (src/azure/model-descriptors.js):
 * AxModelInfo parsing, layer/origin classification, and the on-disk
 * <root>/<Package>/Descriptor/<Model>.xml scan used by all three DB builders.
 *
 * Run: npm test
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  parseModelDescriptor,
  readModelDescriptors,
  insertModelVersions,
  classifyOrigin,
  layerName,
  MODEL_VERSIONS_SCHEMA,
} from '../src/azure/model-descriptors.js';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

function descriptorXml({ name, module, displayName, publisher, layer, major, minor, build, revision }) {
  return `<?xml version="1.0" encoding="utf-8"?>
<AxModelInfo xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="http://schemas.datacontract.org/2004/07/Microsoft.Dynamics.AX.Metadata.MetaModel">
  <Customization>Allow</Customization>
  ${displayName !== undefined ? `<DisplayName>${displayName}</DisplayName>` : ''}
  ${layer !== undefined ? `<Layer>${layer}</Layer>` : ''}
  ${module !== undefined ? `<ModelModule>${module}</ModelModule>` : ''}
  <Name>${name}</Name>
  ${publisher !== undefined ? `<Publisher>${publisher}</Publisher>` : ''}
  ${build !== undefined ? `<VersionBuild>${build}</VersionBuild>` : ''}
  ${major !== undefined ? `<VersionMajor>${major}</VersionMajor>` : ''}
  ${minor !== undefined ? `<VersionMinor>${minor}</VersionMinor>` : ''}
  ${revision !== undefined ? `<VersionRevision>${revision}</VersionRevision>` : ''}
</AxModelInfo>`;
}

describe('classifyOrigin / layerName', () => {
  it('maps SYS..SLP layers to microsoft', () => {
    assert.equal(classifyOrigin(0, 'Anyone'), 'microsoft');
    assert.equal(classifyOrigin(7, null), 'microsoft');
  });
  it('maps ISV/ISP layers to isv', () => {
    assert.equal(classifyOrigin(8, 'Some ISV'), 'isv');
    assert.equal(classifyOrigin(9, null), 'isv');
  });
  it('maps VAR..USP layers to custom', () => {
    assert.equal(classifyOrigin(10, null), 'custom');
    assert.equal(classifyOrigin(14, 'Trelleborg'), 'custom');
    assert.equal(classifyOrigin(15, null), 'custom');
  });
  it('falls back to publisher when layer is missing', () => {
    assert.equal(classifyOrigin(null, 'Microsoft Corporation'), 'microsoft');
    assert.equal(classifyOrigin(null, 'Trelleborg'), 'unknown');
    assert.equal(classifyOrigin(null, null), 'unknown');
  });
  it('names the standard layers', () => {
    assert.equal(layerName(0), 'SYS');
    assert.equal(layerName(8), 'ISV');
    assert.equal(layerName(14), 'USR');
    assert.equal(layerName(99), null);
    assert.equal(layerName(null), null);
  });
});

describe('parseModelDescriptor', () => {
  it('extracts name, module, publisher, layer, and the 4-part version', () => {
    const parsed = parseModelDescriptor(descriptorXml({
      name: 'iExtension', module: 'iExtension', displayName: 'iExtension',
      publisher: 'Trelleborg', layer: 14, major: 10, minor: 0, build: 32, revision: 7,
    }));
    assert.deepEqual(parsed, {
      model_name: 'iExtension',
      module_id: 'iExtension',
      display_name: 'iExtension',
      publisher: 'Trelleborg',
      layer: 'USR',
      origin: 'custom',
      version: '10.0.32.7',
    });
  });

  it('handles a Microsoft application model', () => {
    const parsed = parseModelDescriptor(descriptorXml({
      name: 'Foundation', module: 'ApplicationSuite', displayName: 'Application Suite',
      publisher: 'Microsoft Corporation', layer: 0, major: 10, minor: 0, build: 2263, revision: 172,
    }));
    assert.equal(parsed.module_id, 'ApplicationSuite');
    assert.equal(parsed.origin, 'microsoft');
    assert.equal(parsed.layer, 'SYS');
    assert.equal(parsed.version, '10.0.2263.172');
  });

  it('returns null version when any version part is missing', () => {
    const parsed = parseModelDescriptor(descriptorXml({
      name: 'PartialModel', layer: 8, major: 10, minor: 0,
    }));
    assert.equal(parsed.version, null);
    assert.equal(parsed.origin, 'isv');
    assert.equal(parsed.module_id, null);
  });

  it('accepts a 0 version part (falsy but valid)', () => {
    const parsed = parseModelDescriptor(descriptorXml({
      name: 'ZeroBuild', layer: 0, major: 10, minor: 0, build: 0, revision: 0,
    }));
    assert.equal(parsed.version, '10.0.0.0');
  });

  it('returns null for non-AxModelInfo XML and garbage', () => {
    assert.equal(parseModelDescriptor('<SomethingElse><Name>x</Name></SomethingElse>'), null);
    assert.equal(parseModelDescriptor('not xml at all <<<'), null);
    assert.equal(parseModelDescriptor(descriptorXml({ name: '' })), null);
  });
});

describe('readModelDescriptors (on-disk scan)', () => {
  let root;

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'mcp-descriptors-'));
    // <root>/ApplicationSuite/Descriptor/Foundation.xml  (Microsoft)
    mkdirSync(join(root, 'ApplicationSuite', 'Descriptor'), { recursive: true });
    writeFileSync(
      join(root, 'ApplicationSuite', 'Descriptor', 'Foundation.xml'),
      descriptorXml({
        name: 'Foundation', module: 'ApplicationSuite', publisher: 'Microsoft Corporation',
        layer: 0, major: 10, minor: 0, build: 2263, revision: 172,
      }),
    );
    // <root>/iExtension/descriptor/iExtension.xml — lowercase dir on purpose,
    // no <ModelModule> so module_id falls back to the package directory name.
    mkdirSync(join(root, 'iExtension', 'descriptor'), { recursive: true });
    writeFileSync(
      join(root, 'iExtension', 'descriptor', 'iExtension.xml'),
      descriptorXml({
        name: 'iExtension', publisher: 'Trelleborg',
        layer: 14, major: 10, minor: 0, build: 32, revision: 7,
      }),
    );
    // A package without a Descriptor dir must be skipped silently.
    mkdirSync(join(root, 'NoDescriptorHere', 'AxTable'), { recursive: true });
    // A non-parseable descriptor must warn, not throw.
    mkdirSync(join(root, 'Broken', 'Descriptor'), { recursive: true });
    writeFileSync(join(root, 'Broken', 'Descriptor', 'Broken.xml'), 'not xml <<<');
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('finds every descriptor and attributes it to the right package', () => {
    const warnings = [];
    const rows = readModelDescriptors([root], (m) => warnings.push(m));
    assert.equal(rows.length, 2);

    const foundation = rows.find(r => r.model_name === 'Foundation');
    assert.equal(foundation.module_id, 'ApplicationSuite');
    assert.equal(foundation.origin, 'microsoft');
    assert.equal(foundation.version, '10.0.2263.172');
    assert.equal(foundation.source_root, root);

    const iext = rows.find(r => r.model_name === 'iExtension');
    assert.equal(iext.module_id, 'iExtension');   // package-dir fallback
    assert.equal(iext.origin, 'custom');
    assert.equal(iext.layer, 'USR');
    assert.equal(iext.version, '10.0.32.7');

    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /Broken/);
  });

  it('dedupes the same model across two roots (first root wins)', () => {
    const rows = readModelDescriptors([root, root]);
    assert.equal(rows.filter(r => r.model_name === 'iExtension').length, 1);
  });

  it('warns and continues on a missing root', () => {
    const warnings = [];
    const rows = readModelDescriptors([join(root, 'does-not-exist'), root], (m) => warnings.push(m));
    assert.equal(rows.length, 2);
    assert.ok(warnings.some(w => w.includes('does-not-exist')));
  });

  it('insertModelVersions round-trips through the shared schema', () => {
    const db = new Database(':memory:');
    db.exec(MODEL_VERSIONS_SCHEMA);
    const rows = readModelDescriptors([root]);
    insertModelVersions((sql, params) => db.prepare(sql).run(...params), rows);
    const stored = db.prepare('SELECT * FROM model_versions ORDER BY model_name').all();
    assert.equal(stored.length, 2);
    assert.equal(stored[1].model_name, 'iExtension');
    assert.equal(stored[1].version, '10.0.32.7');
    assert.equal(stored[1].origin, 'custom');
    // NOCASE module lookup (the index the tools' queries rely on)
    const byModule = db.prepare(
      'SELECT model_name FROM model_versions WHERE module_id = ? COLLATE NOCASE'
    ).all('IEXTENSION');
    assert.equal(byModule.length, 1);
    db.close();
  });
});
