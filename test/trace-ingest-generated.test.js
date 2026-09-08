/**
 * gen-trace-ingest — the ingest service (C:\working\ClaudeTrace) validates
 * against COPIES of the contract modules, the way the plugin hook does. The
 * generator writes the copies plus a CONTRACT.sha256 manifest; the ingest
 * repo's own test recomputes the manifest and fails on drift. This test pins
 * the generator: what it copies, that the manifest is deterministic, and —
 * when the ingest repo is present on this machine — that its copy is current.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { generate, COPIED, CONTRACT_DIR, resolveTargetDir, manifestText, contractText } from '../build/gen-trace-ingest.js';

const lf = (s) => s.replace(/\r\n/g, '\n');

test('copies every contract module the validator and sanitizer need, plus the schema', () => {
  assert.deepEqual([...COPIED].sort(), [
    'arg-policies.js', 'identifiers.js', 'privacy.js', 'record.js', 'sanitize.js',
    'trace-record.v1.schema.json', 'validate.js', 'vocabulary-match.js',
  ]);
  for (const f of COPIED) assert.ok(existsSync(join(CONTRACT_DIR, f)), `${f} missing from the contract dir`);
});

test('manifest is one sha256 per copied file, deterministic, and matches the source bytes', () => {
  const a = generate({ write: false });
  const b = generate({ write: false });
  assert.equal(a.manifest, b.manifest);
  const lines = a.manifest.trimEnd().split('\n');
  assert.equal(lines.length, COPIED.length);
  for (const line of lines) {
    const m = /^([0-9a-f]{64})  (\S+)$/.exec(line);
    assert.ok(m, `malformed manifest line: ${line}`);
    const expected = createHash('sha256').update(contractText(m[2])).digest('hex');
    assert.equal(m[1], expected, `${m[2]} hash`);
    assert.equal(contractText(m[2]).includes('\r'), false, 'hashes are over LF text, independent of autocrlf');
  }
  assert.equal(manifestText(a.hashes), a.manifest);
});

test('target dir comes from TRACE_INGEST_REPO, else the sibling ClaudeTrace checkout', () => {
  assert.equal(resolveTargetDir({ TRACE_INGEST_REPO: 'X:/somewhere' }), join('X:/somewhere', 'src', 'contract'));
  assert.ok(resolveTargetDir({}).replace(/\\/g, '/').endsWith('/ClaudeTrace/src/contract'));
});

test('the ingest repo copy on this machine is current (skipped when the repo is absent)', (t) => {
  const target = resolveTargetDir(process.env);
  if (!existsSync(join(target, 'CONTRACT.sha256'))) return t.skip(`no ingest copy at ${target}`);
  const { manifest } = generate({ write: false });
  assert.equal(readFileSync(join(target, 'CONTRACT.sha256'), 'utf8'), manifest, 'run `npm run gen:trace-ingest`');
  for (const f of COPIED) {
    assert.equal(lf(readFileSync(join(target, f), 'utf8')), contractText(f), `${f} drifted — run \`npm run gen:trace-ingest\``);
  }
});
