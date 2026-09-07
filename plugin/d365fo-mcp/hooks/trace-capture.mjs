#!/usr/bin/env node
/**
 * trace-capture — the Claude Code hook that captures an ERP-metadata
 * investigation as trace records (ERP-Trace-Capture-TDD §3/§8, WI-15).
 *
 * One script, five events (registered in ../hooks.json, or in the user's
 * settings.json during cutover):
 *
 *   UserPromptSubmit  → new investigation candidate for this `prompt_id`; prints the
 *                       trace protocol instruction (stdout = context for Claude) so
 *                       Claude COMPILES the request itself (`Request:` / `Entities:`)
 *   PreToolUse        → (D365 MCP tools only) first call opens the investigation:
 *                       `open` from Claude's declared/interpretation line — never the
 *                       user's raw words unless nothing else exists (config
 *                       `allow_prompt_fallback`, decided 2026-09-07) — then one `step`
 *                       per new strategy line, then the call is stashed (launch order)
 *   PostToolUse /
 *   PostToolUseFailure → one Stream-1 call record: tool, replayable args under policy,
 *                       result kind/bytes/rows/has_more/duration — never the response
 *   Stop              → `close` with the final answer as `conclusion.summary`
 *
 * State per session in ~/.claude/mcp-trace/state/<session_id>.json under a
 * directory lock (parallel tool calls run hooks in parallel). Every record
 * passes `sanitize()`; records go to ~/.claude/mcp-trace/hook.ndjson and/or
 * POST <url>/trace/ingest per `~/.claude/claude-trace.config.json`. Exits 0
 * always; writes to stdout ONLY on UserPromptSubmit.
 *
 * `CLAUDE_TRACE_HOME` overrides the home directory (tests). `CLAUDE_TRACE_DEBUG=1`
 * prints to stderr.
 */
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, rmSync, statSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { investigationId, requestKey, isIdentifier } from './lib/identifiers.js';
import { parseToolName } from './lib/arg-policies.js';
import { matchEntities, parseDeclaredEntities } from './lib/vocabulary-match.js';
import { sanitize } from './lib/sanitize.js';
import { callRecord, claudeRecord, sessionKey } from './lib/record.js';
import { proseViolation, maskDigitRuns } from './lib/privacy.js';
import { readTranscriptRecords, currentTurn, parseProtocolLines, firstParagraph } from './lib/transcript.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOME = process.env.CLAUDE_TRACE_HOME || homedir();
const CLAUDE_DIR = join(HOME, '.claude');
const TRACE_DIR = join(CLAUDE_DIR, 'mcp-trace');
const STATE_DIR = join(TRACE_DIR, 'state');
const CONFIG_PATH = join(CLAUDE_DIR, 'claude-trace.config.json');
const LOG_PATH = join(CLAUDE_DIR, 'claude-trace.log');
const CURRENT_PATH = join(TRACE_DIR, 'current');
const FILE_SINK = join(TRACE_DIR, 'hook.ndjson');

