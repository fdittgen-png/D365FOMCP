/**
 * Trace Insight snapshot builder — docs/ERP-Trace-Insight-Service-Concept-2026-09-11.md §3.
 *
 * Reads EVERY trace record in the local sink directory (`~/.claude/mcp-trace`):
 * the hook stream (`open`/`step`/`annotate`/`close` + one hook-side record per
 * KB/XRef/Labels call) and the server stream of all four stdio servers (kb,
 * xref, labels, sec) — pending `*.ndjson` files and the `*.ndjson.<stamp>.sent`
 * files alike. `probe.ndjson` and `probe/` are test output and skipped.
 *
 * Writes `d365fo_insight.sqlite` (better-sqlite3, a few MB, seconds):
 *   investigations · calls · touched · entity_usage · recipes · insight_metadata
 *
 * `analyzeTraces()` is the pure model (records in, tables out) and is what the
 * tests exercise; `buildInsightDb()` is the file-to-file wrapper. Hook/server
 * twins of one call are paired by argument SUBSET inside a 10 s window, the
 * same rule as ClaudeTrace `src/report/analyze.js` — server args carry the Zod
 * defaults the hook never saw, so equality would miss most pairs.
 *
 * Privacy: the input already passed `sanitize()` (the only producer any sink
 * accepts). This builder adds no field class and DROPS the `sql` argument of
 * raw-SQL calls — they are kept as `waste_class = 'unreplayable'` with a count.
 * Response payloads never existed in a record (R0) and do not exist here.
 */

import { createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

export const INSIGHT_SCHEMA_VERSION = '1.0';
export const TWIN_WINDOW_MS = 10_000;

const HOME = () => process.env.USERPROFILE || process.env.HOME || '.';
export const DEFAULT_INSIGHT_DB = () => join(HOME(), '.claude', 'd365fo_insight.sqlite');
export const DEFAULT_TRACE_DIR = () => join(HOME(), '.claude', 'mcp-trace');
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_VOCABULARY = () => join(REPO_ROOT, 'config', 'semantic-vocabulary.json');

export const INSIGHT_SCHEMA = `
CREATE TABLE IF NOT EXISTS investigations (
  investigation_id TEXT PRIMARY KEY,
  request_key      TEXT COLLATE NOCASE,
  interpreted      TEXT,
  request_source   TEXT,
  purpose          TEXT,
  outcome          TEXT,
  erp              TEXT,
  session_key      TEXT,
  t0               TEXT,
  last             TEXT,
  calls            INTEGER NOT NULL DEFAULT 0,
  bytes            INTEGER NOT NULL DEFAULT 0,
  duration_ms      INTEGER NOT NULL DEFAULT 0,
  steps            INTEGER NOT NULL DEFAULT 0,
  calls_under_step INTEGER NOT NULL DEFAULT 0,
  expected_json    TEXT,
  hit_entities_json TEXT,
  snapshot_dates   TEXT,
  contract_version TEXT
);
CREATE INDEX IF NOT EXISTS idx_inv_request_key ON investigations(request_key COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS calls (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  investigation_id TEXT,
  session_key      TEXT,
  seq              INTEGER NOT NULL,
  ts               TEXT NOT NULL,
  service          TEXT,
  tool             TEXT NOT NULL,
  args_json        TEXT NOT NULL,
  source           TEXT NOT NULL,
  paired           INTEGER NOT NULL DEFAULT 0,
  kind             TEXT,
  bytes            INTEGER,
  rows             INTEGER,
  has_more         INTEGER NOT NULL DEFAULT 0,
  duration_ms      INTEGER,
  waste_class      TEXT,
  step_intent      TEXT,
  snapshot_date    TEXT
);
CREATE INDEX IF NOT EXISTS idx_calls_inv ON calls(investigation_id, seq);
CREATE INDEX IF NOT EXISTS idx_calls_tool ON calls(tool);

CREATE TABLE IF NOT EXISTS touched (
  call_id           INTEGER NOT NULL,
  investigation_id  TEXT,
  kind              TEXT NOT NULL,
  name              TEXT NOT NULL COLLATE NOCASE,
  owner             TEXT COLLATE NOCASE,
  functional_entity TEXT COLLATE NOCASE
);
CREATE INDEX IF NOT EXISTS idx_touched_entity ON touched(functional_entity COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_touched_name ON touched(name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS entity_usage (
  functional_entity TEXT NOT NULL COLLATE NOCASE,
  object_kind       TEXT NOT NULL,
  object_name       TEXT NOT NULL COLLATE NOCASE,
  field_name        TEXT COLLATE NOCASE,
  investigations    INTEGER NOT NULL,
  calls             INTEGER NOT NULL,
  last_seen         TEXT,
  contexts_json     TEXT NOT NULL,
  PRIMARY KEY (functional_entity, object_kind, object_name, field_name)
);

CREATE TABLE IF NOT EXISTS recipes (
  request_key      TEXT PRIMARY KEY COLLATE NOCASE,
  runs             INTEGER NOT NULL,
  erps_json        TEXT NOT NULL,
  outcomes_json    TEXT NOT NULL,
  best_investigation TEXT,
  best_calls       INTEGER,
  best_bytes       INTEGER,
  best_duration_ms INTEGER,
  best_ts          TEXT,
  median_calls     REAL,
  interpreted      TEXT,
  recipe_json      TEXT NOT NULL,
  touched_json     TEXT NOT NULL,
  waste_json       TEXT NOT NULL,
  entities_json    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS insight_metadata (key TEXT PRIMARY KEY, value TEXT);
`;

// ── input ────────────────────────────────────────────────────────────────────

/** Every NDJSON sink file in `dir` — pending and `.sent` — except the probe output. */
export function listTraceFiles(dir) {
  if (!dir || !existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /\.ndjson(\.[^/\\]+\.sent)?$/i.test(f) && !/^probe\.ndjson/i.test(f))
    .filter((f) => statSync(join(dir, f)).isFile())
    .sort()
    .map((f) => join(dir, f));
}

/** Parse NDJSON files; malformed lines are counted, never fatal. */
export function readRecords(files) {
  const records = []; let bad = 0;
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const s = line.trim(); if (!s) continue;
      try { const r = JSON.parse(s); if (r && typeof r === 'object' && r.stream) records.push(r); else bad++; } catch { bad++; }
    }
  }
  return { records, bad };
}

/** Vocabulary → lookup maps: lower-cased table / data entity / alias → entity id. */
export function vocabularyIndex(vocab) {
  const entities = Array.isArray(vocab?.entities) ? vocab.entities : [];
  const byTable = new Map(); const byDataEntity = new Map(); const byAlias = new Map(); const byId = new Map();
  for (const e of entities) {
    if (!e?.entity_id) continue;
    byId.set(e.entity_id.toLowerCase(), e);
    byAlias.set(e.entity_id.toLowerCase(), e.entity_id);
    if (e.name) byAlias.set(String(e.name).toLowerCase(), e.entity_id);
    for (const a of e.aliases ?? []) byAlias.set(String(a).toLowerCase(), e.entity_id);
    for (const t of e.d365fo?.primary_tables ?? []) byTable.set(String(t).toLowerCase(), e.entity_id);
    for (const d of e.d365fo?.data_entities ?? []) byDataEntity.set(String(d).toLowerCase(), e.entity_id);
  }
  return { entities, byTable, byDataEntity, byAlias, byId };
}

