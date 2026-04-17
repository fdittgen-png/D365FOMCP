/**
 * Split an OtrsExtract envelope into one valid envelope per ticket.
 *
 * Power Automate's natural iteration idiom is "one file per item" — so
 * instead of the single multi-ticket envelope the PA flow gets back a
 * ZIP with `<ticketNumber>-<title>.xml` per ticket, each one a valid
 * OtrsExtract document with `count="1"`. Downstream consumers (the
 * ingestor, the PDF renderer, the RAG upload step) don't need a special
 * code path — every per-ticket envelope parses with `parseExtractXml`.
 *
 * Each output XML preserves the original envelope attributes
 * (generatedAt, mode) so provenance is obvious from the file alone.
 */

import { parseExtractXml } from './otrs-xml-parse.js';
import { ticketsToXml } from './otrs-xml.js';
import { ticketPdfBaseName } from './ticket-pdf-helpers.js';

/**
 * @param {string} xml - the OtrsExtract document
 * @returns {Array<{filename:string, buffer:Buffer, ticketId:string, ticketNumber:string, title:string}>}
 *   One entry per ticket. Empty array when the envelope has no tickets.
 */
export function splitExtractPerTicket(xml) {
  const parsed = parseExtractXml(xml);
  if (parsed.tickets.length === 0) return [];

  // Disambiguate identical filenames — two tickets might have the same
  // number (rare) or identical titles (e.g. auto-created alerts). The
  // ticketId is the stable disambiguator.
  const seen = new Map(); // baseName → count
  const out = [];

  for (const ticket of parsed.tickets) {
    let baseName = ticketPdfBaseName(ticket);
    const count = seen.get(baseName) || 0;
    seen.set(baseName, count + 1);
    if (count > 0) {
      baseName = `${baseName}-${ticket.ticketId || count}`;
    }

    // Each per-ticket envelope keeps the original generatedAt/mode so
    // provenance travels with the file.
    const perTicketXml = ticketsToXml([ticket], {
      mode: parsed.mode,
      generatedAt: parsed.generatedAt || undefined,
    });

    out.push({
      filename: `${baseName}.xml`,
      buffer: Buffer.from(perTicketXml, 'utf8'),
      ticketId: String(ticket.ticketId ?? ''),
      ticketNumber: String(ticket.ticketNumber ?? ''),
      title: String(ticket.title ?? ''),
    });
  }

  return out;
}
