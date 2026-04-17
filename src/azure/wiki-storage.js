/**
 * Wiki blob storage — read markdown pages + index from Azure Blob Storage.
 *
 * One `WikiStore` instance per wiki (one per WikiConfig). The storage layer
 * takes a blob `serviceClient` so tests can inject a fake — no network, no
 * hidden singletons.
 *
 * Caching: a process-wide TTL cache keyed by `container/blobName`. The wiki
 * changes no more than a handful of times per day (Power Automate ingests
 * new tickets on a schedule), so a 60 s TTL is a good trade between
 * freshness and per-request latency.
 *
 * YAML frontmatter parsing: handled by `parseFrontmatter()` — a minimal
 * parser that understands scalar keys, string/boolean/number/null values,
 * and string arrays (the only shapes we write in `otrs-to-wiki`). It is
 * NOT a full YAML parser; keep the wiki pages within these shapes.
 */

import {
  BlobServiceClient,
  StorageSharedKeyCredential,
} from '@azure/storage-blob';

// ── Blob service client ──────────────────────────────────────────────────────

let _defaultClient = null;

/** Build a BlobServiceClient from AzureWebJobsStorage. Cached. */
export function getDefaultServiceClient() {
  if (_defaultClient) return _defaultClient;

  const connStr = process.env.AzureWebJobsStorage || '';
  if (!connStr || connStr === 'UseDevelopmentStorage=true') {
    throw new Error('Wiki storage not available (AzureWebJobsStorage not configured).');
  }

  const parts = Object.fromEntries(
    connStr.split(';').filter(Boolean).map(p => {
      const idx = p.indexOf('=');
      return [p.substring(0, idx), p.substring(idx + 1)];
    }),
  );

  const accountName = parts.AccountName;
  const accountKey = parts.AccountKey;
  if (!accountName || !accountKey) {
    throw new Error('Invalid AzureWebJobsStorage: missing AccountName or AccountKey.');
  }

  _defaultClient = new BlobServiceClient(
    `https://${accountName}.blob.core.windows.net`,
    new StorageSharedKeyCredential(accountName, accountKey),
  );
  return _defaultClient;
}

// ── TTL cache ────────────────────────────────────────────────────────────────

const TTL_MS = 60_000;
const _cache = new Map(); // key = `${container}/${blobName}` → { value, fetchedAt }

/**
 * Lookup that distinguishes "never fetched" from "fetched and got null".
 * We need the distinction because a missing blob is a valid cache entry —
 * we don't want to re-hit blob storage on every `getIndex()` call for a
 * wiki that hasn't uploaded its index yet.
 *
 * @returns {{hit:true, value:any} | {hit:false}}
 */
function cacheGet(key) {
  const entry = _cache.get(key);
  if (!entry) return { hit: false };
  if (Date.now() - entry.fetchedAt > TTL_MS) {
    _cache.delete(key);
    return { hit: false };
  }
  return { hit: true, value: entry.value };
}

function cacheSet(key, value) {
  _cache.set(key, { value, fetchedAt: Date.now() });
}

/** Exported for tests — drop all cached blob contents. */
export function _resetCache() { _cache.clear(); }

// ── Store factory ────────────────────────────────────────────────────────────

/**
 * @param {import('./wiki-registry.js').WikiConfig} wiki
 * @param {object} [opts]
 * @param {BlobServiceClient} [opts.serviceClient] - injected for tests
 * @returns {WikiStore}
 */
