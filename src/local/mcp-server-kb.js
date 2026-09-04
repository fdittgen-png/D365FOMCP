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
import { registerAllKbTools } from '../azure/tool-sets.js';
import { ensureKbIndexes } from '../azure/kb-indexes.js';
import { serverInfo, serverOptions } from '../azure/server-metadata.js';
import { resolvePreferences, setProcessRequestContext } from '../azure/request-context.js';

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

// Self-healing indexes (#125): the same check getKbDb() runs on Azure, so a
// local snapshot built before an index existed gets it at first start.
if (process.env.KB_AUTO_INDEX !== 'false') ensureKbIndexes(dbPath);

const db = new Database(dbPath, { readonly: true });
db.pragma('journal_mode = OFF');
db.pragma('cache_size = -50000');
db.pragma('mmap_size = 1300000000');

const server = new McpServer(serverInfo('kb'), serverOptions('kb'));

// Client preferences (W2 #106 / W4 #108). A stdio server has ONE client and no
// request boundary, so resolve once from the environment for the whole process
// (MCP_TOOL_PROFILE / MCP_TEXT_CHANNEL); the text-channel policy is re-resolved
// once `initialize` has revealed clientInfo. Registered before connect so the
// handshake cannot race it.
setProcessRequestContext(resolvePreferences({ env: process.env }));
server.server.oninitialized = () => {
  setProcessRequestContext(resolvePreferences({ env: process.env, clientInfo: server.server.getClientVersion() }));
};

// kb + isv-kb + custom-fields — the set is defined ONCE in tool-sets.js so the
// tools/list budget test measures exactly what this server registers.
registerAllKbTools(server, db);

// Graceful shutdown
process.on('SIGINT', () => { try { db.close(); } catch {} process.exit(0); });
process.on('SIGTERM', () => { try { db.close(); } catch {} process.exit(0); });

const transport = new StdioServerTransport();
await server.connect(transport);
