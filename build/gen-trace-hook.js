#!/usr/bin/env node
/**
 * gen-trace-hook — assemble the plugin hook's dependency-free library.
 *
 * The Claude Code hook (`plugin/d365fo-mcp/hooks/trace-capture.mjs`) runs from
 * the plugin cache with no node_modules, so it carries COPIES of the trace
 * contract modules and two generated JSON files:
 *
 *   hooks/lib/{identifiers,privacy,arg-policies,vocabulary-match,sanitize,record}.js
 *       byte-identical copies of src/trace/contract/*  (test/trace-generated.test.js)
 *   hooks/lib/arg-policies.json
 *       { <tool>: { <param>: policy } } derived from every registered tool's Zod
 *       inputSchema (src/trace/client/zod-arg-types.js) — the hook has no Zod
 *   hooks/lib/vocabulary.json
 *       copy of config/semantic-vocabulary.json (the logical-entity hypothesis)
 *
 * Run `npm run gen:trace-hook` after changing a contract module, a tool's
 * inputSchema or the vocabulary; the test fails otherwise.
 */
import { copyFileSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerKbTools } from '../src/azure/kb-tools.js';
import { registerXrefTools } from '../src/azure/xref-tools.js';
import { registerSecTools } from '../src/azure/sec-tools.js';
import { registerTaskRecorderTools } from '../src/azure/taskrecorder-tools.js';
import { registerIsvKbTools } from '../src/azure/isv-kb-tools.js';
import { registerCustomFieldTools } from '../src/azure/custom-fields-tools.js';
import { registerIsvXrefTools } from '../src/azure/isv-xref-tools.js';
import { registerLabelsTools } from '../src/azure/labels-tools.js';
import { argPolicies } from '../src/trace/client/zod-arg-types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, '..');
export const CONTRACT_DIR = join(ROOT, 'src', 'trace', 'contract');
export const HOOK_LIB = join(ROOT, 'plugin', 'd365fo-mcp', 'hooks', 'lib');
export const COPIED = Object.freeze(['identifiers.js', 'privacy.js', 'arg-policies.js', 'vocabulary-match.js', 'sanitize.js', 'record.js']);

const stubDb = {
  prepare: () => ({ all: () => [], get: () => undefined, run: () => ({ changes: 0 }), pluck() { return this; } }),
  pragma: () => [],
  exec: () => {},
};

function captureServer() {
  const tools = [];
  return {
    tools,
    registerTool(name, config) { tools.push({ name, inputSchema: config?.inputSchema ?? {} }); },
    tool(name, _description, schema) { tools.push({ name, inputSchema: schema ?? {} }); },
  };
}

/** `{ tool: { param: policy } }` for every tool of the four D365FO services. */
export function deriveAllArgPolicies() {
  const server = captureServer();
  for (const register of [registerKbTools, registerIsvKbTools, registerCustomFieldTools, registerXrefTools, registerIsvXrefTools, registerSecTools, registerLabelsTools]) register(server, stubDb);
  registerTaskRecorderTools(server);
  const out = {};
  for (const t of server.tools.sort((a, b) => a.name.localeCompare(b.name))) {
    const p = argPolicies(t.inputSchema);
    out[t.name] = Object.fromEntries(Object.entries(p).filter(([, v]) => v != null));
  }
  return out;
}

export function generate({ write = true } = {}) {
  const policies = deriveAllArgPolicies();
  const policiesJson = JSON.stringify(policies, null, 1) + '\n';
  const vocabulary = readFileSync(join(ROOT, 'config', 'semantic-vocabulary.json'), 'utf8');
  if (write) {
    mkdirSync(HOOK_LIB, { recursive: true });
    for (const f of COPIED) copyFileSync(join(CONTRACT_DIR, f), join(HOOK_LIB, f));
    writeFileSync(join(HOOK_LIB, 'arg-policies.json'), policiesJson);
    writeFileSync(join(HOOK_LIB, 'vocabulary.json'), vocabulary);
  }
  return { policies, policiesJson, vocabulary, toolCount: Object.keys(policies).length };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const r = generate();
  const params = Object.values(r.policies).reduce((n, p) => n + Object.keys(p).length, 0);
  console.log(`gen-trace-hook: ${COPIED.length} contract copies, ${r.toolCount} tools / ${params} parameters with a policy, vocabulary copied → ${HOOK_LIB}`);
}
