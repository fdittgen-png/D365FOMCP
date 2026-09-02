#!/usr/bin/env node
/**
 * run-evals.mjs — eval VERIFIER for the four MCP services (W6.3, #110).
 *
 * This is not an LLM harness. It replays the tool calls recorded in
 * `evals/<service>.calls.json` against the LOCAL stdio servers (the same
 * `src/local/mcp-server-*.js` a Claude Code session launches), evaluates each
 * pair's `expr` over the `structuredContent` the calls returned, and compares
 * the result to the `<answer>` in `evals/<service>.xml` by exact string match.
 * It also sums `structuredContent` bytes per question and checks the three
 * budgeted questions in `evals/<service>.budget.json` — the token-discipline
 * dimension: evals here measure filters/limits/batching, not tool choice.
 *
 * Read-only: every call is a tool the servers annotate readOnlyHint:true, and
 * the servers open their databases read-only. `MCP_TOOL_GUARDS=off` because a
 * replay that repeats a call on purpose is not a loop.
 *
 *   node scripts/run-evals.mjs <kb|xref|sec|taskrecorder|all> [--json] [--compare <results.json|auto>]
 *   node scripts/run-evals.mjs <svc|all> --llm [--model claude-sonnet-5] [--max-turns 12] [--questions 1,3] [--compare …]
 *   node scripts/run-evals.mjs call <service> <tool> <json|@path> [--expr <js>] [--max <chars>]
 *   node scripts/run-evals.mjs list <service>
 *
 * `--llm` (issue #119) is the LLM leg: for each <qa_pair> an Anthropic model
 * gets the server's `instructions`, the tool list and the question, runs the
 * tool-use loop against the same local stdio server, and is graded by
 * normalised string match (scripts/evals/answer-match.mjs). Per service the run
 * records the discipline metrics of scripts/evals/discipline.mjs and writes
 * evals/results/<svc>-<YYYY-MM-DD>.json. Needs ANTHROPIC_API_KEY (or an
 * `ant auth login` profile). The replay stays the default and is unchanged.
 *
 * `--compare <file|auto>` (both modes) fails with exit 2 when pass_rate drops
 * > 10 points or median structuredContent bytes rise > 25% against that
 * results file (`auto` = newest evals/results/<svc>-*.json).
 *
 * Argument placeholders inside calls.json / `call` JSON (resolved relative to
 * the repo root): "@file:<path>" -> the file's UTF-8 text, "@b64:<path>" -> its
 * bytes base64-encoded (the Task Recorder tools take a base64 .axtr).
 *
 * Without a snapshot (the KB/XRef/Sec .sqlite files are not in the repo and CI
 * has none) a service is SKIPPED with a notice, exit 0 — the eval files
 * themselves are checked by test/evals-format.test.js.
 *
 * Exit codes: 0 all answers match and budgets hold (or skipped); 1 a mismatch,
 * budget breach or tool error in replay mode; 2 usage error or a --compare
 * regression.
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, join, isAbsolute, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { XMLParser } from 'fast-xml-parser';
import { serverOptions } from '../src/azure/server-metadata.js';
import { answersMatch } from './evals/answer-match.mjs';
import { indexToolLevers, serviceMetrics } from './evals/discipline.mjs';
import { compareResults } from './evals/compare.mjs';
import { runQuestionLlm, buildSystemPrompt, toAnthropicTools, DEFAULT_MODEL, DEFAULT_MAX_TURNS } from './evals/llm-runner.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const SERVICES = Object.freeze(['kb', 'xref', 'sec', 'taskrecorder']);
export const RESULTS_DIR = join(ROOT, 'evals', 'results');
const SERVER = Object.freeze({
  kb: 'src/local/mcp-server-kb.js',
  xref: 'src/local/mcp-server-xref.js',
  sec: 'src/local/mcp-server-sec.js',
  taskrecorder: 'src/local/mcp-server-taskrecorder.js',
});
const CALL_TIMEOUT_MS = 180_000; // XRef on a 3.5 GB file can take a while cold

/* ── Environment ──────────────────────────────────────────────────────────── */

