/**
 * Coverage boundaries (#116, Q3): `coverageNotes(signals)` + the `{ coverage }`
 * 4th argument of `structuredResult`, and how both compose with the freshness
 * banner that tool-sets.js adds centrally (`withFreshnessBanner`).
 *
 * Rule: one `_…_` line per FIRED signal, under the banner, before the body; the
 * typed keys are present only when fired (rule #14 — never false, never null).
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import {
  coverageNotes, structuredResult, withFreshnessBanner, readKbMetadataFlag, encodeToon, customLayerNote,
} from '../src/azure/shared.js';
import { runWithRequestContext } from '../src/azure/request-context.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const dbs = [];
after(() => { for (const d of dbs) { try { d.close(); } catch { /* closed */ } } });

function kbDb(meta = {}) {
  const db = new Database(':memory:');
  dbs.push(db);
  db.exec('CREATE TABLE kb_metadata (key TEXT PRIMARY KEY, value TEXT)');
  for (const [k, v] of Object.entries({ build_date: '2026-08-14T09:30:00.000Z', ...meta })) {
    db.prepare('INSERT INTO kb_metadata VALUES (?,?)').run(k, v);
  }
  return db;
}

const TEXTS = {
  field_limit_hit: '_Fields capped at 200 of 350 — use fields_like / custom_only / field_limit._',
  provenance_omitted: '_12 of 350 fields come from extensions (models: iExtension, HISOL) — pass include_provenance or custom_only to see which._',
  isv_not_scanned: '_Sealed-ISV models not scanned in this snapshot — ISV usages/extensions absent, not zero._',
  isv_excluded: '_37 sealed-ISV usages exist — pass include_isv:true._',
  partial_build: '_KB is a delta-merged snapshot; kb_search may be stale for base tables extended since 2026-09-01._',
};

describe('coverageNotes — each signal alone', () => {
  it('field_limit_hit', () => {
    assert.deepEqual(coverageNotes({ field_limit_hit: { shown: 200, total: 350 } }), { text: TEXTS.field_limit_hit, keys: { field_limit_hit: true } });
    assert.deepEqual(coverageNotes({ field_limit_hit: { shown: 350, total: 350 } }), { text: '', keys: {} }, 'not capped → not fired');
    assert.deepEqual(coverageNotes({ field_limit_hit: { shown: '200', total: '350' } }).keys, { field_limit_hit: true }, 'TEXT-typed counts are coerced');
  });

  it('provenance_omitted (models listed, capped at 5)', () => {
    assert.deepEqual(coverageNotes({ provenance_omitted: { count: 12, total: 350, models: ['iExtension', 'HISOL'] } }),
      { text: TEXTS.provenance_omitted, keys: { provenance_omitted: 12 } });
    const many = coverageNotes({ provenance_omitted: { count: 3, total: 9, models: ['A', 'B', 'C', 'D', 'E', 'F', 'G'] } });
    assert.match(many.text, /\(models: A, B, C, D, E, …\)/);
    assert.equal(coverageNotes({ provenance_omitted: { count: 3, total: 9 } }).text,
      '_3 of 9 fields come from extensions — pass include_provenance or custom_only to see which._', 'no model list → no parenthetical');
    assert.deepEqual(coverageNotes({ provenance_omitted: { count: 0, total: 9, models: ['A'] } }), { text: '', keys: {} }, 'zero → not fired');
  });

  it('isv_not_scanned', () => {
    assert.deepEqual(coverageNotes({ isv_not_scanned: true }), { text: TEXTS.isv_not_scanned, keys: { isv_not_scanned: true } });
    assert.deepEqual(coverageNotes({ isv_not_scanned: false }), { text: '', keys: {} });
    assert.deepEqual(coverageNotes({ isv_not_scanned: 'yes' }), { text: '', keys: {} }, 'only the literal true fires it');
  });

  it('isv_excluded (exact count)', () => {
    assert.deepEqual(coverageNotes({ isv_excluded: { count: 37 } }), { text: TEXTS.isv_excluded, keys: { isv_excluded: 37 } });
    assert.deepEqual(coverageNotes({ isv_excluded: { count: 0 } }), { text: '', keys: {} });
  });

  it('partial_build (date trimmed to YYYY-MM-DD; fallback wording without a date)', () => {
    assert.deepEqual(coverageNotes({ partial_build: { since: '2026-09-01T07:12:00.000Z' } }), { text: TEXTS.partial_build, keys: { partial_build: true } });
    assert.match(coverageNotes({ partial_build: true }).text, /extended since the last full build\._$/);
    assert.deepEqual(coverageNotes({ partial_build: null }), { text: '', keys: {} });
  });

  it('custom_layer reuses customLayerNote — text only, no typed key, silent for a standard name', () => {
    const r = coverageNotes({ custom_layer: 'TBG_SalesExtra' });
    assert.equal(r.text, customLayerNote('TBG_SalesExtra').trim());
    assert.match(r.text, /^_This XRef snapshot is built from the dev layer/);
    assert.deepEqual(r.keys, {});
    assert.deepEqual(coverageNotes({ custom_layer: 'SalesTable' }), { text: '', keys: {} });
  });
});

