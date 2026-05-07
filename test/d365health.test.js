/**
 * Tests for /api/health response builders (issue #35).
 *
 * Pure-function unit tests — no real database, no fs access. The handler
 * itself is integration-tested by hitting the Function App locally; here we
 * cover the response shape and the failure modes.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  readBuildDate,
  readRecordCount,
  safeStat,
  inspectDatabase,
  buildHealthReport,
} from '../src/functions/d365health.js';

// ── readBuildDate ────────────────────────────────────────────────────────────

describe('readBuildDate (issue #35)', () => {
  it('returns the value from a sec_metadata-shaped query', () => {
    const runQuery = (sql, _params) => {
      assert.match(sql, /SELECT value FROM sec_metadata/);
      return [{ value: '2026-04-17T12:00:00Z' }];
    };
    assert.equal(readBuildDate(runQuery, 'sec_metadata'), '2026-04-17T12:00:00Z');
  });

  it('returns null when no row matches', () => {
    assert.equal(readBuildDate(() => [], 'kb_metadata'), null);
  });

  it('returns null when the query throws (DB missing / locked)', () => {
    const runQuery = () => { throw new Error('no such table'); };
    assert.equal(readBuildDate(runQuery, 'xref_metadata'), null);
  });
});

// ── readRecordCount ──────────────────────────────────────────────────────────

describe('readRecordCount (issue #35)', () => {
  it('picks the first numeric metadata value among the candidate keys', () => {
    const rows = { roles: '1500', privileges: '8200', records: '' };
    const runQuery = (sql, params) => {
      const k = params[0];
      return rows[k] != null ? [{ value: rows[k] }] : [];
    };
    assert.equal(readRecordCount(runQuery, 'sec_metadata', ['records', 'roles', 'privileges']), 1500);
  });

  it('skips empty/missing entries and returns the next candidate', () => {
    const runQuery = (sql, params) => {
      if (params[0] === 'a') return [];
      if (params[0] === 'b') return [{ value: '' }];
      if (params[0] === 'c') return [{ value: '42' }];
      return [];
    };
    assert.equal(readRecordCount(runQuery, 't', ['a', 'b', 'c']), 42);
  });

  it('returns null when no candidate yields a finite number', () => {
    const runQuery = () => [{ value: 'not-a-number' }];
    assert.equal(readRecordCount(runQuery, 't', ['x']), null);
  });

  it('NEVER issues a COUNT(*) query (privacy / perf — xref has > 100M rows)', () => {
    const sqls = [];
    const runQuery = (sql, _params) => { sqls.push(sql); return []; };
    readRecordCount(runQuery, 'xref_metadata', ['records']);
    for (const s of sqls) {
      assert.ok(!/COUNT\s*\(/i.test(s), 'must not run COUNT(*) queries: ' + s);
    }
  });
});

// ── safeStat ─────────────────────────────────────────────────────────────────

describe('safeStat (issue #35)', () => {
  it('returns size and mtime when the file exists', () => {
    const fakeStat = () => ({ size: 1234, mtimeMs: Date.UTC(2026, 3, 17, 12) });
    const r = safeStat(fakeStat, 'doesntmatter');
    assert.equal(r?.size_bytes, 1234);
    assert.equal(r?.mtime_iso, new Date(Date.UTC(2026, 3, 17, 12)).toISOString());
  });

  it('returns null when stat throws', () => {
    const fakeStat = () => { throw new Error('ENOENT'); };
    assert.equal(safeStat(fakeStat, 'missing.sqlite'), null);
  });

  it('does not return the file path (never leak paths to callers)', () => {
    const fakeStat = () => ({ size: 1, mtimeMs: 0 });
    const r = safeStat(fakeStat, '/secret/path/db.sqlite');
    assert.ok(r != null);
    for (const v of Object.values(r)) {
      assert.ok(typeof v !== 'string' || !v.includes('/secret'),
        'safeStat must not leak filesystem paths');
    }
  });
});

// ── inspectDatabase ──────────────────────────────────────────────────────────

describe('inspectDatabase (issue #35)', () => {
  function makeFakeDb(metadata) {
    return {
      prepare: (sql) => ({
        all: (..._args) => {
          // Naïve match — works because tests pass plain {key,value} maps
          const keyMatch = sql.match(/key = '(\w+)'/);
          if (keyMatch && metadata[keyMatch[1]] !== undefined) {
            return [{ value: metadata[keyMatch[1]] }];
          }
          return [];
        },
      }),
    };
  }

  it('returns a populated entry when DB and stats are available', () => {
    const db = {};
    const fakeQuery = (sql, params) => {
      if (/build_date/.test(sql)) return [{ value: '2026-04-01T00:00:00Z' }];
      if (params?.[0] === 'roles') return [{ value: '1234' }];
      return [];
    };
    // We can't inject `query` directly — test exercises the structure that
    // inspectDatabase produces using the real `query` against a fake `prepare`.
    const fakeDb = {
      prepare: (sql) => ({
        all: (...params) => fakeQuery(sql, params),
      }),
    };
    const fakeStat = () => ({ size: 999, mtimeMs: Date.UTC(2026, 0, 1) });
    const entry = inspectDatabase({
      name: 'sec',
      dbPath: '/anywhere',
      getDb: () => fakeDb,
      statFn: fakeStat,
    });
    assert.equal(entry.name, 'sec');
    assert.equal(entry.healthy, true);
    assert.equal(entry.size_bytes, 999);
    assert.equal(entry.last_modified, '2026-04-01T00:00:00Z');
    assert.equal(entry.record_count, 1234);
    assert.equal(entry.note, undefined);
  });

  it('marks as unhealthy when the DB cannot be opened', () => {
    const fakeStat = () => ({ size: 1, mtimeMs: 0 });
    const entry = inspectDatabase({
      name: 'kb',
      dbPath: '/x',
      getDb: () => { throw new Error('cannot open'); },
      statFn: fakeStat,
    });
    assert.equal(entry.healthy, false);
    assert.equal(entry.name, 'kb');
    assert.equal(entry.size_bytes, 1);
    assert.equal(entry.record_count, null);
    assert.match(entry.note || '', /not available/i);
  });

  it('does not include any "path" / "dbPath" key in the entry', () => {
    const entry = inspectDatabase({
      name: 'xref',
      dbPath: '/secret/xref.sqlite',
      getDb: () => { throw new Error('x'); },
      statFn: () => { throw new Error('x'); },
    });
    assert.ok(!('path' in entry));
    assert.ok(!('dbPath' in entry));
    for (const v of Object.values(entry)) {
      assert.ok(typeof v !== 'string' || !v.includes('/secret'),
        'entry must not leak filesystem paths');
    }
  });
});

// ── buildHealthReport ────────────────────────────────────────────────────────

describe('buildHealthReport (issue #35)', () => {
  it('returns server_time + databases[3] in a stable order', () => {
    const fakeGetDb = () => { throw new Error('no db'); };
    const fakeStat = () => { throw new Error('no file'); };
    const r = buildHealthReport({
      env: { KB_DB_PATH: '/k', XREF_DB_PATH: '/x', SEC_DB_PATH: '/s' },
      getDbs: { kb: fakeGetDb, xref: fakeGetDb, sec: fakeGetDb },
      statFn: fakeStat,
      now: () => new Date('2026-05-07T12:34:56Z'),
    });
    assert.equal(r.server_time, '2026-05-07T12:34:56.000Z');
    assert.equal(r.databases.length, 3);
    assert.deepEqual(r.databases.map(d => d.name), ['kb', 'xref', 'sec']);
    for (const d of r.databases) {
      assert.equal(d.healthy, false);
      assert.match(d.note, /not available/i);
    }
  });
});
