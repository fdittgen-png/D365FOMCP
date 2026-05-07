/**
 * Tests for d365sec-upload authorization decision (issue #27).
 *
 * Covers the fail-closed RBAC null-check fix: when the managed-identity-driven
 * RBAC check cannot run, the upload must be rejected with 503 — not allowed
 * through with a warning.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decideUploadAuthorization } from '../src/functions/d365sec-upload.js';

const userAlice = { principalId: 'p-alice', principalName: 'alice@example.com' };

describe('decideUploadAuthorization (issue #27)', () => {
  it('RBAC unavailable → 503 (fail-closed)', () => {
    const result = decideUploadAuthorization({
      user: userAlice,
      easyAuth: true,
      authorized: null,
    });
    assert.equal(result?.status, 503);
    assert.match(result.jsonBody.error, /Authorization check unavailable/i);
  });

  it('RBAC returns false → 403', () => {
    const result = decideUploadAuthorization({
      user: userAlice,
      easyAuth: true,
      authorized: false,
    });
    assert.equal(result?.status, 403);
    assert.match(result.jsonBody.error, /Access denied/i);
    assert.ok(result.jsonBody.error.includes(userAlice.principalName));
  });

  it('RBAC returns true → request may proceed (handler will return 200)', () => {
    const result = decideUploadAuthorization({
      user: userAlice,
      easyAuth: true,
      authorized: true,
    });
    assert.equal(result, null);
  });

  it('no user + Easy Auth enabled → 401 (auth required)', () => {
    const result = decideUploadAuthorization({
      user: null,
      easyAuth: true,
      authorized: null,
    });
    assert.equal(result?.status, 401);
    assert.match(result.jsonBody.error, /Authentication required/i);
  });

  it('no user + Easy Auth disabled (local dev) → may proceed', () => {
    const result = decideUploadAuthorization({
      user: null,
      easyAuth: false,
      authorized: null,
    });
    assert.equal(result, null);
  });
});
