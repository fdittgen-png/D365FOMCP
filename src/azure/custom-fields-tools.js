/**
 * `d365_custom_fields` — UI custom fields, read live from a D365 environment
 * (issues #87, #90).
 *
 * Registered onto the KB server. It answers the same response contract as
 * every other tool, with one deliberate difference: `READ_ONLY_LIVE_ANNOTATIONS`
 * instead of `READ_ONLY_DB_ANNOTATIONS`, because this tool really does reach an
 * external system and the host should be told so (#87 section 4).
 *
 * Also exports `resolveCustomFieldChecks`, the helper `d365_check_field_exists`
 * uses to stop answering "does not exist" to a `_Custom` field name.
 */

import { z } from 'zod';

import {
  READ_ONLY_LIVE_ANNOTATIONS,
  formatTextParam,
  structuredResult,
  formatMarkdownTable,
  emptyResult,
  errorResult,
  truncationNote,
  query,
} from './shared.js';
import {
  fetchCustomFields,
  getCacheState,
  isCustomFieldName,
  CustomFieldsError,
  CUSTOM_FIELD_SUFFIX,
} from './custom-fields.js';
import { d365CustomFieldsOutput } from './output-schemas.js';

const DEFAULT_LIMIT = 100;
const HARD_MAX = 500;

/** The explanation a caller gets when the field class is recognised but no
 *  environment is configured to resolve it against. Even with nothing wired up
 *  this beats a bare "does not exist" — it names the field class, says why the
 *  snapshot cannot see it, and says what to do. */
export function customFieldClassNote(extra) {
  return (
    `framework suffix ${CUSTOM_FIELD_SUFFIX} — this is a D365 UI custom field ` +
    '(System administration > Setup > Custom fields). It lives in a runtime table extension, ' +
    'so it is absent from every build snapshot by design and its absence here is not evidence ' +
    'that it does not exist. ' +
    (extra || 'Configure an environment with scripts/Set-D365CustomFieldsSource.ps1 to resolve it.')
  );
}

/** Map `errorResult` category + a usable hint out of a CustomFieldsError. */
function toErrorResult(err) {
  if (err instanceof CustomFieldsError) return errorResult(err.category, err.message);
  console.error('custom-fields tool: unexpected failure', err);
  return errorResult('internal', 'Reading custom fields from the environment failed — see server logs.');
}

/** Cache/lookup key for a (table, field) pair.
 *
 *  Exported and used by BOTH `resolveCustomFieldChecks` (which fills the map)
 *  and `kb-tools.js` (which reads it). It started life as the same template
 *  literal written out in two files, and the two spellings drifted — a stray
 *  byte in one of them meant the map was filled with keys the reader could
 *  never look up, silently. One function, one spelling. */
export function customFieldKey(tableName, fieldName) {
  return `${String(tableName).toUpperCase()}::${String(fieldName).toUpperCase()}`;
}

/* ── entity → table attribution ──────────────────────────────────────────── */

/**
 * Attribute observed entity properties to tables using the KB.
 *
 * `$metadata` reports entity properties; callers ask about table fields. The
 * KB holds `data_entities.primary_table` and `entity_fields.data_source`, so
 * the mapping is done locally — and marked, because it is inference: a custom
 * field is created on a table and propagated onto the entities exposing it, so
 * going back the other way can be ambiguous when an entity has several data
 * sources.
 *
 * @returns the same rows plus `table_name` and `attribution`.
 */
function attributeToTables(db, fields) {
  if (!fields.length) return [];

  const names = [...new Set(fields.map(f => f.entity_name))];
  const byEntity = new Map();

  // Chunk the IN list — an environment can carry custom fields on many
  // entities and SQLite has a parameter ceiling.
  for (let i = 0; i < names.length; i += 400) {
    const slice = names.slice(i, i + 400);
    const placeholders = slice.map(() => '?').join(',');
    const rows = query(
      db,
      `SELECT entity_name, public_name, primary_table
         FROM data_entities
        WHERE entity_name COLLATE NOCASE IN (${placeholders})
           OR public_name COLLATE NOCASE IN (${placeholders})`,
      [...slice, ...slice],
    ) || [];
    for (const r of rows) {
      // An entity is reachable under either its AOT name or its public name —
      // `$metadata` uses the public one.
      for (const key of [r.entity_name, r.public_name]) {
        if (key) byEntity.set(String(key).toUpperCase(), r);
      }
    }
  }

  return fields.map(f => {
    const hit = byEntity.get(String(f.entity_name).toUpperCase());
    if (!hit || !hit.primary_table) {
      return { ...f, table_name: null, attribution: 'unresolved' };
    }
    return { ...f, table_name: hit.primary_table, attribution: 'primary-table' };
  });
}

/** Custom fields plausibly belonging to `tableName`.
 *
 *  Matched two ways, both recorded: the entity's `primary_table` is the table
 *  (strong), or the KB says the table is one of the entity's data sources
 *  (derived — an entity with several data sources cannot say which one the
 *  field was created on). */