/** Minimal `.env` reader (KEY=value, # comments, optional quotes); never overrides the process env. */
export function loadDotEnv(file = join(ROOT, '.env'), base = process.env) {
  const env = { ...base };
  if (!existsSync(file)) return env;
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(m[1] in env)) env[m[1]] = v;
  }
  return env;
}

/**
 * Where the local server of a service will look for its snapshot — mirrors
 * src/local/mcp-server-<svc>.js (sec ignores the env and takes only the
 * default path). Task Recorder has no database.
 */
export function snapshotPath(service, env = loadDotEnv()) {
  const home = env.USERPROFILE || env.HOME || '.';
  if (service === 'kb') return env.KB_DB_PATH || join(home, '.claude', 'd365fo_kb.sqlite');
  if (service === 'xref') return env.XREF_DB_PATH || join(home, '.claude', 'd365fo_xref.sqlite');
  if (service === 'sec') return join(home, '.claude', 'd365fo_sec.sqlite');
  return null;
}

export function snapshotAvailable(service, env = loadDotEnv()) {
  const p = snapshotPath(service, env);
  return p === null || existsSync(p);
}

/* ── Eval files ───────────────────────────────────────────────────────────── */

export function evalPaths(service) {
  const dir = join(ROOT, 'evals');
  return {
    xml: join(dir, `${service}.xml`),
    calls: join(dir, `${service}.calls.json`),
    budget: join(dir, `${service}.budget.json`),
    answers: join(dir, `${service}.answers.md`),
  };
}

/** Parse an mcp-builder evaluation XML into [{question, answer}]. */
export function parseEvalXml(text) {
  const parser = new XMLParser({ ignoreAttributes: false, trimValues: true, parseTagValue: false });
  const doc = parser.parse(text);
  const pairs = doc?.evaluation?.qa_pair;
  const list = Array.isArray(pairs) ? pairs : pairs ? [pairs] : [];
  return list.map(p => ({ question: String(p.question ?? '').trim(), answer: String(p.answer ?? '').trim() }));
}

export function loadEval(service) {
  const p = evalPaths(service);
  for (const f of [p.xml, p.calls]) {
    if (!existsSync(f)) throw new Error(`missing ${f}`);
  }
  const pairs = parseEvalXml(readFileSync(p.xml, 'utf8'));
  const calls = JSON.parse(readFileSync(p.calls, 'utf8'));
  const budget = existsSync(p.budget) ? JSON.parse(readFileSync(p.budget, 'utf8')) : { pairs: {} };
  if (!Array.isArray(calls.pairs) || calls.pairs.length !== pairs.length) {
    throw new Error(`${service}: ${pairs.length} <qa_pair>s in XML but ${calls.pairs?.length ?? 0} entries in calls.json`);
  }
  return { service, pairs, calls, budget };
}

/* ── Placeholders ─────────────────────────────────────────────────────────── */

function repoPath(p) { return isAbsolute(p) ? p : join(ROOT, p); }

export function resolvePlaceholders(value) {
  if (typeof value === 'string') {
    if (value.startsWith('@file:')) return readFileSync(repoPath(value.slice(6)), 'utf8');
    if (value.startsWith('@b64:')) return readFileSync(repoPath(value.slice(5))).toString('base64');
    return value;
  }
  if (Array.isArray(value)) return value.map(resolvePlaceholders);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolvePlaceholders(v)]));
  }
  return value;
}

/* ── Session ──────────────────────────────────────────────────────────────── */

