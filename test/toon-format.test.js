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

import { formatToonBlock, parseToonBlock, encodeToon } from '../src/azure/shared.js';

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

describe('encodeToon — general object encoder (default text channel)', () => {
  it('renders scalar fields as key: value lines', () => {
    assert.equal(
      encodeToon({ table_name: 'CustTable', field_count: 2, is_customized: false }),
      'table_name: CustTable\nfield_count: 2\nis_customized: false',
    );
  });

  it('renders a uniform object array as a TOON table block', () => {
    const out = encodeToon({
      role: 'AccountsPayableClerk',
      duties: [
        { duty_id: 'D1', permission: 'Grant' },
        { duty_id: 'D2', permission: 'Deny' },
      ],
    });
    assert.match(out, /^role: AccountsPayableClerk$/m);
    assert.match(out, /^duties\[2\]\{duty_id,permission\}:$/m);
    assert.match(out, /^ {2}D1,Grant$/m);
    assert.match(out, /^ {2}D2,Deny$/m);
  });

  it('renders an array of primitives inline', () => {
    assert.match(encodeToon({ modules: ['ApplicationSuite', 'iExtension'] }),
      /^modules\[2\]: ApplicationSuite,iExtension$/m);
  });

  it('renders an empty array with a [0] marker', () => {
    assert.match(encodeToon({ rows: [] }), /^rows\[0\]:$/m);
  });

  it('renders a nested object under an indented key', () => {
    const out = encodeToon({ summary: { total: 3, kind: 'Call' } });
    assert.match(out, /^summary:$/m);
    assert.match(out, /^ {2}total: 3$/m);
    assert.match(out, /^ {2}kind: Call$/m);
  });

  it('renders a non-uniform / nested array as dash-led blocks', () => {
    const out = encodeToon({
      items: [
        { name: 'a', tags: ['x', 'y'] },
        { name: 'b', tags: [] },
      ],
    });
    assert.match(out, /^items\[2\]:$/m);
    assert.match(out, /^ {2}- name: a$/m);
    assert.match(out, /^ {4}tags\[2\]: x,y$/m);
  });

  it('quotes scalar values containing commas/newlines and keys containing colons', () => {
    const out = encodeToon({ note: 'has,comma', 'odd:key': 1 });
    assert.match(out, /note: "has,comma"/);
    assert.match(out, /"odd:key": 1/);
  });
});
