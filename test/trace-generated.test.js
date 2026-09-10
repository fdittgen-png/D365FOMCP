/**
 * The plugin hook's library is GENERATED from the trace contract, the tool
 * registrations and the vocabulary (`npm run gen:trace-hook`). Drift fails here.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { generate, COPIED, CONTRACT_DIR, HOOK_LIB, ROOT } from '../build/gen-trace-hook.js';
import { parseToolName } from '../src/trace/contract/arg-policies.js';

describe('generated hook library', () => {
  it('contract copies in plugin/d365fo-mcp/hooks/lib are byte-identical to src/trace/contract', () => {
    for (const f of COPIED) {
      assert.ok(existsSync(join(HOOK_LIB, f)), `${f} missing — run npm run gen:trace-hook`);
      assert.equal(readFileSync(join(HOOK_LIB, f), 'utf8'), readFileSync(join(CONTRACT_DIR, f), 'utf8'), `${f} differs — run npm run gen:trace-hook`);
    }
  });
  it('arg-policies.json matches the current tool registrations and covers every D365 tool with a policy per parameter', () => {
    const r = generate({ write: false });
    // compared as LF text: with core.autocrlf=true the checked-out JSON is CRLF while the generator emits LF
    assert.equal(readFileSync(join(HOOK_LIB, 'arg-policies.json'), 'utf8').replace(/\r\n/g, '\n'), r.policiesJson, 'arg-policies.json is stale — run npm run gen:trace-hook');
    assert.ok(r.toolCount >= 60, `only ${r.toolCount} tools`);
    for (const t of ['d365_lookup_table', 'd365_get_entity_sources', 'd365_search', 'd365_raw_sql', 'xref_find_references', 'xref_check_exists', 'sec_lookup_role', 'taskrecorder_to_markdown']) {
      assert.ok(r.policies[t], `${t} has no policy table`);
    }
    assert.equal(r.policies.d365_raw_sql.sql, 'sql_shape');
    assert.equal(r.policies.d365_search.query, 'term');
    assert.equal(r.policies.d365_lookup_table.table_name, 'identifier');
    assert.equal(r.policies.xref_check_exists.objects, 'name_list');
    for (const [tool, table] of Object.entries(r.policies)) {
      for (const [param, policy] of Object.entries(table)) {
        assert.ok(['identifier', 'number', 'boolean', 'identifier[]', 'term', 'sql_shape', 'payload_ref', 'redacted', 'name_list'].includes(policy), `${tool}.${param} = ${policy}`);
        if (/(^|_)(user|users|principal|upn)(_|$)/i.test(param)) assert.equal(policy, 'redacted', `${tool}.${param} must be redacted`);
      }
    }
  });
  it('vocabulary.json is the checked-in vocabulary', () => {
    assert.equal(readFileSync(join(HOOK_LIB, 'vocabulary.json'), 'utf8'), readFileSync(join(ROOT, 'config', 'semantic-vocabulary.json'), 'utf8'), 'vocabulary copy is stale — run npm run gen:trace-hook');
  });
  it('hooks.json registers the five events and restricts tool events to the KB/XRef/Labels servers (never Security)', () => {
    const h = JSON.parse(readFileSync(join(ROOT, 'plugin', 'd365fo-mcp', 'hooks', 'hooks.json'), 'utf8')).hooks;
    assert.deepEqual(Object.keys(h).sort(), ['PostToolUse', 'PostToolUseFailure', 'PreToolUse', 'Stop', 'UserPromptSubmit']);
    for (const ev of ['PreToolUse', 'PostToolUse', 'PostToolUseFailure']) {
      const re = new RegExp(h[ev][0].matcher);
      assert.ok(re.test('mcp__d365kb__d365_lookup_table') && re.test('mcp__claude_ai_D365_xRef__xref_find_references'));
      assert.ok(re.test('mcp__d365labels__labels_lookup') && re.test('mcp__claude_ai_D365_Labels__labels_search'), 'labels calls are captured (2026-09-10)');
      assert.ok(!re.test('mcp__d365sec__sec_lookup_role') && !re.test('Skill') && !re.test('mcp__claude_ai_Microsoft_Learn__microsoft_docs_search'));
      // every server the matcher admits must be one the contract maps to a service, or the hook records service "kb" by default
      for (const name of ['mcp__d365labels__labels_lookup', 'mcp__claude_ai_D365_Labels__labels_search']) assert.equal(parseToolName(name)?.service, 'labels');
    }
    for (const groups of Object.values(h)) for (const g of groups) for (const hk of g.hooks) assert.match(hk.command, /\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/trace-capture\.mjs/);
  });
});
