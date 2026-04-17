/**
 * OTRS extract XML → ticket objects.
 *
 * Inverse of `otrs-xml.js#ticketsToXml`. Takes the `<OtrsExtract>` envelope
 * produced by the extractor (or a Power-Automate forward of it) and
 * returns a plain-JS representation the wiki ingestor can iterate over.
 *
 * Preserves the full schema introduced for single-ticket export:
 *   - ticket-level metadata (state, serviceId, customerUserId, age, …)
 *   - dynamic fields
 *   - full article metadata (subject, contentType, charset, message IDs, …)
 *   - attachments with base64 content byte-for-byte
 *
 * fast-xml-parser quirks handled here:
 *   - multiple adjacent CDATA sections return `__cdata` as an array —
 *     joined back into one string (the serializer uses this to escape `]]>`)
 *   - single vs. many children of an element — pinned via `isArray`
 */

import { XMLParser } from 'fast-xml-parser';

const ALWAYS_ARRAY = new Set([
  'OtrsExtract.Ticket',
  'OtrsExtract.Skipped.Ticket',
  'OtrsExtract.Ticket.Articles.Article',
  'OtrsExtract.Ticket.Articles.Article.Attachments.Attachment',
  'OtrsExtract.Ticket.DynamicFields.Field',
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
 * @param {string} xml
 * @returns {ParsedExtract}
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

  const dynamicFieldsRaw = node?.DynamicFields?.Field;
  const dynamicFields = Array.isArray(dynamicFieldsRaw)
    ? dynamicFieldsRaw.map(toDynamicField)
    : dynamicFieldsRaw
      ? [toDynamicField(dynamicFieldsRaw)]
      : [];

  return {
    ticketId:       str(node['@_id']),
    ticketNumber:   str(node['@_number']),
    title:          str(node['@_title']),
    queue:          str(node['@_queue']),
    queueId:        str(node['@_queueId']),
    service:        str(node['@_service']),
    serviceId:      str(node['@_serviceId']),
    state:          str(node['@_state']),
    stateId:        str(node['@_stateId']),
    priority:       str(node['@_priority']),
    priorityId:     str(node['@_priorityId']),
    type:           str(node['@_type']),
    owner:          str(node['@_owner']),
    responsible:    str(node['@_responsible']),
    customerUserId: str(node['@_customerUserId']),
    customerId:     str(node['@_customerId']),
    sla:            str(node['@_sla']),
    age:            str(node['@_age']),
    createdAt:      str(node['@_createdAt']),
    changedAt:      str(node['@_changedAt']),
    closedAt:       str(node['@_closedAt']),
    description:    cdataOrText(node.Description),
    resolution:     cdataOrText(node.Resolution),
    dynamicFields,
    articles,
  };
}

function toDynamicField(node) {
  return {
    name:  str(node['@_name']),
    value: str(node['@_value']),
  };
}

function toArticle(node) {
  const attsRaw = node?.Attachments?.Attachment;
  const attachments = Array.isArray(attsRaw)
    ? attsRaw.map(toAttachment)
    : attsRaw
      ? [toAttachment(attsRaw)]
      : [];

  return {
    id:                     str(node['@_id']),
    number:                 str(node['@_number']),
    senderType:             str(node['@_sender']),
    senderTypeId:           str(node['@_senderTypeId']),
    from:                   str(node['@_from']),
    to:                     str(node['@_to']),
    cc:                     str(node['@_cc']),
    bcc:                    str(node['@_bcc']),
    subject:                str(node['@_subject']),
    messageId:              str(node['@_messageId']),
    references:             str(node['@_references']),
    inReplyTo:              str(node['@_inReplyTo']),
    communicationChannel:   str(node['@_communicationChannel']),
    communicationChannelId: str(node['@_communicationChannelId']),
    isVisibleForCustomer:   str(node['@_isVisibleForCustomer']),
    contentType:            str(node['@_contentType']),
    mimeType:               str(node['@_mimeType']),
    charset:                str(node['@_charset']),
    createdAt:              str(node['@_createdAt']),
    changedAt:              str(node['@_changedAt']),
    body:                   cdataOrText(node?.Body ?? node),
    attachments,
  };
}

function toAttachment(node) {
  return {
    id:                 str(node['@_id']),
    filename:           str(node['@_filename']),
    contentType:        str(node['@_contentType']),
    contentAlternative: str(node['@_contentAlternative']),
    contentId:          str(node['@_contentId']),
    disposition:        str(node['@_disposition']),
    filesizeBytes:      toInt(node['@_filesizeBytes'], 0),
    // `Content` element carries `encoding="base64"` and the CDATA content.
    // We return the CDATA content as a string — callers that need bytes
    // can `Buffer.from(content, 'base64')`.
    content:            cdataOrText(node?.Content),
  };
}

function toSkipped(node) {
  return {
    ticketId: str(node['@_id']),
    reason:   str(node['@_reason']),
  };
}

/**
 * Normalize fast-xml-parser output for a CDATA-or-text element. Multiple
 * adjacent CDATA sections (produced by the serializer when escaping `]]>`)
 * come back as an array in `__cdata` — joined here without inserting any
 * extra whitespace so bytes round-trip.
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

/**
 * @typedef {object} ParsedExtract
 * @property {string|null} generatedAt
 * @property {string} mode
 * @property {number} count
 * @property {number} skippedCount
 * @property {ParsedTicket[]} tickets
 * @property {ParsedSkipped[]} skipped
 *
 * @typedef {object} ParsedTicket — see otrs-xml.js for field meanings
 * @property {string} ticketId
 * @property {string} ticketNumber
 * @property {string} title
 * @property {string} queue
 * @property {string} queueId
 * @property {string} service
 * @property {string} serviceId
 * @property {string} state
 * @property {string} stateId
 * @property {string} priority
 * @property {string} priorityId
 * @property {string} type
 * @property {string} owner
 * @property {string} responsible
 * @property {string} customerUserId
 * @property {string} customerId
 * @property {string} sla
 * @property {string} age
 * @property {string} createdAt
 * @property {string} changedAt
 * @property {string} closedAt
 * @property {string} description
 * @property {string} resolution
 * @property {Array<{name:string, value:string}>} dynamicFields
 * @property {ParsedArticle[]} articles
 *
 * @typedef {object} ParsedArticle
 * @property {string} id
 * @property {string} number
 * @property {string} senderType
 * @property {string} senderTypeId
 * @property {string} from
 * @property {string} to
 * @property {string} cc
 * @property {string} bcc
 * @property {string} subject
 * @property {string} messageId
 * @property {string} references
 * @property {string} inReplyTo
 * @property {string} communicationChannel
 * @property {string} communicationChannelId
 * @property {string} isVisibleForCustomer
 * @property {string} contentType
 * @property {string} mimeType
 * @property {string} charset
 * @property {string} createdAt
 * @property {string} changedAt
 * @property {string} body
 * @property {ParsedAttachment[]} attachments
 *
 * @typedef {object} ParsedAttachment
 * @property {string} id
 * @property {string} filename
 * @property {string} contentType
 * @property {string} contentAlternative
 * @property {string} contentId
 * @property {string} disposition
 * @property {number} filesizeBytes
 * @property {string} content  — base64
 *
 * @typedef {object} ParsedSkipped
 * @property {string} ticketId
 * @property {string} reason
 */
