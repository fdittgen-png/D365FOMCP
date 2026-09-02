/**
 * Answer comparison for the LLM leg of the evals (issue #119).
 *
 * The mcp-builder guide grades by "direct string comparison" and asks the
 * question to fix the format ("Answer with the number only", "True/False",
 * "a,b with no spaces"). A model that answers `**3**` or `CustAccount.` has
 * still found the fact, so the comparison is normalised — but only in ways
 * that cannot turn a wrong answer into a right one:
 *
 *   trim · case-fold · collapse internal whitespace · strip one layer of
 *   wrapping quotes/backticks/bold markers · strip trailing sentence
 *   punctuation · numeric equality when BOTH sides parse as a finite number
 *   (so `74`, `74.0` and ` 74 ` agree, `7,4` does not).
 *
 * Nothing here extracts an answer out of prose: "The value is 3" does not
 * match "3". That is deliberate — the system prompt says "Answer with the
 * value only", and following it is part of what the eval measures.
 */

const WRAPPERS = [
  ['`', '`'], ['"', '"'], ["'", "'"], ['**', '**'], ['*', '*'], ['“', '”'], ['‘', '’'],
];

export function normalizeLlmAnswer(v) {
  let s = v === undefined || v === null ? '' : String(v);
  s = s.replace(/\s+/g, ' ').trim();
  // One layer of wrapping markers, repeated while it keeps unwrapping something.
  let changed = true;
  while (changed && s.length >= 2) {
    changed = false;
    for (const [open, close] of WRAPPERS) {
      if (s.length > open.length + close.length && s.startsWith(open) && s.endsWith(close)) {
        s = s.slice(open.length, s.length - close.length).trim();
        changed = true;
      }
    }
  }
  s = s.replace(/[.,;:!?]+$/u, '').trim();
  return s.toLowerCase();
}

function asNumber(s) {
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** True when `actual` matches `expected` after normalisation. */
export function answersMatch(expected, actual) {
  const e = normalizeLlmAnswer(expected);
  const a = normalizeLlmAnswer(actual);
  if (e === a) return true;
  const en = asNumber(e);
  const an = asNumber(a);
  return en !== null && an !== null && en === an;
}
