/**
 * Tests for d365sec-upload authorization decision (issue #27).
 *
 * Covers the fail-closed RBAC null-check fix: when the managed-identity-driven
 * RBAC check cannot run, the upload must be rejected with 503 — not allowed
 * through with a warning.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decideUploadAuthorization, isAuthRequired } from '../src/functions/d365sec-upload.js';

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

  it('no user + Easy Auth disabled + REQUIRE_AUTH=false (local dev opt-out) → may proceed', () => {
    const result = decideUploadAuthorization({
      user: null,
      easyAuth: false,
      authorized: null,
      requireAuth: false,
    });
    assert.equal(result, null);
  });
});

describe('decideUploadAuthorization REQUIRE_AUTH gate (issue #28)', () => {
  it('Easy Auth disabled + requireAuth=true (default) → 503 (fail-closed)', () => {
    const result = decideUploadAuthorization({
      user: null,
      easyAuth: false,
      authorized: null,
      requireAuth: true,
    });
    assert.equal(result?.status, 503);
    assert.match(result.jsonBody.error, /Easy Auth is not enabled/i);
    assert.match(result.jsonBody.hint, /REQUIRE_AUTH=false/i);
  });

  it('Easy Auth disabled + requireAuth=true with a user header → still 503', () => {
    // Header spoofing must not bypass the gate — Easy Auth headers are only
    // trustworthy when Easy Auth is actually enabled on the Function App.
    const result = decideUploadAuthorization({
      user: userAlice,
      easyAuth: false,
      authorized: true,
      requireAuth: true,
    });
    assert.equal(result?.status, 503);
    assert.match(result.jsonBody.error, /Easy Auth is not enabled/i);
  });

  it('default requireAuth (omitted) is treated as true → 503', () => {
    const result = decideUploadAuthorization({
      user: null,
      easyAuth: false,
      authorized: null,
    });
    assert.equal(result?.status, 503);
  });

  it('Easy Auth enabled + requireAuth=true + RBAC ok → may proceed', () => {
    const result = decideUploadAuthorization({
      user: userAlice,
      easyAuth: true,
      authorized: true,
      requireAuth: true,
    });
    assert.equal(result, null);
  });
});

describe('isAuthRequired (issue #28)', () => {
  const ORIG = process.env.REQUIRE_AUTH;
  const restore = () => {
    if (ORIG === undefined) delete process.env.REQUIRE_AUTH;
    else process.env.REQUIRE_AUTH = ORIG;
  };

  it('defaults to true when REQUIRE_AUTH is unset', () => {
    delete process.env.REQUIRE_AUTH;
    assert.equal(isAuthRequired(), true);
    restore();
  });

  it('returns true when REQUIRE_AUTH=true', () => {
    process.env.REQUIRE_AUTH = 'true';
    assert.equal(isAuthRequired(), true);
    restore();
  });

  it('returns false ONLY for the literal "false" (case-insensitive)', () => {
    process.env.REQUIRE_AUTH = 'false';
    assert.equal(isAuthRequired(), false);
    process.env.REQUIRE_AUTH = 'FALSE';
    assert.equal(isAuthRequired(), false);
    process.env.REQUIRE_AUTH = 'False';
    assert.equal(isAuthRequired(), false);
    restore();
  });

  it('treats unrecognized values (typos, "0", "no") as true (fail-closed)', () => {
    for (const v of ['0', 'no', 'off', 'disabled', 'falsey', '']) {
      process.env.REQUIRE_AUTH = v;
      assert.equal(isAuthRequired(), true, `value ${JSON.stringify(v)} should fail closed`);
    }
    restore();
  });
});
