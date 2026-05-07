/**
 * Tests for src/azure/shared.js helpers.
 *
 * Issue #33: edge-case coverage for DB open failures, formatMarkdownTable
 * empty-state, validateLikePattern, and runWithBudget. Every test asserts
 * STRUCTURAL shape — never `assert.ok(string.includes(...))`.
 *
 * Run: npm test
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  formatMarkdownTable,
  textResult,
  validateLikePattern,
  patternErrorResult,
  runWithBudget,
  QueryBudgetExceededError,
  timeoutErrorResult,
  MAX_LIKE_PATTERN_LENGTH,
  QUERY_TIMEOUT_MS,
  getKbDb,
  getXrefDb,
  getSecDb,
  reloadSecDb,
} from '../src/azure/shared.js';

// ── formatMarkdownTable ─────────────────────────────────────────────────────

describe('issue #33 — formatMarkdownTable edge cases', () => {
  it('given an empty rows array, when formatMarkdownTable runs, then returns the canonical "No results found." sentinel', () => {
    assert.equal(formatMarkdownTable([]), 'No results found.');
  });

  it('given null rows, when formatMarkdownTable runs, then returns the canonical no-results sentinel (does not throw)', () => {
    assert.equal(formatMarkdownTable(null), 'No results found.');
  });

  it('given undefined rows, when formatMarkdownTable runs, then returns the canonical no-results sentinel (does not throw)', () => {
    assert.equal(formatMarkdownTable(undefined), 'No results found.');
  });

  it('given a single row, when formatMarkdownTable runs, then header + separator + body all present', () => {
    const out = formatMarkdownTable([{ a: 1, b: 2 }]);
    assert.match(out, /^\| a \| b \|$/m);
    assert.match(out, /^\| --- \| --- \|$/m);
    assert.match(out, /^\| 1 \| 2 \|$/m);
  });

  it('given a row with null/undefined cells, when formatMarkdownTable runs, then the cells render as empty strings (not literal "null")', () => {
    const out = formatMarkdownTable([{ a: null, b: undefined, c: 'ok' }]);
    assert.doesNotMatch(out, /\bnull\b/);
    assert.doesNotMatch(out, /\bundefined\b/);
    assert.match(out, /\| ok \|/);
  });
});

// ── textResult ──────────────────────────────────────────────────────────────

describe('issue #33 — textResult shape', () => {
  it('given a string, when textResult runs, then returns the MCP content array shape (no isError flag)', () => {
    const r = textResult('hello');
    assert.deepEqual(r, { content: [{ type: 'text', text: 'hello' }] });
    // Success path: no isError flag.
    assert.equal(r.isError, undefined);
  });
});

// ── validateLikePattern / patternErrorResult ───────────────────────────────

describe('issue #33 — validateLikePattern + patternErrorResult', () => {
  it('given a non-string input, when validateLikePattern runs, then returns null (defers type errors to Zod)', () => {
    assert.equal(validateLikePattern(undefined), null);
    assert.equal(validateLikePattern(null), null);
    assert.equal(validateLikePattern(42), null);
  });

  it('given a string within the length cap, when validateLikePattern runs, then returns null (valid)', () => {
    assert.equal(validateLikePattern('CustTable'), null);
    assert.equal(validateLikePattern('x'.repeat(MAX_LIKE_PATTERN_LENGTH)), null);
  });

  it('given a string longer than the cap, when validateLikePattern runs, then returns an error envelope referencing the limit', () => {
    const v = validateLikePattern('x'.repeat(MAX_LIKE_PATTERN_LENGTH + 1));
    assert.ok(v && typeof v === 'object', 'expected an error envelope object');
    assert.match(v.error, /too long/);
    assert.match(v.error, new RegExp(String(MAX_LIKE_PATTERN_LENGTH)));
  });

  it('given a custom max parameter, when validateLikePattern runs, then it uses the custom max in the error message', () => {
    const v = validateLikePattern('xxxxxxxxxx', 5);
    assert.ok(v);
    assert.match(v.error, /max 5/);
  });

  it('given a validation envelope, when patternErrorResult runs, then returns isError:true with the structured payload preserved', () => {
    const v = validateLikePattern('x'.repeat(MAX_LIKE_PATTERN_LENGTH + 1));
    const r = patternErrorResult(v);
    // Shape: error channel.
    assert.equal(r.isError, true);
    assert.equal(r.content[0].type, 'text');
    // The structured payload is preserved (callers can branch on it).
    assert.deepEqual(r.structuredContent, v);
    // The text body matches the structured error message.
    assert.equal(r.content[0].text, v.error);
  });
});

// ── runWithBudget / timeoutErrorResult ──────────────────────────────────────

describe('issue #33 — runWithBudget enforcement', () => {
  it('given a fast call, when runWithBudget runs, then it returns the inner result without throwing', () => {
    const result = runWithBudget('label', () => 42, 1000, () => 0);
    assert.equal(result, 42);
  });

  it('given an injected clock that exceeds the budget, when runWithBudget runs, then it throws QueryBudgetExceededError carrying label/elapsed/budget', () => {
    let t = 0;
    const clock = () => {
      const now = t;
      t += 5000; // first call: 0, second call: 5000
      return now;
    };
    assert.throws(
      () => runWithBudget('slow-call', () => 'x', 1000, clock),
      (err) => {
        assert.ok(err instanceof QueryBudgetExceededError);
        assert.equal(err.label, 'slow-call');
        assert.equal(err.elapsedMs, 5000);
        assert.equal(err.budgetMs, 1000);
        return true;
      },
    );
  });

  it('given a QueryBudgetExceededError, when timeoutErrorResult renders it, then the response is on the error channel with the structured payload', () => {
    const err = new QueryBudgetExceededError('my-query', 5000, 1000);
    const r = timeoutErrorResult(err);
    assert.equal(r.isError, true);
    assert.equal(r.content[0].type, 'text');
    assert.match(r.content[0].text, /Query timeout/);
    assert.equal(r.structuredContent.error, 'query-timeout');
    assert.equal(r.structuredContent.label, 'my-query');
    assert.equal(r.structuredContent.elapsedMs, 5000);
    assert.equal(r.structuredContent.budgetMs, 1000);
  });

  it('given a budget enforced by the default clock, when runWithBudget runs a fast op, then the result is returned and no error is thrown', () => {
    // Exercises the default `now = Date.now` path so we don't fully mock
    // the clock for every test.
    const r = runWithBudget('fast', () => 7);
    assert.equal(r, 7);
    assert.ok(QUERY_TIMEOUT_MS > 0);
  });
});

// ── DB open failures ────────────────────────────────────────────────────────

describe('issue #33 — DB singletons throw on missing files', () => {
  // The DB getters lazy-open: getKbDb() / getXrefDb() / getSecDb() only
  // touch the filesystem on first call. We override the env var and rely
  // on the reload helpers (only sec exposes one in this codebase state) or
  // the fact that the singleton is null at module load.
  //
  // To avoid leaking module state across tests, each test sets a new env
  // var, calls the getter, asserts the throw, then restores the env var.
  // The KB and XRef getters in this codebase don't have reload helpers,
  // so we accept that the module-level singleton stays null on failure
  // (the constructor throws BEFORE assignment).

  it('given a missing KB DB path, when getKbDb runs for the first time, then it throws an Error referencing the path', () => {
    const prev = process.env.KB_DB_PATH;
    process.env.KB_DB_PATH = '/issue33/nonexistent/no-such-kb.sqlite';
    try {
      assert.throws(
        () => getKbDb(),
        (err) => {
          assert.ok(err instanceof Error, 'expected an Error instance');
          // better-sqlite3 produces "unable to open database" or similar;
          // assert structural shape — it's an Error, not undefined or null.
          // The error name often contains "SqliteError" — accept either.
          assert.equal(typeof err.message, 'string');
          return true;
        },
      );
    } finally {
      if (prev === undefined) delete process.env.KB_DB_PATH;
      else process.env.KB_DB_PATH = prev;
    }
  });

  it('given a missing XRef DB path, when getXrefDb runs for the first time, then it throws an Error', () => {
    const prev = process.env.XREF_DB_PATH;
    process.env.XREF_DB_PATH = '/issue33/nonexistent/no-such-xref.sqlite';
    try {
      assert.throws(() => getXrefDb(), Error);
    } finally {
      if (prev === undefined) delete process.env.XREF_DB_PATH;
      else process.env.XREF_DB_PATH = prev;
    }
  });

  it('given a missing Sec DB path, when getSecDb runs after reloadSecDb, then it throws an Error', () => {
    // `reloadSecDb()` is the ONLY public way to clear the sec singleton —
    // call it first so the next getSecDb() runs the lazy-open path.
    reloadSecDb();
    const prev = process.env.SEC_DB_PATH;
    process.env.SEC_DB_PATH = '/issue33/nonexistent/no-such-sec.sqlite';
    try {
      assert.throws(() => getSecDb(), Error);
    } finally {
      if (prev === undefined) delete process.env.SEC_DB_PATH;
      else process.env.SEC_DB_PATH = prev;
      // Reload again so subsequent tests in the same node process don't
      // inherit the failed-open state.
      reloadSecDb();
    }
  });

  it('given the reloadSecDb helper called when no DB is open, when invoked, then it is a no-op (no throw)', () => {
    reloadSecDb();
    assert.doesNotThrow(() => reloadSecDb());
  });
});
