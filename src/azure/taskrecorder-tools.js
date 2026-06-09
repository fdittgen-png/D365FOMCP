/**
 * D365FO Task Recorder – MCP Tools
 *
 * Registers two tools on an McpServer instance:
 *   taskrecorder_to_markdown  — parse a .axtr recording into structured Markdown.
 *   taskrecorder_to_document  — parse a .axtr (+ optional .docx with screenshots)
 *       and generate a single self-contained MHTML web-archive that documents the
 *       recorded process, embeds each screenshot next to its step + BPM security,
 *       and is completed with KB technical detail (used form, executed
 *       classes/methods, OData endpoints) and the Security DB role-based access
 *       chain (roles/sub-roles/duties/privileges) plus the assigned users.
 *
 * Usage:
 *   import { registerTaskRecorderTools } from './taskrecorder-tools.js';
 *   registerTaskRecorderTools(server);
 *
 * The document tool opens the KB and Security databases lazily via the shared
 * singletons (getKbDb / getSecDb). When a database is not configured/present the
 * corresponding enrichment section degrades to a "not available" note rather
 * than failing the tool.
 */

import { z } from 'zod';
import { writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, isAbsolute } from 'path';
import {
  structuredResult,
  errorResult,
  READ_ONLY_DB_ANNOTATIONS,
  getKbDb,
  getSecDb,
} from './shared.js';
import { taskrecorderMarkdownOutput, taskrecorderDocumentOutput } from './output-schemas.js';
import { parseTaskRecording } from './taskrecorder-parser.js';
import { buildTaskRecorderDocument } from './taskrecorder-document.js';

const AXTR_URL_MAX_BYTES = 50 * 1024 * 1024;   // 50 MB downloaded
const CONTENT_B64_MAX = 20_000_000;            // ~15 MB decoded

/**
 * Resolve a file buffer from EITHER a URL (downloaded) or base64 content.
 * Returns `{ buffer, fileName }` on success or `{ error }` (an MCP errorResult)
 * on failure. `fileName` is only derived from the URL when `deriveExt` matches.
 */
async function loadBuffer({ url, content, kind, deriveExt }) {
  if (url) {
    let response;
    try {
      response = await fetch(url);
    } catch (e) {
      return { error: errorResult('invalid-input', `Could not download the ${kind} from the supplied URL.`, e) };
    }
    if (!response.ok) {
      return { error: errorResult('invalid-input', `Failed to download the ${kind}: ${response.status} ${response.statusText}.`) };
    }
    const contentLength = response.headers.get('content-length');
    if (contentLength && Number(contentLength) > AXTR_URL_MAX_BYTES) {
      return { error: errorResult('invalid-input', `${kind} too large. Maximum supported size is 50 MB.`) };
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    let fileName = null;
    try {
      const urlName = new URL(url).pathname.split('/').pop();
      if (urlName && deriveExt && urlName.toLowerCase().endsWith(deriveExt)) fileName = urlName;
    } catch { /* keep null */ }
    return { buffer, fileName };
  }
  if (content) {
    if (content.length > CONTENT_B64_MAX) {
      return { error: errorResult('invalid-input', `${kind} too large. Maximum supported size is ~15 MB (20 MB base64-encoded).`) };
    }
    return { buffer: Buffer.from(content, 'base64'), fileName: null };
  }
  return { error: null, buffer: null, fileName: null };
}

/** Open a shared read-only DB singleton, returning null if it can't be opened. */
function tryOpenDb(getter) {
  try { return getter(); } catch { return null; }
}

function sanitizeFileStem(s) {
  return (s || 'recording').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) || 'recording';
}