export async function openSession(service) {
  if (!SERVER[service]) throw new Error(`unknown service "${service}" — one of ${SERVICES.join(', ')}`);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(ROOT, SERVER[service])],
    env: { ...loadDotEnv(), MCP_TOOL_GUARDS: 'off' },
    stderr: 'inherit',
  });
  const client = new Client({ name: 'd365fo-evals', version: '0.1.0' }, { capabilities: {} });
  await client.connect(transport);
  return {
    client,
    async call(tool, args) {
      const started = Date.now();
      const res = await client.callTool({ name: tool, arguments: resolvePlaceholders(args ?? {}) }, undefined, { timeout: CALL_TIMEOUT_MS });
      const sc = res.structuredContent;
      const text = Array.isArray(res.content) ? res.content.filter(c => c.type === 'text').map(c => c.text).join('\n') : '';
      return {
        tool, args, sc, text,
        isError: Boolean(res.isError),
        scBytes: sc === undefined ? 0 : Buffer.byteLength(JSON.stringify(sc), 'utf8'),
        textBytes: Buffer.byteLength(text, 'utf8'),
        ms: Date.now() - started,
      };
    },
    async close() { try { await client.close(); } catch { /* noop */ } },
  };
}

/* ── Evaluation ───────────────────────────────────────────────────────────── */

/**
 * `expr` is a JavaScript expression over `r` (array of structuredContent, one
 * per recorded call, in order) and `text` (array of the text channels). It is
 * checked-in code from this repository, not input from a client — same trust
 * as the script itself.
 */
export function evaluateExpr(expr, r, text) {
  // eslint-disable-next-line no-new-func
  const fn = new Function('r', 'text', `"use strict"; return (${expr});`);
  return fn(r, text);
}

export function normalizeAnswer(v) {
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  return String(v).trim();
}

/** `--questions 1,3` -> Set of ids; undefined -> all. */
export function parseQuestionFilter(spec) {
  if (spec === undefined || spec === true || spec === '') return undefined;
  const ids = String(spec).split(',').map(s => Number(s.trim())).filter(n => Number.isInteger(n) && n > 0);
  return ids.length ? new Set(ids) : undefined;
}

function skippedReport(service, mode, log) {
  const p = snapshotPath(service);
  log(`\n## ${service} — skipped: no snapshot (${p})\n`);
  return { service, mode, rows: [], pass: true, skipped: `no snapshot: ${p}`, metrics: null };
}

