/**
 * Trace contract v1 — privacy denylist (TDD §6).
 *
 * The four party-data regexes are COPIES of `src/azure/semantic-store.js`
 * (parity-tested in `test/trace-contract.test.js`), not imports: this file is
 * copied into the plugin hook and must stay dependency-free.
 */
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const IBAN_RE = /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/;
const VAT_RE = /\b[A-Z]{2}\d{8,12}\b/;
const PHONE_RE = /(?:\+|00)\d[\d\s().-]{7,}\d|\b\d{3}[\s.-]\d{3}[\s.-]\d{4}\b/;
const URL_QUERY_RE = /https?:\/\/[^\s]*\?[^\s]+/;
const DIGIT_RUN_RE = /\d{7,}/g;
/** Key names that announce serialised data rather than metadata. */
export const FORBIDDEN_KEYS_RE = /^(sample|samples|example|examples|value|values|data|record|records|row|rows|payload)$/i;
/** Person-level keys are never allowed anywhere in a record. */
export const PERSON_KEY_RE = /user|principal|upn|oid|email/i;

/** Party-like data in free text: reason or null. Same verdicts as semantic-store.privacyViolation. */
export function partyDataViolation(text) {
  if (text == null) return null;
  const s = String(text);
  if (EMAIL_RE.test(s)) return 'contains an e-mail address';
  if (IBAN_RE.test(s)) return 'contains an IBAN-like token';
  if (VAT_RE.test(s)) return 'contains a VAT-number-like token';
  if (PHONE_RE.test(s)) return 'contains a phone-number-like token';
  return null;
}

/** Full prose denylist: party data + URL with query string. Digit runs are MASKED, not rejected (§13.7). */
export function proseViolation(text) {
  const v = partyDataViolation(text);
  if (v) return v;
  if (URL_QUERY_RE.test(String(text))) return 'contains a URL with a query string';
  return null;
}

/** Mask digit runs ≥ 7 (RecIds quoted in a conclusion) with `#`; returns { text, masked }. */
export function maskDigitRuns(text) {
  let masked = 0;
  const out = String(text ?? '').replace(DIGIT_RUN_RE, () => {
    masked += 1;
    return '#';
  });
  return { text: out, masked };
}

/** A `term` argument: ≤ 100 chars, no party data, no digit run ≥ 5. */
export function termViolation(text) {
  const s = String(text ?? '');
  if (s.length > 100) return 'term longer than 100 characters';
  const v = partyDataViolation(s);
  if (v) return v;
  if (/\d{5,}/.test(s)) return 'term contains a digit run';
  return null;
}
