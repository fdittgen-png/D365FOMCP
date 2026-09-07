/**
 * Trace contract v1 — the privacy choke point (TDD §6).
 *
 * `sanitize(record)` is the ONLY producer of a sanitized record: it returns a
 * frozen copy carrying `Symbol.for('mcp.trace.sanitized')`, or
 * `{ ok:false, reason, field }` — `reason` names the field, never the text.
 * Every writer/sink accepts branded records only. Dependency-free.
 */
import { isIdentifier, ID_RE } from './identifiers.js';
import { proseViolation, maskDigitRuns, FORBIDDEN_KEYS_RE, PERSON_KEY_RE } from './privacy.js';
import { TOUCHED_KINDS } from './arg-policies.js';

export const SANITIZED = Symbol.for('mcp.trace.sanitized');

export const PROSE_CAPS = Object.freeze({
  'request.interpreted': 600, 'request.approach': 400, 'investigation.title': 200, 'intent': 400,
  'note': 300, 'conclusion.summary': 6000, 'statement': 300, 'trigger': 150, 'retention': 200, 'action': 200,
});

const PHASES = new Set(['open', 'step', 'annotate', 'close']);
const RESULT_KINDS = new Set(['data', 'empty', 'not-found', 'error', 'unfinished']);
const ENTITIES_FROM = new Set(['declared', 'prompt', 'functional_context', 'vocabulary_match', 'none']);
const REQUEST_SOURCES = new Set(['interpretation', 'declared', 'user_prompt']);
const OUTCOMES = new Set(['answered', 'partial', 'abandoned']);

export function isSanitized(rec) {
  return !!rec && rec[SANITIZED] === true;
}

/** @returns {{ ok: false, reason: string, field: string }} */
function fail(reason, field) {
  return { ok: /** @type {false} */ (false), reason, field };
}

/** @returns {{ ok: true, body: any }} */
function ok(body) {
  return { ok: /** @type {true} */ (true), body };
}

/** Prose: mask digit runs, cap, denylist. Returns { text } or { error }. */
function prose(value, cap, field) {
  if (typeof value !== 'string') return { error: fail('not a string', field) };
  const { text } = maskDigitRuns(value);
  const capped = text.length > cap ? text.slice(0, cap) : text;
  const v = proseViolation(capped);
  return v ? { error: fail(v, field) } : { text: capped };
}

function identifierList(list, field, max, strict) {
  if (!Array.isArray(list)) return { error: fail('not an array', field) };
  const kept = [];
  for (const v of list) {
    if (isIdentifier(v)) kept.push(v);
    else if (strict) return { error: fail('identifier grammar', field) };
  }
  return { list: kept.slice(0, max) };
}

/** Keys that announce data or persons anywhere in the record (args keys are policy-controlled). */
function forbiddenKeyPath(obj, path = '') {
  if (!obj || typeof obj !== 'object') return null;
  for (const [k, v] of Object.entries(obj)) {
    const p = path ? `${path}.${k}` : k;
    if (path !== 'tool.args' && FORBIDDEN_KEYS_RE.test(k) && p !== 'result.rows') return p;
    if (path !== 'tool.args' && path !== 'tool' && PERSON_KEY_RE.test(k)) return p;
    if (v && typeof v === 'object') {
      const inner = forbiddenKeyPath(v, Array.isArray(obj) ? path : p);
      if (inner) return inner;
    }
  }
  return null;
}

function envelope(rec) {
  if (!rec || typeof rec !== 'object') return fail('not an object', '');
  if (!ID_RE.test(rec.id ?? '')) return fail('id grammar', 'id');
  if (!/^1\.\d+\.\d+$/.test(rec.contract_version ?? '')) return fail('contract_version', 'contract_version');
  if (rec.stream !== 'mcp' && rec.stream !== 'claude') return fail('stream', 'stream');
  if (!rec.id.startsWith(`${rec.stream}_`)) return fail('id/stream mismatch', 'id');
  if (typeof rec.ts !== 'string' || Number.isNaN(Date.parse(rec.ts))) return fail('ts', 'ts');
  if (!rec.erp || !isIdentifier(rec.erp.system) || !isIdentifier(rec.erp.installation_id)) return fail('erp identity', 'erp');
  if (rec.erp.version != null && !isIdentifier(rec.erp.version)) return fail('identifier grammar', 'erp.version');
  if (!rec.mcp || !isIdentifier(rec.mcp.service)) return fail('mcp.service', 'mcp.service');
  if (rec.investigation_id != null && !isIdentifier(rec.investigation_id)) return fail('identifier grammar', 'investigation_id');
  if (rec.stream === 'claude' && !rec.investigation_id) return fail('missing', 'investigation_id');
  if (!/^[0-9a-f]{32}$/.test(rec.session_key ?? '')) return fail('session_key', 'session_key');
  if (!Number.isInteger(rec.seq) || rec.seq < 0) return fail('seq', 'seq');
  if (rec.source !== 'server' && rec.source !== 'hook') return fail('source', 'source');
  return null;
}

