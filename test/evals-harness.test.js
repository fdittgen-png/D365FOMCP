/**
 * LLM eval harness — pure parts (issue #119). No network, no server, no DB:
 *
 *   - answer normaliser / matcher (cases from the mcp-builder guide);
 *   - discipline derivation from a fake tools list + a fake call log;
 *   - --compare thresholds;
 *   - one full tool-use loop with a mocked Anthropic client (injected) and a
 *     mocked MCP client, including an isError tool result fed back;
 *   - the results-file shape (names + arg KEYS only — no payloads).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { answersMatch, normalizeLlmAnswer } from '../scripts/evals/answer-match.mjs';
import { toolLevers, callLevers, indexToolLevers, disciplineRate, median, serviceMetrics } from '../scripts/evals/discipline.mjs';
import { compareResults, PASS_RATE_DROP_POINTS, BYTES_RISE_RATIO } from '../scripts/evals/compare.mjs';
import { runQuestionLlm, toAnthropicTools, buildSystemPrompt, estimateCostUsd } from '../scripts/evals/llm-runner.mjs';
import { toResultsFile, writeResults, latestResultsFile, parseQuestionFilter, loadDotEnv } from '../scripts/run-evals.mjs';

/* ── answer matching ──────────────────────────────────────────────────────── */

test('normaliser: trim, case-fold, whitespace, wrappers, trailing punctuation', () => {
  assert.equal(normalizeLlmAnswer('  CustAccount.  '), 'custaccount');
  assert.equal(normalizeLlmAnswer('**3**'), '3');
  assert.equal(normalizeLlmAnswer('`CustTable.CustGroup`'), 'custtable.custgroup');
  assert.equal(normalizeLlmAnswer('"Microsoft   Corporation"'), 'microsoft corporation');
  assert.equal(normalizeLlmAnswer('True!'), 'true');
  assert.equal(normalizeLlmAnswer(null), '');
  assert.equal(normalizeLlmAnswer(74), '74');
});

test('answersMatch: guide cases — number only, True/False, a,b format, EDT name', () => {
  assert.ok(answersMatch('3', ' 3 '));
  assert.ok(answersMatch('3', '**3**'));
  assert.ok(answersMatch('74', '74.0'), 'numeric equality when both parse');
  assert.ok(answersMatch('True', 'true.'));
  assert.ok(answersMatch('False', 'FALSE'));
  assert.ok(answersMatch('CreditManagement,19,0', 'CreditManagement,19,0'));
  assert.ok(answersMatch('CustAccount', '`CustAccount`'));
  assert.ok(answersMatch('Microsoft Corporation', 'microsoft  corporation'));
});

test('answersMatch: does not rescue wrong or prose answers', () => {
  assert.ok(!answersMatch('3', '4'));
  assert.ok(!answersMatch('3', 'The value is 3'), 'no extraction from prose');
  assert.ok(!answersMatch('CreditManagement,19,0', 'CreditManagement, 19, 0'), 'the question fixed "no spaces"');
  assert.ok(!answersMatch('74', '7,4'));
  assert.ok(!answersMatch('True', ''));
  assert.ok(!answersMatch('Invoice', 'Invoiced'));
});

/* ── discipline ───────────────────────────────────────────────────────────── */

const FAKE_TOOLS = [
  { name: 'd365_lookup_table', inputSchema: { type: 'object', properties: { table_name: {}, fields_like: {}, custom_only: {}, field_limit: {}, format: {} } } },
  { name: 'd365_get_enum', inputSchema: { type: 'object', properties: { enum_name: {}, enum_names: {}, format: {} } } },
  { name: 'd365_get_join_keys', inputSchema: { type: 'object', properties: { table1: {}, table2: {}, format: {} } } },
  { name: 'd365_search', inputSchema: { type: 'object', properties: { query: {}, object_type: {}, modules: {}, limit: {}, cursor: {}, format: {} } } },
  { name: 'xref_find_references', inputSchema: { type: 'object', properties: { object_name: {}, objects: {}, kind: {}, limit: {}, cursor: {} } } },
];

test('toolLevers derives limit/filter/batch/cursor from inputSchema properties', () => {
  assert.deepEqual(toolLevers(FAKE_TOOLS[0].inputSchema), { limit: true, filter: true, batch: false, cursor: false, any: true });
  assert.deepEqual(toolLevers(FAKE_TOOLS[1].inputSchema), { limit: false, filter: false, batch: true, cursor: false, any: true });
  assert.deepEqual(toolLevers(FAKE_TOOLS[2].inputSchema), { limit: false, filter: false, batch: false, cursor: false, any: false }, 'format is not a lever');
  assert.deepEqual(toolLevers(FAKE_TOOLS[3].inputSchema), { limit: true, filter: true, batch: false, cursor: true, any: true });
  assert.deepEqual(toolLevers(undefined).any, false);
});

