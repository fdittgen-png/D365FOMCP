/**
 * D365FO Task Recorder MCP Server (Local stdio)
 *
 * Exposes two tools via stdio transport for local development and CLI usage:
 *   taskrecorder_to_markdown  — .axtr → structured Markdown.
 *   taskrecorder_to_document  — .axtr (+ optional .docx) → a self-contained
 *       MHTML web-archive enriched with KB technical detail and Security DB
 *       role-based access. Set KB_DB_PATH / SEC_DB_PATH to enable enrichment.
 *
 * Usage: node mcp-server-taskrecorder.js
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerAllTaskRecorderTools } from '../azure/tool-sets.js';
import { serverInfo, serverOptions } from '../azure/server-metadata.js';
import { resolvePreferences, setProcessRequestContext } from '../azure/request-context.js';

const server = new McpServer(serverInfo('taskrecorder'), serverOptions('taskrecorder'));

// Client preferences (W2 #106 / W4 #108) — one client per stdio process; see mcp-server-kb.js.
setProcessRequestContext(resolvePreferences({ env: process.env }));
server.server.oninitialized = () => {
  setProcessRequestContext(resolvePreferences({ env: process.env, clientInfo: server.server.getClientVersion() }));
};

registerAllTaskRecorderTools(server);

// Graceful shutdown
process.on('SIGINT', () => { process.exit(0); });
process.on('SIGTERM', () => { process.exit(0); });

const transport = new StdioServerTransport();
await server.connect(transport);