function sanitizeMcp(rec) {
  const out = {};
  if (!rec.tool || !isIdentifier(rec.tool.name)) return fail('tool.name', 'tool.name');
  const args = {};
  for (const [k, v] of Object.entries(rec.tool.args ?? {})) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') args[k] = v;
    else if (Array.isArray(v)) { const r = identifierList(v, `tool.args.${k}`, 50, false); if (r.list.length) args[k] = r.list; }
    else if (v && typeof v === 'object' && typeof v.sha256 === 'string') args[k] = { sha256: v.sha256, bytes: Number(v.bytes) || 0 };
  }
  out.tool = { name: rec.tool.name, args };
  if (Number.isInteger(rec.launch_seq)) out.launch_seq = rec.launch_seq;
  const r = rec.result ?? {};
  if (!RESULT_KINDS.has(r.kind)) return fail('result.kind', 'result.kind');
  out.result = { kind: r.kind, bytes: Number.isInteger(r.bytes) && r.bytes >= 0 ? r.bytes : 0 };
  if (Number.isInteger(r.rows)) out.result.rows = r.rows;
  if (typeof r.has_more === 'boolean') out.result.has_more = r.has_more;
  if (Number.isInteger(r.duration_ms)) out.result.duration_ms = r.duration_ms;
  if (Array.isArray(r.coverage)) out.result.coverage = r.coverage.filter(isIdentifier).slice(0, 20);
  if (Array.isArray(rec.touched)) {
    out.touched = [];
    for (const t of rec.touched) {
      if (!t || !TOUCHED_KINDS.includes(t.kind) || !isIdentifier(t.name)) continue; // Stream 1 drops
      const row = { kind: t.kind, name: t.name };
      if (isIdentifier(t.owner)) row.owner = t.owner;
      out.touched.push(row);
      if (out.touched.length >= 200) break;
    }
  }
  if (rec.functional_context != null && isIdentifier(rec.functional_context)) out.functional_context = rec.functional_context;
  return ok(out);
}

