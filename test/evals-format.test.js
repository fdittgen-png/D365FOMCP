/**
 * evals/ format contract (W6.3, #110).
 *
 * The eval files are consumed by two very different readers — the mcp-builder
 * LLM harness (XML only) and scripts/run-evals.mjs (XML + calls + budget) — so
 * their shape is asserted here without starting a server or touching a database:
 *
 *   - evals/<service>.xml parses and holds exactly 10 <qa_pair>s, each with a
 *     non-empty question and a single-line answer;
 *   - evals/<service>.calls.json has one entry per pair, every call names a tool
 *     the service really registers (serviceToolNames from tool-sets.js), and
 *     every expr is a non-empty string that at least parses as a JS expression;
 *   - evals/<service>.budget.json budgets at least 3 pairs, each with a registered
 *     expected_tools sequence and a positive byte ceiling;
 *   - privacy: no e-mail address anywhere under evals/, and the Sec set never
 *     calls a user-centred tool or asks for user lists.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { XMLParser } from 'fast-xml-parser';
import { serviceToolNames } from '../src/azure/tool-sets.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const ROOT = join(import.meta.dirname, '..');
const EVALS = join(ROOT, 'evals');
const SERVICES = ['kb', 'xref', 'sec', 'taskrecorder'];
const PAIRS_PER_SERVICE = 10;
const MIN_BUDGETED = 3;

// Tool names that centre on people rather than on the security model. The eval
// set is about roles/duties/privileges/entry points only (privacy rule).
const USER_TOOLS = ['sec_lookup_user', 'sec_find_users_by_role', 'sec_company_users', 'sec_licence_assessment', 'sec_what_if'];

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

function readJson(p) { return JSON.parse(readFileSync(p, 'utf8')); }

function parsePairs(xmlText) {
  const parser = new XMLParser({ ignoreAttributes: false, trimValues: true, parseTagValue: false });
  const doc = parser.parse(xmlText);
  assert.ok(doc?.evaluation, 'root element must be <evaluation>');
  const raw = doc.evaluation.qa_pair;
  return Array.isArray(raw) ? raw : raw ? [raw] : [];
}

// One dry-run registration per service; the schemas probe the db, the names do not.
const memDb = new Database(':memory:');
const registered = Object.fromEntries(SERVICES.map(s => [s, new Set(serviceToolNames(s, memDb))]));

for (const svc of SERVICES) {
  const xmlPath = join(EVALS, `${svc}.xml`);
  const callsPath = join(EVALS, `${svc}.calls.json`);
  const budgetPath = join(EVALS, `${svc}.budget.json`);
  const answersPath = join(EVALS, `${svc}.answers.md`);

  test(`evals/${svc}.xml — mcp-builder format, ${PAIRS_PER_SERVICE} pairs`, () => {
    assert.ok(existsSync(xmlPath), `${xmlPath} missing`);
    const pairs = parsePairs(readFileSync(xmlPath, 'utf8'));
    assert.equal(pairs.length, PAIRS_PER_SERVICE);
    pairs.forEach((p, i) => {
      assert.ok(typeof p.question === 'string' && p.question.trim().length >= 40, `pair ${i + 1}: question too short`);
      assert.ok(typeof p.answer === 'string' && p.answer.trim().length > 0, `pair ${i + 1}: empty answer`);
      assert.ok(!/\n/.test(p.answer.trim()), `pair ${i + 1}: answer must be a single line`);
    });
  });

  test(`evals/${svc}.calls.json — every call names a registered ${svc} tool`, () => {
    assert.ok(existsSync(callsPath), `${callsPath} missing`);
    const calls = readJson(callsPath);
    assert.equal(calls.service, svc);
    assert.ok(Array.isArray(calls.pairs) && calls.pairs.length === PAIRS_PER_SERVICE, 'one calls entry per <qa_pair>');
    const ids = new Set();
    for (const p of calls.pairs) {
      assert.ok(Number.isInteger(p.id) && p.id >= 1 && p.id <= PAIRS_PER_SERVICE, `bad id ${p.id}`);
      assert.ok(!ids.has(p.id), `duplicate id ${p.id}`);
      ids.add(p.id);
      assert.ok(typeof p.title === 'string' && p.title.trim(), `pair ${p.id}: title`);
      assert.ok(Array.isArray(p.calls) && p.calls.length >= 2, `pair ${p.id}: an eval question needs at least two tool calls`);
      for (const c of p.calls) {
        assert.ok(registered[svc].has(c.tool), `pair ${p.id}: "${c.tool}" is not a tool the ${svc} server registers`);
        assert.ok(c.arguments && typeof c.arguments === 'object' && !Array.isArray(c.arguments), `pair ${p.id}: arguments must be an object`);
      }
      assert.ok(typeof p.expr === 'string' && p.expr.trim(), `pair ${p.id}: expr`);
      // Must at least parse — a syntax error here would only surface at replay time.
      // eslint-disable-next-line no-new-func
      assert.doesNotThrow(() => new Function('r', 'text', `"use strict"; return (${p.expr});`), `pair ${p.id}: expr does not parse`);
    }
  });

  test(`evals/${svc}.budget.json — token-discipline dimension on ≥${MIN_BUDGETED} pairs`, () => {
    assert.ok(existsSync(budgetPath), `${budgetPath} missing`);
    const budget = readJson(budgetPath);
    const calls = readJson(callsPath);
    const entries = Object.entries(budget.pairs ?? {});
    assert.ok(entries.length >= MIN_BUDGETED, `at least ${MIN_BUDGETED} budgeted pairs`);
    for (const [id, b] of entries) {
      const spec = calls.pairs.find(p => String(p.id) === id);
      assert.ok(spec, `budget names pair ${id}, which calls.json does not have`);
      assert.ok(Array.isArray(b.expected_tools) && b.expected_tools.length >= 2, `pair ${id}: expected_tools`);
      for (const t of b.expected_tools) assert.ok(registered[svc].has(t), `pair ${id}: expected tool "${t}" is not registered`);
      assert.deepEqual(spec.calls.map(c => c.tool), b.expected_tools, `pair ${id}: recorded calls must follow the expected sequence`);
      assert.ok(Number.isInteger(b.max_structured_bytes) && b.max_structured_bytes > 0, `pair ${id}: max_structured_bytes`);
      assert.ok(Number.isInteger(b.measured_bytes) && b.measured_bytes > 0, `pair ${id}: measured_bytes`);
      assert.ok(b.max_structured_bytes >= b.measured_bytes, `pair ${id}: ceiling below the measurement`);
      assert.ok(typeof b.lever === 'string' && b.lever.trim(), `pair ${id}: say which discipline lever the budget rewards`);
    }
  });

  test(`evals/${svc}.answers.md — records the calls behind every answer`, () => {
    assert.ok(existsSync(answersPath), `${answersPath} missing`);
    const md = readFileSync(answersPath, 'utf8');
    const calls = readJson(callsPath);
    for (const p of calls.pairs) {
      for (const c of p.calls) assert.ok(md.includes(c.tool), `${svc}.answers.md never mentions ${c.tool} (pair ${p.id})`);
    }
  });
}

test('evals/ — privacy: no e-mail address, no user-centred Sec tool', () => {
  for (const f of readdirSync(EVALS)) {
    const text = readFileSync(join(EVALS, f), 'utf8');
    assert.ok(!EMAIL_RE.test(text), `${f} contains an e-mail address`);
  }
  const secCalls = readJson(join(EVALS, 'sec.calls.json'));
  for (const p of secCalls.pairs) {
    for (const c of p.calls) assert.ok(!USER_TOOLS.includes(c.tool), `sec pair ${p.id} calls user tool ${c.tool}`);
  }
  const secBudget = readJson(join(EVALS, 'sec.budget.json'));
  for (const b of Object.values(secBudget.pairs)) {
    for (const t of b.expected_tools) assert.ok(!USER_TOOLS.includes(t), `sec budget expects user tool ${t}`);
  }
  const secXml = readFileSync(join(EVALS, 'sec.xml'), 'utf8');
  assert.ok(!/\buser(s)?\b/i.test(parsePairs(secXml).map(p => p.question + ' ' + p.answer).join('\n')),
    'sec questions are about roles/duties/privileges/entry points — never users');
});

test('evals/ — every service has the four files and nothing else is stray', () => {
  const expected = new Set(['README.md']);
  for (const s of SERVICES) for (const ext of ['xml', 'calls.json', 'budget.json', 'answers.md']) expected.add(`${s}.${ext}`);
  const actual = readdirSync(EVALS).filter(f => !f.startsWith('.'));
  for (const f of expected) assert.ok(actual.includes(f), `missing evals/${f}`);
  for (const f of actual) assert.ok(expected.has(f), `unexpected file evals/${f} — add it to the contract or move it`);
});
