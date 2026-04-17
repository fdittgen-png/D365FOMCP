/**
 * OTRS extract orchestration — pure function, no Azure Functions host,
 * no env reads, no blob I/O. Takes config + current state + an injectable
 * fetch; returns the extracted batch and the list of skipped tickets.
 *
 * The HTTP wrapper in `src/functions/otrs-extract.js` is responsible for
 * parsing the request body, reading the state blob, calling this, then
 * persisting the new state and serializing to XML. Splitting the two lets
 * the tests cover the orchestration without depending on `@azure/functions`.
 */

import { searchTickets, getTicket, validateTicket } from './otrs-client.js';

/**
 * @param {object} opts
 * @param {'incremental'|'full'|'preview'} [opts.mode='incremental']
 * @param {number|null} [opts.limit=null]
 * @param {object} opts.cfg - output of readOtrsConfig()
 * @param {{processedTicketIds:string[]}} opts.state - output of readState()
 * @param {typeof fetch} [opts.fetch]
 * @param {(msg:string)=>void} [opts.log]
 * @returns {Promise<{candidateIds:string[], extracted:object[], skipped:{ticketId:string, reason:string}[]}>}
 */
export async function runExtract({
  mode = 'incremental',
  limit = null,
  cfg,
  state,
  fetch = globalThis.fetch,
  log = () => {},
}) {
  const knownIds = new Set((state?.processedTicketIds) || []);

  const allIds = await searchTickets({ cfg, fetch });
  log(`TicketSearch → ${allIds.length} candidate IDs`);

  let candidateIds = mode === 'full' ? allIds : allIds.filter(id => !knownIds.has(id));
  if (limit != null && candidateIds.length > limit) {
    candidateIds = candidateIds.slice(0, limit);
  }

  const extracted = [];
  const skipped = [];

  for (const ticketId of candidateIds) {
    try {
      const raw = await getTicket(ticketId, { cfg, fetch });
      const v = validateTicket(raw, { minResolutionChars: cfg.minResolutionChars });
      if (!v.ok) {
        skipped.push({ ticketId, reason: v.reason });
        continue;
      }
      extracted.push(toExtractedTicket(ticketId, raw, v));
    } catch (err) {
      log(`ticket ${ticketId} failed — ${err.message}`);
      skipped.push({ ticketId, reason: `fetch error: ${err.message}` });
    }
  }

  return { candidateIds, extracted, skipped };
}

/**
 * Flatten a raw OTRS ticket (optionally with a validation result) into the
 * shape `ticketsToXml` expects. Captures the full envelope including every
 * article field, attachments (as base64), and dynamic fields — so the
 * downstream wiki can preserve inline screenshots, Word attachments, HTML
 * bodies with `cid:` references, etc.
 *
 * `v` is optional. When absent (single-ticket export path), description
 * and resolution are computed from the article stream using the same rules
 * `validateTicket` uses — without the quality thresholds, so every ticket
 * is mappable.
 *
 * Returns the richer ExtractedTicket shape — see otrs-xml.js for the XML
 * schema this maps into.
 */
export function toExtractedTicket(ticketId, raw, v = null) {
  const articles = extractArticles(raw);
  const description = v?.description ?? firstCustomerBody(articles);
  const resolution  = v?.resolution  ?? joinAgentBodies(articles);

  return {
    ticketId:       String(raw.TicketID ?? ticketId),
    ticketNumber:   String(raw.TicketNumber ?? ''),
    title:          String(raw.Title ?? ''),
    queue:          String(raw.Queue ?? ''),
    queueId:        String(raw.QueueID ?? ''),
    service:        String(raw.Service ?? ''),
    serviceId:      String(raw.ServiceID ?? ''),
    state:          String(raw.State ?? ''),
    stateId:        String(raw.StateID ?? ''),
    priority:       String(raw.Priority ?? ''),
    priorityId:     String(raw.PriorityID ?? ''),
    type:           String(raw.Type ?? ''),
    owner:          String(raw.Owner ?? ''),
    responsible:    String(raw.Responsible ?? ''),
    customerUserId: String(raw.CustomerUserID ?? ''),
    customerId:     String(raw.CustomerID ?? ''),
    sla:            String(raw.SLA ?? ''),
    age:            String(raw.Age ?? ''),
    createdAt:      String(raw.Created ?? raw.CreateTime ?? ''),
    changedAt:      String(raw.Changed ?? raw.ChangeTime ?? ''),
    closedAt:       String(raw.Closed ?? raw.Changed ?? raw.ChangeTime ?? ''),
    description,
    resolution,
    dynamicFields:  extractDynamicFields(raw),
    articles:       articles.map(mapArticle),
  };
}

