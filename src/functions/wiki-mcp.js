/**
 * Azure Function: Wiki MCP — multi-wiki dispatcher.
 *
 * A single HTTP route serves every configured wiki. The wiki name is a
 * path parameter, looked up against the registry (config/wikis.json or
 * WIKI_CONFIG_JSON env var) at request time. Adding a new wiki is an
 * `Add-WikiMcp.ps1` invocation — no new Function to write, no new route
 * to register.
 *
 * Routes:
 *   GET    /api/wiki-mcp/<name>       → health check (cheap, non-SSE GET)
 *   POST   /api/wiki-mcp/<name>       → MCP JSON-RPC
 *   DELETE /api/wiki-mcp/<name>       → MCP session cleanup
 *   GET    /api/wiki-mcp              → lists every configured wiki (catalog)
 *
 * Transport: `WebStandardStreamableHTTPServerTransport` (same as the other
 * MCP endpoints in this repo). A fresh McpServer per request — keeps the
 * per-wiki tool-registration state isolated and lets us change the registry
 * without restarting the app.
 *
 * Auth: same Entra App-Role gate as the other MCP endpoints
 * (`authorizeMcpRequest`, docs/MCP-Entra-Auth-Setup.md) — Easy Auth validates
 * the bearer token at the platform edge, the code requires the `Mcp.Access`
 * app role on the MCP protocol path. The catalog + health GETs stay open in
 * code (metadata only); Easy Auth covers them once enabled.
 */

import { app } from '@azure/functions';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { loadWikiRegistry, findWiki } from '../azure/wiki-registry.js';
import { registerWikiTools } from '../azure/wiki-tools.js';
import { authorizeMcpRequest } from '../azure/mcp-auth.js';
import { serverInfo, serverOptions, wikiService, requestBaseUrl } from '../azure/server-metadata.js';

/**
 * Registry loaded lazily on first request so module import never throws
 * (a broken registry should yield a clear 500 with detail, not a cold-start
 * crash that wipes every other MCP endpoint on the same Function App).
 */
let _registry = null;
let _registryError = null;

function getRegistry() {
  if (_registry !== null) return _registry;
  if (_registryError) throw _registryError;
  try {
    _registry = loadWikiRegistry();
    return _registry;
  } catch (err) {
    _registryError = err;
    throw err;
  }
}

function buildServer(wiki, baseUrl) {
  const svc = wikiService(wiki);
  const server = new McpServer(serverInfo(svc, { baseUrl }), serverOptions(svc));
  registerWikiTools(server, wiki);
  return server;
}

// ── Catalog route ────────────────────────────────────────────────────────────
//
// A GET on the bare path returns every configured wiki + its endpoint. Useful
// for a human operator exploring "what wikis are deployed?" without going to
// Azure Portal. Not strictly required by the MCP protocol.

app.http('wiki-mcp-catalog', {
  methods: ['GET'],
  route: 'api/wiki-mcp',
  authLevel: 'anonymous',
  handler: async (_request, context) => {
    try {
      const registry = getRegistry();
      return {
        status: 200,
        jsonBody: {
          count: registry.length,
          wikis: registry.map(w => ({
            name: w.name,
            title: w.title,
            description: w.description,
            endpoint: `/api/wiki-mcp/${w.name}`,
          })),
        },
      };
    } catch (err) {
      context.error('wiki-mcp catalog error:', err);
      return {
        status: 500,
        jsonBody: {
          error: 'Wiki registry failed to load.',
          hint: err.message,
        },
      };
    }
  },
});

// ── Per-wiki MCP route ───────────────────────────────────────────────────────

app.http('wiki-mcp', {
  methods: ['GET', 'POST', 'DELETE'],
  route: 'api/wiki-mcp/{name}',
  authLevel: 'anonymous',
  handler: async (request, context) => {
    const name = request.params.name;

    let wiki;
    try {
      const registry = getRegistry();
      wiki = findWiki(registry, name);
      if (!wiki) {
        return {
          status: 404,
          jsonBody: {
            error: `Wiki "${name}" is not configured.`,
            available: registry.map(w => w.name),
            hint: 'Run scripts/Add-WikiMcp.ps1 to add a new wiki, or check spelling.',
          },
        };
      }
    } catch (err) {
      context.error('wiki-mcp registry error:', err);
      return {
        status: 500,
        jsonBody: { error: 'Wiki registry failed to load.', hint: err.message },
      };
    }

    // Cheap health check: GET without `Accept: text/event-stream`.
    if (request.method === 'GET' && !request.headers.get('accept')?.includes('text/event-stream')) {
      return {
        status: 200,
        jsonBody: {
          name: `wiki-${wiki.name}`,
          title: wiki.title,
          container: wiki.container,
          status: 'ok',
        },
      };
    }

    // Entra App-Role gate (docs/MCP-Entra-Auth-Setup.md) — fail closed.
    const denied = authorizeMcpRequest(request);
    if (denied) return denied;

    // MCP protocol path — spin up a fresh server + transport per request.
    try {
      const server = buildServer(wiki, requestBaseUrl(request));
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
      const body = await response.text();
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body,
      };
    } catch (err) {
      context.error(`wiki-mcp[${wiki.name}] error:`, err);
      return {
        status: 500,
        jsonBody: { jsonrpc: '2.0', error: { code: -32603, message: err.message } },
      };
    }
  },
});
