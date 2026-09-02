/**
 * Shared utilities for Azure-hosted MCP servers.
 * - SQLite database singletons (better-sqlite3, read-only)
 * - Query helper with positional parameters
 * - Markdown formatting
 */

import { createRequire } from 'module';
import { z } from 'zod';
// resolve not needed — paths come from env vars or default mount path

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
import { ensureSecIndexes } from './sec-indexes.js';
import { getRequestContext } from './request-context.js';
import { entityDisplayName, mappedObjectsForEntity, suggestEntities } from './semantic-store.js';

// ── Shared tool input params ─────────────────────────────────────────────────
//
// Standard text-channel rendering switch. Add `format: formatTextParam` to a
// tool's inputSchema and pass the `format` arg STRAIGHT THROUGH as the 3rd
// argument to structuredResult — do not normalise it in the handler. Anything
// that is not the literal 'markdown' or 'toon' (including undefined, which is
// what the test mock server passes) means "adaptive", so structuredResult stays
// the single choke point (rule #13) and a handler-level default can only break
// it. structuredContent JSON is unchanged in every case.
export const formatTextParam = z
  .enum(['markdown', 'toon', 'auto'])
  .optional()
  .default('auto')
  // KEEP THIS SHORT. It is duplicated into the wire schema of all 56 tools that
  // take it, so every character costs 56x on `tools/list` — which ships on
  // EVERY request. The long-form explanation (why "auto", the per-tool
  // measurements) lives in CLAUDE.md rule #5 and the tooling skill, where it is
  // paid for once. Measured: the previous 342-character version was 16,074 B
  // (~4,019 tk) of pure duplication, roughly a quarter of the whole tool list.
  // Carries ONLY what the enum itself cannot: which value is the default, and
  // when to override it. Everything else the model reads off the value list.
  // test/tool-schema-budget.test.js fails above 4,000 B of duplication.
  .describe('auto (default) = smallest; markdown when quoting verbatim.');

// Standard per-model scope filter. Add `modules: modulesFilterParam` to a
// search tool's inputSchema to let callers limit the investigation to specific
// models/packages — e.g. only the Microsoft application, only an ISV model,
// or only a customization like iExtension. The list-modules/stats tool of each
// service shows the scanned modules together with their build versions.
export const modulesFilterParam = z
  .array(z.string().min(1).max(200))
  .min(1)
  .max(50)
  .optional()
  .describe('Optional: limit results to these modules/models (case-insensitive), e.g. ["iExtension"] or ["ApplicationSuite","ApplicationPlatform"]. Use the service\'s list-modules/stats tool to see the scanned modules and their build versions.');

/** Defensive counterpart of modulesFilterParam (rule #13 — the test mock
 *  server bypasses Zod): trims, drops non-strings/empties, dedupes, caps at 50.
 *  Returns [] when no usable filter was passed. */
export function sanitizeModulesFilter(modules) {
  if (!Array.isArray(modules)) return [];
  return [...new Set(
    modules
      .filter(m => typeof m === 'string' && m.trim().length > 0)
      .map(m => m.trim()),
  )].slice(0, 50);
}

// ── Model build provenance ───────────────────────────────────────────────────

/**
 * Read the model_versions provenance table (written by the DB builders from
 * the models' Descriptor XMLs). Returns [] when the database predates the
 * table, so callers degrade gracefully on older snapshots.
 *
 * @param {(sql:string, params?:any[])=>object[]} q  Bound query helper.
 * @param {string|null} [moduleId]  Optional: only models of this package.
 */
export function queryModelVersions(q, moduleId = null) {
  try {
    if (moduleId != null) {
      return q(
        `SELECT model_name, module_id, display_name, publisher, layer, origin, version
         FROM model_versions WHERE module_id = ? COLLATE NOCASE ORDER BY model_name`,
        [moduleId],
      );
    }
    return q(
      `SELECT model_name, module_id, display_name, publisher, layer, origin, version
       FROM model_versions ORDER BY module_id, model_name`,
    );
  } catch {
    return [];
  }
}

// ── Singleton databases ─────────────────────────────────────────────────────

let kbDb;
let xrefDb;
let secDb;

function openDb(filePath, mmapSize = 3221225472) {
  const db = new Database(filePath, { readonly: true });
  db.pragma('journal_mode = OFF');
  db.pragma(`cache_size = -50000`);   // 50 MB cache
  db.pragma(`mmap_size = ${mmapSize}`);
  db.pragma(`busy_timeout = 30000`);  // 30 s — issue #50: bound lock-contention waits
  return db;
}

export function getKbDb() {
  if (!kbDb) {
    const dbPath = process.env.KB_DB_PATH || '/home/data/d365fo_kb.sqlite';
    kbDb = openDb(dbPath, 1100000000);
  }
  return kbDb;
}

export function getXrefDb() {
  if (!xrefDb) {
    const dbPath = process.env.XREF_DB_PATH || '/home/data/d365fo_xref.sqlite';
    xrefDb = openDb(dbPath);
  }
  return xrefDb;
}

export function getSecDb() {
  if (!secDb) {
    const dbPath = process.env.SEC_DB_PATH || '/home/data/d365fo_sec.sqlite';
    // Self-healing indexes: the DB file on /home/data is only replaced by an
    // explicit upload, so a code deploy that adds indexes would otherwise never
    // reach it. CREATE INDEX IF NOT EXISTS is a no-op when present (~ms); the
    // first request after a deploy that introduced new indexes pays ~1-2 s.
    // Set SEC_AUTO_INDEX=false to disable (e.g. read-only mount).
    if (process.env.SEC_AUTO_INDEX !== 'false') {
      const r = ensureSecIndexes(dbPath, { log: (m) => console.log(m) });
      if (r.created.length) console.log(`sec DB: ${r.created.length} index(es) added in ${r.ms} ms`);
    }
    secDb = openDb(dbPath, 67108864);
  }
  return secDb;
}

/** Close and discard the sec DB singleton so the next getSecDb() opens a fresh connection. */
export function reloadSecDb() {
  if (secDb) {
    try { secDb.close(); } catch (e) { console.warn('Warning closing sec DB:', e.message); }
    secDb = null;
  }
}

/** Close and discard the KB DB singleton so the next getKbDb() reopens it.
 *  Used by the KB database upload endpoint before swapping the file on disk. */
export function reloadKbDb() {
  if (kbDb) {
    try { kbDb.close(); } catch (e) { console.warn('Warning closing KB DB:', e.message); }
    kbDb = null;
  }
}

// ── Query helper ─────────────────────────────────────────────────────────────

/**
 * Execute a parameterized query. Returns array of row objects.
 * Usage: query(db, 'SELECT * FROM tables WHERE table_name = ?', ['CustTable'])
 */
export function query(db, sql, params = []) {
  const stmt = db.prepare(sql);
  return stmt.all(...params);
}

