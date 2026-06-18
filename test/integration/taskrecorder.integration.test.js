/**
 * Integration test: Task Recorder MCP service over the in-process MCP protocol.
 *
 * Stands up a real `McpServer` with `registerTaskRecorderTools()` and drives
 * it through a real `Client` over the SDK's `InMemoryTransport`. No DB.
 *
 * Per acceptance criteria for issue #31:
 *  - tools/list returns at least one tool
 *  - tool returns a well-shaped CallToolResult on valid base64 input
 *  - invalid input is rejected (validation error or graceful textResult)
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import { startServer, firstTextContent } from './harness.js';
import { registerTaskRecorderTools } from '../../src/azure/taskrecorder-tools.js';

const require = createRequire(import.meta.url);
const AdmZip = require('adm-zip');

// ── Build a minimal synthetic .axtr buffer ───────────────────────────────────

function buildSyntheticAxtr() {
  const recordingXml = `<?xml version="1.0" encoding="utf-8"?>
<Recording xmlns:i="http://www.w3.org/2001/XMLSchema-instance"
           xmlns="http://schemas.datacontract.org/2004/07/Microsoft.Dynamics.Client.ServerForm.TaskRecording">
  <CanonicalId>integration-test-id</CanonicalId>
  <CurrentSequence>1</CurrentSequence>
  <Description>Integration test recording</Description>
  <FormContexts xmlns:d2p1="http://schemas.microsoft.com/2003/10/Serialization/Arrays"></FormContexts>
  <Name>IntegrationTest</Name>
  <RootScope xmlns:z="http://schemas.microsoft.com/2003/10/Serialization/">
    <CustomDescription i:nil="true" />
    <Description i:nil="true" />
    <Id>root-id</Id>
    <Parent i:nil="true" />
    <ParentSequence>0</ParentSequence>
    <ScreenshotUri i:nil="true" />
    <Sequence>0</Sequence>
    <Children></Children>
    <IsForm>false</IsForm>
    <IsStepGroup>false</IsStepGroup>
    <Name>IntegrationTest</Name>
    <ScopeType>Public</ScopeType>
  </RootScope>
  <Version>1</Version>
</Recording>`;

  const zip = new AdmZip();
  zip.addFile('Recording.xml', Buffer.from(recordingXml, 'utf8'));
  return zip.toBuffer();
}

// ── Suite ────────────────────────────────────────────────────────────────────

let session;

before(async () => {
  session = await startServer({
    register: registerTaskRecorderTools,
    useDb: false,
  });
});

after(async () => {
  if (session) await session.close();
});

describe('Task Recorder MCP service — in-process protocol', () => {
  it('tools/list exposes the taskrecorder_to_markdown tool', async () => {
    const { tools } = await session.client.listTools();
    assert.ok(Array.isArray(tools));
    assert.ok(tools.length > 0, 'at least one Task Recorder tool must be registered');

    for (const t of tools) {
      assert.equal(typeof t.name, 'string');
      assert.equal(typeof t.description, 'string');
      assert.equal(typeof t.inputSchema, 'object');
    }

    const names = new Set(tools.map(t => t.name));
    assert.ok(names.has('taskrecorder_to_markdown'),
      `Task Recorder service must register taskrecorder_to_markdown; got ${[...names].join(', ')}`);
  });

  it('parses a synthetic .axtr buffer passed via base64 file_content', async () => {
    const buffer = buildSyntheticAxtr();
    const result = await session.client.callTool({
      name: 'taskrecorder_to_markdown',
      arguments: {
        file_content: buffer.toString('base64'),
        file_name: 'integration.axtr',
      },
    });
    assert.ok(Array.isArray(result.content), 'result.content must be an array');
    assert.equal(result.content[0].type, 'text');
    assert.equal(typeof result.content[0].text, 'string');
    assert.notEqual(result.isError, true);

    const text = firstTextContent(result);
    assert.ok(text.length > 0, 'parser must return non-empty markdown');
    assert.match(text, /IntegrationTest/, 'output must reference the recording name from the synthetic fixture');
  });

  it('returns a tool-level error when neither file_url nor file_content is provided', async () => {
    // Both args are optional in the schema, so this path is handler-level —
    // the tool returns an errorResult (isError=true) naming the missing inputs
    // rather than throwing (migrated off the legacy "ERROR:" textResult).
    const result = await session.client.callTool({
      name: 'taskrecorder_to_markdown',
      arguments: {},
    });
    assert.ok(Array.isArray(result.content));
    assert.equal(result.isError, true);
    const text = firstTextContent(result);
    assert.match(text, /file_url|file_content/);
  });

  it('rejects invalid input (wrong type for file_name) with an isError result', async () => {
    // SDK v1.27 returns input-validation failures as a CallToolResult with
    // isError=true and the validation message in content[0].text — it does
    // not throw a client-side exception.
    const result = await session.client.callTool({
      name: 'taskrecorder_to_markdown',
      arguments: {
        file_content: Buffer.from('not a real zip').toString('base64'),
        file_name: 12345, // schema requires string
      },
    });
    assert.equal(result.isError, true, 'invalid input must set isError on the result');
    const text = firstTextContent(result);
    assert.match(
      text,
      /(invalid|validation|params)/i,
      `expected validation-flavored error text, got: ${text}`,
    );
  });
});
