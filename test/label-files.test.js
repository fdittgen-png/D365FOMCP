/**
 * build/label-files.js — label-file discovery + parser shared by the KB builder
 * and the Labels builder (Labels service, docs/Labels-Service-Concept-2026-09-08.md).
 *
 * The description (` ;` line under a label) is the one fact no snapshot carried
 * before this module: the KB parser skipped it. These tests pin the file format
 * as measured on disk 2026-09-08: UTF-8 BOM, CRLF, single-line descriptions
 * attached to the PRECEDING label, `\t;` variant, `=` inside the text.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseLabelFile, labelLines, canonicalLabelId, normalizeLabelIdInput, findLabelFiles, splitLabelFileName,
} from '../build/label-files.js';

const BOM = '﻿';

describe('parseLabelFile', () => {
  it('attaches the description line to the preceding label, tolerates BOM + CRLF', () => {
    const text = BOM + '@SYS1=Time transactions\r\n ;Form caption\r\n@SYS2=Vendor\r\n';
    const { labels, stats } = parseLabelFile(text);
    assert.deepEqual(labels, [
      { key: '@SYS1', text: 'Time transactions', description: 'Form caption' },
      { key: '@SYS2', text: 'Vendor', description: null },
    ]);
    assert.deepEqual(stats, { labels: 2, descriptions: 1, orphan_descriptions: 0, duplicate_keys: 0 });
  });

  it('accepts the tab-comment variant and keeps "=" inside the text', () => {
    const { labels } = parseLabelFile('Foo=a=b\n\t;desc with = sign\n');
    assert.deepEqual(labels, [{ key: 'Foo', text: 'a=b', description: 'desc with = sign' }]);
  });

  it('counts a description before any label as orphan and skips empty values / bad lines', () => {
    const { labels, stats } = parseLabelFile(' ;stray\nEmpty=\n=novalue\nnoequals\nOk=x\n');
    assert.deepEqual(labels, [{ key: 'Ok', text: 'x', description: null }]);
    assert.equal(stats.orphan_descriptions, 1);
    assert.equal(stats.labels, 1);
  });

  it('duplicate key: last one wins and is counted', () => {
    const { labels, stats } = parseLabelFile('A=1\nA=2\n ;second\n');
    assert.deepEqual(labels, [{ key: 'A', text: '2', description: 'second' }]);
    assert.equal(stats.duplicate_keys, 1);
  });

  it('labelLines() keeps the KB contract: [key, value] pairs, comments skipped', () => {
    assert.deepEqual([...labelLines(BOM + 'A=1\r\n ;c\r\nB=2\r\n')], [['A', '1'], ['B', '2']]);
  });
});

describe('label ids', () => {
  it('canonicalLabelId: numeric ids stay, named keys get the file prefix', () => {
    assert.equal(canonicalLabelId('@SYS154828', 'SYS'), '@SYS154828');
    assert.equal(canonicalLabelId('VendMaintain', 'AccountsPayable'), '@AccountsPayable:VendMaintain');
    assert.equal(canonicalLabelId('@AP:Key', 'AccountsPayable'), '@AP:Key');
  });

  it('normalizeLabelIdInput: tolerant on the leading @, null on garbage', () => {
    assert.equal(normalizeLabelIdInput('SYS154828'), '@SYS154828');
    assert.equal(normalizeLabelIdInput('@SYS154828'), '@SYS154828');
    assert.equal(normalizeLabelIdInput('AccountsPayable:VendMaintain'), '@AccountsPayable:VendMaintain');
    assert.equal(normalizeLabelIdInput(' @LAC:Key '), '@LAC:Key');
    assert.equal(normalizeLabelIdInput('Maintain vendor'), null);
    assert.equal(normalizeLabelIdInput(''), null);
    assert.equal(normalizeLabelIdInput(null), null);
  });

  it('splitLabelFileName: prefix + language from the file name', () => {
    assert.deepEqual(splitLabelFileName('SYS.en-us.label.txt'), { prefix: 'SYS', language: 'en-us' });
    assert.deepEqual(splitLabelFileName('HSAPAC.en-US.label.txt'), { prefix: 'HSAPAC', language: 'en-US' });
    assert.equal(splitLabelFileName('readme.txt'), null);
  });
});

describe('findLabelFiles', () => {
  let root;
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'lblfiles-'));
    const res = join(root, 'Pkg', 'Model', 'AxLabelFile', 'LabelResources');
    mkdirSync(join(res, 'en-US'), { recursive: true });
    mkdirSync(join(res, 'de'), { recursive: true });
    writeFileSync(join(res, 'en-US', 'X.en-US.label.txt'), 'A=a\n');
    writeFileSync(join(res, 'de', 'X.de.label.txt'), 'A=b\n');
    writeFileSync(join(res, 'de', 'notes.txt'), 'ignored');
    // bin/ copies must be skipped
    mkdirSync(join(root, 'Pkg', 'bin', 'LabelResources', 'fr'), { recursive: true });
    writeFileSync(join(root, 'Pkg', 'bin', 'LabelResources', 'fr', 'X.fr.label.txt'), 'A=c\n');
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it('returns path, language (folder) and prefix, skipping bin/', () => {
    const files = findLabelFiles(root).sort((a, b) => a.language.localeCompare(b.language));
    assert.deepEqual(files.map(f => ({ language: f.language, prefix: f.prefix, module: f.module })), [
      { language: 'de', prefix: 'X', module: 'Model' },
      { language: 'en-US', prefix: 'X', module: 'Model' },
    ]);
    assert.ok(files.every(f => f.path.endsWith('.label.txt')));
  });

  it('returns [] for a missing root', () => {
    assert.deepEqual(findLabelFiles(join(root, 'nope')), []);
  });
});
