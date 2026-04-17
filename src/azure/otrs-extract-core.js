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
 * Flatten a raw OTRS ticket + validation result into the shape
 * `ticketsToXml` expects. Exported so tests can assert the mapping directly
 * without needing a full round-trip through the orchestration.
 */
export function toExtractedTicket(ticketId, raw, v) {
  return {
    ticketId:     String(raw.TicketID ?? ticketId),
    ticketNumber: String(raw.TicketNumber ?? ''),
    title:        String(raw.Title ?? ''),
    queue:        String(raw.Queue ?? ''),
    service:      String(raw.Service ?? ''),
    priority:     String(raw.Priority ?? ''),
    closedAt:     String(raw.Closed ?? raw.ChangeTime ?? raw.Changed ?? ''),
    description:  v.description,
    resolution:   v.resolution,
    articles: (v.articles || []).map(a => ({
      senderType: String(a.SenderType || ''),
      from:       String(a.From || ''),
      createdAt:  String(a.CreateTime || a.Created || ''),
      body:       typeof a.Body === 'string' ? a.Body.trim() : '',
    })),
  };
}
