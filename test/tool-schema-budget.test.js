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
 * Per-server ceilings, ≤2% above the 2026-09-02 measurement (kb 69,113 ·
 * xref 36,596 · sec 36,837 · taskrecorder 13,243 B; total 155,789 B ≈ 38,947 tk)
 * PLUS exactly the measured cost of `title` on every tool (W5.B, #109):
 * kb +529 · xref +443 · sec +439 · taskrecorder +44 = **+1,455 B** (~364 tk),
 * measured 2026-09-02 → kb 69,642 · xref 37,039 · sec 37,276 · taskrecorder
 * 13,287; total 157,244 B ≈ 39,311 tk. A deliberate cost: a display name on
 * every tool for ~0.9% of the list.
 * `tools` is the count the server registers today — a drop means a set was
 * removed or filtered, which is as much a "come and look" event as a breach.
 */
const BUDGET = {
  // Every ceiling below also carries the measured `title` delta (W5.B): kb +529 ·
  // xref +443 · sec +439 · taskrecorder +44 — see the docblock above.
  // kb raised 70,400 -> 71,000 on 2026-09-02 (#83): d365_search `queries[]` (+84 B measured).
  // kb raised 71,000 -> 76,400 and 21 -> 22 tools on 2026-09-02 (#85): d365_effective_schema
  // (+5,679 B measured — a rich typed payload: attributed fields, indexes, relations, ISV inventory).
  // kb 76,400 -> 77,100, sec 42,600 -> 43,000 on 2026-09-02 (#109): `cursor` input +
  // has_more/next_cursor on the 8 paginated tools (+319 B kb, +130 B sec; xref fits).
  // kb 77,700 -> 91,100 and 22 -> 26 tools on 2026-09-02 (W7 #111): the four
  // semantic-layer tools (d365_map_entity, d365_map_dq_rule, d365_entity_map,
  // d365_dq_rules) measured +11,656 B — the 9 DQ dimension spec schemas are the
  // bulk. W1 (#105) trims from here.
  kb: { maxBytes: 91_100, tools: 26 },
  // xref raised 37,300 -> 38,600 on 2026-09-02 (#83): xref_find_references `objects[]` (+864 B).
  xref: { maxBytes: 39_700, tools: 17 },
  // sec raised 37,500 -> 38,700 on 2026-09-02 (W3 #107.1): sec_lookup_role /
  // sec_role_hierarchy / sec_compare_roles gained the summary-view inputs and
  // the exact-count keys that make a capped list honest (+824 B measured).
  // sec raised 38,700 -> 39,800 on 2026-09-02 (W3 #107.6): `limit` + exact-count
  // keys on sec_lookup_duty/privilege/user and sec_find_roles_by_* (+1,015 B).
  // sec raised 39,800 -> 42,600 on 2026-09-02 (#83): sec_lookup_role `role_names[]`. +2,363 B,
  // mostly the top-level payload keys repeated as optional beside `roles[]` — the
  // price of the disjoint single/batch contract on a wide payload.
  sec: { maxBytes: 44_000, tools: 18 },
  taskrecorder: { maxBytes: 13_544, tools: 2 },
};
const TOTAL_MAX_BYTES = 188_400;

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
  let schemaKeys = 0, schemaCount = 0, refs = 0, defs = 0;

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
  console.log(`  wire facts:  $schema on ${schemaKeys}/${schemaCount} schemas · $ref ${refs} · $defs/definitions ${defs}\n`);

  assert.ok(total <= TOTAL_MAX_BYTES,
    `combined tools/list is ${total} B, over the ${TOTAL_MAX_BYTES} B ceiling`);
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
