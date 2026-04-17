/**
 * Tests for src/azure/wiki-search.js — pure function, no I/O.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { searchPages, tokenize } from '../src/azure/wiki-search.js';

function page(slug, title, body, fm = {}) {
  return { slug, title, body, frontmatter: fm, content: body };
}

describe('tokenize', () => {
  it('splits on whitespace', () => {
    assert.deepEqual(tokenize('foo bar baz'), ['foo', 'bar', 'baz']);
  });
  it('drops surrounding quotes', () => {
    assert.deepEqual(tokenize('"exact" `phrase`'), ['exact', 'phrase']);
  });
  it('returns empty for empty / non-string', () => {
    assert.deepEqual(tokenize(''), []);
    assert.deepEqual(tokenize(null), []);
    assert.deepEqual(tokenize(undefined), []);
  });
});

describe('searchPages', () => {
  const pages = [
    page('1001', 'Sales order post fails with NumberSeq error',
      'When posting a sales order the system throws "Number sequence is not set up". '
      + 'Navigate to Sales and marketing parameters to assign a new reference.',
      { tags: ['sales', 'numbersequence', 'posting'] }),
    page('1002', 'Inventory adjustment fails on financial dim',
      'Error: financial dimensions are invalid during inventory posting. Check legal entity setup.',
      { tags: ['inventory', 'financial-dimension'] }),
    page('1003', 'Print management issue on customer invoice',
      'Customer invoice template not rendering due to missing print settings.',
      { tags: ['print', 'customer'] }),
  ];

  it('returns empty when query is empty', () => {
    assert.deepEqual(searchPages(pages, ''), []);
  });

  it('ranks a page that matches title highest', () => {
    const res = searchPages(pages, 'NumberSeq');
    assert.equal(res.length, 1);
    assert.equal(res[0].slug, '1001');
    assert.ok(res[0].score > 0);
  });

  it('matches against frontmatter tags', () => {
    const res = searchPages(pages, 'financial-dimension');
    assert.equal(res.length, 1);
    assert.equal(res[0].slug, '1002');
  });

  it('multi-term coverage bonus promotes pages hitting every term', () => {
    const multi = searchPages(pages, 'sales posting');
    assert.equal(multi[0].slug, '1001');
    // The coverage bonus means 1001 must outrank any page that only matches one term.
  });

  it('returns snippets around body matches', () => {
    const res = searchPages(pages, 'financial');
    assert.ok(res[0].snippets.length > 0);
    assert.match(res[0].snippets[0], /financial/i);
  });

  it('honors the limit', () => {
    const res = searchPages(pages, 'error', { limit: 1 });
    assert.equal(res.length, 1);
  });

  it('returns zero results when no page contains the term', () => {
    assert.deepEqual(searchPages(pages, 'quantumentanglement'), []);
  });
});