export function createWikiStore(wiki, { serviceClient = null } = {}) {
  const client = serviceClient || getDefaultServiceClient();
  const container = client.getContainerClient(wiki.container);

  /**
   * Read a blob as UTF-8 text. Returns null when the blob does not exist.
   * Throws on any other error.
   */
  async function downloadText(blobName) {
    const key = `${wiki.container}/${blobName}`;
    const cached = cacheGet(key);
    if (cached.hit) return cached.value;

    const blob = container.getBlobClient(blobName);
    try {
      const dl = await blob.download();
      const buf = await streamToBuffer(dl.readableStreamBody);
      const value = {
        content: buf.toString('utf8'),
        lastModified: dl.lastModified ? new Date(dl.lastModified).toISOString() : null,
        contentLength: typeof dl.contentLength === 'number' ? dl.contentLength : buf.length,
      };
      cacheSet(key, value);
      return value;
    } catch (err) {
      if (isNotFound(err)) {
        cacheSet(key, null);
        return null;
      }
      throw err;
    }
  }

  /** Read the wiki's index page. Returns null when absent (fresh wiki). */
  async function getIndex() {
    return downloadText(wiki.indexBlob);
  }

  /** Read a single page by slug. The slug is the blob name relative to pagesPrefix, without `.md`. */
  async function getPage(slug) {
    const name = slugToBlobName(wiki, slug);
    const blob = await downloadText(name);
    if (!blob) return null;
    const parsed = parseMarkdown(blob.content);
    return {
      slug,
      blobName: name,
      title: parsed.frontmatter.title || deriveTitle(parsed.body) || slug,
      frontmatter: parsed.frontmatter,
      body: parsed.body,
      content: blob.content,
      lastModified: blob.lastModified,
    };
  }

  /**
   * List every page under `pagesPrefix` (excluding the index).
   * Returns blob names and cached per-page metadata (title, summary, tags,
   * lastModified) parsed from frontmatter.
   */
  async function listPages({ limit = null } = {}) {
    const pages = [];
    const listPrefix = wiki.pagesPrefix || '';
    // Note: listBlobsFlat() returns everything — we filter out the index
    // blob in case it lives under the same prefix.
    for await (const b of container.listBlobsFlat({ prefix: listPrefix })) {
      if (!b.name.toLowerCase().endsWith('.md')) continue;
      if (b.name === wiki.indexBlob) continue;
      pages.push({
        blobName: b.name,
        slug: blobNameToSlug(wiki, b.name),
        lastModified: b.properties?.lastModified
          ? new Date(b.properties.lastModified).toISOString()
          : null,
        sizeBytes: b.properties?.contentLength ?? 0,
      });
      if (limit != null && pages.length >= limit) break;
    }
    pages.sort((a, b) => a.slug.localeCompare(b.slug));
    return pages;
  }

  /**
   * Read every page into memory. Used by search. Each entry includes the
   * parsed frontmatter + body so search doesn't re-parse per query.
   * The whole listing is cached via the individual-page cache.
   */
  async function loadAllPages() {
    const listing = await listPages();
    const out = [];
    for (const item of listing) {
      const dl = await downloadText(item.blobName);
      if (!dl) continue;
      const parsed = parseMarkdown(dl.content);
      out.push({
        slug: item.slug,
        blobName: item.blobName,
        title: parsed.frontmatter.title || deriveTitle(parsed.body) || item.slug,
        frontmatter: parsed.frontmatter,
        body: parsed.body,
        content: dl.content,
        lastModified: dl.lastModified,
      });
    }
    return out;
  }

  /**
   * Freshness marker for the wiki — the lastModified of the index blob
   * (our analog of the DB `build_date`). Null when the index is absent.
   * Formatted as the existing freshnessBanner helper does.
   */
  async function freshnessBanner() {
    const idx = await getIndex();
    if (!idx || !idx.lastModified) return '';
    return `_wiki:${wiki.name} snapshot: ${idx.lastModified}_\n\n`;
  }

  return {
    wiki,
    getIndex,
    getPage,
    listPages,
    loadAllPages,
    freshnessBanner,
    _downloadText: downloadText, // exported for tests only
  };
}

// ── Slug <-> blob name ───────────────────────────────────────────────────────

export function slugToBlobName(wiki, slug) {
  const safe = String(slug).replace(/\\/g, '/').replace(/\.md$/i, '');
  // Defensive: strip leading slashes to keep the path inside pagesPrefix.
  const cleaned = safe.replace(/^\/+/, '');
  return `${wiki.pagesPrefix || ''}${cleaned}.md`;
}

export function blobNameToSlug(wiki, blobName) {
  const prefix = wiki.pagesPrefix || '';
  let s = blobName;
  if (prefix && s.startsWith(prefix)) s = s.slice(prefix.length);
  return s.replace(/\.md$/i, '');
}

// ── Frontmatter + title parsing ──────────────────────────────────────────────

export function parseMarkdown(text) {
  const { frontmatter, body } = splitFrontmatter(text);
  return { frontmatter: parseFrontmatter(frontmatter), body };
}

function splitFrontmatter(text) {
  if (typeof text !== 'string' || !text.startsWith('---')) {
    return { frontmatter: '', body: text || '' };
  }
  // Accept both LF and CRLF line endings.
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { frontmatter: '', body: text };
  return { frontmatter: m[1], body: m[2] };
}

/**
 * Minimal YAML frontmatter parser. Supports:
 *   key: value
 *   key: "quoted value"
 *   key: [a, b, c]          (string arrays)
 *   key:                    (empty → null)
 *   # comment                (ignored)
 *
 * Any line we can't parse is skipped rather than erroring — the wiki
 * author should use a real YAML tool for anything more exotic.
 */
export function parseFrontmatter(text) {
  const out = {};
  if (!text) return out;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    const value = m[2];
    out[key] = parseScalar(value);
  }
  return out;
}

function parseScalar(v) {
  if (!v) return null;
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  }
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null' || v === '~') return null;
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  if (/^-?\d+\.\d+$/.test(v)) return parseFloat(v);
  return v;
}

/** Derive a title from the first `# Heading` line of the body. */
function deriveTitle(body) {
  if (!body) return null;
  const m = body.match(/^\s*#\s+(.+?)\s*$/m);
  return m ? m[1] : null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', chunk => chunks.push(chunk instanceof Buffer ? chunk : Buffer.from(chunk)));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

function isNotFound(err) {
  const code = err?.code || err?.statusCode;
  return code === 404 || code === 'BlobNotFound' || code === 'ContainerNotFound';
}

/**
 * @typedef {object} WikiStore
 * @property {import('./wiki-registry.js').WikiConfig} wiki
 * @property {() => Promise<{content:string,lastModified:string|null,contentLength:number}|null>} getIndex
 * @property {(slug:string) => Promise<WikiPage|null>} getPage
 * @property {(opts?:{limit?:number}) => Promise<WikiPageListing[]>} listPages
 * @property {() => Promise<WikiPage[]>} loadAllPages
 * @property {() => Promise<string>} freshnessBanner
 *
 * @typedef {object} WikiPage
 * @property {string} slug
 * @property {string} blobName
 * @property {string} title
 * @property {Record<string, unknown>} frontmatter
 * @property {string} body
 * @property {string} content
 * @property {string|null} lastModified
 *
 * @typedef {object} WikiPageListing
 * @property {string} blobName
 * @property {string} slug
 * @property {string|null} lastModified
 * @property {number} sizeBytes
 */
