/**
 * Azure Function: D365FO Knowledge Base MCP endpoint
 *
 * Exposes all KB tools via MCP Streamable HTTP transport.
 * URL: /api/d365kb
 */

import { app } from '@azure/functions';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { getKbDb } from '../azure/shared.js';
import { registerKbTools } from '../azure/kb-tools.js';

function createKbServer() {
  const server = new McpServer({
    name: 'd365fo-kb',
    version: '1.0.0',
    description: 'D365FO Knowledge Base — tables, fields, joins, enums, classes, methods, and more.',
  });
  registerKbTools(server, getKbDb());
  return server;
}

app.http('d365kb', {
  methods: ['GET', 'POST', 'DELETE'],
  route: 'd365kb',
  authLevel: 'anonymous',
  handler: async (request, context) => {
    // Health check: GET without Accept SSE header
    if (request.method === 'GET' && !request.headers.get('accept')?.includes('text/event-stream')) {
      return { status: 200, jsonBody: { name: 'd365fo-kb', version: '1.0.0', status: 'ok' } };
    }

    try {
      const server = createKbServer();
      const transport = new WebStandardStreamableHTTPServerTransport({
        enableJsonResponse: true,
      });
      await server.connect(transport);

      // Parse body for POST, pass as parsedBody option
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
      context.error('d365kb MCP error:', err);
      return {
        status: 500,
        jsonBody: { jsonrpc: '2.0', error: { code: -32603, message: err.message } },
      };
    }
  },
});
