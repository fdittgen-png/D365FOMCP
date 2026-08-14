/**
 * OAuth proxy core — pure logic for the MCP OAuth compatibility endpoints
 * (docs/MCP-Entra-Auth-Setup.md, "OAuth proxy" section).
 *
 * Why this exists: the MCP authorization spec (2025-06-18) requires clients to
 * send an RFC 8707 `resource` parameter (the MCP server URL, taken verbatim
 * from the protected-resource metadata). Since Entra's enforcement change
 * (~2026-03), the v2.0 endpoints reject any `resource` value that is not an
 * Application ID URI of the app owning the requested scope — and tenant
 * policy blocks registering `https://<app>.azurewebsites.net/...` URIs
 * (no verified domain). Result: every spec-compliant MCP client dead-ends at
 * AADSTS9010010.
 *
 * Fix (the pattern used in-house by orion/pulsar and across the MCP
 * ecosystem): the Function App presents ITSELF as the authorization server.
 * Clients discover metadata here, and `/api/oauth/authorize` + `/api/oauth/token`
 * forward to Entra with the `resource` parameter stripped. Tokens still come
 * from Entra, audience-bound to the api://… App ID URI; Easy Auth validation
 * is unchanged. No OBO — this is discovery/parameter mediation only.
 *
 * Everything here is a pure function of (config, request data) so it is unit
 * testable without HTTP.
 */

/** Query/body parameter Entra v2.0 rejects when it mismatches the scope's audience. */
const STRIPPED_PARAMS = ['resource'];

const DEFAULT_TENANT_ID = '0f861177-7722-4f06-8db9-3384e5321a9f';
const DEFAULT_CLIENT_ID = '54b1261c-352d-4772-b83a-001e529bd117';
const DEFAULT_SCOPE = 'api://trelleborg.onmicrosoft.com/sp-tis-d-d365fokb-mcp/user_impersonation';

/**
 * Proxy configuration. Env-overridable so a prod Function App / different
 * registration needs no code change; defaults match the live dev registration
 * sp-tis-d-d365fokb-mcp.
 */
export function oauthProxyConfig(env = process.env) {
  const tenantId = (env.MCP_OAUTH_TENANT_ID ?? '').trim() || DEFAULT_TENANT_ID;
  const clientId = (env.MCP_OAUTH_CLIENT_ID ?? '').trim() || DEFAULT_CLIENT_ID;
  const scope = (env.MCP_OAUTH_SCOPE ?? '').trim() || DEFAULT_SCOPE;
  return {
    tenantId,
    clientId,
    scope,
    authorizeEndpoint: `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize`,
    tokenEndpoint: `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
  };
}

/**
 * RFC 9728 protected-resource metadata. `resourcePath` is the path suffix of
 * the well-known request ('' for the root document, 'api/d365kb' for the
 * path-scoped form) — the `resource` value must echo the URL the client
 * connected to, or spec-compliant clients reject the document.
 */
export function protectedResourceMetadata(baseUrl, resourcePath, cfg) {
  const suffix = resourcePath ? `/${String(resourcePath).replace(/^\/+/, '')}` : '';
  return {
    resource: `${baseUrl}${suffix}`,
    authorization_servers: [baseUrl],
    scopes_supported: [cfg.scope],
    bearer_methods_supported: ['header'],
  };
}

/**
 * RFC 8414 authorization-server metadata for the proxy. The issuer is this
 * Function App; authorize/token/register point at the proxy routes, which
 * forward to Entra. `code_challenge_methods_supported` is REQUIRED by the MCP
 * spec (PKCE) and famously absent from Entra's own OIDC metadata.
 */
export function authorizationServerMetadata(baseUrl, cfg) {
  return {
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/api/oauth/authorize`,
    token_endpoint: `${baseUrl}/api/oauth/token`,
    registration_endpoint: `${baseUrl}/api/oauth/register`,
    scopes_supported: [cfg.scope, 'openid', 'profile', 'offline_access'],
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
  };
}

/**
 * Build the Entra /authorize redirect URL from the client's authorize request.
 * Passes every parameter through verbatim EXCEPT the stripped ones, and
 * injects the registered client_id when the caller omitted it.
 */
export function buildAuthorizeRedirect(searchParams, cfg) {
  const out = new URLSearchParams();
  for (const [key, value] of searchParams) {
    if (STRIPPED_PARAMS.includes(key)) continue;
    out.append(key, value);
  }
  if (!out.has('client_id')) out.set('client_id', cfg.clientId);
  return `${cfg.authorizeEndpoint}?${out.toString()}`;
}

/**
 * Filter a token-request body (URLSearchParams) for forwarding to Entra:
 * strip `resource`, inject client_id if absent (public client, no secret).
 */
export function filterTokenParams(bodyParams, cfg) {
  const out = new URLSearchParams();
  for (const [key, value] of bodyParams) {
    if (STRIPPED_PARAMS.includes(key)) continue;
    out.append(key, value);
  }
  if (!out.has('client_id')) out.set('client_id', cfg.clientId);
  return out;
}

/**
 * Mock RFC 7591 dynamic client registration. Entra has no DCR; every client
 * "registers" as the single pre-created public-client app registration. The
 * response echoes the client's requested metadata (spec requirement) with the
 * fields we pin overridden. redirect_uris must still be pre-registered in
 * Entra — unknown ones fail later at /authorize with AADSTS50011.
 */
export function registrationResponse(requestBody, cfg) {
  const body = requestBody && typeof requestBody === 'object' ? requestBody : {};
  return {
    ...body,
    client_id: cfg.clientId,
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  };
}
