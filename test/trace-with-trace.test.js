/**
 * Stream 1 on the server (ERP-Trace-Capture-TDD WI-07): `withTrace` wraps a
 * handler, returns its result UNCHANGED, and enqueues one sanitized call record
 * built from the arguments and five result keys.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { withTrace, TraceWriter, memorySink, resultSummary, currentInvestigation, validateRecord } from '../src/trace/index.js';

const config = { inputSchema: { table_name: z.string(), field_limit: z.number().optional(), sql: z.string().optional(), user_id: z.string().optional() } };
const env = (extra = {}) => ({ MCP_TRACE: 'on', TRACE_SESSION_SALT: 'test', ...extra });

let sink, writer;
beforeEach(() => { sink = memorySink(); writer = new TraceWriter(sink, { intervalMs: 50 }); });
afterEach(() => writer.close());

describe('withTrace', () => {
  it('MCP_TRACE off → the very same handler function; on → a wrapper', () => {
    const h = async () => ({ content: [] });
    assert.equal(withTrace('t', h, config, { service: 'kb', env: { MCP_TRACE: 'off' } }), h);
    assert.notEqual(withTrace('t', h, config, { service: 'kb', env: env() }), h);
  });

  it('returns the identical result object and records tool, policy-filtered args, result facts and touched names', async () => {
    const result = { content: [{ type: 'text', text: '## x' }], structuredContent: { table_name: 'VendTable', has_more: true, field_count: 10, field_limit_hit: true } };
    const h = withTrace('d365_lookup_table', async () => result, config, { service: 'kb', writer, env: env() });
    const got = await h({ table_name: 'VendTable', field_limit: 10, sql: "SELECT 1 FROM x WHERE a = 'b'", user_id: 'someone', unknown: { nested: 1 } }, {});
    assert.equal(got, result);
    await writer.flush();
    assert.equal(sink.records.length, 1);
    const r = sink.records[0];
    assert.deepEqual(validateRecord(r), { ok: true });
    assert.equal(r.stream, 'mcp');
    assert.equal(r.source, 'server');
    assert.equal(r.mcp.service, 'kb');
    assert.equal(r.tool.name, 'd365_lookup_table');
    assert.deepEqual(r.tool.args, { table_name: 'VendTable', field_limit: 10, sql: 'SELECT ? FROM x WHERE a = ?', user_id: '<redacted>' });
    assert.equal(r.result.kind, 'data');
    assert.equal(r.result.has_more, true);
    assert.equal(r.result.rows, 10);
    assert.ok(r.result.bytes > 0);
    assert.ok(Number.isInteger(r.result.duration_ms));
    assert.deepEqual([...r.result.coverage].sort(), ['args_partial', 'field_limit_hit']);
    assert.deepEqual(r.touched, [{ kind: 'table', name: 'VendTable' }]);
    assert.equal(r.investigation_id, undefined);
    assert.ok(!JSON.stringify(r).includes('## x'), 'response text never enters the record');
  });

  it('meta-responses keep their kind; a throwing handler rethrows and records an error', async () => {
    const nf = withTrace('t', async () => ({ isError: true, _meta: { kind: 'not-found' }, content: [] }), config, { service: 'kb', writer, env: env() });
    await nf({ table_name: 'Nope' }, {});
    const boom = withTrace('t', async () => { throw new Error('db gone'); }, config, { service: 'kb', writer, env: env() });
    await assert.rejects(() => boom({ table_name: 'X' }, {}), /db gone/);
    await writer.flush();
    assert.deepEqual(sink.records.map((r) => r.result.kind), ['not-found', 'error']);
  });

  it('stamps the investigation id the hook announced in ~/.claude/mcp-trace/current, only while fresh', async () => {
    const home = mkdtempSync(join(tmpdir(), 'trace-home-'));
    try {
      mkdirSync(join(home, '.claude', 'mcp-trace'), { recursive: true });
      const cur = join(home, '.claude', 'mcp-trace', 'current');
      writeFileSync(cur, JSON.stringify({ investigation_id: 'inv-abc', ts: new Date().toISOString() }));
      const e = env({ TRACE_HOME: home });
      assert.equal(currentInvestigation(e), 'inv-abc');
      const h = withTrace('t', async () => ({ content: [], structuredContent: {} }), config, { service: 'xref', writer, env: e });
      await h({ table_name: 'X' }, {});
      await writer.flush();
      assert.equal(sink.records[0].investigation_id, 'inv-abc');
      writeFileSync(cur, JSON.stringify({ investigation_id: 'inv-old', ts: new Date(Date.now() - 9 * 3600 * 1000).toISOString() }));
      assert.equal(currentInvestigation(e), null);
      writeFileSync(cur, 'garbage');
      assert.equal(currentInvestigation(e), null);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('resultSummary reads five keys only', () => {
    const sc = { result_count: 3, has_more: false, isv_excluded: 2, rows: [{ secret: 1 }] };
    assert.deepEqual(resultSummary({ structuredContent: sc }), { kind: 'data', bytes: JSON.stringify(sc).length, has_more: false, rows: 3, coverage: ['isv_excluded'] });
    assert.deepEqual(resultSummary({ isError: true, content: [{ type: 'text', text: 'boom' }] }), { kind: 'error', bytes: 4 });
    assert.deepEqual(resultSummary({ _meta: { kind: 'empty' }, content: [] }), { kind: 'empty', bytes: 0 });
  });

  it('TraceWriter: rejects unsanitized records, bounded ring, retries once on retryable failure', async () => {
    assert.throws(() => writer.enqueue({ id: 'x' }), /not sanitized/);
    let calls = 0;
    const flaky = async () => { calls += 1; if (calls === 1) { const e = new Error('503'); e.retryable = true; throw e; } };
    const w = new TraceWriter(flaky, { ring: 2, intervalMs: 50 });
    const h = withTrace('t', async () => ({ content: [] }), config, { service: 'kb', writer: w, env: env() });
    await h({ table_name: 'A' }, {});
    await w.flush();
    assert.equal(calls, 2);
    assert.equal(w.stats.retried, 1);
    assert.equal(w.stats.sent, 1);
    await w.close();
  });
});
