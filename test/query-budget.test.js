/**
 * Tests for the SQLite query budget wrapper (issue #50).
 *
 * better-sqlite3 is synchronous — runWithBudget cannot preempt an in-flight
 * query. The wrapper detects budget overruns AFTER the call returns and
 * converts them into a typed QueryBudgetExceededError, which raw_sql tools
 * surface as a clean "Query timeout" message via timeoutErrorResult().
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  runWithBudget,
  QueryBudgetExceededError,
  timeoutErrorResult,
  QUERY_TIMEOUT_MS,
} from '../src/azure/shared.js';

/** Minimal injectable clock for deterministic tests. */
function fakeClock(values) {
  let i = 0;
  return () => values[i++];
}

describe('runWithBudget (issue #50)', () => {
  it('exports a default budget around 25 s (overridable via env)', () => {
    assert.equal(typeof QUERY_TIMEOUT_MS, 'number');
    assert.ok(QUERY_TIMEOUT_MS > 0);
  });

  it('returns the wrapped function value when within budget', () => {
    const result = runWithBudget(
      'fast-query',
      () => ({ rows: [{ a: 1 }] }),
      1000,
      fakeClock([0, 50]), // 50 ms elapsed
    );
    assert.deepEqual(result, { rows: [{ a: 1 }] });
  });

  it('throws QueryBudgetExceededError when over budget', () => {
    assert.throws(
      () =>
        runWithBudget(
          'slow-query',
          () => ({ rows: [] }),
          100,
          fakeClock([0, 1000]), // 1000 ms elapsed, 100 ms budget
        ),
      (err) => {
        assert.ok(err instanceof QueryBudgetExceededError);
        assert.equal(err.label, 'slow-query');
        assert.equal(err.elapsedMs, 1000);
        assert.equal(err.budgetMs, 100);
        return true;
      },
    );
  });

  it('exactly-at-budget is allowed (boundary)', () => {
    assert.equal(
      runWithBudget('boundary', () => 'ok', 100, fakeClock([0, 100])),
      'ok',
    );
  });

  it('1 ms over budget throws (boundary)', () => {
    assert.throws(
      () => runWithBudget('over', () => 'ok', 100, fakeClock([0, 101])),
      QueryBudgetExceededError,
    );
  });

  it('propagates non-budget errors unchanged (does not wrap)', () => {
    assert.throws(
      () =>
        runWithBudget(
          'sql-error',
          () => {
            throw new Error('SQLITE_ERROR: no such table: foo');
          },
          1000,
        ),
      /SQLITE_ERROR/,
    );
  });
});

describe('timeoutErrorResult (issue #50)', () => {
  it('renders an MCP tool error with the timeout message and structured payload', () => {
    const err = new QueryBudgetExceededError('xref_raw_sql', 30000, 25000);
    const result = timeoutErrorResult(err);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Query timeout/);
    assert.match(result.content[0].text, /try a more specific search/);
    assert.equal(result.structuredContent.error, 'query-timeout');
    assert.equal(result.structuredContent.label, 'xref_raw_sql');
    assert.equal(result.structuredContent.elapsedMs, 30000);
    assert.equal(result.structuredContent.budgetMs, 25000);
  });
});
