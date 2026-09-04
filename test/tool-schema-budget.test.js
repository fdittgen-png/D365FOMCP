/**
 * Tool-schema budget.
 *
 * The serialized `tools/list` payload — every tool's name, description,
 * annotations and BOTH schemas — is re-sent on EVERY request of a session that
 * has the server connected. It is the one response cost that cannot be
 * filtered, limited, paginated or narrowed by an argument: it is paid before a
 * single tool runs.
 *
 * This test measures it the only way that cannot drift from reality: it starts
 * a real `McpServer` per service, registers EXACTLY the tool sets the entry
 * points register (`src/azure/tool-sets.js` is the single source of truth, and
 * a static scan below proves every entry point goes through it), connects a
 * real SDK `Client` over an `InMemoryTransport`, and captures the actual
 * `tools/list` result message off the transport before the client parses it.
 * What is counted is byte-for-byte what a Streamable HTTP response would carry.
 *
 * ── Wire facts (W0.3, issue #104) — measured 2026-09-02 ─────────────────────
 *
 * Measured twice: once against the four LOCAL stdio servers through the SDK's
 * `Client` + `StdioClientTransport` (scratch script, production DB paths), and
 * again by this test's own transport capture against empty in-memory DBs.
 *
 *  (a) `$schema` IS on the wire, on EVERY inputSchema and outputSchema:
 *      `"$schema":"http://json-schema.org/draft-07/schema#"` — 116 of 116
 *      schemas across the 58 tools, ~52 B each, ≈ 6 KB of the grand total.
 *      Cause: `McpServer` converts through `toJsonSchemaCompat()`, which calls
 *      `z4mini.toJSONSchema(schema, { target: 'draft-7', io })`
 *      (node_modules/@modelcontextprotocol/sdk/dist/esm/server/zod-json-schema-compat.js).
 *      Zod 4 emits `$schema` for every top-level conversion.
 *  (b) Repeated nested shapes are INLINED, never shared: 0 `$ref`, 0
 *      `$defs`/`definitions` in all 116 schemas. The SDK passes no `reused`
 *      option, so the single/batch row duplication in `d365_lookup_table`,
 *      `d365_check_field_exists`, `d365_get_enum`, `xref_object_summary` is
 *      paid twice on the wire. W1 (#105) owns both levers.
 *  (c) Not asked for, but shipped: SDK 1.27 adds
 *      `"execution":{"taskSupport":"forbidden"}` (39 B) to every tool.
 *
 *  Wire vs test: local stdio servers via the SDK Client — KB 69,113 · XRef
 *  36,596 · Sec 36,837 · Task Recorder 13,243 B; this test on the same code —
 *  69,113 · 36,596 · 36,837 · 13,243 B. Identical to the byte, all four.
 *  The previous test re-implemented the serialiser with `z.toJSONSchema()`
 *  (draft 2020-12, no `execution`) and registered ONE of the KB server's three
 *  tool sets, reporting 43,975 B for a server that ships 69 KB. Before that, a
 *  version counted only name + description + inputSchema (PR #102). Three
 *  budgets, three different wrong numbers — hence: capture the real message.
 *
 * The ceilings are not aspirational targets — they are "you have changed
 * something big, come and look" tripwires, set ≤2% above the measurement.
 * Raising one is a normal, deliberate act; doing it without noticing is what
 * this prevents.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv-provider.js';

import { TOOL_SETS, registerServiceTools } from '../src/azure/tool-sets.js';
import { serverInfo, serverOptions } from '../src/azure/server-metadata.js';
import { CORE_TOOLS } from '../src/azure/tool-guards.js';
import { runWithRequestContext } from '../src/azure/request-context.js';

// The budget is the FULL surface. A profile or guard left over in the
// environment would silently shrink or alter it.
delete process.env.MCP_TOOL_PROFILE;
delete process.env.MCP_TOOL_GUARDS;

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(__dirname, '..', 'src');

// The budget is a property of the REGISTRATIONS, not of any data: an empty
// in-memory database is enough. The tools' registration-time probes
// (`PRAGMA table_info`, ISV presence) all degrade to "absent" against it, which
// is the correct baseline — a schema must not get cheaper just because the
// machine happens to have a populated snapshot.
const emptyDb = () => new Database(':memory:');

/**
 * Per-server ceilings, ≤2% above the measurement. Re-baselined DOWN on
 * 2026-09-02 after W1 (#105): kb 74,354 · xref 35,047 · sec 38,234 ·
 * taskrecorder 8,131 B; total 155,766 B ≈ 38,942 tk (from 183,810 B before W1,
 * −15.3%: nullable→nullish/optional −5,904 · `$schema` strip −6,552 ·
 * descriptions + input prose −9,039 · ISV/Task-Recorder output prose −6,549).
 * Lowering the ceiling after a diet is the point — otherwise the saving erodes
 * one unnoticed 300 B at a time.
 * `tools` is the count the server registers today — a drop means a set was
 * removed or filtered, which is as much a "come and look" event as a breach.
 */
