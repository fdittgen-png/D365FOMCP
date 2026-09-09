/**
 * update-kb-model.js — refresh the KB for ONE OR MORE custom models without a
 * full rebuild.
 *
 * Composes two pieces that already exist: `buildKnowledgeBase()` produces a
 * customizations-only KB, `mergeCustomKb()` folds it into the live one. All this
 * module adds is scoping — pointing the builder at just the models that were
 * compiled instead of the whole custom metadata root.
 *
 * SCOPING TRICK. `buildKnowledgeBase()` takes package *roots* and walks the
 * packages inside them, so handing it `<ModelStore>\iExtension` would be one
 * level too deep. Instead a throwaway directory of junctions to the requested
 * model folders is built and used as the root. Directory junctions need no
 * elevation on Windows; if creating one fails for any reason the whole
 * ModelStoreFolder is used instead, which is correct but slower.
 *
 * WHAT THIS CANNOT DO — and why the weekly full rebuild is not optional.
 * `mergeCustomKb()` is ADDITIVE: it upserts and never deletes. An object a
 * developer removes from a model stays in the KB, and every delta compounds
 * that. The delta keeps the KB current; only a full rebuild makes it correct.
 *
 * Usage:
 *   node build/update-kb-model.js iExtension --model-store="C:\Workspace\MAIN\Metadata"
 *   node build/update-kb-model.js iExtension HISOL --kb=<path> --isv
 */

import { join } from 'path';
import { existsSync, mkdtempSync, rmSync, symlinkSync, statSync } from 'fs';
import { tmpdir } from 'os';

const DEFAULT_KB = () => join(process.env.USERPROFILE || process.env.HOME || '.', '.claude', 'd365fo_kb.sqlite');

function log(msg) {
  process.stdout.write(`[${new Date().toISOString().slice(11, 19)}] ${msg}\n`);
}

/**
 * Build a throwaway root containing a junction per requested model.
 * @returns {{root:string, models:string[], cleanup:() => void, scoped:boolean}}
 */
export function scopeRoot(modelStoreFolder, models, logger = log) {
  const present = models.filter((m) => {
    const p = join(modelStoreFolder, m);
    try { return statSync(p).isDirectory(); } catch { return false; }
  });
  if (!present.length) {
    throw new Error(`None of [${models.join(', ')}] is a directory under ${modelStoreFolder}.`);
  }

  const dir = mkdtempSync(join(tmpdir(), 'kb-model-'));
  try {
    for (const m of present) symlinkSync(join(modelStoreFolder, m), join(dir, m), 'junction');
    return { root: dir, models: present, scoped: true, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  } catch (err) {
    // A junction is an optimisation, never a correctness requirement.
    rmSync(dir, { recursive: true, force: true });
    logger(`  junction scoping unavailable (${err.message}); falling back to the whole model store`);
    return { root: modelStoreFolder, models: present, scoped: false, cleanup: () => {} };
  }
}

/**
 * @param {object} [opts]
 * @param {string[]} [opts.models]           model folder names under the model store
 * @param {string} [opts.modelStoreFolder]   active XPP ModelStoreFolder
 * @param {string} [opts.kbDbPath]
 * @param {boolean} [opts.isv]               also refresh the sealed-ISV tables
 * @param {string[]|null} [opts.isvRoots]
 * @param {(msg:string)=>void} [opts.logger]
 */
export async function updateKbForModels({
  models,
  modelStoreFolder,
  kbDbPath = DEFAULT_KB(),
  isv = false,
  isvRoots = null,
  logger = log,
} = {}) {
  if (!models || !models.length) throw new Error('No models named.');
  if (!modelStoreFolder) throw new Error('No ModelStoreFolder — pass --model-store or let Refresh-McpData.ps1 resolve it from the active XPP configuration.');
  if (!existsSync(kbDbPath)) {
    throw new Error(`KB SQLite not found: ${kbDbPath}. Run a full \`npm run build:kb\` first — the delta refreshes an existing database, it does not create one.`);
  }

  const scope = scopeRoot(modelStoreFolder, models, logger);
  const work = mkdtempSync(join(tmpdir(), 'kb-delta-'));
  const customDb = join(work, 'custom-kb.sqlite');
  const summary = { models: scope.models, scoped: scope.scoped, kbDbPath };

  try {
    logger(`  building a customizations-only KB for [${scope.models.join(', ')}]...`);
    const { buildKnowledgeBase } = await import('./build-kb.js');
    const built = await buildKnowledgeBase({ packagesPaths: scope.root, outputPath: customDb });
    summary.built = built?.stats ?? null;

    logger('  merging into the live KB...');
    const { mergeCustomKb } = await import('./merge-kb-custom.js');
    summary.merged = mergeCustomKb(kbDbPath, customDb, (m) => logger(`  ${m}`));

    // Labels service: same models, same run — a compiled model's label files are
    // re-ingested into d365fo_labels.sqlite (DELETE + INSERT, fixes the
    // INSERT-OR-IGNORE staleness the KB merge has). Non-fatal; skipped when no
    // labels DB exists yet (LABELS_SCAN=off or never built).
    try {
      const { refreshLabelsModules, DEFAULT_LABELS_DB } = await import('./build-labels.js');
      const labelsDb = process.env.LABELS_DB_PATH || DEFAULT_LABELS_DB();
      if (process.env.LABELS_SCAN?.toLowerCase() !== 'off' && existsSync(labelsDb)) {
        logger('  refreshing the labels DB for the same models...');
        summary.labels = await refreshLabelsModules({ dbPath: labelsDb, modules: scope.models, packagesPaths: [modelStoreFolder], log: (m) => logger(`  ${m}`) });
      }
    } catch (err) {
      logger(`  labels DB refresh skipped: ${err.message}`);
    }

    if (isv) {
      // Sealed ISV models are vendor binaries: they change on an ISV upgrade,
      // not when someone compiles iExtension. Opt-in on purpose — the weekly
      // full pass is where this belongs.
      const { refreshIsvMetadata } = await import('./isv-scan.js');
      summary.isv = await refreshIsvMetadata({
        dbPath: kbDbPath,
        target: 'kb',
        roots: isvRoots || [modelStoreFolder],
        log: (m) => logger(`  ${m}`),
      });
    }
    return summary;
  } finally {
    scope.cleanup();
    try { rmSync(work, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/* ── CLI ──────────────────────────────────────────────────────────────────── */

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());

if (isMain) {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const hit = argv.find(a => a === `--${name}` || a.startsWith(`--${name}=`));
    if (!hit) return undefined;
    return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : true;
  };
  const models = argv.filter(a => !a.startsWith('--'));

  if (!models.length) {
    console.error('Usage: node build/update-kb-model.js <Model> [Model...] [--model-store=<dir>] [--kb=<sqlite>] [--isv]');
    process.exit(2);
  }

  updateKbForModels({
    models,
    modelStoreFolder: /** @type {string} */ (flag('model-store') || process.env.KB_MODEL_STORE || ''),
    kbDbPath: /** @type {string} */ (flag('kb') || process.env.KB_DB_PATH || DEFAULT_KB()),
    isv: flag('isv') === true,
  })
    .then((s) => {
      log(`Done. ${s.models.join(', ')} merged into ${s.kbDbPath}${s.scoped ? '' : ' (unscoped fallback)'}.`);
      process.exit(0);
    })
    .catch((err) => {
      console.error(`FAILED: ${err.message}`);
      process.exit(1);
    });
}