export async function runService(service, { log = console.log, questions } = {}) {
  const { pairs, calls, budget } = loadEval(service);
  if (!snapshotAvailable(service)) return skippedReport(service, 'replay', log);
  const session = await openSession(service);
  const rows = [];
  let leverIndex = new Map();
  try {
    leverIndex = indexToolLevers((await session.client.listTools()).tools);
    for (let i = 0; i < pairs.length; i++) {
      const pair = pairs[i];
      const spec = calls.pairs[i];
      const id = spec.id ?? i + 1;
      if (questions && !questions.has(Number(id))) continue;
      const results = [];
      let error = null;
      for (const c of spec.calls ?? []) {
        try {
          const res = await session.call(c.tool, c.arguments);
          results.push(res);
          if (res.isError) error ??= `${c.tool}: isError — ${res.text.split('\n').find(l => l.trim()) ?? ''}`.slice(0, 160);
        } catch (err) {
          error ??= `${c.tool}: ${err.message}`.slice(0, 160);
          results.push({ tool: c.tool, args: c.arguments, sc: undefined, text: '', isError: true, scBytes: 0, textBytes: 0, ms: 0 });
        }
      }
      let actual;
      try {
        actual = normalizeAnswer(evaluateExpr(spec.expr, results.map(x => x.sc), results.map(x => x.text)));
      } catch (err) {
        actual = `<expr error: ${err.message}>`;
        error ??= actual;
      }
      const match = actual === pair.answer;
      const scBytes = results.reduce((s, x) => s + x.scBytes, 0);
      const textBytes = results.reduce((s, x) => s + x.textBytes, 0);
      const b = budget.pairs?.[String(id)];
      let budgetStatus = '';
      let budgetOk = true;
      if (b) {
        const seq = (spec.calls ?? []).map(c => c.tool);
        const seqOk = !b.expected_tools || JSON.stringify(seq) === JSON.stringify(b.expected_tools);
        const bytesOk = !Number.isInteger(b.max_structured_bytes) || scBytes <= b.max_structured_bytes;
        budgetOk = seqOk && bytesOk;
        budgetStatus = `${scBytes.toLocaleString('en-US')}/${(b.max_structured_bytes ?? 0).toLocaleString('en-US')} ${bytesOk ? 'ok' : 'OVER'}${seqOk ? '' : ' seq!'}`;
      }
      rows.push({
        id, title: spec.title ?? `#${id}`, expected: pair.answer, actual, match,
        calls: results.length, scBytes, textBytes, ms: results.reduce((s, x) => s + x.ms, 0),
        budget: budgetStatus, budgetOk, error,
        // Discipline record (same keys as the LLM leg) — the recorded calls ARE
        // the reference sequence, so first_call_correct is not a measurement here.
        pass: match && budgetOk && !error,
        tool_calls: results.map(x => ({ tool: x.tool, arg_keys: Object.keys(x.args ?? {}).sort(), is_error: x.isError, structured_bytes: x.scBytes, text_bytes: x.textBytes, ms: x.ms })),
        structured_bytes: scBytes, text_bytes: textBytes,
        first_call_correct: null,
        over_fetch: b && Number.isInteger(b.max_structured_bytes) ? scBytes > b.max_structured_bytes : null,
      });
    }
  } finally {
    await session.close();
  }
  const okCount = rows.filter(r => r.pass).length;
  log(`\n## ${service} — ${okCount}/${rows.length} pass\n`);
  log(renderTable(rows));
  const metrics = serviceMetrics(rows, leverIndex);
  log(renderMetrics(metrics));
  return { service, mode: 'replay', rows, pass: okCount === rows.length, metrics };
}

/* ── LLM leg (issue #119) ─────────────────────────────────────────────────── */

async function makeAnthropicClient() {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  // Zero-arg: ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or an `ant auth login` profile.
  return new Anthropic();
}

/**
 * @param {object} opts
 * @param {(opts: object) => Promise<object>} [opts.clientFactory] injectable for tests (returns something with messages.create)
 */