/** Confirmed/recorded mappings from a semantic store: lower(object_name) → entity id (highest confidence wins). */
export function readSemanticMappings(semanticDbPath) {
  if (!semanticDbPath || !existsSync(semanticDbPath)) return new Map();
  let db;
  try {
    db = new Database(semanticDbPath, { readonly: true });
    const rows = /** @type {any[]} */ (db.prepare("SELECT object_name, entity_id, confidence FROM sem_mappings WHERE role <> 'excluded' ORDER BY confidence DESC").all());
    const m = new Map();
    for (const r of rows) { const k = String(r.object_name).toLowerCase(); if (!m.has(k)) m.set(k, r.entity_id); }
    return m;
  } catch { return new Map(); } finally { try { db?.close(); } catch { /* ignore */ } }
}

// ── pure model ───────────────────────────────────────────────────────────────

const byTime = (a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : (a.seq ?? 0) - (b.seq ?? 0));
const isRawSql = (tool) => /_raw_sql$/i.test(String(tool ?? ''));

/** Arguments as recorded, minus `format` (presentation) and minus `sql` (privacy). */
export function replayArgs(tool, args) {
  const a = { ...(args ?? {}) };
  delete a.format;
  if (isRawSql(tool)) { delete a.sql; delete a.query_sql; }
  return a;
}

/** Same call recorded twice (hook + server)? Argument-subset match, `format` ignored. */
export function sameCall(a, b) {
  if ((a.tool?.name ?? '') !== (b.tool?.name ?? '')) return false;
  const aa = { ...(a.tool?.args ?? {}) }; const bb = { ...(b.tool?.args ?? {}) };
  delete aa.format; delete bb.format;
  const [small, big] = Object.keys(aa).length <= Object.keys(bb).length ? [aa, bb] : [bb, aa];
  return Object.keys(small).every((k) => k in big && JSON.stringify(small[k]) === JSON.stringify(big[k]));
}

/** Groups of twins `{ primary, also[] }`; primary = the server record when there is one. */
export function pairCalls(calls) {
  const sorted = calls.slice().sort(byTime);
  const out = []; const used = new Set();
  for (let i = 0; i < sorted.length; i++) {
    if (used.has(i)) continue;
    const g = { primary: sorted[i], also: [] };
    for (let j = i + 1; j < sorted.length; j++) {
      if (used.has(j)) continue;
      const dt = Date.parse(sorted[j].ts) - Date.parse(sorted[i].ts);
      if (dt > TWIN_WINDOW_MS) break;
      if (sorted[j].source === sorted[i].source) continue;
      if (sameCall(sorted[j], sorted[i])) { used.add(j); g.also.push(sorted[j]); break; }
    }
    const all = [g.primary, ...g.also];
    const server = all.find((r) => r.source === 'server');
    if (server) { g.primary = server; g.also = all.filter((r) => r !== server); }
    out.push(g);
  }
  return out;
}

const stableArgs = (o) => JSON.stringify(o, Object.keys(o ?? {}).sort());

/**
 * Waste class of one paired call within its ordered list (or null):
 *   empty | not-found | error   from result.kind
 *   repeat                      identical (tool, args) already made in the same investigation
 *   unfollowed_page             has_more=true and no later call of the same tool carrying a cursor
 *   unreplayable                raw_sql (the sink dead-letters its sql argument)
 */
export function classifyWaste(callViews) {
  const seen = new Set();
  for (let i = 0; i < callViews.length; i++) {
    const c = callViews[i];
    const key = `${c.tool}|${stableArgs(c.args)}`;
    let w = null;
    if (isRawSql(c.tool)) w = 'unreplayable';
    else if (c.kind === 'empty' || c.kind === 'not-found' || c.kind === 'error') w = c.kind;
    else if (seen.has(key)) w = 'repeat';
    else if (c.has_more) {
      const strip = (a) => { const b = { ...(a ?? {}) }; delete b.cursor; return stableArgs(b); };
      const followed = callViews.slice(i + 1).some((n) => n.tool === c.tool && n.args && typeof n.args.cursor === 'string' && n.args.cursor && strip(n.args) === strip(c.args));
      if (!followed) w = 'unfollowed_page';
    }
    seen.add(key);
    c.waste_class = w;
  }
  return callViews;
}

