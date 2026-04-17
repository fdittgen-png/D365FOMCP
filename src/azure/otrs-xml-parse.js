/**
 * OTRS extract XML → ticket objects.
 *
 * Inverse of `otrs-xml.js#ticketsToXml`. Takes the `<OtrsExtract>` envelope
 * produced by the extractor (or a Power-Automate forward of it) and
 * returns a plain-JS representation the wiki ingestor can iterate over.
 *
 * Uses `fast-xml-parser` with CDATA extraction so bodies with HTML / `&` /
 * `<script>` etc. come back intact. The parser's `isArray` function pins
 * the element types that MUST always be arrays — otherwise a single
 * `<Ticket>` or `<Article>` would come back as an object, breaking
 * downstream for-of loops.
 */

import { XMLParser } from 'fast-xml-parser';

const ALWAYS_ARRAY = new Set([
  'OtrsExtract.Ticket',
  'OtrsExtract.Skipped.Ticket',
  'OtrsExtract.Ticket.Articles.Article',
]);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  cdataPropName: '__cdata',
  parseAttributeValue: false,
  trimValues: false,
  isArray: (_name, jpath) => ALWAYS_ARRAY.has(jpath),
});

/**
 * @param {string} xml - the raw OtrsExtract document (with or without XML decl)
 * @returns {ParsedExtract}
 *
 * @typedef {object} ParsedExtract
 * @property {string|null} generatedAt
 * @property {string} mode
 * @property {number} count
 * @property {number} skippedCount
 * @property {ParsedTicket[]} tickets
 * @property {ParsedSkipped[]} skipped
 *
 * @typedef {object} ParsedTicket
 * @property {string} ticketId
 * @property {string} ticketNumber
 * @property {string} title
 * @property {string} queue
 * @property {string} service
 * @property {string} priority
 * @property {string} closedAt
 * @property {string} description
 * @property {string} resolution
 * @property {ParsedArticle[]} articles
 *
 * @typedef {object} ParsedArticle
 * @property {string} senderType
 * @property {string} from
 * @property {string} createdAt
 * @property {string} body
 *
 * @typedef {object} ParsedSkipped
 * @property {string} ticketId
 * @property {string} reason
 */
export function parseExtractXml(xml) {
  if (typeof xml !== 'string' || xml.trim().length === 0) {
    throw new Error('parseExtractXml requires a non-empty XML string.');
  }

  const parsed = parser.parse(xml);
  const root = parsed?.OtrsExtract;
  if (!root) throw new Error('XML does not contain an <OtrsExtract> root element.');

  const ticketsRaw = Array.isArray(root.Ticket) ? root.Ticket : (root.Ticket ? [root.Ticket] : []);
  const skippedRaw = root.Skipped?.Ticket
    ? (Array.isArray(root.Skipped.Ticket) ? root.Skipped.Ticket : [root.Skipped.Ticket])
    : [];

  return {
    generatedAt: str(root['@_generatedAt']) || null,
    mode: str(root['@_mode']) || 'incremental',
    count: toInt(root['@_count'], ticketsRaw.length),
    skippedCount: toInt(root['@_skippedCount'], skippedRaw.length),
    tickets: ticketsRaw.map(toTicket),
    skipped: skippedRaw.map(toSkipped),
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function toTicket(node) {
  const articlesRaw = node?.Articles?.Article;
  const articles = Array.isArray(articlesRaw)
    ? articlesRaw.map(toArticle)
    : articlesRaw
      ? [toArticle(articlesRaw)]
      : [];
  return {
    ticketId:     str(node['@_id']),
    ticketNumber: str(node['@_number']),
    title:        str(node['@_title']),
    queue:        str(node['@_queue']),
    service:      str(node['@_service']),
    priority:     str(node['@_priority']),
    closedAt:     str(node['@_closedAt']),
    description:  cdataOrText(node.Description),
    resolution:   cdataOrText(node.Resolution),
    articles,
  };
}

function toArticle(node) {
  return {
    senderType: str(node['@_sender']),
    from:       str(node['@_from']),
    createdAt:  str(node['@_createdAt']),
    body:       cdataOrText(node),
  };
}

function toSkipped(node) {
  return {
    ticketId: str(node['@_id']),
    reason:   str(node['@_reason']),
  };
}

/**
 * fast-xml-parser returns an element's value differently depending on
 * whether it has CDATA, attributes, plain text, or multiple adjacent
 * CDATA sections (which the serializer produces when escaping the
 * forbidden `]]>` sequence — see otrs-xml.js `cdataSafe`). This helper
 * normalizes every case to the concatenated string value.
 *
 * The joined segments are intentionally not re-trimmed between pieces —
 * the split can happen in the middle of a word, and trimming would
 * destroy data. We only trim the outer edges.
 */
function cdataOrText(node) {
  if (node == null) return '';
  if (typeof node === 'string') return node.trim();
  if (node.__cdata !== undefined) {
    if (Array.isArray(node.__cdata)) return node.__cdata.map(s => String(s ?? '')).join('').trim();
    return String(node.__cdata).trim();
  }
  if (typeof node['#text'] === 'string') return node['#text'].trim();
  return '';
}

function str(v) {
  return v == null ? '' : String(v);
}

function toInt(v, fallback) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}
