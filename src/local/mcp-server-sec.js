/**
 * D365FO Security Configuration MCP Server (Local stdio)
 *
 * Exposes the D365FO security SQLite database as MCP tools
 * via stdio transport for local development.
 *
 * Uses better-sqlite3 (same as Azure) and calls registerSecTools()
 * directly, ensuring local behavior matches production exactly.
 *
 * Usage: node mcp-server-sec.js [dbPath]
 */

import { createRequire } from 'module';
import { join } from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerAllSecTools } from '../azure/tool-sets.js';
import { serverInfo, serverOptions } from '../azure/server-metadata.js';

// Agent guardrails are a SESSION concern, so they are switched on here — at the
// MCP entry point — rather than defaulting on inside the tool library, where a
// test or a batch script would be caught by loop detection it never asked for.
// See src/azure/tool-guards.js. Set MCP_TOOL_GUARDS=off to disable.
process.env.MCP_TOOL_GUARDS ??= 'on';


const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

// ─── Configuration ───────────────────────────────────────────────────────────

const DEFAULT_DB_PATH = join(
  process.env.USERPROFILE || process.env.HOME || '.',
  '.claude', 'd365fo_sec.sqlite'
);

const dbPath = process.argv[2] || DEFAULT_DB_PATH;

// ─── Database Setup ──────────────────────────────────────────────────────────

const db = new Database(dbPath, { readonly: true });
db.pragma('journal_mode = OFF');
db.pragma('cache_size = -50000');
db.pragma('mmap_size = 67108864');

// ─── MCP Server ──────────────────────────────────────────────────────────────

const server = new McpServer(serverInfo('sec'), serverOptions('sec'));

registerAllSecTools(server, db);

// Graceful shutdown
process.on('SIGINT', () => { try { db.close(); } catch {} process.exit(0); });
process.on('SIGTERM', () => { try { db.close(); } catch {} process.exit(0); });

const transport = new StdioServerTransport();
await server.connect(transport);
