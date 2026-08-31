/**
 * Verify that rebuilt databases carry model build provenance.
 * Called by Rebuild-Provenance.ps1 with VERIFY_DBS={"kb":"<path>",...}.
 * Lives inside the repo so require('better-sqlite3') resolves to the
 * project's node_modules.
 */
const Database = require('better-sqlite3');

const META_TABLE = { kb: 'kb_metadata', sec: 'sec_metadata', xref: 'xref_metadata' };
const targets = JSON.parse(process.env.VERIFY_DBS || '{}');
let failed = false;

for (const [label, path] of Object.entries(targets)) {
  try {
    const db = new Database(path, { readonly: true });
    const n = db.prepare('SELECT COUNT(*) AS n FROM model_versions').get().n;
    const custom = db.prepare(
      "SELECT model_name, version, layer, origin FROM model_versions WHERE origin <> 'microsoft' ORDER BY model_name"
    ).all();
    const bd = db.prepare(`SELECT value FROM ${META_TABLE[label]} WHERE key = 'build_date'`).get()?.value;
    console.log(`${label}: ${n} models, build_date ${bd}`);
    for (const c of custom) console.log(`  ${c.origin}/${c.layer}  ${c.model_name}  ${c.version}`);
    if (n < 100) { console.log(`  !! ${label}: expected ~180 models, got ${n}`); failed = true; }
    if (!custom.some(c => c.model_name.toLowerCase() === 'iextension')) {
      console.log(`  !! ${label}: iExtension missing from model_versions`);
      failed = true;
    }
    db.close();
  } catch (e) {
    console.log(`${label}: FAILED - ${e.message}`);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