function resolveEntity(kind, name, owner, idx, semantic) {
  const lname = String(name ?? '').toLowerCase(); const lowner = String(owner ?? '').toLowerCase();
  if (kind === 'field' && lowner) {
    return idx.byTable.get(lowner) ?? semantic.get(lowner) ?? null;
  }
  if (kind === 'data_entity') return idx.byDataEntity.get(lname) ?? semantic.get(lname) ?? null;
  if (kind === 'table' || kind === 'other' || kind === 'form' || kind === 'menu_item') return idx.byTable.get(lname) ?? semantic.get(lname) ?? null;
  return semantic.get(lname) ?? null;
}

/** Field/owner normalisation: `touched` rows of kind field may carry `owner`, or `Table.Field` in name. */
function splitTouched(t) {
  let { kind, name, owner } = t;
  if (kind === 'field' && !owner && typeof name === 'string' && name.includes('.')) {
    const i = name.indexOf('.'); owner = name.slice(0, i); name = name.slice(i + 1);
  }
  return { kind: kind ?? 'other', name: String(name ?? ''), owner: owner ?? null };
}

const median = (xs) => { if (!xs.length) return null; const s = xs.slice().sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/**
 * The pure model: records → the six table row sets plus counters.
 * @param {any[]} records
 * @param {{ vocabulary?: any, semantic?: Map<string,string> }} [opts]
 */
export function analyzeTraces(records, { vocabulary = { entities: [] }, semantic = new Map() } = {}) {
  const idx = vocabularyIndex(vocabulary);
  const claude = records.filter((r) => r.stream === 'claude');
  const mcp = records.filter((r) => r.stream === 'mcp' && r.tool?.name);

  // Investigation shells from the hook lifecycle.
  /** @type {Map<string, any>} */
  const inv = new Map();
  const shell = (id) => { if (!inv.has(id)) inv.set(id, { investigation_id: id, steps: [], expected: [], entities: [], calls: [] }); return inv.get(id); };
  for (const r of claude.slice().sort(byTime)) {
    const id = r.investigation?.id ?? r.investigation_id; if (!id) continue;
    const s = shell(id);
    s.contract_version ??= r.contract_version ?? null;
    s.erp ??= r.erp?.system ?? null;
    s.session_key ??= r.session_key ?? null;
    if (r.phase === 'open') {
      s.request_key = r.request?.key ?? null; s.interpreted = r.request?.interpreted ?? null; s.request_source = r.request?.source ?? null;
      s.purpose = r.investigation?.purpose ?? null; s.t0 = r.ts;
      s.expected = Array.isArray(r.expected_entities) ? r.expected_entities.slice() : [];
    } else if (r.phase === 'step') {
      if (r.intent) s.steps.push({ ts: r.ts, intent: String(r.intent).slice(0, 200) });
    } else if (r.phase === 'annotate') {
      for (const e of r.entities ?? []) s.entities.push(e);
    } else if (r.phase === 'close') {
      s.outcome = r.conclusion?.outcome ?? s.outcome ?? null; s.last = r.ts;
    }
  }

  // Group call records by investigation (or session for the ones without).
  /** @type {Map<string, any[]>} */
  const groups = new Map();
  for (const r of mcp) {
    const key = r.investigation_id ? `inv:${r.investigation_id}` : `ses:${r.session_key ?? 'unknown'}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  const calls = []; const touched = []; let callId = 0; let paired = 0;
  /** @type {Map<string, any>} */
  const usage = new Map();
  const usageKey = (fe, k, n, f) => `${fe}|${k}|${n.toLowerCase()}|${(f ?? '').toLowerCase()}`;

  for (const [gkey, recs] of groups) {
    const invId = gkey.startsWith('inv:') ? gkey.slice(4) : null;
    const s = invId ? shell(invId) : null;
    const views = pairCalls(recs).map((g, i) => {
      const r = g.primary; const all = [r, ...g.also];
      if (g.also.length) paired++;
      const tch = all.map((x) => x.touched).find((t) => Array.isArray(t) && t.length) ?? [];
      const bytes = all.map((x) => x.result?.bytes).find((b) => Number.isFinite(b)) ?? null;
      const dur = all.map((x) => x.result?.duration_ms).find((b) => Number.isFinite(b)) ?? null;
      const stepIntent = s ? [...s.steps].filter((st) => st.ts <= r.ts).pop()?.intent ?? null : null;
      return {
        seq: i, ts: r.ts, tool: r.tool.name, service: r.mcp?.service ?? null, source: r.source ?? 'server', paired: g.also.length ? 1 : 0,
        args: replayArgs(r.tool.name, r.tool.args), kind: r.result?.kind ?? null, bytes, rows: r.result?.rows ?? null,
        has_more: r.result?.has_more === true, duration_ms: dur, snapshot_date: r.mcp?.snapshot_date ?? null,
        session_key: r.session_key ?? null, step_intent: stepIntent, touched: tch, waste_class: null,
      };
    });
    classifyWaste(views);
    for (const v of views) {
      const id = ++callId;
      calls.push({ id, investigation_id: invId, session_key: v.session_key, seq: v.seq, ts: v.ts, service: v.service, tool: v.tool, args_json: JSON.stringify(v.args), source: v.source, paired: v.paired, kind: v.kind, bytes: v.bytes, rows: v.rows, has_more: v.has_more ? 1 : 0, duration_ms: v.duration_ms, waste_class: v.waste_class, step_intent: v.step_intent, snapshot_date: v.snapshot_date });
      for (const t0 of v.touched) {
        const t = splitTouched(t0); if (!t.name) continue;
        const fe = resolveEntity(t.kind, t.name, t.owner, idx, semantic);
        touched.push({ call_id: id, investigation_id: invId, kind: t.kind, name: t.name, owner: t.owner, functional_entity: fe });
        if (fe) {
          const objKind = t.kind === 'field' ? 'table' : t.kind; const objName = t.kind === 'field' ? (t.owner ?? '') : t.name; const field = t.kind === 'field' ? t.name : null;
          const k = usageKey(fe, objKind, objName, field);
          if (!usage.has(k)) usage.set(k, { functional_entity: fe, object_kind: objKind, object_name: objName, field_name: field, invs: new Set(), calls: 0, last_seen: null, contexts: new Set() });
          const u = usage.get(k); u.calls++; if (invId) u.invs.add(invId); else u.invs.add(`ses:${v.session_key}`);
          if (!u.last_seen || v.ts > u.last_seen) u.last_seen = v.ts;
          const ctx = v.args?.functional_context ?? s?.request_key ?? null; if (ctx) u.contexts.add(String(ctx));
        }
      }
      if (s) s.calls.push({ ...v, id });
    }
  }

  // Investigation rows.
  const investigations = [];
  for (const s of inv.values()) {
    const cs = s.calls.slice().sort(byTime);
    const t0 = s.t0 ?? cs[0]?.ts ?? null; const last = s.last ?? cs[cs.length - 1]?.ts ?? t0;
    const hit = new Set(); for (const c of cs) for (const t of c.touched) { const st = splitTouched(t); const fe = resolveEntity(st.kind, st.name, st.owner, idx, semantic); if (fe) hit.add(fe); }
    const snaps = [...new Set(cs.map((c) => c.snapshot_date).filter(Boolean))].sort();
    investigations.push({
      investigation_id: s.investigation_id, request_key: s.request_key ?? null, interpreted: s.interpreted ? String(s.interpreted).slice(0, 200) : null,
      request_source: s.request_source ?? null, purpose: s.purpose ?? null, outcome: s.outcome ?? (s.last ? 'answered' : null), erp: s.erp ?? null, session_key: s.session_key ?? null,
      t0, last, calls: cs.length, bytes: cs.reduce((n, c) => n + (c.bytes ?? 0), 0), duration_ms: cs.reduce((n, c) => n + (c.duration_ms ?? 0), 0),
      steps: s.steps.length, calls_under_step: cs.filter((c) => c.step_intent).length,
      expected_json: JSON.stringify(s.expected), hit_entities_json: JSON.stringify([...hit].sort()), snapshot_dates: snaps.join(','), contract_version: s.contract_version ?? null,
    });
  }

  // Recipes per request key.
  const byKey = new Map();
  for (const i of investigations) { if (!i.request_key) continue; if (!byKey.has(i.request_key.toLowerCase())) byKey.set(i.request_key.toLowerCase(), []); byKey.get(i.request_key.toLowerCase()).push(i); }
  const recipes = [];
  for (const runs of byKey.values()) {
    const answered = runs.filter((r) => r.outcome === 'answered' && r.calls > 0);
    const pool = answered.length ? answered : runs.filter((r) => r.calls > 0);
    const best = pool.slice().sort((a, b) => a.calls - b.calls || a.bytes - b.bytes || (a.t0 < b.t0 ? 1 : -1))[0] ?? null;
    const bestCalls = best ? inv.get(best.investigation_id).calls.slice().sort(byTime) : [];
    const outcomes = {}; for (const r of runs) { const o = r.outcome ?? 'open'; outcomes[o] = (outcomes[o] ?? 0) + 1; }
    const waste = {}; for (const c of bestCalls) if (c.waste_class) waste[c.waste_class] = (waste[c.waste_class] ?? 0) + 1;
    const tch = new Map();
    for (const c of bestCalls) for (const t0 of c.touched) { const t = splitTouched(t0); if (!t.name) continue; const k = `${t.kind}|${t.name.toLowerCase()}|${(t.owner ?? '').toLowerCase()}`; if (!tch.has(k)) tch.set(k, { kind: t.kind, name: t.name, owner: t.owner, functional_entity: resolveEntity(t.kind, t.name, t.owner, idx, semantic) }); }
    const ents = new Set(runs.flatMap((r) => JSON.parse(r.hit_entities_json)));
    recipes.push({
      request_key: runs[0].request_key, runs: runs.length, erps_json: JSON.stringify([...new Set(runs.map((r) => r.erp).filter(Boolean))].sort()), outcomes_json: JSON.stringify(outcomes),
      best_investigation: best?.investigation_id ?? null, best_calls: best?.calls ?? null, best_bytes: best?.bytes ?? null, best_duration_ms: best?.duration_ms ?? null, best_ts: best?.t0 ?? null,
      median_calls: median(runs.map((r) => r.calls)), interpreted: best?.interpreted ?? runs[0].interpreted ?? null,
      recipe_json: JSON.stringify(bestCalls.map((c, i) => ({ seq: i, tool: c.tool, service: c.service, args: c.args, kind: c.kind, step_intent: c.step_intent ?? undefined }))),
      touched_json: JSON.stringify([...tch.values()]), waste_json: JSON.stringify(waste), entities_json: JSON.stringify([...ents].sort()),
    });
  }

  const entity_usage = [...usage.values()].map((u) => ({ functional_entity: u.functional_entity, object_kind: u.object_kind, object_name: u.object_name, field_name: u.field_name, investigations: u.invs.size, calls: u.calls, last_seen: u.last_seen, contexts_json: JSON.stringify([...u.contexts].sort()) }));
  const bytes = calls.reduce((n, c) => n + (c.bytes ?? 0), 0);
  return {
    investigations, calls, touched, entity_usage, recipes,
    counters: { records: records.length, claude_records: claude.length, mcp_records: mcp.length, calls: calls.length, paired_twins: paired, investigations: investigations.length, session_only_calls: calls.filter((c) => !c.investigation_id).length, bytes, services: [...new Set(calls.map((c) => c.service).filter(Boolean))].sort() },
  };
}

// ── writer ───────────────────────────────────────────────────────────────────

/**
 * Build the snapshot file. Returns the counters.
 * @param {{ outputPath?: string, traceDir?: string, files?: string[], vocabularyPath?: string, semanticDbPath?: string, log?: (m: string) => void }} [opts]
 */
export function buildInsightDb({ outputPath = DEFAULT_INSIGHT_DB(), traceDir = DEFAULT_TRACE_DIR(), files, vocabularyPath = DEFAULT_VOCABULARY(), semanticDbPath = process.env.SEMANTIC_DB_PATH, log = console.log } = {}) {
  const list = files ?? listTraceFiles(traceDir);
  const { records, bad } = readRecords(list);
  const vocabulary = existsSync(vocabularyPath) ? JSON.parse(readFileSync(vocabularyPath, 'utf8')) : { entities: [] };
  const semantic = readSemanticMappings(semanticDbPath);
  const model = analyzeTraces(records, { vocabulary, semantic });

  const tmp = `${outputPath}.tmp`;
  if (existsSync(tmp)) unlinkSync(tmp);
  const db = new Database(tmp);
  db.pragma('journal_mode = OFF'); db.pragma('synchronous = OFF');
  db.exec(INSIGHT_SCHEMA);
  const tx = db.transaction(() => {
    const ins = (table, rows) => {
      if (!rows.length) return;
      const cols = Object.keys(rows[0]);
      const stmt = db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
      for (const r of rows) stmt.run(cols.map((c) => { const v = r[c]; return typeof v === 'boolean' ? (v ? 1 : 0) : v === undefined ? null : v; }));
    };
    ins('investigations', model.investigations); ins('calls', model.calls); ins('touched', model.touched); ins('entity_usage', model.entity_usage); ins('recipes', model.recipes);
    const set = db.prepare('INSERT OR REPLACE INTO insight_metadata (key, value) VALUES (?, ?)');
    set.run('build_date', new Date().toISOString());
    set.run('schema_version', INSIGHT_SCHEMA_VERSION);
    set.run('source', files ? 'files' : 'ndjson-dir'); set.run('trace_dir', files ? '' : traceDir);
    set.run('files', String(list.length)); set.run('records', String(records.length)); set.run('malformed_lines', String(bad));
    set.run('vocabulary_version', String(vocabulary.version ?? '')); set.run('semantic_mappings', String(semantic.size));
    set.run('bytes_per_token_estimate', '4');
    for (const [k, v] of Object.entries(model.counters)) set.run(k, Array.isArray(v) ? v.join(',') : String(v));
  });
  tx();
  db.pragma('journal_mode = DELETE');
  db.close();
  if (existsSync(outputPath)) unlinkSync(outputPath);
  renameSync(tmp, outputPath);
  log(`insight: ${list.length} file(s), ${records.length} record(s) (${bad} malformed) → ${model.counters.investigations} investigation(s), ${model.counters.calls} call(s) (${model.counters.paired_twins} paired, ${model.counters.session_only_calls} without dossier), ${model.recipes.length} recipe(s), ${model.entity_usage.length} usage row(s) → ${outputPath}`);
  return { ...model.counters, recipes: model.recipes.length, entity_usage: model.entity_usage.length, malformed: bad, outputPath };
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const opt = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt; };
  try {
    buildInsightDb({
      outputPath: opt('--out', process.env.INSIGHT_DB_PATH || DEFAULT_INSIGHT_DB()),
      traceDir: opt('--traces', process.env.INSIGHT_TRACE_DIR || DEFAULT_TRACE_DIR()),
      vocabularyPath: opt('--vocabulary', DEFAULT_VOCABULARY()),
      semanticDbPath: opt('--semantic', process.env.SEMANTIC_DB_PATH),
    });
  } catch (err) {
    console.error('build:insight failed:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
}