export async function runServiceLlm(service, { log = console.log, model = DEFAULT_MODEL, maxTurns = DEFAULT_MAX_TURNS, questions, clientFactory = makeAnthropicClient } = {}) {
  const { pairs, calls, budget } = loadEval(service);
  if (!snapshotAvailable(service)) return skippedReport(service, 'llm', log);
  const anthropic = await clientFactory({ service, model });
  const session = await openSession(service);
  const rows = [];
  let leverIndex = new Map();
  try {
    const { tools: mcpTools } = await session.client.listTools();
    leverIndex = indexToolLevers(mcpTools);
    const tools = toAnthropicTools(mcpTools);
    const system = buildSystemPrompt(serverOptions(service).instructions);
    for (let i = 0; i < pairs.length; i++) {
      const pair = pairs[i];
      const spec = calls.pairs[i];
      const id = spec.id ?? i + 1;
      if (questions && !questions.has(Number(id))) continue;
      let rec;
      try {
        rec = await runQuestionLlm({ anthropic, mcp: session.client, tools, system, question: pair.question, model, maxTurns });
      } catch (err) {
        // An API failure (auth, rate limit, network) is a run failure, not a wrong answer.
        rec = { answer: '', stop_reason: 'api_error', turns: 0, tool_calls: [], tool_errors: 0, structured_bytes: 0, text_bytes: 0, usage: {}, estimated_cost_usd: null, wall_ms: 0, model, error: `${err?.name ?? 'Error'}: ${String(err?.message ?? err).slice(0, 200)}` };
      }
      const match = rec.stop_reason !== 'api_error' && answersMatch(pair.answer, rec.answer);
      const expectedFirst = spec.calls?.[0]?.tool ?? null;
      const b = budget.pairs?.[String(id)];
      const overFetch = b && Number.isInteger(b.max_structured_bytes) ? rec.structured_bytes > b.max_structured_bytes : null;
      const budgetStatus = b ? `${rec.structured_bytes.toLocaleString('en-US')}/${b.max_structured_bytes.toLocaleString('en-US')} ${overFetch ? 'OVER' : 'ok'}` : '';
      rows.push({
        id, title: spec.title ?? `#${id}`, question: pair.question, expected: pair.answer, actual: rec.answer, match, pass: match,
        calls: rec.tool_calls.length, scBytes: rec.structured_bytes, textBytes: rec.text_bytes, ms: rec.wall_ms,
        budget: budgetStatus, budgetOk: !overFetch, error: rec.error ?? null,
        tool_calls: rec.tool_calls, tool_errors: rec.tool_errors, turns: rec.turns, stop_reason: rec.stop_reason,
        structured_bytes: rec.structured_bytes, text_bytes: rec.text_bytes,
        first_call_correct: rec.tool_calls.length ? rec.tool_calls[0].tool === expectedFirst : false,
        expected_first_tool: expectedFirst,
        over_fetch: overFetch,
        usage: rec.usage, estimated_cost_usd: rec.estimated_cost_usd, model: rec.model,
      });
      log(`  #${id} ${match ? 'pass' : 'FAIL'} — ${rec.tool_calls.length} calls, ${rec.turns} turns, ${rec.structured_bytes.toLocaleString('en-US')} B sc, ${rec.wall_ms} ms${rec.error ? ` — ${rec.error}` : ''}`);
    }
  } finally {
    await session.close();
  }
  const metrics = serviceMetrics(rows, leverIndex);
  const usage = rows.reduce((t, r) => { for (const k of Object.keys(r.usage ?? {})) t[k] = (t[k] ?? 0) + r.usage[k]; return t; }, {});
  const cost = rows.reduce((s, r) => s + (r.estimated_cost_usd ?? 0), 0);
  metrics.usage = usage;
  metrics.estimated_cost_usd = Math.round(cost * 1e4) / 1e4;
  metrics.model = model;
  log(`\n## ${service} (llm, ${model}) — ${metrics.passed}/${rows.length} pass\n`);
  log(renderLlmTable(rows));
  log(renderMetrics(metrics));
  return { service, mode: 'llm', model, rows, pass: metrics.passed === rows.length, metrics };
}

/* ── Results files + compare ──────────────────────────────────────────────── */

/** The on-disk shape of evals/results/<svc>-<date>.json (kept flat and payload-free). */
export function toResultsFile(report, { date = new Date() } = {}) {
  const day = date.toISOString().slice(0, 10);
  return {
    schema: 'd365fo-evals-results/1',
    service: report.service,
    mode: report.mode,
    model: report.model ?? null,
    date: day,
    generated_at: date.toISOString(),
    metrics: report.metrics,
    questions: report.rows.map(r => ({
      id: r.id, title: r.title, pass: r.pass, expected: r.expected, actual: r.actual,
      turns: r.turns ?? null, stop_reason: r.stop_reason ?? null,
      tool_calls: (r.tool_calls ?? []).map(c => ({ tool: c.tool, arg_keys: c.arg_keys, is_error: c.is_error, structured_bytes: c.structured_bytes, text_bytes: c.text_bytes })),
      structured_bytes: r.structured_bytes, text_bytes: r.text_bytes,
      first_call_correct: r.first_call_correct, expected_first_tool: r.expected_first_tool ?? null,
      over_fetch: r.over_fetch, budget: r.budget || null,
      usage: r.usage ?? null, estimated_cost_usd: r.estimated_cost_usd ?? null,
      wall_ms: r.ms, error: r.error ?? null,
    })),
  };
}

