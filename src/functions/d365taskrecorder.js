/**
 * Azure Function: D365FO Task Recorder MCP endpoint
 *
 * Exposes the taskrecorder_to_markdown tool via MCP Streamable HTTP transport.
 * Also provides a test UI and direct file upload endpoint.
 *
 * Routes:
 *   /api/d365taskrecorder          — MCP endpoint (GET health / POST JSON-RPC)
 *   /api/d365taskrecorder/upload   — Test UI (GET) + direct file upload (POST file -> markdown)
 */

import { app } from '@azure/functions';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { registerTaskRecorderTools } from '../azure/taskrecorder-tools.js';
import { parseTaskRecording } from '../azure/taskrecorder-parser.js';

app.setup({ enableHttpStream: true });

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB

// ── Load test UI HTML at startup ────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_UI_HTML = readFileSync(join(__dirname, '..', '..', 'www', 'taskrecorder.html'), 'utf8');

// ── MCP endpoint ────────────────────────────────────────────────────────────

app.http('d365taskrecorder', {
  methods: ['GET', 'POST', 'DELETE'],
  route: 'd365taskrecorder',
  authLevel: 'anonymous',
  handler: async (request, context) => {
    // Health check
    if (request.method === 'GET' && !request.headers.get('accept')?.includes('text/event-stream')) {
      return { status: 200, jsonBody: { name: 'd365fo-taskrecorder', version: '1.0.0', status: 'ok' } };
    }

    try {
      const server = new McpServer({
        name: 'd365fo-taskrecorder',
        version: '1.0.0',
        description: 'D365FO Task Recorder parser — converts .axtr recordings to structured Markdown for LLM consumption.',
      });

      registerTaskRecorderTools(server);

      const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
      await server.connect(transport);

      let options;
      if (request.method === 'POST') {
        const parsedBody = await request.json();
        options = { parsedBody };
      }

      const response = await transport.handleRequest(request, options);

      if (!response || !(response instanceof Response)) {
        return { status: 204 };
      }

      const responseBody = await response.text();
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body: responseBody,
      };
    } catch (err) {
      context.error('d365taskrecorder MCP error:', err);
      return {
        status: 500,
        jsonBody: { jsonrpc: '2.0', error: { code: -32603, message: err.message } },
      };
    }
  },
});

// ── Test UI + direct upload endpoint ────────────────────────────────────────

app.http('d365taskrecorder-upload', {
  methods: ['GET', 'POST'],
  route: 'd365taskrecorder/upload',
  authLevel: 'anonymous',
  handler: async (request, context) => {
    // GET: serve the test UI
    if (request.method === 'GET') {
      return { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: TEST_UI_HTML };
    }

    // POST: parse uploaded file, return markdown as plain text
    try {
      const formData = await request.formData();
      const file = formData.get('file');
      if (!file) {
        return { status: 400, body: 'No file uploaded.' };
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        return { status: 413, body: `File exceeds ${MAX_UPLOAD_BYTES / 1024 / 1024} MB limit.` };
      }

      const buffer = Buffer.from(await file.arrayBuffer());
      const markdown = parseTaskRecording(buffer, file.name || 'recording.axtr');

      return {
        status: 200,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        body: markdown,
      };
    } catch (err) {
      context.error('d365taskrecorder-upload error:', err);
      return { status: 500, body: `Error: ${err.message}` };
    }
  },
});
