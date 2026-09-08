/**
 * Per-model refresh of d365fo_labels.sqlite (Labels service, delta path).
 *
 *   node build/update-labels-model.js HSAPAC iExtension [--labels=<path>] [--packages=a;b] [--model-store=<dir>]
 *
 * Packages default to KB_PACKAGES_PATHS; --model-store adds the active XPP
 * model store the way Refresh-McpData.ps1 resolves it. build/update-kb-model.js
 * calls refreshLabelsModules() itself, so this CLI is for a labels-only refresh.
 */
import { pathToFileURL } from 'node:url';
import { refreshLabelsModules, DEFAULT_LABELS_DB, parsePathList } from './build-labels.js';

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const opt = (name) => { const hit = argv.find(a => a.startsWith(`--${name}=`)); return hit ? hit.slice(name.length + 3) : null; };
  const modules = argv.filter(a => !a.startsWith('--'));
  if (!modules.length) {
    console.error('Usage: node build/update-labels-model.js <Model> [<Model>…] [--labels=<path>] [--packages=a;b] [--model-store=<dir>]');
    process.exit(2);
  }
  const packagesPaths = [...parsePathList(opt('packages') || process.env.KB_PACKAGES_PATHS), ...(opt('model-store') ? [opt('model-store')] : [])];
  refreshLabelsModules({ dbPath: opt('labels') || process.env.LABELS_DB_PATH || DEFAULT_LABELS_DB(), modules, packagesPaths })
    .then(r => { console.log(`labels: ${r.modules.join(', ')} refreshed (${r.meta.toLocaleString()} ids in DB)`); process.exit(0); })
    .catch(err => { console.error('FATAL ERROR:', err.message); process.exit(1); });
}