export function writeResults(report, { dir = RESULTS_DIR, date = new Date() } = {}) {
  mkdirSync(dir, { recursive: true });
  const file = toResultsFile(report, { date });
  const path = join(dir, `${report.service}-${file.date}.json`);
  writeFileSync(path, JSON.stringify(file, null, 1) + '\n');
  return path;
}

/** Newest evals/results/<svc>-*.json, or null. */
export function latestResultsFile(service, dir = RESULTS_DIR) {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter(f => f.startsWith(`${service}-`) && f.endsWith('.json')).sort();
  return files.length ? join(dir, files[files.length - 1]) : null;
}

function resolveCompareTarget(spec, service) {
  if (spec === 'auto') return latestResultsFile(service);
  return repoPath(spec);
}

function renderMetrics(m) {
  if (!m) return '';
  const f = (v, suffix = '') => (v === null || v === undefined ? '—' : `${typeof v === 'number' ? v.toLocaleString('en-US') : v}${suffix}`);
  const parts = [
    `pass_rate ${f(m.pass_rate, '%')}`,
    `median calls/q ${f(m.median_tool_calls)}`,
    `median sc bytes/q ${f(m.median_structured_bytes)}`,
    `discipline_rate ${f(m.discipline_rate, '%')}`,
    `first_call_correct ${f(m.first_call_correct_rate, '%')}`,
    `over-fetch ${m.over_fetch_count}/${m.budgeted_questions}`,
  ];
  if (m.usage && Object.keys(m.usage).length) {
    parts.push(`tokens in ${f(m.usage.input_tokens)} (+${f(m.usage.cache_read_input_tokens)} cached, ${f(m.usage.cache_creation_input_tokens)} written) out ${f(m.usage.output_tokens)}`);
    parts.push(`est. cost $${f(m.estimated_cost_usd)}`);
  }
  return `\n${parts.join(' · ')}`;
}

export function renderLlmTable(rows) {
  const lines = [
    '| # | question | expected | actual | ok | calls | turns | sc bytes | text | 1st call ok | ms | budget |',
    '|---|---|---|---|---|---:|---:|---:|---:|---|---:|---|',
  ];
  const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  for (const r of rows) {
    lines.push(`| ${r.id} | ${cell(r.title)} | ${cell(r.expected)} | ${cell(r.actual).slice(0, 60)} | ${r.match ? 'yes' : 'NO'} | ${r.calls} | ${r.turns ?? ''} | ${r.scBytes.toLocaleString('en-US')} | ${r.textBytes.toLocaleString('en-US')} | ${r.first_call_correct ? 'yes' : 'no'} | ${r.ms} | ${cell(r.budget)} |`);
    if (r.error) lines.push(`|   | ! ${cell(r.error)} | | | | | | | | | | |`);
  }
  return lines.join('\n');
}

function pad(s, n, right = false) {
  s = String(s ?? '');
  if (s.length > n) s = s.slice(0, n - 1) + '…';
  return right ? s.padStart(n) : s.padEnd(n);
}

export function renderTable(rows) {
  const head = `${pad('#', 3)} ${pad('question', 44)} ${pad('expected', 22)} ${pad('actual', 22)} ${pad('ok', 3)} ${pad('calls', 5, true)} ${pad('sc bytes', 9, true)} ${pad('text', 8, true)} ${pad('ms', 6, true)}  budget`;
  const lines = [head, '-'.repeat(head.length)];
  for (const r of rows) {
    lines.push(`${pad(r.id, 3)} ${pad(r.title, 44)} ${pad(r.expected, 22)} ${pad(r.actual, 22)} ${pad(r.match ? 'yes' : 'NO', 3)} ${pad(r.calls, 5, true)} ${pad(r.scBytes.toLocaleString('en-US'), 9, true)} ${pad(r.textBytes.toLocaleString('en-US'), 8, true)} ${pad(r.ms, 6, true)}  ${r.budget}`);
    if (r.error) lines.push(`    ! ${r.error}`);
  }
  return lines.join('\n');
}

