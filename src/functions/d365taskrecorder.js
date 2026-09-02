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
import { registerAllTaskRecorderTools } from '../azure/tool-sets.js';
import { parseTaskRecording } from '../azure/taskrecorder-parser.js';
import { validateRequestSize } from '../azure/request-size.js';
import { authorizeMcpRequest } from '../azure/mcp-auth.js';
import { serverInfo, serverOptions, healthInfo, requestBaseUrl } from '../azure/server-metadata.js';

/**
 * Per-endpoint upload ceiling for Task Recorder recordings.
 * Recordings are typically < 1 MB. The 2 GB host.json limit is set for
 * security DB uploads (KB ~1 GB, XRef ~3.3 GB) and is too permissive for
 * this endpoint specifically — Azure Functions has no per-route override,
 * so we enforce it here.
 */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * Decide whether an upload's declared size is acceptable. Pure function — easy to unit-test.
 * Returns `null` when the request may proceed; otherwise returns the rejection
 * `{ status, body }` to send back. Issue #43: enforce the size check via the
 * `Content-Length` header BEFORE the body is read into memory, so a 60 MB
 * upload is rejected with 413 before allocating a 60 MB buffer.
 */
export function checkUploadSize(contentLengthHeader, max = MAX_UPLOAD_BYTES) {
  if (contentLengthHeader == null || contentLengthHeader === '') {
    return {
      status: 413,
      body: `Content-Length header is required (max ${max / 1024 / 1024} MB).`,
    };
  }
  const len = Number(contentLengthHeader);
  if (!Number.isFinite(len) || len < 0) {
    return {
      status: 413,
      body: `Invalid Content-Length header (max ${max / 1024 / 1024} MB).`,
    };
  }
  if (len > max) {
    return {
      status: 413,
      body: `File exceeds ${max / 1024 / 1024} MB limit (${(len / 1024 / 1024).toFixed(1)} MB declared).`,
    };
  }
  return null;
}

// ── Load test UI HTML at startup ────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
let TEST_UI_HTML = '<html><body>Upload UI not available</body></html>';
try {
  TEST_UI_HTML = readFileSync(join(__dirname, '..', '..', 'www', 'taskrecorder.html'), 'utf8');
} catch { /* UI file not bundled in this deployment */ }

// ── MCP server factory ─────────────────────────────────────────────────────

function createTaskRecorderServer(baseUrl) {
  const server = new McpServer(serverInfo('taskrecorder', { baseUrl }), serverOptions('taskrecorder'));
  registerAllTaskRecorderTools(server);
  return server;
}

// ── MCP endpoint ────────────────────────────────────────────────────────────

app.http('d365taskrecorder', {
  methods: ['GET', 'POST', 'DELETE'],
  route: 'api/d365taskrecorder',
  authLevel: 'anonymous',
  handler: async (request, context) => {
    // Health check
    if (request.method === 'GET' && !request.headers.get('accept')?.includes('text/event-stream')) {
      return { status: 200, jsonBody: healthInfo('taskrecorder', { baseUrl: requestBaseUrl(request) }) };
    }

    // Entra App-Role gate (docs/MCP-Entra-Auth-Setup.md) — fail closed.
    const denied = authorizeMcpRequest(request);
    if (denied) return denied;

    try {
      const server = createTaskRecorderServer(requestBaseUrl(request));
      const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
      await server.connect(transport);

      let options;
      if (request.method === 'POST') {
        const sizeRejection = validateRequestSize(request);
        if (sizeRejection) return sizeRejection;
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
  route: 'api/d365taskrecorder/upload',
  authLevel: 'anonymous',
  handler: async (request, context) => {
    // GET: serve the test UI
    if (request.method === 'GET') {
      return { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: TEST_UI_HTML };
    }

    // POST: parse uploaded file, return markdown as plain text
    // Same Entra App-Role gate as the MCP endpoint — this route processes data.
    const denied = authorizeMcpRequest(request);
    if (denied) return denied;

    try {
      // Pre-check Content-Length BEFORE reading the body (issue #43).
      const sizeRejection = checkUploadSize(request.headers.get('content-length'));
      if (sizeRejection) return sizeRejection;

      const formData = await request.formData();
      const file = formData.get('file');
      if (!file) {
        return { status: 400, body: 'No file uploaded.' };
      }
      // Defence-in-depth: re-check the actual file size (Content-Length covers
      // the whole multipart envelope, so a near-limit envelope might wrap a
      // file just under the per-part cap — but a file *larger* than the
      // overall envelope is impossible, so this check only catches edge cases).
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
