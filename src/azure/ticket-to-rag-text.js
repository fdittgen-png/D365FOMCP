/**
 * Build a plain-text representation of a parsed OTRS ticket, shaped for
 * downstream RAG chunking + embedding.
 *
 * Produced content is deterministic and human-readable — the RAG
 * chunker treats `\n\n` as a paragraph boundary, so keeping section
 * headers + blank lines gives the chunker natural cut points. All
 * empty fields (including every unfilled dynamic field) are omitted so
 * the indexed text stays on-topic.
 *
 * The output is ASCII-safe; sanitizeForPdfText is reused so tabs,
 * smart quotes, NBSP, bullets, etc. don't reach the embedding API as
 * garbage.
 */

import { sanitizeForPdfText, isFilled } from './ticket-pdf-helpers.js';

/**
 * @param {import('./otrs-xml-parse.js').ParsedTicket} ticket
 * @returns {string}
 */
export function ticketToRagText(ticket) {
  const lines = [];

  // ── Header ────────────────────────────────────────────────────────────
  const headline = `OTRS Ticket ${ticket.ticketNumber || ticket.ticketId}`
    + (isFilled(ticket.title) ? ` — ${ticket.title}` : '');
  lines.push(headline);
  lines.push('');

  // ── Ticket metadata (filled-only) ─────────────────────────────────────
  const metaPairs = [
    ['Service',       ticket.service],
    ['State',         ticket.state],
    ['Queue',         ticket.queue],
    ['Type',          ticket.type],
    ['Priority',      ticket.priority],
    ['Owner',         ticket.owner],
    ['Responsible',   ticket.responsible],
    ['Customer user', ticket.customerUserId],
    ['Customer',      ticket.customerId],
    ['Created',       ticket.createdAt],
    ['Changed',       ticket.changedAt],
    ['Closed',        ticket.closedAt],
  ].filter(([, v]) => isFilled(v));
  if (metaPairs.length > 0) {
    for (const [k, v] of metaPairs) lines.push(`${k}: ${v}`);
    lines.push('');
  }

  // ── Dynamic fields (filled-only) ──────────────────────────────────────
  const dyn = (ticket.dynamicFields || []).filter(f => isFilled(f.value));
  if (dyn.length > 0) {
    lines.push('Dynamic fields:');
    for (const f of dyn) lines.push(`- ${f.name}: ${f.value}`);
    lines.push('');
  }

  // ── Problem / Resolution ──────────────────────────────────────────────
  if (isFilled(ticket.description)) {
    lines.push('Problem:');
    lines.push(ticket.description.trim());
    lines.push('');
  }
  if (isFilled(ticket.resolution)) {
    lines.push('Resolution:');
    lines.push(ticket.resolution.trim());
    lines.push('');
  }

  // ── Full article trace ───────────────────────────────────────────────
  const articles = ticket.articles || [];
  if (articles.length > 0) {
    lines.push(`Articles (${articles.length}):`);
    for (const [i, a] of articles.entries()) {
      const who  = a.senderType || 'unknown';
      const when = a.createdAt ? ` · ${a.createdAt}` : '';
      const from = a.from ? ` · ${a.from}` : '';
      lines.push('');
      lines.push(`Article #${i + 1} (${who}${from}${when}):`);
      if (isFilled(a.subject)) lines.push(`Subject: ${a.subject}`);
      lines.push('');
      if (isFilled(a.body)) lines.push(a.body.trim());
      // Attachment metadata (filename/type/size) is useful signal for
      // search — the binary payload is NOT included. A chunk mentioning
      // "screenshot.png (image/png)" lets the LLM reason about presence
      // without re-embedding the pixels.
      const atts = a.attachments || [];
      if (atts.length > 0) {
        lines.push('');
        lines.push('Attachments:');
        for (const att of atts) {
          lines.push(`- ${att.filename || '(unnamed)'}`
            + ` (${att.contentType || 'unknown'}, `
            + `${att.filesizeBytes || 0} bytes, ${att.disposition || 'attachment'})`);
        }
      }
    }
  }

  return sanitizeForPdfText(lines.join('\n'));
}
