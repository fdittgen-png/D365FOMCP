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
 *   node scripts/run-evals.mjs <kb|xref|sec|taskrecorder|all> [--json]
 *   node scripts/run-evals.mjs call <service> <tool> <json|@path> [--expr <js>] [--max <chars>]
 *   node scripts/run-evals.mjs list <service>
 *
 * `--model <id>` is accepted and refused with a pointer to evals/README.md:
 * plugging an LLM in is the mcp-builder harness's job, documented there.
 *
 * Argument placeholders inside calls.json / `call` JSON (resolved relative to
 * the repo root): "@file:<path>" -> the file's UTF-8 text, "@b64:<path>" -> its
 * bytes base64-encoded (the Task Recorder tools take a base64 .axtr).
 *
 * Exit codes: 0 all answers match and budgets hold; 1 a mismatch, budget breach
 * or tool error; 2 usage error.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { XMLParser } from 'fast-xml-parser';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const SERVICES = Object.freeze(['kb', 'xref', 'sec', 'taskrecorder']);
const SERVER = Object.freeze({
  kb: 'src/local/mcp-server-kb.js',
  xref: 'src/local/mcp-server-xref.js',
  sec: 'src/local/mcp-server-sec.js',
  taskrecorder: 'src/local/mcp-server-taskrecorder.js',
});
const CALL_TIMEOUT_MS = 180_000; // XRef on a 3.5 GB file can take a while cold

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
    env: { ...process.env, MCP_TOOL_GUARDS: 'off' },
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

export async function runService(service, { log = console.log } = {}) {
  const { pairs, calls, budget } = loadEval(service);
  const session = await openSession(service);
  const rows = [];
  try {
    for (let i = 0; i < pairs.length; i++) {
      const pair = pairs[i];
      const spec = calls.pairs[i];
      const id = spec.id ?? i + 1;
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
      });
    }
  } finally {
    await session.close();
  }
  const okCount = rows.filter(r => r.match && r.budgetOk && !r.error).length;
  log(`\n## ${service} — ${okCount}/${rows.length} pass\n`);
  log(renderTable(rows));
  return { service, rows, pass: okCount === rows.length };
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
    'usage: node scripts/run-evals.mjs <kb|xref|sec|taskrecorder|all> [--json]',
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
  const model = flag(argv, '--model');
  if (model) {
    console.error(`--model ${model}: this script is a verifier, not an LLM harness. See evals/README.md for wiring the mcp-builder evaluation.py against evals/<service>.xml.`);
    process.exit(2);
  }
  const json = Boolean(flag(argv, '--json'));
  const [cmd] = argv;
  if (cmd === 'call') return cmdCall(argv.slice(1));
  if (cmd === 'list') return cmdList(argv.slice(1));
  if (cmd === 'batch') return cmdBatch(argv.slice(1));

  const targets = cmd === 'all' ? SERVICES : [cmd];
  for (const t of targets) if (!SERVICES.includes(t)) usage();
  const reports = [];
  for (const svc of targets) reports.push(await runService(svc, { log: json ? () => {} : console.log }));
  if (json) console.log(JSON.stringify(reports, null, 1));
  const allPass = reports.every(r => r.pass);
  if (!json) console.log(`\n${allPass ? 'PASS' : 'FAIL'} — ${reports.map(r => `${r.service} ${r.rows.filter(x => x.match && x.budgetOk && !x.error).length}/${r.rows.length}`).join(', ')}`);
  process.exit(allPass ? 0 : 1);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => { console.error(err?.stack ?? String(err)); process.exit(1); });
}
