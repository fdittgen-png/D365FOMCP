/**
 * D365FO Cross-Reference MCP Server (Local stdio)
 *
 * Uses better-sqlite3 (same as Azure) and calls registerXrefTools()
 * directly, ensuring local behavior matches production exactly.
 *
 * Usage: node mcp-server-xref.js [dbPath]
 */

import { createRequire } from 'module';
import { join } from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerXrefTools } from '../azure/xref-tools.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const DEFAULT_DB_PATH = join(
  process.env.USERPROFILE || process.env.HOME || '.',
  '.claude', 'd365fo_xref.sqlite'
);

const dbPath = process.argv[2] || process.env.XREF_DB_PATH || DEFAULT_DB_PATH;

const db = new Database(dbPath, { readonly: true });
db.pragma('journal_mode = OFF');
db.pragma('cache_size = -50000');
db.pragma('mmap_size = 3221225472');

const server = new McpServer({
  name: 'd365fo-xref',
  version: '1.0.0',
  description: 'D365FO Cross-Reference — find who calls, extends, implements, or references any AOT object.',
});

registerXrefTools(server, db);

// Graceful shutdown
process.on('SIGINT', () => { try { db.close(); } catch {} process.exit(0); });
process.on('SIGTERM', () => { try { db.close(); } catch {} process.exit(0); });

const transport = new StdioServerTransport();
await server.connect(transport);
