/**
 * D365FO Task Recorder — Word (.docx) screenshot extractor
 *
 * A Task Recorder "business process" export is an Open-XML Word document:
 *   word/document.xml             — title + numbered step paragraphs
 *   word/_rels/document.xml.rels  — relationship id -> media target
 *   word/media/imageN.<ext>       — the embedded screenshots
 *
 * This module pulls the ordered steps and their embedded screenshots out of a
 * .docx buffer so the document builder can pair each Word step (by document
 * order) with the matching Task Recorder action. Mirrors the Word-handling
 * section of the reference Map-TaskRecording.ps1 script.
 *
 * Parsing is best-effort and non-throwing for content shape: a text-only
 * export (no screenshots) yields steps with empty `images` arrays rather than
 * an error. Only a structurally invalid ZIP / missing document.xml throws.
 */

import { XMLParser } from 'fast-xml-parser';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const AdmZip = require('adm-zip');

// removeNSPrefix collapses w:/a:/r: prefixes so we match on local names
// (p, pPr, numPr, pStyle, t, blip, Relationship, …) regardless of namespace.
const docxParser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  attributeNamePrefix: '@_',
  trimValues: false,   // keep run text exactly; we trim per-step later
});

const EXT_MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  tiff: 'image/tiff',
  tif: 'image/tiff',
  emf: 'image/emf',
  wmf: 'image/wmf',
  svg: 'image/svg+xml',
};

function mimeForName(name) {
  const dot = name.lastIndexOf('.');
  const ext = dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
  return EXT_MIME[ext] || 'application/octet-stream';
}

function asArray(v) {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

/**
 * Recursively collect every value stored under `key` anywhere inside `obj`.
 * fast-xml-parser groups children by tag name, so a paragraph's runs/blips can
 * be nested several levels deep (p > r > t, p > r > drawing > … > blip). A deep
 * walk is the namespace-agnostic equivalent of the PowerShell `.//t` XPath.
 */
function deepCollect(obj, key, out = []) {
  if (Array.isArray(obj)) {
    for (const item of obj) deepCollect(item, key, out);
    return out;
  }
  if (obj && typeof obj === 'object') {
    for (const k of Object.keys(obj)) {
      if (k === key) {
        for (const v of asArray(obj[k])) out.push(v);
      }
      deepCollect(obj[k], key, out);
    }
  }
  return out;
}

/** Extract the concatenated text of a Word paragraph object. */
function paragraphText(p) {
  const runs = deepCollect(p, 't');
  let text = '';
  for (const t of runs) {
    if (t === null || t === undefined) continue;
    if (typeof t === 'object') {
      if (t['#text'] !== undefined) text += String(t['#text']);
    } else {
      text += String(t);
    }
  }
  return text.trim();
}

/** True when the paragraph is a numbered/bulleted list item (i.e. a step). */
function isListParagraph(p) {
  if (deepCollect(p, 'numPr').length > 0) return true;
  for (const ps of deepCollect(p, 'pStyle')) {
    const val = ps && typeof ps === 'object' ? ps['@_val'] : null;
    if (val === 'ListParagraph') return true;
  }
  return false;
}

/** Relationship ids (r:embed) of every image referenced in a paragraph. */
function paragraphEmbedIds(p) {
  const ids = [];
  for (const blip of deepCollect(p, 'blip')) {
    const id = blip && typeof blip === 'object' ? blip['@_embed'] : null;
    if (id) ids.push(id);
  }
  return ids;
}

/**
 * Parse a .docx buffer into its title + ordered step list with screenshots.
 *
 * @param {Buffer} buffer - raw .docx bytes
 * @returns {{
 *   title: (string|null),
 *   steps: Array<{ text: string, images: Array<{ name: string, mime: string, bytes: Buffer }> }>,
 *   imageCount: number
 * }}
 */
export function parseDocxScreenshots(buffer) {
  const zip = new AdmZip(buffer);
  const entryMap = {};
  for (const entry of zip.getEntries()) entryMap[entry.entryName.replace(/\\/g, '/')] = entry;

  const docEntry = entryMap['word/document.xml'];
  if (!docEntry) {
    throw new Error('word/document.xml not found inside the archive. This is not a valid .docx file.');
  }

  // ── relId -> media bytes ────────────────────────────────────────────────
  const relMedia = {};   // relId -> { name, mime, bytes }
  const relsEntry = entryMap['word/_rels/document.xml.rels'];
  if (relsEntry) {
    try {
      const relsDoc = docxParser.parse(zip.readAsText(relsEntry, 'utf8'));
      for (const rel of asArray(relsDoc?.Relationships?.Relationship)) {
        const id = rel?.['@_Id'];
        const target = rel?.['@_Target'];
        if (!id || !target || !/media\//.test(target)) continue;
        // Targets are relative to word/ (e.g. "media/image1.png").
        const normalized = String(target).replace(/^\.?\//, '').replace(/\\/g, '/');
        const mediaPath = normalized.startsWith('media/') ? `word/${normalized}` : `word/${normalized}`;
        const mediaEntry = entryMap[mediaPath] || entryMap[normalized];
        if (!mediaEntry) continue;
        const name = mediaPath.split('/').pop();
        relMedia[id] = { name, mime: mimeForName(name), bytes: mediaEntry.getData() };
      }
    } catch { /* relationships are best-effort — a missing/garbled rels file just means no images */ }
  }

  // ── ordered paragraphs -> title + steps ─────────────────────────────────
  const doc = docxParser.parse(zip.readAsText(docEntry, 'utf8'));
  const body = doc?.document?.body;
  const paragraphs = asArray(body?.p);

  let title = null;
  const steps = [];
  let imageCount = 0;

  for (const p of paragraphs) {
    const text = paragraphText(p);
    const list = isListParagraph(p);
    const images = [];
    for (const id of paragraphEmbedIds(p)) {
      if (relMedia[id]) { images.push(relMedia[id]); imageCount++; }
    }

    if (list && text) {
      steps.push({ text, images });
    } else if (!title && text && !list) {
      title = text;   // first non-list, non-empty paragraph = document title
    } else if (images.length && steps.length) {
      // A screenshot living in its own (non-list) paragraph belongs to the
      // step it follows — attach it to the most recent step.
      steps[steps.length - 1].images.push(...images);
    }
  }

  return { title, steps, imageCount };
}
