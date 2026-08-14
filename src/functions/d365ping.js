/**
 * Azure Function: /api/ping — anonymous liveness probe.
 *
 * Returns liveness + server time only. Deliberately carries NO database
 * metadata and NO auth gate: /api/health is the admin dashboard backend and
 * fail-closes behind Easy Auth (decideAdminAccess), so deploy probes and
 * uptime checks use this endpoint instead. It is the single path excluded
 * from Easy Auth by scripts/Enable-McpAuth.ps1.
 */

import { app } from '@azure/functions';

app.http('d365ping', {
  methods: ['GET'],
  route: 'api/ping',
  authLevel: 'anonymous',
  handler: async () => ({
    status: 200,
    headers: { 'Cache-Control': 'no-store' },
    jsonBody: { status: 'ok', server_time: new Date().toISOString() },
  }),
});
