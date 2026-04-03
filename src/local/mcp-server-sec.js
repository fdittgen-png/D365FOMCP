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
import { registerSecTools } from '../azure/sec-tools.js';

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
db.pragma('cache_size = -200000');
db.pragma('mmap_size = 3221225472');

// ─── MCP Server ──────────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'd365fo-sec',
  version: '1.0.0',
  description: 'D365FO Security Configuration — roles, duties, privileges, permissions, and user assignments.',
});

registerSecTools(server, db);

const transport = new StdioServerTransport();
await server.connect(transport);
