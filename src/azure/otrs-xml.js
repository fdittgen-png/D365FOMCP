/**
 * OTRS extract → XML serializer.
 *
 * Produces the envelope Power Automate will forward to the wiki-ingestor
 * Function. XML (not JSON) per the user's pipeline choice — Power Automate
 * has first-class XML handling for request bodies.
 *
 * Shape:
 *   <?xml version="1.0" encoding="utf-8"?>
 *   <OtrsExtract generatedAt="…" mode="incremental" count="2" skippedCount="1">
 *     <Ticket id="…" number="…" title="…" queue="…" service="…"
 *             priority="…" closedAt="…">
 *       <Description><![CDATA[…]]></Description>
 *       <Resolution><![CDATA[…]]></Resolution>
 *       <Articles>
 *         <Article sender="customer" from="…" createdAt="…"><![CDATA[…]]></Article>
 *         <Article sender="agent"    from="…" createdAt="…"><![CDATA[…]]></Article>
 *       </Articles>
 *     </Ticket>
 *     <Skipped>
 *       <Ticket id="…" reason="agent-article body total is 80 chars, minimum 200"/>
 *     </Skipped>
 *   </OtrsExtract>
 *
 * CDATA wraps every ticket-authored body so the XML remains valid even
 * when a user pasted stack traces, HTML, or anything with `<`/`&` into the
 * ticket. The only thing CDATA cannot contain is the literal `]]>`; we
 * escape that by splitting into two adjacent CDATA sections.
 */

import { XMLBuilder } from 'fast-xml-parser';

/**
 * Serialize a list of validated tickets to the OtrsExtract XML envelope.
 *
 * @param {Array<ExtractedTicket>} tickets - output of the extractor handler.
 * @param {object} [opts]
 * @param {string} [opts.mode='incremental'] - echoed on the root element.
 * @param {string} [opts.generatedAt] - override for tests (ISO string).
 * @param {Array<{ticketId:string, reason:string}>} [opts.skipped] - tickets
 *   that failed validation or errored on fetch, reported inline so Power
 *   Automate can log them without a second round-trip.
 * @returns {string} full XML document (includes the XML declaration).
 *
 * @typedef {object} ExtractedTicket
 * @property {string} ticketId
 * @property {string} [ticketNumber]
 * @property {string} [title]
 * @property {string} [queue]
 * @property {string} [service]
 * @property {string} [priority]
 * @property {string} [closedAt]
 * @property {string} description
 * @property {string} resolution
 * @property {Array<{senderType:string, from?:string, createdAt?:string, body:string}>} [articles]
 */
export function ticketsToXml(tickets, { mode = 'incremental', generatedAt = null, skipped = [] } = {}) {
  const list = Array.isArray(tickets) ? tickets : [];
  const skippedList = Array.isArray(skipped) ? skipped : [];
  const rootNode = {
    '@_generatedAt': generatedAt || new Date().toISOString(),
    '@_mode': mode,
    '@_count': String(list.length),
    '@_skippedCount': String(skippedList.length),
    Ticket: list.map(toTicketNode),
  };
  if (skippedList.length > 0) {
    rootNode.Skipped = {
      Ticket: skippedList.map(s => ({
        '@_id': str(s.ticketId),
        '@_reason': str(s.reason),
      })),
    };
  }
  const root = { OtrsExtract: rootNode };

  const builder = new XMLBuilder({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    cdataPropName: '__cdata',
    format: true,
    indentBy: '  ',
    processEntities: true,
    suppressEmptyNode: true,
  });

  return '<?xml version="1.0" encoding="utf-8"?>\n' + builder.build(root);
}

function toTicketNode(t) {
  const node = {
    '@_id':        str(t.ticketId),
    '@_number':    str(t.ticketNumber),
    '@_title':     str(t.title),
    '@_queue':     str(t.queue),
    '@_service':   str(t.service),
    '@_priority':  str(t.priority),
    '@_closedAt':  str(t.closedAt),
    Description: { __cdata: cdataSafe(t.description) },
    Resolution:  { __cdata: cdataSafe(t.resolution) },
  };
  if (Array.isArray(t.articles) && t.articles.length > 0) {
    node.Articles = {
      Article: t.articles.map(a => ({
        '@_sender':    str(a.senderType),
        '@_from':      str(a.from),
        '@_createdAt': str(a.createdAt),
        __cdata: cdataSafe(a.body),
      })),
    };
  }
  return node;
}

function str(v) {
  return v == null ? '' : String(v);
}

function cdataSafe(s) {
  if (typeof s !== 'string') return '';
  // CDATA sections cannot contain the literal ']]>'. Split any occurrence
  // so the parser sees two adjacent CDATA blocks instead of a premature
  // termination.
  return s.replace(/]]>/g, ']]]]><![CDATA[>');
}
