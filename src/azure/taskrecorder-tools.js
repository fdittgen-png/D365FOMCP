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
        'Parse a Task Recorder (.axtr) file into a structured Markdown test-case description: overview, forms, every step, '
        + 'data sources, security roles, navigation, scope tree. Quick in-context read; for the screenshot-rich deliverable use '
        + 'taskrecorder_to_document. Provide file_url OR file_content (base64).',
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
        return structuredResult({ markdown, file_name: fileName }, markdown, 'markdown');
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
      // outputSchema declared up-front (before the long description/inputSchema)
      // so the response-format static scan finds it within its window.
      outputSchema: taskrecorderDocumentOutput.shape,
      description:
        'Self-contained MHTML document of a Task Recorder recording — the shareable deliverable (vs taskrecorder_to_markdown). '
        + 'Inputs: .axtr via file_url/file_content; client repro recording via repro_url/repro_content for inline screenshots; '
        + 'optional legacy .docx. The response is a SUMMARY — the document is written to output_path (return_inline=true embeds it).',
      inputSchema: {
        file_url: z.string().min(1).max(2000).optional().describe('URL to the .axtr recording file.'),
        file_content: z.string().min(1).max(20000000).optional().describe('Base64-encoded .axtr recording contents.'),
        repro_url: z.string().min(1).max(2000).optional().describe('URL to the client repro recording XML (reproReport) — preferred screenshot/step source.'),
        repro_content: z.string().min(1).max(20000000).optional().describe('Base64-encoded repro recording XML.'),
        docx_url: z.string().min(1).max(2000).optional().describe('URL to the legacy Word export with screenshots (used only without a repro recording).'),
        docx_content: z.string().min(1).max(20000000).optional().describe('Base64-encoded .docx (legacy).'),
        file_name: z.string().min(1).max(255).optional().default('recording.axtr').describe('Original .axtr filename (footer).'),
        output_path: z.string().min(1).max(1000).optional().describe('Absolute path for the .mhtml; default: OS temp directory.'),
        include_users: z.boolean().optional().default(true).describe('List the users assigned to each role (never e-mail addresses).'),
        company: z.string().min(1).max(20).optional().describe('Restrict assigned-user lists to this legal entity.'),
        max_users_per_role: z.number().int().positive().max(1000).optional().default(50).describe('Cap on users listed per role.'),
        return_inline: z.boolean().optional().default(false).describe('Also return the full MHTML in structuredContent.document_mhtml (and the XML in document_xml).'),
        include_xml: z.boolean().optional().default(false).describe('Also write a contract XML beside output_path (schemas/task-recording-document.xsd).'),
      },
    },
    async (args) => {
      const fileNameIn = typeof args.file_name === 'string' && args.file_name ? args.file_name : 'recording.axtr';
      const includeUsers = args.include_users !== false;
      const company = typeof args.company === 'string' && args.company ? args.company : null;
      const maxUsers = Number.isInteger(args.max_users_per_role) && args.max_users_per_role > 0 ? args.max_users_per_role : 50;
      const returnInline = args.return_inline === true;
      const includeXml = args.include_xml === true;

      // ── load the .axtr (required) ──────────────────────────────────────────
      const axtr = await loadBuffer({ url: args.file_url, content: args.file_content, kind: '.axtr file', deriveExt: '.axtr' });
      if (axtr.error) return axtr.error;
      if (!axtr.buffer) return errorResult('invalid-input', 'Provide the recording via either file_url or file_content (.axtr).');
      const fileName = axtr.fileName || fileNameIn;

      // ── load the client repro XML (preferred) / .docx (legacy) ────────────
      let reproBuf = null;
      if (args.repro_url || args.repro_content) {
        const rep = await loadBuffer({ url: args.repro_url, content: args.repro_content, kind: 'repro recording', deriveExt: '.xml' });
        if (rep.error) return rep.error;
        reproBuf = rep.buffer;
      }
      let docxBuf = null;
      if (!reproBuf && (args.docx_url || args.docx_content)) {
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
          kbDb, secDb, reproBuf, includeUsers, company, maxUsers, fileName,
        });
      } catch (err) {
        return errorResult('parse-error', 'The recording could not be parsed into a document.', err);
      }

      const { mhtml, xml, summaryMarkdown, structured } = result;

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

      // ── emit the contract XML (sibling .xml) ───────────────────────────────
      if (includeXml) {
        const xmlPath = outPath.replace(/\.mhtml$/i, '') + '.xml';
        try {
          writeFileSync(xmlPath, xml, 'utf8');
          structured.xml_output_path = xmlPath;
        } catch (err) {
          structured.notes.push('Could not write the contract XML to disk; it is available via return_inline.');
          console.error(`[internal] taskrecorder_to_document XML write failed -- ${err.name}: ${err.message}`);
          structured.xml_output_path = null;
        }
        if (returnInline) structured.document_xml = xml;
      }

      const finalSummary = structured.output_path
        ? summaryMarkdown.replace('A self-contained MHTML web-archive was generated.',
            `A self-contained MHTML web-archive was written to \`${structured.output_path}\`.`)
        : summaryMarkdown;

      return structuredResult(structured, finalSummary, 'markdown');
    }
  );
}