const BUDGET = {
  // History (all 2026-09-02): kb 70,400 -> 71,000 (#83 d365_search queries[]);
  // -> 76,400 and 22 tools (#85 d365_effective_schema, +5,679 B); -> 77,100
  // (#109 cursor pagination); -> 91,100 and 26 tools (W7 #111, four semantic
  // tools +11,656 B); W1 (#105) 88,940 measured -> 74,354, ceiling 75,800.
  // Q2–Q5 (#115–#118, 2026-09-02): 74,354 -> 75,439 (+1,085): functional_context
  // on 5 tools +697 inputSchema · coverage keys (partial_build on 17 schemas +
  // the field/provenance/ISV keys) +858 outputSchema · routing prose out of 8
  // descriptions −470. Ceiling 76,900.
  // #123–#128 (2026-09-03): six authoring-loop read tools (find_method_implementations,
  // lookup_object, lookup_form, find_forms, preflight, knowledge) — measured after
  // the change, ceiling re-set at ≤2% above it.
  kb: { maxBytes: 93_700, tools: 32 },   // 91,916 measured 2026-09-03
  // xref 37,300 -> 38,600 (#83 objects[]); W1: 38,702 measured -> 35,047, ceiling 35,700.
  // Q2–Q5: 35,047 -> 36,800 (+1,753): xref_check_exists +1,599 (18 tools) ·
  // functional_context ×2 +280 · coverage keys +177 · description trims −304. Ceiling 37,500.
  xref: { maxBytes: 37_500, tools: 18 },
  // sec 37,500 -> 38,700 (W3 #107.1 summary views) -> 39,800 (#107.6 limits) ->
  // 42,600 (#83 sec_lookup_role role_names[]: +2,363 B, mostly the payload keys
  // repeated as optional beside roles[] — the price of a disjoint single/batch
  // contract inside ONE object schema; W1 could not remove it without $ref).
  // W1: 42,881 measured -> 38,234, ceiling 39,000.
  // Q2–Q5: 38,278 -> 40,430 (+2,152): sec_check_exists +1,847 (19 tools) ·
  // functional_context ×2 +320 · description trim −16. Ceiling 41,200.
  sec: { maxBytes: 41_200, tools: 19 },
  // W1: 13,287 measured -> 8,131 (descriptions 1,755+755 chars and 2.7 KB of
  // output prose on taskrecorder_to_document), ceiling 8,290.
  taskrecorder: { maxBytes: 8_290, tools: 2 },
};
// 160,800 B measured after Q2–Q5 (was 155,810): +4,990 = two preflight tools
// +3,446 · functional_context ×9 +1,297 · coverage keys +1,035 · trims −790.
const TOTAL_MAX_BYTES = 180_800; // 2026-09-03: 177,349 measured after #123–#128 (six KB tools)

// Entry points that must register through tool-sets.js — and nothing else.
const ENTRY_POINTS = {
  kb: { files: ['local/mcp-server-kb.js', 'functions/d365kb.js'], via: 'registerAllKbTools' },
  xref: { files: ['local/mcp-server-xref.js', 'functions/d365xref.js'], via: 'registerAllXrefTools' },
  sec: { files: ['local/mcp-server-sec.js', 'functions/d365sec.js'], via: 'registerAllSecTools' },
  taskrecorder: { files: ['local/mcp-server-taskrecorder.js', 'functions/d365taskrecorder.js'], via: 'registerAllTaskRecorderTools' },
};

// `title` (W5.B, #109): derived on the registration path for every tool that
// does not set one. A deliberate cost — a few bytes per tool — so it is
// measured as its own column rather than hidden in `other`.
const FIELDS = ['name', 'title', 'description', 'inputSchema', 'outputSchema', 'annotations'];

