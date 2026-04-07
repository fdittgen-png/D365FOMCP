/**
 * Azure Function: D365FO Security Configuration MCP endpoint
 *
 * Exposes all Security tools via MCP Streamable HTTP transport.
 * URL: /api/d365sec
 */

import { app } from '@azure/functions';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { getSecDb, query } from '../azure/shared.js';
import { registerSecTools } from '../azure/sec-tools.js';

function createSecServer() {
  const server = new McpServer({
    name: 'd365fo-sec',
    version: '1.0.0',
    description: 'D365FO Security Configuration — roles, duties, privileges, permissions, and user assignments.',
  });
  registerSecTools(server, getSecDb());
  return server;
}

app.http('d365sec', {
  methods: ['GET', 'POST', 'DELETE'],
  route: 'd365sec',
  authLevel: 'function',
  handler: async (request, context) => {
    // Health check: GET without Accept SSE header
    if (request.method === 'GET' && !request.headers.get('accept')?.includes('text/event-stream')) {
      let lastUpdated = null;
      try {
        const db = getSecDb();
        const row = query(db, "SELECT value FROM sec_metadata WHERE key = 'build_date'");
        if (row.length) lastUpdated = row[0].value;
      } catch { /* DB not loaded yet */ }
      return { status: 200, jsonBody: { name: 'd365fo-sec', version: '1.0.0', status: 'ok', lastUpdated } };
    }

    try {
      const server = createSecServer();
      const transport = new WebStandardStreamableHTTPServerTransport({
        enableJsonResponse: true,
      });
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
      context.error('d365sec MCP error:', err);
      return {
        status: 500,
        jsonBody: { jsonrpc: '2.0', error: { code: -32603, message: err.message } },
      };
    }
  },
});