const NOISE_RE = /^\s*(<task-notification>|<task-id>|<system-reminder>|\[SYSTEM NOTIFICATION|<local-command-caveat>|<command-name>)/i;

export const INSTRUCTION =
  'Trace protocol (active): if this turn will query ERP metadata through the D365 KB or XRef MCP tools, ' +
  'begin your reply with two lines — `Request: <ERP-neutral restatement of the ask; no person names, no data values>` ' +
  'and `Entities: <functional entities named in business terms, e.g. vendor, postal address, sales order — or none>` — ' +
  'then write one short strategy line before each group of MCP calls. Otherwise ignore this note.';

/* ── small I/O helpers ─────────────────────────────────────────────────────── */

function debug(...a) {
  if (process.env.CLAUDE_TRACE_DEBUG) console.error('[trace-capture]', ...a);
}

function log(msg) {
  try { mkdirSync(CLAUDE_DIR, { recursive: true }); appendFileSync(LOG_PATH, `${new Date().toISOString()} ${msg}\n`); } catch { /* ignore */ }
}

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

function readConfig() {
  const cfg = readJson(CONFIG_PATH, null);
  if (!cfg || cfg.enabled === false) return null;
  return {
    timeoutMs: 3000,
    transport: cfg.url ? 'both' : 'file',
    ingest_route: '/trace/ingest',
    instruct: true,
    allow_prompt_fallback: true,
    erp: { system: 'D365FO', installation_id: 'local' },
    ...cfg,
    url: cfg.url ? String(cfg.url).replace(/\/+$/, '') : null,
  };
}

function readStdin() {
  try { const raw = readFileSync(0, 'utf8'); return raw.trim() ? JSON.parse(raw) : {}; } catch { return {}; }
}

let vocabularyCache;
function vocabulary() {
  vocabularyCache ??= readJson(join(__dirname, 'lib', 'vocabulary.json'), { entities: [] });
  return vocabularyCache;
}

let policiesCache;
function policiesFor(tool) {
  policiesCache ??= readJson(join(__dirname, 'lib', 'arg-policies.json'), {});
  return policiesCache[tool] ?? {};
}

/* ── state under a lock ────────────────────────────────────────────────────── */

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withLock(sessionId, fn) {
  mkdirSync(STATE_DIR, { recursive: true });
  const lock = join(STATE_DIR, `${sessionId}.lock`);
  const deadline = Date.now() + 2000;
  for (;;) {
    try { mkdirSync(lock); break; } catch {
      try { if (Date.now() - statSync(lock).mtimeMs > 10_000) rmSync(lock, { recursive: true, force: true }); } catch { /* raced */ }
      if (Date.now() > deadline) { log('lock timeout'); return undefined; }
      sleep(5);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

function statePath(sessionId) {
  return join(STATE_DIR, `${String(sessionId).replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
}

function freshState(input, now) {
  return {
    session_id: input.session_id || 'unknown',
    prompt_id: input.prompt_id || null,
    prompt_ts: now,
    investigation_id: investigationId(input.prompt_id || `${input.session_id || 's'}-${Date.now()}`),
    opened: false,
    closed: false,
    seq: 0,
    step_n: 0,
    launch_seq: 0,
    calls: {},
    consumed: [],
    done: [],
    emitted: 0,
  };
}

function loadState(input, now) {
  const p = statePath(input.session_id || 'unknown');
  const s = readJson(p, null);
  if (s && (!input.prompt_id || s.prompt_id === input.prompt_id)) return { state: s, path: p, isNew: false };
  return { state: freshState(input, now), path: p, isNew: true, previous: s };
}

function saveState(path, state) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, path);
}

/* ── record context + transport ────────────────────────────────────────────── */

function context(cfg, state, service) {
  return {
    erp: { system: cfg.erp?.system || 'D365FO', installation_id: cfg.erp?.installation_id || 'local', ...(cfg.erp?.version ? { version: cfg.erp.version } : {}) },
    mcp: { service },
    investigation_id: state.investigation_id,
    session_key: sessionKey(state.session_id, cfg.erp?.installation_id || 'local'),
    seq: state.seq++,
    source: 'hook',
  };
}

async function emit(cfg, records) {
  const clean = [];
  for (const r of records) {
    const s = sanitize(r);
    if (s.ok) clean.push(s.record);
    else log(`dropped ${r.stream}/${r.phase ?? r.tool?.name ?? '?'}: ${s.reason} (${s.field})`);
  }
  if (!clean.length) return;
  if (cfg.transport === 'file' || cfg.transport === 'both') {
    try {
      mkdirSync(TRACE_DIR, { recursive: true });
      appendFileSync(FILE_SINK, clean.map((r) => JSON.stringify(r)).join('\n') + '\n');
    } catch (e) { log(`file sink: ${e.message}`); }
  }
  if ((cfg.transport === 'http' || cfg.transport === 'both') && cfg.url) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
    try {
      const res = await fetch(`${cfg.url}${cfg.ingest_route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-functions-key': cfg.key || '' },
        body: JSON.stringify(clean),
        signal: ctrl.signal,
      });
      debug('POST', cfg.ingest_route, res.status);
      if (res.status >= 300) log(`${cfg.ingest_route} HTTP ${res.status}`);
    } catch (e) {
      log(`${cfg.ingest_route} ${e.name}: ${e.message}`);
    } finally {
      clearTimeout(t);
    }
  }
}

function setCurrent(state) {
  try {
    mkdirSync(TRACE_DIR, { recursive: true });
    writeFileSync(CURRENT_PATH, JSON.stringify({ investigation_id: state.investigation_id, ts: new Date().toISOString() }));
  } catch { /* ignore */ }
}

function clearCurrent(state) {
  try {
    const cur = readJson(CURRENT_PATH, null);
    if (!cur || cur.investigation_id === state.investigation_id) rmSync(CURRENT_PATH, { force: true });
  } catch { /* ignore */ }
}

/* ── the four phases ───────────────────────────────────────────────────────── */

/** Interpretation of the request: declared `Request:` line → first assistant paragraph → (allowed) user prompt. */
function interpretRequest(turn, protocol, cfg) {
  if (protocol.request) return { interpreted: protocol.request.slice(0, 600), approach: protocol.rest ? firstParagraph(protocol.rest, 400) : undefined, source: 'declared' };
  const first = turn.texts[0];
  if (first) {
    const { rest } = parseProtocolLines(first.text);
    const para = firstParagraph(rest || first.text, 600);
    if (para) {
      const paras = (rest || first.text).split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
      return { interpreted: para, approach: paras[1] ? paras[1].slice(0, 400) : undefined, source: 'interpretation' };
    }
  }
  if (cfg.allow_prompt_fallback && turn.prompt_text) {
    const { text } = maskDigitRuns(turn.prompt_text);
    const para = firstParagraph(text, 600);
    if (para && !proseViolation(para)) return { interpreted: para, source: 'user_prompt' };
    return { interpreted: 'User request withheld: it contained party or person data.', source: 'user_prompt' };
  }
  return { interpreted: 'Request not captured: no interpretation line before the first MCP call.', source: 'interpretation' };
}

function expectedEntities(protocol, interpreted, toolInput) {
  const vocab = vocabulary();
  if (protocol.entities != null) {
    const declared = [...new Set([...parseDeclaredEntities(protocol.entities, vocab), ...matchEntities(protocol.entities, vocab)])].slice(0, 20);
    return { expected_entities: declared, entities_from: 'declared' };
  }
  const fc = toolInput?.functional_context;
  if (typeof fc === 'string' && isIdentifier(fc)) return { expected_entities: [fc], entities_from: 'functional_context' };
  const matched = matchEntities(interpreted, vocab);
  if (matched.length) return { expected_entities: matched, entities_from: 'vocabulary_match' };
  return { expected_entities: [], entities_from: 'none' };
}

function onUserPromptSubmit(cfg, input) {
  if (NOISE_RE.test(String(input.prompt ?? ''))) return [];
  const now = new Date().toISOString();
  const out = [];
  withLock(input.session_id || 'unknown', () => {
    const { state, path, isNew, previous } = loadState(input, now);
    if (isNew && previous?.opened && !previous.closed) {
      const ctx = context(cfg, previous, previous.service || 'kb');
      out.push(claudeRecord(ctx, 'close', { conclusion: { summary: 'Investigation left open: a new prompt started before Stop fired.', outcome: 'abandoned' }, calls: previous.emitted }));
    }
    saveState(path, isNew ? state : { ...state, prompt_ts: now });
  });
  if (cfg.instruct !== false) process.stdout.write(INSTRUCTION + '\n');
  return out;
}

function onPreToolUse(cfg, input) {
  const parsed = parseToolName(input.tool_name);
  if (!parsed) return [];
  const now = new Date().toISOString();
  const out = [];
  withLock(input.session_id || 'unknown', () => {
    const { state, path } = loadState(input, now);
    state.service ??= parsed.service;
    const records = readTranscriptRecords(input.transcript_path);
    const turn = currentTurn(records) || { prompt_text: '', texts: [] };
    const newTexts = turn.texts.filter((t) => !state.consumed.includes(t.uuid));

    if (!state.opened) {
      const protocol = newTexts.reduce((acc, t) => {
        const p = parseProtocolLines(t.text);
        if (p.request && acc.request == null) { acc.request = p.request; acc.rest = p.rest; acc.uuid = t.uuid; }
        if (p.entities && acc.entities == null) acc.entities = p.entities;
        return acc;
      }, { request: null, entities: null, rest: '' });
      const req = interpretRequest(turn, protocol, cfg);
      const ents = expectedEntities(protocol, req.interpreted, input.tool_input);
      const ctx = context(cfg, state, parsed.service);
      out.push(claudeRecord(ctx, 'open', {
        request: { key: requestKey(req.interpreted), interpreted: req.interpreted, approach: req.approach, source: req.source },
        ...ents,
      }, turn.prompt_ts || now));
      state.opened = true;
      // the block that carried the interpretation is consumed; protocol lines never become steps
      const used = protocol.uuid || newTexts[0]?.uuid;
      if (used) state.consumed.push(used);
    }

    for (const t of turn.texts) {
      if (state.consumed.includes(t.uuid)) continue;
      const { rest } = parseProtocolLines(t.text);
      const intent = firstParagraph(rest, 400);
      state.consumed.push(t.uuid);
      if (!intent) continue;
      state.step_n += 1;
      out.push(claudeRecord(context(cfg, state, parsed.service), 'step', { n: state.step_n, intent }, t.ts || now));
    }

    const id = input.tool_use_id || `${Date.now()}-${Math.random()}`;
    if (!state.calls[id] && !state.done.includes(id)) {
      state.launch_seq += 1;
      state.calls[id] = { launch_ts: now, launch_seq: state.launch_seq, tool: parsed.tool, service: parsed.service, args: input.tool_input ?? {} };
    }
    setCurrent(state);
    saveState(path, state);
  });
  return out;
}

/** How the call ended, from the hook's `tool_response` — five facts, never the body. */
export function resultFromResponse(response, failed) {
  let text = '';
  let obj = null;
  if (typeof response === 'string') { text = response; try { obj = JSON.parse(response); } catch { /* text channel */ } }
  else if (response && typeof response === 'object') {
    obj = response.structuredContent ?? (Array.isArray(response.content) ? null : response);
    text = Array.isArray(response.content) ? response.content.map((c) => c?.text ?? '').join('\n') : JSON.stringify(response);
  }
  const out = { kind: 'data', bytes: Buffer.byteLength(text, 'utf8') };
  if (failed || response?.isError) out.kind = 'error';
  else if (response?._meta?.kind) out.kind = response._meta.kind;
  else if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    if (obj._meta?.kind) out.kind = obj._meta.kind;
  } else {
    const head = text.slice(0, 400);
    if (/\bnot found\b/i.test(head)) out.kind = 'not-found';
    else if (/^## Error|\berror\b.*\binvalid-input\b|_error_/i.test(head)) out.kind = 'error';
    else if (/\bno (rows|results|matches|references|usages)\b|\b0 (rows|results)\b/i.test(head)) out.kind = 'empty';
  }
  const src = obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
  if (src) {
    if (typeof src.has_more === 'boolean') out.has_more = src.has_more;
    const rows = ['result_count', 'total_count', 'field_count', 'row_count', 'count'].map((k) => src[k]).find((v) => Number.isInteger(v));
    if (Number.isInteger(rows)) out.rows = rows;
    const cov = ['field_limit_hit', 'provenance_omitted', 'isv_not_scanned', 'isv_excluded', 'partial_build'].filter((k) => src[k]);
    if (cov.length) out.coverage = cov;
  } else if (/has_more:\s*true|_has more_|pass `cursor`/i.test(text)) out.has_more = true;
  return out;
}

function onPostToolUse(cfg, input, failed) {
  const parsed = parseToolName(input.tool_name);
  if (!parsed) return [];
  const now = new Date().toISOString();
  const out = [];
  withLock(input.session_id || 'unknown', () => {
    const { state, path } = loadState(input, now);
    const id = input.tool_use_id;
    if (id && state.done.includes(id)) return; // second registration of the same hook
    const call = (id && state.calls[id]) || { launch_ts: now, launch_seq: ++state.launch_seq, tool: parsed.tool, service: parsed.service, args: input.tool_input ?? {} };
    const result = resultFromResponse(input.tool_response, failed);
    result.duration_ms = Math.max(0, Date.parse(now) - Date.parse(call.launch_ts));
    const ctx = context(cfg, state, call.service);
    out.push(callRecord(ctx, { tool: call.tool, rawArgs: call.args, policies: policiesFor(call.tool), result, launch_seq: call.launch_seq, ts: call.launch_ts }));
    state.emitted += 1;
    if (id) { delete state.calls[id]; state.done.push(id); if (state.done.length > 200) state.done.splice(0, state.done.length - 200); }
    saveState(path, state);
  });
  return out;
}

function onStop(cfg, input) {
  if (input.stop_hook_active) return [];
  const now = new Date().toISOString();
  const out = [];
  withLock(input.session_id || 'unknown', () => {
    const { state, path } = loadState(input, now);
    if (!state.opened || state.closed) return;
    for (const call of Object.values(state.calls)) {
      out.push(callRecord(context(cfg, state, call.service), { tool: call.tool, rawArgs: call.args, policies: policiesFor(call.tool), result: { kind: 'unfinished', bytes: 0 }, launch_seq: call.launch_seq, ts: call.launch_ts }));
      state.emitted += 1;
    }
    state.calls = {};
    let summary = typeof input.last_assistant_message === 'string' ? input.last_assistant_message : '';
    if (!summary) {
      const turn = currentTurn(readTranscriptRecords(input.transcript_path));
      summary = turn ? turn.texts.map((t) => t.text).join('\n\n') : '';
    }
    summary = parseProtocolLines(summary).rest || summary;
    const ctx = context(cfg, state, state.service || 'kb');
    out.push(claudeRecord(ctx, 'close', { conclusion: { summary: summary || '(no final message captured)', outcome: summary ? 'answered' : 'partial' }, calls: state.emitted }, now));
    state.closed = true;
    clearCurrent(state);
    saveState(path, state);
  });
  return out;
}

/* ── main ──────────────────────────────────────────────────────────────────── */

export async function run(input, cfg = readConfig()) {
  if (!cfg) return;
  const event = input.hook_event_name || process.argv[2] || '';
  let records = [];
  switch (event) {
    case 'UserPromptSubmit': records = onUserPromptSubmit(cfg, input); break;
    case 'PreToolUse': records = onPreToolUse(cfg, input); break;
    case 'PostToolUse': records = onPostToolUse(cfg, input, false); break;
    case 'PostToolUseFailure': records = onPostToolUse(cfg, input, true); break;
    case 'Stop': records = onStop(cfg, input); break;
    default: return;
  }
  if (records.length) await emit(cfg, records);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  run(readStdin())
    .catch((e) => { debug('error', e.message); log(`hook error: ${e.message}`); })
    .finally(() => process.exit(0));
}
