/**
 * Azure Functions: MCP OAuth compatibility endpoints (deliberately anonymous).
 *
 * Serves OAuth discovery + proxies /authorize and /token to Entra with the
 * RFC 8707 `resource` parameter stripped (Entra rejects it: AADSTS9010010).
 * See src/azure/oauth-proxy-core.js for the full rationale and
 * docs/MCP-Entra-Auth-Setup.md for the architecture.
 *
 * These routes MUST be in the Easy Auth excluded-paths list
 * (scripts/Enable-McpAuth.ps1) — they are the pre-authentication surface of
 * the OAuth flow itself. They never see or store tokens beyond passing the
 * Entra token response through to the client, and they hold no secrets
 * (public client + PKCE end to end).
 */

import { app } from '@azure/functions';
import {
  oauthProxyConfig,
  protectedResourceMetadata,
  authorizationServerMetadata,
  buildAuthorizeRedirect,
  filterTokenParams,
  registrationResponse,
} from '../azure/oauth-proxy-core.js';

const JSON_HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

function baseUrl(request) {
  return new URL(request.url).origin;
}

app.http('oauth-prm', {
  methods: ['GET'],
  route: '.well-known/oauth-protected-resource/{*path}',
  authLevel: 'anonymous',
  handler: async (request) => ({
    status: 200,
    headers: JSON_HEADERS,
    jsonBody: protectedResourceMetadata(
      baseUrl(request),
      request.params.path ?? '',
      oauthProxyConfig()
    ),
  }),
});

app.http('oauth-asm', {
  methods: ['GET'],
  route: '.well-known/oauth-authorization-server/{*path}',
  authLevel: 'anonymous',
  handler: async (request) => ({
    status: 200,
    headers: JSON_HEADERS,
    jsonBody: authorizationServerMetadata(baseUrl(request), oauthProxyConfig()),
  }),
});

// OIDC-style alias: some clients probe openid-configuration instead of the
// RFC 8414 path. Same document — the shape is compatible for our purposes.
app.http('oauth-oidc-config', {
  methods: ['GET'],
  route: '.well-known/openid-configuration',
  authLevel: 'anonymous',
  handler: async (request) => ({
    status: 200,
    headers: JSON_HEADERS,
    jsonBody: authorizationServerMetadata(baseUrl(request), oauthProxyConfig()),
  }),
});

app.http('oauth-authorize', {
  methods: ['GET'],
  route: 'api/oauth/authorize',
  authLevel: 'anonymous',
  handler: async (request) => {
    const location = buildAuthorizeRedirect(
      new URL(request.url).searchParams,
      oauthProxyConfig()
    );
    return { status: 302, headers: { Location: location, 'Cache-Control': 'no-store' } };
  },
});

app.http('oauth-token', {
  methods: ['POST'],
  route: 'api/oauth/token',
  authLevel: 'anonymous',
  handler: async (request, context) => {
    const cfg = oauthProxyConfig();
    let bodyParams;
    try {
      bodyParams = new URLSearchParams(await request.text());
    } catch {
      return {
        status: 400,
        headers: JSON_HEADERS,
        jsonBody: { error: 'invalid_request', error_description: 'Unreadable request body.' },
      };
    }

    try {
      const upstream = await fetch(cfg.tokenEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: filterTokenParams(bodyParams, cfg).toString(),
      });
      const text = await upstream.text();
      return {
        status: upstream.status,
        headers: JSON_HEADERS,
        body: text,
      };
    } catch (err) {
      context.error(`oauth-token proxy: upstream call failed: ${err?.message}`);
      return {
        status: 502,
        headers: JSON_HEADERS,
        jsonBody: {
          error: 'server_error',
          error_description: 'Token endpoint upstream request failed.',
        },
      };
    }
  },
});

app.http('oauth-register', {
  methods: ['POST'],
  route: 'api/oauth/register',
  authLevel: 'anonymous',
  handler: async (request) => {
    let body = {};
    try {
      body = await request.json();
    } catch {
      // tolerate empty/non-JSON registration bodies — the response is static anyway
    }
    return {
      status: 201,
      headers: JSON_HEADERS,
      jsonBody: registrationResponse(body, oauthProxyConfig()),
    };
  },
});