test('callLevers reads only argument keys', () => {
  assert.equal(callLevers(['table_name', 'fields_like']).filter, true);
  assert.equal(callLevers(['table_name']).any, false);
  assert.equal(callLevers(['enum_names']).batch, true);
  assert.equal(callLevers(['object_name', 'limit']).limit, true);
  assert.equal(callLevers(undefined).any, false);
});

test('disciplineRate: used-over-offered, lever-less tools leave the denominator', () => {
  const idx = indexToolLevers(FAKE_TOOLS);
  const calls = [
    { tool: 'd365_lookup_table', arg_keys: ['table_name', 'fields_like'] }, // offered, used
    { tool: 'd365_lookup_table', arg_keys: ['table_name'] },                // offered, wide dump
    { tool: 'd365_get_join_keys', arg_keys: ['table1', 'table2'] },         // no lever offered — excluded
    { tool: 'd365_get_enum', arg_keys: ['enum_name'] },                     // batch offered, single used
    { tool: 'd365_get_enum', arg_keys: ['enum_names'] },                    // batch used
    { tool: 'unknown_tool', arg_keys: ['limit'] },                          // unknown — excluded
  ];
  assert.equal(disciplineRate(calls, idx), 2 / 4);
  assert.equal(disciplineRate([{ tool: 'd365_get_join_keys', arg_keys: [] }], idx), null, 'no denominator');
  assert.equal(disciplineRate([], idx), null);
});

test('disciplineRate: a deliberately over-fetching sequence scores 0', () => {
  const idx = indexToolLevers(FAKE_TOOLS);
  const wide = [
    { tool: 'd365_lookup_table', arg_keys: ['table_name'] },
    { tool: 'd365_search', arg_keys: ['query'] },
    { tool: 'xref_find_references', arg_keys: ['object_name'] },
  ];
  assert.equal(disciplineRate(wide, idx), 0);
  const tight = wide.map(c => ({ ...c, arg_keys: [...c.arg_keys, 'limit'] }));
  assert.equal(disciplineRate(tight, idx), 1, 'limit counts only where the tool offers it');
});

test('median', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([]), null);
  assert.equal(median([1, NaN, 'x', 3]), 2);
});

test('serviceMetrics: pass rate, medians, first-call-correct, over-fetch flags', () => {
  const idx = indexToolLevers(FAKE_TOOLS);
  const rows = [
    { pass: true, tool_calls: [{ tool: 'd365_lookup_table', arg_keys: ['table_name', 'fields_like'] }, { tool: 'd365_get_enum', arg_keys: ['enum_name'] }], structured_bytes: 1000, text_bytes: 500, first_call_correct: true, over_fetch: false },
    { pass: false, tool_calls: [{ tool: 'd365_lookup_table', arg_keys: ['table_name'] }], structured_bytes: 30000, text_bytes: 20000, first_call_correct: false, over_fetch: true },
    { pass: true, tool_calls: [{ tool: 'd365_get_join_keys', arg_keys: ['table1', 'table2'] }, { tool: 'd365_get_join_keys', arg_keys: ['table1', 'table2'] }, { tool: 'd365_search', arg_keys: ['query', 'limit'] }], structured_bytes: 2000, text_bytes: 900, first_call_correct: true, over_fetch: null },
  ];
  const m = serviceMetrics(rows, idx);
  assert.equal(m.questions, 3);
  assert.equal(m.passed, 2);
  assert.equal(m.pass_rate, 66.7);
  assert.equal(m.median_tool_calls, 2);
  assert.equal(m.median_structured_bytes, 2000);
  assert.equal(m.discipline_rate, 50, '2 of 4 lever-offering calls (lookup+fields_like, search+limit) used one');
  assert.equal(m.first_call_correct_rate, 66.7);
  assert.equal(m.over_fetch_count, 1);
  assert.equal(m.budgeted_questions, 2);
  assert.equal(m.total_tool_calls, 6);
});

/* ── compare ──────────────────────────────────────────────────────────────── */

