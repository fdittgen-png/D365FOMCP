/**
 * Live UI-custom-field reader (issues #87, #89).
 *
 * The only module in this repo that talks to a D365FO environment.
 *
 * Why it exists: fields created through System administration > Setup > Custom
 * fields are held in a *runtime* table extension —
 * `SysCustomFieldModel.getExtensionFieldsForTable()` resolves them via
 * `tableExtensionManager.GetRuntimeExtension(tableName, SysCustomFieldConstants::ExtensionName)`
 * — so they exist in the environment but in no deployed package metadata, and
 * the KB builder can never see them. `SELECT COUNT(*) FROM fields WHERE
 * field_name LIKE '%_Custom'` on a freshly built KB is 0, and always will be.
 * They are also not exportable: the definition table is
 * `SysCustomFieldDefinitionTmp`, a temp table filled on demand, and the only
 * related data entity covers picklist *values*.
 *
 * So they are read live, per request, from the environment's OData `$metadata`
 * — where they appear because `SysCustomFieldModel.updateEntityExtensions()`
 * and `updateStagingTable()` propagate every custom field onto the data
 * entities and their staging tables.
 *
 * Two invariants, both from the ADR (#87):
 *   1. Nothing here writes to a database. A custom field is environment state,
 *      not build metadata, and must never land in `tables` / `fields`.
 *   2. Only metadata is fetched — entity and property *names*. No `$filter`,
 *      no entity sets, no row data, ever: OData row data is party data.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getSecret, KeyVaultError } from './key-vault.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * The D365 framework suffix for UI custom fields.
 *
 * Not a naming convention we are guessing at: `SysCustomFieldModel.
 * getExtensionFieldsForTable()` compares each field of the custom-fields
 * runtime extension against `SysCustomFieldConstants::FieldNameSuffix` and
 * `Debug::assert(false)`s when one does not carry it. Matching on the suffix is
 * therefore sound in both directions.
 */
export const CUSTOM_FIELD_SUFFIX = '_Custom';

/** Does this field name carry the framework suffix? */
export function isCustomFieldName(name) {
  return typeof name === 'string' && name.toUpperCase().endsWith(CUSTOM_FIELD_SUFFIX.toUpperCase());
}

const DEFAULTS = {
  cacheTtlSeconds: 900,
  timeoutMs: 30_000,
  maxBytes: 256 * 1024 * 1024,
};

/** Largest partial tag we will hold across a chunk boundary. An EDMX tag is a
 *  few hundred bytes; 64 KB is three orders of magnitude of headroom and keeps
 *  a pathological input (a `<` with no `>`) from growing the buffer forever. */
const MAX_TAIL_BYTES = 65_536;

/** Thrown for every failure. `category` maps 1:1 onto `errorResult` categories
 *  so the tool layer never has to guess, and `stage` says how far we got. */
export class CustomFieldsError extends Error {
  /** @param {'invalid-input'|'internal'|'parse-error'} category
   *  @param {'config'|'secret'|'token'|'metadata'|'size'|'parse'} stage */
  constructor(category, stage, message) {
    super(message);
    this.name = 'CustomFieldsError';
    this.category = category;
    this.stage = stage;
  }
}

function numFromEnv(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/* ── source registry ─────────────────────────────────────────────────────── */

function normaliseSource(raw, origin) {
  const key = String(raw?.key ?? '').trim().toLowerCase();
  const url = String(raw?.url ?? '').trim().replace(/\/+$/, '');
  const tenantId = String(raw?.tenantId ?? '').trim();
  const clientId = String(raw?.clientId ?? '').trim();
  if (!key || !url || !tenantId || !clientId) return null;
  if (!/^https:\/\//i.test(url)) {
    console.error(`custom-fields: source "${key}" ignored — url must be https`);
    return null;
  }
  return {
    key,
    title: String(raw?.title ?? '').trim() || key,
    url,
    tenantId,
    clientId,
    secretName: String(raw?.secretName ?? '').trim() || `d365-cf-${key}-client-secret`,
    is_default: raw?.default === true,
    origin,
  };
}

function parseRegistry(json, origin) {
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    console.error(`custom-fields: ${origin} is not valid JSON — ignored`);
    return [];
  }
  if (!Array.isArray(parsed)) {
    console.error(`custom-fields: ${origin} must be a JSON array — ignored`);
    return [];
  }
  return parsed.map(s => normaliseSource(s, origin)).filter(Boolean);
}

