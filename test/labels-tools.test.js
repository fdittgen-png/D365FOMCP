/**
 * src/azure/labels-tools.js — the four Labels service tools against a
 * builder-made labels DB and an in-memory XRef fixture.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { z } from 'zod';
import { buildLabelsDb } from '../build/build-labels.js';
import { registerLabelsTools, parseXrefSourcePath, labelsSearchSql } from '../src/azure/labels-tools.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

function mockServer() {
  const handlers = {};
  return { registerTool: (name, config, handler) => { handlers[name] = { schema: config.inputSchema, outputSchema: config.outputSchema, annotations: config.annotations, description: config.description, handler }; }, handlers };
}

function writeLabel(root, pkg, model, lang, prefix, body) {
  const dir = join(root, pkg, model, 'AxLabelFile', 'LabelResources', lang);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${prefix}.${lang}.label.txt`), '﻿' + body.replace(/\n/g, '\r\n'), 'utf8');
}

function xrefFixture() {
  const x = new Database(':memory:');
  x.exec(`CREATE TABLE names (id INTEGER PRIMARY KEY, path TEXT, provider_id INTEGER, module_id INTEGER);
          CREATE INDEX idx_names_path ON names(path);
          CREATE TABLE refs (source_id INTEGER, target_id INTEGER, kind INTEGER, line INTEGER, col INTEGER);
          CREATE INDEX idx_refs_target ON refs(target_id);`);
  const names = ['/Labels/@SYS1', '/Labels/@AccountsPayable:VendMaintain', 'Table/CustTable?Label',
    'Table/CustTable/TableFieldString/AccountNum?HelpText', 'Table/CustTableChange?Label', '/Classes/Foo/Methods/bar',
    'SecurityDuty/VendMaintainDuty?Label', 'Form/CustTable/FormDesign/Grid?Caption'];
  const ins = x.prepare('INSERT INTO names (id, path, provider_id, module_id) VALUES (?, ?, 0, 1)');
  names.forEach((p, i) => ins.run(i + 1, p));
  const id = (p) => names.indexOf(p) + 1;
  const ref = x.prepare('INSERT INTO refs VALUES (?, ?, ?, 0, 0)');
  ref.run(id('Table/CustTable?Label'), id('/Labels/@SYS1'), 2);
  ref.run(id('Table/CustTable/TableFieldString/AccountNum?HelpText'), id('/Labels/@SYS1'), 2);
  ref.run(id('Table/CustTableChange?Label'), id('/Labels/@SYS1'), 2);
  ref.run(id('/Classes/Foo/Methods/bar'), id('/Labels/@SYS1'), 1);
  ref.run(id('Form/CustTable/FormDesign/Grid?Caption'), id('/Labels/@SYS1'), 2);
  ref.run(id('SecurityDuty/VendMaintainDuty?Label'), id('/Labels/@AccountsPayable:VendMaintain'), 2);
  return x;
}

describe('labels tools', () => {
  let root, db, xref, tools, toolsNoXref;
  const call = async (set, name, args) => {
    const t = set.handlers[name];
    const validated = z.object(t.schema).parse({ format: 'markdown', ...args });
    return t.handler(validated);
  };

  before(async () => {
    root = mkdtempSync(join(tmpdir(), 'lbltools-'));
    mkdirSync(join(root, 'ApplicationSuite', 'Descriptor'), { recursive: true });
    writeFileSync(join(root, 'ApplicationSuite', 'Descriptor', 'Foundation.xml'),
      '<AxModelInfo><Name>Foundation</Name><ModelModule>ApplicationSuite</ModelModule><Publisher>Microsoft Corporation</Publisher><Layer>0</Layer><VersionMajor>10</VersionMajor><VersionMinor>0</VersionMinor><VersionBuild>1</VersionBuild><VersionRevision>0</VersionRevision></AxModelInfo>');
    writeLabel(root, 'ApplicationSuite', 'Foundation', 'en-US', 'AccountsPayable', 'VendMaintain=Maintain vendor master data\n ;Duty\n@SYS1=Vendor\n ;[SecurityDuty FIM]\nOther=Something else\n');
    writeLabel(root, 'ApplicationSuite', 'Foundation', 'de', 'AccountsPayable', 'VendMaintain=Masterdaten von Kreditoren verwalten\n ;Duty\n@SYS1=Kreditor\n ;[SecurityDuty FIM]\n');
    writeLabel(root, 'ApplicationSuite', 'Foundation', 'fr', 'AccountsPayable', '@SYS1=Fournisseur\n ;[SecurityDuty FIM]\nOther=Autre chose\n');
    const out = join(root, 'labels.sqlite');
    await buildLabelsDb({ outputPath: out, packagesPaths: [root], log: () => {} });
    db = new Database(out, { readonly: true });
    xref = xrefFixture();
    tools = mockServer(); registerLabelsTools(tools, db, { xrefDb: xref });
    toolsNoXref = mockServer(); registerLabelsTools(toolsNoXref, db);
  });
  after(() => { try { db.close(); xref.close(); } catch {} rmSync(root, { recursive: true, force: true }); });

  it('registers four tools with read-only annotations and output schemas', () => {
    assert.deepEqual(Object.keys(tools.handlers).sort(), ['labels_for_object', 'labels_lookup', 'labels_search', 'labels_where_used']);
    for (const t of Object.values(tools.handlers)) { assert.equal(t.annotations.readOnlyHint, true); assert.ok(t.outputSchema); assert.ok(t.description.length <= 300, 'description ≤ 300 chars'); }
  });

  describe('labels_lookup', () => {
    it('returns meta once per id (description always) and text per language, case-tolerant, no-@ tolerant', async () => {
      const r = await call(tools, 'labels_lookup', { label_ids: ['sys1', 'AccountsPayable:VendMaintain', '@SYS999', 'not a label'] });
      assert.ok(!r.isError);
      const s = r.structuredContent;
      assert.equal(s.requested_count, 4); assert.equal(s.found_count, 2);
      assert.deepEqual(s.not_found, ['@SYS999', 'not a label']);
      assert.deepEqual(s.meta, [
        { label_id: '@AccountsPayable:VendMaintain', label_file: 'AccountsPayable', module: 'Foundation', origin: 'microsoft', description: 'Duty' },
        { label_id: '@SYS1', label_file: 'AccountsPayable', module: 'Foundation', origin: 'microsoft', description: '[SecurityDuty FIM]' },
      ]);
      assert.deepEqual(s.labels.filter(l => l.label_id === '@SYS1').map(l => l.language), ['de', 'en-US', 'fr']);
      assert.deepEqual(s.languages_present, ['de', 'en-US', 'fr']);
      assert.equal(s.languages_missing, undefined, 'only reported when languages were requested');
      assert.match(r.content[0].text, /^## Label lookup/);
      assert.ok(r.content[0].text.includes('[SecurityDuty FIM]'));
    });

    it('reports missing translations for the requested languages', async () => {
      const r = await call(tools, 'labels_lookup', { label_ids: ['@AccountsPayable:VendMaintain'], languages: ['en-US', 'fr'] });
      const s = r.structuredContent;
      assert.deepEqual(s.labels.map(l => l.language), ['en-US']);
      assert.deepEqual(s.languages_missing, [{ label_id: '@AccountsPayable:VendMaintain', languages: ['fr'] }]);
    });

    it('all ids unknown → notFoundResult (isError, no structuredContent)', async () => {
      const r = await call(tools, 'labels_lookup', { label_ids: ['@SYS999999'] });
      assert.equal(r.isError, true); assert.equal(r.structuredContent, undefined); assert.equal(r._meta.kind, 'not-found');
    });

    it('a null description stays an explicit null on the row (rule #14)', async () => {
      const r = await call(tools, 'labels_lookup', { label_ids: ['@AccountsPayable:Other'] });
      assert.equal(r.structuredContent.meta[0].description, null);
    });
  });

  describe('labels_search', () => {
    it('finds text in any language via FTS and paginates without overlap', async () => {
      const p1 = await call(tools, 'labels_search', { text: 'Kredit', limit: 1 });
      assert.equal(p1.structuredContent.result_count, 1);
      assert.equal(p1.structuredContent.has_more, true);
      assert.ok(p1.structuredContent.next_cursor);
      const p2 = await call(tools, 'labels_search', { text: 'Kredit', limit: 1, cursor: p1.structuredContent.next_cursor });
      assert.equal(p2.structuredContent.has_more, false);
      const all = [...p1.structuredContent.results, ...p2.structuredContent.results];
      assert.deepEqual(all.map(r => r.label_id).sort(), ['@AccountsPayable:VendMaintain', '@SYS1']);
      assert.ok(all.every(r => r.language === 'de' && 'description' in r));
    });

    it('language / origin filters and an empty result', async () => {
      const r = await call(tools, 'labels_search', { text: 'vendor', language: 'de' });
      assert.equal(r._meta?.kind, 'empty'); assert.equal(r.isError, undefined);
      const c = await call(tools, 'labels_search', { text: 'vendor', origin: 'custom' });
      assert.equal(c._meta?.kind, 'empty');
      const ok = await call(tools, 'labels_search', { text: 'vendor', language: 'en-US', origin: 'microsoft' });
      assert.equal(ok.structuredContent.result_count, 2, '"Vendor" and "Maintain vendor master data"');
    });

    it('rejects a garbage cursor as invalid-input', async () => {
      const r = await call(tools, 'labels_search', { text: 'vendor', cursor: '!!not-a-cursor!!' });
      assert.equal(r.isError, true); assert.match(r.content[0].text, /cursor/);
    });
  });

  describe('labels_where_used', () => {
    it('groups XRef usages by property, parses element paths, pages', async () => {
      const r = await call(tools, 'labels_where_used', { label_id: 'SYS1', limit: 3 });
      const s = r.structuredContent;
      assert.equal(s.label_id, '@SYS1'); assert.equal(s.text, 'Vendor'); assert.equal(s.description, '[SecurityDuty FIM]');
      assert.equal(s.total_count, 5);
      assert.deepEqual(s.property_counts, [{ property: 'Label', count: 2 }, { property: 'Caption', count: 1 }, { property: 'Code', count: 1 }, { property: 'HelpText', count: 1 }]);
      assert.equal(s.usages.length, 3); assert.equal(s.has_more, true);
      const p2 = await call(tools, 'labels_where_used', { label_id: '@SYS1', limit: 3, cursor: s.next_cursor });
      assert.equal(p2.structuredContent.usages.length, 2); assert.equal(p2.structuredContent.has_more, false);
      const all = [...s.usages, ...p2.structuredContent.usages];
      assert.deepEqual(all.find(u => u.kind === 'Code'), { object_type: 'Class', object_name: 'Foo', element: 'bar', property: null, kind: 'Code' });
      assert.deepEqual(all.find(u => u.property === 'HelpText'), { object_type: 'Table', object_name: 'CustTable', element: 'AccountNum', property: 'HelpText', kind: 'Property' });
      assert.match(r.content[0].text, /^## Label where-used: @SYS1/);
    });

    it('property and object_type filters narrow the SQL', async () => {
      const r = await call(tools, 'labels_where_used', { label_id: '@SYS1', property: 'Label', object_type: 'table' });
      assert.equal(r.structuredContent.total_count, 2);
      const c = await call(tools, 'labels_where_used', { label_id: '@SYS1', property: 'Code' });
      assert.equal(c.structuredContent.total_count, 1);
      const none = await call(tools, 'labels_where_used', { label_id: '@SYS1', object_type: 'privilege' });
      assert.equal(none._meta?.kind, 'empty');
    });

    it('a label known to the labels DB but absent from XRef is an empty result; unknown everywhere is not-found; no XRef is a db-error', async () => {
      const e = await call(tools, 'labels_where_used', { label_id: '@AccountsPayable:Other' });
      assert.equal(e._meta?.kind, 'empty'); assert.equal(e.structuredContent.total_count, 0);
      const nf = await call(tools, 'labels_where_used', { label_id: '@SYS424242' });
      assert.equal(nf.isError, true);
      const x = await call(toolsNoXref, 'labels_where_used', { label_id: '@SYS1' });
      assert.equal(x.isError, true); assert.match(x.content[0].text, /XRef database not available/);
    });
  });

  describe('labels_for_object', () => {
    it('lists the labels an object carries with element, property and text per language', async () => {
      const r = await call(tools, 'labels_for_object', { object_type: 'table', object_name: 'CustTable', languages: ['en-US', 'de'] });
      const s = r.structuredContent;
      assert.equal(s.label_count, 2, 'CustTableChange is a different object');
      assert.deepEqual(s.labels.map(l => `${l.element ?? ''}|${l.property}|${l.label_id}|${l.language}|${l.text}`), [
        '|Label|@SYS1|en-US|Vendor', '|Label|@SYS1|de|Kreditor',
        'AccountNum|HelpText|@SYS1|en-US|Vendor', 'AccountNum|HelpText|@SYS1|de|Kreditor',
      ]);
      assert.ok(s.labels.every(l => l.description === '[SecurityDuty FIM]'));
    });

    it('properties filter, friendly + raw type tokens, not-found object, no-XRef error', async () => {
      const p = await call(tools, 'labels_for_object', { object_type: 'Table', object_name: 'CustTable', properties: ['HelpText'] });
      assert.equal(p.structuredContent.label_count, 1);
      const cls = await call(tools, 'labels_for_object', { object_type: 'class', object_name: 'Foo' });
      assert.equal(cls.structuredContent.labels[0].property, 'Code');
      const nf = await call(tools, 'labels_for_object', { object_type: 'table', object_name: 'NoSuchTable' });
      assert.equal(nf.isError, true); assert.equal(nf._meta.kind, 'not-found');
      const x = await call(toolsNoXref, 'labels_for_object', { object_type: 'table', object_name: 'CustTable' });
      assert.equal(x.isError, true);
    });

    it('text is null when the label has no translation in a requested language', async () => {
      const r = await call(tools, 'labels_for_object', { object_type: 'duty', object_name: 'VendMaintainDuty', languages: ['fr'] });
      assert.deepEqual(r.structuredContent.labels, [{ element: null, property: 'Label', label_id: '@AccountsPayable:VendMaintain', language: 'fr', text: null, description: 'Duty' }]);
    });
  });

  it('labels_search query plan: the FTS index drives even with a language filter (26M-row regression, 2026-09-08)', () => {
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${labelsSearchSql(true, ' AND l.language = ? COLLATE NOCASE AND m.origin = ?')}`).all('"x"', 'de', 'microsoft', 21, 0);
    // SQLite prints the alias: "SCAN f VIRTUAL TABLE INDEX 0:M1" — f is labels_fts.
    assert.match(plan[0].detail, /^SCAN f VIRTUAL TABLE INDEX/, `first step must be the FTS scan, got: ${plan.map(p => p.detail).join(' | ')}`);
  });

  it('parseXrefSourcePath covers the three path shapes', () => {
    assert.deepEqual(parseXrefSourcePath('Enum/NoYes?Label'), { object_type: 'Enum', object_name: 'NoYes', element: null, property: 'Label', kind: 'Property' });
    assert.deepEqual(parseXrefSourcePath('Form/CustTable/FormDesign/Grid?Caption'), { object_type: 'Form', object_name: 'CustTable', element: 'Grid', property: 'Caption', kind: 'Property' });
    assert.deepEqual(parseXrefSourcePath('/Tables/CustTable/Methods/validateWrite'), { object_type: 'Table', object_name: 'CustTable', element: 'validateWrite', property: null, kind: 'Code' });
  });
});
