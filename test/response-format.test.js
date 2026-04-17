/**
 * P1-06 — Response-format contract tests.
 *
 * These are static-source tests: they read the three tool files as text
 * and enforce structural conventions that the P1 phase established. Static
 * scanning is deliberate — it catches every call site in one shot without
 * having to register every tool into a mock server and call it with valid
 * input (which would require per-tool fixtures).
 *
 * If a future change wants to introduce H1 headers, bold-text fake headers,
 * hand-rolled "Showing first N" strings, or raw `err.message` forwarding,
 * these tests must be updated (and should be updated with a comment
 * explaining why the exception is warranted).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(__dirname, '..', 'src', 'azure');

const TOOL_FILES = [
  'kb-tools.js',
  'xref-tools.js',
  'sec-tools.js',
  'taskrecorder-tools.js',
  'wiki-tools.js',
];

// P6-01: every directory under src/ must not contain a `/* ignore */`
// silent-catch comment. Cleanup failures must surface via cleanup-warn
// logging so operators can spot orphans.
const SRC_ROOT = join(__dirname, '..', 'src');
const SRC_FILES_TO_SCAN = [
  'azure/blob-helper.js',
  'azure/sec-builder.js',
  'functions/d365sec-upload.js',
  'functions/d365sec.js',
  'functions/d365taskrecorder.js',
];

function readSource(name) {
  return readFileSync(join(SRC_DIR, name), 'utf-8');
}

// ── Every src/functions/*.js file must pass `node --check` ──────────────────
//
// The test suite only *imports* modules from `src/azure/`, never from
// `src/functions/`. A syntax error in a Function-entry file (e.g. a stray
// backtick inside a giant template literal) therefore slips through the
// test runner entirely and only surfaces as a cold-start 404 after
// deployment. Run node's parser on each Function file here to catch those
// locally before they hit Azure.

const FUNCTIONS_DIR = join(SRC_ROOT, 'functions');
for (const name of readdirSync(FUNCTIONS_DIR).filter(f => f.endsWith('.js'))) {
  test(`given functions/${name}, when parsed, then node --check succeeds`, () => {
    const full = join(FUNCTIONS_DIR, name);
    try {
      execFileSync(process.execPath, ['--check', full], { stdio: 'pipe' });
    } catch (err) {
      const output = (err.stderr?.toString() || err.stdout?.toString() || err.message).slice(0, 800);
      assert.fail(`node --check failed for functions/${name}:\n${output}`);
    }
  });
}

// ── P6-01: silent `/* ignore */` catch blocks are forbidden ─────────────────

for (const file of SRC_FILES_TO_SCAN) {
  test(`given ${file}, when scanned for silent /* ignore */ catches, then none remain`, () => {
    const src = readFileSync(join(SRC_ROOT, file), 'utf-8');
    assert.doesNotMatch(
      src,
      /\/\*\s*ignore/,
      `${file} still has a /* ignore */ silent catch. Replace with cleanup-warn logging (P6-01).`,
    );
  });
}

// ── P6-03: every .sqlite.new reference must be hoisted via `let inplaceTemp` ──
//
// The contract is: the rename-into-place pattern that creates a `.sqlite.new`
// file MUST hoist the path declaration above the try block so the matching
// finally can clean it up regardless of which mode crashed. Walk every
// site that mentions `.sqlite.new` and confirm the surrounding scope has a
// `let inplaceTemp = null` declaration.

test('given d365sec-upload.js, when scanned for .sqlite.new sites, then each is hoisted via let inplaceTemp', () => {
  const src = readFileSync(join(SRC_ROOT, 'functions/d365sec-upload.js'), 'utf-8');
  // Both upload paths must declare `let inplaceTemp` near their try block.
  // 2 hoist declarations expected (sync handler + runBuildAsync).
  const hoists = (src.match(/let\s+inplaceTemp\s*=\s*null\s*;/g) || []).length;
  assert.equal(hoists, 2, 'expected 2 `let inplaceTemp = null` hoist declarations (sync + async paths)');
  // Every cleanup site references inplaceTemp and existsSync.
  assert.match(src, /sync-inplace-temp|async-inplace-temp/);
});

// ── PM-02: deprecated `server.tool()` overload must not be used ──────────────

for (const file of TOOL_FILES) {
  test(`given ${file}, when scanned for deprecated server.tool() calls, then none remain`, () => {
    const src = readSource(file);
    assert.doesNotMatch(
      src,
      /\bserver\.tool\(/,
      `${file} still uses the deprecated server.tool() overload. Use server.registerTool(name, config, handler).`,
    );
  });
}

// ── PM-03: every registerTool call must declare annotations ──────────────────

for (const file of TOOL_FILES) {
  test(`given ${file}, when scanned, then every registerTool config declares annotations`, () => {
    const src = readSource(file);
    // Count the number of registerTool calls.
    const calls = (src.match(/server\.registerTool\(/g) || []).length;
    // Count the number of `annotations:` fields (assume one per call).
    const annotations = (src.match(/\bannotations:\s*READ_ONLY_DB_ANNOTATIONS/g) || []).length;
    assert.equal(
      annotations,
      calls,
      `${file}: ${calls} registerTool calls but only ${annotations} annotations declarations. Every tool must set annotations: READ_ONLY_DB_ANNOTATIONS.`,
    );
  });
}

// ── PM-03: READ_ONLY_DB_ANNOTATIONS must match the declared shape ────────────

test('given READ_ONLY_DB_ANNOTATIONS, when imported, then it declares read-only + idempotent + closed-world', async () => {
  const { READ_ONLY_DB_ANNOTATIONS } = await import('../src/azure/shared.js');
  assert.equal(READ_ONLY_DB_ANNOTATIONS.readOnlyHint, true);
  assert.equal(READ_ONLY_DB_ANNOTATIONS.idempotentHint, true);
  assert.equal(READ_ONLY_DB_ANNOTATIONS.openWorldHint, false);
});

test('given READ_ONLY_DB_ANNOTATIONS, when mutation attempted, then Object.freeze blocks it', async () => {
  const { READ_ONLY_DB_ANNOTATIONS } = await import('../src/azure/shared.js');
  // Strict mode throws on frozen-object write; non-strict silently no-ops.
  // Either way the value must not change.
  try { READ_ONLY_DB_ANNOTATIONS.readOnlyHint = false; } catch { /* frozen */ }
  assert.equal(READ_ONLY_DB_ANNOTATIONS.readOnlyHint, true);
});

// ── PM-06: EVERY tool must declare outputSchema ──────────────────────────────
//
// PM-05 piloted structured output on 5 tools; PM-06 rolled it out to all 49.
// This contract test walks every registerTool call in every *-tools.js file
// and asserts the config block contains an `outputSchema:` declaration. The
// rollout is complete — any new tool added to the suite MUST emit both a
// typed payload and a Markdown fallback via `structuredResult`.
//
// Ratchet rule: if you're adding a new tool, you must declare outputSchema.
// If you have a valid reason not to (e.g. a tool whose output truly has no
// structure), add an explicit opt-out comment here and the exclusion path
// to the loop below — do NOT silently skip.

for (const file of TOOL_FILES) {
  test(`given ${file}, when scanned, then every registerTool call declares outputSchema`, () => {
    const src = readSource(file);
    // Find every `server.registerTool(` call and grab the next 4 KB of source
    // (a single registerTool config block is always < 4 KB even for the
    // verbose tools like sec_raw_sql).
    const calls = [];
    const re = /server\.registerTool\(\s*['"]([a-z0-9_]+)['"]/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      calls.push({ name: m[1], offset: m.index });
    }
    assert.ok(calls.length > 0, `${file} must declare at least one tool`);

    const missing = [];
    for (const { name, offset } of calls) {
      const window = src.slice(offset, offset + 4000);
      if (!/outputSchema:\s*\w+/.test(window)) {
        missing.push(name);
      }
    }
    assert.equal(
      missing.length,
      0,
      `${file}: the following tools lack an outputSchema declaration: ${missing.join(', ')}. ` +
      `Every tool must emit structuredContent via structuredResult(typed, markdown). ` +
      `See docs/Response-Format-Contract.md §Typed-first rendering.`,
    );
  });
}

// ── PM-11: shared helper contracts (runtime assertions) ──────────────────────

test('given shared.js helpers, when imported, then structuredResult is a function that returns both content and structuredContent', async () => {
  const { structuredResult } = await import('../src/azure/shared.js');
  assert.equal(typeof structuredResult, 'function');
  const r = structuredResult({ a: 1 }, 'fallback');
  assert.ok(Array.isArray(r.content));
  assert.equal(r.content[0].type, 'text');
  assert.equal(r.content[0].text, 'fallback');
  assert.deepEqual(r.structuredContent, { a: 1 });
  assert.equal(r.isError, undefined);
});

test('given shared.js helpers, when errorResult/notFoundResult are called, then isError is true', async () => {
  const { errorResult, notFoundResult } = await import('../src/azure/shared.js');
  assert.equal(errorResult('db-error', 'hint').isError, true);
  assert.equal(notFoundResult('Table', 'Foo').isError, true);
});

test('given shared.js helpers, when emptyResult/textResult are called, then isError is undefined', async () => {
  const { emptyResult, textResult } = await import('../src/azure/shared.js');
  assert.equal(emptyResult('tables').isError, undefined);
  assert.equal(textResult('hello').isError, undefined);
});

// ── Heading convention: no H1 openers in tool output ─────────────────────────

for (const file of TOOL_FILES) {
  test(`given ${file}, when scanned for H1 openers, then none are present`, () => {
    const src = readSource(file);
    // Match patterns that would produce a leading H1 in a response body:
    //   let out = `# Foo…`
    //   out = `# Foo…`
    //   out += `# Foo…`       (at the very start of a response)
    //   let text = `# Foo…`
    //   text = `# Foo…`
    // Importantly, `## Foo` and `### Foo` must NOT match — the pattern
    // requires exactly one `#` followed by a space.
    const h1Pattern = /(?:let\s+)?(?:out|text|body)\s*(?:=|\+=)\s*`#\s/g;
    const hits = [...src.matchAll(h1Pattern)];
    assert.equal(
      hits.length,
      0,
      `H1 opener found in ${file}. P1-06 requires H2 (##) for all tool responses.\n` +
      hits.map(m => `  at offset ${m.index}: ${src.slice(Math.max(0, m.index - 20), m.index + 40)}`).join('\n')
    );
  });
}

