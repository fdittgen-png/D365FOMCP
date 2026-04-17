/**
 * OTRS extract → XML serializer.
 *
 * Produces the envelope Power Automate will forward to the wiki-ingestor
 * Function, and that the admin UI offers as a file download. The schema
 * preserves enough of the raw OTRS ticket that every resolved case —
 * including HTML article bodies with `cid:` inline images, Word-doc
 * attachments, and custom dynamic fields — can be reconstructed offline.
 *
 * Shape:
 *   <?xml version="1.0" encoding="utf-8"?>
 *   <OtrsExtract generatedAt="…" mode="…" count="…" skippedCount="…">
 *     <Ticket id="…" number="…" title="…" queue="…" queueId="…"
 *             service="…" serviceId="…" state="…" stateId="…"
 *             priority="…" priorityId="…" type="…" owner="…" responsible="…"
 *             customerUserId="…" customerId="…" sla="…" age="…"
 *             createdAt="…" changedAt="…" closedAt="…">
 *       <Description><![CDATA[…first customer article body…]]></Description>
 *       <Resolution><![CDATA[…agent bodies joined…]]></Resolution>
 *       <DynamicFields>
 *         <Field name="…" value="…"/>
 *       </DynamicFields>
 *       <Articles count="…">
 *         <Article id="…" number="…" sender="…" senderTypeId="…"
 *                  from="…" to="…" cc="…" bcc="…" subject="…"
 *                  messageId="…" references="…" inReplyTo="…"
 *                  communicationChannel="…" communicationChannelId="…"
 *                  isVisibleForCustomer="…"
 *                  contentType="…" mimeType="…" charset="…"
 *                  createdAt="…" changedAt="…">
 *           <Body><![CDATA[… verbatim body, may be text/plain or text/html …]]></Body>
 *           <Attachments count="…">
 *             <Attachment id="…" filename="…" contentType="…"
 *                         contentAlternative="…" contentId="…"
 *                         disposition="…" filesizeBytes="…">
 *               <Content encoding="base64"><![CDATA[…base64…]]></Content>
 *             </Attachment>
 *           </Attachments>
 *         </Article>
 *       </Articles>
 *     </Ticket>
 *     <Skipped>
 *       <Ticket id="…" reason="…"/>
 *     </Skipped>
 *   </OtrsExtract>
 *
 * CDATA safety: base64 content is safe (its alphabet [A-Za-z0-9+/=] has
 * no XML metacharacters). Article bodies are escaped for the single
 * forbidden sequence `]]>` by splitting into two adjacent CDATA sections
 * (the `cdataSafe` helper below).
 */

import { XMLBuilder } from 'fast-xml-parser';

/**
 * @param {Array<ExtractedTicket>} tickets
 * @param {object} [opts]
 * @param {string} [opts.mode='incremental']
 * @param {string} [opts.generatedAt]
 * @param {Array<{ticketId:string, reason:string}>} [opts.skipped]
 * @returns {string}
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
    '@_id':             str(t.ticketId),
    '@_number':         str(t.ticketNumber),
    '@_title':          str(t.title),
    '@_queue':          str(t.queue),
    '@_queueId':        str(t.queueId),
    '@_service':        str(t.service),
    '@_serviceId':      str(t.serviceId),
    '@_state':          str(t.state),
    '@_stateId':        str(t.stateId),
    '@_priority':       str(t.priority),
    '@_priorityId':     str(t.priorityId),
    '@_type':           str(t.type),
    '@_owner':          str(t.owner),
    '@_responsible':    str(t.responsible),
    '@_customerUserId': str(t.customerUserId),
    '@_customerId':     str(t.customerId),
    '@_sla':            str(t.sla),
    '@_age':            str(t.age),
    '@_createdAt':      str(t.createdAt),
    '@_changedAt':      str(t.changedAt),
    '@_closedAt':       str(t.closedAt),
    Description: { __cdata: cdataSafe(t.description) },
    Resolution:  { __cdata: cdataSafe(t.resolution) },
  };

  if (Array.isArray(t.dynamicFields) && t.dynamicFields.length > 0) {
    node.DynamicFields = {
      Field: t.dynamicFields.map(f => ({
        '@_name':  str(f.name),
        '@_value': str(f.value),
      })),
    };
  }

  if (Array.isArray(t.articles) && t.articles.length > 0) {
    node.Articles = {
      '@_count': String(t.articles.length),
      Article: t.articles.map(toArticleNode),
    };
  }

  return node;
}

function toArticleNode(a) {
  const node = {
    '@_id':                     str(a.id),
    '@_number':                 str(a.number),
    '@_sender':                 str(a.senderType),
    '@_senderTypeId':           str(a.senderTypeId),
    '@_from':                   str(a.from),
    '@_to':                     str(a.to),
    '@_cc':                     str(a.cc),
    '@_bcc':                    str(a.bcc),
    '@_subject':                str(a.subject),
    '@_messageId':              str(a.messageId),
    '@_references':             str(a.references),
    '@_inReplyTo':              str(a.inReplyTo),
    '@_communicationChannel':   str(a.communicationChannel),
    '@_communicationChannelId': str(a.communicationChannelId),
    '@_isVisibleForCustomer':   str(a.isVisibleForCustomer),
    '@_contentType':            str(a.contentType),
    '@_mimeType':               str(a.mimeType),
    '@_charset':                str(a.charset),
    '@_createdAt':              str(a.createdAt),
    '@_changedAt':              str(a.changedAt),
    Body: { __cdata: cdataSafe(a.body) },
  };

  if (Array.isArray(a.attachments) && a.attachments.length > 0) {
    node.Attachments = {
      '@_count': String(a.attachments.length),
      Attachment: a.attachments.map(toAttachmentNode),
    };
  }

  return node;
}

function toAttachmentNode(att) {
  return {
    '@_id':                 str(att.id),
    '@_filename':           str(att.filename),
    '@_contentType':        str(att.contentType),
    '@_contentAlternative': str(att.contentAlternative),
    '@_contentId':          str(att.contentId),
    '@_disposition':        str(att.disposition),
    '@_filesizeBytes':      str(att.filesizeBytes),
    Content: {
      '@_encoding': 'base64',
      // Attachment content is already base64 — safe inside CDATA with no
      // escape needed. `cdataSafe` is a no-op for base64 alphabet but
      // we still call it in case OTRS emits empty / non-base64 bytes.
      __cdata: cdataSafe(att.content),
    },
  };
}

function str(v) {
  return v == null ? '' : String(v);
}

function cdataSafe(s) {
  if (typeof s !== 'string') return '';
  // CDATA sections cannot contain the literal ']]>'. Split any occurrence
  // so the parser sees two adjacent CDATA blocks instead of a premature
  // termination. `otrs-xml-parse.js` joins them on the way back.
  return s.replace(/]]>/g, ']]]]><![CDATA[>');
}