/**
 * Bytes a service contributes to `tools/list` — ALL of what the protocol ships,
 * captured from the transport as the server emitted it.
 */
async function measureService(svc) {
  const db = emptyDb();
  const server = new McpServer(serverInfo(svc), serverOptions(svc));
  registerServiceTools(svc, server, db);

  const client = new Client({ name: 'budget-test', version: '0.0.0' }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  // Capture the raw result message BEFORE the client's Zod schema sees it, so
  // a key the client strips (or adds) cannot skew the count.
  let rawTools = null;
  const forward = clientTransport.onmessage;
  clientTransport.onmessage = (message, extra) => {
    if (message?.result?.tools) rawTools = message.result.tools;
    forward?.(message, extra);
  };
  await client.listTools();
  try { await client.close(); } catch { /* noop */ }
  try { await server.close(); } catch { /* noop */ }
  db.close();

  assert.ok(Array.isArray(rawTools), `${svc}: no tools/list result captured on the transport`);

  const perField = Object.fromEntries([...FIELDS, 'other'].map(f => [f, 0]));
  const otherKeys = new Set();
  const tools = rawTools.map((t) => {
    const fields = {};
    for (const [k, v] of Object.entries(t)) {
      if (v === undefined) continue;
      // `"key":` + value + separating comma
      const b = k.length + 3 + JSON.stringify(v).length;
      if (FIELDS.includes(k)) { perField[k] += b; fields[k] = b; } else { perField.other += b; otherKeys.add(k); }
    }
    return { name: t.name, bytes: JSON.stringify(t).length, fields };
  });
  return { tools, bytes: JSON.stringify(rawTools).length, perField, otherKeys: [...otherKeys], raw: rawTools };
}

function walk(node, fn) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach(n => walk(n, fn)); return; }
  fn(node);
  for (const v of Object.values(node)) walk(v, fn);
}

test('tool-schema budget: tools/list stays within its per-server ceiling (all four servers, as registered)', async () => {
  const report = [];
  const grand = Object.fromEntries([...FIELDS, 'other'].map(f => [f, 0]));
  let total = 0;
  let toolTotal = 0;
  let schemaKeys = 0, schemaCount = 0, refs = 0, defs = 0, defIds = 0;

  for (const [svc, { maxBytes, tools: expectedTools }] of Object.entries(BUDGET)) {
    const m = await measureService(svc);
    total += m.bytes;
    toolTotal += m.tools.length;
    for (const f of Object.keys(grand)) grand[f] += m.perField[f];
    for (const t of m.raw) {
      for (const s of [t.inputSchema, t.outputSchema]) {
        if (!s) continue;
        schemaCount++;
        if ('$schema' in s) schemaKeys++;
        walk(s, n => { if ('$ref' in n) refs++; if ('$defs' in n || 'definitions' in n) defs++; });
        for (const d of Object.values(s.definitions ?? {})) if (d && typeof d === 'object' && 'id' in d) defIds++;
      }
    }

    const worst = [...m.tools].sort((a, b) => b.bytes - a.bytes).slice(0, 3);
    const share = (f) => `${f} ${m.perField[f]} (${(100 * m.perField[f] / m.bytes).toFixed(1)}%)`;
    report.push(
      `  ${svc.padEnd(12)} ${String(m.tools.length).padStart(2)} tools  ${String(m.bytes).padStart(7)} B `
      + `(~${String(Math.round(m.bytes / 4)).padStart(5)} tk)  ceiling ${maxBytes} B`
      + `\n${' '.repeat(15)}${FIELDS.map(share).join(' · ')} · other[${m.otherKeys.join(',')}] ${m.perField.other}`
      + `\n${' '.repeat(15)}largest: ${worst.map(t => `${t.name} ${t.bytes}B`).join(' · ')}`,
    );

    assert.equal(m.tools.length, expectedTools,
      `${svc}: registers ${m.tools.length} tools, expected ${expectedTools}. A tool set was added, removed or `
      + 'filtered — update BUDGET.tools deliberately once the budget line below has been read.');
    const untitled = m.raw.filter(t => !t.title).map(t => t.name);
    assert.deepEqual(untitled, [], `${svc}: every tool carries a title (W5.B); missing on ${untitled.join(', ')}`);
    assert.ok(m.bytes <= maxBytes,
      `${svc}: tools/list is ${m.bytes} B, over the ${maxBytes} B ceiling by ${m.bytes - maxBytes} B `
      + `(~${Math.round((m.bytes - maxBytes) / 4)} tk on EVERY request). Shorten a description, narrow a schema, `
      + 'or raise the ceiling deliberately — but do it knowing the cost.');
  }

  const pct = (b) => `${(100 * b / total).toFixed(1)}%`;
  console.log(`\ntools/list wire budget (captured off the transport, all tool sets each server registers):\n${report.join('\n')}`);
  console.log(`  TOTAL        ${toolTotal} tools  ${total} B (~${Math.round(total / 4)} tk) per request`
    + `  ≈ $${(Math.round(total / 4) * 0.5e-6 * 40).toFixed(3)} over a 40-turn session`);
  console.log(`  composition: ${[...FIELDS, 'other'].map(f => `${f} ${grand[f]} B ${pct(grand[f])}`).join(' · ')}`);
  console.log(`  wire facts:  $schema on ${schemaKeys}/${schemaCount} schemas · $ref ${refs} · $defs/definitions ${defs} · definition ids ${defIds}\n`);

  // W1 (#105) wire trim — `trimToolsListWire` in tool-sets.js. `$schema` is
  // ~6.6 KB of pure overhead per request; if the SDK moves `_requestHandlers`
  // the hook is a no-op and THIS is what notices, not a bill.
  assert.equal(schemaKeys, 0, `"$schema" reached the wire on ${schemaKeys} schemas — trimToolsListWire did not attach`);
  assert.equal(defIds, 0, `${defIds} definitions carry Zod's "id" — AJV (the SDK client) rejects that keyword`);

  assert.ok(total <= TOTAL_MAX_BYTES,
    `combined tools/list is ${total} B, over the ${TOTAL_MAX_BYTES} B ceiling`);
});

