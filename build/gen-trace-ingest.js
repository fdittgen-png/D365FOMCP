#!/usr/bin/env node
/**
 * gen-trace-ingest — copy the trace contract into the ingest service.
 *
 * The message sink (`C:\working\ClaudeTrace`, Function App tis-d-claudetrace-func)
 * re-validates every record against THE contract — schema (AJV) and privacy
 * denylist (`sanitize()`) — so it carries copies of the contract modules, the
 * same way the plugin hook does (build/gen-trace-hook.js). Two repos, one
 * generator, one hash: `CONTRACT.sha256` lists the sha256 of every copied
 * file; the ingest repo's test recomputes it and fails with "run npm run
 * gen:trace-ingest in the MCP repo" on drift, and test/trace-ingest-generated
 * .test.js here fails when the copy on this machine is stale.
 *
 * Target: `$TRACE_INGEST_REPO/src/contract`, default `../ClaudeTrace/src/contract`.
 */
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, '..');
export const CONTRACT_DIR = join(ROOT, 'src', 'trace', 'contract');
export const COPIED = Object.freeze([
  'identifiers.js', 'privacy.js', 'arg-policies.js', 'vocabulary-match.js', 'sanitize.js', 'record.js',
  'validate.js', 'trace-record.v1.schema.json',
  // Not a contract module: the vocabulary DATA the sink's report needs to resolve a touched
  // object to its functional entity (entity hit rate, entity usage). Same generator, same
  // manifest, so it cannot drift from config/semantic-vocabulary.json.
  'vocabulary.json',
]);

/** Copied files that do NOT live in `src/trace/contract/`: name -> path from the repo root. */
export const EXTERNAL_SOURCES = Object.freeze({
  'vocabulary.json': ['config', 'semantic-vocabulary.json'],
});
export const MANIFEST = 'CONTRACT.sha256';

export function resolveTargetDir(env = process.env) {
  const repo = env.TRACE_INGEST_REPO || join(ROOT, '..', 'ClaudeTrace');
  return join(resolve(repo), 'src', 'contract');
}

/** `<sha256>  <file>` per line, in COPIED order — the `sha256sum -c` format. */
export function manifestText(hashes) {
  return COPIED.map((f) => `${hashes[f]}  ${f}`).join('\n') + '\n';
}

/** Contract file as LF text — the hash must not depend on the checkout's autocrlf setting. */
export function contractText(f) {
  return readFileSync(EXTERNAL_SOURCES[f] ? join(ROOT, ...EXTERNAL_SOURCES[f]) : join(CONTRACT_DIR, f), 'utf8').replace(/\r\n/g, '\n');
}

export function generate({ write = true, env = process.env } = {}) {
  const texts = {};
  const hashes = {};
  for (const f of COPIED) {
    texts[f] = contractText(f);
    hashes[f] = createHash('sha256').update(texts[f]).digest('hex');
  }
  const manifest = manifestText(hashes);
  const target = resolveTargetDir(env);
  if (write) {
    mkdirSync(target, { recursive: true });
    for (const f of COPIED) writeFileSync(join(target, f), texts[f]);
    writeFileSync(join(target, MANIFEST), manifest);
  }
  return { hashes, manifest, target };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const r = generate();
  console.log(`gen-trace-ingest: ${COPIED.length} contract files + ${MANIFEST} → ${r.target}`);
}
