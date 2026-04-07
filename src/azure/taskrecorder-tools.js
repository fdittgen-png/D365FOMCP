/**
 * D365FO Task Recorder – MCP Tools
 *
 * Registers the taskrecorder_to_markdown tool on an McpServer instance.
 * Accepts a base64-encoded .axtr file and returns structured Markdown.
 *
 * Usage:
 *   import { registerTaskRecorderTools } from './taskrecorder-tools.js';
 *   registerTaskRecorderTools(server);
 */

import { z } from 'zod';
import { textResult } from './shared.js';
import { parseTaskRecording } from './taskrecorder-parser.js';

export function registerTaskRecorderTools(server) {

  server.tool(
    'taskrecorder_to_markdown',
    'Parse a D365FO Task Recorder (.axtr) file and return a structured Markdown document describing the recorded test case. '
      + 'The output includes: overview, forms visited, every recorded step (commands, data entry, validations, subtasks, navigation), '
      + 'data sources, security roles, navigation flow, and scope tree.',
    {
      file_content: z.string().max(20000000).describe(
        'Base64-encoded contents of the .axtr file'
      ),
      file_name: z.string().max(255).optional().default('recording.axtr').describe(
        'Original filename (used in the generated footer)'
      ),
    },
    async ({ file_content, file_name }) => {
      if (file_content.length > 20_000_000) {
        return textResult('ERROR: File too large. Maximum supported size is ~15 MB (20 MB base64-encoded).');
      }
      try {
        const buffer = Buffer.from(file_content, 'base64');
        const markdown = parseTaskRecording(buffer, file_name);
        return textResult(markdown);
      } catch (err) {
        return textResult(`Error parsing task recording: ${err.message}`);
      }
    }
  );
}
