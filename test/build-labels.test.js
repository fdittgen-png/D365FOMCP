/**
 * build/build-labels.js — the d365fo_labels.sqlite builder + per-model delta
 * (docs/Labels-Service-Concept-2026-09-08.md §3.1 / §3.4).
 *
 * Synthetic package: two models, three languages, one label untranslated in
 * `de`, descriptions identical across languages (the measured property the
 * schema relies on: description stored ONCE in label_meta).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { buildLabelsDb, refreshLabelsModules, LABELS_SCHEMA_VERSION } from '../build/build-labels.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const BOM = '﻿';
const DESCRIPTOR = (name, layer, publisher) => `<?xml version="1.0" encoding="utf-8"?>
<AxModelInfo xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
  <Name>${name}</Name><ModelModule>${name}</ModelModule><DisplayName>${name}</DisplayName>
  <Publisher>${publisher}</Publisher><Layer>${layer}</Layer>
  <VersionMajor>10</VersionMajor><VersionMinor>0</VersionMinor><VersionBuild>1</VersionBuild><VersionRevision>0</VersionRevision>
</AxModelInfo>`;

function writeLabel(root, pkg, model, lang, prefix, body) {
  const dir = join(root, pkg, model, 'AxLabelFile', 'LabelResources', lang);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${prefix}.${lang}.label.txt`), BOM + body.replace(/\n/g, '\r\n'), 'utf8');
}

function makePackages(root) {
  // Real layout: <Package>/Descriptor/<Model>.xml (layer 0-7 = microsoft, 10+ = custom)
  mkdirSync(join(root, 'ApplicationSuite', 'Descriptor'), { recursive: true });
  writeFileSync(join(root, 'ApplicationSuite', 'Descriptor', 'Foundation.xml'), DESCRIPTOR('Foundation', 0, 'Microsoft Corporation'));
  mkdirSync(join(root, 'HISOL', 'Descriptor'), { recursive: true });
  writeFileSync(join(root, 'HISOL', 'Descriptor', 'HSAPAC.xml'), DESCRIPTOR('HSAPAC', 12, 'Hitachi'));

  writeLabel(root, 'ApplicationSuite', 'Foundation', 'en-US', 'AccountsPayable',
    'VendMaintain=Maintain vendor master data\n ;Duty\nVendInquire=Inquire into vendor master data\n ;Duty\n@SYS1=Vendor\n ;[SecurityDuty FIM]\n');
  writeLabel(root, 'ApplicationSuite', 'Foundation', 'de', 'AccountsPayable',
    'VendMaintain=Masterdaten von Kreditoren verwalten\n ;Duty\n@SYS1=Kreditor\n ;[SecurityDuty FIM]\n');
  writeLabel(root, 'ApplicationSuite', 'Foundation', 'fr', 'AccountsPayable',
    'VendMaintain=Gérer les données fournisseur\n ;Duty\nVendInquire=Consulter les fournisseurs\n ;Duty\n@SYS1=Fournisseur\n ;[SecurityDuty FIM]\n');
  writeLabel(root, 'HISOL', 'HSAPAC', 'en-US', 'HSAPAC', 'HS0300001=Similan journal setup\nHS0300004=Similan\n ;Module name\n');
}

describe('buildLabelsDb', () => {
  let root, out, db;
  before(async () => {
    root = mkdtempSync(join(tmpdir(), 'lblbuild-'));
    makePackages(root);
    out = join(root, 'labels.sqlite');
    await buildLabelsDb({ outputPath: out, packagesPaths: [root], log: () => {} });
    db = new Database(out, { readonly: true });
  });
  after(() => { try { db.close(); } catch {} rmSync(root, { recursive: true, force: true }); });

  it('label_meta has one row per id with the description, file, module and origin', () => {
    const rows = db.prepare('SELECT * FROM label_meta ORDER BY label_id').all();
    assert.deepEqual(rows.map(r => r.label_id), ['@AccountsPayable:VendInquire', '@AccountsPayable:VendMaintain', '@HSAPAC:HS0300001', '@HSAPAC:HS0300004', '@SYS1']);
    const m = rows.find(r => r.label_id === '@AccountsPayable:VendMaintain');
    assert.deepEqual(m, { label_id: '@AccountsPayable:VendMaintain', label_file: 'AccountsPayable', module: 'Foundation', origin: 'microsoft', description: 'Duty' });
    assert.equal(rows.find(r => r.label_id === '@HSAPAC:HS0300001').description, null);
    assert.equal(rows.find(r => r.label_id === '@HSAPAC:HS0300004').origin, 'custom');
  });

  it('labels has one row per (id, language) — the untranslated de label is simply absent', () => {
    assert.equal(db.prepare('SELECT COUNT(*) n FROM labels').get().n, 3 + 2 + 3 + 2);
    assert.equal(db.prepare("SELECT text FROM labels WHERE label_id='@SYS1' AND language='de'").get().text, 'Kreditor');
    assert.equal(db.prepare("SELECT COUNT(*) n FROM labels WHERE label_id='@AccountsPayable:VendInquire' AND language='de'").get().n, 0);
  });

  it('label_languages / label_files / labels_metadata carry the inventory', () => {
    assert.deepEqual(db.prepare('SELECT language, label_count, file_count FROM label_languages ORDER BY language').all(), [
      { language: 'de', label_count: 2, file_count: 1 },
      { language: 'en-US', label_count: 5, file_count: 2 },
      { language: 'fr', label_count: 3, file_count: 1 },
    ]);
    const f = db.prepare("SELECT * FROM label_files WHERE label_file='AccountsPayable' AND language='en-US'").get();
    assert.equal(f.label_count, 3); assert.equal(f.description_count, 3); assert.equal(f.module, 'Foundation');
    const meta = Object.fromEntries(db.prepare('SELECT key, value FROM labels_metadata').all().map(r => [r.key, r.value]));
    assert.equal(meta.schema_version, LABELS_SCHEMA_VERSION);
    assert.ok(!Number.isNaN(new Date(meta.build_date).getTime()));
    assert.equal(meta.label_count, '10'); assert.equal(meta.meta_count, '5'); assert.equal(meta.language_count, '3');
    assert.equal(meta.description_disagreements, '0');
    assert.equal(meta.partial_build, undefined);
    assert.equal(db.prepare("SELECT origin FROM model_versions WHERE model_name='HSAPAC'").get().origin, 'custom');
  });

  it('labels_fts finds text in any stored language', () => {
    const hit = db.prepare("SELECT l.label_id, l.language FROM labels_fts f JOIN labels l ON l.rowid = f.rowid WHERE labels_fts MATCH 'Kreditoren'").all();
    assert.deepEqual(hit, [{ label_id: '@AccountsPayable:VendMaintain', language: 'de' }]);
  });

  it('a language allow-list stores only those languages', async () => {
    const out2 = join(root, 'labels-en.sqlite');
    const r = await buildLabelsDb({ outputPath: out2, packagesPaths: [root], languages: ['en-US'], log: () => {} });
    assert.equal(r.languages, 1); assert.equal(r.labels, 5);
    const d2 = new Database(out2, { readonly: true });
    assert.deepEqual(d2.prepare('SELECT DISTINCT language FROM labels').all(), [{ language: 'en-US' }]);
    d2.close();
  });
});

describe('refreshLabelsModules (per-model delta)', () => {
  let root, out;
  before(async () => {
    root = mkdtempSync(join(tmpdir(), 'lbldelta-'));
    makePackages(root);
    out = join(root, 'labels.sqlite');
    await buildLabelsDb({ outputPath: out, packagesPaths: [root], log: () => {} });
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it('replaces the module rows: changed text, removed label, new label, FTS in sync, partial_build set', async () => {
    writeLabel(root, 'HISOL', 'HSAPAC', 'en-US', 'HSAPAC', 'HS0300001=Similan journal SETUP\n ;Menu item\nHS0300099=Brand new\n');
    const r = await refreshLabelsModules({ dbPath: out, modules: ['HSAPAC'], packagesPaths: [root], log: () => {} });
    assert.deepEqual(r.modules, ['HSAPAC']);
    const db = new Database(out, { readonly: true });
    assert.equal(db.prepare("SELECT text FROM labels WHERE label_id='@HSAPAC:HS0300001'").get().text, 'Similan journal SETUP');
    assert.equal(db.prepare("SELECT description FROM label_meta WHERE label_id='@HSAPAC:HS0300001'").get().description, 'Menu item');
    assert.equal(db.prepare("SELECT COUNT(*) n FROM labels WHERE label_id='@HSAPAC:HS0300004'").get().n, 0, 'removed label gone');
    assert.equal(db.prepare("SELECT COUNT(*) n FROM label_meta WHERE label_id='@HSAPAC:HS0300004'").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM labels WHERE label_id='@HSAPAC:HS0300099'").get().n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM labels_fts WHERE labels_fts MATCH 'SETUP'").get().n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM labels_fts WHERE labels_fts MATCH 'Similan'").get().n, 1, 'old Similan module-name row is gone from FTS');
    // Untouched module stays byte-identical
    assert.equal(db.prepare("SELECT COUNT(*) n FROM labels WHERE label_id LIKE '@AccountsPayable:%'").get().n, 5);
    const meta = Object.fromEntries(db.prepare('SELECT key, value FROM labels_metadata').all().map(r => [r.key, r.value]));
    assert.ok(meta.partial_build, 'partial_build stamped by the delta');
    assert.equal(meta.label_count, '10'); // 3+2+3 AP + 2 HSAPAC
    db.close();
  });
});

describe('pipeline hooks (static scan)', () => {
  const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  it('build:kb refreshes the labels DB after the ISV scan (non-fatal, LABELS_SCAN=off skips)', () => {
    const src = read('build/build-kb.js');
    assert.match(src, /refreshLabelsAfterKb\(/, 'build-kb.js calls refreshLabelsAfterKb');
    assert.match(read('build/build-labels.js'), /LABELS_SCAN/, 'the off switch exists');
  });
  it('the per-model KB delta refreshes the same models in the labels DB', () => {
    assert.match(read('build/update-kb-model.js'), /refreshLabelsModules\(/);
  });
});
