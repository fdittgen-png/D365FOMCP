/**
 * MCP endpoint authorization — Entra App-Role gate for the MCP HTTP surfaces
 * (docs/MCP-Entra-Auth-Setup.md Part C, role model per the Entra role-based
 * security setup: App Roles stamped into the token's `roles` claim, validated
 * by Easy Auth at the platform edge, authorised here in code).
 *
 * Authn is delegated to App Service Authentication (Easy Auth): it validates
 * signature / issuer / audience / expiry and injects the verified principal as
 * the base64-JSON `x-ms-client-principal` header. This module is the authz
 * half: it requires the `Mcp.Access` App Role (value configurable via
 * MCP_REQUIRED_ROLE) in the principal's role claims.
 *
 * Fail-closed posture (issues #27 + #28, same lever as the upload endpoints):
 * when Easy Auth is NOT enabled the headers are spoofable, so requests are
 * refused with 503 unless REQUIRE_AUTH is explicitly "false" (local-dev
 * opt-out). Never warn-and-proceed.
 */

import { isEasyAuthEnabled, getAuthUser } from './admin-auth.js';

export const DEFAULT_REQUIRED_ROLE = 'Mcp.Access';

/** App Role value that must appear in the token's `roles` claim. */
export function requiredMcpRole() {
  const v = (process.env.MCP_REQUIRED_ROLE ?? '').trim();
  return v || DEFAULT_REQUIRED_ROLE;
}

/**
 * Whether authentication is required. Same semantics as the upload endpoints
 * (issue #28): defaults to true and fails closed — only the literal string
 * "false" (case-insensitive) disables it; every other value (typos, "0",
 * "no", "") is treated as true.
 */
export function isAuthRequired() {
  const v = (process.env.REQUIRE_AUTH ?? '').trim().toLowerCase();
  return v !== 'false';
}

/**
 * Decode the Easy Auth `x-ms-client-principal` header (base64 JSON).
 * Returns the principal object, or null when absent/malformed.
 */
export function parseClientPrincipal(header) {
  if (!header) return null;
  try {
    const principal = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
    return principal && typeof principal === 'object' ? principal : null;
  } catch {
    return null;
  }
}

/**
 * Extract App Role values from a client principal's claims. Entra emits the
 * short claim type `roles` on v2 tokens; Easy Auth may surface the WS-Fed
 * long form (`…/identity/claims/role`) — accept both.
 */
export function extractRoles(principal) {
  const claims = Array.isArray(principal?.claims) ? principal.claims : [];
  return claims
    .filter(c => c && typeof c.typ === 'string' && (c.typ === 'roles' || c.typ.endsWith('/role')))
    .map(c => c.val)
    .filter(v => typeof v === 'string');
}

/**
 * Pure authorization decision for the MCP endpoints. Returns `null` when the
 * request may proceed, or an HTTP response object `{ status, jsonBody }`
 * describing the rejection.
 *
 * @param {object} args
 * @param {{principalId:string, principalName:string}|null} args.user  Easy Auth identity, or null.
 * @param {string[]} args.roles  App Role values from the token's role claims.
 * @param {boolean} args.easyAuth  Whether Easy Auth is enabled on the Function App.
 * @param {boolean} [args.requireAuth]  Override for isAuthRequired() (defaults to it).
 * @param {string} [args.requiredRole]  Override for requiredMcpRole() (defaults to it).
 */
export function decideMcpAuthorization({ user, roles, easyAuth, requireAuth, requiredRole }) {
  const mustAuth = requireAuth === undefined ? isAuthRequired() : requireAuth;
  const role = requiredRole === undefined ? requiredMcpRole() : requiredRole;

  // Easy Auth not enabled: principal headers are not trustworthy, so refuse
  // unless the operator explicitly opted out for local development.
  if (!easyAuth) {
    if (mustAuth) {
      return {
        status: 503,
        jsonBody: {
          error: 'Easy Auth is not enabled on this Function App, so MCP callers cannot be authenticated.',
          hint: 'Enable App Service Authentication (docs/MCP-Entra-Auth-Setup.md Part B), or set REQUIRE_AUTH=false for unauthenticated local development.',
        },
      };
    }
    return null; // local-dev opt-out
  }

  // Easy Auth enabled. No principal id (`oid`) → unauthenticated; reject —
  // the object id is also required for audit attribution.
  if (!user) {
    return {
      status: 401,
      jsonBody: {
        error: 'Authentication required.',
        hint: 'Send an Entra access token for this API as an Authorization: Bearer header.',
      },
    };
  }

  // No hierarchy in App Roles — exact string match on the role value.
  if (!Array.isArray(roles) || !roles.includes(role)) {
    return {
      status: 403,
      jsonBody: {
        error: `Not authorized for MCP: the '${role}' app role is missing from your token.`,
        hint: 'Ask to be added to the MCP access group. If you were added recently, your token may be stale — sign out and back in to get a token with the new role.',
      },
    };
  }

  return null; // authorized
}

/**
 * Request-level guard for the MCP HTTP handlers. Returns `null` when the
 * request may proceed, or the rejection response to emit immediately.
 *
 * Usage (top of every MCP handler, before any tool work):
 *   const denied = authorizeMcpRequest(request);
 *   if (denied) return denied;
 */
export function authorizeMcpRequest(request) {
  const easyAuth = isEasyAuthEnabled();
  if (!easyAuth) {
    return decideMcpAuthorization({ user: null, roles: [], easyAuth });
  }

  const user = getAuthUser(request);
  let roles = [];
  if (user) {
    const header = request.headers.get('x-ms-client-principal');
    const principal = parseClientPrincipal(header);
    if (!principal) {
      // A principal id without a decodable principal blob is inconsistent —
      // treat as unauthenticated rather than guessing at roles.
      return {
        status: 401,
        jsonBody: {
          error: 'Invalid authentication principal.',
          hint: 'The Easy Auth client principal header is missing or malformed. Re-authenticate and retry.',
        },
      };
    }
    roles = extractRoles(principal);
  }

  return decideMcpAuthorization({ user, roles, easyAuth });
}
