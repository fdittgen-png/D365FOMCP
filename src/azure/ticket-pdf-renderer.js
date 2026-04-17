/**
 * OTRS ticket XML → PDF renderer (pure, buffer-returning).
 *
 * Shared by:
 *   - the CLI script `scripts/ticket-xml-to-pdf.js` — writes buffers to disk
 *   - the admin HTTP endpoint `POST /api/otrs-admin/convert-to-pdf` —
 *     zips buffers and streams the ZIP back to the browser
 *
 * Emits one main PDF per ticket plus one sibling PDF per NON-image
 * attachment (PNG/JPEG are embedded into the main PDF). Base64 bytes
 * are decoded on the way out and never appear in any rendered output.
 *
 * Contract:
 *   renderExtractPdfs({ xml, deps }) → Promise<{
 *     tickets: number,
 *     files: Array<{ filename: string, buffer: Buffer, contentType: string }>,
 *     warnings: Array<{ ticketId:string, filename:string, reason:string }>,
 *   }>
 *
 * `deps` may be produced by `loadPdfDeps()` below. Passing them in keeps
 * this module import-cheap — tests that don't exercise rendering don't
 * need to load mammoth/xlsx.
 */

import { createRequire } from 'node:module';
import { parseExtractXml } from './otrs-xml-parse.js';
import {
  isFilled,
  collectFilledMetadata,
  isEmbeddableImage,
  attachmentRenderer,
  siblingPdfName,
  safeFilename,
  toReadableText,
  humanSize,
} from './ticket-pdf-helpers.js';

// pdfkit is CommonJS — load via createRequire so ESM + CJS interop is clean.
const require = createRequire(import.meta.url);
const PDFDocument = require('pdfkit');

// ── Page layout constants ───────────────────────────────────────────────────

const PAGE = { size: 'A4', margin: 50 };
const FONT = {
  title:   { name: 'Helvetica-Bold', size: 18 },
  section: { name: 'Helvetica-Bold', size: 13 },
  sub:     { name: 'Helvetica-Bold', size: 11 },
  body:    { name: 'Helvetica',      size: 10 },
  meta:    { name: 'Helvetica',      size:  9, color: '#555' },
  mono:    { name: 'Courier',        size:  9 },
};

// ── Deps loader ─────────────────────────────────────────────────────────────

/**
 * Load the three heavy renderer deps once. Kept out of the module's
 * top-level imports so `src/azure/` modules that only use the XML parser
 * (e.g. the wiki-ingestor) don't pay the startup cost of parsing
 * mammoth/xlsx when they boot.
 */
export async function loadPdfDeps() {
  const [mammothMod, XLSXMod, htmlToTextMod] = await Promise.all([
    import('mammoth'),
    import('xlsx'),
    import('html-to-text'),
  ]);
  return {
    mammoth:    mammothMod.default || mammothMod,
    XLSX:       XLSXMod.default || XLSXMod,
    htmlToText: htmlToTextMod.convert,
  };
}

// ── Entry point ─────────────────────────────────────────────────────────────

/**
 * Render every ticket in the XML to PDF buffers.
 *
 * @param {object} opts
 * @param {string} opts.xml - the OtrsExtract document
 * @param {object} opts.deps - output of loadPdfDeps()
 * @returns {Promise<{tickets:number, files:Array<{filename,buffer,contentType}>, warnings:Array}>}
 */
export async function renderExtractPdfs({ xml, deps }) {
  if (!deps) throw new Error('renderExtractPdfs requires { deps } — call loadPdfDeps() first.');
  const parsed = parseExtractXml(xml);
  const files = [];
  const warnings = [];

  for (const ticket of parsed.tickets) {
    const perTicket = await renderOneTicket(ticket, deps, warnings);
    files.push(...perTicket);
  }

  return { tickets: parsed.tickets.length, files, warnings };
}

async function renderOneTicket(ticket, deps, warnings) {
  const slug = safeFilename(ticket.ticketId || 'unknown');
  const files = [];

  const mainBuffer = await renderMainPdfBuffer(ticket, slug, deps);
  files.push({
    filename: `ticket-${slug}.pdf`,
    buffer: mainBuffer,
    contentType: 'application/pdf',
  });

  let attachmentCounter = 0;
  for (const article of (ticket.articles || [])) {
    for (const att of (article.attachments || [])) {
      attachmentCounter++;
      if (isEmbeddableImage(att.contentType)) continue;   // embedded inline
      try {
        const buffer = await renderAttachmentBuffer(att, deps);
        const filename = siblingPdfName(slug, attachmentCounter, att.filename);
        files.push({ filename, buffer, contentType: 'application/pdf' });
      } catch (err) {
        warnings.push({
          ticketId: ticket.ticketId,
          filename: att.filename,
          reason: err?.message || String(err),
        });
      }
    }
  }

  return files;
}

