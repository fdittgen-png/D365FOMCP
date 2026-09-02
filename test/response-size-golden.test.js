/**
 * Response-size golden test (W0.2, issue #104).
 *
 * The regression gate every token-efficiency workstream (W1–W5, #105–#109)
 * reports against. Ten representative calls run with DEFAULT arguments against
 * a deterministic synthetic fixture that is wide enough for a shaping change to
 * be measurable: a 300-field table with 40 relations, 150 models, a 100-method
 * class, a role with 2,000 direct entity permissions and 60 duties, an entity
 * with 250 fields. For each call the two channels a client is billed for are
 * recorded — `JSON.stringify(structuredContent).length` and
 * `content[0].text.length` — and compared to `test/fixtures/response-size-baseline.json`
 * within ±10%.
 *
 * A breach is not a failure of correctness; it is "a payload changed size by
 * more than a rounding error — was that intended?". When it was:
 *
 *     GOLDEN_UPDATE=1 node --test test/response-size-golden.test.js
 *
 * rewrites the baseline. (No npm script on purpose: package.json is owned
 * elsewhere, and re-baselining should be a visible, deliberate act in the diff.)
 *
 * The fixture is synthetic, so the ABSOLUTE numbers are not production sizes —
 * the concept document (§3.1) holds those. What this test tracks is the RATIO:
 * a change that shaves 20% off `d365_lookup_table` here shaves ~20% off
 * CustTable in production, because both are dominated by the per-row shape.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { z } from 'zod';

import { registerKbTools } from '../src/azure/kb-tools.js';
import { registerXrefTools } from '../src/azure/xref-tools.js';
import { registerSecTools } from '../src/azure/sec-tools.js';

// Guards are a session concern (loop detection would swap a repeated call for
// a note); the profile filter would drop tools. Neither may touch a size gate.
delete process.env.MCP_TOOL_GUARDS;
delete process.env.MCP_TOOL_PROFILE;

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const __dirname = dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = join(__dirname, 'fixtures', 'response-size-baseline.json');
const TOLERANCE = 0.10;

// ── Fixture builders ─────────────────────────────────────────────────────────
// Schemas mirror the unit-test fixtures (kb-tools/xref-tools/sec-tools.test.js)
// plus the provenance columns the production builders emit (fields.source_module
// / is_extension, tables.is_customized), so the per-row shape matches production.

const pad = (n, w = 3) => String(n).padStart(w, '0');

function buildKb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = OFF');
  db.exec(`
    CREATE TABLE tables (table_name TEXT PRIMARY KEY, module_id TEXT, label TEXT, table_group TEXT,
      save_per_company INTEGER DEFAULT 1, cache_lookup TEXT, clustered_index TEXT, replacement_key TEXT,
      field_count INTEGER DEFAULT 0, is_customized INTEGER DEFAULT 0);
    CREATE TABLE fields (table_name TEXT, field_name TEXT, field_type TEXT, edt TEXT, enum_type TEXT,
      mandatory INTEGER DEFAULT 0, label TEXT, source_module TEXT, is_extension INTEGER DEFAULT 0,
      PRIMARY KEY (table_name, field_name));
    CREATE TABLE indexes_tbl (table_name TEXT, index_name TEXT, is_unique INTEGER DEFAULT 0,
      is_clustered INTEGER DEFAULT 0, fields_json TEXT, PRIMARY KEY (table_name, index_name));
    CREATE TABLE relations (source_table TEXT, related_table TEXT, relation_name TEXT,
      constraints_json TEXT, relationship_type TEXT, on_delete TEXT);
    CREATE TABLE enums (enum_name TEXT PRIMARY KEY, module_id TEXT, label TEXT, values_json TEXT);
    CREATE TABLE classes (class_name TEXT PRIMARY KEY, module_id TEXT, extends_class TEXT,
      implements_list TEXT, is_abstract INTEGER DEFAULT 0, method_count INTEGER DEFAULT 0);
    CREATE TABLE methods (owner_type TEXT, owner_name TEXT, method_name TEXT, signature TEXT,
      is_static INTEGER DEFAULT 0, source_code TEXT, PRIMARY KEY (owner_name, method_name));
    CREATE TABLE data_entities (entity_name TEXT PRIMARY KEY, module_id TEXT, label TEXT, public_name TEXT,
      public_collection TEXT, is_public INTEGER DEFAULT 0, primary_table TEXT, staging_table TEXT, config_key TEXT);
    CREATE TABLE entity_fields (entity_name TEXT, field_name TEXT, data_field TEXT, data_source TEXT,
      is_mandatory INTEGER DEFAULT 0, PRIMARY KEY (entity_name, field_name));
    CREATE TABLE kb_search (object_type TEXT, object_name TEXT, module_id TEXT, content TEXT);
    CREATE TABLE modules (module_id TEXT PRIMARY KEY, table_count INTEGER DEFAULT 0, class_count INTEGER DEFAULT 0,
      enum_count INTEGER DEFAULT 0, entity_count INTEGER DEFAULT 0, form_count INTEGER DEFAULT 0);
    CREATE TABLE model_versions (model_name TEXT PRIMARY KEY, module_id TEXT, display_name TEXT,
      publisher TEXT, layer TEXT, origin TEXT, version TEXT, source_root TEXT);
    CREATE TABLE hallucination_traps (object_name TEXT, trap_type TEXT, wrong_value TEXT, correct_value TEXT, explanation TEXT);
    CREATE TABLE field_renames (table_name TEXT, ax2012_name TEXT, d365fo_name TEXT);
    CREATE TABLE query_templates (template_id TEXT PRIMARY KEY, title TEXT, description TEXT, sql_template TEXT, tables_used TEXT);
    CREATE TABLE graph_edges (source_node TEXT, target_node TEXT, source_type TEXT, target_type TEXT, edge_type TEXT, edge_detail TEXT);
    CREATE TABLE labels (label_id TEXT PRIMARY KEY, text TEXT);
  `);

  const ins = (sql) => db.prepare(sql);
  const tables = ins('INSERT INTO tables VALUES (?,?,?,?,?,?,?,?,?,?)');
  const fields = ins('INSERT INTO fields VALUES (?,?,?,?,?,?,?,?,?)');
  const indexes = ins('INSERT INTO indexes_tbl VALUES (?,?,?,?,?)');
  const relations = ins('INSERT INTO relations VALUES (?,?,?,?,?,?)');
  const enums = ins('INSERT INTO enums VALUES (?,?,?,?)');
  const classes = ins('INSERT INTO classes VALUES (?,?,?,?,?,?)');
  const methods = ins('INSERT INTO methods VALUES (?,?,?,?,?,?)');
  const entities = ins('INSERT INTO data_entities VALUES (?,?,?,?,?,?,?,?,?)');
  const entityFields = ins('INSERT INTO entity_fields VALUES (?,?,?,?,?)');
  const search = ins('INSERT INTO kb_search VALUES (?,?,?,?)');
  const modules = ins('INSERT INTO modules VALUES (?,?,?,?,?,?)');
  const versions = ins('INSERT INTO model_versions VALUES (?,?,?,?,?,?,?,?)');
  const labels = ins('INSERT INTO labels VALUES (?,?)');

  db.transaction(() => {
    const TYPES = ['String', 'Int64', 'Real', 'Enum', 'Date', 'Int'];
    tables.run('GoldenTable', 'ApplicationSuite', '@SYS900000', 'Main', 1, 'Found', 'GoldenIdx', 'GoldenId', 300, 1);
    labels.run('@SYS900000', 'Golden master table');
    for (let i = 1; i <= 300; i++) {
      const type = TYPES[i % TYPES.length];
      const isExt = i % 10 === 0 ? 1 : 0;
      const label = i % 3 === 0 ? `@SYS9${pad(i, 5)}` : null;
      if (label) labels.run(label, `Golden field label ${i}`);
      fields.run('GoldenTable', `Field${pad(i)}`, type, `GoldenEdt${i % 37}`,
        type === 'Enum' ? `GoldenEnum${i % 5}` : null, i % 7 === 0 ? 1 : 0, label,
        isExt ? 'iExtension' : 'Foundation', isExt);
    }
    for (let i = 1; i <= 6; i++) {
      indexes.run('GoldenTable', `GoldenIdx${i}`, i === 1 ? 1 : 0, i === 1 ? 1 : 0,
        JSON.stringify([`Field${pad(i)}`, `Field${pad(i + 1)}`]));
    }
    for (let i = 1; i <= 40; i++) {
      tables.run(`RelTable${pad(i, 2)}`, 'ApplicationSuite', null, 'Group', 1, 'Found', null, null, 3, 0);
      relations.run('GoldenTable', `RelTable${pad(i, 2)}`, `RelTable${pad(i, 2)}Rel`,
        JSON.stringify([{ field: `Field${pad(i)}`, relatedField: 'RecId' }]), 'Association', 'Restricted');
    }
    for (let i = 1; i <= 25; i++) {
      relations.run(`SrcTable${pad(i, 2)}`, 'GoldenTable', `GoldenRel${pad(i, 2)}`,
        JSON.stringify([{ field: 'GoldenRef', relatedField: 'GoldenId' }]), 'Association', 'Restricted');
    }
    for (const name of ['GoldenEnumA', 'GoldenEnumB']) {
      const values = Array.from({ length: 15 }, (_, v) => ({ name: `${name}Value${v}`, value: v, label: v % 4 === 0 ? null : `Label ${v}` }));
      enums.run(name, 'ApplicationSuite', `${name} label`, JSON.stringify(values));
    }
    classes.run('GoldenClass', 'ApplicationSuite', 'GoldenBase', 'SysRunnable', 0, 100);
    for (let i = 1; i <= 100; i++) {
      const body = `public void method${pad(i)}(int a, str b)\n{\n    // body ${i}\n    this.helper(a);\n    return;\n}`;
      methods.run('class', 'GoldenClass', `method${pad(i)}`, `public void method${pad(i)}(int a, str b)`, i % 9 === 0 ? 1 : 0, body);
    }
    entities.run('GoldenEntity', 'ApplicationSuite', 'Golden entity', 'GoldenV2', 'GoldensV2', 1, 'GoldenTable', 'GoldenStaging', null);
    for (let i = 1; i <= 250; i++) {
      entityFields.run('GoldenEntity', `EntityField${pad(i)}`, `Field${pad(i)}`, 'GoldenTable', i % 11 === 0 ? 1 : 0);
    }
    for (let i = 1; i <= 60; i++) {
      const type = ['table', 'class', 'enum', 'entity'][i % 4];
      search.run(type, `Payment${type}${pad(i, 2)}`, `Module${pad(i % 150)}`, `Payment${type}${pad(i, 2)} handles payment journal posting and settlement for scenario ${i}`);
    }
    for (let i = 1; i <= 150; i++) {
      const origin = i > 140 ? 'custom' : i > 130 ? 'isv' : 'microsoft';
      modules.run(`Module${pad(i)}`, 300 - i, 200 - i, 50 - (i % 50), 20 - (i % 20), 30 - (i % 30));
      versions.run(`Model${pad(i)}`, `Module${pad(i)}`, `Model ${i}`,
        origin === 'microsoft' ? 'Microsoft Corporation' : origin === 'isv' ? 'Golden ISV Ltd' : 'Trelleborg',
        origin === 'microsoft' ? 'SYS' : origin === 'isv' ? 'ISV' : 'USR', origin, `10.0.${2000 + i}.${i}`, 'C:\\pkg');
    }
  })();
  return db;
}

function buildXref() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = OFF');
  db.exec(`
    CREATE TABLE names (id INTEGER PRIMARY KEY, path TEXT NOT NULL, name TEXT, kind INTEGER, provider_id INTEGER, module_id INTEGER);
    CREATE TABLE refs (source_id INTEGER, target_id INTEGER, kind INTEGER, line INTEGER, col INTEGER);
    CREATE TABLE modules (id INTEGER PRIMARY KEY, module TEXT NOT NULL);
    CREATE TABLE providers (id INTEGER PRIMARY KEY, provider TEXT NOT NULL);
    CREATE TABLE model_versions (model_name TEXT PRIMARY KEY, module_id TEXT, display_name TEXT,
      publisher TEXT, layer TEXT, origin TEXT, version TEXT, source_root TEXT);
  `);
  const names = db.prepare('INSERT INTO names VALUES (?,?,?,?,?,?)');
  const refs = db.prepare('INSERT INTO refs VALUES (?,?,?,?,?)');
  db.transaction(() => {
    for (let m = 1; m <= 5; m++) db.prepare('INSERT INTO modules VALUES (?,?)').run(m, `GoldenModule${m}`);
    db.prepare('INSERT INTO providers VALUES (1, ?)').run('Microsoft');
    names.run(1000, '/Tables/GoldenTable', 'GoldenTable', 0, 1, 1);
    for (let i = 1; i <= 60; i++) names.run(1000 + i, `/Tables/GoldenTable/Fields/Field${pad(i)}`, `Field${pad(i)}`, 0, 1, 1);
    for (let i = 1; i <= 30; i++) names.run(1100 + i, `/Tables/GoldenTable/Methods/method${pad(i)}`, `method${pad(i)}`, 0, 1, 1);
    const KINDS = [1, 2, 4, 10, 1, 2];
    for (let i = 1; i <= 150; i++) {
      const id = 2000 + i;
      names.run(id, `/Classes/GoldenCaller${pad(i)}`, `GoldenCaller${pad(i)}`, 0, 1, (i % 5) + 1);
      refs.run(id, 1000, KINDS[i % KINDS.length], 10 + i, 5);
      // Every third caller also touches a field, so the summary has sub-object refs.
      if (i % 3 === 0) refs.run(id, 1000 + (i % 60) + 1, 2, 20 + i, 9);
    }
    for (let i = 1; i <= 20; i++) refs.run(1100 + i, 2000 + i, 1, i, 1);
  })();
  return db;
}

function buildSec() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = OFF');
  db.exec(`
    CREATE TABLE roles (role_id TEXT PRIMARY KEY, role_name TEXT NOT NULL, module_id TEXT, label TEXT, description TEXT,
      license_type TEXT, permission_type TEXT DEFAULT 'Grant', is_profile INTEGER DEFAULT 0, source TEXT DEFAULT 'test');
    CREATE TABLE role_subroles (parent_role_id TEXT, child_role_id TEXT, is_transitive INTEGER DEFAULT 0, PRIMARY KEY (parent_role_id, child_role_id));
    CREATE TABLE duties (duty_id TEXT PRIMARY KEY, duty_name TEXT, module_id TEXT, description TEXT);
    CREATE TABLE role_duties (role_id TEXT, duty_id TEXT, permission_type TEXT DEFAULT 'Grant', PRIMARY KEY (role_id, duty_id));
    CREATE TABLE privileges (privilege_name TEXT PRIMARY KEY, module_id TEXT, label TEXT);
    CREATE TABLE duty_privileges (duty_id TEXT, privilege_name TEXT, PRIMARY KEY (duty_id, privilege_name));
    CREATE TABLE privilege_entry_points (privilege_name TEXT, entry_point_name TEXT, object_type TEXT, object_name TEXT,
      grant_read TEXT, grant_create TEXT, grant_update TEXT, grant_delete TEXT, grant_correct TEXT, grant_invoke TEXT,
      PRIMARY KEY (privilege_name, entry_point_name));
    CREATE TABLE users (user_id TEXT PRIMARY KEY, person_name TEXT, email TEXT, enabled INTEGER DEFAULT 1, default_company TEXT);
    CREATE TABLE user_roles (user_id TEXT, role_id TEXT, PRIMARY KEY (user_id, role_id));
    CREATE TABLE user_role_companies (user_id TEXT, role_id TEXT, company_id TEXT, PRIMARY KEY (user_id, role_id, company_id));
    CREATE TABLE role_direct_privileges (role_id TEXT, privilege_name TEXT, PRIMARY KEY (role_id, privilege_name));
    CREATE TABLE role_direct_entity_permissions (role_id TEXT, entity_name TEXT, resource_type TEXT, grant_read TEXT, grant_create TEXT,
      grant_update TEXT, grant_delete TEXT, grant_correct TEXT, grant_invoke TEXT, PRIMARY KEY (role_id, entity_name));
    CREATE TABLE sec_search (object_type TEXT, object_name TEXT, module_id TEXT, content TEXT);
    CREATE TABLE sec_metadata (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE model_versions (model_name TEXT PRIMARY KEY, module_id TEXT, display_name TEXT,
      publisher TEXT, layer TEXT, origin TEXT, version TEXT, source_root TEXT);
  `);
  const roles = db.prepare('INSERT INTO roles VALUES (?,?,?,?,?,?,?,?,?)');
  const subroles = db.prepare('INSERT INTO role_subroles VALUES (?,?,?)');
  const duties = db.prepare('INSERT INTO duties VALUES (?,?,?,?)');
  const roleDuties = db.prepare('INSERT INTO role_duties VALUES (?,?,?)');
  const privileges = db.prepare('INSERT INTO privileges VALUES (?,?,?)');
  const dutyPrivs = db.prepare('INSERT INTO duty_privileges VALUES (?,?)');
  const entryPoints = db.prepare('INSERT INTO privilege_entry_points VALUES (?,?,?,?,?,?,?,?,?,?)');
  const users = db.prepare('INSERT INTO users VALUES (?,?,?,?,?)');
  const userRoles = db.prepare('INSERT INTO user_roles VALUES (?,?)');
  const userRoleCompanies = db.prepare('INSERT INTO user_role_companies VALUES (?,?,?)');
  const directPrivs = db.prepare('INSERT INTO role_direct_privileges VALUES (?,?)');
  const directPerms = db.prepare('INSERT INTO role_direct_entity_permissions VALUES (?,?,?,?,?,?,?,?,?)');
  const meta = db.prepare('INSERT INTO sec_metadata VALUES (?,?)');
  const versions = db.prepare('INSERT INTO model_versions VALUES (?,?,?,?,?,?,?,?)');

  db.transaction(() => {
    roles.run('R_GOLDEN', 'Golden role', 'ApplicationSuite', 'Golden role', 'Golden role with a wide direct-permission surface', 'Enterprise', 'Grant', 0, 'aot');
    for (let i = 1; i <= 5; i++) {
      roles.run(`R_SUB${i}`, `Golden sub-role ${i}`, 'ApplicationSuite', null, null, 'Activity', 'Grant', 0, 'aot');
      subroles.run('R_GOLDEN', `R_SUB${i}`, 0);
    }
    for (let i = 1; i <= 60; i++) {
      duties.run(`GoldenDuty${pad(i, 2)}`, `Maintain golden thing ${i}`, 'ApplicationSuite', `Duty ${i}`);
      roleDuties.run('R_GOLDEN', `GoldenDuty${pad(i, 2)}`, i % 15 === 0 ? 'Deny' : 'Grant');
      privileges.run(`GoldenPriv${pad(i, 2)}`, 'ApplicationSuite', `Golden privilege ${i}`);
      dutyPrivs.run(`GoldenDuty${pad(i, 2)}`, `GoldenPriv${pad(i, 2)}`);
      entryPoints.run(`GoldenPriv${pad(i, 2)}`, `GoldenMenuItem${pad(i, 2)}`, 'MenuItemDisplay', `GoldenForm${pad(i, 2)}`,
        'Allow', i % 2 ? 'Allow' : null, i % 2 ? 'Allow' : null, null, null, null);
    }
    for (let i = 1; i <= 30; i++) directPrivs.run('R_GOLDEN', `GoldenDirectPriv${pad(i, 2)}`);
    for (let i = 1; i <= 2000; i++) {
      directPerms.run('R_GOLDEN', `GoldenEntity${pad(i, 4)}`, 'DataEntity',
        'Allow', i % 3 === 0 ? 'Allow' : null, i % 3 === 0 ? 'Allow' : null, i % 9 === 0 ? 'Allow' : null, null, i % 5 === 0 ? 'Allow' : null);
    }
    for (let i = 1; i <= 10; i++) {
      users.run(`golden.user${i}`, `Golden User ${i}`, null, i === 10 ? 0 : 1, 'GLD1');
      userRoles.run(`golden.user${i}`, 'R_GOLDEN');
      userRoleCompanies.run(`golden.user${i}`, 'R_GOLDEN', ['GLD1', 'GLD2', 'GLD3'][i % 3]);
    }
    for (const [k, v] of [['build_date', '2026-01-01'], ['source', 'golden fixture'], ['aot_roles', '6'],
      ['dmf_rows', '0'], ['platform', '10.0.9999.1'], ['builder', 'sec-builder.js']]) meta.run(k, v);
    for (let i = 1; i <= 150; i++) {
      const origin = i > 140 ? 'custom' : i > 130 ? 'isv' : 'microsoft';
      versions.run(`Model${pad(i)}`, `Module${pad(i)}`, `Model ${i}`,
        origin === 'microsoft' ? 'Microsoft Corporation' : origin === 'isv' ? 'Golden ISV Ltd' : 'Trelleborg',
        origin === 'microsoft' ? 'SYS' : origin === 'isv' ? 'ISV' : 'USR', origin, `10.0.${2000 + i}.${i}`, 'C:\\pkg');
    }
  })();
  return db;
}

// ── Mock server ──────────────────────────────────────────────────────────────

function captureTools(register, db) {
  const handlers = {};
  register({
    registerTool: (name, config, handler) => { handlers[name] = { schema: config.inputSchema || {}, handler }; },
  }, db);
  return handlers;
}

/** Run a handler with the caller's args passed through Zod so every `.default()`
 *  applies — this is exactly what a client sending only the required arguments
 *  gets (`format` resolves to 'auto', the adaptive text channel). */
