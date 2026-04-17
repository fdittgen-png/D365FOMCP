/**
 * Ticket → wiki page markdown.
 *
 * Renders a parsed OTRS ticket into the YAML-frontmatter + body format the
 * wiki MCP reads. Pure function, no I/O. The output shape is what the
 * Karpathy-style LLM wiki expects: scannable frontmatter, H1 title, clear
 * Problem / Resolution sections, and (optional) full article trace for
 * cases where the ingestor wants to preserve every message.
 *
 * Slug policy: `<ticketId>`. OTRS TicketIDs are integers, already
 * URL-safe. Ticket numbers (the human-facing ones) can be long and
 * contain dots; using the internal ID as the slug keeps filenames short
 * and stable under renames.
 */

/**
 * @param {import('./otrs-xml-parse.js').ParsedTicket} ticket
 * @param {object} [opts]
 * @param {boolean} [opts.includeArticles=true] - include the full article trace section
 * @returns {{slug:string, markdown:string, frontmatter:Record<string,unknown>}}
 */
export function ticketToMarkdown(ticket, { includeArticles = true } = {}) {
  if (!ticket || !ticket.ticketId) {
    throw new Error('ticketToMarkdown requires a ticket with ticketId.');
  }

  const slug = slugFor(ticket);
  const title = ticket.title || `Ticket ${ticket.ticketNumber || ticket.ticketId}`;

  const frontmatter = {
    title,
    ticketId: ticket.ticketId,
    ticketNumber: ticket.ticketNumber || null,
    service: ticket.service || null,
    queue: ticket.queue || null,
    priority: ticket.priority || null,
    closedAt: ticket.closedAt || null,
    tags: deriveTags(ticket),
    summary: ticket.description
      ? ticket.description.replace(/\s+/g, ' ').trim().slice(0, 160)
      : null,
  };

  const lines = [];
  lines.push(renderFrontmatter(frontmatter));
  lines.push('');
  lines.push(`# ${title}`);
  lines.push('');
  lines.push(`> **Ticket** ${ticket.ticketNumber || ticket.ticketId}${ticket.closedAt ? ` — closed ${ticket.closedAt}` : ''}`);
  if (ticket.service) lines.push(`> **Service** ${ticket.service}`);
  if (ticket.queue)   lines.push(`> **Queue** ${ticket.queue}`);
  if (ticket.priority) lines.push(`> **Priority** ${ticket.priority}`);
  lines.push('');

  if (ticket.description) {
    lines.push('## Problem');
    lines.push('');
    lines.push(ticket.description.trim());
    lines.push('');
  }

  if (ticket.resolution) {
    lines.push('## Resolution');
    lines.push('');
    lines.push(ticket.resolution.trim());
    lines.push('');
  }

  // Aggregated attachment table — filename / type / size / disposition /
  // where it appears. Base64 content is intentionally NOT inlined; the
  // wiki page would balloon for any ticket with a screenshot. The XML
  // export remains the source-of-truth for raw bytes.
  const allAttachments = [];
  for (const a of (ticket.articles || [])) {
    for (const att of (a.attachments || [])) {
      allAttachments.push({ ...att, articleId: a.id, articleNumber: a.number });
    }
  }
  if (allAttachments.length > 0) {
    lines.push(`## Attachments (${allAttachments.length})`);
    lines.push('');
    lines.push('| # | Filename | Type | Size | Disposition | Article |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const att of allAttachments) {
      lines.push(
        `| ${att.id || ''} | ${mdEscape(att.filename)} | ${mdEscape(att.contentType)} | `
        + `${humanSize(att.filesizeBytes)} | ${mdEscape(att.disposition)} | `
        + `${att.articleNumber ? '#' + att.articleNumber : att.articleId || ''} |`,
      );
    }
    lines.push('');
    lines.push(
      '> _Raw bytes are preserved in the source XML (`<Attachment><Content encoding="base64">…`), '
      + 'not embedded here to keep the wiki page lean._',
    );
    lines.push('');
  }

  if (Array.isArray(ticket.dynamicFields) && ticket.dynamicFields.length > 0) {
    lines.push('## Dynamic fields');
    lines.push('');
    lines.push('| Name | Value |');
    lines.push('| --- | --- |');
    for (const f of ticket.dynamicFields) {
      if (!f.value) continue;
      lines.push(`| ${mdEscape(f.name)} | ${mdEscape(f.value)} |`);
    }
    lines.push('');
  }

  if (includeArticles && Array.isArray(ticket.articles) && ticket.articles.length > 0) {
    lines.push('## Full article trace');
    lines.push('');
    for (const a of ticket.articles) {
      const who  = a.senderType || 'unknown';
      const when = a.createdAt ? ` · ${a.createdAt}` : '';
      const from = a.from ? ` · ${a.from}` : '';
      lines.push(`### ${who}${from}${when}`);
      if (a.subject) lines.push(`_Subject:_ ${a.subject}`);
      if (a.contentType && a.contentType !== 'text/plain') {
        lines.push(`_Content-Type:_ ${a.contentType}`);
      }
      lines.push('');
      lines.push((a.body || '').trim());
      lines.push('');
      const atts = a.attachments || [];
      if (atts.length > 0) {
        lines.push(`_Attachments on this article:_ ${atts.map(x => x.filename || '(unnamed)').join(', ')}`);
        lines.push('');
      }
    }
  }

  return { slug, markdown: lines.join('\n'), frontmatter };
}

function humanSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

function mdEscape(s) {
  return String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/**
 * Slug for the page blob. Ticket ID is numeric in OTRS so this is just
 * `String(ticketId)` — but we defensive-strip any path-traversal characters
 * a pathological input could carry.
 */
export function slugFor(ticket) {
  const raw = String(ticket.ticketId || '').trim();
  return raw.replace(/[^A-Za-z0-9_-]/g, '');
}

/**
 * Derive tags from the ticket's title + description. We tokenize into
 * alphanumeric words, lowercase, filter stopwords, keep the top-N most
 * frequent. Good enough for `wiki_search` to boost pages on any of the
 * key domain terms without needing manual curation.
 */
function deriveTags(ticket, { maxTags = 8 } = {}) {
  const text = `${ticket.title || ''} ${ticket.description || ''}`;
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 4 && !STOPWORDS.has(t));

  const freq = new Map();
  for (const t of tokens) freq.set(t, (freq.get(t) || 0) + 1);

  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxTags)
    .map(([t]) => t);
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'when', 'from', 'that', 'this', 'have', 'been',
  'not', 'but', 'are', 'was', 'were', 'will', 'would', 'could', 'should',
  'there', 'their', 'they', 'them', 'what', 'which', 'than', 'then', 'into',
  'also', 'only', 'any', 'all', 'some', 'one', 'two', 'three',
  'error', 'issue', 'problem', 'system', 'user', 'client',
]);

function renderFrontmatter(fm) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(fm)) {
    if (v == null) continue;
    if (Array.isArray(v)) {
      if (v.length === 0) continue;
      lines.push(`${k}: [${v.map(x => quoteIfNeeded(String(x))).join(', ')}]`);
    } else if (typeof v === 'boolean' || typeof v === 'number') {
      lines.push(`${k}: ${v}`);
    } else {
      lines.push(`${k}: ${quoteIfNeeded(String(v))}`);
    }
  }
  lines.push('---');
  return lines.join('\n');
}

function quoteIfNeeded(s) {
  // Quote if the value could confuse the minimal frontmatter parser in
  // wiki-storage.js. Also quote anything that starts with a digit so a
  // numeric-looking string (e.g. the ticketId "1721474") survives the
  // round-trip as a string instead of being coerced to a number.
  if (/^\d/.test(s)) return `"${s.replace(/"/g, '\\"')}"`;
  if (/^[A-Za-z_\-. /@][A-Za-z0-9_\-. /@]*$/.test(s)) return s;
  return `"${s.replace(/"/g, '\\"')}"`;
}
