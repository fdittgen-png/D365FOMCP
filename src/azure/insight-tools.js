/**
 * Trace Insight tools — the MCP on the traces
 * (docs/ERP-Trace-Insight-Service-Concept-2026-09-11.md §4).
 *
 * Two read tools whose EVERY answer is computed from trace records, hosted on
 * the KB server so they can attach type, label and description to the fields
 * the traces name:
 *
 *   d365_prior_art       "Has this request been investigated before, and how?"
 *                        → the cheapest answered run's call recipe, objects
 *                          touched, cost, the waste it still paid
 *   d365_entity_insight  "What IS `customer` here and what of it matters?"
 *                        → vocabulary mapping + confirmed mappings, key fields
 *                          with meaning, field usage heat, never-touched fields
 *
 * Source: `d365fo_insight.sqlite` (build/build-insight.js) built from ALL local
 * trace sinks — hook stream + the four stdio servers. Without the snapshot both
 * tools return errorResult('db-error') naming the build; without the traces they
 * return empty; the KB/Labels read-through only decorates. What the traces do NOT
 * cover is stated in `insight_snapshot.not_covered` on every response.
 *
 * Registered from the end of registerKbTools() — tool-sets.js untouched. Outside
 * CORE_TOOLS by decision (§2 of the concept).
 */

import { z } from 'zod';
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  query,
  formatMarkdownTable,
  emptyResult,
  notFoundResult,
  errorResult,
  structuredResult,
  makeLabelResolver,
  formatTextParam,
  coverageNotes,
  readKbMetadataFlag,
  tryGetInsightDb,
  tryGetLabelsDb,
  READ_ONLY_DB_ANNOTATIONS,
} from './shared.js';
import { semanticStore } from './tool-guards.js';
import { d365PriorArtOutput, d365EntityInsightOutput } from './output-schemas.js';

const VOCABULARY_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'config', 'semantic-vocabulary.json');

/** What no trace record holds — stated on every response so a recipe is read as partial when it is. */
export const NOT_COVERED = Object.freeze([
  'Security calls inside a dossier (the hook records KB, XRef and Labels only; Sec appears as session calls without investigation)',
  'Task Recorder calls (never traced)',
  'Calls served by the Azure app to connectors outside Claude Code (server-side tracing on Azure is off)',
  'Response payloads (never recorded — replay the recipe against the snapshot date)',
  'SQL text of raw_sql calls (dropped; counted as unreplayable waste)',
]);

const BYTES_PER_TOKEN = 4;
export const ENTITY_SECTIONS = Object.freeze(['summary', 'keys', 'usage', 'fields', 'recipes']);
const DEFAULT_SECTIONS = Object.freeze(['summary', 'keys', 'usage']);

/** @param {any} v */
const parseJson = (v, dflt) => { try { return v == null ? dflt : JSON.parse(v); } catch { return dflt; } };

/** Vocabulary loaded once per registration (small JSON; the same file the semantic tools read). */
export function loadVocabulary(path = VOCABULARY_PATH) {
  if (!existsSync(path)) return { entities: [] };
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return { entities: [] }; }
}

/** Resolve an entity id, name or alias → vocabulary entry + how it matched. */
export function resolveVocabularyEntity(vocab, input) {
  const s = String(input ?? '').trim().toLowerCase();
  if (!s) return null;
  const entities = Array.isArray(vocab?.entities) ? vocab.entities : [];
  for (const e of entities) if (String(e.entity_id).toLowerCase() === s) return { entity: e, matched_by: 'entity_id' };
  for (const e of entities) if (String(e.name ?? '').toLowerCase() === s) return { entity: e, matched_by: 'name' };
  for (const e of entities) if ((e.aliases ?? []).some((a) => String(a).toLowerCase() === s)) return { entity: e, matched_by: 'alias' };
  return null;
}

