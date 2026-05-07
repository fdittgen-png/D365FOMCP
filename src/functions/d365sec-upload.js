/**
 * Azure Function: D365FO Security Database Upload & Rebuild
 *
 * Provides an HTML form to upload a ZIP file with DMF XML exports (and
 * optionally AOT security XMLs) and rebuilds the security database in place.
 *
 * Authentication: Requires Azure AD sign-in via Easy Auth.
 * Authorization:  POST restricted to users with Owner or Contributor role
 *                 on the resource group (checked via ARM API + managed identity).
 *
 * Prerequisites:
 *   1. Enable Easy Auth on the Function App (Authentication blade → Add provider → Microsoft)
 *      Set "Unauthenticated requests" to "Allow" (so MCP endpoints remain open)
 *   2. Enable a system-assigned managed identity on the Function App
 *   3. Grant the managed identity "Reader" role on the resource group
 *      (needed to read role assignments via ARM API)
 *
 * URL: /api/d365sec/upload
 *   GET  — Returns the upload form (with sign-in prompt if unauthenticated)
 *   POST — Accepts ZIP, checks RBAC, rebuilds database, reloads singleton
 */

import { app } from '@azure/functions';
import { createRequire } from 'module';
import { mkdtempSync, rmSync, readdirSync, existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { buildSecurityDatabase } from '../azure/sec-builder.js';
import { getSecDb, reloadSecDb, query } from '../azure/shared.js';

const require = createRequire(import.meta.url);
const AdmZip = require('adm-zip');

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Azure RBAC role definition IDs ───────────────────────────────────────────

const MAX_UPLOAD_BYTES = 200 * 1024 * 1024; // 200 MB

const OWNER_ROLE_ID = '8e3af657-a8ff-443c-a75c-2fe8c4bcb635';
const CONTRIBUTOR_ROLE_ID = 'b24988ac-6180-42a0-ab88-20f7382dd24c';

// ── Auth helpers ─────────────────────────────────────────────────────────────

/** Check if Easy Auth is enabled on this Function App. */
function isEasyAuthEnabled() {
  return process.env.WEBSITE_AUTH_ENABLED === 'True';
}

/**
 * Whether authentication is required for upload requests.
 *
 * Defaults to `true` (fail-closed). Set `REQUIRE_AUTH=false` only as an explicit
 * opt-out for local development. In production, leaving this at the default
 * combined with Easy Auth being disabled will cause uploads to be refused with
 * HTTP 503 — this prevents an Easy Auth misconfiguration from silently
 * accepting unauthenticated uploads (issue #28).
 */
export function isAuthRequired() {
  // Any value other than the literal string 'false' (case-insensitive) is treated as true.
  const v = String(process.env.REQUIRE_AUTH ?? 'true').trim().toLowerCase();
  return v !== 'false';
}

/** Read the user identity from Easy Auth headers (set by App Service Authentication). */
function getAuthUser(request) {
  const principalId = request.headers.get('x-ms-client-principal-id');
  const principalName = request.headers.get('x-ms-client-principal-name');
  if (!principalId) return null;
  return { principalId, principalName };
}

/** Obtain an ARM access token using the Function App's managed identity. */
async function getArmToken() {
  const endpoint = process.env.IDENTITY_ENDPOINT;
  const header = process.env.IDENTITY_HEADER;
  if (!endpoint || !header) return null;

  const url = `${endpoint}?resource=https://management.azure.com&api-version=2019-08-01`;
  const resp = await fetch(url, { headers: { 'X-IDENTITY-HEADER': header } });
  if (!resp.ok) return null;
  return (await resp.json()).access_token;
}

/**
 * Check whether the given principal has Owner or Contributor role on the
 * resource group.  Returns true/false, or null if RBAC cannot be verified
 * (e.g. no managed identity or missing Reader role on the RG).
 */
async function isOwnerOrContributor(principalId) {
  const armToken = await getArmToken();
  if (!armToken) return null;

  // Derive subscription + resource group from App Service environment
  const subId = (process.env.WEBSITE_OWNER_NAME || '').split('+')[0];
  const siteName = process.env.WEBSITE_SITE_NAME || '';
  const rgName = siteName.replace(/-func$/, '-rg');
  if (!subId || !rgName) return null;

  const scope = `/subscriptions/${subId}/resourceGroups/${rgName}`;
  const filter = encodeURIComponent(`principalId eq '${principalId}'`);
  const url = `https://management.azure.com${scope}/providers/Microsoft.Authorization/roleAssignments`
    + `?api-version=2022-04-01&$filter=${filter}`;

  const resp = await fetch(url, { headers: { Authorization: `Bearer ${armToken}` } });
  if (!resp.ok) return null;

  const data = await resp.json();
  return (data.value || []).some(ra => {
    const defId = ra.properties?.roleDefinitionId || '';
    return defId.endsWith(OWNER_ROLE_ID) || defId.endsWith(CONTRIBUTOR_ROLE_ID);
  });
}

/**
 * Decide whether an upload request is authorized. Pure function — easy to unit-test.
 * Returns `null` when the request may proceed; otherwise returns the rejection
 * response `{ status, jsonBody }` to send back to the client.
 *
 * Fail-closed on `authorized === null` (issue #27): when the RBAC check cannot run
 * (no managed identity, ARM token unavailable, missing Reader role), we reject
 * with 503 instead of allowing the upload through.
 *
 * Fail-closed when Easy Auth is disabled (issue #28): if `requireAuth` is true
 * (the default) and Easy Auth is not enabled on the Function App, refuse the
 * upload with HTTP 503. The previous behavior — silently allowing anonymous
 * uploads when `WEBSITE_AUTH_ENABLED !== 'True'` — meant a production deploy
 * without Easy Auth would accept unauthenticated database replacements. Set
 * `REQUIRE_AUTH=false` explicitly only for local development.
 */
export function decideUploadAuthorization({ user, easyAuth, authorized, requireAuth = true }) {
  if (!easyAuth && requireAuth) {
    return {
      status: 503,
      jsonBody: {
        error: 'Authentication is required but Easy Auth is not enabled — upload rejected.',
        hint: 'Enable Easy Auth (App Service Authentication) on the Function App, or set REQUIRE_AUTH=false for local development.',
      },
    };
  }
  if (!user && easyAuth) {
    return {
      status: 401,
      jsonBody: {
        error: 'Authentication required.',
        hint: 'Sign in via Azure AD at /api/d365sec/upload.',
      },
    };
  }
  if (!user) return null; // local dev / no Easy Auth + REQUIRE_AUTH=false — anonymous allowed
  if (authorized === false) {
    return {
      status: 403,
      jsonBody: {
        error: `Access denied for ${user.principalName}.`,
        hint: 'Owner or Contributor role on the resource group is required.',
      },
    };
  }
  if (authorized === null) {
    return {
      status: 503,
      jsonBody: {
        error: 'Authorization check unavailable — upload rejected.',
        hint: 'Configure a system-assigned managed identity with Reader role on the resource group, then retry.',
      },
    };
  }
  return null;
}

// ── HTML Upload Form ─────────────────────────────────────────────────────────
//
// The form template is loaded from `www/upload.html` (issue #35) so the same
// page can also be served by the new admin dashboard. The static file contains
// the placeholders `{{AUTH_BAR}}`, `{{DB_INFO}}`, `{{UPLOAD_DISABLED}}` and
// `{{INPUT_DISABLED}}` which the GET handler substitutes per-request.

const UPLOAD_HTML_PATH = join(__dirname, '..', '..', 'www', 'upload.html');

let UPLOAD_HTML;
try {
  UPLOAD_HTML = readFileSync(UPLOAD_HTML_PATH, 'utf8');
} catch {
  UPLOAD_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Upload form unavailable</title></head>
<body style="font-family:system-ui;padding:32px"><h1>Upload form unavailable</h1>
<p>The static page <code>www/upload.html</code> is not bundled in this deployment.</p>
{{AUTH_BAR}}{{DB_INFO}}</body></html>`;
}


// ── Helpers ──────────────────────────────────────────────────────────────────

/** Known DMF file names (case-insensitive check) */
const DMF_FILES = [
  'system security role.xml',
  'systemsecurityrole.xml',
  'system security sub role v2.xml',
  'systemsecuritysubrolev2.xml',
  'system security role duty.xml',
  'systemsecurityroleduty.xml',
  'systemsecurityuserroleentity.xml',
  'security user role association.xml',
  'userroleassociation.xml',
  'systemsecurityuserroleorganizationentity.xml',
  'system security user role organization.xml',
  'user information.xml',
  'userinformation.xml',
  'systemusers.xml',
  'securitydatabasecustomizations.xml',
];

function detectDmfDir(extractedDir) {
  const dmfSub = join(extractedDir, 'dmf');
  if (existsSync(dmfSub)) return dmfSub;
  try {
    const files = readdirSync(extractedDir).map(f => f.toLowerCase());
    if (DMF_FILES.some(name => files.includes(name))) return extractedDir;
  } catch { /* ignore */ }
  return null;
}

function detectAotDir(extractedDir) {
  const aotSub = join(extractedDir, 'aot');
  if (existsSync(aotSub)) return aotSub;
  return null;
}

/** Build the DB info HTML from current sec_metadata. */
function buildDbInfoHtml() {
  try {
    const db = getSecDb();
    const meta = query(db, "SELECT key, value FROM sec_metadata WHERE key IN ('build_date','roles','users','duties')");
    const m = Object.fromEntries(meta.map(r => [r.key, r.value]));
    if (m.build_date) {
      const d = new Date(m.build_date);
      const fmt = d.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC';
      return `<span class="item"><span class="label">Last updated:</span> ${fmt}</span>`
        + `<span class="item"><span class="label">Roles:</span> ${m.roles || '?'}</span>`
        + `<span class="item"><span class="label">Duties:</span> ${m.duties || '?'}</span>`
        + `<span class="item"><span class="label">Users:</span> ${m.users || '?'}</span>`;
    }
  } catch { /* DB not available yet */ }
  return '<span style="color:#8b949e">No database loaded yet.</span>';
}

// ── Azure Function ───────────────────────────────────────────────────────────

app.http('d365sec-upload', {
  methods: ['GET', 'POST'],
  route: 'd365sec/upload',
  authLevel: 'anonymous',
  handler: async (request, context) => {

    // ── GET: serve the upload form ───────────────────────────────────────────
    if (request.method === 'GET') {
      const user = getAuthUser(request);
      const easyAuth = isEasyAuthEnabled();
      const requireAuth = isAuthRequired();
      let authBarHtml;
      let formAllowed = false;

      if (!easyAuth && requireAuth) {
        // Fail-closed (issue #28): Easy Auth disabled but auth is required.
        // Show a denial banner instead of the form — POST will return 503 anyway.
        authBarHtml = `<div class="auth-bar denied">`
          + `Uploads are disabled: Easy Auth is not enabled on this Function App and <code>REQUIRE_AUTH</code> is true. `
          + `Enable Easy Auth in the Azure Portal, or set <code>REQUIRE_AUTH=false</code> for local development.</div>`;
      } else if (!easyAuth && !user) {
        // Easy Auth not configured AND REQUIRE_AUTH=false (explicit local-dev opt-out)
        formAllowed = true;
        authBarHtml = `<div class="auth-bar signed-in">`
          + `<span style="opacity:0.7">Authentication not configured (REQUIRE_AUTH=false) — uploads allowed without sign-in. `
          + `Enable Easy Auth in Azure Portal for production use.</span></div>`;
      } else if (!user) {
        // Easy Auth enabled but not signed in — show login prompt
        authBarHtml = `<div class="auth-bar signed-out">`
          + `Sign in required. <a href="/.auth/login/aad?post_login_redirect_uri=/api/d365sec/upload">Sign in with Azure AD</a>`
          + ` (Owner or Contributor role needed to upload).</div>`;
      } else {
        // Signed in — check RBAC
        const authorized = await isOwnerOrContributor(user.principalId);
        if (authorized === true) {
          formAllowed = true;
          authBarHtml = `<div class="auth-bar signed-in">`
            + `Signed in as <strong>${user.principalName}</strong></div>`;
        } else if (authorized === false) {
          authBarHtml = `<div class="auth-bar denied">`
            + `Access denied for <strong>${user.principalName}</strong>. `
            + `Owner or Contributor role on the resource group is required.</div>`;
        } else {
          // RBAC check unavailable (no managed identity) — allow with warning
          formAllowed = true;
          authBarHtml = `<div class="auth-bar signed-in">`
            + `Signed in as <strong>${user.principalName}</strong> `
            + `<span style="opacity:0.7">(RBAC check unavailable — managed identity not configured)</span></div>`;
        }
      }

      const html = UPLOAD_HTML
        .replace('{{AUTH_BAR}}', authBarHtml)
        .replace('{{DB_INFO}}', buildDbInfoHtml())
        .replace('{{UPLOAD_DISABLED}}', formAllowed ? '' : 'disabled')
        .replace('{{INPUT_DISABLED}}', formAllowed ? '' : 'disabled');

      return { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: html };
    }

    // ── POST: process ZIP upload ─────────────────────────────────────────────
    try {
      // Auth check
      const user = getAuthUser(request);
      const easyAuth = isEasyAuthEnabled();
      const requireAuth = isAuthRequired();

      const authorized = user ? await isOwnerOrContributor(user.principalId) : null;
      const rejection = decideUploadAuthorization({ user, easyAuth, authorized, requireAuth });
      if (rejection) {
        if (!easyAuth && requireAuth) {
          context.error('CRITICAL: Easy Auth is disabled but REQUIRE_AUTH=true — rejecting upload with 503 (fail-closed; issue #28). '
            + 'Enable Easy Auth on the Function App, or set REQUIRE_AUTH=false for local development.');
        } else if (authorized === null && user) {
          context.error(`RBAC check unavailable for ${user.principalName} — rejecting upload (fail-closed; issue #27)`);
        }
        return rejection;
      }

      const uploaderName = user?.principalName || 'anonymous (no Easy Auth)';
      context.log(`Upload authorized for ${uploaderName}`);

      // Parse multipart form data
      const formData = await request.formData();
      const file = formData.get('zipfile');
      if (!file) {
        return { status: 400, jsonBody: { error: 'No ZIP file uploaded.' } };
      }

      if (file.size > MAX_UPLOAD_BYTES) {
        return {
          status: 413,
          jsonBody: { error: `File too large (${(file.size / (1024 * 1024)).toFixed(1)} MB). Maximum: ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB.` },
        };
      }

      context.log(`Received ZIP: ${file.name}, ${file.size} bytes`);

      // Extract ZIP to temp directory
      const buffer = Buffer.from(await file.arrayBuffer());
      const tmpDir = mkdtempSync(join(tmpdir(), 'sec-build-'));

      try {
        const zip = new AdmZip(buffer);
        zip.extractAllTo(tmpDir, true);

        const dmfDir = detectDmfDir(tmpDir);
        const aotDir = detectAotDir(tmpDir);

        if (!dmfDir && !aotDir) {
          return {
            status: 400,
            jsonBody: {
              error: 'No recognized XML files found in the ZIP.',
              hint: 'Place DMF XML exports in the ZIP root or a dmf/ subdirectory. '
                  + 'Place AOT security XMLs in an aot/ subdirectory.',
            },
          };
        }

        context.log(`DMF dir: ${dmfDir || '(skip)'}, AOT dir: ${aotDir || '(skip)'}`);

        const dbPath = process.env.SEC_DB_PATH || '/home/data/d365fo_sec.sqlite';
        const logs = [];
        const log = (msg) => { logs.push(msg); context.log(msg); };

        const result = buildSecurityDatabase({
          packagesPathArg: aotDir || 'skip',
          dmfInputDir: dmfDir || 'skip',
          outputPath: dbPath,
          log,
        });

        reloadSecDb();

        return {
          status: 200,
          jsonBody: {
            success: true,
            message: 'Security database rebuilt and reloaded.',
            uploadedBy: uploaderName,
            buildDate: new Date().toISOString(),
            counts: result.counts,
            elapsed: `${result.elapsed}s`,
            fileSize: `${result.fileSize} MB`,
          },
        };
      } finally {
        try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    } catch (err) {
      context.error('d365sec-upload error:', err);
      return { status: 500, jsonBody: { error: err.message } };
    }
  },
});
