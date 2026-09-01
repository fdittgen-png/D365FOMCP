/**
 * D365FO Knowledge Base MCP Server (Local stdio)
 *
 * Uses better-sqlite3 (same as Azure) and calls registerKbTools()
 * directly, ensuring local behavior matches production exactly.
 *
 * Usage: node mcp-server-kb.js [dbPath]
 */

import { createRequire } from 'module';
import { join } from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerKbTools } from '../azure/kb-tools.js';
import { registerIsvKbTools } from '../azure/isv-kb-tools.js';
import { registerCustomFieldTools } from '../azure/custom-fields-tools.js';
import { serverInfo, serverOptions } from '../azure/server-metadata.js';

// Agent guardrails are a SESSION concern, so they are switched on here — at the
// MCP entry point — rather than defaulting on inside the tool library, where a
// test or a batch script would be caught by loop detection it never asked for.
// See src/azure/tool-guards.js. Set MCP_TOOL_GUARDS=off to disable.
process.env.MCP_TOOL_GUARDS ??= 'on';


const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const DEFAULT_DB_PATH = join(
  process.env.USERPROFILE || process.env.HOME || '.',
  '.claude', 'd365fo_kb.sqlite'
);

const dbPath = process.argv[2] || process.env.KB_DB_PATH || DEFAULT_DB_PATH;

const db = new Database(dbPath, { readonly: true });
db.pragma('journal_mode = OFF');
db.pragma('cache_size = -50000');
db.pragma('mmap_size = 1100000000');

const server = new McpServer(serverInfo('kb'), serverOptions('kb'));

registerKbTools(server, db);
registerIsvKbTools(server, db);
registerCustomFieldTools(server, db);

// Graceful shutdown
process.on('SIGINT', () => { try { db.close(); } catch {} process.exit(0); });
process.on('SIGTERM', () => { try { db.close(); } catch {} process.exit(0); });

const transport = new StdioServerTransport();
await server.connect(transport);
