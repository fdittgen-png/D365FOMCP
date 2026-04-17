/**
 * Wiki MCP Server (Local stdio).
 *
 * Exposes one configured wiki via stdio transport. Each wiki gets its own
 * `mcpServers` entry in the client config (Claude Desktop, Claude Code, …):
 *
 *   {
 *     "mcpServers": {
 *       "wiki-otrs": {
 *         "command": "node",
 *         "args": [
 *           "C:\\working\\MCP\\src\\local\\mcp-server-wiki.js",
 *           "otrs"
 *         ]
 *       }
 *     }
 *   }
 *
 * The wiki name can also come from the WIKI_NAME env var, which is handy
 * when a client only lets you configure env vars per server.
 *
 * For local development the blob store reads from the Function App's
 * AzureWebJobsStorage — copy the connection string into a local .env to
 * let stdio mode hit the same wikis that Azure is serving.
 *
 * Usage:
 *   node mcp-server-wiki.js <wiki-name>
 *   WIKI_NAME=otrs node mcp-server-wiki.js
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadWikiRegistry, findWiki } from '../azure/wiki-registry.js';
import { registerWikiTools } from '../azure/wiki-tools.js';

function usageAndExit(msg) {
  process.stderr.write(`${msg}\n`);
  process.stderr.write('Usage: node mcp-server-wiki.js <wiki-name>\n');
  process.stderr.write('       WIKI_NAME=<wiki-name> node mcp-server-wiki.js\n');
  process.exit(1);
}

const wikiName = (process.argv[2] || process.env.WIKI_NAME || '').trim();
if (!wikiName) {
  usageAndExit('Wiki name is required.');
}

let registry;
try {
  registry = loadWikiRegistry();
} catch (err) {
  usageAndExit(`Could not load wiki registry: ${err.message}`);
}

const wiki = findWiki(registry, wikiName);
if (!wiki) {
  const available = registry.length > 0
    ? `Available: ${registry.map(w => w.name).join(', ')}`
    : 'No wikis configured. Add one via scripts/Add-WikiMcp.ps1.';
  usageAndExit(`Wiki "${wikiName}" not found. ${available}`);
}

const server = new McpServer({
  name: `wiki-${wiki.name}`,
  version: '1.0.0',
  description: wiki.description,
});

registerWikiTools(server, wiki);

process.on('SIGINT',  () => { process.exit(0); });
process.on('SIGTERM', () => { process.exit(0); });

const transport = new StdioServerTransport();
await server.connect(transport);