/* ── CLI ──────────────────────────────────────────────────────────────────── */

function usage(code = 2) {
  console.error([
    'usage: node scripts/run-evals.mjs <kb|xref|sec|taskrecorder|all> [--json] [--questions 1,3] [--compare <results.json|auto>]',
    '       node scripts/run-evals.mjs <service|all> --llm [--model claude-sonnet-5] [--max-turns 12] [--questions 1,3] [--compare …] [--no-write]',
    '       node scripts/run-evals.mjs call <service> <tool> <json|@path> [--expr <js>] [--max <chars>]',
    '       node scripts/run-evals.mjs list <service>',
    '       node scripts/run-evals.mjs batch <service> <calls.json>   # [{tool, arguments, expr?, max?}]',
  ].join('\n'));
  process.exit(code);
}

function flag(argv, name) {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v ?? true;
}

async function cmdCall(argv) {
  const expr = flag(argv, '--expr');
  const max = Number(flag(argv, '--max') ?? 4000);
  const [service, tool, rawArgs = '{}'] = argv;
  if (!service || !tool) usage();
  const argText = rawArgs.startsWith('@') ? readFileSync(repoPath(rawArgs.slice(1)), 'utf8') : rawArgs;
  const session = await openSession(service);
  try {
    const res = await session.call(tool, JSON.parse(argText));
    console.log(`# ${tool} — isError=${res.isError} structuredContent=${res.scBytes.toLocaleString('en-US')} B text=${res.textBytes.toLocaleString('en-US')} B ${res.ms} ms`);
    if (expr) {
      const v = evaluateExpr(expr, [res.sc], [res.text]);
      console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 1));
    } else if (res.sc !== undefined) {
      const s = JSON.stringify(res.sc, null, 1);
      console.log(s.length > max ? s.slice(0, max) + `\n… (${s.length - max} more chars)` : s);
    } else {
      console.log(res.text.slice(0, max));
    }
  } finally {
    await session.close();
  }
}

/**
 * `batch <service> <file.json>`: one session, many calls — for exploration and
 * for recording answers. The file is `[{tool, arguments, expr?, max?}]`; each
 * result prints like `call` does (expr projection, else structuredContent
 * truncated to `max` chars, default 1200).
 */
async function cmdBatch(argv) {
  const [service, file] = argv;
  if (!service || !file) usage();
  const specs = JSON.parse(readFileSync(repoPath(file), 'utf8'));
  const session = await openSession(service);
  try {
    for (const spec of specs) {
      let res;
      try {
        res = await session.call(spec.tool, spec.arguments ?? {});
      } catch (err) {
        console.log(`# ${spec.tool} ${JSON.stringify(spec.arguments ?? {})}\n! ${err.message}\n`);
        continue;
      }
      console.log(`# ${spec.tool} ${JSON.stringify(spec.arguments ?? {})} — isError=${res.isError} sc=${res.scBytes.toLocaleString('en-US')} B text=${res.textBytes.toLocaleString('en-US')} B ${res.ms} ms`);
      const max = Number(spec.max ?? 1200);
      if (spec.expr) {
        try {
          const v = evaluateExpr(spec.expr, [res.sc], [res.text]);
          const s = typeof v === 'string' ? v : JSON.stringify(v);
          console.log(s.length > max ? s.slice(0, max) + ' …' : s);
        } catch (err) {
          console.log(`! expr: ${err.message}`);
        }
      } else if (res.sc !== undefined) {
        const s = JSON.stringify(res.sc);
        console.log(s.length > max ? s.slice(0, max) + ` … (+${s.length - max})` : s);
      } else {
        console.log(res.text.slice(0, max));
      }
      console.log('');
    }
  } finally {
    await session.close();
  }
}