export function registerTaskRecorderTools(server) {

  // ── taskrecorder_to_markdown ──────────────────────────────────────────────

  server.registerTool(
    'taskrecorder_to_markdown',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description:
        'Parse a D365FO Task Recorder (.axtr) file and return a structured Markdown description of the recorded test case. '
        + 'USE THIS for a quick, in-context textual read of what a recording does (steps, forms, data entry, security roles). '
        + 'For a shareable, screenshot-rich deliverable also enriched with KB technical detail and role/user data, use taskrecorder_to_document instead. '
        + 'Provide EITHER file_url (preferred for file uploads/attachments) OR file_content (base64). '
        + 'The output includes: overview, forms visited, every recorded step (commands, data entry, validations, subtasks, navigation), '
        + 'data sources, security roles, navigation flow, and scope tree. '
        + 'Returns the full Markdown in BOTH the text channel and structuredContent.markdown — read either directly.',
      inputSchema: {
        file_url: z.string().min(1).max(2000).optional().describe(
          'URL to the .axtr file (e.g. from a file upload or attachment). The server downloads and parses it directly.'),
        file_content: z.string().min(1).max(20000000).optional().describe(
          'Base64-encoded contents of the .axtr file. Use file_url instead when the file is available as a URL.'),
        file_name: z.string().min(1).max(255).optional().default('recording.axtr').describe(
          'Original filename (used in the generated footer).'),
      },
      outputSchema: taskrecorderMarkdownOutput.shape,
    },
    async ({ file_url, file_content, file_name }) => {
      let fileName = typeof file_name === 'string' && file_name ? file_name : 'recording.axtr';
      const loaded = await loadBuffer({ url: file_url, content: file_content, kind: '.axtr file', deriveExt: '.axtr' });
      if (loaded.error) return loaded.error;
      if (!loaded.buffer) return errorResult('invalid-input', 'Provide either file_url or file_content.');
      if (loaded.fileName) fileName = loaded.fileName;

      try {
        const markdown = parseTaskRecording(loaded.buffer, fileName);
        return structuredResult({ markdown, file_name: fileName }, markdown);
      } catch (err) {
        return errorResult('parse-error', 'The .axtr file could not be parsed as a valid Task Recorder recording.', err);
      }
    }
  );

  // ── taskrecorder_to_document ──────────────────────────────────────────────

  server.registerTool(
    'taskrecorder_to_document',
    {
      annotations: READ_ONLY_DB_ANNOTATIONS,
      description:
        'Generate a formatted, self-contained MHTML web-archive ("Web Archive, single file") that fully documents a D365FO Task '
        + 'Recorder recording — the shareable deliverable, vs taskrecorder_to_markdown for a quick textual read. '
        + 'Provide the recording via file_url OR file_content (.axtr), and the Word export via docx_url OR docx_content (.docx) so its '
        + 'screenshots are embedded inline next to each step (omit it and the document still renders, without screenshots). '
        + 'The document has five sections: (1) functional overview; (2) the recorded process — each step with its screenshot and the '
        + 'object security from the BPM package; (3) the BPM package security (role/duty/privilege grants); (4) KB technical detail — '
        + 'the used form, executed/related classes & methods, and OData endpoints; (5) role-based security from the Security DB — each '
        + 'role with its sub-roles, duties, privileges, and assigned users. Sections 4 and 5 require the KB_DB_PATH / SEC_DB_PATH '
        + 'databases; when a database is absent that section degrades to a "not available" note and the tool still succeeds. '
        + 'HOW TO READ THE RESULT: the text channel and structuredContent are a SUMMARY (overview + a step→action mapping table + notes), '
        + 'NOT the document itself. The document is written to output_path (open the .mhtml in a browser or Word). To also receive the raw '
        + 'MHTML text in-band, set return_inline=true (it then appears in structuredContent.document_mhtml). '
        + 'Privacy: assigned-user lists contain user id + name + enabled only — email addresses are never emitted.',
      inputSchema: {
        file_url: z.string().min(1).max(2000).optional().describe('URL to the .axtr recording file.'),
        file_content: z.string().min(1).max(20000000).optional().describe('Base64-encoded .axtr recording contents.'),
        docx_url: z.string().min(1).max(2000).optional().describe('URL to the Word (.docx) export containing the screenshots.'),
        docx_content: z.string().min(1).max(20000000).optional().describe('Base64-encoded .docx contents.'),
        file_name: z.string().min(1).max(255).optional().default('recording.axtr').describe('Original .axtr filename (used in the footer).'),
        output_path: z.string().min(1).max(1000).optional().describe('Absolute path to write the generated .mhtml file. If omitted, the document is written to the OS temp directory.'),
        include_users: z.boolean().optional().default(true).describe('Include the users assigned to each role (no email addresses are ever emitted).'),
        company: z.string().min(1).max(20).optional().describe('Restrict assigned-user lists to this company (legal entity) id.'),
        max_users_per_role: z.number().int().positive().max(1000).optional().default(50).describe('Cap on users listed per role.'),
        return_inline: z.boolean().optional().default(false).describe('Also return the full MHTML document text inside structuredContent.document_mhtml.'),
      },
      outputSchema: taskrecorderDocumentOutput.shape,
    },
    async (args) => {
      const fileNameIn = typeof args.file_name === 'string' && args.file_name ? args.file_name : 'recording.axtr';
      const includeUsers = args.include_users !== false;
      const company = typeof args.company === 'string' && args.company ? args.company : null;
      const maxUsers = Number.isInteger(args.max_users_per_role) && args.max_users_per_role > 0 ? args.max_users_per_role : 50;
      const returnInline = args.return_inline === true;

      // ── load the .axtr (required) ──────────────────────────────────────────
      const axtr = await loadBuffer({ url: args.file_url, content: args.file_content, kind: '.axtr file', deriveExt: '.axtr' });
      if (axtr.error) return axtr.error;
      if (!axtr.buffer) return errorResult('invalid-input', 'Provide the recording via either file_url or file_content (.axtr).');
      const fileName = axtr.fileName || fileNameIn;

      // ── load the .docx (optional) ──────────────────────────────────────────
      let docxBuf = null;
      if (args.docx_url || args.docx_content) {
        const docx = await loadBuffer({ url: args.docx_url, content: args.docx_content, kind: '.docx file', deriveExt: '.docx' });
        if (docx.error) return docx.error;
        docxBuf = docx.buffer;
      }

      // ── lazily open the enrichment DBs (graceful when absent) ──────────────
      const kbDb = tryOpenDb(getKbDb);
      const secDb = tryOpenDb(getSecDb);

      let result;
      try {
        result = buildTaskRecorderDocument(axtr.buffer, docxBuf, {
          kbDb, secDb, includeUsers, company, maxUsers, fileName,
        });
      } catch (err) {
        return errorResult('parse-error', 'The recording could not be parsed into a document.', err);
      }

      const { mhtml, summaryMarkdown, structured } = result;

      // ── write the .mhtml ───────────────────────────────────────────────────
      let outPath = typeof args.output_path === 'string' && args.output_path ? args.output_path : null;
      if (!outPath) {
        outPath = join(tmpdir(), `${sanitizeFileStem(structured.recording.name)}.mhtml`);
      } else if (!isAbsolute(outPath)) {
        // Refuse relative paths — the server's cwd is not meaningful to the caller.
        return errorResult('invalid-input', 'output_path must be an absolute path.');
      }
      try {
        writeFileSync(outPath, mhtml, 'utf8');
        structured.output_path = outPath;
      } catch (err) {
        structured.notes.push('Could not write the document to disk; it is available via return_inline.');
        console.error(`[internal] taskrecorder_to_document write failed -- ${err.name}: ${err.message}`);
        structured.output_path = null;
      }

      if (returnInline) structured.document_mhtml = mhtml;

      const finalSummary = structured.output_path
        ? summaryMarkdown.replace('A self-contained MHTML web-archive was generated.',
            `A self-contained MHTML web-archive was written to \`${structured.output_path}\`.`)
        : summaryMarkdown;

      return structuredResult(structured, finalSummary);
    }
  );
}
