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
import { registerTaskRecorderTools } from '../azure/taskrecorder-tools.js';
import { serverInfo, serverOptions } from '../azure/server-metadata.js';

const server = new McpServer(serverInfo('taskrecorder'), serverOptions('taskrecorder'));

registerTaskRecorderTools(server);

// Graceful shutdown
process.on('SIGINT', () => { process.exit(0); });
process.on('SIGTERM', () => { process.exit(0); });

const transport = new StdioServerTransport();
await server.connect(transport);
