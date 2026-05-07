/**
 * Request body size middleware for the four MCP JSON-RPC endpoints
 * (d365kb, d365xref, d365sec, d365taskrecorder).
 *
 * Issue #29: pre-check the Content-Length header BEFORE calling
 * `await request.json()`, so an oversized payload is rejected with HTTP 413
 * before any memory is allocated. Same pattern as `checkUploadSize` for
 * Task Recorder (issue #43).
 */

import { MAX_REQUEST_BODY_BYTES } from '../constants.js';

const JSON_RPC_INVALID_REQUEST = -32600;

/**
 * Validate that an incoming HTTP request's declared body size is within the
 * per-route limit. Pure function — easy to unit-test.
 *
 * Returns `null` when the request may proceed; otherwise returns the rejection
 * `{ status, jsonBody }` to short-circuit the handler. The body shape is a
 * JSON-RPC 2.0 error object so MCP clients can surface it cleanly.
 */
export function validateRequestSize(request, max = MAX_REQUEST_BODY_BYTES) {
  const cl = request.headers.get('content-length');
  if (cl == null || cl === '') {
    return rejectionResponse(`Content-Length header required (max ${max} bytes).`, max);
  }
  const len = Number(cl);
  if (!Number.isFinite(len) || len < 0) {
    return rejectionResponse(`Invalid Content-Length header (max ${max} bytes).`, max);
  }
  if (len > max) {
    return rejectionResponse(
      `Request body exceeds ${max} bytes (${len} declared).`,
      max,
    );
  }
  return null;
}

function rejectionResponse(message, max) {
  return {
    status: 413,
    jsonBody: {
      jsonrpc: '2.0',
      error: {
        code: JSON_RPC_INVALID_REQUEST,
        message,
        data: { maxBytes: max },
      },
    },
  };
}
