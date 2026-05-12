/**
 * Tests for the TOON (Token-Oriented Object Notation) helpers in shared.js.
 *
 * The encoder/decoder pair must be lossless on JSON-primitive cells: any row
 * set round-trips through formatToonBlock → parseToonBlock back to the same
 * stringified data. Quoting rules cover comma, newline, embedded quotes, and
 * leading/trailing whitespace (RFC 4180-ish).
 *
 * Token-savings claim is not asserted here — that is a property of the LLM
 * tokenizer, not this code. We assert correctness; the savings follow.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { formatToonBlock, parseToonBlock } from '../src/azure/shared.js';

describe('formatToonBlock — encoding', () => {
  it('given an empty rows array, when encoded, then returns the canonical "No results found." sentinel', () => {
    assert.equal(formatToonBlock('rows', []), 'No results found.');
  });

  it('given null rows, when encoded, then returns the no-results sentinel (does not throw)', () => {
    assert.equal(formatToonBlock('rows', null), 'No results found.');
  });

  it('given a uniform array, when encoded, then header declares count + columns once', () => {
    const out = formatToonBlock('users', [
      { id: 1, name: 'Alice', role: 'admin' },
      { id: 2, name: 'Bob', role: 'user' },
    ]);
    const lines = out.split('\n');
    assert.equal(lines[0], 'users[2]{id,name,role}:');
    assert.equal(lines[1], '  1,Alice,admin');
    assert.equal(lines[2], '  2,Bob,user');
  });

  it('given an arrayName with disallowed chars, when encoded, then falls back to "rows"', () => {
    const out = formatToonBlock('not a slug!', [{ a: 1 }]);
    assert.match(out, /^rows\[1\]\{a\}:/);
  });

  it('given a value containing comma, when encoded, then the field is double-quoted', () => {
    const out = formatToonBlock('rows', [{ a: 'foo,bar', b: 'plain' }]);
    assert.match(out, /^  "foo,bar",plain$/m);
  });

  it('given a value containing a double quote, when encoded, then the quote is doubled inside double quotes', () => {
    const out = formatToonBlock('rows', [{ a: 'he said "hi"' }]);
    assert.match(out, /^  "he said ""hi"""$/m);
  });

  it('given a value containing a newline, when encoded, then the field is quoted (preserves the newline literally)', () => {
    const out = formatToonBlock('rows', [{ a: 'line1\nline2' }]);
    // The newline inside the quoted field IS a literal newline in output.
    assert.ok(out.includes('"line1\nline2"'));
  });

  it('given a value with leading or trailing whitespace, when encoded, then the field is quoted to preserve it', () => {
    const out = formatToonBlock('rows', [{ a: '  padded  ' }]);
    assert.match(out, /^  "  padded  "$/m);
  });

  it('given null/undefined cells, when encoded, then they render as empty fields (not literal "null")', () => {
    const out = formatToonBlock('rows', [{ a: null, b: undefined, c: 'ok' }]);
    assert.doesNotMatch(out, /\bnull\b/);
    assert.doesNotMatch(out, /\bundefined\b/);
    assert.match(out, /^  ,,ok$/m);
  });

  it('given explicit columns, when encoded, then column order matches the columns argument (not key iteration order)', () => {
    const out = formatToonBlock('rows', [{ b: 2, a: 1, c: 3 }], ['a', 'b', 'c']);
    const lines = out.split('\n');
    assert.equal(lines[0], 'rows[1]{a,b,c}:');
    assert.equal(lines[1], '  1,2,3');
  });
});

describe('parseToonBlock — decoding', () => {
  it('given a well-formed block, when parsed, then arrayName/count/columns/rows are reconstructed', () => {
    const out = formatToonBlock('users', [
      { id: 1, name: 'Alice', role: 'admin' },
      { id: 2, name: 'Bob', role: 'user' },
    ]);
    const parsed = parseToonBlock(out);
    assert.equal(parsed.arrayName, 'users');
    assert.equal(parsed.count, 2);
    assert.deepEqual(parsed.columns, ['id', 'name', 'role']);
    assert.deepEqual(parsed.rows, [
      { id: '1', name: 'Alice', role: 'admin' },
      { id: '2', name: 'Bob', role: 'user' },
    ]);
  });

  it('given a malformed header, when parsed, then throws', () => {
    assert.throws(() => parseToonBlock('not a header'), /malformed header/);
  });

  it('given non-string input, when parsed, then throws', () => {
    assert.throws(() => parseToonBlock(null));
    assert.throws(() => parseToonBlock(42));
  });
});

describe('TOON round-trip parity', () => {
  it('given mixed primitives + tricky strings, when round-tripped, then values stringify identically', () => {
    const rows = [
      { id: 1, label: 'plain', note: '' },
      { id: 2, label: 'has,comma', note: 'has "quote"' },
      { id: 3, label: '  padded  ', note: 'multi\nline' },
      { id: 4, label: 'ok', note: null },
    ];
    const out = formatToonBlock('rows', rows);
    const parsed = parseToonBlock(out);
    // String representation comparison: JS coerces numbers to strings on parse,
    // and nulls round-trip as ''. This mirrors how Markdown tables render too.
    const expected = rows.map(r => ({
      id: String(r.id),
      label: r.label,
      note: r.note == null ? '' : r.note,
    }));
    assert.deepEqual(parsed.rows, expected);
  });
});
