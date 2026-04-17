/**
 * Wiki blob writer — companion to `wiki-storage.js` (reader).
 *
 * The ingestor writes through this module exclusively, which gives us one
 * place to:
 *   - honor the wiki's `pagesPrefix` when turning a slug into a blob name
 *   - invalidate the reader's TTL cache on every write so the next LLM
 *     call sees fresh content instead of waiting 60 s
 *   - stream writes idempotently (blob upload with overwrite)
 *
 * Just like the reader, the writer accepts an injected `serviceClient` so
 * tests can use a fake BlobServiceClient.
 */

import { getDefaultServiceClient, _resetCache, slugToBlobName } from './wiki-storage.js';

/**
 * @param {import('./wiki-registry.js').WikiConfig} wiki
 * @param {object} [opts]
 * @param {object} [opts.serviceClient] - injected BlobServiceClient for tests
 * @returns {WikiWriter}
 */
export function createWikiWriter(wiki, { serviceClient = null } = {}) {
  const client = serviceClient || getDefaultServiceClient();
  const container = client.getContainerClient(wiki.container);

  /** Create the container idempotently on first write. */
  async function ensureContainer() {
    await container.createIfNotExists();
  }

  /**
   * Upsert a page by slug. `content` is the whole markdown file — the
   * writer does not inject frontmatter or modify it. Returns the resulting
   * blob name so the caller can log what actually landed.
   */
  async function writePage(slug, content, { contentType = 'text/markdown; charset=utf-8' } = {}) {
    await ensureContainer();
    const blobName = slugToBlobName(wiki, slug);
    const blob = container.getBlockBlobClient(blobName);
    const body = typeof content === 'string' ? content : String(content ?? '');
    await blob.upload(body, Buffer.byteLength(body, 'utf8'), {
      blobHTTPHeaders: { blobContentType: contentType },
    });
    _resetCache(); // next reader call sees the new bytes
    return blobName;
  }

  /**
   * Overwrite the index blob (usually `index.md`).
   */
  async function writeIndex(content) {
    await ensureContainer();
    const blob = container.getBlockBlobClient(wiki.indexBlob);
    const body = typeof content === 'string' ? content : String(content ?? '');
    await blob.upload(body, Buffer.byteLength(body, 'utf8'), {
      blobHTTPHeaders: { blobContentType: 'text/markdown; charset=utf-8' },
    });
    _resetCache();
    return wiki.indexBlob;
  }

  /**
   * Delete a page by slug. Returns true when the blob existed, false when
   * it didn't — an idempotent-delete contract. Errors other than
   * not-found propagate.
   */
  async function deletePage(slug) {
    const blobName = slugToBlobName(wiki, slug);
    const blob = container.getBlockBlobClient(blobName);
    const result = await blob.deleteIfExists();
    _resetCache();
    return Boolean(result?.succeeded);
  }

  return { wiki, writePage, writeIndex, deletePage, ensureContainer };
}

/**
 * @typedef {object} WikiWriter
 * @property {import('./wiki-registry.js').WikiConfig} wiki
 * @property {(slug:string, content:string, opts?:{contentType?:string}) => Promise<string>} writePage
 * @property {(content:string) => Promise<string>} writeIndex
 * @property {(slug:string) => Promise<boolean>} deletePage
 * @property {() => Promise<void>} ensureContainer
 */
