/**
 * Trace contract v1 — argument policies and touched names (TDD §6, WI-06).
 *
 * `args` are the replay: every parameter of a call is kept under a policy or
 * dropped and counted. This file holds the POLICY APPLICATION and the name →
 * policy overrides; the Zod introspection that derives a tool's policy table
 * lives server-side in `src/trace/client/zod-arg-types.js` (it needs the
 * registered schemas) and is written out for the hook by
 * `build/gen-trace-hook.js` as `arg-policies.json`. Dependency-free.
 */
import { createHash } from 'node:crypto';
import { isIdentifier } from './identifiers.js';
import { termViolation } from './privacy.js';

export const POLICIES = Object.freeze([
  'identifier', 'number', 'boolean', 'identifier[]', 'term', 'sql_shape', 'payload_ref', 'redacted', 'name_list',
]);

/** Name-based overrides, checked before the type-derived default. Order matters. */
/** @type {ReadonlyArray<[RegExp, string]>} */
export const NAME_OVERRIDES = Object.freeze([
  [/^(sql|query_sql)$/i, 'sql_shape'],
  [/(recording|xml|docx|repro|content|file)$/i, 'payload_ref'],
  [/(^|_)(user|users|principal|upn|person|email)(_|$)/i, 'redacted'],
  [/^(query|queries|search_term|term|text|pattern|question)$/i, 'term'],
]);

/** Policy for one parameter from its name and JSON-ish type. */
export function policyFor(name, type) {
  for (const [re, policy] of NAME_OVERRIDES) if (re.test(name)) return policy;
  switch (type) {
    case 'string': return 'identifier';
    case 'number': case 'integer': return 'number';
    case 'boolean': return 'boolean';
    case 'string[]': return 'identifier[]';
    case 'object[]': return 'name_list'; // [{ name, type? }] batch targets (xref_check_exists.objects)
    default: return null; // no policy → dropped, args_partial
  }
}

/** Mask every string and numeric literal in SQL text with `?`; keep the shape. */
export function sqlShape(sql) {
  return String(sql ?? '')
    .replace(/'(?:[^']|'')*'/g, '?')
    .replace(/"(?:[^"]|"")*"/g, (m) => (/^"[A-Za-z_][A-Za-z0-9_]*"$/.test(m) ? m : '?'))
    .replace(/\b\d+(?:\.\d+)?\b/g, '?')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2000);
}

/** Fingerprint of a payload the replay cannot regenerate (Task Recorder input). */
export function payloadRef(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return { sha256: createHash('sha256').update(text).digest('hex'), bytes: Buffer.byteLength(text, 'utf8') };
}

function applyOne(policy, value) {
  switch (policy) {
    case 'identifier':
      if (Array.isArray(value)) return applyOne('identifier[]', value);
      return isIdentifier(value) ? { keep: value } : { drop: 'args_redacted' };
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? { keep: value } : { drop: 'args_partial' };
    case 'boolean':
      return typeof value === 'boolean' ? { keep: value } : { drop: 'args_partial' };
    case 'identifier[]': {
      const arr = Array.isArray(value) ? value : [value];
      const kept = arr.filter(isIdentifier).slice(0, 50);
      return kept.length ? { keep: kept, partial: kept.length !== arr.length } : { drop: 'args_redacted' };
    }
    case 'term': {
      if (Array.isArray(value)) {
        const kept = value.filter((v) => typeof v === 'string' && !termViolation(v)).slice(0, 50);
        return kept.length ? { keep: kept, partial: kept.length !== value.length } : { drop: 'args_redacted' };
      }
      return typeof value === 'string' && !termViolation(value) ? { keep: value } : { drop: 'args_redacted' };
    }
    case 'name_list': {
      const arr = Array.isArray(value) ? value : [value];
      const kept = arr
        .map((o) => (o && typeof o === 'object' ? (isIdentifier(o.type) ? `${o.type}:${o.name}` : o.name) : o))
        .filter(isIdentifier)
        .slice(0, 50);
      return kept.length ? { keep: kept, partial: kept.length !== arr.length } : { drop: 'args_redacted' };
    }
    case 'sql_shape':
      return typeof value === 'string' ? { keep: sqlShape(value) } : { drop: 'args_partial' };
    case 'payload_ref':
      return { keep: payloadRef(value) };
    case 'redacted':
      return { keep: '<redacted>' };
    default:
      return { drop: 'args_partial' };
  }
}

/**
 * Apply a tool's policy table to the raw call arguments.
 * @returns {{ args: object, coverage: string[] }} — `coverage` ⊆ ['args_partial','args_redacted']
 */
