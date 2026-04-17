/**
 * Direct unit tests for src/azure/otrs-storage.js.
 *
 * The state-blob helper is covered only indirectly by the extractor test
 * suite (which mocks the whole orchestration) — these tests exercise
 * `readState` and `writeState` against a fake BlobServiceClient and
 * pin down the contract:
 *
 *   - readState returns an empty state when the blob is missing
 *   - readState returns an empty state when the container is missing,
 *     and quietly ensures the container on the return trip
 *   - readState normalizes malformed payloads (non-array IDs, wrong types)
 *   - readState re-throws anything that's not a not-found
 *   - writeState persists JSON, respects injected-client isolation
 *   - writeState + readState round-trip is lossless for supported shapes
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { readState, writeState } from '../src/azure/otrs-storage.js';

// ── Fake BlobServiceClient ───────────────────────────────────────────────────
//
// The OTRS store calls:
//   svc.getContainerClient(name) →
//     container.createIfNotExists()
//     container.getBlockBlobClient(name) →
//       blob.downloadToBuffer()
//       blob.upload(body, len, opts)

function makeClient({ initialBlob = null, missingContainer = false, downloadError = null } = {}) {
  const state = {
    // simulate the container existing or not; createIfNotExists flips it on.
    containerExists: !missingContainer,
    blobPayload: initialBlob, // string | null
    uploads: [],
    createIfNotExistsCalls: 0,
    downloadCalls: 0,
  };
  const svc = {
    state,
    getContainerClient(_name) {
      return {
        async createIfNotExists() {
          state.createIfNotExistsCalls++;
          state.containerExists = true;
        },
        getBlockBlobClient(_blobName) {
          return {
            async downloadToBuffer() {
              state.downloadCalls++;
              if (downloadError) throw downloadError;
              if (!state.containerExists) {
                const err = new Error('ContainerNotFound');
                err.code = 'ContainerNotFound';
                err.statusCode = 404;
                throw err;
              }
              if (state.blobPayload == null) {
                const err = new Error('BlobNotFound');
                err.code = 'BlobNotFound';
                err.statusCode = 404;
                throw err;
              }
              return Buffer.from(state.blobPayload, 'utf8');
            },
            async upload(body, len, _opts) {
              state.uploads.push({ body: String(body), len });
              state.blobPayload = String(body);
            },
          };
        },
      };
    },
  };
  return svc;
}

// ── readState ────────────────────────────────────────────────────────────────

describe('readState — missing blob', () => {
  it('returns empty state when the blob does not exist', async () => {
    // Arrange
    const svc = makeClient({ initialBlob: null });
    // Act
    const state = await readState({ serviceClient: svc });
    // Assert
    assert.deepEqual(state, { version: 1, lastExtractedAt: null, processedTicketIds: [] });
  });

  it('creates the container on a 404 read so the next write has a target', async () => {
    const svc = makeClient({ missingContainer: true });
    await readState({ serviceClient: svc });
    assert.equal(svc.state.createIfNotExistsCalls, 1);
    assert.equal(svc.state.containerExists, true);
  });
});

describe('readState — parsing', () => {
  it('parses a well-formed payload', async () => {
    const svc = makeClient({
      initialBlob: JSON.stringify({
        version: 1,
        lastExtractedAt: '2026-04-10T12:00:00.000Z',
        processedTicketIds: ['1001', '1002'],
      }),
    });
    const state = await readState({ serviceClient: svc });
    assert.equal(state.version, 1);
    assert.equal(state.lastExtractedAt, '2026-04-10T12:00:00.000Z');
    assert.deepEqual(state.processedTicketIds, ['1001', '1002']);
  });

  it('coerces numeric IDs to strings', async () => {
    const svc = makeClient({
      initialBlob: JSON.stringify({ processedTicketIds: [100, 200] }),
    });
    const state = await readState({ serviceClient: svc });
    assert.deepEqual(state.processedTicketIds, ['100', '200']);
  });

  it('replaces a non-array processedTicketIds with an empty array', async () => {
    const svc = makeClient({
      initialBlob: JSON.stringify({ processedTicketIds: 'not-an-array' }),
    });
    const state = await readState({ serviceClient: svc });
    assert.deepEqual(state.processedTicketIds, []);
  });

  it('coerces a non-integer version to the default 1', async () => {
    const svc = makeClient({
      initialBlob: JSON.stringify({ version: 'v1', processedTicketIds: [] }),
    });
    const state = await readState({ serviceClient: svc });
    assert.equal(state.version, 1);
  });

  it('nulls out a non-string lastExtractedAt', async () => {
    const svc = makeClient({
      initialBlob: JSON.stringify({ lastExtractedAt: 42, processedTicketIds: [] }),
    });
    const state = await readState({ serviceClient: svc });
    assert.equal(state.lastExtractedAt, null);
  });

  it('filters out empty / falsy IDs', async () => {
    const svc = makeClient({
      initialBlob: JSON.stringify({ processedTicketIds: ['1001', '', null, 0, '1002'] }),
    });
    const state = await readState({ serviceClient: svc });
    // 0 stringifies to "0" (truthy when String()), but we filter after the
    // coercion — "0" survives, empty and null do not.
    assert.deepEqual(state.processedTicketIds, ['1001', '0', '1002']);
  });
});

describe('readState — error propagation', () => {
  it('re-throws non-404 errors', async () => {
    const boom = new Error('network down');
    boom.code = 'ECONNRESET';
    const svc = makeClient({ downloadError: boom });
    await assert.rejects(
      () => readState({ serviceClient: svc }),
      /network down/,
    );
  });

  it('re-throws JSON parse errors on a corrupt blob', async () => {
    const svc = makeClient({ initialBlob: 'not-json-at-all' });
    await assert.rejects(() => readState({ serviceClient: svc }), SyntaxError);
  });
});

// ── writeState ───────────────────────────────────────────────────────────────

describe('writeState', () => {
  it('persists the payload and ensures the container', async () => {
    const svc = makeClient({ missingContainer: true });
    const state = {
      lastExtractedAt: '2026-04-10T12:00:00.000Z',
      processedTicketIds: ['42', '43'],
    };
    await writeState(state, { serviceClient: svc });

    assert.equal(svc.state.createIfNotExistsCalls, 1);
    assert.equal(svc.state.uploads.length, 1);
    const parsed = JSON.parse(svc.state.uploads[0].body);
    assert.equal(parsed.version, 1);
    assert.equal(parsed.lastExtractedAt, '2026-04-10T12:00:00.000Z');
    assert.deepEqual(parsed.processedTicketIds, ['42', '43']);
  });

  it('writes the correct byte length', async () => {
    const svc = makeClient();
    await writeState({ processedTicketIds: ['1001'] }, { serviceClient: svc });
    const { body, len } = svc.state.uploads[0];
    assert.equal(Buffer.byteLength(body, 'utf8'), len);
  });
});

// ── Round-trip ──────────────────────────────────────────────────────────────

describe('readState + writeState round-trip', () => {
  it('preserves every supported field across a write then read', async () => {
    const svc = makeClient();
    const original = {
      version: 1,
      lastExtractedAt: '2026-04-15T07:30:00.000Z',
      processedTicketIds: ['1001', '1002', '1003'],
    };
    await writeState(original, { serviceClient: svc });
    const readBack = await readState({ serviceClient: svc });
    assert.deepEqual(readBack, original);
  });

  it('normalizes on both directions (write then read still produces the canonical shape)', async () => {
    const svc = makeClient();
    // Give writeState a partial/messy payload.
    await writeState(
      { processedTicketIds: [1, 2, 3] },  // numbers
      { serviceClient: svc },
    );
    const readBack = await readState({ serviceClient: svc });
    assert.deepEqual(readBack.processedTicketIds, ['1', '2', '3']);
    assert.equal(readBack.version, 1);
    assert.equal(readBack.lastExtractedAt, null);
  });
});
