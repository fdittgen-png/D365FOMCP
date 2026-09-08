/**
 * D365FO Labels MCP Server (Local stdio)
 *
 * Same tool set as the Azure entry point (tool-sets.js → registerAllLabelsTools).
 * The where-used tools need the XRef snapshot: XREF_DB_PATH or ~/.claude/d365fo_xref.sqlite
 * when present — absent, those two tools report it instead of failing at start.
 *
 * Usage: node mcp-server-labels.js [labelsDbPath]
 */

import { createRequire } from 'module';
import { join } from 'path';
import { existsSync } from 'fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerAllLabelsTools } from '../azure/tool-sets.js';
import { serverInfo, serverOptions } from '../azure/server-metadata.js';
import { resolvePreferences, setProcessRequestContext } from '../azure/request-context.js';

// Agent guardrails are a SESSION concern, switched on at the MCP entry point
// (see src/azure/tool-guards.js). Set MCP_TOOL_GUARDS=off to disable.
process.env.MCP_TOOL_GUARDS ??= 'on';
// ERP trace, Stream 1: file sink on stdio, ~/.claude/mcp-trace/<service>.ndjson
process.env.MCP_TRACE ??= 'on';
process.env.TRACE_SINK ??= 'file';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const home = process.env.USERPROFILE || process.env.HOME || '.';
const dbPath = process.argv[2] || process.env.LABELS_DB_PATH || join(home, '.claude', 'd365fo_labels.sqlite');
// Let the tool set find the XRef snapshot through the same env the KB/XRef servers use.
if (!process.env.XREF_DB_PATH) {
  const guess = join(home, '.claude', 'd365fo_xref.sqlite');
  if (existsSync(guess)) process.env.XREF_DB_PATH = guess;
}

const db = new Database(dbPath, { readonly: true });
db.pragma('journal_mode = OFF');
db.pragma('cache_size = -50000');
db.pragma('mmap_size = 3221225472');

const server = new McpServer(serverInfo('labels'), serverOptions('labels'));

setProcessRequestContext(resolvePreferences({ env: process.env }));
server.server.oninitialized = () => {
  setProcessRequestContext(resolvePreferences({ env: process.env, clientInfo: server.server.getClientVersion() }));
};

registerAllLabelsTools(server, db);

process.on('SIGINT', () => { try { db.close(); } catch {} process.exit(0); });
process.on('SIGTERM', () => { try { db.close(); } catch {} process.exit(0); });

const transport = new StdioServerTransport();
await server.connect(transport);
