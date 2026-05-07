/**
 * Azure Function: admin HTML pages (index, db-health, upload).
 *
 * Serves the static back-office pages from `www/` behind an Easy Auth gate.
 * Mirrors the load-at-startup pattern used by `d365taskrecorder.js`.
 *
 * Routes:
 *   /api/admin                — dashboard (www/index.html)
 *   /api/admin/db-health      — DB health detail (www/db-health.html)
 *   /api/admin/upload         — Sec database upload (www/upload.html)
 *
 * The Sec upload POST endpoint (`/api/d365sec/upload`) is unchanged; this
 * module only owns the GET-form for the upload page now that the inline
 * HTML has been extracted.
 */

import { app } from '@azure/functions';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { decideAdminAccess, getAuthUser, isEasyAuthEnabled } from '../azure/admin-auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const wwwDir = join(__dirname, '..', '..', 'www');

/** Load an HTML file at startup. Falls back to an inline error page if missing. */
function loadHtml(name) {
  try {
    return readFileSync(join(wwwDir, name), 'utf8');
  } catch {
    return `<!doctype html><meta charset="utf-8"><title>Not bundled</title>`
      + `<body style="font-family:system-ui;padding:32px;color:#82071e">`
      + `<h1>Page unavailable</h1><p><code>${name}</code> is not present in this deployment.</p></body>`;
  }
}

const PAGES = {
  index: loadHtml('index.html'),
  dbHealth: loadHtml('db-health.html'),
};

function htmlResponse(body) {
  return {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    },
    body,
  };
}

function makePageHandler(html, redirectTarget) {
  return async (request) => {
    const user = getAuthUser(request);
    const easyAuth = isEasyAuthEnabled();
    const rejection = decideAdminAccess({ user, easyAuth, wantsHtml: true, redirectTarget });
    if (rejection) return rejection;
    return htmlResponse(html);
  };
}

app.http('d365admin-index', {
  methods: ['GET'],
  route: 'admin',
  authLevel: 'anonymous',
  handler: makePageHandler(PAGES.index, '/api/admin'),
});

app.http('d365admin-db-health', {
  methods: ['GET'],
  route: 'admin/db-health',
  authLevel: 'anonymous',
  handler: makePageHandler(PAGES.dbHealth, '/api/admin/db-health'),
});

// /api/admin/upload — redirect to the existing sec upload endpoint.
// The Sec upload page uses dynamic placeholders for the RBAC auth bar and
// live DB info, so we don't duplicate the rendering pipeline here. The
// existing endpoint at /api/d365sec/upload already serves the static
// `www/upload.html` template with the placeholders substituted per-request.
app.http('d365admin-upload', {
  methods: ['GET'],
  route: 'admin/upload',
  authLevel: 'anonymous',
  handler: async (request) => {
    const user = getAuthUser(request);
    const easyAuth = isEasyAuthEnabled();
    const rejection = decideAdminAccess({
      user,
      easyAuth,
      wantsHtml: true,
      redirectTarget: '/api/admin/upload',
    });
    if (rejection) return rejection;
    return {
      status: 302,
      headers: { Location: '/api/d365sec/upload' },
    };
  },
});
