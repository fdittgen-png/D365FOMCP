/**
 * D365FO client-side repro recording (reproReport XML) parser
 *
 * The "D365FO Repro Recorder" Edge extension (C:\tmp\dist) captures a user's
 * browser-side repro of a D365FO process and exports a single XML document
 * (namespace https://d365fo.repro/schema/v1) with embedded base64 screenshots.
 * It replaces the Word (.docx) export as the screenshot source for the
 * enriched Task Recorder document.
 *
 * Step vocabulary (from the extension's serializer):
 *   navigate    : formTitle, menuItem, company, url
 *   click       : label, role, href?, formTitle
 *   edit        : fieldLabel, fieldName?, controlType?, oldValue, newValue, formTitle
 *   error       : message, formTitle
 *   manual-snap : formTitle
 *   note        : text
 *   pasted-img  : (screenshot only)
 * Every step may carry an optional <note> and an <attachment> (base64 image).
 *
 * Parsing is best-effort for content shape; only a non-XML / wrong-root buffer
 * throws.
 */

import { XMLParser } from 'fast-xml-parser';

const reproParser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  attributeNamePrefix: '@_',
  trimValues: true,
  isArray: (name) => name === 'step' || name === 'tag',
});

function asArray(v) {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

/** Element text: handles plain string, {#text}, and empty/self-closing → null. */
function txt(node, key) {
  if (!node) return null;
  const v = node[key];
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'object' && !Array.isArray(v)) {
    if (v['#text'] !== undefined) return String(v['#text']);
    return null;   // present but empty (e.g. <language />)
  }
  return String(v);
}

/** Decode a step's <attachment> into a screenshot resource, or null. */
function parseAttachment(step) {
  const a = step.attachment;
  if (!a || typeof a !== 'object') return null;
  const mime = a['@_type'] || 'image/png';
  const filename = a['@_filename'] || null;
  // Inline base64 form: <attachment ... encoding="base64">B64</attachment>
  if (a['@_encoding'] === 'base64' && a['#text']) {
    let bytes;
    try { bytes = Buffer.from(String(a['#text']).replace(/\s+/g, ''), 'base64'); }
    catch { return null; }
    return { mime, filename, bytes, href: null };
  }
  // External reference form: <attachment href="..." type="image/png" />
  if (a['@_href']) return { mime, filename, bytes: null, href: a['@_href'] };
  return null;
}

/**
 * Parse a reproReport XML document (client recording).
 *
 * @param {Buffer|string} input - raw .xml bytes or text
 * @returns {{
 *   sessionId: (string|null),
 *   meta: object, environment: object, description: (string|null),
 *   steps: Array<object>,
 *   imageCount: number,
 * }}
 */
export function parseReproReport(input) {
  const text = Buffer.isBuffer(input) ? input.toString('utf8') : String(input);
  let doc;
  try {
    doc = reproParser.parse(text);
  } catch (err) {
    throw new Error(`reproReport XML could not be parsed: ${err.message}`);
  }
  const report = doc && doc.reproReport;
  if (!report) {
    throw new Error('reproReport root element missing — not a D365FO client repro recording.');
  }

  const meta = report.meta || {};
  const env = report.environment || {};

  const environment = {
    host: txt(env, 'host'),
    tenant: txt(env, 'tenant'),
    company: txt(env, 'company'),
    language: txt(env, 'language'),
    userAgent: txt(env, 'userAgent'),
    initialUrl: txt(env, 'initialUrl'),
  };

  const tags = [];
  if (meta.tags) for (const t of asArray(meta.tags.tag)) {
    const v = typeof t === 'object' ? t['#text'] : t;
    if (v) tags.push(String(v));
  }

  let imageCount = 0;
  const steps = [];
  if (report.steps) {
    for (const s of asArray(report.steps.step)) {
      const screenshot = parseAttachment(s);
      if (screenshot && screenshot.bytes) imageCount++;
      steps.push({
        index: Number(s['@_index']) || steps.length + 1,
        kind: s['@_kind'] || 'note',
        ts: s['@_ts'] || null,
        id: s['@_id'] || null,
        formTitle: txt(s, 'formTitle'),
        menuItem: txt(s, 'menuItem'),
        company: txt(s, 'company'),
        url: txt(s, 'url'),
        label: txt(s, 'label'),
        role: txt(s, 'role'),
        href: txt(s, 'href'),
        fieldLabel: txt(s, 'fieldLabel'),
        fieldName: txt(s, 'fieldName'),
        controlType: txt(s, 'controlType'),
        oldValue: txt(s, 'oldValue'),
        newValue: txt(s, 'newValue'),
        message: txt(s, 'message'),
        text: txt(s, 'text'),
        note: txt(s, 'note'),
        screenshot,
      });
    }
  }

  return {
    sessionId: report['@_sessionId'] || null,
    meta: {
      title: txt(meta, 'title'),
      severity: txt(meta, 'severity'),
      startedAt: txt(meta, 'startedAt'),
      endedAt: txt(meta, 'endedAt'),
      extensionVersion: txt(meta, 'extensionVersion'),
      tags,
    },
    environment,
    description: txt(report, 'description'),
    steps,
    imageCount,
  };
}