export function applyArgPolicies(rawArgs, policies = {}) {
  const args = {};
  const coverage = new Set();
  for (const [name, value] of Object.entries(rawArgs ?? {})) {
    if (value === undefined || value === null) continue;
    const policy = policies[name] ?? policyFor(name, jsType(value));
    if (!policy) { coverage.add('args_partial'); continue; }
    const r = applyOne(policy, value);
    if ('keep' in r) {
      args[name] = r.keep;
      if (r.partial) coverage.add('args_redacted');
    } else coverage.add(r.drop);
  }
  return { args, coverage: [...coverage].sort() };
}

/** JSON-ish type of a runtime value, for the type-derived default when no table exists. */
export function jsType(v) {
  if (Array.isArray(v)) {
    if (v.every((x) => typeof x === 'string')) return 'string[]';
    if (v.length && v.every((x) => x && typeof x === 'object' && typeof x.name === 'string')) return 'object[]';
    return 'other';
  }
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return typeof v;
  return 'other';
}

/* ── touched names ─────────────────────────────────────────────────────────── */

export const TOUCHED_KINDS = Object.freeze([
  'table', 'field', 'edt', 'enum', 'class', 'method', 'data_entity', 'form', 'menu_item',
  'role', 'duty', 'privilege', 'model', 'recording', 'other',
]);

/** Parameter name → touched kind. Only names that carry an OBJECT name. */
/** @type {ReadonlyArray<[RegExp, string]>} */
const TOUCHED_PARAMS = Object.freeze([
  [/^(table_name|tables|primary_table|table)$/, 'table'],
  [/^(entity_name|entity_names|entity)$/, 'data_entity'],
  [/^(class_name|owner_name|owner|type_name)$/, 'class'],
  [/^(method_name|method)$/, 'method'],
  [/^(enum_name|enum_names)$/, 'enum'],
  [/^(field_name|field_names|field)$/, 'field'],
  [/^(form_name|form)$/, 'form'],
  [/^(menu_item|menu_items|entry_point|entry_points)$/, 'menu_item'],
  [/^(role_name|role_names|roles|role)$/, 'role'],
  [/^(duty_name|duties|duty)$/, 'duty'],
  [/^(privilege_name|privileges|privilege)$/, 'privilege'],
  [/^(module|modules|model|models|module_name)$/, 'model'],
  [/^(object_name|object_names|objects|name)$/, 'other'],
]);

/** Object names the call was ABOUT, from its (already policy-filtered) args. ≤ 200. */
export function touchedFromArgs(args) {
  const out = [];
  const owner = typeof args?.table_name === 'string' ? args.table_name : typeof args?.class_name === 'string' ? args.class_name : undefined;
  for (const [name, value] of Object.entries(args ?? {})) {
    const kind = TOUCHED_PARAMS.find(([re]) => re.test(name))?.[1];
    if (!kind) continue;
    const names = Array.isArray(value) ? value : [value];
    for (const raw of names) {
      // name_list entries are `type:Name`; the type is the touched kind when the contract knows it
      const m = typeof raw === 'string' ? /^([a-z_]+):([^:]+)$/.exec(raw) : null;
      const n = m ? m[2] : raw;
      const k = m && TOUCHED_KINDS.includes(m[1]) ? m[1] : kind;
      if (!isIdentifier(n) || /[%*]/.test(n)) continue; // wildcards are a search, not an object
      const row = { kind: k, name: n };
      if ((kind === 'field' || kind === 'method') && owner && owner !== n) row.owner = owner;
      out.push(row);
      if (out.length >= 200) return out;
    }
  }
  return out;
}

/* ── tool name → service ──────────────────────────────────────────────────── */

/** @type {ReadonlyArray<[RegExp, string]>} */
const SERVICE_PREFIXES = Object.freeze([
  [/^mcp__(d365kb|claude_ai_D365_KB|plugin_d365fo-mcp_kb)__/i, 'kb'],
  [/^mcp__(d365xref|claude_ai_D365_xRef|plugin_d365fo-mcp_xref)__/i, 'xref'],
  [/^mcp__(d365sec|claude_ai_D365_Sec|plugin_d365fo-mcp_sec)__/i, 'sec'],
  [/^mcp__(d365taskrecorder|claude_ai_D365_Task_recorder|plugin_d365fo-mcp_taskrecorder)__/i, 'taskrecorder'],
  [/^mcp__(d365labels|claude_ai_D365_Labels|plugin_d365fo-mcp_labels)__/i, 'labels'],
]);

/** `mcp__<server>__<tool>` → { service, tool } for the D365FO services, else null. */
export function parseToolName(fullName) {
  for (const [re, service] of SERVICE_PREFIXES) {
    const m = re.exec(String(fullName ?? ''));
    if (m) return { service, tool: String(fullName).slice(m[0].length) };
  }
  return null;
}