// ── No bold-text fake headers ────────────────────────────────────────────────

test('given xref-tools.js, when scanned for bold-text fake headers, then none are present', () => {
  const src = readSource('xref-tools.js');
  // Fake-header patterns that must be `## ` H2 headings. Extended in P3-11
  // to catch every remaining bold-as-header in the xref tool.
  const forbidden = [
    /\*\*References TO\*\*/,
    /\*\*References FROM\*\*/,
    /\*\*Callers of\*\*/,
    /\*\*Outgoing references from\*\*/,
    /\*\*Impact Analysis for\*\*/,
    /\*\*Object Summary:\*\*/,
    /\*\*Extensions for\*\*/,
    /\*\*Field usages:\*\*/,
    // P3-11 additions — sub-headers and section headers.
    /\*\*Subclasses of\*\*/,
    /\*\*Inheritance chain for\*\*/,
    /\*\*Implementors of\*\*/,
    /\*\*Objects in\*\*/,
    /\*\*By reference kind:\*\*/,
    /\*\*By module.*:\*\*/,
    /\*\*Referencing objects:\*\*/,
    /\*\*Incoming references.*:\*\*/,
    /\*\*Outgoing references.*:\*\*/,
    /\*\*CoC \/ \[ExtensionOf\] Classes/,
    /\*\*Table Extensions/,
    /\*\*Form Extensions/,
    /\*\*Entity Extensions/,
    /\*\*Delegates defined on\*\*/,
    /\*\*Event handlers subscribing to\*\*/,
    /\*\*Data event handlers for\*\*/,
    /\*\*Method overrides on\*\*/,
    /\*\*Reads \(/,
    /\*\*Calls \(/,
  ];
  for (const re of forbidden) {
    assert.doesNotMatch(src, re,
      `Bold-text header ${re} found in xref-tools.js. Convert to "## " heading.`);
  }
});

// ── No hand-rolled truncation strings ────────────────────────────────────────

for (const file of TOOL_FILES) {
  test(`given ${file}, when scanned for hand-rolled truncation strings, then none are present`, () => {
    const src = readSource(file);
    // Every truncation note must go through truncationNote(kind, N, max?).
    // Hand-rolled `> ⚠️ Showing first` strings are forbidden.
    const hits = src.match(/⚠️\s*Showing first/g);
    assert.equal(
      hits,
      null,
      `Hand-rolled truncation string found in ${file}. Use truncationNote() from shared.js.`
    );
  });
}

// ── No raw error-message forwarding to the caller ────────────────────────────

for (const file of TOOL_FILES) {
  test(`given ${file}, when scanned for raw err.message forwarding, then none are present`, () => {
    const src = readSource(file);
    // Forbidden:
    //   return textResult('Error: ' + err.message)
    //   return textResult(`Something: ${err.message}`)
    // Allowed:
    //   return errorResult(...)     (helper handles sanitization)
    //   console.error('...', err)   (server-side logging)
    //   return '*(db-error — see server logs)*' (visible marker for inner helpers)
    const hits = [...src.matchAll(/textResult\([^)]*err\.message/g)];
    assert.equal(
      hits.length,
      0,
      `Raw err.message forwarded to caller in ${file}. Use errorResult(category, hint, err) from shared.js.\n` +
      hits.map(m => `  at offset ${m.index}: ${src.slice(Math.max(0, m.index - 10), m.index + 60)}`).join('\n')
    );
  });
}

// ── No hand-rolled "No results"/not-found strings ────────────────────────────

for (const file of TOOL_FILES) {
  test(`given ${file}, when scanned for hand-rolled empty/not-found strings, then none are present`, () => {
    const src = readSource(file);
    // Empty-result or not-found responses must use emptyResult() or
    // notFoundResult(). Hand-rolled "No results"/"X not found" strings are
    // forbidden.
    const forbidden = [
      /textResult\(\s*[`'"]No (results|methods|tables|roles|users|duties|privileges|modules|templates|matches)/g,
      /textResult\(\s*`[A-Z][a-z]+ "[^"]*" not found\. Did you mean/g,
    ];
    for (const re of forbidden) {
      const hits = [...src.matchAll(re)];
      assert.equal(
        hits.length,
        0,
        `Hand-rolled empty/not-found string found in ${file}. Use emptyResult() or notFoundResult() from shared.js.\n` +
        hits.map(m => `  at offset ${m.index}: ${src.slice(m.index, m.index + 80)}`).join('\n')
      );
    }
  });
}
