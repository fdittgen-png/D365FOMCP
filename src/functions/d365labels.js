/**
 * D365FO Labels MCP Server — Azure Function (Streamable HTTP)
 *
 * Route: /api/d365labels. Same skeleton as d365kb.js: one McpServer per request,
 * the tool set defined once in tool-sets.js (registerAllLabelsTools), the labels
 * snapshot from getLabelsDb() and the XRef snapshot (where-used) picked up by the
 * set itself when /home/data/d365fo_xref.sqlite is present.
 */
import { app } from '@azure/functions';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { getLabelsDb } from '../azure/shared.js';
import { registerAllLabelsTools } from '../azure/tool-sets.js';
import { validateRequestSize } from '../azure/request-size.js';
import { authorizeMcpRequest } from '../azure/mcp-auth.js';
import { serverInfo, serverOptions, healthInfo, requestBaseUrl } from '../azure/server-metadata.js';
import { preferencesFromHttpRequest, runWithRequestContext, describePreferences } from '../azure/request-context.js';

// Agent guardrails are a SESSION concern, switched on at the MCP entry point
// (see src/azure/tool-guards.js). Set MCP_TOOL_GUARDS=off to disable.
process.env.MCP_TOOL_GUARDS ??= 'on';

function createLabelsServer(baseUrl) {
  const server = new McpServer(serverInfo('labels', { baseUrl }), serverOptions('labels'));
  registerAllLabelsTools(server, getLabelsDb());
  return server;
}

app.http('d365labels', {
  methods: ['GET', 'POST', 'DELETE'],
  route: 'api/d365labels',
  authLevel: 'anonymous',
  handler: async (request, context) => {
    // Health check: GET without Accept SSE header
    if (request.method === 'GET' && !request.headers.get('accept')?.includes('text/event-stream')) {
      return { status: 200, jsonBody: healthInfo('labels', { baseUrl: requestBaseUrl(request) }) };
    }

    // Entra App-Role gate (docs/MCP-Entra-Auth-Setup.md) — fail closed.
    const denied = authorizeMcpRequest(request);
    if (denied) return denied;

    const prefs = preferencesFromHttpRequest(request);
    console.info(`d365labels request ${describePreferences(prefs)}`);

    try {
      return await runWithRequestContext(prefs, async () => {
        const server = createLabelsServer(requestBaseUrl(request));
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
        if (!response || !(response instanceof Response)) return { status: 204 };

        const responseBody = await response.text();
        return {
          status: response.status,
          headers: Object.fromEntries(response.headers.entries()),
          body: responseBody,
        };
      });
    } catch (err) {
      context.error('d365labels MCP error:', err);
      return {
        status: 500,
        jsonBody: { jsonrpc: '2.0', error: { code: -32603, message: err.message } },
      };
    }
  },
});
