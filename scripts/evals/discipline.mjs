/**
 * Discipline metrics for the evals (issue #119, W6 of the token-efficiency
 * concept): the numbers that say HOW a model used the tools, not only whether
 * it got the answer. "Evals measure discipline, not tool choice."
 *
 * Everything here is pure: it takes the tools list (`client.listTools()` shape,
 * name + inputSchema) and a call log of `{ tool, arg_keys }` — names and
 * argument KEYS only, never values or payloads (privacy rule of #119).
 */

/** `limit`, `field_limit`, `max_depth`, `entity_permission_limit`, … */
export const LIMIT_KEY_RE = /^(limit|\w+_limit|max_\w+)$/;
/** Narrowing filters — the shared ones by name, the per-tool ones by suffix. */
export const FILTER_KEY_RE = /^(filter|modules|object_type|element_type|kind|direction|edge_type|scenario|origin|layer|publisher|dimension|min_confidence|min_severity)$|_like$|_only$|_filter$/;
/** Multi-target batch arrays (issue #83 and the W3 batches). */
export const BATCH_KEYS = Object.freeze(['enum_names', 'tables', 'method_names', 'queries', 'objects', 'object_names', 'role_names']);
export const CURSOR_KEY = 'cursor';

/**
 * Which discipline levers a tool's inputSchema offers.
 * @returns {{limit: boolean, filter: boolean, batch: boolean, cursor: boolean, any: boolean}}
 */
export function toolLevers(inputSchema) {
  const keys = Object.keys(inputSchema?.properties ?? {});
  const levers = {
    limit: keys.some(k => LIMIT_KEY_RE.test(k)),
    filter: keys.some(k => FILTER_KEY_RE.test(k)),
    batch: keys.some(k => BATCH_KEYS.includes(k)),
    cursor: keys.includes(CURSOR_KEY),
  };
  levers.any = levers.limit || levers.filter || levers.batch || levers.cursor;
  return levers;
}

/** Which levers one call actually pulled, given its argument keys. */
export function callLevers(argKeys) {
  const keys = Array.isArray(argKeys) ? argKeys : [];
  const levers = {
    limit: keys.some(k => LIMIT_KEY_RE.test(k)),
    filter: keys.some(k => FILTER_KEY_RE.test(k)),
    batch: keys.some(k => BATCH_KEYS.includes(k)),
    cursor: keys.includes(CURSOR_KEY),
  };
  levers.any = levers.limit || levers.filter || levers.batch || levers.cursor;
  return levers;
}

/** Map tool name -> levers offered, from a tools list. */
export function indexToolLevers(tools) {
  const idx = new Map();
  for (const t of tools ?? []) idx.set(t.name, toolLevers(t.inputSchema));
  return idx;
}

/**
 * discipline_rate = calls that used at least one lever the tool offers, over
 * calls to tools that offer any lever. Calls to lever-less tools (e.g.
 * `d365_get_join_keys`, `taskrecorder_to_markdown`) are neither rewarded nor
 * penalised — they leave the denominator. Unknown tool names count as
 * lever-less. Returns null when the denominator is 0.
 */
export function disciplineRate(calls, leverIndex) {
  let offered = 0;
  let used = 0;
  for (const c of calls ?? []) {
    const offers = leverIndex.get(c.tool);
    if (!offers?.any) continue;
    offered++;
    const pulled = callLevers(c.arg_keys);
    if ((offers.limit && pulled.limit) || (offers.filter && pulled.filter) || (offers.batch && pulled.batch) || (offers.cursor && pulled.cursor)) used++;
  }
  return offered === 0 ? null : used / offered;
}

/** Median of a numeric array (null when empty). */
export function median(values) {
  const xs = (values ?? []).filter(v => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const mid = xs.length >> 1;
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

/**
 * Per-service metrics over the per-question rows of a results file.
 * Each row: { pass, tool_calls: [{tool, arg_keys}], structured_bytes,
 *             first_call_correct (bool|null), over_fetch (bool|null) }.
 */
export function serviceMetrics(rows, leverIndex) {
  const n = rows.length;
  const allCalls = rows.flatMap(r => r.tool_calls ?? []);
  const fcc = rows.filter(r => typeof r.first_call_correct === 'boolean');
  const budgeted = rows.filter(r => typeof r.over_fetch === 'boolean');
  const pct = (x) => (x === null ? null : Math.round(x * 1000) / 10);
  return {
    questions: n,
    passed: rows.filter(r => r.pass).length,
    pass_rate: n ? pct(rows.filter(r => r.pass).length / n) : null,
    median_tool_calls: median(rows.map(r => (r.tool_calls ?? []).length)),
    median_structured_bytes: median(rows.map(r => r.structured_bytes)),
    median_text_bytes: median(rows.map(r => r.text_bytes)),
    discipline_rate: pct(disciplineRate(allCalls, leverIndex)),
    first_call_correct_rate: fcc.length ? pct(fcc.filter(r => r.first_call_correct).length / fcc.length) : null,
    over_fetch_count: budgeted.filter(r => r.over_fetch).length,
    budgeted_questions: budgeted.length,
    total_tool_calls: allCalls.length,
  };
}