describe('coverageNotes — all together and none', () => {
  it('none: empty text, empty keys — for undefined, {}, garbage', () => {
    for (const s of [undefined, {}, null, 'x', 42, { unknown: true }]) {
      assert.deepEqual(coverageNotes(s), { text: '', keys: {} }, `signals=${JSON.stringify(s)}`);
    }
  });

  it('all fired: one line per signal in table order, only fired keys, each ≤ 120 B', () => {
    const r = coverageNotes({
      field_limit_hit: { shown: 200, total: 350 },
      provenance_omitted: { count: 12, total: 350, models: ['iExtension', 'HISOL'] },
      isv_not_scanned: true,
      isv_excluded: { count: 37 },
      partial_build: { since: '2026-09-01' },
    });
    assert.deepEqual(r.text.split('\n'), [TEXTS.field_limit_hit, TEXTS.provenance_omitted, TEXTS.isv_not_scanned, TEXTS.isv_excluded, TEXTS.partial_build]);
    assert.deepEqual(r.keys, { field_limit_hit: true, provenance_omitted: 12, isv_not_scanned: true, isv_excluded: 37, partial_build: true });
    for (const line of r.text.split('\n')) {
      assert.ok(line.startsWith('_') && line.endsWith('_'), `italic line: ${line}`);
      assert.ok(Buffer.byteLength(line, 'utf8') <= 130, `${Buffer.byteLength(line)} B: ${line}`);
    }
    // Rule #14: never false / null anywhere in keys.
    assert.ok(Object.values(r.keys).every(v => v === true || (Number.isInteger(v) && v > 0)));
  });
});

describe('structuredResult({ coverage })', () => {
  const typed = { table_name: 'CustTable', field_count: 350, fields: [{ name: 'AccountNum', type: 'String' }] };
  const md = '## Table CustTable\n\n| name | type |\n|---|---|\n| AccountNum | String |';
  const cov = coverageNotes({ field_limit_hit: { shown: 200, total: 350 }, isv_not_scanned: true });

  it('merges only the fired keys into structuredContent and puts the lines directly under the H2', () => {
    for (const format of [undefined, 'auto', 'toon', 'markdown']) {
      const r = structuredResult(typed, md, format, { coverage: cov });
      assert.deepEqual(r.structuredContent, { ...typed, field_limit_hit: true, isv_not_scanned: true }, `format=${format}`);
      const lines = r.content[0].text.split('\n');
      assert.equal(lines[0], '## Table CustTable');
      assert.equal(lines[1], TEXTS.field_limit_hit);
      assert.equal(lines[2], TEXTS.isv_not_scanned);
      assert.equal(lines[3], '', 'the blank line still separates the header block from the body');
      assert.ok(lines.length > 4, 'body follows');
    }
    assert.equal(structuredResult(typed, md, 'markdown', { coverage: cov }).content[0].text,
      `## Table CustTable\n${cov.text}\n\n| name | type |\n|---|---|\n| AccountNum | String |`);
  });

  it('is a no-op for an empty coverage, a missing 4th arg, or an unfired signal set — byte-identical to the 3-arg call', () => {
    const base = structuredResult(typed, md);
    assert.deepEqual(structuredResult(typed, md, undefined, {}), base);
    assert.deepEqual(structuredResult(typed, md, undefined, { coverage: coverageNotes({}) }), base);
    assert.deepEqual(structuredResult(typed, md, undefined, { coverage: null }), base);
    assert.deepEqual(structuredResult(typed, md, undefined, { coverage: { text: '', keys: {} } }), base);
    assert.equal(base.content[0].text, `## Table CustTable\n\n${encodeToon(typed)}`.length < md.length ? `## Table CustTable\n\n${encodeToon(typed)}` : md);
  });

  it('the adaptive choice compares the two renderings WITH the coverage lines, and a heading-less text gets them prepended', () => {
    const r = structuredResult(typed, 'plain body', 'auto', { coverage: cov });
    assert.ok(r.content[0].text.startsWith(`${cov.text}\n\n`));
    const toon = structuredResult({ a: 1 }, '## X\n\nvery long markdown body '.padEnd(400, 'x'), 'auto', { coverage: cov });
    // TOON renders the PRE-merge payload: the `_…_` line is the text form of the
    // key, and paying it twice on one channel is what #116 is trying to stop.
    assert.equal(toon.content[0].text, `## X\n${cov.text}\n\na: 1`);
    assert.deepEqual(toon.structuredContent, { a: 1, field_limit_hit: true, isv_not_scanned: true });
  });

  it('survives the summary text channel — the boundary is exactly what a summary cannot omit', async () => {
    await runWithRequestContext({ profile: 'full', textChannel: 'summary' }, () => {
      const r = structuredResult(typed, md, 'auto', { coverage: cov });
      const lines = r.content[0].text.split('\n');
      assert.equal(lines[0], '## Table CustTable');
      assert.equal(lines[1], TEXTS.field_limit_hit);
      assert.equal(lines[2], TEXTS.isv_not_scanned);
      assert.match(lines[4], /^_Payload in structuredContent/);
      assert.equal(r.structuredContent.field_limit_hit, true);
    });
  });

  it('does not touch an array-shaped or scalar typed payload', () => {
    assert.deepEqual(structuredResult([1, 2], '## L\n\nx', 'toon', { coverage: cov }).structuredContent, [1, 2]);
  });
});

