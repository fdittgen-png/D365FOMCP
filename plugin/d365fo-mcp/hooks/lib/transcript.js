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

/** `Request:` / `Entities:` protocol lines Claude declared, and the text without them. */
export function parseProtocolLines(text) {
  let request = null;
  let entities = null;
  const rest = [];
  for (const line of String(text ?? '').split('\n')) {
    const m = /^\s*(?:[-*>]\s*)?\*{0,2}(Request|Entities)\*{0,2}\s*:\s*\*{0,2}(.+?)\*{0,2}\s*$/i.exec(line);
    if (m && m[1].toLowerCase() === 'request' && request == null) request = m[2].trim();
    else if (m && m[1].toLowerCase() === 'entities' && entities == null) entities = m[2].trim();
    else rest.push(line);
  }
  return { request, entities, rest: rest.join('\n').trim() };
}

/** First paragraph of a text (≤ `max` chars), for interpretation / step lines. */
export function firstParagraph(text, max) {
  const para = String(text ?? '').split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim()).find((p) => p.length > 0) || '';
  return para.length > max ? para.slice(0, max) : para;
}