// ── Formatting helpers ───────────────────────────────────────────────────────

/**
 * Format an array of row objects as a Markdown table.
 * @param {object[]} rows - Array of row objects
 * @param {string[]} [columns] - Optional column names to display (default: all keys from first row)
 */
export function formatMarkdownTable(rows, columns) {
  if (!rows || rows.length === 0) return 'No results found.';
  if (!columns) columns = Object.keys(rows[0]);

  const header = '| ' + columns.join(' | ') + ' |';
  const sep = '| ' + columns.map(() => '---').join(' | ') + ' |';
  const body = rows
    .map(row => '| ' + columns.map(c => row[c] == null ? '' : String(row[c])).join(' | ') + ' |')
    .join('\n');

  return `${header}\n${sep}\n${body}`;
}

export function textResult(text) {
  return { content: [{ type: 'text', text }] };
}

// ── TOON (Token-Oriented Object Notation) ────────────────────────────────────
//
// Compact tabular text for LLM input. Header declares column names once;
// rows list values comma-separated. Lossless round-trip on JSON-primitive
// cells. Used as an opt-in alternative to formatMarkdownTable on tools that
// routinely return large uniform row sets (e.g. *_raw_sql).
//
//   rows[3]{id,name,role}:
//     1,Alice,admin
//     2,Bob,user
//     3,Charlie,user
//
// Quoting rules (RFC 4180-ish): a field is wrapped in double quotes when it
// contains `,` `"` `\n` `\r` or has leading/trailing whitespace. Internal
// quotes are doubled. Numeric/boolean values are stringified as-is.

