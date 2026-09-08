/**
 * Schema validation of trace records with AJV (the SDK client's own validator,
 * already in node_modules). Server- and test-side only — the plugin hook does
 * not carry AJV and relies on `sanitize()`, whose output this validator is
 * asserted to accept in `test/trace-contract.test.js`.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const Ajv = /** @type {any} */ (require('ajv'));
const addFormats = /** @type {any} */ (require('ajv-formats'));

const __dirname = dirname(fileURLToPath(import.meta.url));
export const SCHEMA_PATH = join(__dirname, 'trace-record.v1.schema.json');

let compiled = null;

export function traceSchema() {
  return JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
}

/** Compiled validator (cached). Returns `(record) => boolean`, errors on `.errors`. */
export function traceValidator() {
  if (compiled) return compiled;
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  compiled = ajv.compile(traceSchema());
  return compiled;
}

/** `{ ok: true }` or `{ ok: false, errors: string[] }` (paths + messages, never values). */
export function validateRecord(record) {
  const v = traceValidator();
  if (v(record)) return { ok: true };
  // `additionalProperties` errors name the offending key only in params — append it so a
  // consumer (the ingest dead letter) can say WHICH key, never its value.
  return {
    ok: false,
    errors: (v.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}${e.params?.additionalProperty ? ` '${e.params.additionalProperty}'` : ''}`),
  };
}