test('compareResults: thresholds at > 10 points and > 25%', () => {
  const prev = { service: 'kb', mode: 'llm', metrics: { pass_rate: 80, median_structured_bytes: 1000 } };
  assert.equal(PASS_RATE_DROP_POINTS, 10);
  assert.equal(BYTES_RISE_RATIO, 0.25);
  assert.ok(compareResults(prev, { service: 'kb', mode: 'llm', metrics: { pass_rate: 70, median_structured_bytes: 1250 } }).ok, 'exactly at the thresholds passes');
  const drop = compareResults(prev, { service: 'kb', mode: 'llm', metrics: { pass_rate: 69.9, median_structured_bytes: 1000 } });
  assert.ok(!drop.ok && /pass_rate dropped/.test(drop.reasons[0]));
  const rise = compareResults(prev, { service: 'kb', mode: 'llm', metrics: { pass_rate: 80, median_structured_bytes: 1251 } });
  assert.ok(!rise.ok && /bytes rose/.test(rise.reasons[0]));
  const better = compareResults(prev, { service: 'kb', mode: 'llm', metrics: { pass_rate: 100, median_structured_bytes: 500 } });
  assert.ok(better.ok);
  assert.equal(better.deltas.pass_rate_points, 20);
  assert.equal(better.deltas.median_structured_bytes_ratio, -0.5);
});

test('compareResults: mode/service mismatches warn, missing metrics do not fail', () => {
  const r = compareResults({ service: 'kb', mode: 'replay', metrics: { pass_rate: 100, median_structured_bytes: 900 } }, { service: 'xref', mode: 'llm', metrics: {} });
  assert.ok(r.ok);
  assert.equal(r.warnings.length, 2);
  assert.ok(compareResults(undefined, { metrics: { pass_rate: 0 } }).ok);
});

/* ── the loop, mocked ─────────────────────────────────────────────────────── */

