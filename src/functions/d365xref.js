/**
 * Azure Function: D365FO Cross-Reference MCP endpoint
 *
 * Exposes all XRef tools via MCP Streamable HTTP transport.
 * URL: /api/d365xref
 */

import { app } from '@azure/functions';
import { validateRequestSize } from '../azure/request-size.js';
import { authorizeMcpRequest } from '../azure/mcp-auth.js';
import { serverInfo, serverOptions, healthInfo, requestBaseUrl } from '../azure/server-metadata.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { getXrefDb } from '../azure/shared.js';
import { registerXrefTools } from '../azure/xref-tools.js';

function createXrefServer(baseUrl) {
  const server = new McpServer(serverInfo('xref', { baseUrl }), serverOptions('xref'));
  registerXrefTools(server, getXrefDb());
  return server;
}

app.http('d365xref', {
  methods: ['GET', 'POST', 'DELETE'],
  route: 'api/d365xref',
  authLevel: 'anonymous',
  handler: async (request, context) => {
    // Health check: GET without Accept SSE header
    if (request.method === 'GET' && !request.headers.get('accept')?.includes('text/event-stream')) {
      return { status: 200, jsonBody: healthInfo('xref', { baseUrl: requestBaseUrl(request) }) };
    }

    // Entra App-Role gate (docs/MCP-Entra-Auth-Setup.md) — fail closed.
    const denied = authorizeMcpRequest(request);
    if (denied) return denied;

    try {
      const server = createXrefServer(requestBaseUrl(request));
      const transport = new WebStandardStreamableHTTPServerTransport({
        enableJsonResponse: true,
      });
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
      context.error('d365xref MCP error:', err);
      return {
        status: 500,
        jsonBody: { jsonrpc: '2.0', error: { code: -32603, message: err.message } },
      };
    }
  },
});