function extractArticles(raw) {
  const a = raw?.Article;
  if (!a) return [];
  return Array.isArray(a) ? a : [a];
}

function extractDynamicFields(raw) {
  const d = raw?.DynamicField;
  if (!d) return [];
  const list = Array.isArray(d) ? d : [d];
  return list.map(f => ({
    name:  String(f?.Name ?? ''),
    value: f?.Value == null ? '' : String(f.Value),
  }));
}

function mapArticle(a) {
  return {
    id:                     String(a?.ArticleID ?? ''),
    number:                 String(a?.ArticleNumber ?? ''),
    senderType:             String(a?.SenderType ?? ''),
    senderTypeId:           String(a?.SenderTypeID ?? ''),
    from:                   String(a?.From ?? ''),
    to:                     String(a?.To ?? ''),
    cc:                     String(a?.Cc ?? ''),
    bcc:                    String(a?.Bcc ?? ''),
    subject:                String(a?.Subject ?? ''),
    messageId:              String(a?.MessageID ?? ''),
    references:             String(a?.References ?? ''),
    inReplyTo:              String(a?.InReplyTo ?? ''),
    communicationChannel:   String(a?.CommunicationChannel ?? ''),
    communicationChannelId: String(a?.CommunicationChannelID ?? ''),
    isVisibleForCustomer:   String(a?.IsVisibleForCustomer ?? ''),
    contentType:            String(a?.ContentType ?? ''),
    mimeType:               String(a?.MimeType ?? ''),
    charset:                String(a?.Charset ?? a?.ContentCharset ?? ''),
    createdAt:              String(a?.CreateTime ?? a?.Created ?? ''),
    changedAt:              String(a?.ChangeTime ?? ''),
    // Do NOT trim body — HTML whitespace is semantically meaningful and
    // trimming would break CDATA round-trip for signed content. Trim
    // happens only where the body is surfaced as description/resolution.
    body:                   typeof a?.Body === 'string' ? a.Body : '',
    attachments:            mapAttachments(a?.Attachment),
  };
}

function mapAttachments(atts) {
  if (!atts) return [];
  const list = Array.isArray(atts) ? atts : [atts];
  return list.map((a, idx) => ({
    id:                 String(a?.ID ?? idx + 1),
    filename:           String(a?.Filename ?? ''),
    contentType:        String(a?.ContentType ?? ''),
    contentAlternative: String(a?.ContentAlternative ?? ''),
    contentId:          String(a?.ContentID ?? ''),
    disposition:        String(a?.Disposition ?? ''),
    filesizeBytes:      toInt(a?.FilesizeRaw, 0),
    // `Content` is base64-encoded. Preserve the exact bytes — downstream
    // consumers need them to reconstruct inline images and Word docs.
    content:            typeof a?.Content === 'string' ? a.Content : '',
  }));
}

function toInt(v, def) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

function firstCustomerBody(articles) {
  const c = articles.find(a =>
    String(a?.SenderType || '').toLowerCase() === 'customer'
    && typeof a?.Body === 'string' && a.Body.trim());
  return c ? c.Body.trim() : '';
}

function joinAgentBodies(articles) {
  return articles
    .filter(a =>
      String(a?.SenderType || '').toLowerCase() === 'agent'
      && typeof a?.Body === 'string' && a.Body.trim())
    .map(a => a.Body.trim())
    .join('\n\n---\n\n');
}
