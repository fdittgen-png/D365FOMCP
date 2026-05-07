/**
 * Project-wide constants. Keep this file dependency-free so it can be imported
 * by any module (functions, azure helpers, build scripts, tests) without
 * triggering side effects or circular imports.
 */

/**
 * Maximum allowed Content-Length for an MCP JSON-RPC request body.
 * Tools wrap small JSON payloads (parameter objects, query strings); 1 MB is
 * generous for legitimate traffic and cheap to reject for runaway calls.
 *
 * Note: this is per-route, enforced inside each function handler via
 * `validateRequestSize(request)`. The host.json `maxRequestBodySize` is a
 * process-global ceiling sized for the security-DB upload endpoint; Azure
 * Functions does not support per-route overrides there.
 */
export const MAX_REQUEST_BODY_BYTES = 1 * 1024 * 1024; // 1 MB