test('tool-schema budget: every outputSchema compiles in the SDK client\'s AJV — hooked AND unhooked registration paths', async () => {
  // What a real client does with the list: compile each outputSchema with AJV
  // (strict: false, as the SDK ships it) before validating structuredContent.
  // Compiling is where a Zod `.meta({ id })` blows up (`NOT SUPPORTED: keyword
  // "id"`): W1 measured −3.2 KB from `$ref`-sharing row shapes that way and
  // reverted it, because the entry-point hook that strips the `id` does not
  // cover a McpServer that calls `registerKbTools()` directly (the integration
  // harness does). So this compiles BOTH paths: the servers as shipped, and each
  // register function on a bare McpServer with no policy. A future `.meta({ id })`
  // fails here, not in a client.
  const validator = new AjvJsonSchemaValidator();
  const compiled = new Map();
  const compileAll = (tools, label) => {
    for (const t of tools) {
      if (!t.outputSchema) continue;
      let v;
      assert.doesNotThrow(() => { v = validator.getValidator(t.outputSchema); },
        `${t.name} (${label}): the SDK client cannot compile this outputSchema`);
      compiled.set(t.name, v);
    }
  };

  for (const svc of Object.keys(BUDGET)) {
    compileAll((await measureService(svc)).raw, `${svc}, via tool-sets`);

    // Unhooked: the raw register functions straight onto a McpServer, as a
    // library user or the integration harness would.
    const db = emptyDb();
    const server = new McpServer(serverInfo(svc), serverOptions(svc));
    for (const register of TOOL_SETS[svc]) register(server, db);
    const client = new Client({ name: 'budget-test-unhooked', version: '0.0.0' }, { capabilities: {} });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    const { tools } = await client.listTools();
    try { await client.close(); } catch { /* noop */ }
    try { await server.close(); } catch { /* noop */ }
    db.close();
    compileAll(tools, `${svc}, direct registration`);
  }

  // And the compiled validators still separate a valid payload from an invalid
  // one on the two single/batch tools with the widest envelopes.
  const enumV = compiled.get('d365_get_enum');
  assert.ok(enumV, 'd365_get_enum has an outputSchema');
  assert.equal(enumV({ enum_name: 'SalesStatus', module_id: null, label: null, value_count: 1,
    values: [{ name: 'None', value: 0, label: null }] }).valid, true, 'a single-target enum payload validates');
  assert.equal(enumV({ requested_count: 1, resolved_count: 1, not_found: [],
    enums: [{ enum_name: 'X', module_id: null, label: 'L', value_count: 1, values: [{ name: 'A', value: 1, label: 'a' }] }] }).valid, true,
  'a batch enum payload validates');
  const bad = enumV({ enum_name: 'X', value_count: 1, values: [{ name: 7, value: 'not-a-number' }] });
  assert.equal(bad.valid, false, 'a row violating the value shape is rejected');
  assert.match(bad.errorMessage ?? '', /values\/0/, 'the error points into the row');

  const roleV = compiled.get('sec_lookup_role');
  assert.equal(roleV({ requested_count: 1, resolved_count: 0, not_found: ['x'], roles: [] }).valid, true);
  assert.equal(roleV({ roles: [{ role_id: 'r' }] }).valid, false, 'an incomplete role row inside roles[] is rejected');
});

