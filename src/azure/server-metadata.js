/**
 * Server identity metadata for every MCP endpoint in this repo.
 *
 * MCP clients (claude.ai connector directory, Claude Code, Copilot Studio…)
 * render whatever the server returns in the `initialize` result's `serverInfo`
 * (`Implementation`: name, title, version, description, websiteUrl, icons —
 * MCP spec 2025-11-25) plus the `instructions` string. Without these the
 * directory shows a bare hostname and a generic "Custom" placeholder icon.
 *
 * One place for all of it so the Azure Function and the local stdio server of
 * the same service always present identically, and so the RFC 9728
 * protected-resource document can carry the matching `resource_name`.
 *
 * Icons: the Trelleborg mark (assets/mcp-icon-128.png) is embedded as a
 * data: URI so it renders even when the client cannot reach the Function App
 * (auth-gated hosts, offline stdio). When a `baseUrl` is known the https
 * variants (/api/icon.png, /api/icon-512.png — Easy-Auth-excluded) are added
 * as higher-resolution alternatives.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = join(__dirname, '..', '..', 'assets');

let _pkgVersion = null;
export function packageVersion() {
  if (_pkgVersion) return _pkgVersion;
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'));
    _pkgVersion = typeof pkg.version === 'string' ? pkg.version : '1.0.0';
  } catch {
    _pkgVersion = '1.0.0';
  }
  return _pkgVersion;
}

const _icons = new Map();
/** Raw PNG bytes for the icon endpoint. Returns null when the asset is missing. */
export function iconPng(size = 128) {
  const key = size === 512 ? 512 : 128;
  if (_icons.has(key)) return _icons.get(key);
  let buf = null;
  try { buf = readFileSync(join(ASSETS_DIR, `mcp-icon-${key}.png`)); } catch { buf = null; }
  _icons.set(key, buf);
  return buf;
}

let _dataUri = null;
export function iconDataUri() {
  if (_dataUri !== null) return _dataUri || undefined;
  const buf = iconPng(128);
  _dataUri = buf ? `data:image/png;base64,${buf.toString('base64')}` : '';
  return _dataUri || undefined;
}

/** Author / contact shown to consumers (operator identity, approved for publication). */
export const AUTHOR = 'Trelleborg Group — TIS D365 F&O Services';
export const CONTACT_EMAIL = 'florian.dittgen@trelleborg.com';
export const WEBSITE_URL = 'https://github.com/fdittgen-png/D365FOMCP';
export const ATTRIBUTION = `Provided by ${AUTHOR}. Contact / information: ${CONTACT_EMAIL}.`;

/**
 * Per-service identity. `name` is the stable machine identifier (unchanged
 * from before — clients key sessions/permissions on it); `title` is what the
 * directory card shows; `description` is the card body; `instructions` is the
 * server-level usage note the host injects into the model's context — kept
 * short on purpose (it is paid for on every turn).
 */
export const SERVICES = Object.freeze({
  kb: {
    name: 'd365fo-kb',
    title: 'D365 F&O Knowledge Base',
    description:
      'Dynamics 365 Finance & Operations application metadata (AOT) for the Trelleborg TOC365 solution: ' +
      '17k tables and 215k fields with types/EDTs, 45k relations and join keys, enums with numeric values, ' +
      '63k classes with method signatures and X++ source, data entities with field-to-datasource mapping, ' +
      'forms, menu items, labels and per-model build provenance (Microsoft / ISV / custom layer). ' +
      'Includes curated anti-hallucination data: AX2012→D365 field renames, hallucination traps and verified SQL templates. ' +
      'Read-only snapshot; every data response carries its snapshot date.',
    instructions:
      'Start with d365_search or d365_lookup_table; use d365_check_field_exists before asserting a field exists; ' +
      'resolve enums with d365_get_enum; use the `modules` filter to scope to custom/ISV models; ' +
      'd365_raw_sql is last resort (read-only, LIMIT, COLLATE NOCASE). Responses default to TOON — pass format:"markdown" only for human-facing prose.',
  },
  xref: {
    name: 'd365fo-xref',
    title: 'D365 F&O Cross-Reference',
    description:
      'Compiler cross-references for the Trelleborg TOC365 D365 F&O code base: who calls, extends, implements, ' +
      'reads or writes any AOT object — methods, tables, fields, classes, forms, enums, menu items. ' +
      'Covers Microsoft standard, ISV (STAEDEAN, iExtension, HISOL) and the Trelleborg custom layer. ' +
      'Impact analysis, Chain-of-Command extension discovery, event handlers, class hierarchies, interface implementors, ' +
      'cross-module dependencies. Read-only snapshot; every data response carries its snapshot date.',
    instructions:
      'Use xref_object_summary first for counts, then xref_find_references / xref_find_method_callers / xref_find_extensions for detail; ' +
      'xref_impact_analysis before modifying an object. Always pass `limit`; the database is 3 GB — never SELECT * via xref_raw_sql.',
  },
  sec: {
    name: 'd365fo-sec',
    title: 'D365 F&O Security',
    description:
      'Security configuration of the Trelleborg TOC365 D365 F&O tenant: roles, sub-roles, duties, privileges, entry points ' +
      '(menu items, data entities, tables) with Grant/Deny permissions, user-to-role assignments per legal entity, ' +
      'effective-permission resolution (Deny wins), permission traces, role comparison, what-if for additive grants ' +
      'and licence (Team Members / Activity / Operations) assessment. Labels resolved to English text. ' +
      'Internal staff data only — no customer or vendor records. Read-only snapshot; every data response carries its snapshot date.',
    instructions:
      'For "can user X do Y" use sec_effective_permissions or sec_permission_trace (walks role→duty→privilege→entry point, Deny wins). ' +
      'Object names are case-insensitive. Verify every permission claim with a trace before stating it. sec_raw_sql is last resort.',
  },
  taskrecorder: {
    name: 'd365fo-taskrecorder',
    title: 'D365 F&O Task Recorder',
    description:
      'Converts Dynamics 365 F&O Task Recorder recordings (.axtr / task-recording XML, optionally the client reproReport ' +
      'or .docx with screenshots) into structured Markdown or a self-contained enriched MHTML document: ' +
      'each step correlated to the server action, form/table/field technical details from the Knowledge Base, ' +
      'and the roles/duties/privileges that grant access to every form. Used for process documentation, ' +
      'test cases, support reproduction and training material. Stateless — nothing is stored.',
    instructions:
      'Pass the recording file content as text. Use taskrecorder_to_markdown for a quick step list, ' +
      'taskrecorder_to_document for the full enriched document (screenshots + KB + security). Output is a document — treat it as markdown.',
  },
});

