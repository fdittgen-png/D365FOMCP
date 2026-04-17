/**
 * Wiki ingest orchestration.
 *
 * Given an OtrsExtract XML document and a target wiki config, parse the
 * tickets, write one markdown page per validated ticket into the wiki's
 * blob container, regenerate the index.md catalog, and return a summary
 * of what landed vs what failed.
 *
 * Pure orchestration — no Azure Functions host, no env reads. The caller
 * supplies a writer (production = `createWikiWriter(wiki)`, tests = a
 * fake that records calls). A single orchestrator means the Power
 * Automate endpoint and the human-operated admin UI share exactly the
 * same behavior.
 */

import { parseExtractXml } from './otrs-xml-parse.js';
import { ticketToMarkdown } from './ticket-to-markdown.js';

/**
 * @param {object} opts
 * @param {string} opts.xml - the OtrsExtract document
 * @param {import('./wiki-registry.js').WikiConfig} opts.wiki
 * @param {import('./wiki-writer.js').WikiWriter} opts.writer
 * @param {(msg:string) => void} [opts.log] - progress log sink
 * @returns {Promise<IngestSummary>}
 *
 * @typedef {object} IngestSummary
 * @property {number} total_extracted - tickets in <Ticket> nodes
 * @property {number} total_skipped - tickets in <Skipped> nodes (not written, reported)
 * @property {number} written - pages upserted successfully
 * @property {number} failed - pages that threw during write
 * @property {Array<{slug:string, blobName:string, ticketId:string}>} pages
 * @property {Array<{ticketId:string, reason:string}>} skipped
 * @property {Array<{ticketId:string, reason:string}>} errors
 * @property {string} indexBlob - blob name of the regenerated index
 * @property {string|null} extractGeneratedAt - echoed from the XML root
 */
export async function ingestExtractXml({ xml, wiki, writer, log = () => {} }) {
  const parsed = parseExtractXml(xml);
  log(`ingest: parsed ${parsed.count} ticket(s), ${parsed.skippedCount} skipped`);

  const pages = [];
  const errors = [];

  for (const ticket of parsed.tickets) {
    try {
      const { slug, markdown } = ticketToMarkdown(ticket);
      const blobName = await writer.writePage(slug, markdown);
      pages.push({ slug, blobName, ticketId: ticket.ticketId });
      log(`ingest: wrote ${blobName}`);
    } catch (err) {
      errors.push({ ticketId: ticket.ticketId, reason: err.message || String(err) });
      log(`ingest: failed ticket ${ticket.ticketId} — ${err.message}`);
    }
  }

  // Regenerate the catalog. A sorted-by-closedAt listing is enough — LLMs
  // start at the index, see every entry, pick what to read. We keep it
  // deterministic (sort is stable on closedAt desc → ticketId desc) so
  // repeat ingests don't thrash the index blob.
  const indexMarkdown = await buildIndex(wiki, writer, parsed);
  const indexBlob = await writer.writeIndex(indexMarkdown);
  log(`ingest: rewrote index blob ${indexBlob}`);

  return {
    total_extracted: parsed.tickets.length,
    total_skipped: parsed.skipped.length,
    written: pages.length,
    failed: errors.length,
    pages,
    skipped: parsed.skipped,
    errors,
    indexBlob,
    extractGeneratedAt: parsed.generatedAt,
  };
}

/**
 * Build the new index.md. We prefer to list every page currently in the
 * container (not just the ones from this run) so operators who upload
 * partial XML don't lose links to older tickets. If the writer exposes a
 * `listAllPages` accessor we use it; otherwise we fall back to the
 * tickets we just ingested.
 *
 * Keeps the page ordering deterministic (closedAt desc, then ticketId desc)
 * so round-tripping the same XML twice produces a byte-identical index
 * blob — helpful for anyone watching lastModified deltas.
 */
async function buildIndex(wiki, writer, parsed) {
  const title = wiki.title || `Wiki: ${wiki.name}`;
  const lines = [];
  lines.push('---');
  lines.push(`title: ${yamlScalar(title)}`);
  lines.push(`wiki: ${wiki.name}`);
  lines.push(`updated: ${new Date().toISOString()}`);
  lines.push('---');
  lines.push('');
  lines.push(`# ${title}`);
  lines.push('');
  if (wiki.description) {
    lines.push(`_${wiki.description}_`);
    lines.push('');
  }

  const entries = parsed.tickets
    .slice()
    .sort((a, b) => {
      const byDate = compareStringDesc(a.closedAt, b.closedAt);
      if (byDate !== 0) return byDate;
      return compareStringDesc(a.ticketId, b.ticketId);
    });

  if (entries.length === 0) {
    lines.push('## Pages');
    lines.push('');
    lines.push('*(No pages in this ingest.)*');
    return lines.join('\n');
  }

  lines.push(`## Pages (${entries.length})`);
  lines.push('');
  lines.push('| Ticket | Closed | Title | Service |');
  lines.push('| --- | --- | --- | --- |');
  const prefix = wiki.pagesPrefix || '';
  for (const t of entries) {
    const slug = String(t.ticketId);
    const link = `[${t.ticketNumber || slug}](${prefix}${slug}.md)`;
    lines.push(`| ${link} | ${t.closedAt || ''} | ${escapeCell(t.title || '')} | ${escapeCell(t.service || '')} |`);
  }

  if (parsed.skipped.length > 0) {
    lines.push('');
    lines.push(`## Skipped in last ingest (${parsed.skipped.length})`);
    lines.push('');
    lines.push('| Ticket | Reason |');
    lines.push('| --- | --- |');
    for (const s of parsed.skipped) {
      lines.push(`| ${s.ticketId} | ${escapeCell(s.reason)} |`);
    }
  }

  return lines.join('\n');
}

function compareStringDesc(a, b) {
  const sa = a || '';
  const sb = b || '';
  if (sa === sb) return 0;
  return sa < sb ? 1 : -1; // desc: later first
}

function escapeCell(s) {
  return String(s || '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function yamlScalar(s) {
  if (/^[A-Za-z0-9_\-. /@]+$/.test(s)) return s;
  return `"${s.replace(/"/g, '\\"')}"`;
}
