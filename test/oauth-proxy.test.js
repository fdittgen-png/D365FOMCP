/**
 * OAuth proxy core tests — the MCP OAuth compatibility layer
 * (src/azure/oauth-proxy-core.js). The whole point of the proxy is the
 * `resource`-parameter strip (Entra AADSTS9010010), so that behavior is
 * pinned hard here.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  oauthProxyConfig,
  protectedResourceMetadata,
  authorizationServerMetadata,
  buildAuthorizeRedirect,
  filterTokenParams,
  registrationResponse,
} from '../src/azure/oauth-proxy-core.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const BASE = 'https://tis-d-mcpd365fo-func.azurewebsites.net';

describe('oauthProxyConfig', () => {
  it('defaults to the live dev registration + Trelleborg tenant', () => {
    const cfg = oauthProxyConfig({});
    assert.equal(cfg.clientId, '54b1261c-352d-4772-b83a-001e529bd117');
    assert.equal(cfg.tenantId, '0f861177-7722-4f06-8db9-3384e5321a9f');
    assert.equal(cfg.scope, 'api://trelleborg.onmicrosoft.com/sp-tis-d-d365fokb-mcp/user_impersonation');
    assert.match(cfg.authorizeEndpoint, /^https:\/\/login\.microsoftonline\.com\/0f861177.*\/oauth2\/v2\.0\/authorize$/);
    assert.match(cfg.tokenEndpoint, /\/oauth2\/v2\.0\/token$/);
  });

  it('is env-overridable (trimmed), empty values fall back to defaults', () => {
    const cfg = oauthProxyConfig({
      MCP_OAUTH_TENANT_ID: ' t-1 ',
      MCP_OAUTH_CLIENT_ID: 'c-1',
      MCP_OAUTH_SCOPE: '  ',
    });
    assert.equal(cfg.tenantId, 't-1');
    assert.equal(cfg.clientId, 'c-1');
    assert.equal(cfg.scope, 'api://trelleborg.onmicrosoft.com/sp-tis-d-d365fokb-mcp/user_impersonation');
    assert.equal(cfg.authorizeEndpoint, 'https://login.microsoftonline.com/t-1/oauth2/v2.0/authorize');
  });
});

describe('protectedResourceMetadata', () => {
  const cfg = oauthProxyConfig({});

  it('root document: resource is the bare origin, AS is the proxy itself', () => {
    const doc = protectedResourceMetadata(BASE, '', cfg);
    assert.equal(doc.resource, BASE);
    assert.deepEqual(doc.authorization_servers, [BASE]);
    assert.deepEqual(doc.scopes_supported, [cfg.scope]);
  });

  it('path-scoped document echoes the endpoint path verbatim (client validates it)', () => {
    const doc = protectedResourceMetadata(BASE, 'api/d365kb', cfg);
    assert.equal(doc.resource, `${BASE}/api/d365kb`);
  });

  it('normalizes leading slashes in the path suffix (no double slash)', () => {
    const doc = protectedResourceMetadata(BASE, '/api/d365sec', cfg);
    assert.equal(doc.resource, `${BASE}/api/d365sec`);
  });
});

describe('authorizationServerMetadata', () => {
  it('points authorize/token/register at the proxy routes and advertises PKCE S256', () => {
    const doc = authorizationServerMetadata(BASE, oauthProxyConfig({}));
    assert.equal(doc.issuer, BASE);
    assert.equal(doc.authorization_endpoint, `${BASE}/api/oauth/authorize`);
    assert.equal(doc.token_endpoint, `${BASE}/api/oauth/token`);
    assert.equal(doc.registration_endpoint, `${BASE}/api/oauth/register`);
    assert.deepEqual(doc.code_challenge_methods_supported, ['S256']);
    assert.deepEqual(doc.token_endpoint_auth_methods_supported, ['none']);
    assert.ok(doc.grant_types_supported.includes('refresh_token'));
  });
});

describe('buildAuthorizeRedirect — the AADSTS9010010 fix', () => {
  const cfg = oauthProxyConfig({});

  it('strips resource, preserves every other parameter verbatim', () => {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: cfg.clientId,
      code_challenge: 'abc',
      code_challenge_method: 'S256',
      redirect_uri: 'http://localhost:45235/callback',
      state: 'xyz',
      scope: `${cfg.scope} offline_access`,
      resource: `${BASE}/api/d365kb`,
    });
    const url = new URL(buildAuthorizeRedirect(params, cfg));
    assert.equal(`${url.origin}${url.pathname}`, cfg.authorizeEndpoint);
    assert.equal(url.searchParams.get('resource'), null);
    assert.equal(url.searchParams.get('state'), 'xyz');
    assert.equal(url.searchParams.get('code_challenge'), 'abc');
    assert.equal(url.searchParams.get('scope'), `${cfg.scope} offline_access`);
    assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:45235/callback');
  });

  it('injects the registered client_id when the client omitted it', () => {
    const url = new URL(buildAuthorizeRedirect(new URLSearchParams({ response_type: 'code' }), cfg));
    assert.equal(url.searchParams.get('client_id'), cfg.clientId);
  });

  it('does not override a client-provided client_id', () => {
    const url = new URL(buildAuthorizeRedirect(new URLSearchParams({ client_id: 'other' }), cfg));
    assert.equal(url.searchParams.get('client_id'), 'other');
  });
});

describe('filterTokenParams', () => {
  const cfg = oauthProxyConfig({});

  it('strips resource, keeps grant/code/verifier/redirect, injects client_id', () => {
    const out = filterTokenParams(new URLSearchParams({
      grant_type: 'authorization_code',
      code: 'the-code',
      code_verifier: 'ver',
      redirect_uri: 'http://localhost:45235/callback',
      resource: `${BASE}/api/d365kb`,
    }), cfg);
    assert.equal(out.get('resource'), null);
    assert.equal(out.get('grant_type'), 'authorization_code');
    assert.equal(out.get('code'), 'the-code');
    assert.equal(out.get('code_verifier'), 'ver');
    assert.equal(out.get('client_id'), cfg.clientId);
  });

  it('refresh_token grant passes through with resource stripped', () => {
    const out = filterTokenParams(new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: 'rt',
      client_id: cfg.clientId,
      scope: cfg.scope,
      resource: BASE,
    }), cfg);
    assert.equal(out.get('resource'), null);
    assert.equal(out.get('refresh_token'), 'rt');
    assert.equal(out.get('scope'), cfg.scope);
  });
});

describe('registrationResponse (mock DCR)', () => {
  const cfg = oauthProxyConfig({});

  it('echoes requested metadata but pins client_id and public-client auth', () => {
    const res = registrationResponse({
      client_name: 'Claude',
      redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
      token_endpoint_auth_method: 'client_secret_basic',
    }, cfg);
    assert.equal(res.client_id, cfg.clientId);
    assert.equal(res.token_endpoint_auth_method, 'none');
    assert.deepEqual(res.redirect_uris, ['https://claude.ai/api/mcp/auth_callback']);
    assert.deepEqual(res.response_types, ['code']);
  });

  it('tolerates a missing/invalid body', () => {
    assert.equal(registrationResponse(null, cfg).client_id, cfg.clientId);
    assert.equal(registrationResponse('junk', cfg).client_id, cfg.clientId);
  });
});

describe('static scan — routing invariants for the proxy', () => {
  const fnSrc = readFileSync(join(__dirname, '..', 'src', 'functions', 'oauth-proxy.js'), 'utf8');

  it('host.json routePrefix is empty (well-known routes live at the root)', () => {
    const host = JSON.parse(readFileSync(join(__dirname, '..', 'host.json'), 'utf8'));
    assert.equal(host.extensions.http.routePrefix, '');
  });

  it('every src/functions route carries the explicit api/ prefix except well-known', () => {
    // routePrefix '' means routes must self-prefix; a bare route would silently
    // change its public URL. Well-known OAuth routes are the only root-level ones.
    for (const file of readdirSync(join(__dirname, '..', 'src', 'functions'))) {
      if (!file.endsWith('.js')) continue;
      const src = readFileSync(join(__dirname, '..', 'src', 'functions', file), 'utf8');
      for (const m of src.matchAll(/route:\s*'([^']+)'/g)) {
        const route = m[1];
        assert.ok(
          route.startsWith('api/') || route.startsWith('.well-known/'),
          `${file}: route '${route}' must start with api/ or .well-known/`
        );
      }
    }
  });

  it('every function file with routes is imported by the index.js entry point', () => {
    // The runtime only discovers routes imported from src/functions/index.js —
    // a missing import silently drops endpoints from the deployed app.
    const index = readFileSync(join(__dirname, '..', 'src', 'functions', 'index.js'), 'utf8');
    for (const file of readdirSync(join(__dirname, '..', 'src', 'functions'))) {
      if (!file.endsWith('.js') || file === 'index.js') continue;
      const src = readFileSync(join(__dirname, '..', 'src', 'functions', file), 'utf8');
      if (!/app\.http\(/.test(src)) continue;
      assert.ok(index.includes(`'./${file}'`), `src/functions/index.js must import './${file}'`);
    }
  });

  it('the proxy endpoints are anonymous and never call the MCP auth gate', () => {
    assert.ok(!fnSrc.includes('authorizeMcpRequest'), 'oauth proxy must stay pre-auth');
    const anonCount = (fnSrc.match(/authLevel: 'anonymous'/g) || []).length;
    const routeCount = (fnSrc.match(/route:\s*'/g) || []).length;
    assert.equal(anonCount, routeCount, 'every proxy route is explicitly anonymous');
  });
});