/**
 * Configured environments, secret-free. Resolution order, first non-empty wins:
 *   1. `CUSTOM_FIELDS_SOURCES` app setting — lets an operator add an
 *      environment without a redeploy (scripts/Set-D365CustomFieldsSource.ps1),
 *   2. `config/custom-field-sources.json` — the committed baseline,
 *   3. `D365_ENV_URL` / `D365_TENANT_ID` / `D365_CLIENT_ID` — local dev.
 *
 * @returns {Array<{key,title,url,tenantId,clientId,secretName,is_default,origin}>}
 */
export function resolveSources() {
  const fromEnv = (process.env.CUSTOM_FIELDS_SOURCES || '').trim();
  if (fromEnv) {
    const sources = parseRegistry(fromEnv, 'CUSTOM_FIELDS_SOURCES');
    if (sources.length) return withDefault(sources);
  }

  try {
    const file = join(__dirname, '..', '..', 'config', 'custom-field-sources.json');
    const sources = parseRegistry(readFileSync(file, 'utf-8'), 'config/custom-field-sources.json');
    if (sources.length) return withDefault(sources);
  } catch {
    // Absent config file is the normal case for a fresh clone.
  }

  const single = normaliseSource({
    key: process.env.D365_ENV_KEY || 'default',
    title: process.env.D365_ENV_TITLE || 'D365FO environment',
    url: process.env.D365_ENV_URL,
    tenantId: process.env.D365_TENANT_ID,
    clientId: process.env.D365_CLIENT_ID,
    secretName: process.env.D365_CLIENT_SECRET_NAME,
    default: true,
  }, 'env');
  return single ? [single] : [];
}

/** Exactly one default: an explicit `default: true` wins, else the first. */
function withDefault(sources) {
  if (sources.some(s => s.is_default)) {
    let seen = false;
    return sources.map(s => {
      const keep = s.is_default && !seen;
      if (keep) seen = true;
      return { ...s, is_default: keep };
    });
  }
  return sources.map((s, i) => ({ ...s, is_default: i === 0 }));
}

/**
 * Pick a source by key, or the default when no key is given.
 * @throws {CustomFieldsError} invalid-input, with the configured keys listed.
 */
export function selectSource(environment) {
  const sources = resolveSources();
  if (!sources.length) {
    throw new CustomFieldsError('invalid-input', 'config',
      'No D365 environment is configured as a custom-field source. ' +
      'Configure one with scripts/Set-D365CustomFieldsSource.ps1 (see docs/Administration.md).');
  }
  if (!environment) return sources.find(s => s.is_default) || sources[0];

  const wanted = String(environment).trim().toLowerCase();
  const hit = sources.find(s => s.key === wanted);
  if (!hit) {
    throw new CustomFieldsError('invalid-input', 'config',
      `Unknown environment "${environment}". Configured: ${sources.map(s => s.key).join(', ')}.`);
  }
  return hit;
}

/* ── token ───────────────────────────────────────────────────────────────── */

/** key → { token, expiresAt } */
const tokenCache = new Map();