// ── Main ticket PDF ─────────────────────────────────────────────────────────

async function renderMainPdfBuffer(ticket, slug, deps) {
  const { doc, done } = newDoc({
    Title: ticket.title ? `OTRS ${ticket.ticketNumber || ticket.ticketId} — ${ticket.title}` : `OTRS ${ticket.ticketId}`,
    Author: 'OTRS extract',
    Subject: ticket.service || '',
  });

  // Header
  doc.font(FONT.title.name).fontSize(FONT.title.size).fillColor('black')
     .text(ticket.title || `OTRS Ticket ${ticket.ticketId}`, { lineGap: 2 });
  doc.moveDown(0.3);
  doc.font(FONT.meta.name).fontSize(FONT.meta.size).fillColor(FONT.meta.color)
     .text(`Ticket ${ticket.ticketNumber || ticket.ticketId}`
           + (ticket.service ? ` · ${ticket.service}` : '')
           + (ticket.closedAt ? ` · closed ${ticket.closedAt}` : ''));
  doc.moveDown();

  // Ticket metadata (filled-only)
  renderKeyValueBlock(doc, 'Ticket metadata', collectFilledMetadata(ticket));

  // Dynamic fields (filled-only)
  const dynFilled = (ticket.dynamicFields || [])
    .filter(f => isFilled(f.value))
    .map(f => ({ key: f.name, value: f.value }));
  if (dynFilled.length > 0) {
    renderKeyValueBlock(doc, 'Dynamic fields', dynFilled);
  }

  // Problem / Resolution
  if (isFilled(ticket.description)) {
    renderTextSection(doc, 'Problem', toReadableText(ticket.description, { htmlToText: deps.htmlToText }));
  }
  if (isFilled(ticket.resolution)) {
    renderTextSection(doc, 'Resolution', toReadableText(ticket.resolution, { htmlToText: deps.htmlToText }));
  }

  // Article trace
  if (ticket.articles?.length > 0) {
    doc.addPage();
    doc.font(FONT.section.name).fontSize(FONT.section.size).fillColor('black')
       .text(`Article trace (${ticket.articles.length})`);
    doc.moveDown(0.5);

    for (const [i, article] of ticket.articles.entries()) {
      renderArticle(doc, article, i + 1, ticket, slug, deps);
      doc.moveDown();
    }
  }

  doc.end();
  return done;
}

// ── Main-PDF sections ───────────────────────────────────────────────────────

function renderKeyValueBlock(doc, title, rows) {
  if (!rows || rows.length === 0) return;
  sectionHeader(doc, title);

  const labelWidth = 120;
  doc.font(FONT.body.name).fontSize(FONT.body.size).fillColor('black');
  for (const row of rows) {
    const startY = doc.y;
    doc.font(FONT.sub.name).text(`${row.key}:`, doc.page.margins.left, startY, {
      width: labelWidth, continued: false,
    });
    doc.font(FONT.body.name).text(String(row.value), doc.page.margins.left + labelWidth, startY, {
      width: doc.page.width - doc.page.margins.left - doc.page.margins.right - labelWidth,
    });
    doc.moveDown(0.2);
  }
  doc.moveDown(0.5);
}

function renderTextSection(doc, title, text) {
  if (!isFilled(text)) return;
  sectionHeader(doc, title);
  doc.font(FONT.body.name).fontSize(FONT.body.size).fillColor('black')
     .text(text, { align: 'left', paragraphGap: 4 });
  doc.moveDown(0.5);
}

function sectionHeader(doc, title) {
  doc.font(FONT.section.name).fontSize(FONT.section.size).fillColor('black').text(title);
  doc.moveDown(0.2);
}

