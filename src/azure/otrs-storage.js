/**
 * OTRS extractor state store.
 *
 * Persists the list of already-extracted OTRS ticket IDs so the extractor
 * can run in `mode: "incremental"` and skip tickets Power Automate has
 * already forwarded to the wiki ingestor. A single JSON blob keeps the
 * storage surface trivial — no table, no SQLite, no schema migrations.
 *
 *   container: otrs-state
 *   blob:      otrs-extract-state.json
 *   payload:   { version, lastExtractedAt, processedTicketIds: [string] }
 *
 * Reuses the same AzureWebJobsStorage connection string as blob-helper.js,
 * but with an isolated client so lifecycle policies on `secbuild-uploads`
 * don't sweep our state file.
 */

import {
  BlobServiceClient,
  StorageSharedKeyCredential,
} from '@azure/storage-blob';

const CONTAINER_NAME = 'otrs-state';
const STATE_BLOB_NAME = 'otrs-extract-state.json';
const STATE_VERSION = 1;

let _serviceClient = null;

function getDefaultServiceClient() {
  if (_serviceClient) return _serviceClient;

  const connStr = process.env.AzureWebJobsStorage || '';
  if (!connStr || connStr === 'UseDevelopmentStorage=true') {
    throw new Error('OTRS state blob not available (AzureWebJobsStorage not configured).');
  }

  const parts = Object.fromEntries(
    connStr.split(';').filter(Boolean).map(part => {
      const idx = part.indexOf('=');
      return [part.substring(0, idx), part.substring(idx + 1)];
    }),
  );

  const accountName = parts.AccountName;
  const accountKey = parts.AccountKey;
  if (!accountName || !accountKey) {
    throw new Error('Invalid AzureWebJobsStorage: missing AccountName or AccountKey.');
  }

  _serviceClient = new BlobServiceClient(
    `https://${accountName}.blob.core.windows.net`,
    new StorageSharedKeyCredential(accountName, accountKey),
  );
  return _serviceClient;
}

function getBlobClient(serviceClient) {
  const service = serviceClient || getDefaultServiceClient();
  const container = service.getContainerClient(CONTAINER_NAME);
  return { container, blob: container.getBlockBlobClient(STATE_BLOB_NAME) };
}

/**
 * Read the current state. Returns a fresh empty state when the blob (or
 * container) does not exist yet, so the first run is a no-op instead of a
 * hard error.
 *
 * @param {object} [opts]
 * @param {object} [opts.serviceClient] - injected BlobServiceClient for tests
 * @returns {Promise<{version:number,lastExtractedAt:string|null,processedTicketIds:string[]}>}
 */
export async function readState({ serviceClient } = {}) {
  const { container, blob } = getBlobClient(serviceClient);
  try {
    const buf = await blob.downloadToBuffer();
    const parsed = JSON.parse(buf.toString('utf8'));
    return normalizeState(parsed);
  } catch (err) {
    // A missing blob or container is the first-run case — return empty.
    // Anything else (permissions, network) is a real failure.
    if (isNotFound(err)) {
      try { await container.createIfNotExists(); }
      catch (e) { try { console.warn('cleanup-warn', 'otrs-state-create', e.message); } catch { /* logger unavailable */ } }
      return emptyState();
    }
    throw err;
  }
}

/**
 * Overwrite the state blob. Container is created on demand so callers
 * don't need a separate bootstrap step.
 *
 * @param {{version?:number,lastExtractedAt?:string|null,processedTicketIds?:string[]}} state
 * @param {object} [opts]
 * @param {object} [opts.serviceClient] - injected BlobServiceClient for tests
 */
export async function writeState(state, { serviceClient } = {}) {
  const { container, blob } = getBlobClient(serviceClient);
  await container.createIfNotExists();
  const payload = normalizeState(state);
  const body = JSON.stringify(payload, null, 2);
  await blob.upload(body, Buffer.byteLength(body, 'utf8'), {
    blobHTTPHeaders: { blobContentType: 'application/json; charset=utf-8' },
  });
}

function emptyState() {
  return { version: STATE_VERSION, lastExtractedAt: null, processedTicketIds: [] };
}

function normalizeState(raw) {
  // Filter null/undefined BEFORE stringifying — otherwise they become the
  // literal string "null", which .filter(Boolean) can't remove. Empty
  // strings are dropped on the way out via the post-String Boolean filter.
  const ids = Array.isArray(raw?.processedTicketIds)
    ? raw.processedTicketIds
        .filter(x => x != null)
        .map(String)
        .filter(Boolean)
    : [];
  return {
    version: Number.isInteger(raw?.version) ? raw.version : STATE_VERSION,
    lastExtractedAt: typeof raw?.lastExtractedAt === 'string' ? raw.lastExtractedAt : null,
    processedTicketIds: ids,
  };
}

function isNotFound(err) {
  const code = err?.code || err?.statusCode;
  return code === 404 || code === 'BlobNotFound' || code === 'ContainerNotFound';
}
