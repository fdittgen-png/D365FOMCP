/**
 * Azure Function: unified back-office page.
 *
 * Serves a single consolidated HTML page (`www/admin.html`) that contains every
 * back-office surface as in-page tabs: Overview, Database health, Security
 * upload, and Knowledge Base upload. The page is fully client-side — it reads
 * /api/health for status and posts to the existing upload endpoints — so one
 * static document replaces the previous four separate pages.
 *
 * Route:
 *   /api/backoffice            — the single back-office page (deep links select a
 *                                tab via the URL hash, e.g. /api/backoffice#kb)
 *
 * NB: `/api/admin` is intentionally NOT used — the Functions host reserves the
 * `admin` path segment, so routes under it return 404 regardless of
 * registration (verified live). `backoffice` is the working canonical route.
 *
 * The upload POST endpoints live in d365sec-upload.js / d365kb-upload.js and are
 * unchanged; this module only owns the GET page.
 */

import { app } from '@azure/functions';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { decideAdminAccess, getAuthUser, isEasyAuthEnabled } from '../azure/admin-auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const wwwDir = join(__dirname, '..', '..', 'www');

function loadHtml(name) {
  try {
    return readFileSync(join(wwwDir, name), 'utf8');
  } catch {
    return `<!doctype html><meta charset="utf-8"><title>Not bundled</title>`
      + `<body style="font-family:system-ui;padding:32px;color:#82071e">`
      + `<h1>Page unavailable</h1><p><code>${name}</code> is not present in this deployment.</p></body>`;
  }
}

const ADMIN_HTML = loadHtml('admin.html');

function pageHandler(redirectTarget) {
  return async (request) => {
    const user = getAuthUser(request);
    const easyAuth = isEasyAuthEnabled();
    const rejection = decideAdminAccess({ user, easyAuth, wantsHtml: true, redirectTarget });
    if (rejection) return rejection;
    return {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      },
      body: ADMIN_HTML,
    };
  };
}

app.http('d365backoffice', {
  methods: ['GET'],
  route: 'api/backoffice',
  authLevel: 'anonymous',
  handler: pageHandler('/api/backoffice'),
});
