/**
 * The Azure package is assembled from an explicit folder list. On 2026-09-07 a new
 * `src/trace` folder imported by `tool-sets.js` was not on that list: the worker
 * indexed ZERO functions while Easy Auth kept answering 401, so every "expect 401"
 * health check passed and only the anonymous /api/ping probe failed. This test
 * fails the build instead: every `src/<dir>` that the Azure code imports must be
 * staged by scripts/Deploy-FunctionApp.ps1.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');

function walk(dir, acc = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (p.endsWith('.js')) acc.push(p);
  }
  return acc;
}

/** Top-level src/<dir> names reachable by import from src/azure and src/functions (transitively). */
function importedSrcDirs() {
  const seen = new Set(['azure', 'functions']);
  const queue = ['azure', 'functions'];
  while (queue.length) {
    const dir = queue.shift();
    for (const f of walk(join(SRC, dir))) {
      for (const m of readFileSync(f, 'utf8').matchAll(/from\s+['"](\.\.?\/[^'"]+)['"]/g)) {
        const target = join(dirname(f), m[1]);
        const rel = target.startsWith(SRC) ? target.slice(SRC.length + 1).split(/[\\/]/)[0] : null;
        if (rel && rel.includes('.') === false && !seen.has(rel)) { seen.add(rel); queue.push(rel); }
      }
    }
  }
  return [...seen].sort();
}

describe('Azure deploy staging', () => {
  it('scripts/Deploy-FunctionApp.ps1 stages every src/<dir> the Azure code imports', () => {
    const script = readFileSync(join(ROOT, 'scripts', 'Deploy-FunctionApp.ps1'), 'utf8');
    const missing = importedSrcDirs().filter((d) => !script.includes(`src\\${d}`));
    assert.deepEqual(missing, [], `add these folders to the staging block of Deploy-FunctionApp.ps1: ${missing.join(', ')}`);
  });
  it('the transitive import walk finds the trace module (guards the guard)', () => {
    assert.ok(importedSrcDirs().includes('trace'));
  });
});
