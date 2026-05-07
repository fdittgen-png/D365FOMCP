/**
 * Shared in-process MCP test harness.
 *
 * Spins up a real `McpServer`, registers tool implementations from
 * `src/azure/*-tools.js` against an in-memory SQLite database (or no DB
 * for taskrecorder), and connects a real `Client` over the SDK's
 * `InMemoryTransport.createLinkedPair()`.
 *
 * Each integration test exercises tools through the actual MCP protocol
 * (initialize → tools/list → tools/call) rather than calling handlers
 * directly. This catches contract regressions the unit tests miss:
 * tool registration, schema serialization, and the JSON-RPC round trip.
 *
 * Usage:
 *   const { client, db, close } = await startServer({ register: registerKbTools, schema, fixtures });
 *   try {
 *     const tools = await client.listTools();
 *     const result = await client.callTool({ name: 'd365_lookup_table', arguments: { table_name: 'CustTable' } });
 *   } finally {
 *     await close();
 *   }
 */

import { createRequire } from 'module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

/**
 * Start an in-process MCP server + client connected by an InMemoryTransport pair.
 *
 * @param {object} opts
 * @param {(server: any, db?: any) => void} opts.register  Tool registration function
 *   (e.g. `registerKbTools`). For taskrecorder pass a wrapper that ignores the db arg.
 * @param {string} [opts.schema]  Optional `CREATE TABLE …` DDL applied to the in-memory DB.
 * @param {string} [opts.fixtures]  Optional `INSERT …` statements applied after the schema.
 * @param {boolean} [opts.useDb=true]  Set to false for tools that don't need a DB (taskrecorder).
 * @returns {Promise<{ client: Client, server: McpServer, db: any | null, close: () => Promise<void> }>}
 */
export async function startServer({ register, schema, fixtures, useDb = true }) {
  let db = null;
  if (useDb) {
    db = new Database(':memory:');
    db.pragma('journal_mode = OFF');
    if (schema) db.exec(schema);
    if (fixtures) db.exec(fixtures);
  }

  const server = new McpServer({
    name: 'integration-test-server',
    version: '0.0.0',
    description: 'In-process server for integration tests',
  });

  // The taskrecorder registrar takes only `server`; KB/XRef/Sec take (server, db).
  if (useDb) register(server, db);
  else register(server);

  const client = new Client(
    { name: 'integration-test-client', version: '0.0.0' },
    { capabilities: {} },
  );

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  return {
    client,
    server,
    db,
    async close() {
      try { await client.close(); } catch { /* noop */ }
      try { await server.close(); } catch { /* noop */ }
      if (db) {
        try { db.close(); } catch { /* noop */ }
      }
    },
  };
}

/**
 * Convenience: extract the first text item from an MCP CallToolResult.
 * Throws a descriptive error if the result doesn't have the expected shape,
 * so test failures point at the contract violation, not a generic TypeError.
 */
export function firstTextContent(result) {
  if (!result || !Array.isArray(result.content) || result.content.length === 0) {
    throw new Error('MCP tool result has no content array');
  }
  const item = result.content[0];
  if (!item || item.type !== 'text' || typeof item.text !== 'string') {
    throw new Error(`MCP tool result first content item is not text: ${JSON.stringify(item)}`);
  }
  return item.text;
}
