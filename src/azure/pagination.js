/**
 * Cursor pagination for the list-shaped tools (issue #109 part A, W5).
 *
 * Before this, truncation was signalled but never resumable: `truncationNote`
 * said "pass a higher `limit`", which re-pays the head of the list to reach
 * the tail. A cursor is an opaque, stateless token — base64url of
 * `{o: offset, k?: sort_key}` — so the server keeps nothing between calls and a
 * client that ignores it loses nothing: `limit` semantics are unchanged and a
 * call without `cursor` returns exactly what it always did, plus `has_more`
 * (and `next_cursor` when there is more).
 *
 * Contract (rule #14): `has_more` is always present on a paginated single-target
 * response; `next_cursor` is present only when `has_more` is true; `total_count`
 * only when the tool knows it cheaply (most tools already carry their own exact
 * count key and pass `null` here).
 *
 * The SQL side pairs `LIMIT ? OFFSET ?` with a stable ORDER BY and fetches one
 * row more than `limit` (`probeLimit`) so `has_more` is exact without a COUNT.
 */

import { z } from 'zod';
import { errorResult } from './shared.js';

export const CURSOR_MAX_LENGTH = 500;

/** Shared input: add `cursor: cursorParam` to a paginated tool's inputSchema.
 *  KEPT SHORT — it ships in tools/list once per paginated tool. */
export const cursorParam = z.string().max(CURSOR_MAX_LENGTH).optional()
  .describe('Page cursor: the `next_cursor` of the previous response.');

/** Opaque cursor for the page starting at `offset`. */
export function encodeCursor({ offset, sort_key } = {}) {
  const o = Number.isInteger(offset) && offset > 0 ? offset : 0;
  const payload = sort_key === undefined ? { o } : { o, k: sort_key };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/**
 * Tolerant decode. Absent / empty -> first page. Anything that is not a cursor
 * this module produced -> `{ ok: false, error }` where `error` is an
 * `errorResult('invalid-input', …)` ready to return as-is.
 *
 * @returns {{ok:true, offset:number, sort_key?:unknown} | {ok:false, error:object}}
 */
export function decodeCursor(str) {
  if (str === undefined || str === null || str === '') return { ok: true, offset: 0 };
  const invalid = () => ({
    ok: false,
    error: errorResult('invalid-input',
      'Invalid `cursor`. Pass the `next_cursor` value from the previous page unchanged, or omit it for the first page.'),
  });
  if (typeof str !== 'string' || str.length > CURSOR_MAX_LENGTH) return invalid();
  try {
    const obj = JSON.parse(Buffer.from(str, 'base64url').toString('utf8'));
    if (!obj || typeof obj !== 'object' || !Number.isInteger(obj.o) || obj.o < 0) return invalid();
    return obj.k === undefined ? { ok: true, offset: obj.o } : { ok: true, offset: obj.o, sort_key: obj.k };
  } catch {
    return invalid();
  }
}

/**
 * Page envelope. `total` may be null when unknown; then `hasMoreHint` (from a
 * limit+1 probe) decides, and failing that the legacy `shown >= limit` heuristic.
 *
 * @param {number|null} total     exact total when known, else null
 * @param {number} offset         first row of this page
 * @param {number} shown          rows on this page
 * @param {number} limit          page size
 * @param {boolean} [hasMoreHint] exact answer from a limit+1 probe
 * @returns {{has_more:boolean, next_cursor?:string, total_count?:number}}
 */
export function pageMeta(total, offset, shown, limit, hasMoreHint) {
  const off = Number.isInteger(offset) && offset > 0 ? offset : 0;
  const has_more = typeof hasMoreHint === 'boolean'
    ? hasMoreHint
    : Number.isInteger(total) ? off + shown < total : shown >= limit;
  const meta = { has_more };
  if (has_more) meta.next_cursor = encodeCursor({ offset: off + shown });
  if (Number.isInteger(total)) meta.total_count = total;
  return meta;
}

/** LIMIT value for a probe: one more than the page, so has_more is exact. */
export function probeLimit(limit) {
  return limit + 1;
}

/** Split a probe result into the page and the exact has_more flag. */
export function takePage(rows, limit) {
  const has_more = rows.length > limit;
  return { rows: has_more ? rows.slice(0, limit) : rows, has_more };
}

/**
 * Text-channel footnote for a paginated response. Replaces the "raise `limit`"
 * wording of truncationNote when a cursor exists: continuing is cheaper than
 * re-fetching the head.
 */
export function pageNote(shown, offset, nextCursor) {
  const off = Number.isInteger(offset) && offset > 0 ? offset : 0;
  const from = off ? ` (rows ${off + 1}-${off + shown})` : '';
  return `\n\n_Showing ${shown} results${from}; more available — pass \`cursor: "${nextCursor}"\` to continue._\n`;
}
