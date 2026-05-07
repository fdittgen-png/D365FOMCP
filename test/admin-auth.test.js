/**
 * Tests for admin-auth.decideAdminAccess (issue #35).
 *
 * Mirrors the fail-closed posture from `decideUploadAuthorization` (issue #27):
 * Easy Auth on + no signed-in principal must reject the request.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decideAdminAccess, buildSignInHtml } from '../src/azure/admin-auth.js';

const userAlice = { principalId: 'p-alice', principalName: 'alice@example.com' };

describe('decideAdminAccess (issue #35)', () => {
  it('signed-in user → request may proceed', () => {
    assert.equal(decideAdminAccess({ user: userAlice, easyAuth: true }), null);
  });

  it('Easy Auth on, no user, JSON caller → 401 with structured error', () => {
    const r = decideAdminAccess({ user: null, easyAuth: true, wantsHtml: false });
    assert.equal(r?.status, 401);
    assert.match(r.jsonBody.error, /Authentication required/i);
    assert.ok(r.jsonBody.signInUrl?.startsWith('/.auth/login/aad'));
  });

  it('Easy Auth on, no user, HTML caller → 401 with sign-in landing page', () => {
    const r = decideAdminAccess({
      user: null,
      easyAuth: true,
      wantsHtml: true,
      redirectTarget: '/api/admin',
    });
    assert.equal(r?.status, 401);
    assert.match(r.headers['Content-Type'], /text\/html/);
    assert.match(r.body, /Sign in required/i);
    // Redirect target is encoded into the sign-in link
    assert.ok(r.body.includes(encodeURIComponent('/api/admin')));
  });

  it('Easy Auth disabled (local dev), no user → may proceed', () => {
    assert.equal(decideAdminAccess({ user: null, easyAuth: false }), null);
  });

  it('buildSignInHtml escapes the redirect target via encodeURIComponent', () => {
    const html = buildSignInHtml('/api/admin?x=1&y=2');
    // encodeURIComponent of the input
    const expected = encodeURIComponent('/api/admin?x=1&y=2');
    assert.ok(html.includes(expected), 'redirect target should be URI-encoded in the HTML');
    // Defensive: raw `?` and `&` from the input must NOT leak through unescaped
    assert.ok(!html.includes('post_login_redirect_uri=/api/admin?x=1'));
  });
});