function renderArticle(doc, article, index, ticket, slug, deps) {
  if (doc.y > doc.page.height - doc.page.margins.bottom - 100) doc.addPage();

  const who  = article.senderType || 'unknown';
  const when = article.createdAt ? ` · ${article.createdAt}` : '';
  const from = article.from ? ` · ${article.from}` : '';
  doc.font(FONT.sub.name).fontSize(FONT.sub.size).fillColor('black')
     .text(`#${index} — ${who}${from}${when}`);
  doc.moveDown(0.1);

  if (isFilled(article.subject)) {
    doc.font(FONT.meta.name).fontSize(FONT.meta.size).fillColor(FONT.meta.color)
       .text(`Subject: ${article.subject}`);
  }
  if (isFilled(article.contentType) && article.contentType !== 'text/plain') {
    doc.font(FONT.meta.name).fontSize(FONT.meta.size).fillColor(FONT.meta.color)
       .text(`Content-Type: ${article.contentType}`);
  }
  doc.moveDown(0.3);

  const body = toReadableText(article.body, { htmlToText: deps.htmlToText });
  if (isFilled(body)) {
    doc.font(FONT.body.name).fontSize(FONT.body.size).fillColor('black')
       .text(body, { paragraphGap: 4 });
  }

  const atts = article.attachments || [];
  if (atts.length === 0) return;

  doc.moveDown(0.3);
  doc.font(FONT.meta.name).fontSize(FONT.meta.size).fillColor(FONT.meta.color)
     .text(`Attachments (${atts.length}):`);

  let globalCounter = countAttachmentsBefore(ticket, article);
  for (const att of atts) {
    globalCounter++;
    if (isEmbeddableImage(att.contentType)) {
      doc.font(FONT.meta.name).text(
        `• ${safeFilename(att.filename)} (${att.contentType}, ${humanSize(att.filesizeBytes)}) — embedded below:`,
      );
      embedImage(doc, att);
    } else {
      const sibling = siblingPdfName(slug, globalCounter, att.filename);
      doc.font(FONT.meta.name).text(
        `• ${safeFilename(att.filename)} (${att.contentType || 'unknown'}, ${humanSize(att.filesizeBytes)}) — see sibling file: ${sibling}`,
      );
    }
  }
}

function countAttachmentsBefore(ticket, currentArticle) {
  let n = 0;
  for (const a of (ticket.articles || [])) {
    if (a === currentArticle) break;
    n += (a.attachments || []).length;
  }
  return n;
}

function embedImage(doc, att) {
  if (!isFilled(att.content)) return;
  let buffer;
  try { buffer = Buffer.from(att.content, 'base64'); } catch { return; }
  if (buffer.length === 0) return;

  doc.moveDown(0.3);
  const maxWidth  = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const maxHeight = 400;
  try {
    doc.image(buffer, { fit: [maxWidth, maxHeight], align: 'center' });
    doc.moveDown(0.3);
  } catch (err) {
    doc.font(FONT.meta.name).fillColor('red')
       .text(`  (image could not be embedded: ${err.message})`);
  }
}

// ── Attachment → PDF buffer ─────────────────────────────────────────────────

async function renderAttachmentBuffer(att, deps) {
  if (!isFilled(att.content)) {
    return placeholderBuffer(att, 'Attachment had no decoded bytes.');
  }
  const buf = Buffer.from(att.content, 'base64');
  if (buf.length === 0) {
    return placeholderBuffer(att, 'Attachment decoded to 0 bytes.');
  }

  const kind = attachmentRenderer(att.contentType);
  switch (kind) {
    case 'passthrough':
      // Already a PDF — pass through byte-for-byte. Preserves signatures,
      // embedded fonts, form fields — anything a re-render would drop.
      return buf;

    case 'docx':
      return renderDocxBuffer(buf, att, deps);

    case 'xlsx':
      return renderXlsxBuffer(buf, att, deps);

    case 'text':
      return renderTextBuffer(buf, att);

    default:
      return placeholderBuffer(att,
        'This attachment format cannot be rendered as a readable PDF. '
        + 'The binary payload is preserved in the source XML (base64).');
  }
}

async function renderDocxBuffer(buf, att, { mammoth, htmlToText }) {
  let text;
  try {
    const result = await mammoth.convertToHtml({ buffer: buf });
    text = toReadableText(result.value, { htmlToText });
  } catch {
    const raw = await mammoth.extractRawText({ buffer: buf });
    text = raw.value;
  }
  return writeTextBuffer(att, text || '(empty document)', 'Word document');
}

