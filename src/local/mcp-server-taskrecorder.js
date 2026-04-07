/**
 * D365FO Task Recorder MCP Server (Local stdio)
 *
 * Exposes the taskrecorder_to_markdown tool via stdio transport
 * for local development and CLI usage.
 *
 * Usage: node mcp-server-taskrecorder.js
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerTaskRecorderTools } from '../azure/taskrecorder-tools.js';

const server = new McpServer({
  name: 'd365fo-taskrecorder',
  version: '1.0.0',
  description: 'D365FO Task Recorder parser — converts .axtr recordings to structured Markdown for LLM consumption.',
});

registerTaskRecorderTools(server);

// Graceful shutdown
process.on('SIGINT', () => { process.exit(0); });
process.on('SIGTERM', () => { process.exit(0); });

const transport = new StdioServerTransport();
await server.connect(transport);