function sanitizeClaude(rec) {
  if (!PHASES.has(rec.phase)) return fail('phase', 'phase');
  const out = { phase: rec.phase };
  if (!rec.investigation || rec.investigation.id !== rec.investigation_id) return fail('investigation.id', 'investigation.id');
  out.investigation = { id: rec.investigation.id };
  switch (rec.phase) {
    case 'open': {
      const inv = rec.investigation;
      if (inv.title != null) { const p = prose(inv.title, PROSE_CAPS['investigation.title'], 'investigation.title'); if (p.error) return p.error; out.investigation.title = p.text; }
      if (inv.purpose != null) { if (!isIdentifier(inv.purpose)) return fail('enum', 'investigation.purpose'); out.investigation.purpose = inv.purpose; }
      const req = rec.request;
      if (!req || !isIdentifier(req.key)) return fail('identifier grammar', 'request.key');
      const interp = prose(req.interpreted, PROSE_CAPS['request.interpreted'], 'request.interpreted');
      if (interp.error) return interp.error;
      out.request = { key: req.key, interpreted: interp.text };
      if (req.approach != null) { const p = prose(req.approach, PROSE_CAPS['request.approach'], 'request.approach'); if (p.error) return p.error; out.request.approach = p.text; }
      if (req.source != null) { if (!REQUEST_SOURCES.has(req.source)) return fail('enum', 'request.source'); out.request.source = req.source; }
      const ents = identifierList(rec.expected_entities ?? null, 'expected_entities', 20, true);
      if (ents.error) return ents.error;
      out.expected_entities = ents.list;
      if (!ENTITIES_FROM.has(rec.entities_from)) return fail('enum', 'entities_from');
      out.entities_from = rec.entities_from;
      break;
    }
    case 'step': {
      if (!Number.isInteger(rec.n) || rec.n < 1) return fail('n', 'n');
      out.n = rec.n;
      const p = prose(rec.intent, PROSE_CAPS.intent, 'intent');
      if (p.error) return p.error;
      out.intent = p.text;
      if (rec.expects != null) { const e = identifierList(rec.expects, 'expects', 20, true); if (e.error) return e.error; out.expects = e.list; }
      break;
    }
    case 'annotate': {
      if (!Array.isArray(rec.entities)) return fail('entities', 'entities');
      out.entities = [];
      for (const e of rec.entities.slice(0, 50)) {
        if (!e || !isIdentifier(e.kind) || !isIdentifier(e.name) || !isIdentifier(e.role)) return fail('identifier grammar', 'entities[]');
        const row = { kind: e.kind, name: e.name, role: e.role };
        if (e.level != null) { if (!isIdentifier(e.level)) return fail('enum', 'entities[].level'); row.level = e.level; }
        if (e.functional_entity != null) { if (!isIdentifier(e.functional_entity)) return fail('identifier grammar', 'entities[].functional_entity'); row.functional_entity = e.functional_entity; }
        if (e.counterpart) { if (!isIdentifier(e.counterpart.erp) || !isIdentifier(e.counterpart.name)) return fail('identifier grammar', 'entities[].counterpart'); row.counterpart = { erp: e.counterpart.erp, name: e.counterpart.name }; }
        out.entities.push(row);
      }
      if (rec.note != null) { const p = prose(rec.note, PROSE_CAPS.note, 'note'); if (p.error) return p.error; out.note = p.text; }
      break;
    }
    case 'close': {
      const c = rec.conclusion;
      if (!c) return fail('missing', 'conclusion');
      const p = prose(c.summary, PROSE_CAPS['conclusion.summary'], 'conclusion.summary');
      if (p.error) return p.error;
      if (!OUTCOMES.has(c.outcome)) return fail('enum', 'conclusion.outcome');
      out.conclusion = { summary: p.text, outcome: c.outcome };
      if (Array.isArray(c.differences)) {
        out.conclusion.differences = [];
        for (const d of c.differences.slice(0, 50)) {
          if (!d || !isIdentifier(d.aspect)) return fail('enum', 'conclusion.differences[].aspect');
          const s = prose(d.statement, PROSE_CAPS.statement, 'conclusion.differences[].statement');
          if (s.error) return s.error;
          out.conclusion.differences.push({ aspect: d.aspect, statement: s.text });
        }
      }
      if (Number.isInteger(rec.calls)) out.calls = rec.calls;
      break;
    }
  }
  return ok(out);
}

/**
 * @returns {{ ok: true, record: any } | { ok: false, reason: string, field: string }}
 */
export function sanitize(record) {
  const envErr = envelope(record);
  if (envErr) return envErr;
  const body = record.stream === 'mcp' ? sanitizeMcp(record) : sanitizeClaude(record);
  if (body.ok !== true) return body;
  const out = {
    id: record.id, contract_version: record.contract_version, stream: record.stream, ts: record.ts,
    erp: { system: record.erp.system, installation_id: record.erp.installation_id },
    mcp: { service: record.mcp.service },
    session_key: record.session_key, seq: record.seq, source: record.source,
    ...body.body,
  };
  if (record.erp.version != null) out.erp.version = record.erp.version;
  if (isIdentifier(record.erp.build)) out.erp.build = record.erp.build;
  if (isIdentifier(record.mcp.version)) out.mcp.version = record.mcp.version;
  if (typeof record.mcp.snapshot_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(record.mcp.snapshot_date)) out.mcp.snapshot_date = record.mcp.snapshot_date;
  if (record.investigation_id) out.investigation_id = record.investigation_id;
  const bad = forbiddenKeyPath(out);
  if (bad) return fail('forbidden key', bad);
  Object.defineProperty(out, SANITIZED, { value: true, enumerable: false });
  return { ok: /** @type {true} */ (true), record: deepFreeze(out) };
}

function deepFreeze(o) {
  if (o && typeof o === 'object') {
    for (const v of Object.values(o)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}
