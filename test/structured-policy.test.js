/**
 * C5 — structured-content policy on the registration path
 * (MCP_Communication_Efficiency_Improvements_2026-09-04 §1.2 / C5).
 *
 * Claude Code stores `structuredContent` and never shows the model the TOON /
 * Markdown text channel (measured 2026-09-04 on 10/10 results). With the
 * request preference `structured: 'off'` the registration policy (a) registers
 * the tool WITHOUT its outputSchema — a client validating structuredContent
 * against a declared schema would otherwise reject the response — and (b)
 * strips `structuredContent` from every result AFTER the freshness banner was
 * attached, so the compact text, banner included, is what arrives.
 * Default 'full' is byte-identical to the previous behaviour.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { z } from 'zod';

import { withRegistrationPolicy } from '../src/azure/tool-sets.js';
import { runWithRequestContext } from '../src/azure/request-context.js';
import { structuredResult, emptyResult, READ_ONLY_DB_ANNOTATIONS } from '../src/azure/shared.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const dbs = [];
after(() => { for (const d of dbs) { try { d.close(); } catch { /* closed */ } } });
function kbDb() {
  const db = new Database(':memory:'); dbs.push(db);
  db.exec("CREATE TABLE kb_metadata (key TEXT PRIMARY KEY, value TEXT)");
  db.prepare("INSERT INTO kb_metadata VALUES ('build_date', '2026-08-14T09:30:00.000Z')").run();
  return db;
}
function fakeServer() {
  const configs = {}, handlers = {};
  return { configs, handlers, registerTool(name, config, handler) { configs[name] = config; handlers[name] = handler; } };
}
const config = () => ({
  description: 'd', annotations: READ_ONLY_DB_ANNOTATIONS,
  inputSchema: { x: z.string().optional() }, outputSchema: { a: z.string() },
});
const handler = async () => structuredResult({ a: '1' }, '## X\n\n| a |\n|---|\n| 1 |');

describe('structured-content policy (C5)', () => {
  it("default 'full': outputSchema registered, structuredContent present, banner present", async () => {
    await runWithRequestContext({ profile: 'full', textChannel: 'full', structured: 'full' }, async () => {
      const s = fakeServer();
      withRegistrationPolicy(s, { service: 'kb', db: kbDb(), profile: 'full' }).registerTool('d365_x', config(), handler);
      assert.ok(s.configs.d365_x.outputSchema, 'outputSchema kept');
      const r = await s.handlers.d365_x({});
      assert.deepEqual(r.structuredContent, { a: '1' });
      assert.match(r.content[0].text, /_KB snapshot: 2026-08-14_/);
    });
  });

  it("'off': no outputSchema on registration, no structuredContent on the wire, banner still there", async () => {
    await runWithRequestContext({ profile: 'full', textChannel: 'full', structured: 'off' }, async () => {
      const s = fakeServer();
      withRegistrationPolicy(s, { service: 'kb', db: kbDb(), profile: 'full' }).registerTool('d365_x', config(), handler);
      assert.equal(s.configs.d365_x.outputSchema, undefined, 'outputSchema omitted');
      assert.ok(s.configs.d365_x.inputSchema, 'inputSchema untouched');
      const r = await s.handlers.d365_x({});
      assert.equal(r.structuredContent, undefined);
      assert.match(r.content[0].text, /^## X\n_KB snapshot: 2026-08-14_/);
      assert.match(r.content[0].text, /\na: 1$/, 'the text body is the compact (adaptive: TOON) channel');
    });
  });

  it("'off' also strips the typed payload of an emptyResult and leaves the meta marker alone", async () => {
    await runWithRequestContext({ profile: 'full', textChannel: 'full', structured: 'off' }, async () => {
      const s = fakeServer();
      const view = withRegistrationPolicy(s, { service: 'kb', db: kbDb(), profile: 'full' });
      view.registerTool('d365_empty', config(), async () => emptyResult('rows for X', { a: '0' }));
      const r = await s.handlers.d365_empty({});
      assert.equal(r.structuredContent, undefined);
      assert.equal(r._meta.kind, 'empty');
      assert.ok(r.content[0].text.startsWith('## '));
    });
  });
});
