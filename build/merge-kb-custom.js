/**
 * merge-kb-custom.js
 *
 * Additively merge a customizations-only KB database (built by build-kb.js from
 * a customization metadata root such as C:\Workspace\DEV\Metadata) INTO an
 * existing full KB database that already holds the Microsoft standard objects.
 *
 * This backs the Azure "custom-delta rebuild": the multi-GB Microsoft base is
 * built once locally, and customizations can be refreshed server-side from a
 * small ZIP without re-shipping the whole KB.
 *
 * The merge is ADDITIVE — it never deletes Microsoft rows:
 *   - net-new custom tables → added (existing base rows untouched)
 *   - extension fields      → upserted onto their base table; the base table is
 *                             flagged is_customized and its field_count refreshed
 *   - enum extensions       → values UNIONED into the base enum (not replaced),
 *                             because a custom-only build has no MS base values
 *                             to append to and would otherwise overwrite them
 *   - classes/edts/entities/forms/views/menu items/methods/relations/indexes,
 *     labels, object paths, graph edges → upserted
 *
 * kb_search is refreshed for the delta's own objects AND recomputed for the
 * base objects that received custom members — see reindexExtendedBaseObjects().
 *
 * Requires the live DB to be schema v1.1 (has the customization columns). On an
 * older DB it throws, directing the operator to do a full KB upload instead.
 */

import { createRequire } from 'module';
import { MODEL_VERSIONS_SCHEMA } from '../src/azure/model-descriptors.js';
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

function hasColumn(db, table, col) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col);
  } catch { return false; }
}

function hasTable(db, schema, table) {
  try {
    return !!db.prepare(
      `SELECT 1 FROM ${schema}.sqlite_master WHERE type = 'table' AND name = ?`
    ).get(table);
  } catch { return false; }
}

/**
 * Recompute kb_search rows for base objects that received custom members.
 *
 * The content strings MUST stay byte-identical to build-kb.js buildFtsIndex()
 * (:1331-1387), so that a delta-merged KB and a full rebuild index the same
 * text. Any change to the formulas there has to be mirrored here.
 *
 * Only objects that exist in main are rewritten; a delta may carry members for
 * an object the live DB has never seen (e.g. an extension of a model that was
 * not part of the base build), and inventing a row for it would be wrong.
 *
 * @param {import('better-sqlite3').Database} db  live DB, cust already ATTACHed
 * @param {string[]} enumNames  enums whose values_json this merge changed
 * @returns {{tables:number, enums:number, entities:number}}
 */
function reindexExtendedBaseObjects(db, enumNames) {
  const del = db.prepare('DELETE FROM main.kb_search WHERE object_type = ? AND object_name = ?');
  const ins = db.prepare('INSERT INTO main.kb_search VALUES (?,?,?,?)');
  const counts = { tables: 0, enums: 0, entities: 0 };

  // ── Tables that received extension fields ────────────────────────────────
  const fieldsOf = db.prepare('SELECT field_name, label, edt FROM main.fields WHERE table_name = ?');
  for (const t of db.prepare(`
    SELECT t.table_name, t.module_id, t.label, t.developer_doc
      FROM main.tables t
     WHERE t.table_name IN (SELECT DISTINCT table_name FROM cust.fields WHERE is_extension = 1)
  `).all()) {
    const f = fieldsOf.all(t.table_name);
    let fieldContent = '';
    if (f.length > 0) {
      const fieldNames = f.map(x => x.field_name).join(', ');
      const fieldLabels = f.map(x => x.label).filter(Boolean).join(', ');
      const fieldEdts = f.map(x => x.edt).filter(Boolean).join(', ');
      fieldContent = `${fieldNames} ${fieldLabels} ${fieldEdts}`;
    }
    del.run('table', t.table_name);
    ins.run('table', t.table_name, t.module_id || '', `${t.label || ''} ${t.developer_doc || ''} ${fieldContent}`);
    counts.tables++;
  }

  // ── Enums whose values were UNIONed ──────────────────────────────────────
  const liveEnum = db.prepare('SELECT enum_name, module_id, label, values_json FROM main.enums WHERE enum_name = ?');
  for (const name of enumNames) {
    const e = liveEnum.get(name);
    if (!e) continue;
    let valNames = '';
    try { valNames = JSON.parse(e.values_json).map(v => v.name).join(', '); } catch { /* keep '' */ }
    del.run('enum', e.enum_name);
    ins.run('enum', e.enum_name, e.module_id || '', `${e.label || ''} ${valNames}`);
    counts.enums++;
  }

  // ── Entities that received extension fields/methods ──────────────────────
  const entFields = db.prepare('SELECT field_name FROM main.entity_fields WHERE entity_name = ?');
  const entMethods = db.prepare("SELECT method_name FROM main.methods WHERE owner_type = 'entity' AND owner_name = ?");
  for (const e of db.prepare(`
    SELECT d.entity_name, d.module_id, d.label, d.public_name
      FROM main.data_entities d
     WHERE d.entity_name IN (SELECT DISTINCT entity_name FROM cust.entity_fields)
        OR d.entity_name IN (SELECT DISTINCT owner_name FROM cust.methods WHERE owner_type = 'entity')
  `).all()) {
    const fieldNames = entFields.all(e.entity_name).map(x => x.field_name).join(', ');
    const methodNames = entMethods.all(e.entity_name).map(x => x.method_name).join(', ');
    del.run('entity', e.entity_name);
    ins.run('entity', e.entity_name, e.module_id || '', `${e.label || ''} ${e.public_name || ''} ${fieldNames} ${methodNames}`);
    counts.entities++;
  }

  return counts;
}

