/**
 * Claude Code transcript (JSONL) reading for the trace hook. Pure functions,
 * hook-only (not part of the contract). Reads the last 4 MB first; the whole
 * file only when the last real user prompt is older than that.
 */
import { existsSync, statSync, openSync, readSync, closeSync, readFileSync } from 'node:fs';

const TAIL_BYTES = 4 * 1024 * 1024;

export function parseLines(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* partial first line of a tail read */ }
  }
  return out;
}

/** A real user prompt: typed by the user — not a tool_result, not meta, not a sidechain. */
export function isUserPrompt(rec) {
  if (!rec || rec.type !== 'user' || rec.isSidechain || rec.isMeta) return false;
  const m = rec.message;
  if (!m || m.role !== 'user') return false;
  if (typeof m.content === 'string') return m.content.length > 0;
  if (Array.isArray(m.content)) return m.content.length > 0 && m.content.every((b) => b && b.type === 'text');
  return false;
}

export function promptText(rec) {
  const c = rec?.message?.content;
  if (typeof c === 'string') return c;
  return Array.isArray(c) ? c.map((b) => b.text || '').join('\n') : '';
}

export function readTranscriptRecords(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return [];
  const size = statSync(transcriptPath).size;
  if (size > TAIL_BYTES) {
    const fd = openSync(transcriptPath, 'r');
    try {
      const buf = Buffer.alloc(TAIL_BYTES);
      readSync(fd, buf, 0, TAIL_BYTES, size - TAIL_BYTES);
      const tail = parseLines(buf.toString('utf8'));
      if (tail.some(isUserPrompt)) return tail;
    } finally {
      closeSync(fd);
    }
  }
  return parseLines(readFileSync(transcriptPath, 'utf8'));
}

/**
 * The current turn: the last real user prompt and every assistant TEXT block
 * after it, each with the uuid of its record (for consumed-tracking) and its
 * timestamp. Tool calls, tool results and thinking are excluded.
 */
export function currentTurn(records) {
  let lastPromptIdx = -1;
  for (let i = records.length - 1; i >= 0; i--) {
    if (isUserPrompt(records[i])) { lastPromptIdx = i; break; }
  }
  if (lastPromptIdx < 0) return null;
  const prompt = records[lastPromptIdx];
  const texts = [];
  for (let i = lastPromptIdx + 1; i < records.length; i++) {
    const r = records[i];
    if (r.type !== 'assistant' || r.isSidechain || !r.message) continue;
    const content = Array.isArray(r.message.content) ? r.message.content : [];
    content.forEach((b, idx) => {
      if (b.type === 'text' && b.text && b.text.trim()) {
        texts.push({ uuid: `${r.uuid || i}#${idx}`, ts: r.timestamp || null, text: b.text });
      }
    });
  }
  return { prompt_text: promptText(prompt), prompt_ts: prompt.timestamp || null, texts };
}

const PROTOCOL_LINE_RE = /^\s*(?:[-*>]\s*)?\*{0,2}(Request|Entities|Entity|Expect|Note)\*{0,2}\s*:\s*\*{0,2}(.+?)\*{0,2}\s*$/i;

/**
 * Protocol lines Claude declared, and the text without them. `Request:` /
 * `Entities:` open the investigation (first occurrence wins); `Entity:` /
 * `Expect:` / `Note:` lines (any number, anywhere in the turn) feed the
 * `annotate` record at Stop. None of them ever becomes a step or a conclusion.
 */
export function parseProtocolLines(text) {
  let request = null;
  let entities = null;
  let note = null;
  const entity = [];
  const expect = [];
  const rest = [];
  for (const line of String(text ?? '').split('\n')) {
    const m = PROTOCOL_LINE_RE.exec(line);
    if (!m) { rest.push(line); continue; }
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === 'request') { if (request == null) request = value; }
    else if (key === 'entities') { if (entities == null) entities = value; }
    else if (key === 'entity') entity.push(value);
    else if (key === 'expect') expect.push(value);
    else if (note == null) note = value;
  }
  return { request, entities, entity, expect, note, rest: rest.join('\n').trim() };
}

const ENTITY_LINE_RE = /^(\S+)\s+(\S+)\s+as\s+(source|target|related|excluded)(?:\s*=\s*(\S+))?(?:\s*~\s*([^\s:]+):(\S+))?(?:\s*@\s*(functional|logical|physical))?$/i;
const PHYSICAL_KINDS = new Set(['table', 'field', 'index', 'relation', 'edt', 'enum', 'class', 'method', 'form', 'menu_item', 'view', 'map', 'query']);

/**
 * One `Entity:` line → an annotate entity, or null when malformed.
 * Grammar: `<kind> <Name> as <source|target|related|excluded> [= <functional_entity>] [~ <erp>:<Name>] [@ <level>]`.
 * Level defaults from the kind: `data_entity` → logical, AOT kinds → physical, `functional` → functional.
 */
export function parseEntityLine(value) {
  const m = ENTITY_LINE_RE.exec(String(value ?? '').trim());
  if (!m) return null;
  const kind = m[1].toLowerCase();
  const e = { kind, name: m[2], role: m[3].toLowerCase() };
  const level = m[7] ? m[7].toLowerCase() : kind === 'data_entity' ? 'logical' : PHYSICAL_KINDS.has(kind) ? 'physical' : kind === 'functional' ? 'functional' : null;
  if (level) e.level = level;
  if (m[4]) e.functional_entity = m[4];
  if (m[5] && m[6]) e.counterpart = { erp: m[5], name: m[6] };
  return e;
}

/** First paragraph of a text (≤ `max` chars), for interpretation / step lines. */
export function firstParagraph(text, max) {
  const para = String(text ?? '').split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim()).find((p) => p.length > 0) || '';
  return para.length > max ? para.slice(0, max) : para;
}