function fakeAnthropic(script) {
  const seen = [];
  let i = 0;
  return {
    seen,
    messages: {
      async create(params) {
        seen.push(structuredClone(params)); // the runner grows one messages array in place — snapshot it
        const step = script[i++];
        if (!step) throw new Error('script exhausted');
        return { stop_reason: step.stop_reason, content: step.content, usage: step.usage ?? { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
      },
    },
  };
}

function fakeMcp(handlers) {
  const calls = [];
  return {
    calls,
    async callTool({ name, arguments: args }) {
      calls.push({ name, args });
      const h = handlers[name];
      if (!h) throw new Error(`no handler for ${name}`);
      return h(args);
    },
  };
}

const MCP_TOOLS = [
  { name: 'd365_lookup_table', description: 'Lookup', inputSchema: { type: 'object', properties: { table_name: { type: 'string' }, fields_like: { type: 'string' } }, required: ['table_name'] }, annotations: { readOnlyHint: true } },
  { name: 'd365_get_enum', description: 'Enum', inputSchema: { type: 'object', properties: { enum_name: { type: 'string' } } }, annotations: { readOnlyHint: true } },
  { name: 'd365_map_entity', description: 'WRITES', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: false } },
  { name: 'no_schema_tool', description: '' },
];

test('toAnthropicTools: name/description/input_schema, drops readOnlyHint:false, defaults a missing schema', () => {
  const tools = toAnthropicTools(MCP_TOOLS);
  assert.deepEqual(tools.map(t => t.name), ['d365_lookup_table', 'd365_get_enum', 'no_schema_tool']);
  assert.equal(tools[0].input_schema.properties.fields_like.type, 'string');
  assert.deepEqual(tools[2].input_schema, { type: 'object', properties: {} });
  for (const t of tools) assert.deepEqual(Object.keys(t).sort(), ['description', 'input_schema', 'name']);
});

test('buildSystemPrompt = server instructions + "Answer with the value only."', () => {
  assert.equal(buildSystemPrompt('Start with d365_search.'), 'Start with d365_search.\nAnswer with the value only.');
  assert.equal(buildSystemPrompt(undefined), 'Answer with the value only.');
});

test('runQuestionLlm: two tool turns (one isError fed back), final answer, names + arg KEYS only', async () => {
  const bigPayload = { fields: Array.from({ length: 50 }, (_, i) => ({ name: `Field${i}`, enum_type: 'SalesStatus' })) };
  const mcp = fakeMcp({
    d365_lookup_table: (args) => (args.table_name === 'SalesTabel'
      ? { isError: true, content: [{ type: 'text', text: '## Not found\nTable SalesTabel — did you mean SalesTable?' }] }
      : { content: [{ type: 'text', text: '## Table SalesTable\nSECRET-VALUE-IN-TEXT' }], structuredContent: bigPayload }),
    d365_get_enum: () => ({ content: [{ type: 'text', text: '## Enum SalesStatus' }], structuredContent: { values: [{ name: 'Invoiced', value: 3 }] } }),
  });
  const anthropic = fakeAnthropic([
    { stop_reason: 'tool_use', content: [{ type: 'text', text: 'Looking it up.' }, { type: 'tool_use', id: 't1', name: 'd365_lookup_table', input: { table_name: 'SalesTabel', fields_like: 'SalesStatus' } }] },
    { stop_reason: 'tool_use', content: [
      { type: 'tool_use', id: 't2', name: 'd365_lookup_table', input: { table_name: 'SalesTable', fields_like: 'SalesStatus' } },
      { type: 'tool_use', id: 't3', name: 'd365_get_enum', input: { enum_name: 'SalesStatus' } },
    ], usage: { input_tokens: 200, output_tokens: 40, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0 } },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: '**3**' }] },
  ]);
  const tools = toAnthropicTools(MCP_TOOLS);
  const rec = await runQuestionLlm({ anthropic, mcp, tools, system: buildSystemPrompt('x'), question: 'Q?', model: 'claude-sonnet-5', maxTurns: 12 });

  assert.equal(rec.answer, '**3**');
  assert.ok(answersMatch('3', rec.answer));
  assert.equal(rec.stop_reason, 'end_turn');
  assert.equal(rec.turns, 3);
  assert.equal(rec.tool_calls.length, 3);
  assert.equal(rec.tool_errors, 1);
  assert.deepEqual(rec.tool_calls.map(c => c.tool), ['d365_lookup_table', 'd365_lookup_table', 'd365_get_enum']);
  assert.deepEqual(rec.tool_calls[0].arg_keys, ['fields_like', 'table_name'], 'keys sorted');
  assert.equal(rec.tool_calls[0].is_error, true);
  assert.equal(rec.tool_calls[0].structured_bytes, 0, 'an error result has no structuredContent');
  assert.equal(rec.tool_calls[1].structured_bytes, Buffer.byteLength(JSON.stringify(bigPayload)));
  assert.equal(rec.structured_bytes, rec.tool_calls.reduce((s, c) => s + c.structured_bytes, 0));
  assert.ok(rec.text_bytes > 0);
  assert.deepEqual(rec.usage, { input_tokens: 400, output_tokens: 80, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0 });
  assert.equal(rec.estimated_cost_usd, estimateCostUsd('claude-sonnet-5', rec.usage));
  assert.equal(rec.model, 'claude-sonnet-5');
  // Privacy: the record never carries argument values or tool payloads.
  const dumped = JSON.stringify(rec);
  assert.ok(!dumped.includes('SalesTabel') && !dumped.includes('SECRET-VALUE-IN-TEXT') && !dumped.includes('Field0'));

  // What the model was sent: tools + cached system block; tool results in ONE user message per turn, is_error on the failed one.
  const first = anthropic.seen[0];
  assert.equal(first.model, 'claude-sonnet-5');
  assert.equal(first.tools.length, 3);
  assert.equal(first.system[0].cache_control.type, 'ephemeral');
  assert.equal(first.messages.length, 1);
  const second = anthropic.seen[1];
  assert.equal(second.messages[1].role, 'assistant');
  assert.equal(second.messages[2].role, 'user');
  assert.equal(second.messages[2].content[0].type, 'tool_result');
  assert.equal(second.messages[2].content[0].tool_use_id, 't1');
  assert.equal(second.messages[2].content[0].is_error, true);
  assert.match(second.messages[2].content[0].content, /did you mean SalesTable/);
  const third = anthropic.seen[2];
  assert.equal(third.messages[4].content.length, 2, 'both parallel results in one user message');
  assert.equal(third.messages[4].content[1].tool_use_id, 't3');
  assert.ok(!('is_error' in third.messages[4].content[0]));
  // The model reads the text channel, never the JSON.
  assert.match(third.messages[4].content[0].content, /^## Table SalesTable/);
  assert.ok(!third.messages[4].content[0].content.includes('"fields"'));
});

