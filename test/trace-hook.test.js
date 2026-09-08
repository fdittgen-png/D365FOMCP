/**
 * Hook capture for Claude Code (ERP-Trace-Capture-TDD WI-15) — the plugin hook
 * `trace-capture.mjs` run as a child process against a fixture transcript whose
 * shape is the vendor investigation of 2026-09-04 (content synthetic, the prompt
 * deliberately carries an e-mail and a 9-digit number).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { validateRecord } from '../src/trace/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = join(ROOT, 'plugin', 'd365fo-mcp', 'hooks', 'trace-capture.mjs');

const PROMPT = 'find me how the logical structure of the vendor entity looks; ping someone@example.com, order 123456789';
const SESSION = 'sess-0001';
const PROMPT_ID = 'p-1111-2222';
let home, transcript, ndjson, logFile;

function ts(offsetS) { return new Date(Date.UTC(2026, 8, 4, 12, 27, 30 + offsetS)).toISOString(); }
function rec(obj) { appendFileSync(transcript, JSON.stringify(obj) + '\n'); }
function userPrompt(text, t) { rec({ type: 'user', isSidechain: false, uuid: `u-${t}`, timestamp: ts(t), message: { role: 'user', content: text } }); }
function assistant(blocks, t) { rec({ type: 'assistant', isSidechain: false, uuid: `a-${t}`, timestamp: ts(t), message: { role: 'assistant', model: 'claude-fable-5-1', content: blocks } }); }
function toolResult(id, t) { rec({ type: 'user', isSidechain: false, uuid: `r-${t}`, timestamp: ts(t), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'x' }] } }); }

function run(event, payload) {
  const r = spawnSync(process.execPath, [HOOK, event], {
    input: JSON.stringify({ hook_event_name: event, session_id: SESSION, prompt_id: PROMPT_ID, transcript_path: transcript, cwd: home, permission_mode: 'default', ...payload }),
    env: { ...process.env, CLAUDE_TRACE_HOME: home },
    encoding: 'utf8',
    timeout: 20000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function records() {
  return existsSync(ndjson) ? readFileSync(ndjson, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
}

before(() => {
  home = mkdtempSync(join(tmpdir(), 'trace-hook-'));
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', 'claude-trace.config.json'), JSON.stringify({ enabled: true, transport: 'file', erp: { system: 'D365FO', installation_id: 'test-box', version: 'v10.0.2645.90' } }));
  transcript = join(home, 'transcript.jsonl');
  writeFileSync(transcript, '');
  ndjson = join(home, '.claude', 'mcp-trace', 'hook.ndjson');
  logFile = join(home, '.claude', 'claude-trace.log');
});
after(() => rmSync(home, { recursive: true, force: true }));

describe('trace-capture hook — the vendor investigation', () => {
  it('UserPromptSubmit: prints the protocol instruction, records nothing, ignores task notifications', () => {
    const r = run('UserPromptSubmit', { prompt: PROMPT });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^Trace protocol/);
    assert.match(r.stdout, /Request: </);
    assert.equal(records().length, 0);
    const noise = run('UserPromptSubmit', { prompt: '<task-notification>\n<task-id>x</task-id>' });
    assert.equal(noise.stdout, '');
    assert.equal(noise.status, 0);
  });

  it('first PreToolUse opens from the declared Request/Entities lines and stashes the call; a Skill call is ignored', () => {
    userPrompt(PROMPT, 0);
    assistant([{ type: 'text', text: 'Request: Explain the logical structure of the vendor entity and its backing table.\nEntities: vendor, postal address\n\nI will query the KB for the vendor data entity sources first, then the backing table.' }, { type: 'tool_use', id: 'tu1', name: 'mcp__d365kb__d365_get_entity_sources', input: { entity_name: 'VendVendorV2Entity', limit: 60, functional_context: 'vendor' } }], 5);
    const skill = run('PreToolUse', { tool_name: 'Skill', tool_use_id: 'tu0', tool_input: { skill: 'x' } });
    assert.equal(skill.status, 0);
    assert.equal(skill.stdout, '');
    assert.equal(records().length, 0);

    const r = run('PreToolUse', { tool_name: 'mcp__d365kb__d365_get_entity_sources', tool_use_id: 'tu1', tool_input: { entity_name: 'VendVendorV2Entity', limit: 60, functional_context: 'vendor' } });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '', 'PreToolUse never writes to stdout');
    const recs = records();
    assert.equal(recs.length, 1, JSON.stringify(recs));
    const open = recs[0];
    assert.equal(open.stream, 'claude');
    assert.equal(open.phase, 'open');
    assert.equal(open.source, 'hook');
    assert.equal(open.erp.system, 'D365FO');
    assert.equal(open.erp.installation_id, 'test-box');
    assert.equal(open.mcp.service, 'kb');
    assert.equal(open.investigation_id, `inv-${PROMPT_ID}`);
    assert.equal(open.request.interpreted, 'Explain the logical structure of the vendor entity and its backing table.');
    assert.equal(open.request.key, 'req.explain_the_logical_structure_of_the_vendor_entity_and_its');
    assert.equal(open.request.source, 'declared');
    assert.match(open.request.approach, /^I will query the KB/);
    assert.deepEqual(open.expected_entities, ['vendor', 'address']);
    assert.equal(open.entities_from, 'declared');
    assert.deepEqual(validateRecord(open), { ok: true });
    const current = JSON.parse(readFileSync(join(home, '.claude', 'mcp-trace', 'current'), 'utf8'));
    assert.equal(current.investigation_id, open.investigation_id);
  });

  it('PostToolUse emits the call record: replayable args, result facts, touched names — never the response', () => {
    toolResult('tu1', 6);
    const response = JSON.stringify({ entity_name: 'VendVendorV2Entity', result_count: 5, has_more: false, sources: [{ table: 'VendTable', secret_value: 'never-traced' }] });
    const r = run('PostToolUse', { tool_name: 'mcp__d365kb__d365_get_entity_sources', tool_use_id: 'tu1', tool_input: { entity_name: 'VendVendorV2Entity', limit: 60, functional_context: 'vendor' }, tool_response: response });
    assert.equal(r.status, 0);
    const recs = records();
    assert.equal(recs.length, 2);
    const call = recs[1];
    assert.equal(call.stream, 'mcp');
    assert.equal(call.tool.name, 'd365_get_entity_sources');
    assert.deepEqual(call.tool.args, { entity_name: 'VendVendorV2Entity', limit: 60, functional_context: 'vendor' });
    assert.equal(call.result.kind, 'data');
    assert.equal(call.result.rows, 5);
    assert.equal(call.result.has_more, false);
    assert.equal(call.result.bytes, response.length);
    assert.ok(Number.isInteger(call.result.duration_ms));
    assert.equal(call.launch_seq, 1);
    assert.deepEqual(call.touched, [{ kind: 'data_entity', name: 'VendVendorV2Entity' }]);
    assert.equal(call.functional_context, 'vendor');
    assert.equal(call.investigation_id, `inv-${PROMPT_ID}`);
    assert.deepEqual(validateRecord(call), { ok: true });
    assert.ok(!readFileSync(ndjson, 'utf8').includes('never-traced'));
    const again = run('PostToolUse', { tool_name: 'mcp__d365kb__d365_get_entity_sources', tool_use_id: 'tu1', tool_input: {}, tool_response: response });
    assert.equal(again.status, 0);
    assert.equal(records().length, 2, 'a second registration of the same hook emits nothing');
  });

  it('a new strategy line becomes one step even when two calls launch in parallel; SQL literals are masked; order is launch order', () => {
    assistant([{ type: 'text', text: 'Now the backing table with its indexes, and the sibling entities over VendTable.' }, { type: 'tool_use', id: 'tu2', name: 'mcp__d365kb__d365_lookup_table', input: { table_name: 'VendTable', sections: ['indexes', 'relations_out'], include_provenance: true, functional_context: 'vendor' } }, { type: 'tool_use', id: 'tu3', name: 'mcp__d365kb__d365_raw_sql', input: { sql: "SELECT entity_name FROM data_entities WHERE primary_table = 'VendTable' LIMIT 20" } }], 20);
    run('PreToolUse', { tool_name: 'mcp__d365kb__d365_lookup_table', tool_use_id: 'tu2', tool_input: { table_name: 'VendTable', sections: ['indexes', 'relations_out'], include_provenance: true, functional_context: 'vendor' } });
    run('PreToolUse', { tool_name: 'mcp__d365kb__d365_raw_sql', tool_use_id: 'tu3', tool_input: { sql: "SELECT entity_name FROM data_entities WHERE primary_table = 'VendTable' LIMIT 20" } });
    let recs = records();
    assert.equal(recs.length, 3);
    assert.equal(recs[2].phase, 'step');
    assert.equal(recs[2].n, 1);
    assert.equal(recs[2].intent, 'Now the backing table with its indexes, and the sibling entities over VendTable.');
    // tu3 finishes before tu2
    run('PostToolUse', { tool_name: 'mcp__d365kb__d365_raw_sql', tool_use_id: 'tu3', tool_input: {}, tool_response: '## KB raw SQL\n_KB snapshot: 2026-08-14_\n| entity_name |\n|---|\n| VendVendorV2Entity |' });
    run('PostToolUse', { tool_name: 'mcp__d365kb__d365_lookup_table', tool_use_id: 'tu2', tool_input: {}, tool_response: '## Table VendTable\n_KB snapshot: 2026-08-14_\n_Field limit hit_\n...' });
    recs = records();
    assert.equal(recs.length, 5);
    const sql = recs[3];
    assert.equal(sql.tool.name, 'd365_raw_sql');
    assert.equal(sql.tool.args.sql, 'SELECT entity_name FROM data_entities WHERE primary_table = ? LIMIT ?');
    assert.equal(sql.launch_seq, 3);
    const lookup = recs[4];
    assert.equal(lookup.launch_seq, 2);
    assert.deepEqual(lookup.tool.args, { table_name: 'VendTable', sections: ['indexes', 'relations_out'], include_provenance: true, functional_context: 'vendor' });
    assert.deepEqual(lookup.touched, [{ kind: 'table', name: 'VendTable' }]);
    assert.ok(lookup.ts < sql.ts, 'ts is the launch time');
  });

  it('a strategy line with party data is dropped and counted, the dossier stays intact', () => {
    assistant([{ type: 'text', text: 'Checking the contact at someone@example.com before the next call.' }, { type: 'tool_use', id: 'tu4', name: 'mcp__d365xref__xref_find_references', input: { object_name: 'VendTable', limit: 5 } }], 30);
    run('PreToolUse', { tool_name: 'mcp__d365xref__xref_find_references', tool_use_id: 'tu4', tool_input: { object_name: 'VendTable', limit: 5 } });
    assert.equal(records().length, 5, 'the tainted step is not written');
    assert.match(readFileSync(logFile, 'utf8'), /dropped claude\/step: contains an e-mail address \(intent\)/);
    run('PostToolUseFailure', { tool_name: 'mcp__d365xref__xref_find_references', tool_use_id: 'tu4', tool_input: { object_name: 'VendTable', limit: 5 }, tool_response: 'connection refused' });
    const last = records().at(-1);
    assert.equal(last.result.kind, 'error');
    assert.equal(last.mcp.service, 'xref');
    assert.equal(last.launch_seq, 4);
  });

  it('Stop closes with the final answer (digit runs masked), counts the calls, clears current; a second Stop is a no-op', () => {
    const answer = 'The vendor is VendTable behind VendVendorV2Entity, joined to DirPartyTable via Party (RecId 5637144576).';
    assistant([{ type: 'text', text: answer }], 40);
    const r = run('Stop', { stop_hook_active: false, last_assistant_message: answer });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    const recs = records();
    const close = recs.at(-1);
    assert.equal(close.phase, 'close');
    assert.equal(close.conclusion.summary, answer.replace('5637144576', '#'));
    assert.equal(close.conclusion.outcome, 'answered');
    assert.equal(close.calls, 4);
    assert.deepEqual(validateRecord(close), { ok: true });
    assert.ok(!existsSync(join(home, '.claude', 'mcp-trace', 'current')));
    run('Stop', { stop_hook_active: false, last_assistant_message: answer });
    assert.equal(records().length, recs.length);
  });

  it('KO: the user prompt text never appears in any record; every record validates and shares the investigation', () => {
    const text = readFileSync(ndjson, 'utf8');
    assert.ok(!text.includes('example.com'));
    assert.ok(!text.includes('123456789'));
    assert.ok(!text.includes('find me how'));
    const recs = records();
    assert.ok(recs.length >= 7);
    for (const r of recs) {
      assert.deepEqual(validateRecord(r), { ok: true }, r.id);
      assert.equal(r.investigation_id, `inv-${PROMPT_ID}`);
      assert.equal(r.source, 'hook');
    }
    assert.deepEqual([...new Set(recs.map((r) => r.seq))].length, recs.length, 'seq is unique per record');
  });
});

describe('trace-capture hook — edge cases', () => {
  it('Stop with no open investigation writes nothing; missing transcript exits 0', () => {
    const before = records().length;
    const r = spawnSync(process.execPath, [HOOK, 'Stop'], { input: JSON.stringify({ hook_event_name: 'Stop', session_id: 'other-session', prompt_id: 'p-x', transcript_path: join(home, 'missing.jsonl'), last_assistant_message: 'hi' }), env: { ...process.env, CLAUDE_TRACE_HOME: home }, encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.equal(records().length, before);
  });

  it('no interpretation line before the first call → falls back to the masked user prompt; a prompt with party data is withheld', () => {
    const t2 = join(home, 't2.jsonl');
    writeFileSync(t2, JSON.stringify({ type: 'user', isSidechain: false, uuid: 'u1', timestamp: ts(0), message: { role: 'user', content: 'Which table holds sales order lines? Order 5637144576 as example.' } }) + '\n');
    const run2 = (event, payload) => spawnSync(process.execPath, [HOOK, event], { input: JSON.stringify({ hook_event_name: event, session_id: 'sess-2', prompt_id: 'p-2', transcript_path: t2, ...payload }), env: { ...process.env, CLAUDE_TRACE_HOME: home }, encoding: 'utf8' });
    run2('PreToolUse', { tool_name: 'mcp__d365kb__d365_lookup_table', tool_use_id: 'x1', tool_input: { table_name: 'SalesLine' } });
    let open = records().filter((r) => r.phase === 'open' && r.investigation_id === 'inv-p-2')[0];
    assert.ok(open);
    assert.equal(open.request.source, 'user_prompt');
    assert.equal(open.request.interpreted, 'Which table holds sales order lines? Order # as example.');
    assert.deepEqual(open.expected_entities, ['sales_order_line']);
    assert.equal(open.entities_from, 'vocabulary_match');

    const t3 = join(home, 't3.jsonl');
    writeFileSync(t3, JSON.stringify({ type: 'user', isSidechain: false, uuid: 'u1', timestamp: ts(0), message: { role: 'user', content: 'Check vendor someone@example.com in VendTable' } }) + '\n');
    spawnSync(process.execPath, [HOOK, 'PreToolUse'], { input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'sess-3', prompt_id: 'p-3', transcript_path: t3, tool_name: 'mcp__d365kb__d365_lookup_table', tool_use_id: 'y1', tool_input: { table_name: 'VendTable', functional_context: 'vendor' } }), env: { ...process.env, CLAUDE_TRACE_HOME: home }, encoding: 'utf8' });
    open = records().filter((r) => r.phase === 'open' && r.investigation_id === 'inv-p-3')[0];
    assert.ok(open);
    assert.match(open.request.interpreted, /^User request withheld/);
    assert.deepEqual(open.expected_entities, ['vendor']);
    assert.equal(open.entities_from, 'functional_context');
    assert.ok(!readFileSync(ndjson, 'utf8').includes('example.com'));
  });

  it('a 207 from the sink is logged as dead letters (id/reason/field), never as an HTTP error', async () => {
    const { spawn } = await import('node:child_process');
    const server = spawn(process.execPath, ['-e', `
      const http = require('node:http');
      const s = http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
        const n = JSON.parse(b).length;
        res.writeHead(207, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ received: n, accepted: n - 1, dead_lettered: [{ id: 'claude_01TESTDEADLETTER0000000000', reason: 'privacy', field: 'request.interpreted' }] }));
      }); });
      s.listen(0, '127.0.0.1', () => process.stdout.write(String(s.address().port) + '\\n'));
    `], { stdio: ['ignore', 'pipe', 'inherit'] });
    const port = await new Promise((resolve) => server.stdout.once('data', (d) => resolve(String(d).trim())));
    const cfgPath = join(home, '.claude', 'claude-trace.config.json');
    const saved = readFileSync(cfgPath, 'utf8');
    try {
      writeFileSync(cfgPath, JSON.stringify({ ...JSON.parse(saved), transport: 'both', url: `http://127.0.0.1:${port}`, key: 'k' }));
      const t = 400;
      userPrompt('trace the item entity', t);
      assistant([{ type: 'text', text: 'Request: item master structure\nEntities: item' }, { type: 'tool_use', id: 'tu207', name: 'mcp__d365kb__d365_lookup_table', input: { table_name: 'InventTable' } }], t + 1);
      const r = run('PreToolUse', { tool_name: 'mcp__d365kb__d365_lookup_table', tool_use_id: 'tu207', tool_input: { table_name: 'InventTable' }, prompt_id: 'p-207', session_id: 'sess-207' });
      assert.equal(r.status, 0);
      const log = readFileSync(logFile, 'utf8');
      assert.match(log, /\/trace\/ingest 207: 1 dead-lettered \(privacy request\.interpreted\)/);
      assert.equal(/HTTP 207/.test(log), false, 'a 207 is not an error line');
    } finally {
      writeFileSync(cfgPath, saved);
      server.kill();
    }
  });

  it('tracing disabled → nothing written, no stdout', () => {
    writeFileSync(join(home, '.claude', 'claude-trace.config.json'), JSON.stringify({ enabled: false }));
    const before = records().length;
    const r = run('UserPromptSubmit', { prompt: 'hello' });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    run('PreToolUse', { tool_name: 'mcp__d365kb__d365_lookup_table', tool_use_id: 'z1', tool_input: { table_name: 'VendTable' } });
    assert.equal(records().length, before);
  });
});
