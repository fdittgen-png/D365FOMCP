/**
 * Trace contract v1 — record builders shared by the hook and the server
 * (`source: hook` / `source: server`). Dependency-free; copied into the plugin.
 *
 * A builder returns an UNSANITIZED record; the caller passes it through
 * `sanitize()` before it reaches any writer or file.
 */
import { createHash } from 'node:crypto';
import { CONTRACT_VERSION, makeId } from './identifiers.js';
import { applyArgPolicies, touchedFromArgs } from './arg-policies.js';

/** 32-hex session key. `hour` mode = sha256(salt | yyyy-mm-ddThh) (TDD §4); a
 *  client token (Claude Code `session_id`) is hashed the same way — never the
 *  raw id, never anything person-derived. */
export function sessionKey(token, salt = 'local') {
  return createHash('sha256').update(`${salt}|${token}`).digest('hex').slice(0, 32);
}

export function hourToken(now = new Date()) {
  return now.toISOString().slice(0, 13);
}

/** Common envelope. `ctx` = { erp, mcp, investigation_id?, session_key, seq, source }. */
export function envelope(stream, ctx, now = new Date()) {
  const rec = {
    id: makeId(stream, now.getTime()),
    contract_version: CONTRACT_VERSION,
    stream,
    ts: now.toISOString(),
    erp: { system: ctx.erp?.system ?? 'D365FO', installation_id: ctx.erp?.installation_id ?? 'local' },
    mcp: { service: ctx.mcp?.service ?? 'unknown' },
    session_key: ctx.session_key,
    seq: ctx.seq,
    source: ctx.source,
  };
  if (ctx.erp?.version) rec.erp.version = ctx.erp.version;
  if (ctx.erp?.build) rec.erp.build = ctx.erp.build;
  if (ctx.mcp?.version) rec.mcp.version = ctx.mcp.version;
  if (ctx.mcp?.snapshot_date) rec.mcp.snapshot_date = ctx.mcp.snapshot_date;
  if (ctx.investigation_id) rec.investigation_id = ctx.investigation_id;
  return rec;
}

/**
 * Stream 1 call record (TDD §5.2). `result` = { kind, bytes, rows?, has_more?, duration_ms?, coverage? }.
 * `policies` is the tool's parameter → policy table (may be empty: type-derived defaults apply).
 * @param {object} ctx
 * @param {{ tool: string, rawArgs?: object, policies?: object, result?: any, launch_seq?: number, ts?: string }} call
 */
export function callRecord(ctx, call) {
  const { tool, rawArgs, policies, result, launch_seq, ts } = call;
  const rec = envelope('mcp', ctx, ts ? new Date(ts) : new Date());
  const { args, coverage } = applyArgPolicies(rawArgs, policies);
  rec.tool = { name: tool, args };
  if (Number.isInteger(launch_seq)) rec.launch_seq = launch_seq;
  rec.result = { kind: result?.kind ?? 'unfinished', bytes: result?.bytes ?? 0 };
  if (Number.isInteger(result?.rows)) rec.result.rows = result.rows;
  if (typeof result?.has_more === 'boolean') rec.result.has_more = result.has_more;
  if (Number.isInteger(result?.duration_ms)) rec.result.duration_ms = result.duration_ms;
  const cov = [...new Set([...(result?.coverage ?? []), ...coverage])];
  if (cov.length) rec.result.coverage = cov;
  const touched = touchedFromArgs(args);
  if (touched.length) rec.touched = touched;
  if (typeof rawArgs?.functional_context === 'string') rec.functional_context = rawArgs.functional_context;
  return rec;
}

/** Stream 2 record (TDD §5.3): `body` carries the phase-specific keys. */
export function claudeRecord(ctx, phase, body, ts) {
  const rec = envelope('claude', ctx, ts ? new Date(ts) : new Date());
  rec.phase = phase;
  rec.investigation = { id: ctx.investigation_id, ...(body.investigation ?? {}) };
  for (const [k, v] of Object.entries(body)) if (k !== 'investigation' && v !== undefined) rec[k] = v;
  return rec;
}
