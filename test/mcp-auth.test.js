/**
 * Tests for the MCP endpoint Entra App-Role gate (src/azure/mcp-auth.js).
 *
 * Mirrors the fail-closed posture of `decideUploadAuthorization` (issues
 * #27 + #28): Easy Auth off + REQUIRE_AUTH unset must refuse with 503, never
 * warn-and-proceed; Easy Auth on requires a principal AND the `Mcp.Access`
 * app role in the token's role claims.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  decideMcpAuthorization,
  authorizeMcpRequest,
  parseClientPrincipal,
  extractRoles,
  isAuthRequired,
  requiredMcpRole,
  DEFAULT_REQUIRED_ROLE,
} from '../src/azure/mcp-auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const userAlice = { principalId: 'oid-alice', principalName: 'alice@example.com' };

function principalHeader(claims) {
  return Buffer.from(JSON.stringify({ claims }), 'utf8').toString('base64');
}

/** Minimal request stub — handlers only use `request.headers.get(...)`. */
function fakeRequest(headers = {}) {
  const map = new Map(Object.entries(headers));
  return { headers: { get: (k) => map.get(k) ?? null } };
}

describe('decideMcpAuthorization (pure decision)', () => {
  it('Easy Auth off + auth required → 503, never warn-and-proceed', () => {
    const r = decideMcpAuthorization({ user: null, roles: [], easyAuth: false, requireAuth: true });
    assert.equal(r?.status, 503);
    assert.match(r.jsonBody.error, /Easy Auth is not enabled/i);
  });

  it('Easy Auth off + explicit local-dev opt-out → proceed', () => {
    assert.equal(
      decideMcpAuthorization({ user: null, roles: [], easyAuth: false, requireAuth: false }),
      null,
    );
  });

  it('Easy Auth on, no principal → 401', () => {
    const r = decideMcpAuthorization({ user: null, roles: [], easyAuth: true, requireAuth: true });
    assert.equal(r?.status, 401);
    assert.match(r.jsonBody.error, /Authentication required/i);
  });

  it('Easy Auth on, principal without the app role → 403 with stale-token hint', () => {
    const r = decideMcpAuthorization({
      user: userAlice, roles: ['SomethingElse'], easyAuth: true, requireAuth: true,
    });
    assert.equal(r?.status, 403);
    assert.match(r.jsonBody.error, /Mcp\.Access/);
    assert.match(r.jsonBody.hint, /stale/i); // role changes are baked in at token issue time
  });

  it('Easy Auth on, empty roles → 403 (no roles claim means no access)', () => {
    const r = decideMcpAuthorization({ user: userAlice, roles: [], easyAuth: true, requireAuth: true });
    assert.equal(r?.status, 403);
  });

  it('Easy Auth on, principal with Mcp.Access → proceed', () => {
    assert.equal(
      decideMcpAuthorization({
        user: userAlice, roles: ['Mcp.Access'], easyAuth: true, requireAuth: true,
      }),
      null,
    );
  });

  it('role match is exact / case-sensitive (Entra role values are case-sensitive)', () => {
    const r = decideMcpAuthorization({
      user: userAlice, roles: ['mcp.access'], easyAuth: true, requireAuth: true,
    });
    assert.equal(r?.status, 403);
  });

  it('requiredRole override is honoured', () => {
    assert.equal(
      decideMcpAuthorization({
        user: userAlice, roles: ['Custom.Role'], easyAuth: true, requireAuth: true, requiredRole: 'Custom.Role',
      }),
      null,
    );
  });
});

describe('parseClientPrincipal / extractRoles', () => {
  it('decodes a valid base64 JSON principal', () => {
    const p = parseClientPrincipal(principalHeader([{ typ: 'roles', val: 'Mcp.Access' }]));
    assert.equal(p.claims.length, 1);
  });

  it('returns null for missing or malformed headers', () => {
    assert.equal(parseClientPrincipal(null), null);
    assert.equal(parseClientPrincipal(''), null);
    assert.equal(parseClientPrincipal('%%%not-base64-json%%%'), null);
    assert.equal(parseClientPrincipal(Buffer.from('"just a string"').toString('base64')), null);
  });

  it('extracts short-form `roles` claims', () => {
    const roles = extractRoles({ claims: [{ typ: 'roles', val: 'Mcp.Access' }, { typ: 'name', val: 'Alice' }] });
    assert.deepEqual(roles, ['Mcp.Access']);
  });

  it('extracts WS-Fed long-form role claims', () => {
    const roles = extractRoles({
      claims: [{ typ: 'http://schemas.microsoft.com/ws/2008/06/identity/claims/role', val: 'Mcp.Access' }],
    });
    assert.deepEqual(roles, ['Mcp.Access']);
  });

  it('tolerates absent/garbled claims', () => {
    assert.deepEqual(extractRoles(null), []);
    assert.deepEqual(extractRoles({}), []);
    assert.deepEqual(extractRoles({ claims: [{ typ: 'roles' }, null, { val: 'x' }] }), []);
  });
});