async function callDefault(handlers, name, args) {
  const tool = handlers[name];
  assert.ok(tool, `tool "${name}" not registered`);
  const validated = z.object(tool.schema).parse(args);
  const result = await tool.handler(validated);
  assert.ok(!result.isError, `${name}: returned an error — ${result.content?.[0]?.text?.slice(0, 200)}`);
  assert.ok(result.structuredContent, `${name}: no structuredContent — the size gate needs a typed payload`);
  return {
    json: JSON.stringify(result.structuredContent).length,
    text: result.content[0].text.length,
  };
}

// The ten calls of concept §3.1, default arguments only.
const CALLS = [
  ['kb', 'd365_lookup_table', { table_name: 'GoldenTable' }],
  ['kb', 'd365_search', { query: 'payment' }],
  ['kb', 'd365_get_enum', { enum_names: ['GoldenEnumA', 'GoldenEnumB'] }],
  ['kb', 'd365_get_class_methods', { name: 'GoldenClass' }],
  ['kb', 'd365_get_entity_sources', { entity_name: 'GoldenEntity' }],
  ['kb', 'd365_list_modules', {}],
  ['xref', 'xref_find_references', { object_name: 'GoldenTable' }],
  ['xref', 'xref_object_summary', { object_name: 'GoldenTable' }],
  ['sec', 'sec_lookup_role', { role_name: 'Golden role' }],
  ['sec', 'sec_stats', {}],
];