function fieldsForTable(db, fields, tableName) {
  const wanted = String(tableName).toUpperCase();
  const attributed = attributeToTables(db, fields);

  const direct = attributed.filter(f => (f.table_name || '').toUpperCase() === wanted);
  const directEntities = new Set(direct.map(f => f.entity_name.toUpperCase()));

  // Second pass: entities whose *data sources* include the table.
  const remaining = attributed.filter(f => !directEntities.has(f.entity_name.toUpperCase()));
  if (!remaining.length) return direct;

  const names = [...new Set(remaining.map(f => f.entity_name))];
  const viaDataSource = new Set();
  for (let i = 0; i < names.length; i += 400) {
    const slice = names.slice(i, i + 400);
    const placeholders = slice.map(() => '?').join(',');
    const rows = query(
      db,
      `SELECT DISTINCT ef.entity_name, de.public_name
         FROM entity_fields ef
         LEFT JOIN data_entities de ON de.entity_name = ef.entity_name COLLATE NOCASE
        WHERE ef.data_source = ? COLLATE NOCASE
          AND (ef.entity_name COLLATE NOCASE IN (${placeholders})
            OR de.public_name COLLATE NOCASE IN (${placeholders}))`,
      [tableName, ...slice, ...slice],
    ) || [];
    for (const r of rows) {
      for (const key of [r.entity_name, r.public_name]) {
        if (key) viaDataSource.add(String(key).toUpperCase());
      }
    }
  }

  const derived = remaining
    .filter(f => viaDataSource.has(f.entity_name.toUpperCase()))
    .map(f => ({ ...f, table_name: tableName, attribution: 'derived' }));

  return [...direct, ...derived];
}

/* ── the check_field_exists helper ───────────────────────────────────────── */

/**
 * Resolve `_Custom` field names against a live environment.
 *
 * Called by `d365_check_field_exists` only when at least one checked name
 * carries the framework suffix, so a normal field check makes no network call
 * at all.
 *
 * Never throws: a live-source failure must not turn a successful offline field
 * check into an error (#87 section 5). On failure the caller still gets the
 * class explanation, which is the part that actually prevents the wrong
 * conclusion.
 *
 * @param {object} db KB database.
 * @param {Array<{table_name: string, field_name: string}>} wanted
 * @param {{ environment?: string }} [opts]
 * @returns {Promise<{ resolved: Map<string, object>, environment: string|null, fetched_at: string|null, note: string|null }>}
 *          `resolved` is keyed by `customFieldKey(table, field)`.
 */
export async function resolveCustomFieldChecks(db, wanted, opts = {}) {
  const empty = { resolved: new Map(), environment: null, fetched_at: null, note: null };
  if (!wanted.length) return empty;

  let live;
  try {
    live = await fetchCustomFields({ environment: opts.environment });
  } catch (err) {
    if (err instanceof CustomFieldsError) {
      return { ...empty, note: customFieldClassNote(
        err.stage === 'config'
          ? 'No environment is configured as a custom-field source, so it could not be resolved: ' + err.message
          : `The configured environment could not be read (${err.stage}): ${err.message}`,
      ) };
    }
    console.error('custom-fields: unexpected failure resolving field checks', err);
    return { ...empty, note: customFieldClassNote('The configured environment could not be read — see server logs.') };
  }

  const resolved = new Map();
  for (const { table_name, field_name } of wanted) {
    const candidates = fieldsForTable(db, live.fields, table_name)
      .filter(f => f.property_name.toUpperCase() === String(field_name).toUpperCase());
    if (!candidates.length) continue;
    // Prefer a primary-table match over a derived one when both exist.
    const best = candidates.find(c => c.attribution === 'primary-table') || candidates[0];
    resolved.set(customFieldKey(table_name, field_name), {
      environment: live.environment,
      entity_name: best.entity_name,
      property_name: best.property_name,
      type: best.type,
      max_length: best.max_length,
      fetched_at: live.fetched_at,
      attribution: best.attribution,
    });
  }

  return { resolved, environment: live.environment, fetched_at: live.fetched_at, note: null };
}

/** Live custom fields for one table, for `d365_lookup_table`'s opt-in block.
 *  Never throws; returns a note instead. */
export async function customFieldsForTable(db, tableName, opts = {}) {
  try {
    const live = await fetchCustomFields({ environment: opts.environment, refresh: opts.refresh });
    return {
      fields: fieldsForTable(db, live.fields, tableName),
      environment: live.environment,
      fetched_at: live.fetched_at,
      note: null,
    };
  } catch (err) {
    const message = err instanceof CustomFieldsError
      ? err.message
      : 'Reading the environment failed — see server logs.';
    if (!(err instanceof CustomFieldsError)) console.error('custom-fields: lookup_table block failed', err);
    return { fields: [], environment: null, fetched_at: null, note: message };
  }
}

