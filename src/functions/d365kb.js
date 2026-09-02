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
import { registerAllKbTools } from '../azure/tool-sets.js';
import { validateRequestSize } from '../azure/request-size.js';
import { authorizeMcpRequest } from '../azure/mcp-auth.js';
import { serverInfo, serverOptions, healthInfo, requestBaseUrl } from '../azure/server-metadata.js';

// Agent guardrails are a SESSION concern, so they are switched on here — at the
// MCP entry point — rather than defaulting on inside the tool library, where a
// test or a batch script would be caught by loop detection it never asked for.
// See src/azure/tool-guards.js. Set MCP_TOOL_GUARDS=off to disable.
process.env.MCP_TOOL_GUARDS ??= 'on';


function createKbServer(baseUrl) {
  const server = new McpServer(serverInfo('kb', { baseUrl }), serverOptions('kb'));
  // kb + isv-kb + custom-fields, defined once in tool-sets.js (budget test).
  registerAllKbTools(server, getKbDb());
  return server;
}

app.http('d365kb', {
  methods: ['GET', 'POST', 'DELETE'],
  route: 'api/d365kb',
  authLevel: 'anonymous',
  handler: async (request, context) => {
    // Health check: GET without Accept SSE header
    if (request.method === 'GET' && !request.headers.get('accept')?.includes('text/event-stream')) {
      return { status: 200, jsonBody: healthInfo('kb', { baseUrl: requestBaseUrl(request) }) };
    }

    // Entra App-Role gate (docs/MCP-Entra-Auth-Setup.md) — fail closed.
    const denied = authorizeMcpRequest(request);
    if (denied) return denied;

    try {
      const server = createKbServer(requestBaseUrl(request));
      const transport = new WebStandardStreamableHTTPServerTransport({
        enableJsonResponse: true,
      });
      await server.connect(transport);

      // Parse body for POST, pass as parsedBody option
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
      context.error('d365kb MCP error:', err);
      return {
        status: 500,
        jsonBody: { jsonrpc: '2.0', error: { code: -32603, message: err.message } },
      };
    }
  },
});
