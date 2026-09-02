#!/usr/bin/env node
/**
 * Write the ERP-neutral `sem_export` JSON of the local semantic database.
 *
 *   node build/export-semantic.js [--out sem-export.json]
 *
 * The export is the cross-ERP contract (docs/Semantic-Layer.md): vocabulary,
 * mappings, relations and the latest version of every DQ rule for this
 * installation. It is the input of build/gen-dq-sql.js and of the external
 * cross-ERP matcher. Metadata only — nothing in it is a business record.
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openSemanticDb, ensureVocabulary, exportSemantic } from '../src/azure/semantic-store.js';

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--out');
  const outPath = i >= 0 ? argv[i + 1] : (argv.find(a => a.startsWith('--out='))?.slice(6) ?? 'sem-export.json');
  const db = openSemanticDb();
  ensureVocabulary(db);   // a fresh database exports the checked-in vocabulary, not nothing
  const exp = exportSemantic(db);
  writeFileSync(outPath, JSON.stringify(exp, null, 2), 'utf-8');
  console.log(`${outPath}: ${exp.vocabulary.length} entities, ${exp.mappings.length} mappings, ${exp.dq_rules.length} rules (${exp.erp_system}/${exp.installation_id})`);
  db.close();
}