/* ── registration ────────────────────────────────────────────────────────── */

export function registerCustomFieldTools(server, db) {
  server.registerTool(
    'd365_custom_fields',
    {
      annotations: READ_ONLY_LIVE_ANNOTATIONS,
      description:
        'UI custom fields (`_Custom` suffix) read LIVE from a configured environment — created in System administration > ' +
        'Setup > Custom fields, they exist in NO build snapshot. Filter by table_name (derived), entity_name (observed) or ' +
        'field_name; no filter lists the environments. Types are OData/EDM, not EDTs; a picklist looks like Text.',
      inputSchema: {
        table_name: z.string().min(1).max(500).optional()
          .describe('Only custom fields attributable to this table. Attribution is derived from the entity model — see `attribution` on each row.'),
        entity_name: z.string().min(1).max(500).optional()
          .describe('Only custom fields on this data entity (as named in $metadata). Observed directly, not derived.'),
        field_name: z.string().min(1).max(500).optional()
          .describe('Only this field, e.g. TBGSecondaryContact_Custom. Answers "does this exist" for one name.'),
        environment: z.string().min(1).max(100).optional()
          .describe('Source key to read from. Defaults to the source marked default.'),
        refresh: z.boolean().default(false)
          .describe('Bypass the TTL cache and re-read $metadata from the environment.'),
        limit: z.number().int().min(1).max(HARD_MAX).default(DEFAULT_LIMIT).optional(),
        format: formatTextParam,
      },
      outputSchema: d365CustomFieldsOutput.shape,
    },
    async ({ table_name, entity_name, field_name, environment, refresh, limit, format }) => {
      // Rule #13: the test mock server bypasses Zod, so mirror every default.
      const cap = Number.isInteger(limit) && limit > 0 ? Math.min(limit, HARD_MAX) : DEFAULT_LIMIT;
      const doRefresh = refresh === true;
      const hasFilter = Boolean(table_name || entity_name || field_name);

      // No filter: answer "what can I even query" without touching the network.
      if (!hasFilter) {
        const sources = getCacheState();
        if (!sources.length) {
          return errorResult('invalid-input',
            'No D365 environment is configured as a custom-field source. ' +
            'Configure one with scripts/Set-D365CustomFieldsSource.ps1 (see docs/Administration.md).');
        }
        const typed = {
          sources,
          note: 'Pass table_name, entity_name or field_name to read custom fields from an environment.',
        };
        const out = '## Custom-field sources\n\n' + formatMarkdownTable(sources, [
          'environment', 'title', 'url', 'is_default', 'cached', 'cached_property_count', 'fetched_at', 'last_error',
        ]) + `\n\n_${typed.note}_\n`;
        return structuredResult(typed, out, format);
      }

      let live;
      try {
        live = await fetchCustomFields({ environment, refresh: doRefresh });
      } catch (err) {
        return toErrorResult(err);
      }

      let rows = table_name
        ? fieldsForTable(db, live.fields, table_name)
        : attributeToTables(db, live.fields);

      if (entity_name) {
        const wanted = entity_name.toUpperCase();
        rows = rows.filter(r => r.entity_name.toUpperCase() === wanted);
      }
      if (field_name) {
        const wanted = field_name.toUpperCase();
        rows = rows.filter(r => r.property_name.toUpperCase() === wanted);
      }

      const total = rows.length;
      const shown = rows.slice(0, cap);

      const base = {
        environment: live.environment,
        title: live.title,
        url: live.url,
        fetched_at: live.fetched_at,
        cached: live.cached,
        entity_count: live.entity_count,
        property_count: live.property_count,
      };

      if (!total) {
        // A valid query with zero rows — and for a suffixed field_name this is
        // an EVIDENCED negative, which is worth saying out loud.
        const note = field_name && isCustomFieldName(field_name)
          ? `${field_name} is not a custom field in ${live.environment} as of ${live.fetched_at}.`
          : `No custom fields matched in ${live.environment} (${live.property_count} exist in total).`;
        return emptyResult('custom fields', { ...base, shown: 0, fields: [], note });
      }

      const typed = { ...base, shown: shown.length, fields: shown, note: null };

      let out = `## Custom fields: ${live.environment}\n\n`;
      out += `_Live from ${live.environment} (${live.title}), fetched ${live.fetched_at}` +
        `${live.cached ? ', cached' : ''} — environment-local, not in the build snapshot._\n\n`;
      out += formatMarkdownTable(shown, [
        'table_name', 'attribution', 'entity_name', 'property_name', 'type', 'max_length', 'nullable',
      ]);
      if (total > shown.length) out += '\n' + truncationNote('cap', shown.length, HARD_MAX);
      out += '\n_`attribution`: primary-table = the entity\'s primary table is this table; ' +
        'derived = the table is one of the entity\'s data sources; unresolved = entity not in the KB snapshot._\n';

      return structuredResult(typed, out, format);
    },
  );
}