async function renderXlsxBuffer(buf, att, { XLSX }) {
  const wb = XLSX.read(buf, { type: 'buffer' });
  const sections = wb.SheetNames.map(name => {
    const sheet = wb.Sheets[name];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', blankrows: false });
    return { name, rows };
  });
  return writeWorkbookBuffer(att, sections);
}

async function renderTextBuffer(buf, att) {
  let text = buf.toString('utf8');
  if (text.includes('\uFFFD')) text = buf.toString('latin1');
  return writeTextBuffer(att, text, 'Text');
}

async function writeTextBuffer(att, text, kindLabel) {
  const { doc, done } = newDoc({ Title: att.filename, Author: 'OTRS extract', Subject: kindLabel });

  attachmentHeader(doc, att, kindLabel);

  doc.font(FONT.body.name).fontSize(FONT.body.size).fillColor('black');
  const body = text.length > 200_000
    ? text.slice(0, 200_000) + '\n\n…[truncated at 200 KB of text]'
    : text;
  doc.text(body, { paragraphGap: 3 });

  doc.end();
  return done;
}

async function writeWorkbookBuffer(att, sections) {
  const { doc, done } = newDoc({ Title: att.filename, Author: 'OTRS extract', Subject: 'Spreadsheet' });

  attachmentHeader(doc, att, 'Spreadsheet');

  for (const [i, section] of sections.entries()) {
    if (i > 0) doc.addPage();
    doc.font(FONT.sub.name).fontSize(FONT.sub.size).text(`Sheet: ${section.name}`);
    doc.moveDown(0.3);

    if (section.rows.length === 0) {
      doc.font(FONT.meta.name).fontSize(FONT.meta.size).fillColor(FONT.meta.color)
         .text('(empty sheet)');
      continue;
    }

    const sample = section.rows.slice(0, 20);
    const colCount = sample.reduce((n, r) => Math.max(n, r.length), 0);
    const colWidths = [];
    for (let c = 0; c < colCount; c++) {
      let max = 6;
      for (const row of sample) max = Math.max(max, String(row[c] ?? '').length);
      colWidths.push(Math.min(max, 30));
    }

    doc.font(FONT.mono.name).fontSize(FONT.mono.size).fillColor('black');
    for (const row of section.rows) {
      const line = row.map((cell, c) => padCell(cell, colWidths[c] || 10)).join('  ');
      doc.text(line.length > 200 ? line.slice(0, 200) + ' …' : line, { paragraphGap: 0 });
    }
  }

  doc.end();
  return done;
}

function padCell(value, width) {
  const s = String(value ?? '');
  if (s.length >= width) return s.slice(0, width - 1) + '…';
  return s.padEnd(width, ' ');
}

async function placeholderBuffer(att, reason) {
  const { doc, done } = newDoc({ Title: att.filename || '(attachment)', Subject: 'Attachment (not renderable)' });
  attachmentHeader(doc, att, 'Attachment');
  doc.moveDown();
  doc.font(FONT.body.name).fontSize(FONT.body.size).fillColor('black')
     .text(reason || 'This attachment cannot be previewed.');
  doc.end();
  return done;
}

function attachmentHeader(doc, att, kindLabel) {
  doc.font(FONT.title.name).fontSize(FONT.title.size).fillColor('black')
     .text(att.filename || '(unnamed attachment)');
  doc.moveDown(0.2);
  doc.font(FONT.meta.name).fontSize(FONT.meta.size).fillColor(FONT.meta.color)
     .text(`${kindLabel} · ${att.contentType || 'unknown'} · ${humanSize(att.filesizeBytes)}`);
  if (isFilled(att.disposition)) doc.text(`Disposition: ${att.disposition}`);
  if (isFilled(att.contentId))   doc.text(`Content-ID: ${att.contentId}`);
  doc.moveDown(0.6);
}

// ── pdfkit → Buffer helper ─────────────────────────────────────────────────

/**
 * Create a new PDFDocument wired up to collect all emitted chunks into a
 * single Buffer. Returns the doc to write into plus a Promise that
 * resolves when `.end()` is called and the final buffer is ready.
 *
 * Using this instead of a file stream means the renderer works the same
 * way inside an Azure Function (no writable filesystem for the response)
 * as it does locally.
 */
function newDoc(info) {
  const doc = new PDFDocument({ ...PAGE, info });
  const chunks = [];
  doc.on('data', c => chunks.push(c));
  const done = new Promise((resolve, reject) => {
    doc.on('end',   () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  return { doc, done };
}