/**
 * Wiki servers are configured at runtime (config/wikis.json). Build a service
 * record from the registry entry so they present like the fixed services.
 */
export function wikiService(wiki) {
  return {
    name: `wiki-${wiki.name}`,
    title: wiki.title || `D365 F&O Wiki — ${wiki.name}`,
    description: wiki.description,
    instructions:
      'Use wiki_search for keyword lookup across pages, wiki_index for the table of contents, wiki_read for one page. ' +
      'Pages are markdown; cite the page title when quoting.',
  };
}

/**
 * MCP `Implementation` object for `new McpServer(info, options)`.
 * @param {keyof typeof SERVICES | object} svc  service key or a wikiService() record
 * @param {{ baseUrl?: string }} [opts]         public origin for https icon URLs
 */
export function serverInfo(svc, opts = {}) {
  const rec = typeof svc === 'string' ? SERVICES[svc] : svc;
  if (!rec) throw new Error(`Unknown MCP service "${svc}"`);
  const icons = [];
  const dataUri = iconDataUri();
  if (dataUri) icons.push({ src: dataUri, mimeType: 'image/png', sizes: ['128x128'] });
  const base = typeof opts.baseUrl === 'string' ? opts.baseUrl.replace(/\/+$/, '') : '';
  if (base) {
    icons.push({ src: `${base}/api/icon.png`, mimeType: 'image/png', sizes: ['128x128'] });
    icons.push({ src: `${base}/api/icon-512.png`, mimeType: 'image/png', sizes: ['512x512'] });
  }
  return {
    name: rec.name,
    title: rec.title,
    version: packageVersion(),
    description: `${rec.description} ${ATTRIBUTION}`,
    websiteUrl: WEBSITE_URL,
    ...(icons.length ? { icons } : {}),
  };
}

/** `ServerOptions` for `new McpServer(info, options)`. */
export function serverOptions(svc) {
  const rec = typeof svc === 'string' ? SERVICES[svc] : svc;
  if (!rec) throw new Error(`Unknown MCP service "${svc}"`);
  return { instructions: rec.instructions };
}

/** Compact JSON for the non-SSE health GET on each MCP route. */
export function healthInfo(svc, opts = {}) {
  const info = serverInfo(svc, opts);
  return {
    name: info.name,
    title: info.title,
    version: info.version,
    description: info.description,
    author: AUTHOR,
    contact: CONTACT_EMAIL,
    websiteUrl: info.websiteUrl,
    icon: opts.baseUrl ? `${String(opts.baseUrl).replace(/\/+$/, '')}/api/icon.png` : undefined,
    status: 'ok',
  };
}

/** Derive the public origin from an incoming request (Azure Functions HttpRequest). */
export function requestBaseUrl(request) {
  try {
    const u = new URL(request.url);
    const host = request.headers?.get?.('x-forwarded-host') || u.host;
    const proto = request.headers?.get?.('x-forwarded-proto') || (host.startsWith('localhost') ? 'http' : 'https');
    return `${proto}://${host}`;
  } catch {
    return '';
  }
}

/** Map a resource path (e.g. 'api/d365kb') to the service title for RFC 9728 `resource_name`. */
export function resourceNameForPath(resourcePath) {
  const p = String(resourcePath || '').replace(/^\/+/, '').replace(/\/+$/, '').toLowerCase();
  const map = {
    'api/d365kb': SERVICES.kb.title,
    'api/d365xref': SERVICES.xref.title,
    'api/d365sec': SERVICES.sec.title,
    'api/d365taskrecorder': SERVICES.taskrecorder.title,
  };
  if (map[p]) return map[p];
  if (p.startsWith('api/wiki-mcp/')) return `D365 F&O Wiki — ${p.slice('api/wiki-mcp/'.length)}`;
  return 'Trelleborg D365 F&O MCP Services';
}
