/**
 * Tests for validateRequestSize middleware (issue #29).
 *
 * Verifies the Content-Length pre-check rejects oversized MCP JSON-RPC
 * payloads before the body is read into memory across all four endpoints.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateRequestSize } from '../src/azure/request-size.js';
import { MAX_REQUEST_BODY_BYTES } from '../src/constants.js';

/** Build a fake request whose `headers.get('content-length')` returns the given value. */
function fakeRequest(contentLength) {
  return {
    headers: {
      get: (name) => (name.toLowerCase() === 'content-length' ? contentLength : null),
    },
  };
}

describe('validateRequestSize (issue #29)', () => {
  it('exposes the documented 1 MB ceiling', () => {
    assert.equal(MAX_REQUEST_BODY_BYTES, 1 * 1024 * 1024);
  });

  it('returns null for a small valid Content-Length (request may proceed)', () => {
    assert.equal(validateRequestSize(fakeRequest('1024')), null);
  });

  it('rejects oversized payload with HTTP 413 + JSON-RPC error envelope', () => {
    const big = String(2 * 1024 * 1024); // 2 MB
    const result = validateRequestSize(fakeRequest(big));
    assert.equal(result?.status, 413);
    assert.equal(result.jsonBody.jsonrpc, '2.0');
    assert.equal(result.jsonBody.error.code, -32600);
    assert.match(result.jsonBody.error.message, /exceeds/i);
    assert.equal(result.jsonBody.error.data.maxBytes, MAX_REQUEST_BODY_BYTES);
  });

  it('rejects missing Content-Length (fail-closed, cannot size-verify upfront)', () => {
    assert.equal(validateRequestSize(fakeRequest(null))?.status, 413);
    assert.equal(validateRequestSize(fakeRequest(''))?.status, 413);
    assert.equal(validateRequestSize(fakeRequest(undefined))?.status, 413);
  });

  it('rejects invalid Content-Length', () => {
    assert.equal(validateRequestSize(fakeRequest('abc'))?.status, 413);
    assert.equal(validateRequestSize(fakeRequest('-5'))?.status, 413);
  });

  it('honours boundary: exactly at limit → null, 1 byte over → 413', () => {
    assert.equal(validateRequestSize(fakeRequest(String(MAX_REQUEST_BODY_BYTES))), null);
    assert.equal(validateRequestSize(fakeRequest(String(MAX_REQUEST_BODY_BYTES + 1)))?.status, 413);
  });

  it('honours a custom max (callers can tighten the limit)', () => {
    assert.equal(validateRequestSize(fakeRequest('500'), 1024), null);
    assert.equal(validateRequestSize(fakeRequest('5000'), 1024)?.status, 413);
  });
});