test('tool-schema budget: the `core` profile figure, per server, selected per request (W2, #106)', async () => {
  // `?profile=core` / `X-MCP-Tool-Profile: core` / `MCP_TOOL_PROFILE=core`
  // resolve into the request context; registration reads it there. Measured the
  // same way as the full list — a real McpServer, the real tools/list message —
  // inside a request context, so this is what a connector URL carrying
  // `?profile=core` receives. Printed for tuning, asserted for shape.
  const report = [];
  let fullTotal = 0, coreTotal = 0, coreTools = 0;
  for (const svc of Object.keys(BUDGET)) {
    const full = await measureService(svc);
    const core = await runWithRequestContext({ profile: 'core', textChannel: 'full' }, () => measureService(svc));
    fullTotal += full.bytes; coreTotal += core.bytes; coreTools += core.tools.length;

    const names = core.tools.map(t => t.name);
    const members = full.tools.map(t => t.name).filter(n => CORE_TOOLS.has(n));
    let note = '';
    if (members.length === 0) {
      // A profile that would empty a server falls back to `full` — the SDK
      // installs no tools/list handler for a server with zero tools and the
      // client gets -32601. Task Recorder is that server today.
      assert.deepEqual(names, full.tools.map(t => t.name),
        `${svc}: no CORE_TOOLS member — core must fall back to the full list, never to an empty server`);
      note = '  (no CORE_TOOLS member → full)';
    } else {
      assert.deepEqual(names, members,
        `${svc}: core must register exactly the CORE_TOOLS members of the full list, in the same order`);
    }
    assert.ok(core.bytes <= full.bytes, `${svc}: core (${core.bytes} B) cannot exceed full (${full.bytes} B)`);

    report.push(`  ${svc.padEnd(12)} full ${String(full.tools.length).padStart(2)} tools ${String(full.bytes).padStart(7)} B`
      + `  →  core ${String(core.tools.length).padStart(2)} tools ${String(core.bytes).padStart(7)} B`
      + `  (${full.bytes ? (100 * (core.bytes - full.bytes) / full.bytes).toFixed(1) : '0.0'}%)${note}`);
  }
  console.log(`\ntools/list under MCP_TOOL_PROFILE=core / ?profile=core (per request):\n${report.join('\n')}`);
  console.log(`  TOTAL        full ${fullTotal} B (~${Math.round(fullTotal / 4)} tk)  →  core ${coreTools} tools ${coreTotal} B (~${Math.round(coreTotal / 4)} tk)`
    + `  ${(100 * (coreTotal - fullTotal) / fullTotal).toFixed(1)}%\n`);
  assert.ok(coreTotal < fullTotal, 'the profile must actually shrink the combined list');
});

