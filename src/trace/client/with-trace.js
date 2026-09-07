/**
 * Stream 1 on the server: `withTrace(name, handler, config, opts)` wraps a tool
 * handler so every call produces one call record (TDD §5.2, WI-07) —
 * `source: server`. The handler's result object is returned UNCHANGED (same
 * reference); the record is built from the arguments and five result keys
 * only (`_meta.kind`, `isError`, `structuredContent` size, `has_more`, the
 * coverage keys) and enqueued on the non-blocking writer. Any failure inside
 * the tracing path is swallowed: a trace must never be the reason a tool fails.
 *
 * Correlation on stdio: the Claude Code hook writes `~/.claude/mcp-trace/current`
 * (`{ investigation_id, ts }`) at PreToolUse, before the call reaches the
 * server; the wrapper reads it per call and stamps the id when it is < 8 h old.
 */
import { readFileSync } from 'node:fs';
import { callRecord, sessionKey, hourToken } from '../contract/record.js';
import { sanitize } from '../contract/sanitize.js';
import { argPolicies } from './zod-arg-types.js';
import { traceIdentity } from './identity.js';
import { traceEnabled, traceWriter } from './writer.js';

const COVERAGE_KEYS = ['field_limit_hit', 'provenance_omitted', 'isv_not_scanned', 'isv_excluded', 'partial_build'];
const TTL_MS = 8 * 3600 * 1000;

let seq = 0;

export function currentInvestigationPath(env = process.env) {
  const home = env.TRACE_HOME || env.USERPROFILE || env.HOME || '.';
  return `${home}/.claude/mcp-trace/current`;
}

/** Investigation id the hook announced for this machine, or null. */
export function currentInvestigation(env = process.env, now = Date.now()) {
  try {
    const cur = JSON.parse(readFileSync(currentInvestigationPath(env), 'utf8'));
    const ts = Date.parse(cur.ts ?? '');
    const ttl = Number(env.TRACE_INVESTIGATION_TTL_MS) || TTL_MS;
    if (typeof cur.investigation_id === 'string' && Number.isFinite(ts) && now - ts < ttl) return cur.investigation_id;
  } catch { /* no current investigation */ }
  return null;
}

/** The five result keys a call record may read — and nothing else. */
export function resultSummary(result) {
  const kind = result?._meta?.kind ?? (result?.isError ? 'error' : 'data');
  const sc = result?.structuredContent;
  let bytes = 0;
  if (sc !== undefined) bytes = Buffer.byteLength(JSON.stringify(sc), 'utf8');
  else if (Array.isArray(result?.content)) bytes = Buffer.byteLength(result.content.map((c) => c?.text ?? '').join(''), 'utf8');
  const out = { kind, bytes };
  if (sc && typeof sc === 'object') {
    if (typeof sc.has_more === 'boolean') out.has_more = sc.has_more;
    const rows = ['result_count', 'total_count', 'field_count', 'row_count', 'count'].map((k) => sc[k]).find((v) => Number.isInteger(v));
    if (Number.isInteger(rows)) out.rows = rows;
    const cov = COVERAGE_KEYS.filter((k) => sc[k]);
    if (cov.length) out.coverage = cov;
  }
  return out;
}

/**
 * @param {string} name tool name
 * @param {Function} handler original handler
 * @param {object} config registerTool config (for `inputSchema`)
 * @param {{ service?: string, db?: object, writer?: import('./writer.js').TraceWriter|null, env?: any }} [opts]
 */
export function withTrace(name, handler, config, { service, db = null, writer = null, env = process.env } = {}) {
  if (typeof handler !== 'function' || !traceEnabled(env)) return handler;
  let policies = null;
  const hasInput = !!config?.inputSchema;
  return async (...args) => {
    const t0 = Date.now();
    let result;
    let threw = null;
    try {
      result = await handler(...args);
    } catch (e) {
      threw = e;
    }
    try {
      policies ??= hasInput ? argPolicies(config.inputSchema) : {};
      const rawArgs = hasInput && args[0] && typeof args[0] === 'object' ? args[0] : {};
      const identity = traceIdentity(service, db);
      const summary = threw ? { kind: 'error', bytes: 0 } : resultSummary(result);
      summary.duration_ms = Date.now() - t0;
      const ctx = {
        ...identity,
        investigation_id: currentInvestigation(env),
        session_key: sessionKey(hourToken(), env.TRACE_SESSION_SALT || identity.erp.installation_id),
        seq: seq++,
        source: 'server',
      };
      const rec = callRecord(ctx, { tool: name, rawArgs, policies, result: summary, ts: new Date(t0).toISOString() });
      const s = sanitize(rec);
      if (s.ok) (writer ?? traceWriter(service, env)).enqueue(s.record);
    } catch { /* tracing never fails a call */ }
    if (threw) throw threw;
    return result;
  };
}