async function cmdList(argv) {
  const [service] = argv;
  if (!service) usage();
  const session = await openSession(service);
  try {
    const { tools } = await session.client.listTools();
    for (const t of tools) {
      console.log(`${t.name}  [${Object.keys(t.inputSchema?.properties ?? {}).join(', ')}]`);
    }
  } finally {
    await session.close();
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes('-h') || argv.includes('--help')) usage(argv.length ? 0 : 2);
  const llm = Boolean(flag(argv, '--llm'));
  const model = flag(argv, '--model');
  if (model && !llm) {
    console.error(`--model ${model} only applies to the LLM leg — add --llm. See evals/README.md.`);
    process.exit(2);
  }
  const maxTurnsArg = flag(argv, '--max-turns');
  const maxTurns = Number.isInteger(Number(maxTurnsArg)) && Number(maxTurnsArg) > 0 ? Number(maxTurnsArg) : DEFAULT_MAX_TURNS;
  const questions = parseQuestionFilter(flag(argv, '--questions'));
  const compareSpec = flag(argv, '--compare');
  const noWrite = Boolean(flag(argv, '--no-write'));
  const json = Boolean(flag(argv, '--json'));
  const [cmd] = argv;
  if (cmd === 'call') return cmdCall(argv.slice(1));
  if (cmd === 'list') return cmdList(argv.slice(1));
  if (cmd === 'batch') return cmdBatch(argv.slice(1));

  const targets = cmd === 'all' ? SERVICES : [cmd];
  for (const t of targets) if (!SERVICES.includes(t)) usage();
  const log = json ? () => {} : console.log;
  const reports = [];
  let compareFailed = false;
  for (const svc of targets) {
    const report = llm
      ? await runServiceLlm(svc, { log, model: typeof model === 'string' ? model : DEFAULT_MODEL, maxTurns, questions })
      : await runService(svc, { log, questions });
    if (typeof compareSpec === 'string' && !report.skipped) {
      const target = resolveCompareTarget(compareSpec, svc);
      if (target && existsSync(target)) {
        const previous = JSON.parse(readFileSync(target, 'utf8'));
        const cmp = compareResults(previous, { service: svc, mode: report.mode, metrics: report.metrics });
        report.compare = { against: basename(target), ...cmp };
        for (const w of cmp.warnings) log(`  compare: ${w}`);
        log(cmp.ok ? `  compare vs ${basename(target)}: ok ${JSON.stringify(cmp.deltas)}` : `  compare vs ${basename(target)}: REGRESSION — ${cmp.reasons.join('; ')}`);
        if (!cmp.ok) compareFailed = true;
      } else {
        log(`  compare: no previous results file for ${svc}${compareSpec === 'auto' ? '' : ` at ${compareSpec}`} — nothing to compare`);
      }
    }
    if (llm && !report.skipped && !noWrite) {
      const path = writeResults(report);
      log(`  results -> ${path}`);
    }
    reports.push(report);
  }
  if (json) console.log(JSON.stringify(reports, null, 1));
  const skipped = reports.filter(r => r.skipped);
  const ran = reports.filter(r => !r.skipped);
  const allPass = ran.every(r => r.pass);
  const summary = reports.map(r => r.skipped ? `${r.service} skipped` : `${r.service} ${r.rows.filter(x => x.pass).length}/${r.rows.length}`).join(', ');
  if (!json) {
    if (ran.length === 0) console.log(`\nSKIPPED — no snapshot for ${skipped.map(r => r.service).join(', ')}`);
    else if (llm) console.log(`\nDONE — ${summary}${compareFailed ? ' — COMPARE REGRESSION' : ''}`);
    else console.log(`\n${allPass ? 'PASS' : 'FAIL'} — ${summary}${compareFailed ? ' — COMPARE REGRESSION' : ''}`);
  }
  if (compareFailed) process.exit(2);
  // The LLM leg is a measurement: a failed question is data, the regression gate is --compare.
  process.exit(llm || allPass ? 0 : 1);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => { console.error(err?.stack ?? String(err)); process.exit(1); });
}