describe('authorizeMcpRequest (request glue, env-driven)', () => {
  const saved = {};
  beforeEach(() => {
    saved.WEBSITE_AUTH_ENABLED = process.env.WEBSITE_AUTH_ENABLED;
    saved.REQUIRE_AUTH = process.env.REQUIRE_AUTH;
    saved.MCP_REQUIRED_ROLE = process.env.MCP_REQUIRED_ROLE;
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('Easy Auth off, REQUIRE_AUTH unset → 503 (fail closed)', () => {
    delete process.env.WEBSITE_AUTH_ENABLED;
    delete process.env.REQUIRE_AUTH;
    assert.equal(authorizeMcpRequest(fakeRequest())?.status, 503);
  });

  it('Easy Auth off, REQUIRE_AUTH=false → proceed (local dev)', () => {
    delete process.env.WEBSITE_AUTH_ENABLED;
    process.env.REQUIRE_AUTH = 'false';
    assert.equal(authorizeMcpRequest(fakeRequest()), null);
  });

  it('Easy Auth on, no headers → 401', () => {
    process.env.WEBSITE_AUTH_ENABLED = 'True';
    assert.equal(authorizeMcpRequest(fakeRequest())?.status, 401);
  });

  it('Easy Auth on, principal id but malformed principal blob → 401', () => {
    process.env.WEBSITE_AUTH_ENABLED = 'True';
    const r = authorizeMcpRequest(fakeRequest({
      'x-ms-client-principal-id': 'oid-alice',
      'x-ms-client-principal': '!!!garbage!!!',
    }));
    assert.equal(r?.status, 401);
    assert.match(r.jsonBody.error, /Invalid authentication principal/i);
  });

  it('Easy Auth on, principal with the role → proceed', () => {
    process.env.WEBSITE_AUTH_ENABLED = 'True';
    const r = authorizeMcpRequest(fakeRequest({
      'x-ms-client-principal-id': 'oid-alice',
      'x-ms-client-principal-name': 'alice@example.com',
      'x-ms-client-principal': principalHeader([{ typ: 'roles', val: 'Mcp.Access' }]),
    }));
    assert.equal(r, null);
  });

  it('Easy Auth on, principal without the role → 403', () => {
    process.env.WEBSITE_AUTH_ENABLED = 'True';
    const r = authorizeMcpRequest(fakeRequest({
      'x-ms-client-principal-id': 'oid-alice',
      'x-ms-client-principal': principalHeader([{ typ: 'roles', val: 'Reader' }]),
    }));
    assert.equal(r?.status, 403);
  });

  it('isAuthRequired fails closed on anything but the literal "false"', () => {
    process.env.REQUIRE_AUTH = 'false';
    assert.equal(isAuthRequired(), false);
    for (const v of ['0', 'no', 'FALSE ok', 'off', '']) {
      process.env.REQUIRE_AUTH = v;
      assert.equal(isAuthRequired(), true, `REQUIRE_AUTH="${v}" must require auth`);
    }
    delete process.env.REQUIRE_AUTH;
    assert.equal(isAuthRequired(), true);
  });

  it('requiredMcpRole defaults to Mcp.Access and honours MCP_REQUIRED_ROLE', () => {
    delete process.env.MCP_REQUIRED_ROLE;
    assert.equal(requiredMcpRole(), DEFAULT_REQUIRED_ROLE);
    process.env.MCP_REQUIRED_ROLE = 'Custom.Role';
    assert.equal(requiredMcpRole(), 'Custom.Role');
  });
});

describe('static scan — every MCP HTTP surface is gated', () => {
  const MCP_FUNCTION_FILES = [
    'd365kb.js',
    'd365xref.js',
    'd365sec.js',
    'd365taskrecorder.js',
    'wiki-mcp.js',
  ];

  for (const file of MCP_FUNCTION_FILES) {
    it(`${file} imports and calls authorizeMcpRequest`, () => {
      const src = readFileSync(join(__dirname, '..', 'src', 'functions', file), 'utf8');
      assert.match(src, /from ['"]\.\.\/azure\/mcp-auth\.js['"]/, `${file} must import mcp-auth.js`);
      assert.match(src, /authorizeMcpRequest\(request\)/, `${file} must call authorizeMcpRequest(request)`);
    });
  }

  it('d365taskrecorder.js gates both the MCP route and the upload route', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'functions', 'd365taskrecorder.js'), 'utf8');
    const count = (src.match(/authorizeMcpRequest\(request\)/g) || []).length;
    assert.ok(count >= 2, 'expected the gate on both routes');
  });
});