test('runQuestionLlm: max_turns stops the loop; a throwing tool becomes an is_error result', async () => {
  const mcp = fakeMcp({ d365_get_enum: () => { throw new Error('boom timeout'); } });
  const anthropic = fakeAnthropic(Array.from({ length: 5 }, (_, i) => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `t${i}`, name: 'd365_get_enum', input: { enum_name: 'X' } }] })));
  const rec = await runQuestionLlm({ anthropic, mcp, tools: [], system: 's', question: 'q', model: 'claude-sonnet-5', maxTurns: 2 });
  assert.equal(rec.turns, 2);
  assert.equal(rec.stop_reason, 'max_turns');
  assert.equal(rec.tool_calls.length, 2);
  assert.ok(rec.tool_calls.every(c => c.is_error));
  assert.equal(rec.tool_errors, 2);
  assert.equal(rec.answer, '');
  assert.equal(anthropic.seen[1].messages[2].content[0].is_error, true);
  assert.match(anthropic.seen[1].messages[2].content[0].content, /Tool call failed/);
});

test('estimateCostUsd: skill price table, cache read 0.1x, write 1.25x; unknown model -> null', () => {
  assert.equal(estimateCostUsd('claude-sonnet-5', { input_tokens: 1_000_000, output_tokens: 0 }), 2);
  assert.equal(estimateCostUsd('claude-sonnet-5', { input_tokens: 0, output_tokens: 1_000_000 }), 10);
  assert.equal(estimateCostUsd('claude-sonnet-5', { cache_read_input_tokens: 1_000_000 }), 0.2);
  assert.equal(estimateCostUsd('claude-sonnet-5', { cache_creation_input_tokens: 1_000_000 }), 2.5);
  assert.equal(estimateCostUsd('claude-opus-5', { input_tokens: 1_000_000 }), 5);
  assert.equal(estimateCostUsd('gpt-x', { input_tokens: 1 }), null);
});

/* ── results file ─────────────────────────────────────────────────────────── */

test('toResultsFile / writeResults / latestResultsFile: shape, name, and no payloads', () => {
  const report = {
    service: 'kb', mode: 'llm', model: 'claude-sonnet-5', pass: false,
    metrics: { questions: 1, passed: 0, pass_rate: 0, median_tool_calls: 1, median_structured_bytes: 42 },
    rows: [{
      id: 1, title: 'T', pass: false, expected: '3', actual: '4', turns: 2, stop_reason: 'end_turn',
      tool_calls: [{ tool: 'd365_get_enum', arg_keys: ['enum_name'], is_error: false, structured_bytes: 42, text_bytes: 10, ms: 5, secret: 'must not leak' }],
      structured_bytes: 42, text_bytes: 10, first_call_correct: false, expected_first_tool: 'd365_lookup_table', over_fetch: null, budget: '',
      usage: { input_tokens: 1 }, estimated_cost_usd: 0.00001, ms: 12, error: null,
    }],
  };
  const file = toResultsFile(report, { date: new Date('2026-09-02T10:00:00Z') });
  assert.equal(file.schema, 'd365fo-evals-results/1');
  assert.equal(file.date, '2026-09-02');
  assert.deepEqual(Object.keys(file.questions[0].tool_calls[0]).sort(), ['arg_keys', 'is_error', 'structured_bytes', 'text_bytes', 'tool']);
  assert.equal(file.questions[0].budget, null);
  assert.equal(file.questions[0].first_call_correct, false);

  const dir = mkdtempSync(join(tmpdir(), 'evals-results-'));
  try {
    const p1 = writeResults(report, { dir, date: new Date('2026-09-01T10:00:00Z') });
    const p2 = writeResults(report, { dir, date: new Date('2026-09-02T10:00:00Z') });
    assert.match(p1, /kb-2026-09-01\.json$/);
    assert.equal(JSON.parse(readFileSync(p2, 'utf8')).date, '2026-09-02');
    assert.equal(latestResultsFile('kb', dir), p2);
    assert.equal(latestResultsFile('xref', dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parseQuestionFilter and loadDotEnv', () => {
  assert.deepEqual([...parseQuestionFilter('1,3, 7')], [1, 3, 7]);
  assert.equal(parseQuestionFilter(undefined), undefined);
  assert.equal(parseQuestionFilter('x'), undefined);
  const dir = mkdtempSync(join(tmpdir(), 'evals-env-'));
  try {
    const f = join(dir, '.env');
    writeFileSync(f, '# c\nKB_DB_PATH="C:/x/kb.sqlite"\nexport FOO=bar\nEXISTING=from-file\nbad line\n');
    const env = loadDotEnv(f, { EXISTING: 'from-process' });
    assert.equal(env.KB_DB_PATH, 'C:/x/kb.sqlite');
    assert.equal(env.FOO, 'bar');
    assert.equal(env.EXISTING, 'from-process', 'never overrides the process env');
    assert.deepEqual(loadDotEnv(join(dir, 'missing.env'), { A: '1' }), { A: '1' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
