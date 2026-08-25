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
import { serverInfo, serverOptions } from '../azure/server-metadata.js';

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

// Graceful shutdown
process.on('SIGINT', () => { try { db.close(); } catch {} process.exit(0); });
process.on('SIGTERM', () => { try { db.close(); } catch {} process.exit(0); });

const transport = new StdioServerTransport();
await server.connect(transport);