async function getToken(source) {
  const hit = tokenCache.get(source.key);
  if (hit && hit.expiresAt > Date.now()) return hit.token;

  let secret;
  try {
    secret = await getSecret(source.secretName);
  } catch (err) {
    if (err instanceof KeyVaultError) {
      throw new CustomFieldsError('internal', 'secret', err.message);
    }
    console.error('custom-fields: unexpected secret failure', err);
    throw new CustomFieldsError('internal', 'secret', 'Could not read the client secret.');
  }

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: source.clientId,
    client_secret: secret,
    scope: `${source.url}/.default`,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), numFromEnv('CUSTOM_FIELDS_TIMEOUT_MS', DEFAULTS.timeoutMs));
  let res;
  try {
    res = await fetch(`https://login.microsoftonline.com/${source.tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: controller.signal,
    });
  } catch (err) {
    console.error(`custom-fields: token request failed for ${source.key}`, err);
    throw new CustomFieldsError('internal', 'token',
      `Could not reach the token endpoint for ${source.key}.`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    // The error body names the tenant and sometimes the app — log it, never
    // return it.
    const detail = await res.text().catch(() => '');
    console.error(`custom-fields: token HTTP ${res.status} for ${source.key}: ${detail.slice(0, 500)}`);
    throw new CustomFieldsError('internal', 'token',
      `Token request for ${source.key} failed (HTTP ${res.status}). Check the client secret in Key Vault ` +
      `and that the app registration is listed under System administration > Setup > Microsoft Entra applications.`);
  }

  const json = await res.json().catch(() => null);
  if (!json?.access_token) {
    throw new CustomFieldsError('internal', 'token', `Token response for ${source.key} carried no access_token.`);
  }

  const lifetime = Number(json.expires_in) || 3600;
  tokenCache.set(source.key, {
    token: json.access_token,
    expiresAt: Date.now() + Math.max(0, lifetime - 60) * 1000,
  });
  return json.access_token;
}

/* ── the scanner ─────────────────────────────────────────────────────────── */

/**
 * Forward scanner over EDMX text, fed chunk by chunk.
 *
 * `$metadata` for a D365FO environment is tens of megabytes, so it is neither
 * buffered nor handed to an XML parser. This tracks the innermost
 * EntityType/ComplexType and collects the properties carrying the framework
 * suffix.
 *
 * The interesting case is a tag split across two chunks. After each pass the
 * scanner retains everything from the last unterminated `<` onward, so a
 * partially received tag is re-examined with the next chunk instead of being
 * lost. `test/custom-fields.test.js` splits a fixture at every offset inside a
 * `<Property>` tag and asserts the result never changes.
 *
 * Exported directly (not just through `fetchCustomFields`) so it can be tested
 * without a network.
 */
export function createMetadataScanner() {
  const fields = [];
  const entities = new Set();
  let buf = '';
  let current = null;
  let truncatedTail = false;

  // One pass matches: type open, type close, or a Property tag.
  const TAG = /<(EntityType|ComplexType)\s[^>]*?>|<\/(EntityType|ComplexType)\s*>|<Property\s[^>]*?>/g;
  const attr = (tag, name) => {
    const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
    return m ? m[1] : null;
  };

  function drain() {
    TAG.lastIndex = 0;
    let lastEnd = 0;
    let m;
    while ((m = TAG.exec(buf)) !== null) {
      const tag = m[0];
      lastEnd = m.index + tag.length;

      if (m[1]) {                                   // <EntityType …> / <ComplexType …>
        current = attr(tag, 'Name');
        // A self-closing type carries no properties; do not let it stay current.
        if (/\/>\s*$/.test(tag)) current = null;
        continue;
      }
      if (m[2]) { current = null; continue; }       // </EntityType> / </ComplexType>

      if (!current) continue;                       // a Property outside a type: ignore
      const name = attr(tag, 'Name');
      if (!name || !isCustomFieldName(name)) continue;

      // MaxLength is absent on every non-string type. `Number(null)` is 0,
      // which would report `max_length: 0` for an Edm.Int32 — a plausible-
      // looking wrong answer. Only parse it when the attribute is there.
      const maxLengthRaw = attr(tag, 'MaxLength');
      let maxLength = null;
      if (maxLengthRaw !== null) {
        const n = Number(maxLengthRaw);
        // 'max' is legal in EDMX for an unbounded string.
        maxLength = Number.isFinite(n) ? n : null;
      }
      // OData 4.0: the Nullable attribute defaults to true when omitted. That
      // is the spec, not an inference, so apply it rather than reporting null
      // and making every caller re-derive it.
      const nullableRaw = attr(tag, 'Nullable');
      fields.push({
        entity_name: current,
        property_name: name,
        type: attr(tag, 'Type'),
        nullable: nullableRaw === null ? true : nullableRaw !== 'false',
        max_length: maxLength,
      });
      entities.add(current);
    }

    // Retain any unterminated tag. `lastOpen > lastEnd` means a `<` arrived
    // that we have not been able to close yet — keep it and everything after.
    const lastOpen = buf.lastIndexOf('<');
    let keepFrom = lastOpen > lastEnd ? lastOpen : lastEnd;
    if (buf.length - keepFrom > MAX_TAIL_BYTES) {
      // Pathological input: an unterminated `<` for more than the tail budget.
      // Drop it rather than growing without bound, and record that we did.
      truncatedTail = true;
      keepFrom = buf.length;
    }
    buf = buf.slice(keepFrom);
  }

  return {
    /** Feed one decoded chunk. */
    push(text) {
      if (!text) return;
      buf += text;
      drain();
    },
    /** No more input. Returns the collected inventory. */
    finish() {
      drain();
      return {
        fields,
        entity_count: entities.size,
        property_count: fields.length,
        truncated_tail: truncatedTail,
      };
    },
  };
}

/** Convenience for tests and for any caller holding the whole document. */
export function scanMetadata(text) {
  const scanner = createMetadataScanner();
  scanner.push(text);
  return scanner.finish();
}

/* ── fetch + cache ───────────────────────────────────────────────────────── */

/** source key → { result, expiresAt } */
const resultCache = new Map();
/** source key → { at, message } — surfaced by getCacheState for diagnostics. */
const lastErrors = new Map();

/**
 * Custom-field inventory of one environment, live.
 *
 * @param {{ environment?: string, refresh?: boolean }} [opts]
 * @returns {Promise<{environment,title,url,fetched_at,bytes_scanned,entity_count,property_count,cached,fields:Array}>}
 * @throws {CustomFieldsError}
 */
export async function fetchCustomFields(opts = {}) {
  const source = selectSource(opts.environment);
  const ttl = numFromEnv('CUSTOM_FIELDS_CACHE_TTL_SECONDS', DEFAULTS.cacheTtlSeconds) * 1000;

  if (!opts.refresh) {
    const hit = resultCache.get(source.key);
    if (hit && hit.expiresAt > Date.now()) return { ...hit.result, cached: true };
  }

  const token = await getToken(source);
  const maxBytes = numFromEnv('CUSTOM_FIELDS_MAX_BYTES', DEFAULTS.maxBytes);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), numFromEnv('CUSTOM_FIELDS_TIMEOUT_MS', DEFAULTS.timeoutMs));

  let res;
  try {
    res = await fetch(`${source.url}/data/$metadata`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/xml',
        'accept-encoding': 'gzip, deflate',
      },
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    console.error(`custom-fields: $metadata request failed for ${source.key}`, err);
    lastErrors.set(source.key, { at: new Date().toISOString(), message: 'request failed' });
    throw new CustomFieldsError('internal', 'metadata',
      `Could not reach ${source.key} at ${source.url}.`);
  }

  if (!res.ok) {
    clearTimeout(timer);
    const detail = await res.text().catch(() => '');
    console.error(`custom-fields: $metadata HTTP ${res.status} for ${source.key}: ${detail.slice(0, 500)}`);
    lastErrors.set(source.key, { at: new Date().toISOString(), message: `HTTP ${res.status}` });
    throw new CustomFieldsError('internal', 'metadata',
      `${source.key} returned HTTP ${res.status} for /data/$metadata. ` +
      'The service account behind the app registration may not have access.');
  }

  const scanner = createMetadataScanner();
  const decoder = new TextDecoder('utf-8');
  let bytes = 0;

  try {
    for await (const chunk of res.body) {
      bytes += chunk.byteLength ?? chunk.length ?? 0;
      if (bytes > maxBytes) {
        controller.abort();
        lastErrors.set(source.key, { at: new Date().toISOString(), message: 'size ceiling' });
        throw new CustomFieldsError('internal', 'size',
          `/data/$metadata from ${source.key} exceeded ${maxBytes} bytes; aborted rather than return a partial inventory.`);
      }
      scanner.push(decoder.decode(chunk, { stream: true }));
    }
    scanner.push(decoder.decode());
  } catch (err) {
    if (err instanceof CustomFieldsError) throw err;
    console.error(`custom-fields: stream failed for ${source.key}`, err);
    lastErrors.set(source.key, { at: new Date().toISOString(), message: 'stream failed' });
    throw new CustomFieldsError('internal', 'metadata', `Reading /data/$metadata from ${source.key} failed.`);
  } finally {
    clearTimeout(timer);
  }

  const scanned = scanner.finish();
  if (scanned.truncated_tail) {
    throw new CustomFieldsError('parse-error', 'parse',
      `/data/$metadata from ${source.key} was not parseable as EDMX (unterminated tag beyond the tail budget).`);
  }
  if (bytes === 0) {
    throw new CustomFieldsError('parse-error', 'parse', `/data/$metadata from ${source.key} was empty.`);
  }

  const result = {
    environment: source.key,
    title: source.title,
    url: source.url,
    fetched_at: new Date().toISOString(),
    bytes_scanned: bytes,
    entity_count: scanned.entity_count,
    property_count: scanned.property_count,
    fields: scanned.fields,
  };

  resultCache.set(source.key, { result, expiresAt: Date.now() + ttl });
  lastErrors.delete(source.key);
  return { ...result, cached: false };
}

/** Per-source cache state for the diagnostics tool. No tokens, no secrets. */
export function getCacheState() {
  const now = Date.now();
  return resolveSources().map(s => {
    const hit = resultCache.get(s.key);
    const err = lastErrors.get(s.key);
    return {
      environment: s.key,
      title: s.title,
      url: s.url,
      is_default: s.is_default,
      origin: s.origin,
      cached: Boolean(hit && hit.expiresAt > now),
      cached_property_count: hit ? hit.result.property_count : null,
      fetched_at: hit ? hit.result.fetched_at : null,
      cache_expires_in_seconds: hit ? Math.max(0, Math.round((hit.expiresAt - now) / 1000)) : null,
      last_error: err ? `${err.message} at ${err.at}` : null,
    };
  });
}

/** Test seam. */
export function clearCustomFieldsCache() {
  resultCache.clear();
  tokenCache.clear();
  lastErrors.clear();
}
