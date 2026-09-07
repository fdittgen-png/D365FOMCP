/**
 * Trace contract v1 — identifiers and ids (TDD §5.1).
 *
 * Dependency-free on purpose: this file is COPIED into the plugin hook
 * (`plugin/d365fo-mcp/hooks/lib/`) by `build/gen-trace-hook.js`, so it may
 * import Node built-ins only. `test/trace-generated.test.js` keeps the copies
 * identical.
 */
import { randomBytes } from 'node:crypto';

export const CONTRACT_VERSION = '1.0.0';

/** Starts with a letter (an optional leading `%`/`*` wildcard allowed, `fields_like: '%Vend%'` is a replayable
 *  search) — never a digit, so no RecId, account number or amount can pass as one. */
export const IDENTIFIER_RE = /^[%*]?[A-Za-z][A-Za-z0-9_.:/%*-]{0,127}$/;
export const ID_RE = /^(mcp|claude)_[0-9A-HJKMNP-TV-Z]{26}$/;

export function isIdentifier(v) {
  return typeof v === 'string' && IDENTIFIER_RE.test(v);
}

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** ULID: 10 chars of ms time + 16 chars of randomness, Crockford base32, time-ordered. */
export function ulid(now = Date.now()) {
  let t = now;
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = B32[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const rnd = randomBytes(16);
  let rand = '';
  for (let i = 0; i < 16; i++) rand += B32[rnd[i] % 32];
  return time + rand;
}

/** Record id: `<stream>_<ULID>`. */
export function makeId(stream, now) {
  if (stream !== 'mcp' && stream !== 'claude') throw new Error(`unknown stream ${stream}`);
  return `${stream}_${ulid(now)}`;
}

/** Investigation id from a client-side correlation token (Claude Code `prompt_id`),
 *  else a fresh ULID. Always identifier-grammar valid. */
export function investigationId(token) {
  const t = typeof token === 'string' ? token.replace(/[^A-Za-z0-9_.:/-]/g, '') : '';
  return t ? `inv-${t}`.slice(0, 128) : `inv-${ulid()}`;
}

/** `req.<slug>` from a prose line: lowercase, non-alphanumerics → `_`, ≤ 60 chars. */
export function requestKey(text) {
  const full = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  let slug = full.slice(0, 60);
  // a truncated slug is cut on a word boundary once past the midpoint, never mid-word
  if (full.length > 60) slug = slug.replace(/_[^_]*$/, (m, off) => (off >= 30 ? '' : m));
  slug = slug.replace(/_+$/g, '');
  return slug ? `req.${slug}` : 'req.unspecified';
}