/** Closest vocabulary ids for a miss — substring on id/name/aliases, else the first few ids. */
export function closestEntities(vocab, input, limit = 3) {
  const s = String(input ?? '').trim().toLowerCase();
  const entities = Array.isArray(vocab?.entities) ? vocab.entities : [];
  const hits = entities.filter((e) => [e.entity_id, e.name, ...(e.aliases ?? [])].some((x) => String(x ?? '').toLowerCase().includes(s) || (s.length > 3 && s.includes(String(x ?? '').toLowerCase()))));
  return (hits.length ? hits : []).slice(0, limit).map((e) => e.entity_id);
}

/** Search terms from free text: lower-cased words of ≥ 3 chars, stop words removed. */
const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'which', 'what', 'how', 'does', 'are', 'its', 'into', 'all', 'any', 'one', 'not', 'req']);
export function searchTerms(text) {
  return [...new Set(String(text ?? '').toLowerCase().split(/[^a-z0-9_]+/).filter((w) => w.length >= 3 && !STOP.has(w)))].slice(0, 12);
}

/**
 * @param {any} server  McpServer (or the guarded proxy)
 * @param {any} kbDb    the KB snapshot handle (field types, labels)
 * @param {{ insightDb?: any, labelsDb?: any, semanticDb?: any, vocabulary?: any }} [opts]
 */