test('response-size golden: the ten §3.1 calls stay within ±10% of the recorded baseline (both channels)', async () => {
  const dbs = { kb: buildKb(), xref: buildXref(), sec: buildSec() };
  const handlers = {
    kb: captureTools(registerKbTools, dbs.kb),
    xref: captureTools(registerXrefTools, dbs.xref),
    sec: captureTools(registerSecTools, dbs.sec),
  };

  const measured = {};
  for (const [svc, name, args] of CALLS) {
    measured[name] = await callDefault(handlers[svc], name, args);
  }
  for (const db of Object.values(dbs)) db.close();

  if (process.env.GOLDEN_UPDATE === '1' || !existsSync(BASELINE_PATH)) {
    writeFileSync(BASELINE_PATH, JSON.stringify({
      _note: 'Response sizes (chars) of the ten concept-§3.1 calls with DEFAULT args against the synthetic fixture in test/response-size-golden.test.js. Regenerate deliberately with GOLDEN_UPDATE=1.',
      tolerance: TOLERANCE,
      calls: measured,
    }, null, 2) + '\n');
    console.log(`\nresponse-size golden: baseline ${existsSync(BASELINE_PATH) ? 'rewritten' : 'created'} at ${BASELINE_PATH}`);
  }

  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf-8')).calls;
  const rows = [];
  const breaches = [];
  for (const [, name] of CALLS) {
    const m = measured[name];
    const b = baseline[name];
    assert.ok(b, `${name}: missing from the baseline file — run with GOLDEN_UPDATE=1`);
    const delta = (cur, base) => (base ? (cur - base) / base : 0);
    const dj = delta(m.json, b.json);
    const dt = delta(m.text, b.text);
    rows.push(`  ${name.padEnd(26)} json ${String(m.json).padStart(7)} (${(100 * dj).toFixed(1).padStart(5)}%)`
      + `   text ${String(m.text).padStart(7)} (${(100 * dt).toFixed(1).padStart(5)}%)   text/json ${(m.text / m.json).toFixed(2)}`);
    if (Math.abs(dj) > TOLERANCE) breaches.push(`${name}.structuredContent ${b.json} → ${m.json} (${(100 * dj).toFixed(1)}%)`);
    if (Math.abs(dt) > TOLERANCE) breaches.push(`${name}.text ${b.text} → ${m.text} (${(100 * dt).toFixed(1)}%)`);
  }
  const totalJson = Object.values(measured).reduce((a, m) => a + m.json, 0);
  const totalText = Object.values(measured).reduce((a, m) => a + m.text, 0);
  console.log(`\nresponse-size golden (default args, synthetic fixture; Δ vs baseline):\n${rows.join('\n')}`
    + `\n  ${'TOTAL'.padEnd(26)} json ${String(totalJson).padStart(7)}           text ${String(totalText).padStart(7)}`
    + `           both ≈ ${Math.round((totalJson + totalText) / 4)} tk\n`);

  assert.deepEqual(breaches, [],
    `Response size moved by more than ${100 * TOLERANCE}% against the golden baseline. If the change is intended, `
    + `re-baseline deliberately: GOLDEN_UPDATE=1 node --test test/response-size-golden.test.js`);
});