const TOON_NEEDS_QUOTE = /[",\n\r]|^\s|\s$/;

function toonField(v) {
  const s = v === null || v === undefined ? '' : String(v);
  if (s === '' || !TOON_NEEDS_QUOTE.test(s)) return s;
  return '"' + s.replace(/"/g, '""') + '"';
}

/**
 * Render rows as a TOON block. Returns 'No results found.' for empty input
 * to match formatMarkdownTable's empty-handling.
 *
 * @param {string} arrayName  Logical name (alphanumeric + underscore).
 * @param {object[]} rows
 * @param {string[]} [columns]  Explicit column order; default = keys of rows[0].
 */
export function formatToonBlock(arrayName, rows, columns) {
  if (!rows || rows.length === 0) return 'No results found.';
  const safeName = /^[A-Za-z_][A-Za-z0-9_]*$/.test(arrayName) ? arrayName : 'rows';
  if (!columns) columns = Object.keys(rows[0]);
  const header = `${safeName}[${rows.length}]{${columns.map(toonField).join(',')}}:`;
  const body = rows
    .map(r => '  ' + columns.map(c => toonField(r[c])).join(','))
    .join('\n');
  return `${header}\n${body}`;
}

/**
 * Parse a TOON block emitted by formatToonBlock. Strict about the header
 * shape; stream-decodes the body so quoted fields may contain literal
 * newlines. Returns { arrayName, count, columns, rows }. Throws on
 * malformed input.
 */
export function parseToonBlock(text) {
  if (typeof text !== 'string') throw new Error('parseToonBlock: text must be a string');
  const nl = text.indexOf('\n');
  const headerLine = (nl === -1 ? text : text.slice(0, nl)).replace(/\r$/, '');
  const m = /^([A-Za-z_][A-Za-z0-9_]*)\[(\d+)\]\{(.*)\}:\s*$/.exec(headerLine);
  if (!m) throw new Error(`parseToonBlock: malformed header "${headerLine}"`);
  const arrayName = m[1];
  const count = Number(m[2]);
  const columns = parseToonHeaderColumns(m[3]);

  const body = nl === -1 ? '' : text.slice(nl + 1).replace(/\r\n/g, '\n');
  const rows = [];
  let i = 0;
  const n = body.length;
  while (i < n) {
    if (body[i] === ' ' && body[i + 1] === ' ') i += 2;
    if (i >= n) break;
    if (body[i] === '\n') { i++; continue; }
    const fields = [];
    while (true) {
      let field = '';
      if (body[i] === '"') {
        i++;
        while (i < n) {
          if (body[i] === '"' && body[i + 1] === '"') { field += '"'; i += 2; }
          else if (body[i] === '"') { i++; break; }
          else { field += body[i]; i++; }
        }
      } else {
        while (i < n && body[i] !== ',' && body[i] !== '\n') { field += body[i]; i++; }
      }
      fields.push(field);
      if (i < n && body[i] === ',') { i++; continue; }
      break;
    }
    if (i < n && body[i] === '\n') i++;
    const obj = {};
    for (let j = 0; j < columns.length; j++) {
      obj[columns[j]] = fields[j] === undefined ? '' : fields[j];
    }
    rows.push(obj);
  }
  return { arrayName, count, columns, rows };
}

function parseToonHeaderColumns(s) {
  const out = [];
  let i = 0;
  const n = s.length;
  if (n === 0) return out;
  while (true) {
    let field = '';
    if (s[i] === '"') {
      i++;
      while (i < n) {
        if (s[i] === '"' && s[i + 1] === '"') { field += '"'; i += 2; }
        else if (s[i] === '"') { i++; break; }
        else { field += s[i]; i++; }
      }
    } else {
      while (i < n && s[i] !== ',') { field += s[i]; i++; }
    }
    out.push(field);
    if (i >= n) break;
    if (s[i] === ',') { i++; if (i === n) { out.push(''); break; } continue; }
    break;
  }
  return out;
}

// ── General TOON encoder ─────────────────────────────────────────────────────
// `formatToonBlock` handles the flat "array of uniform rows" case only.
// `encodeToon` is the GENERAL serializer used as the default text channel for
// every tool (see structuredResult): it renders an arbitrary typed object — the
// same object placed in structuredContent — into TOON so the model always reads
// a compact, uniform shape whether the payload is tabular or nested.
//
// Shapes produced (2-space indent per nesting level):
//   scalar field          key: value
//   nested object         key:
//                           child: …
//   array of primitives   key[3]: a,b,c
//   array of uniform      key[2]{c1,c2}:
//     flat objects          v1,v2
//                           v3,v4
//   mixed / nested array  key[2]:
//                           - childA: …
//                             childB: …
//                           - childA: …
// Scalar quoting reuses toonField (RFC-4180-ish); keys additionally quote on ':'.

const TOON_KEY_NEEDS_QUOTE = /[:,"\n\r]|^\s|\s$/;
function toonKey(k) {
  const s = String(k);
  return TOON_KEY_NEEDS_QUOTE.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function isToonPrimitive(v) {
  return v === null || v === undefined || typeof v !== 'object';
}

/**
 * True when `arr` is a non-empty array of plain objects that all share the same
 * key set (same keys, same order as the first element) and whose values are all
 * primitives — i.e. it renders losslessly as a TOON table.
 */
function isUniformFlatObjectArray(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return false;
  if (!arr.every(e => e && typeof e === 'object' && !Array.isArray(e))) return false;
  const cols = Object.keys(arr[0]);
  if (cols.length === 0) return false;
  return arr.every(e => {
    const k = Object.keys(e);
    return k.length === cols.length
      && cols.every((c, i) => k[i] === c)
      && cols.every(c => isToonPrimitive(e[c]));
  });
}

function encodeToonArray(lines, key, arr, depth) {
  const pad = '  '.repeat(depth);
  const n = arr.length;
  if (n === 0) { lines.push(`${pad}${key}[0]:`); return; }

  if (arr.every(isToonPrimitive)) {
    lines.push(`${pad}${key}[${n}]: ${arr.map(toonField).join(',')}`);
    return;
  }

  if (isUniformFlatObjectArray(arr)) {
    const cols = Object.keys(arr[0]);
    lines.push(`${pad}${key}[${n}]{${cols.map(toonKey).join(',')}}:`);
    const rowPad = '  '.repeat(depth + 1);
    for (const row of arr) {
      lines.push(rowPad + cols.map(c => toonField(row[c])).join(','));
    }
    return;
  }

  // Mixed / nested array: one dash-led block per element.
  lines.push(`${pad}${key}[${n}]:`);
  const itemPad = '  '.repeat(depth + 1);
  for (const el of arr) {
    if (isToonPrimitive(el)) {
      lines.push(`${itemPad}- ${toonField(el)}`);
    } else {
      const sub = [];
      if (Array.isArray(el)) encodeToonArray(sub, 'items', el, 0);
      else encodeToonObject(sub, el, 0);
      if (sub.length === 0) { lines.push(`${itemPad}-`); continue; }
      lines.push(`${itemPad}- ${sub[0]}`);
      for (let i = 1; i < sub.length; i++) lines.push(`${itemPad}  ${sub[i]}`);
    }
  }
}

function encodeToonObject(lines, obj, depth) {
  const pad = '  '.repeat(depth);
  for (const [k, v] of Object.entries(obj)) {
    const key = toonKey(k);
    if (isToonPrimitive(v)) {
      lines.push(`${pad}${key}: ${toonField(v)}`);
    } else if (Array.isArray(v)) {
      encodeToonArray(lines, key, v, depth);
    } else if (Object.keys(v).length === 0) {
      lines.push(`${pad}${key}:`);
    } else {
      lines.push(`${pad}${key}:`);
      encodeToonObject(lines, v, depth + 1);
    }
  }
}

/**
 * Serialize an arbitrary JSON-compatible value to a TOON string. Pure.
 * Top-level scalars stringify directly; objects/arrays render per the shapes
 * documented above.
 */
export function encodeToon(value) {
  if (isToonPrimitive(value)) return toonField(value);
  const lines = [];
  if (Array.isArray(value)) encodeToonArray(lines, 'data', value, 0);
  else encodeToonObject(lines, value, 0);
  return lines.join('\n');
}

/**
 * Pull a leading Markdown heading (`## …` / `# …` / `### …`) off a rendered
 * text block so the TOON default can keep the one-line context header while
 * replacing the body with TOON. Returns '' when the text doesn't open with a
 * heading.
 */
export function extractLeadingHeading(text) {
  if (typeof text !== 'string') return '';
  const firstLine = text.split('\n', 1)[0];
  return /^#{1,6}\s+\S/.test(firstLine) ? firstLine.trimEnd() : '';
}

/**
 * The 'summary' text channel (W4, #108): the H2 context line (rule #3 still
 * holds) and one line that says where the payload is and how big it is. Nothing
 * from the payload itself — a client on this channel reads `structuredContent`.
 */
export function summaryText(typed, markdownText) {
  const heading = extractLeadingHeading(markdownText) || '## Result';
  let bytes = 0;
  try { bytes = Buffer.byteLength(JSON.stringify(typed) ?? '', 'utf8'); } catch { bytes = 0; }
  const keys = Array.isArray(typed) ? typed.length
    : (typed && typeof typed === 'object') ? Object.keys(typed).length : (typed === undefined ? 0 : 1);
  return `${heading}\n\n_Payload in structuredContent (${keys} keys, ${bytes} bytes)._`;
}

// ── Snapshot freshness (rule #4, issue #86 base) ─────────────────────────────

/**
 * Read the snapshot build date from whichever metadata table this service has.
 * Returns null when the DB predates build-date capture, or on any error — a
 * freshness signal must never be the reason a tool call fails.
 */
export function readBuildDate(db) {
  if (!db || typeof db.prepare !== 'function') return null;
  for (const table of ['kb_metadata', 'xref_metadata', 'sec_metadata']) {
    try {
      const row = db.prepare(`SELECT value FROM ${table} WHERE key = 'build_date'`).get();
      if (row?.value) {
        const d = new Date(row.value);
        if (!Number.isNaN(d.getTime())) return d;
      }
    } catch { /* table absent on this service — try the next */ }
  }
  return null;
}

// Cached per database HANDLE: a snapshot's build date cannot change while the
// handle is open (read-only), and a reloaded handle (reloadKbDb / reloadSecDb)
// is a new key. Never read twice per handle, never stale across a reload.
const buildDateByDb = new WeakMap();

/** ISO date (YYYY-MM-DD) of the snapshot behind `db`, or null when undatable. */
export function snapshotDate(db) {
  if (!db || typeof db !== 'object') return null;
  if (buildDateByDb.has(db)) return buildDateByDb.get(db);
  let iso = null;
  try { iso = readBuildDate(db)?.toISOString().slice(0, 10) ?? null; } catch { iso = null; }
  buildDateByDb.set(db, iso);
  return iso;
}

const SERVICE_LABELS = Object.freeze({ kb: 'KB', xref: 'XRef', sec: 'Sec' });

/**
 * The freshness banner of rule #4: `_KB snapshot: 2026-08-14_`. Empty string
 * when the snapshot cannot be dated — never throws. `service` is the service
 * key ('kb' | 'xref' | 'sec') or any label to print verbatim.
 */
export function freshnessBanner(db, service) {
  const iso = snapshotDate(db);
  if (!iso) return '';
  const label = SERVICE_LABELS[String(service ?? '').toLowerCase()] ?? String(service ?? 'snapshot');
  return `_${label} snapshot: ${iso}_`;
}

/**
 * Attach the freshness banner to a DATA response, centrally (tool-sets.js wraps
 * every handler with this), so no handler has to remember rule #4.
 *
 * Placement: the line directly AFTER the H2 heading, so rule #3 (response opens
 * with H2) still holds. A response with no heading gets it prepended.
 *
 * Skipped — returned as-is — for anything that is not a data response:
 *   - `isError` results and anything carrying `_meta.kind` (emptyResult /
 *     notFoundResult / errorResult / loop notes stamp themselves),
 *   - results with no `structuredContent` (text-only tools, documents),
 *   - results whose first content block is not text,
 *   - an undatable snapshot (banner ''), and a text that already carries it.
 */
export function withFreshnessBanner(result, db, service) {
  if (!result || typeof result !== 'object' || result.isError || result._meta?.kind) return result;
  if (!('structuredContent' in result)) return result;
  const first = Array.isArray(result.content) ? result.content[0] : undefined;
  if (!first || first.type !== 'text' || typeof first.text !== 'string') return result;

  const banner = freshnessBanner(db, service);
  if (!banner) return result;

  const text = first.text;
  const heading = extractLeadingHeading(text);
  let next;
  if (heading) {
    const rest = text.slice(heading.length); // '' or starts with '\n'
    if (rest.startsWith(`\n${banner}`)) return result;
    next = `${heading}\n${banner}${rest}`;
  } else {
    if (text.startsWith(banner)) return result;
    next = `${banner}\n\n${text}`;
  }
  return { ...result, content: [{ ...first, text: next }, ...result.content.slice(1)] };
}

// ── Read-only DB tool annotations ────────────────────────────────────────────
// Frozen so a tool file can't accidentally flip a hint at registration time.
export const READ_ONLY_DB_ANNOTATIONS = Object.freeze({
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: false,
});

// ── Read-only LIVE tool annotations (issue #87) ─────────────────────────
// For a tool that reads a live D365 environment over HTTPS instead of a local
// snapshot. Identical to READ_ONLY_DB_ANNOTATIONS except `openWorldHint`, which
// must be `true`: the tool does reach an external system, and claiming
// otherwise to keep the closed-world story tidy would suppress host approval
// prompts under a false premise.
//
// `idempotentHint` stays true — repeating the call has no side effect on the
// environment; it is a GET against `$metadata`.
export const READ_ONLY_LIVE_ANNOTATIONS = Object.freeze({
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: true,
});

// ── Response shape helpers ───────────────────────────────────────────────────

/**
 * Typed payload in structuredContent + a text channel for the model.
 *
 * The text channel defaults to TOON (token-efficient, uniform) rendered from
 * the typed object — the leading `## context` heading from `markdownText` is
 * preserved so the model keeps the human-readable context line above the TOON
 * body. Pass `format === 'markdown'` to emit the full Markdown rendering
 * instead (the human-readable opt-out used by the back-office and debugging).
 *
 * `structuredContent` is always the typed JSON regardless of `format` — it is
 * mandated by the MCP protocol whenever the tool declares an outputSchema.
 *
 * TEXT-CHANNEL POLICY (W4, #108). The request context's `textChannel` decides
 * what the text channel CARRIES; `format` only decides how it is encoded:
 *
 *   'full'    (default) — TOON / Markdown rendering of `typed`, exactly as
 *             before; byte-identical to the pre-#108 behaviour.
 *   'summary' — the H2 context line plus ONE line naming the payload's key
 *             count and byte size, and nothing else. For a client that is
 *             measured to bill `structuredContent` and discard the text, the
 *             full text channel is pure wire waste (1.3–2× the JSON alone).
 *
 * Selected per request via `?text=summary`, `X-MCP-Text-Channel: summary` or
 * `MCP_TEXT_CHANNEL=summary` (request-context.js). The default stays 'full'
 * until #108's client measurement is recorded — this is the mechanism, not the
 * decision.
 *
 * @param {object} typed         Typed payload (also returned as structuredContent).
 * @param {string} markdownText  Full Markdown rendering (heading + body).
 * @param {'auto'|'toon'|'markdown'} [format='auto']  Text-channel encoding.
 *   'auto' picks the smaller of TOON and Markdown per response; the other two
 *   pin it. Anything else (including `undefined` from the test mock server,
 *   which bypasses Zod) is treated as 'auto' — a 'toon' default here would
 *   silently pin the encoding for every such call, which is exactly how this
 *   was wrong the first time.
 */
export function structuredResult(typed, markdownText, format = 'auto', { coverage } = {}) {
  // Coverage boundaries (#116): the fired keys join the typed payload; the
  // `_…_` lines go directly under the H2 (and under the freshness banner once
  // withFreshnessBanner adds it — that wrapper inserts on the line after the
  // heading, so the order on the wire is heading / banner / coverage / body).
  //
  // The text channel renders the PRE-merge payload: the `_…_` line IS the text
  // rendering of the fired key, so encoding the key into TOON as well would pay
  // the same signal twice. structuredContent carries the key, text the line.
  const cov = coverage && typeof coverage === 'object' ? coverage : null;
  const body = typed;
  if (cov && cov.keys && typeof cov.keys === 'object' && Object.keys(cov.keys).length
      && typed && typeof typed === 'object' && !Array.isArray(typed)) {
    typed = { ...typed, ...cov.keys };
  }
  const covText = cov && typeof cov.text === 'string' && cov.text.trim() ? cov.text.trim() : '';
  const withCoverage = (text) => (covText ? insertAfterHeading(text, covText) : text);

  if (getRequestContext().textChannel === 'summary') {
    return {
      content: [{ type: 'text', text: withCoverage(summaryText(typed, markdownText)) }],
      structuredContent: typed,
    };
  }

  // An explicit `format: "markdown"` is honoured unconditionally: those callers
  // quote the text verbatim into a document, so size is not the criterion.
  if (format === 'markdown' && markdownText) {
    return { content: [{ type: 'text', text: withCoverage(markdownText) }], structuredContent: typed };
  }

  const heading = extractLeadingHeading(markdownText);
  const toon = encodeToon(body);
  const toonText = withCoverage(heading ? `${heading}\n\n${toon}` : toon);
  markdownText = markdownText ? withCoverage(markdownText) : markdownText;

  // An explicit `format: "toon"` pins the encoding too — only the DEFAULT is
  // adaptive, so a caller that has decided still gets what it asked for.
  if (format === 'toon') {
    return { content: [{ type: 'text', text: toonText }], structuredContent: typed };
  }

  // ADAPTIVE, because the data says neither encoding wins universally. Measured
  // across six real KB calls (tokens, text channel):
  //
  //   d365_get_entity_sources   TOON 4,448   markdown 5,216   -> TOON
  //   d365_lookup_table         TOON 9,725   markdown 6,772   -> markdown (-30%)
  //   d365_get_class_methods    TOON 5,912   markdown 6,082   -> TOON
  //   d365_get_enum             TOON   749   markdown   651   -> markdown
  //   d365_list_modules         TOON   117   markdown   114   -> markdown
  //   d365_search               TOON   780   markdown   818   -> TOON
  //   TOTAL                     TOON 21,731  markdown 19,653  adaptive 18,677
  //
  // TOON's tabular form wins on nested payloads; a Markdown table wins on wide
  // flat ones, where TOON repeats a long key header. Picking the smaller per
  // response is never worse than either fixed choice (-14% against the TOON
  // default here) and loses nothing: both are renderings of the same `typed`
  // object, and rule #5 already directs post-processing at structuredContent.
  const text = (markdownText && markdownText.length < toonText.length) ? markdownText : toonText;

  return {
    content: [{ type: 'text', text }],
    structuredContent: typed,
  };
}

/**
 * Insert `lines` directly after the leading heading of `text` (or prepend them
 * when there is none). The blank line that followed the heading is kept after
 * the inserted block, so the body still starts on its own paragraph.
 */
function insertAfterHeading(text, lines) {
  const heading = extractLeadingHeading(text);
  if (!heading) return `${lines}\n\n${text}`;
  const rest = text.slice(heading.length); // '' or starts with '\n'
  return `${heading}\n${lines}${rest}`;
}

// ── Coverage boundaries (#116, Q3) ───────────────────────────────────────────
//
// W3 made `truncated` exact for ROWS. This is the same discipline for
// COVERAGE: a data response states, one line per signal and only when the
// condition holds, what it is NOT covering — so the model cannot summarise a
// partial view as the whole. Every signal text lives HERE and nowhere else
// (static scan in test/response-format.test.js); a handler computes the
// signals and passes `{ coverage: coverageNotes(signals) }` to structuredResult.
//
// Typed keys follow rule #14: present only when fired, never false/null.

/**
 * @param {{
 *   field_limit_hit?: { shown: number, total: number },
 *   provenance_omitted?: { count: number, total: number, models?: string[] },
 *   isv_not_scanned?: boolean,
 *   isv_excluded?: { count: number },
 *   partial_build?: { since?: string|null },
 *   custom_layer?: string,
 * }} [signals]
 * @returns {{ text: string, keys: Record<string, boolean|number> }}
 */
export function coverageNotes(signals = {}) {
  const s = signals && typeof signals === 'object' ? signals : {};
  const lines = [];
  const keys = {};
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

  const fl = s.field_limit_hit;
  if (fl && n(fl.shown) != null && n(fl.total) != null && n(fl.shown) < n(fl.total)) {
    lines.push(`_Fields capped at ${n(fl.shown)} of ${n(fl.total)} — use fields_like / custom_only / field_limit._`);
    keys.field_limit_hit = true;
  }

  const po = s.provenance_omitted;
  if (po && n(po.count) > 0) {
    const models = Array.isArray(po.models) ? po.models.filter(m => typeof m === 'string' && m.trim()).map(m => m.trim()) : [];
    const who = models.length ? ` (models: ${models.slice(0, 5).join(', ')}${models.length > 5 ? ', …' : ''})` : '';
    const total = n(po.total) != null ? n(po.total) : n(po.count);
    lines.push(`_${n(po.count)} of ${total} fields come from extensions${who} — pass include_provenance or custom_only to see which._`);
    keys.provenance_omitted = n(po.count);
  }

  if (s.isv_not_scanned === true) {
    lines.push('_Sealed-ISV models not scanned in this snapshot — ISV usages/extensions absent, not zero._');
    keys.isv_not_scanned = true;
  }

  const ie = s.isv_excluded;
  if (ie && n(ie.count) > 0) {
    lines.push(`_${n(ie.count)} sealed-ISV usages exist — pass include_isv:true._`);
    keys.isv_excluded = n(ie.count);
  }

  const pb = s.partial_build;
  if (pb) {
    const since = typeof pb === 'object' && pb.since ? String(pb.since).slice(0, 10) : 'the last full build';
    lines.push(`_KB is a delta-merged snapshot; kb_search may be stale for base tables extended since ${since}._`);
    keys.partial_build = true;
  }

  // Existing behaviour reused, not duplicated: customLayerNote already decides
  // whether the name carries a custom prefix and returns '' otherwise. Text
  // only — #116 lists no typed key for it.
  if (typeof s.custom_layer === 'string' && s.custom_layer) {
    const note = customLayerNote(s.custom_layer).trim();
    if (note) lines.push(note);
  }

  return { text: lines.join('\n'), keys };
}

/**
 * One `kb_metadata` value by key (`partial_build`, `has_customizations`, …),
 * or null when the table/key is absent or the read fails. The
 * `partial_build` flag is set by the delta-merge path (#86) and feeds
 * coverageNotes({ partial_build }).
 */
export function readKbMetadataFlag(db, key) {
  if (!db || typeof db.prepare !== 'function' || typeof key !== 'string' || !key) return null;
  try {
    const row = db.prepare('SELECT value FROM kb_metadata WHERE key = ?').get(key);
    return row?.value == null ? null : String(row.value);
  } catch {
    return null;
  }
}

/**
 * Render source text with body-relative line numbers for citation.
 *
 * The KB `methods.source_code` column stores each method body as a standalone
 * blob with no file-absolute offsets (see build-kb.js), so the only stable,
 * reproducible coordinate we can expose is the line index WITHIN the method
 * body (1 = first line of the method source). Numbering is right-aligned and
 * deterministic, so a citation like "line 12" always points at the same line.
 *
 * Returns the numbered text; use the returned line count via String(text).split.
 */
export function numberSourceLines(text) {
  const s = String(text ?? '').replace(/\r\n/g, '\n').replace(/\n$/, '');
  const lines = s.split('\n');
  const width = String(lines.length).length;
  return lines.map((ln, i) => `${String(i + 1).padStart(width)} | ${ln}`).join('\n');
}

/**
 * Disclosure note for XRef searches that target a custom/ISV overlayer prefix.
 *
 * The XRef SQLite snapshot is extracted from the dev layer (build-xref-db.js);
 * it does not contain ISV/customer overlayer objects. A zero-row result for a
 * custom-prefixed name therefore cannot distinguish "absent from this snapshot"
 * from "does not exist". When an empty search's target matches a known custom
 * prefix, callers get this note so they don't over-conclude from the 0 rows.
 *
 * Prefixes default to the known custom/ISV layers and are overridable via the
 * comma-separated `XREF_CUSTOM_PREFIXES` env var. Returns '' when no prefix
 * matches (the overwhelmingly common case), so standard empty results are
 * untouched.
 */
const DEFAULT_XREF_CUSTOM_PREFIXES = ['TBG_', 'TBG', 'TOC_', 'TOC'];
export function customLayerNote(name) {
  const raw = String(name ?? '').replace(/^%+/, '').trim();
  if (!raw) return '';
  const env = (process.env.XREF_CUSTOM_PREFIXES || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const prefixes = env.length ? env : DEFAULT_XREF_CUSTOM_PREFIXES;
  const hit = prefixes.find(p => raw.toLowerCase().startsWith(p.toLowerCase()));
  if (!hit) return '';
  return `\n\n_This XRef snapshot is built from the dev layer and may not include ISV/custom overlayer objects (matched custom prefix \`${hit}\`). A zero-row result for a custom-prefixed name can mean the object is absent from this snapshot rather than nonexistent — see \`docs/XRef-Custom-Layer-Coverage.md\`._`;
}

/**
 * Valid query that returned zero rows. Not an error — isError stays undefined.
 *
 * `structured` is the typed payload matching the tool's `outputSchema`, with
 * empty arrays and zeroed counts. It is MANDATORY for any tool that declares an
 * `outputSchema`: the MCP SDK validates every non-error response and throws
 * `-32602 "… has an output schema but no structured content was provided"`
 * when `structuredContent` is absent (see SDK `validateToolOutput` — it skips
 * validation for `isError` results but not for empty success results). Omitting
 * it is only safe on the handful of tools without an output schema.
 */
export function emptyResult(context, structured, note) {
  let text = `## No results\n\nNo ${context} found.`;
  if (note) text += note;
  // `_meta.kind` marks the three meta-responses so the central freshness
  // wrapper (withFreshnessBanner) can skip them by construction rather than by
  // pattern-matching their text. `_meta` is part of the MCP Result type.
  const result = {
    content: [{ type: 'text', text }],
    _meta: { kind: 'empty' },
  };
  if (structured !== undefined) result.structuredContent = structured;
  return result;
}

// ── Exact-name recovery (#115 item 3) ────────────────────────────────────────
//
// A not-found response is the cheapest response in the system and used to
// carry the least information. `closestNames` gives every not-found a
// "did you mean" from the service's own name table, so a typo (`SalesTabel`),
// a case slip (`custtable`) or a half-remembered name (`SalesForm`) costs one
// call instead of a guess-and-retry loop.
//
// The KIND → table/column map below was read off the builders' DDL
// (build/build-kb.js, build/build-xref-db.js, src/azure/sec-builder.js) and the
// in-memory fixtures the tool tests build — never guessed. Which service a `db`
// belongs to is discovered from sqlite_master, so one function serves all three:
//   KB   — one flat table per kind, `<kind>_name` column
//   XRef — `names.path`, the object is the last segment of `/<Type>/<Name>`
//   Sec  — roles.role_name / duties.duty_name / privileges.privilege_name /
//          users.user_id

const KB_KIND_TABLES = Object.freeze({
  table: [['tables', 'table_name']],
  class: [['classes', 'class_name']],
  enum: [['enums', 'enum_name']],
  edt: [['edts', 'edt_name']],
  form: [['forms', 'form_name']],
  entity: [['data_entities', 'entity_name']],
  menu_item: [['menu_items', 'menu_item_name']],
  object: [
    ['tables', 'table_name'], ['classes', 'class_name'], ['data_entities', 'entity_name'],
    ['enums', 'enum_name'], ['forms', 'form_name'], ['edts', 'edt_name'], ['menu_items', 'menu_item_name'],
  ],
  role: [['roles', 'role_name']],
  duty: [['duties', 'duty_name']],
  privilege: [['privileges', 'privilege_name']],
  user: [['users', 'user_id']],
});

// XRef: the `/<Type>/` path prefix per kind; `object` = any top-level type.
const XREF_KIND_PREFIXES = Object.freeze({
  table: ['/Tables/'], class: ['/Classes/'], enum: ['/Enums/'], edt: ['/Edts/'],
  form: ['/Forms/'], entity: ['/DataEntityViews/'], menu_item: ['/MenuItemDisplays/', '/MenuItemActions/', '/MenuItemOutputs/'],
  object: [null],
});

export const CLOSEST_NAME_KINDS = Object.freeze(Object.keys(KB_KIND_TABLES));

// Per database HANDLE: the set of table names (read once from sqlite_master).
const tableSetByDb = new WeakMap();
function tableSet(db) {
  if (tableSetByDb.has(db)) return tableSetByDb.get(db);
  let set = new Set();
  try {
    set = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all().map(r => String(r.name).toLowerCase()));
  } catch { set = new Set(); }
  tableSetByDb.set(db, set);
  return set;
}

function escapeLike(s) {
  return String(s).replace(/[\\%_]/g, ch => `\\${ch}`);
}

/** Levenshtein distance with an early exit above `max` (returns max + 1). */
export function levenshtein(a, b, max = Infinity) {
  a = String(a); b = String(b);
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Candidate-name strategy shared by the KB/Sec (flat column) and XRef (path
 * segment) shapes. `run(kind, pattern, limit)` executes one LIKE query and
 * returns bare names; `exact(name)` returns the exact-case spelling or null.
 */
function collectClosest(name, limit, { exact, like }) {
  const out = [];
  const seen = new Set();
  const add = (n) => {
    if (n == null) return;
    const key = String(n).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(String(n));
  };
  // 1. case-only match: the object exists, the caller spelt it in another case.
  add(exact(name));
  if (out.length >= limit) return out.slice(0, limit);
  const esc = escapeLike(name);
  // 2. prefix
  for (const n of like(`${esc}%`, limit * 2)) { add(n); if (out.length >= limit) return out.slice(0, limit); }
  // 3. contains
  for (const n of like(`%${esc}%`, limit * 2)) { add(n); if (out.length >= limit) return out.slice(0, limit); }
  // 4. Levenshtein ≤ 2 over the first 200 candidates sharing the first 3 chars.
  if (name.length >= 3) {
    const lower = name.toLowerCase();
    const scored = [];
    for (const n of like(`${escapeLike(name.slice(0, 3))}%`, 200)) {
      const d = levenshtein(lower, String(n).toLowerCase(), 2);
      if (d <= 2) scored.push([d, n]);
    }
    scored.sort((x, y) => x[0] - y[0] || String(x[1]).localeCompare(String(y[1])));
    for (const [, n] of scored) { add(n); if (out.length >= limit) break; }
  }
  return out.slice(0, limit);
}

/**
 * Closest existing names to `name` of the given `kind` in `db`, at most
 * `limit`. Strategy, in order: case-only match → prefix → contains →
 * Levenshtein ≤ 2. Parameterised SQL only; returns `[]` — never throws — on an
 * unknown kind, a database without the kind's table, or any SQLite error.
 *
 * @param {object} db     KB, XRef or Sec database handle
 * @param {string} name   the name the caller asked for
 * @param {'table'|'class'|'enum'|'edt'|'form'|'entity'|'menu_item'|'object'|'role'|'duty'|'privilege'|'user'} kind
 * @param {number} [limit=3]
 * @returns {string[]}
 */
export function closestNames(db, name, kind, limit = 3) {
  const n = Number.isInteger(limit) && limit > 0 ? limit : 3;
  const needle = typeof name === 'string' ? name.trim().replace(/^%+|%+$/g, '') : '';
  if (!needle || !db || typeof db.prepare !== 'function') return [];
  const kbTargets = KB_KIND_TABLES[kind];
  if (!kbTargets) return [];
  try {
    const tables = tableSet(db);
    const present = kbTargets.filter(([t]) => tables.has(t));
    if (present.length > 0) {
      const out = [];
      for (const [table, col] of present) {
        const hits = collectClosest(needle, n - out.length, {
          exact: (v) => db.prepare(`SELECT ${col} AS n FROM ${table} WHERE ${col} = ? COLLATE NOCASE LIMIT 1`).get(v)?.n ?? null,
          like: (pattern, lim) => db.prepare(`SELECT DISTINCT ${col} AS n FROM ${table} WHERE ${col} LIKE ? ESCAPE '\\' ORDER BY ${col} LIMIT ?`).all(pattern, lim).map(r => r.n),
        });
        for (const h of hits) if (!out.some(o => o.toLowerCase() === h.toLowerCase())) out.push(h);
        if (out.length >= n) break;
      }
      return out.slice(0, n);
    }
    // XRef shape: names.path = /<Type>/<Name>; the object is the last segment.
    if (tables.has('names') && XREF_KIND_PREFIXES[kind]) {
      const last = (p) => String(p).split('/').filter(Boolean).pop() ?? null;
      const out = [];
      for (const prefix of XREF_KIND_PREFIXES[kind]) {
        const hits = collectClosest(needle, n - out.length, {
          exact: (v) => {
            // SQLite LIKE is case-insensitive for ASCII, so the `object` form
            // (any top-level type) is already a case-only match.
            const row = prefix
              ? db.prepare('SELECT path FROM names WHERE path = ? COLLATE NOCASE LIMIT 1').get(`${prefix}${v}`)
              : db.prepare("SELECT path FROM names WHERE path LIKE ? ESCAPE '\\' AND path NOT LIKE '/%/%/%' LIMIT 1").get(`/%/${escapeLike(v)}`);
            return row ? last(row.path) : null;
          },
          like: (pattern, lim) => db.prepare(
            "SELECT path FROM names WHERE path LIKE ? ESCAPE '\\' AND path NOT LIKE '/%/%/%' ORDER BY path LIMIT ?",
          ).all(`${prefix ?? '/%/'}${pattern}`, lim).map(r => last(r.path)),
        });
        for (const h of hits) if (!out.some(o => o.toLowerCase() === h.toLowerCase())) out.push(h);
        if (out.length >= n) break;
      }
      return out.slice(0, n);
    }
    return [];
  } catch {
    return [];
  }
}

const NOT_FOUND_CONTEXT_MAX = 400;

/**
 * The named target object does not exist. Sets isError.
 *
 * Optional 4th argument (#115 items 2–3), fully backward compatible — a 3-arg
 * call produces byte-identical output:
 *   - `db` + `kind`: when the caller passes no `suggestions`, the closest
 *     existing names are looked up via `closestNames(db, name, kind, 3)`, so no
 *     not-found ships empty-handed;
 *   - `functional_context` + `semanticDb`: a vocabulary id names the business
 *     entity the caller was after. Known with mappings → the objects mapped to
 *     it (max 5, by confidence); unknown → the closest vocabulary ids.
 * Still a meta-response: no structuredContent, `_meta.kind: 'not-found'`, no
 * freshness banner. The appended context text is capped at 400 chars.
 */
export function notFoundResult(type, name, suggestions, opts = {}) {
  let list = Array.isArray(suggestions) ? suggestions : [];
  if (list.length === 0 && opts && opts.db && opts.kind) {
    list = closestNames(opts.db, name, opts.kind, 3);
  }
  let text = `## ${type} not found\n\n${type} \`${name}\` was not found.`;
  if (list.length > 0) {
    const items = list.slice(0, 5).map(s => `- \`${s}\``).join('\n');
    text += `\n\n**Did you mean:**\n${items}`;
  }
  const ctxNote = functionalContextNote(opts?.functional_context, opts?.semanticDb);
  if (ctxNote) text += `\n\n${ctxNote}`;
  // No structuredContent on error responses: the MCP client validates
  // structuredContent against the tool's outputSchema whenever it is present —
  // even on isError results (SDK client/index.js) — so an `{error}`-shaped
  // payload would fail validation for every schema'd tool. isError + text only.
  return {
    content: [{ type: 'text', text }],
    isError: true,
    _meta: { kind: 'not-found' },
  };
}

/** One `_…_` line for a `functional_context` vocabulary id, or '' (never throws). */
function functionalContextNote(functionalContext, semanticDb) {
  if (typeof functionalContext !== 'string' || !functionalContext.trim() || !semanticDb) return '';
  const id = functionalContext.trim().slice(0, 64);
  let line = '';
  try {
    const display = entityDisplayName(semanticDb, id);
    if (display) {
      const mapped = mappedObjectsForEntity(semanticDb, id, 5);
      if (mapped.length === 0) return '';
      line = `_Objects mapped to ${display}: ${mapped.map(m => `${m.object_name} (${m.role})`).join(', ')}_`;
    } else {
      const close = suggestEntities(semanticDb, id, 3);
      line = close.length
        ? `_Unknown functional_context "${id}"; closest: ${close.join(', ')}_`
        : `_Unknown functional_context "${id}"_`;
    }
  } catch {
    return '';
  }
  if (line.length > NOT_FOUND_CONTEXT_MAX) line = `${line.slice(0, NOT_FOUND_CONTEXT_MAX - 2)}…_`;
  return line;
}

const ERROR_CATEGORIES = new Set(['not-found', 'invalid-input', 'db-error', 'parse-error', 'internal']);

/** Tool-level failure. `details` is logged server-side, never echoed to caller. */
export function errorResult(category, hint, details) {
  const cat = ERROR_CATEGORIES.has(category) ? category : 'internal';
  if (details !== undefined) {
    const msg = details instanceof Error ? `${details.name}: ${details.message}` : String(details);
    console.error(`[${cat}] ${hint} -- ${msg}`);
  }
  // isError + text only — see notFoundResult for why no structuredContent.
  return {
    content: [{ type: 'text', text: `## Error\n\n${hint}` }],
    isError: true,
    _meta: { kind: 'error' },
  };
}

/**
 * Markdown footnote describing a truncation.
 *   'user' — caller-supplied limit hit
 *   'cap'  — tool default cap (overridable up to hardMax)
 *   'hard' — non-overridable safety ceiling
 */
export function truncationNote(kind, shown, hardMax) {
  switch (kind) {
    case 'user':
      return `\n\n_Showing first ${shown} results (caller \`limit\`). Pass a higher \`limit\` to see more._\n`;
    case 'cap':
      return `\n\n_Showing first ${shown} results (default cap${hardMax ? `, max ${hardMax}` : ''}). Pass a higher \`limit\` to see more._\n`;
    case 'hard':
      return `\n\n_Showing first ${shown} results (hard safety cap, not configurable)._\n`;
    default:
      return `\n\n_Showing first ${shown} results._\n`;
  }
}

// ── Permission rendering ────────────────────────────────────────────────────

/** Render a sec permission constant as ✓ Grant / ✗ Deny / — None. */
export function formatPermission(type) {
  if (type === null || type === undefined || type === '') return '— None';
  const v = String(type).trim().toLowerCase();
  if (v === 'grant' || v === '1' || v === 'true' || v === 'allow') return '✓ Grant';
  if (v === 'deny'  || v === '0' || v === 'false') return '✗ Deny';
  return '— None';
}

/** Render a CRUD grant flag as Y / N / empty. */
export function formatCrudFlag(v) {
  if (v === null || v === undefined || v === '') return '';
  const s = String(v).trim().toLowerCase();
  if (s === '1' || s === 'true' || s === 'y' || s === 'yes' || s === 'allow' || s === 'grant') return 'Y';
  if (s === '0' || s === 'false' || s === 'n' || s === 'no' || s === 'deny') return 'N';
  return '';
}

// ── Snippet windowing ───────────────────────────────────────────────────────

/**
 * Return a snippet of `text` centred on the first (case-insensitive) match of
 * `term`, with up to `window` chars of context on each side. Ellipses mark
 * unreached string boundaries.
 */
export function contextAround(text, term, window) {
  if (text === null || text === undefined) return '';
  const t = String(text);
  if (!term) return t.length > window * 2 ? t.slice(0, window * 2) + '…' : t;
  const idx = t.toLowerCase().indexOf(String(term).toLowerCase());
  if (idx === -1) {
    return t.length > window * 2 ? t.slice(0, window * 2) + '…' : t;
  }
  const start = Math.max(0, idx - window);
  const end = Math.min(t.length, idx + String(term).length + window);
  let snip = t.slice(start, end);
  if (start > 0) snip = '…' + snip;
  if (end < t.length) snip = snip + '…';
  return snip;
}

// ── Label resolver ──────────────────────────────────────────────────────────

/**
 * Per-call resolver: turns @SYS… IDs into their localized text. Plain strings
 * pass through. Tolerant of DBs without a labels table — degrades to
 * pass-through rather than crashing the tool.
 */
export function makeLabelResolver(db) {
  const cache = new Map();
  let stmt = null;
  let stmtAttempted = false;
  return function resolve(rawLabel) {
    if (rawLabel === null || rawLabel === undefined || rawLabel === '') return rawLabel;
    const s = String(rawLabel);
    if (!s.startsWith('@')) return s;
    if (cache.has(s)) return cache.get(s);
    if (!stmtAttempted) {
      stmtAttempted = true;
      try {
        stmt = db.prepare('SELECT text AS label_text FROM labels WHERE label_id = ? COLLATE NOCASE LIMIT 1');
      } catch {
        stmt = null;
      }
    }
    if (!stmt) {
      cache.set(s, s);
      return s;
    }
    let resolved = s;
    try {
      const row = stmt.get(s);
      if (row && row.label_text) resolved = row.label_text;
    } catch {
      stmt = null;
    }
    cache.set(s, resolved);
    return resolved;
  };
}

// ── Wildcard pattern validation (issue #42) ──────────────────────────────────

/**
 * Maximum allowed length for any user-supplied string that becomes a SQL `LIKE`
 * pattern in kb-tools / xref-tools. Above this, full-table scans burn excessive
 * memory and CPU on Azure Functions. Validation must happen before the DB query.
 */
export const MAX_LIKE_PATTERN_LENGTH = 100;

/**
 * Validate that a user-supplied wildcard pattern is within the allowed length.
 * Returns null when valid (or when the input is not a string — Zod handles type errors).
 * Returns `{ error: '...' }` when oversized; the caller decides how to surface it.
 */
export function validateLikePattern(value, max = MAX_LIKE_PATTERN_LENGTH) {
  if (typeof value !== 'string') return null;
  if (value.length > max) {
    return { error: `Search pattern too long (max ${max} chars)` };
  }
  return null;
}

/**
 * Wrap a `validateLikePattern` failure in the MCP error response shape used
 * across kb-tools and xref-tools (text + isError flag, structured object retained
 * so future structured-output handlers can pass it through unchanged).
 */
export function patternErrorResult(validationResult) {
  // isError + text only — see notFoundResult for why no structuredContent.
  return {
    content: [{ type: 'text', text: validationResult.error }],
    isError: true,
  };
}

// ── Query budget enforcement (issue #50) ─────────────────────────────────────

/**
 * Wall-clock budget for a single SQLite call. Configurable via the
 * QUERY_TIMEOUT_MS env var; defaults to 25 s (well under the Azure Functions
 * Premium 60-min ceiling, but high enough for legitimate large traversals).
 *
 * Note: better-sqlite3 is synchronous, so this CANNOT preempt an in-flight
 * query. The check runs after the call returns and converts a budget overrun
 * into a typed error the caller can map to HTTP 504 / a tool-level timeout.
 * Companion measure: the busy_timeout pragma above bounds *lock* waits to 30 s.
 */
export const QUERY_TIMEOUT_MS = Number(process.env.QUERY_TIMEOUT_MS) || 25000;

export class QueryBudgetExceededError extends Error {
  constructor(label, elapsedMs, budgetMs) {
    super(`Query "${label}" exceeded budget: ${elapsedMs}ms > ${budgetMs}ms`);
    this.name = 'QueryBudgetExceededError';
    this.label = label;
    this.elapsedMs = elapsedMs;
    this.budgetMs = budgetMs;
  }
}

/**
 * Run a synchronous DB call and throw QueryBudgetExceededError if it exceeded
 * the wall-clock budget. The injectable `now` clock is for tests.
 */
export function runWithBudget(label, fn, budgetMs = QUERY_TIMEOUT_MS, now = Date.now) {
  const start = now();
  const result = fn();
  const elapsed = now() - start;
  if (elapsed > budgetMs) {
    throw new QueryBudgetExceededError(label, elapsed, budgetMs);
  }
  return result;
}

/**
 * Render a QueryBudgetExceededError as an MCP tool error response. Tools that
 * wrap raw SQL in runWithBudget() should catch the error and return this so
 * the user sees a clean "Query timeout" message rather than an internal trace.
 */
export function timeoutErrorResult(err) {
  // isError + text only — see notFoundResult for why no structuredContent.
  return {
    content: [{
      type: 'text',
      text: `Query timeout — try a more specific search. (${err.elapsedMs}ms > ${err.budgetMs}ms budget)`,
    }],
    isError: true,
  };
}