test('tool-schema budget: every entry point registers through tool-sets.js, so the test measures what the servers ship', () => {
  // The 2026-09-02 lesson: the KB server grew two tool sets (ISV, custom
  // fields) that the budget never saw, and the "live" figure in CLAUDE.md
  // turned out to be the test's own three-service sum. One registration list,
  // imported by both the entry points and this test, closes that gap — but
  // only if nobody bypasses it. Scan the entry points for any direct
  // `register*Tools(` call.
  assert.deepEqual(Object.keys(TOOL_SETS).sort(), Object.keys(ENTRY_POINTS).sort(),
    'TOOL_SETS and ENTRY_POINTS must name the same services');

  for (const [svc, { files, via }] of Object.entries(ENTRY_POINTS)) {
    assert.ok(TOOL_SETS[svc].length >= 1, `${svc}: TOOL_SETS has no register functions`);
    for (const rel of files) {
      const src = readFileSync(join(SRC_ROOT, rel), 'utf-8');
      // Strip comments so a mention in prose is not read as a call.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
      const calls = [...code.matchAll(/\b(register\w*Tools)\s*\(/g)].map(m => m[1]);
      assert.deepEqual(calls, [via],
        `${rel}: expected exactly one registration call, ${via}(…), found [${calls.join(', ')}]. `
        + 'Register new tool sets in src/azure/tool-sets.js — that is what the budget test measures.');
      assert.match(code, /from ['"][^'"]*\/tool-sets\.js['"]/,
        `${rel}: must import ${via} from src/azure/tool-sets.js`);
    }
  }
});

test('tool-schema budget: no parameter description is duplicated at ruinous cost', () => {
  // A description on a SHARED parameter is paid once per tool that takes it.
  // `format` is on ~50 tools: every character of its prose costs 50 characters
  // of tools/list. The long-form explanation belongs in CLAUDE.md and the skill,
  // which are read once — not on the wire.
  // Keyed by param+description but CARRYING both as data. Encoding them into
  // the key and splitting it back out mis-measures any description containing
  // the separator — it under-reported this waste to a single word.
  const seen = new Map();
  for (const svc of Object.keys(TOOL_SETS)) {
    const handle = emptyDb();
    registerServiceTools(svc, {
      registerTool(_name, cfg) {
        let schema = {};
        try { schema = z.toJSONSchema(z.object(cfg.inputSchema ?? {})); } catch { return; }
        for (const [param, def] of Object.entries(schema.properties ?? {})) {
          if (!def || typeof def.description !== 'string') continue;
          const key = `${param} ${def.description}`;
          const prev = seen.get(key);
          if (prev) prev.count += 1;
          else seen.set(key, { param, description: def.description, count: 1 });
        }
      },
    }, handle);
    handle.close();
  }

  const offenders = [];
  for (const { param, description, count } of seen.values()) {
    const waste = (count - 1) * description.length;
    // 4,000 B of duplicated prose for one parameter is ~1,000 tokens on every
    // request. Below that, per-parameter clarity is worth more than the bytes.
    if (waste > 4_000) offenders.push({ param, count, waste, description });
  }
  offenders.sort((a, b) => b.waste - a.waste);

  assert.deepEqual(offenders.map(o => `${o.param} (${o.count}x, ${o.waste} B wasted)`), [],
    'A shared parameter description is duplicated across too many tools. Shorten it — '
    + 'the long form belongs in CLAUDE.md / the skill, where it is paid once, not on '
    + `every request. Offenders: ${offenders.map(o => `${o.param}: "${o.description.slice(0, 60)}…"`).join(' | ')}`);
});

test('tool-schema budget: the preflight check tools stay tiny on the wire (#118)', async () => {
  // These two exist to be CHEAP on tools/list — a preflight that costs as much
  // as the lookups it replaces has no reason to exist. Output schema ≤ 1.2 KB
  // each (the issue's contract); the whole tool entry is asserted too so a
  // description or input-schema creep is caught the same way.
  // Measured 2026-09-02: xref_check_exists 1,599 B (outputSchema 724, inputSchema
  // 576 — the `type` enum), sec_check_exists 1,847 B (outputSchema 779,
  // inputSchema 730 — four name arrays). The issue's ≤2,500 B for the PAIR was
  // not reachable without dropping one of those; the pair is 3,446 B.
  const OUTPUT_MAX = 1_200;
  const TOOL_MAX = 1_900;
  const found = [];
  for (const [svc, name] of [['xref', 'xref_check_exists'], ['sec', 'sec_check_exists']]) {
    const m = await measureService(svc);
    const t = m.tools.find(x => x.name === name);
    assert.ok(t, `${svc}: ${name} is not registered`);
    found.push(t);
  }
  console.log(`\npreflight check tools (#118):\n${found.map(t =>
    `  ${t.name.padEnd(18)} ${String(t.bytes).padStart(5)} B total · outputSchema ${t.fields.outputSchema} B · inputSchema ${t.fields.inputSchema} B · description ${t.fields.description} B`).join('\n')}\n`);
  for (const t of found) {
    assert.ok(t.fields.outputSchema <= OUTPUT_MAX, `${t.name}: outputSchema is ${t.fields.outputSchema} B, over the ${OUTPUT_MAX} B contract`);
    assert.ok(t.bytes <= TOOL_MAX, `${t.name}: ${t.bytes} B on the wire, over the ${TOOL_MAX} B ceiling`);
  }
});
