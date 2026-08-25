/**
 * Azure Function: /api/icon.png, /api/icon-512.png, /favicon.ico, /favicon.png — anonymous server icon.
 *
 * Referenced from every MCP server's `initialize` → `serverInfo.icons`
 * (src/azure/server-metadata.js) so connector directories show the Trelleborg
 * mark instead of a generic placeholder. Static PNG from assets/, long cache.
 * Must stay outside Easy Auth (scripts/Enable-McpAuth.ps1 excludedPaths) —
 * the directory fetches it unauthenticated. The /favicon.* routes are the
 * fallback some hosts (claude.ai proposal, browsers) probe on the server origin
 * when they ignore serverInfo.icons — same PNG, no separate asset.
 */

import { app } from '@azure/functions';
import { iconPng } from '../azure/server-metadata.js';

function iconResponse(size) {
  const body = iconPng(size);
  if (!body) return { status: 404, jsonBody: { error: 'icon asset missing' } };
  return {
    status: 200,
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=86400',
      'Content-Length': String(body.length),
    },
    body,
  };
}

app.http('d365icon', {
  methods: ['GET'],
  route: 'api/icon.png',
  authLevel: 'anonymous',
  handler: async () => iconResponse(128),
});

app.http('d365icon512', {
  methods: ['GET'],
  route: 'api/icon-512.png',
  authLevel: 'anonymous',
  handler: async () => iconResponse(512),
});

// Favicon fallback on the bare origin (routePrefix is '' so these are root paths).
for (const [id, route] of [['favicon', 'favicon.ico'], ['faviconPng', 'favicon.png']]) {
  app.http(id, {
    methods: ['GET'],
    route,
    authLevel: 'anonymous',
    handler: async () => iconResponse(128),
  });
}