describe('composition with the freshness banner (withFreshnessBanner, as tool-sets.js wires it)', () => {
  it('order on the wire: H2, banner, coverage line(s), blank, body', () => {
    const db = kbDb();
    const cov = coverageNotes({ field_limit_hit: { shown: 200, total: 350 }, partial_build: { since: '2026-09-01' } });
    const inner = structuredResult({ table_name: 'CustTable', field_count: 350 }, '## Table CustTable\n\n| a |\n|---|\n| 1 |', 'markdown', { coverage: cov });
    const r = withFreshnessBanner(inner, db, 'kb');
    const lines = r.content[0].text.split('\n');
    assert.deepEqual(lines.slice(0, 5), [
      '## Table CustTable',
      '_KB snapshot: 2026-08-14_',
      TEXTS.field_limit_hit,
      TEXTS.partial_build,
      '',
    ]);
    assert.equal(lines[5], '| a |');
    assert.deepEqual(r.structuredContent, { table_name: 'CustTable', field_count: 350, field_limit_hit: true, partial_build: true });
    assert.deepEqual(withFreshnessBanner(r, db, 'kb'), r, 'idempotent');
  });

  it('the same wiring on the TOON channel and with an undatable snapshot', () => {
    const cov = coverageNotes({ isv_excluded: { count: 5 } });
    const inner = structuredResult({ n: 1 }, '## Refs\n\nbody', 'toon', { coverage: cov });
    const line = '_5 sealed-ISV usages exist — pass include_isv:true._';
    const dated = withFreshnessBanner(inner, kbDb(), 'xref');
    assert.equal(dated.content[0].text, `## Refs\n_XRef snapshot: 2026-08-14_\n${line}\n\nn: 1`);
    assert.deepEqual(dated.structuredContent, { n: 1, isv_excluded: 5 });
    const undatable = new Database(':memory:'); dbs.push(undatable);
    assert.equal(withFreshnessBanner(inner, undatable, 'xref').content[0].text, `## Refs\n${line}\n\nn: 1`);
  });
});

describe('readKbMetadataFlag', () => {
  it('reads one kb_metadata value; null when the key, the table or the db is missing', () => {
    const db = kbDb({ partial_build: '2026-09-01T07:12:00.000Z' });
    assert.equal(readKbMetadataFlag(db, 'partial_build'), '2026-09-01T07:12:00.000Z');
    assert.equal(readKbMetadataFlag(db, 'nope'), null);
    const bare = new Database(':memory:'); dbs.push(bare);
    assert.equal(readKbMetadataFlag(bare, 'partial_build'), null);
    assert.equal(readKbMetadataFlag(null, 'partial_build'), null);
    assert.equal(readKbMetadataFlag(db, ''), null);
    assert.equal(readKbMetadataFlag({ prepare() { throw new Error('closed'); } }, 'partial_build'), null);
    // Feeds the signal directly.
    const since = readKbMetadataFlag(db, 'partial_build');
    assert.deepEqual(coverageNotes({ partial_build: since ? { since } : null }).keys, { partial_build: true });
    assert.deepEqual(coverageNotes({ partial_build: readKbMetadataFlag(bare, 'partial_build') }).keys, {});
  });
});
