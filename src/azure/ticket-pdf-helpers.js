/**
 * Pure helpers for the OTRS ticket → PDF pipeline.
 *
 * Shared by the renderer (`ticket-pdf-renderer.js`), the CLI script
 * (`scripts/ticket-xml-to-pdf.js`), and the admin HTTP route
 * (`POST /api/otrs-admin/convert-to-pdf`). Kept in `src/azure/` so it
 * ships with the Function App deployment package — a sibling module
 * outside `src/` would not.
 *
 * Every function is O(input), no I/O, no side effects.
 */

// ── Empty-value filtering ───────────────────────────────────────────────────

/**
 * A value is "filled" iff it's a non-empty string after trimming. Applies
 * uniformly to ticket attributes and dynamic fields — OTRS represents
 * "no data" as `""` consistently, so one rule is enough.
 */
export function isFilled(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * Collect the ticket's top-level attributes into a {key, value} list,
 * filtered to non-empty values only. Labels are human-readable so the
 * PDF stays presentable. Adding a new OTRS attribute? Add one entry
 * here; the PDF renderer picks it up automatically.
 */
export function collectFilledMetadata(ticket) {
  const pairs = [
    ['Ticket number', ticket.ticketNumber],
    ['State',         ticket.state],
    ['Service',       ticket.service],
    ['Queue',         ticket.queue],
    ['Type',          ticket.type],
    ['Priority',      ticket.priority],
    ['Owner',         ticket.owner],
    ['Responsible',   ticket.responsible],
    ['Customer user', ticket.customerUserId],
    ['Customer',      ticket.customerId],
    ['SLA',           ticket.sla],
    ['Age',           ticket.age],
    ['Created',       ticket.createdAt],
    ['Changed',       ticket.changedAt],
    ['Closed',        ticket.closedAt],
  ];
  return pairs
    .filter(([, v]) => isFilled(v))
    .map(([key, value]) => ({ key, value }));
}

// ── Attachment handling ─────────────────────────────────────────────────────

/**
 * Image types that pdfkit can embed natively (PNG + JPEG). GIF and WEBP
 * are deliberately excluded — pdfkit can't handle them without upstream
 * conversion, and the fallback (sibling PDF) is perfectly fine.
 */
export function isEmbeddableImage(contentType) {
  if (typeof contentType !== 'string') return false;
  const ct = contentType.toLowerCase();
  return ct.startsWith('image/png') || ct.startsWith('image/jpeg') || ct.startsWith('image/jpg');
}

/**
 * Dispatch an attachment to a renderer kind. Downstream code branches on
 * this, so keeping the mapping in one place makes it easy to extend (new
 * MIME type = one more arm in this switch + matching renderer function).
 *
 * Return values:
 *   'passthrough' — write the raw bytes as the output file (already a PDF)
 *   'docx'        — extract text via mammoth, render to a new PDF
 *   'xlsx'        — parse with SheetJS, render cells to a new PDF
 *   'text'        — UTF-8 text, monospace render
 *   'placeholder' — unknown binary format, emit a one-page metadata PDF
 */
export function attachmentRenderer(contentType) {
  const ct = (contentType || '').toLowerCase();
  if (ct.startsWith('application/pdf')) return 'passthrough';
  if (ct.includes('wordprocessingml') || ct === 'application/msword') return 'docx';
  if (ct.includes('spreadsheetml') || ct === 'application/vnd.ms-excel'
      || ct === 'text/csv') return ct === 'text/csv' ? 'text' : 'xlsx';
  if (ct.startsWith('text/')) return 'text';
  return 'placeholder';
}

// ── Filename / path safety ──────────────────────────────────────────────────

/**
 * Turn any string into something that's safe to use as a filename on
 * every platform (removes path separators, control chars, reserved
 * Windows chars, collapses whitespace). Never empty — falls back to
 * 'file' so we always have something to write to.
 */
export function safeFilename(name, { fallback = 'file', maxLength = 120 } = {}) {
  const s = String(name ?? '').trim();
  let cleaned = s
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')  // path + reserved + control
    .replace(/\s+/g, ' ')                         // collapse whitespace
    .replace(/^\.+/, '')                          // no leading dots
    .trim();
  if (cleaned.length === 0) cleaned = fallback;
  if (cleaned.length > maxLength) cleaned = cleaned.slice(0, maxLength);
  return cleaned;
}

/**
 * Build the sibling-file name for a non-image attachment:
 *   `ticket-<ticketId>-att-<index>-<original-filename>.pdf`
 * Strips any original extension and forces `.pdf`.
 */
export function siblingPdfName(ticketId, attachmentIndex, originalFilename) {
  const base = safeFilename(originalFilename || 'attachment')
    .replace(/\.[^.]{1,10}$/, '');  // drop original extension if present
  const idx = String(attachmentIndex).padStart(2, '0');
  return `ticket-${safeFilename(ticketId)}-att-${idx}-${base}.pdf`;
}

// ── HTML body → readable text ───────────────────────────────────────────────

/**
 * Convert an article body (which may be text/plain or text/html) to a
 * readable plain-text form for the PDF. When the content appears to be
 * HTML we run it through `html-to-text` (injectable so tests don't need
 * the heavy dependency). Inline-image `<img cid:...>` references are
 * replaced with a textual placeholder so the flow stays readable.
 */
export function toReadableText(body, { htmlToText } = {}) {
  if (!isFilled(body)) return '';
  const looksLikeHtml = /<\/?[a-z][\s\S]*?>/i.test(body);
  if (!looksLikeHtml) return body.replace(/\r\n/g, '\n');

  // Replace cid: image references BEFORE stripping so we retain a marker.
  const withMarkers = body.replace(
    /<img\b[^>]*\bsrc=["']cid:([^"'>]+)["'][^>]*>/gi,
    (_m, cid) => `[inline image cid:${cid}]`,
  );

  if (typeof htmlToText === 'function') {
    return htmlToText(withMarkers, {
      wordwrap: false,
      selectors: [
        { selector: 'a', options: { ignoreHref: false } },
        { selector: 'img', format: 'skip' },
      ],
    });
  }
  // Tiny fallback stripper when html-to-text isn't injected (used by tests).
  return withMarkers
    .replace(/<\/(p|div|br|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// ── Byte-size rendering ────────────────────────────────────────────────────

export function humanSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
