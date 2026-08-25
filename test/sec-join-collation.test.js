/**
 * Every JOIN predicate in sec-tools.js written as `a.col = b.col COLLATE NOCASE`
 * must be backed by a NOCASE-collated index on at least one side, otherwise
 * SQLite cannot use any index for the join and falls back to a nested-loop
 * scan. That is what made sec_object_access take >90 s for common objects
 * (41k entry points × 27k duty_privileges) and, because better-sqlite3 is
 * synchronous, wedged the whole stdio server for every later call
 * (2026-08-25 skill-eval incident).
 *
 * The check is static: it parses the SQL text in sec-tools.js, resolves
 * aliases to tables from FROM/JOIN clauses, and looks the (table, column)
 * pairs up in src/azure/sec-indexes.js — the shared index list used by the
 * migration script and by the Azure self-healing path — and in src/azure/sec-builder.js — the fresh-build schema.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(__dirname, '..', p), 'utf8');

const TABLES = new Set([
  'roles', 'duties', 'privileges', 'users', 'role_duties', 'duty_privileges', 'privilege_entry_points',
  'role_direct_privileges', 'role_direct_entity_permissions', 'user_roles', 'user_role_companies',
  'role_subroles', 'sec_search',
]);

function nocaseIndexPairs(src) {
  const pairs = new Set();
  for (const m of src.matchAll(/CREATE INDEX IF NOT EXISTS \w+\s+ON\s+(\w+)\s*\(\s*(\w+)\s+COLLATE NOCASE/gi)) {
    pairs.add(`${m[1].toLowerCase()}.${m[2].toLowerCase()}`);
  }
  return pairs;
}

function joinPredicates(sql) {
  // alias → table, from every "FROM|JOIN <table> <alias>" occurrence
  const alias = new Map();
  for (const m of sql.matchAll(/\b(?:FROM|JOIN)\s+(\w+)\s+(?:AS\s+)?(\w+)\b/gi)) {
    if (TABLES.has(m[1].toLowerCase()) && !/^(ON|WHERE|JOIN|LEFT|INNER|CROSS|USING|SET|AS)$/i.test(m[2])) {
      alias.set(m[2], m[1].toLowerCase());
    }
  }
  const preds = [];
  for (const m of sql.matchAll(/JOIN[^\n]*?\bON\s+(\w+)\.(\w+)\s*=\s*(\w+)\.(\w+)\s+COLLATE NOCASE/gi)) {
    const sides = [[m[1], m[2]], [m[3], m[4]]]
      .map(([a, c]) => alias.has(a) ? `${alias.get(a)}.${c.toLowerCase()}` : null);
    preds.push({ text: m[0].trim(), sides });
  }
  return preds;
}

describe('sec-tools.js NOCASE join predicates are index-backed', () => {
  const tools = read('src/azure/sec-tools.js');
  const preds = joinPredicates(tools);

  it('finds the known NOCASE join predicates (sanity: parser is not silently matching nothing)', () => {
    assert.ok(preds.length >= 8, `expected ≥8 NOCASE joins, found ${preds.length}`);
  });

  for (const file of ['src/azure/sec-indexes.js', 'src/azure/sec-builder.js']) {
    const idx = nocaseIndexPairs(read(file));
    for (const p of preds) {
      const real = p.sides.filter(Boolean);
      if (!real.length) continue; // both sides are CTEs (e.g. recursive rt) — planner handles small CTEs
      it(`${file}: "${p.text.slice(0, 80)}"`, () => {
        assert.ok(
          real.some(s => idx.has(s)),
          `no NOCASE index on ${real.join(' or ')} — add one to ${file} (see idx_*_nocase block)`,
        );
      });
    }
  }

  it('add-sec-indexes.sql mirrors sec-indexes.js', () => {
    const js = nocaseIndexPairs(read('src/azure/sec-indexes.js'));
    const sql = nocaseIndexPairs(read('build/add-sec-indexes.sql'));
    for (const p of js) assert.ok(sql.has(p), `${p} missing from add-sec-indexes.sql`);
  });
});