export function registerInsightTools(server, kbDb, { insightDb, labelsDb, semanticDb, vocabulary } = {}) {
  const vocab = vocabulary ?? loadVocabulary();
  const getInsight = () => insightDb ?? tryGetInsightDb();
  const getLabels = () => { try { return labelsDb ?? tryGetLabelsDb(); } catch { return null; } };
  const semDb = () => { try { return semanticDb ?? semanticStore(); } catch { return null; } };
  const partialBuildSince = readKbMetadataFlag(kbDb, 'partial_build');
  const kbCov = () => coverageNotes({ partial_build: partialBuildSince ? { since: partialBuildSince } : null });
  const q = (db, sql, params = []) => query(db, sql, params);
  const num = (v) => (v == null ? null : Number(v));

  const noSnapshot = () => errorResult('db-error', 'Trace Insight snapshot not on this host — run `npm run build:insight` (reads ~/.claude/mcp-trace) or set INSIGHT_DB_PATH.');

  /** The snapshot block every response carries. */
  const snapshotInfo = (idb) => {
    const meta = Object.fromEntries(q(idb, 'SELECT key, value FROM insight_metadata').map((r) => [r.key, r.value]));
    return {
      build_date: meta.build_date ? String(meta.build_date).slice(0, 10) : null,
      records: num(meta.records), investigations: num(meta.investigations), calls: num(meta.calls),
      services: meta.services ? String(meta.services).split(',').filter(Boolean) : [],
      not_covered: [...NOT_COVERED],
    };
  };
  const snapshotLines = (snap) => `Insight snapshot: ${snap.build_date ?? 'undated'} — ${snap.investigations ?? 0} investigation(s), ${snap.calls ?? 0} call(s) from ${snap.services.join(', ') || 'no service'}.\n\nNot covered by the traces: ${snap.not_covered.map((s) => s.split(' (')[0]).join(' · ')}.\n\n`;

  const hitFromRecipe = (idb, r, match) => {
    const recipe = parseJson(r.recipe_json, []);
    return {
      request_key: r.request_key, match, interpreted: r.interpreted ?? null, runs: Number(r.runs),
      erps: parseJson(r.erps_json, []), outcomes: parseJson(r.outcomes_json, {}),
      best: { investigation_id: r.best_investigation ?? null, calls: num(r.best_calls), bytes: num(r.best_bytes), est_tokens: r.best_bytes == null ? null : Math.round(Number(r.best_bytes) / BYTES_PER_TOKEN), duration_ms: num(r.best_duration_ms), ts: r.best_ts ?? null },
      median_calls: num(r.median_calls), entities: parseJson(r.entities_json, []),
      recipe: recipe.map((s) => ({ seq: Number(s.seq), tool: String(s.tool), service: s.service ?? null, args: s.args ?? {}, kind: s.kind ?? null, ...(s.step_intent ? { step_intent: String(s.step_intent) } : {}) })),
      touched: parseJson(r.touched_json, []).map((t) => ({ kind: String(t.kind), name: String(t.name), owner: t.owner ?? null, functional_entity: t.functional_entity ?? null })),
      waste: parseJson(r.waste_json, {}),
    };
  };

  // ── d365_prior_art ─────────────────────────────────────────────────────────
  server.registerTool(
    'd365_prior_art',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description: 'Has this request been investigated before? By request_key (exact) or text (terms against recorded request keys, interpretations and entity aliases): the cheapest answered run\'s call recipe with arguments, objects touched, cost, and the waste it still paid. Call first on a known request key.',
      inputSchema: {
        request_key: z.string().min(2).max(200).optional(),
        text: z.string().min(3).max(300).optional().describe('Used when request_key is absent.'),
        limit: z.number().int().min(1).max(10).default(3),
        format: formatTextParam,
      },
      outputSchema: d365PriorArtOutput.shape,
    },
    async ({ request_key, text, limit, format }) => {
      const idb = getInsight();
      if (!idb) return noSnapshot();
      limit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 10) : 3;
      const key = typeof request_key === 'string' ? request_key.trim() : '';
      const txt = typeof text === 'string' ? text.trim() : '';
      if (!key && !txt) return errorResult('invalid-input', 'Pass request_key or text.');

      const snap = snapshotInfo(idb);
      /** @type {any[]} */
      let hits = [];
      if (key) {
        hits = q(idb, 'SELECT * FROM recipes WHERE request_key = ? COLLATE NOCASE', [key]).map((r) => hitFromRecipe(idb, r, 'request_key'));
      }
      if (!hits.length && txt) {
        const terms = searchTerms(txt);
        const scored = new Map();
        const bump = (r, n, how) => { const cur = scored.get(r.request_key) ?? { r, score: 0, how }; cur.score += n; scored.set(r.request_key, cur); };
        for (const t of terms) {
          for (const r of q(idb, 'SELECT * FROM recipes WHERE request_key LIKE ? OR interpreted LIKE ? LIMIT 50', [`%${t}%`, `%${t}%`])) bump(r, 1, 'text');
        }
        // entity aliases in the text → recipes whose runs touched that entity
        for (const t of terms) {
          const ent = resolveVocabularyEntity(vocab, t);
          if (ent) for (const r of q(idb, 'SELECT * FROM recipes WHERE entities_json LIKE ? LIMIT 50', [`%"${ent.entity.entity_id}"%`])) bump(r, 2, 'entity');
        }
        hits = [...scored.values()].sort((a, b) => b.score - a.score || Number(b.r.runs) - Number(a.r.runs)).slice(0, limit).map((x) => hitFromRecipe(idb, x.r, x.how));
      }
      hits = hits.slice(0, limit);

      const typed = { ...(key ? { request_key: key } : {}), ...(txt && !key ? { text: txt } : {}), hit_count: hits.length, hits, insight_snapshot: snap };
      if (!hits.length) return emptyResult(`prior investigations matching ${key ? `request key \`${key}\`` : `"${txt}"`}`, typed, `\n\n${snapshotLines(snap).trim()}`);

      let out = '## Prior art\n\n' + snapshotLines(snap);
      for (const h of hits) {
        out += `### ${h.request_key} (${h.match} match)\n\n`;
        if (h.interpreted) out += `${h.interpreted}\n\n`;
        out += `Runs: ${h.runs} · outcomes: ${Object.entries(h.outcomes).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'} · best run: ${h.best.calls ?? '?'} call(s), ~${h.best.est_tokens ?? '?'} tokens (est.), ${h.best.duration_ms ?? '?'} ms server${h.median_calls != null ? ` · median ${h.median_calls} calls` : ''}\n`;
        if (h.entities.length) out += `Functional entities: ${h.entities.join(', ')}\n`;
        const waste = Object.entries(h.waste); if (waste.length) out += `Waste still paid: ${waste.map(([k, v]) => `${k} ${v}`).join(', ')}\n`;
        out += '\n' + formatMarkdownTable(h.recipe.map((s) => ({ '#': s.seq + 1, Tool: s.tool, Args: JSON.stringify(s.args), Result: s.kind ?? '', Strategy: s.step_intent ? s.step_intent.slice(0, 80) : '' }))) + '\n';
        if (h.touched.length) out += '\nTouched: ' + h.touched.slice(0, 20).map((t) => `${t.kind}:${t.owner ? `${t.owner}.` : ''}${t.name}${t.functional_entity ? ` (${t.functional_entity})` : ''}`).join(', ') + (h.touched.length > 20 ? ', …' : '') + '\n';
        out += '\n';
      }
      return structuredResult(typed, out, format, { coverage: kbCov() });
    }
  );

  // ── d365_entity_insight ────────────────────────────────────────────────────
  server.registerTool(
    'd365_entity_insight',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description: 'One functional entity (id, name or alias) in one call: its D365FO data entities, tables and key fields, confirmed mappings, field meaning from the KB and Labels, and what real investigations touched of it (usage heat, never-touched fields). sections: summary, keys, usage (default), fields, recipes.',
      inputSchema: {
        entity: z.string().min(2).max(100),
        sections: z.array(z.enum(ENTITY_SECTIONS)).min(1).optional(),
        languages: z.array(z.string().min(2).max(10)).max(5).optional().describe('Label languages; default en-US.'),
        limit: z.number().int().min(1).max(200).default(30).describe('Rows in usage / fields.'),
        format: formatTextParam,
      },
      outputSchema: d365EntityInsightOutput.shape,
    },
    async ({ entity, sections, languages, limit, format }) => {
      const idb = getInsight();
      if (!idb) return noSnapshot();
      limit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 200) : 30;
      const secs = Array.isArray(sections) && sections.length ? [...new Set(sections.filter((s) => ENTITY_SECTIONS.includes(s)))] : [...DEFAULT_SECTIONS];
      const langs = Array.isArray(languages) && languages.length ? languages.map(String) : ['en-US']; void langs; // KB read-through resolves en-US; other languages via labels_lookup

      const hit = resolveVocabularyEntity(vocab, entity);
      if (!hit) return notFoundResult('functional entity', String(entity), closestEntities(vocab, entity));
      const e = hit.entity; const id = e.entity_id;
      const snap = snapshotInfo(idb);
      const tables = (e.d365fo?.primary_tables ?? []).map(String);
      const keyFields = (e.d365fo?.key_fields ?? []).map(String);
      const keySet = new Set(keyFields.map((k) => k.toLowerCase()));

      // usage totals from the traces
      const totals = q(idb, "SELECT COUNT(DISTINCT COALESCE(c.investigation_id, 'ses:' || c.session_key)) inv, COUNT(*) calls, MAX(c.ts) last FROM touched t JOIN calls c ON c.id = t.call_id WHERE t.functional_entity = ? COLLATE NOCASE", [id])[0] ?? {};
      const usageRows = q(idb, 'SELECT object_kind, object_name, field_name, investigations, calls, last_seen, contexts_json FROM entity_usage WHERE functional_entity = ? COLLATE NOCASE ORDER BY calls DESC, investigations DESC, object_name, field_name', [id]);
      const usageByField = new Map(usageRows.filter((r) => r.field_name).map((r) => [`${String(r.object_name).toLowerCase()}.${String(r.field_name).toLowerCase()}`, r]));

      const typed = {
        entity_id: id, name: e.name ?? null, process: e.process ?? null, description: e.description ?? null, aliases: (e.aliases ?? []).map(String), matched_by: hit.matched_by, sections: secs,
        d365fo: { module: e.d365fo?.module ?? null, data_entities: (e.d365fo?.data_entities ?? []).map(String), primary_tables: tables, key_fields: keyFields },
        usage_totals: { investigations: Number(totals.inv ?? 0), calls: Number(totals.calls ?? 0), last_seen: totals.last ?? null, objects: new Set(usageRows.map((r) => String(r.object_name).toLowerCase())).size, fields_touched: usageByField.size },
        insight_snapshot: snap,
      };

      // confirmed mappings (semantic store), when present
      const sdb = semDb();
      if (sdb) {
        try {
          typed.confirmed_mappings = q(sdb, "SELECT object_type, object_name, role, confidence, verified FROM sem_mappings WHERE entity_id = ? COLLATE NOCASE AND role <> 'excluded' ORDER BY confidence DESC LIMIT 20", [id])
            .map((m) => ({ object_type: String(m.object_type), object_name: String(m.object_name), role: String(m.role), confidence: Number(m.confidence), verified: Number(m.verified) === 1 }));
        } catch { /* no store, no section */ }
      }

      // KB read-through for key fields / fields
      const resolveLabel = makeLabelResolver(kbDb);
      const ldb = getLabels();
      const describe = (labelId) => {
        if (!ldb || typeof labelId !== 'string' || !labelId.startsWith('@')) return null;
        try { const r = q(ldb, 'SELECT description FROM label_meta WHERE label_id = ? COLLATE NOCASE', [labelId.replace(/^@/, '')])[0]; return r?.description ?? null; } catch { return null; }
      };
      const fieldRow = (f) => {
        const u = usageByField.get(`${String(f.table_name).toLowerCase()}.${String(f.field_name).toLowerCase()}`);
        let label = null; try { label = resolveLabel(f.label) ?? f.label ?? null; } catch { label = f.label ?? null; }
        return { table_name: String(f.table_name), field_name: String(f.field_name), field_type: f.field_type ?? null, edt: f.edt ?? null, mandatory: f.mandatory ?? null, label, description: describe(f.label), is_key: keySet.has(`${String(f.table_name).toLowerCase()}.${String(f.field_name).toLowerCase()}`), usage_calls: Number(u?.calls ?? 0), usage_investigations: Number(u?.investigations ?? 0) };
      };
      let kbFields = [];
      if (tables.length && (secs.includes('keys') || secs.includes('fields'))) {
        try { kbFields = q(kbDb, `SELECT table_name, field_name, field_type, edt, mandatory, label FROM fields WHERE table_name IN (${tables.map(() => '?').join(',')}) COLLATE NOCASE ORDER BY table_name, field_name`, tables); } catch { kbFields = []; }
      }
      // `fields` is ONE array: the `keys` section fills it with the key fields, the
      // `fields` section with every field (keys first, then by usage) — one row
      // shape on the wire instead of two copies of it in the schema.
      const isKey = (f) => keySet.has(`${String(f.table_name).toLowerCase()}.${String(f.field_name).toLowerCase()}`);
      if (secs.includes('fields')) {
        const all = kbFields.map(fieldRow).sort((a, b) => Number(b.is_key) - Number(a.is_key) || b.usage_calls - a.usage_calls || a.field_name.localeCompare(b.field_name));
        typed.fields = all.slice(0, limit);
        if (all.length > limit) typed.truncated = true;
        typed.never_touched_count = all.filter((f) => f.usage_calls === 0).length;
      } else if (secs.includes('keys')) {
        const rows = kbFields.filter(isKey).map(fieldRow);
        // key fields the KB does not know (vocabulary drift) still appear, unresolved
        for (const k of keyFields) if (!rows.some((r) => `${r.table_name}.${r.field_name}`.toLowerCase() === k.toLowerCase())) { const [t, f] = k.split('.'); rows.push({ table_name: t ?? k, field_name: f ?? '', field_type: null, edt: null, mandatory: null, label: null, description: null, is_key: true, usage_calls: Number(usageByField.get(k.toLowerCase())?.calls ?? 0), usage_investigations: Number(usageByField.get(k.toLowerCase())?.investigations ?? 0) }); }
        typed.fields = rows;
      }
      if (secs.includes('usage')) {
        typed.usage = usageRows.slice(0, limit).map((r) => ({ object_kind: String(r.object_kind), object_name: String(r.object_name), field_name: r.field_name ?? null, investigations: Number(r.investigations), calls: Number(r.calls), last_seen: r.last_seen ?? null, contexts: parseJson(r.contexts_json, []) }));
        if (usageRows.length > limit) typed.truncated = true;
      }
      if (secs.includes('recipes')) {
        typed.recipes = q(idb, 'SELECT request_key, runs, best_calls, interpreted FROM recipes WHERE entities_json LIKE ? ORDER BY runs DESC, best_calls LIMIT 20', [`%"${id}"%`])
          .map((r) => ({ request_key: String(r.request_key), runs: Number(r.runs), best_calls: num(r.best_calls), interpreted: r.interpreted ?? null }));
      }

      let out = `## Entity insight: ${e.name ?? id} (${id})\n\n` + snapshotLines(snap);
      if (e.description) out += `${e.description}\n\n`;
      out += `D365FO: module ${typed.d365fo.module ?? '—'} · data entities ${typed.d365fo.data_entities.join(', ') || '—'} · tables ${tables.join(', ') || '—'} · keys ${keyFields.join(', ') || '—'}\n`;
      out += `Observed: ${typed.usage_totals.investigations} investigation(s), ${typed.usage_totals.calls} call(s), ${typed.usage_totals.objects} object(s), ${typed.usage_totals.fields_touched} field(s) touched${typed.usage_totals.last_seen ? `, last ${String(typed.usage_totals.last_seen).slice(0, 10)}` : ''}.\n\n`;
      if (typed.confirmed_mappings?.length) out += formatMarkdownTable(typed.confirmed_mappings.map((m) => ({ Type: m.object_type, Object: m.object_name, Role: m.role, Confidence: m.confidence.toFixed(2), Verified: m.verified ? 'Y' : 'N' }))) + '\n\n';
      const fieldTable = (rows) => formatMarkdownTable(rows.map((f) => ({ Field: `${f.table_name}.${f.field_name}`, Type: f.field_type ?? '', EDT: f.edt ?? '', Key: f.is_key ? 'Y' : '', Label: f.label ?? '', Description: f.description ?? '', Calls: f.usage_calls, Investigations: f.usage_investigations })));
      if (typed.usage) out += '### Usage (traces)\n\n' + (typed.usage.length ? formatMarkdownTable(typed.usage.map((u) => ({ Object: `${u.object_kind}:${u.object_name}`, Field: u.field_name ?? '', Investigations: u.investigations, Calls: u.calls, 'Last seen': u.last_seen ? String(u.last_seen).slice(0, 10) : '', Contexts: u.contexts.slice(0, 3).join(', ') }))) : 'No investigation has touched this entity yet.') + (usageRows.length > limit ? `\n\nShowing ${limit} of ${usageRows.length} rows — raise limit.` : '') + '\n\n';
      if (typed.fields) out += (secs.includes('fields') ? `### Fields (${typed.fields.length}${kbFields.length > typed.fields.length ? ` of ${kbFields.length}` : ''}, ${typed.never_touched_count} never touched)\n\n` : '### Key fields\n\n') + (typed.fields.length ? fieldTable(typed.fields) : 'No fields in the KB for these tables.') + '\n\n';
      if (typed.recipes) out += '### Request keys that touched it\n\n' + (typed.recipes.length ? formatMarkdownTable(typed.recipes.map((r) => ({ 'Request key': r.request_key, Runs: r.runs, 'Best calls': r.best_calls ?? '', Interpreted: r.interpreted ?? '' }))) : 'None.') + '\n\n';
      return structuredResult(typed, out, format, { coverage: kbCov() });
    }
  );
}
