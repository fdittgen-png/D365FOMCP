/**
 * D365FO Task Recorder – MCP Tools
 *
 * Registers the taskrecorder_to_markdown tool on an McpServer instance.
 * Accepts a file URL, base64-encoded content, or both.
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
      + 'Provide EITHER file_url (preferred for file uploads/attachments) OR file_content (base64). '
      + 'The output includes: overview, forms visited, every recorded step (commands, data entry, validations, subtasks, navigation), '
      + 'data sources, security roles, navigation flow, and scope tree.',
    {
      file_url: z.string().max(2000).optional().describe(
        'URL to the .axtr file (e.g. from a file upload or attachment). The server will download and parse it directly.'
      ),
      file_content: z.string().max(20000000).optional().describe(
        'Base64-encoded contents of the .axtr file. Use file_url instead when the file is available as a URL.'
      ),
      file_name: z.string().max(255).optional().default('recording.axtr').describe(
        'Original filename (used in the generated footer)'
      ),
    },
    async ({ file_url, file_content, file_name }) => {
      try {
        let buffer;

        if (file_url) {
          // Download file from URL
          const response = await fetch(file_url);
          if (!response.ok) {
            return textResult(`ERROR: Failed to download file from URL: ${response.status} ${response.statusText}`);
          }
          const contentLength = response.headers.get('content-length');
          if (contentLength && parseInt(contentLength) > 50 * 1024 * 1024) {
            return textResult('ERROR: File too large. Maximum supported size is 50 MB.');
          }
          buffer = Buffer.from(await response.arrayBuffer());
          // Derive filename from URL if not provided
          if (file_name === 'recording.axtr' && file_url) {
            try {
              const urlPath = new URL(file_url).pathname;
              const urlName = urlPath.split('/').pop();
              if (urlName && urlName.endsWith('.axtr')) file_name = urlName;
            } catch { /* keep default */ }
          }
        } else if (file_content) {
          if (file_content.length > 20_000_000) {
            return textResult('ERROR: File too large. Maximum supported size is ~15 MB (20 MB base64-encoded).');
          }
          buffer = Buffer.from(file_content, 'base64');
        } else {
          return textResult('ERROR: Provide either file_url or file_content.');
        }

        const markdown = parseTaskRecording(buffer, file_name);
        return textResult(markdown);
      } catch (err) {
        return textResult(`Error parsing task recording: ${err.message}`);
      }
    }
  );
}