/**
 * @param {string} liveDbPath   Path to the full KB DB to merge into (modified in place).
 * @param {string} customDbPath Path to the customizations-only KB DB.
 * @param {(msg:string)=>void} [log]
 * @returns {{added:object, customizedTables:number, reindexed:object}} merge summary
 */
export function mergeCustomKb(liveDbPath, customDbPath, log = console.log) {
  const db = new Database(liveDbPath);
  db.pragma('journal_mode = DELETE');   // CIFS/SMB-safe on Azure /home
  db.pragma('synchronous = NORMAL');

  // Schema guard: refuse to merge into a pre-customization KB.
  if (!hasColumn(db, 'fields', 'is_extension') || !hasColumn(db, 'tables', 'is_customized')) {
    db.close();
    throw new Error(
      'Live KB database predates customization support (missing is_extension/is_customized columns). '
      + 'Upload a full pre-built KB database instead of a custom delta.'
    );
  }

  db.exec(`ATTACH DATABASE '${customDbPath.replace(/'/g, "''")}' AS cust`);
  const summary = { added: {}, customizedTables: 0 };

  try {
    db.exec('BEGIN IMMEDIATE');

    // ── Net-new object tables (additive upsert) ──────────────────────────────
    // tables: INSERT OR IGNORE so existing Microsoft base rows are preserved;
    // only genuinely new custom tables are added.
    const before = (t) => db.prepare(`SELECT COUNT(*) n FROM main.${t}`).get().n;

    const tBefore = before('tables');
    db.exec('INSERT OR IGNORE INTO main.tables SELECT * FROM cust.tables');
    summary.added.tables = before('tables') - tBefore;

    // These are keyed by object name; custom names don't collide with MS, and a
    // deliberate re-customization of an MS object should win → OR REPLACE.
    for (const t of ['classes', 'edts', 'data_entities', 'entity_fields', 'forms', 'views', 'menu_items', 'methods', 'indexes_tbl', 'relations']) {
      const b = before(t);
      db.exec(`INSERT OR REPLACE INTO main.${t} SELECT * FROM cust.${t}`);
      summary.added[t] = before(t) - b;
    }

    // ── Fields (additive upsert: custom-table fields + extension fields) ──────
    const fBefore = before('fields');
    db.exec('INSERT OR REPLACE INTO main.fields SELECT * FROM cust.fields');
    summary.added.fields = before('fields') - fBefore;

    // ── Enums: UNION values rather than replace (preserve MS enum values) ─────
    const liveEnumStmt = db.prepare('SELECT module_id, label, values_json FROM main.enums WHERE enum_name = ?');
    const upsertEnum = db.prepare('INSERT OR REPLACE INTO main.enums VALUES (?,?,?,?)');
    const enumNamesTouched = [];
    for (const ce of db.prepare('SELECT enum_name, module_id, label, values_json FROM cust.enums').all()) {
      const live = liveEnumStmt.get(ce.enum_name);
      if (!live) {
        upsertEnum.run(ce.enum_name, ce.module_id, ce.label, ce.values_json);
        enumNamesTouched.push(ce.enum_name);
        continue;
      }
      let liveVals = [];
      let custVals = [];
      try { liveVals = JSON.parse(live.values_json || '[]'); } catch { liveVals = []; }
      try { custVals = JSON.parse(ce.values_json || '[]'); } catch { custVals = []; }
      const seen = new Set(liveVals.map(v => v.name));
      let merged = liveVals;
      let changed = false;
      for (const v of custVals) {
        if (!seen.has(v.name)) { merged.push(v); seen.add(v.name); changed = true; }
      }
      if (changed) {
        upsertEnum.run(ce.enum_name, live.module_id || ce.module_id, live.label, JSON.stringify(merged));
        enumNamesTouched.push(ce.enum_name);
      }
    }
    const enumsTouched = enumNamesTouched.length;
    summary.added.enums = enumsTouched;

    // ── Flag base tables that received extension fields + refresh field_count ─
    const customizedInfo = db.prepare(`
      UPDATE main.tables
         SET is_customized = 1,
             field_count = (SELECT COUNT(*) FROM main.fields WHERE main.fields.table_name = main.tables.table_name)
       WHERE table_name IN (SELECT DISTINCT table_name FROM cust.fields WHERE is_extension = 1)
    `).run();
    summary.customizedTables = customizedInfo.changes;

    // ── Model build provenance ────────────────────────────────────────────────
    // A provenance-aware delta carries the custom models' descriptor versions
    // (model_versions); upsert them so the merged KB reports which build of
    // iExtension/ISV models the refreshed data was scanned from. Guarded:
    // either side may predate the model_versions table.
    if (hasTable(db, 'cust', 'model_versions')) {
      if (!hasTable(db, 'main', 'model_versions')) db.exec(MODEL_VERSIONS_SCHEMA);
      const mvBefore = before('model_versions');
      db.exec('INSERT OR REPLACE INTO main.model_versions SELECT * FROM cust.model_versions');
      summary.added.model_versions = before('model_versions') - mvBefore;
    }

    // ── Labels / object paths / graph edges ──────────────────────────────────
    db.exec('INSERT OR IGNORE INTO main.labels SELECT * FROM cust.labels');
    db.exec('INSERT OR REPLACE INTO main.object_paths SELECT * FROM cust.object_paths');
    db.exec('INSERT OR IGNORE INTO main.graph_edges SELECT * FROM cust.graph_edges');

    // ── Search index: refresh rows for the objects we just merged ─────────────
    db.exec('DELETE FROM main.kb_search WHERE object_name IN (SELECT object_name FROM cust.kb_search)');
    db.exec('INSERT INTO main.kb_search SELECT * FROM cust.kb_search');

    // cust.kb_search only covers the custom model's OWN objects. A Microsoft
    // base object that merely RECEIVED an extension (fields onto a base table,
    // values onto a base enum, fields onto a base entity) has no row there, so
    // the copy above leaves its pre-merge content in place and d365_search can
    // never surface the newly merged members. Recompute those rows from the
    // post-merge main DB.
    summary.reindexed = reindexExtendedBaseObjects(db, enumNamesTouched);

    try {
      db.exec(`INSERT INTO main.kb_search_fts(kb_search_fts) VALUES('rebuild')`);
    } catch { /* FTS5 not present — d365_search falls back to LIKE */ }

    // ── Metadata ──────────────────────────────────────────────────────────────
    const getMeta = (k) => { try { return db.prepare('SELECT value FROM main.kb_metadata WHERE key = ?').get(k)?.value || ''; } catch { return ''; } };
    const custRoots = getMeta('custom_packages_paths');
    const setMeta = db.prepare('INSERT OR REPLACE INTO main.kb_metadata VALUES (?,?)');
    const custFromDelta = (() => { try { return db.prepare("SELECT value FROM cust.kb_metadata WHERE key='custom_packages_paths'").get()?.value || ''; } catch { return ''; } })();
    const mergedRoots = [...new Set([...custRoots.split(';'), ...custFromDelta.split(';')].map(s => s.trim()).filter(Boolean))].join(';');
    setMeta.run('custom_packages_paths', mergedRoots);
    setMeta.run('has_customizations', '1');
    setMeta.run('build_date', new Date().toISOString());
    setMeta.run('last_custom_merge', new Date().toISOString());
    // #116 coverage signal `partial_build`: this database is a DELTA merge, so
    // kb_search may be stale for base tables that only gained extension fields
    // since the last full build (see CLAUDE.md "Post-compile refresh"). A full
    // build creates a fresh kb_metadata without this key, which is what clears it.
    setMeta.run('partial_build', new Date().toISOString());
    if (hasTable(db, 'main', 'model_versions')) {
      setMeta.run('model_versions_count',
        String(db.prepare('SELECT COUNT(*) AS n FROM main.model_versions').get().n));
    }

    db.exec('COMMIT');
    log(`  KB custom merge: +${summary.added.tables} tables, +${summary.added.fields} fields, ${enumsTouched} enums, ${summary.customizedTables} base tables flagged customized`);
    log(`  KB search reindex: ${summary.reindexed.tables} tables, ${summary.reindexed.enums} enums, ${summary.reindexed.entities} entities`);
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    db.exec('DETACH DATABASE cust');
    db.close();
    throw err;
  }

  db.exec('DETACH DATABASE cust');
  db.close();
  return summary;
}
