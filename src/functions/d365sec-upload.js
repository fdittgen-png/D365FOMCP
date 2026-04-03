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
import { mkdtempSync, rmSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { buildSecurityDatabase } from '../azure/sec-builder.js';
import { getSecDb, reloadSecDb, query } from '../azure/shared.js';

const require = createRequire(import.meta.url);
const AdmZip = require('adm-zip');

// ── Azure RBAC role definition IDs ───────────────────────────────────────────

const MAX_UPLOAD_BYTES = 200 * 1024 * 1024; // 200 MB

const OWNER_ROLE_ID = '8e3af657-a8ff-443c-a75c-2fe8c4bcb635';
const CONTRIBUTOR_ROLE_ID = 'b24988ac-6180-42a0-ab88-20f7382dd24c';

// ── Auth helpers ─────────────────────────────────────────────────────────────

/** Check if Easy Auth is enabled on this Function App. */
function isEasyAuthEnabled() {
  return process.env.WEBSITE_AUTH_ENABLED === 'True';
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

// ── HTML Upload Form ─────────────────────────────────────────────────────────

const UPLOAD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>D365FO Security Database Update</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
           max-width: 860px; margin: 0 auto; padding: 32px 20px; color: #24292f; background: #f6f8fa; }
    h1 { font-size: 24px; margin-bottom: 8px; }
    .subtitle { color: #57606a; margin-bottom: 24px; }
    .card { background: #fff; border: 1px solid #d0d7de; border-radius: 6px; padding: 24px; margin-bottom: 16px; }
    .card h2 { font-size: 16px; margin-bottom: 12px; }
    .help-list { font-size: 14px; color: #57606a; padding-left: 20px; }
    .help-list li { margin-bottom: 4px; }
    .help-list code { background: #f0f3f6; padding: 2px 6px; border-radius: 3px; font-size: 13px; }
    .help-list strong { color: #24292f; }

    .db-info { display: flex; gap: 24px; flex-wrap: wrap; font-size: 14px; color: #57606a;
               background: #f0f3f6; border: 1px solid #d0d7de; border-radius: 6px; padding: 12px 16px; margin-bottom: 16px; }
    .db-info .item { display: flex; gap: 6px; }
    .db-info .label { font-weight: 600; color: #24292f; }

    .auth-bar { font-size: 14px; border-radius: 6px; padding: 12px 16px; margin-bottom: 16px; }
    .auth-bar.signed-in { background: #dafbe1; border: 1px solid #4ac26b; color: #116329; }
    .auth-bar.signed-out { background: #fff8c5; border: 1px solid #d4a72c; color: #6a5300; }
    .auth-bar.denied { background: #ffebe9; border: 1px solid #ff8182; color: #82071e; }
    .auth-bar a { color: inherit; font-weight: 600; }

    .upload-area { border: 2px dashed #d0d7de; border-radius: 6px; padding: 40px 20px;
                   text-align: center; cursor: pointer; transition: all 0.15s; }
    .upload-area:hover { border-color: #0969da; background: #f0f6ff; }
    .upload-area.dragover { border-color: #0969da; background: #ddf4ff; }
    .upload-area.disabled { pointer-events: none; opacity: 0.5; }
    .upload-area p { color: #57606a; margin-bottom: 12px; }
    .upload-area .filename { font-weight: 600; color: #0969da; margin-top: 8px; }

    input[type="file"] { display: none; }
    .btn { display: inline-block; background: #2da44e; color: #fff; border: none; padding: 10px 24px;
           border-radius: 6px; font-size: 15px; font-weight: 600; cursor: pointer; transition: background 0.15s;
           text-decoration: none; }
    .btn:hover { background: #218838; }
    .btn:disabled { background: #94d3a2; cursor: not-allowed; }
    .btn-blue { background: #0969da; }
    .btn-blue:hover { background: #0550ae; }
    .btn-row { margin-top: 16px; display: flex; align-items: center; gap: 12px; }

    .status { margin-top: 16px; padding: 16px; border-radius: 6px; display: none; font-size: 14px; }
    .status.info    { display: block; background: #ddf4ff; border: 1px solid #54aeff; color: #0550ae; }
    .status.success { display: block; background: #dafbe1; border: 1px solid #4ac26b; color: #116329; }
    .status.error   { display: block; background: #ffebe9; border: 1px solid #ff8182; color: #82071e; }
    .status h3 { font-size: 15px; margin-bottom: 8px; }
    pre { background: #f6f8fa; padding: 12px; border-radius: 4px; overflow-x: auto;
          font-size: 13px; line-height: 1.5; margin-top: 8px; }
    .spinner { display: inline-block; width: 16px; height: 16px; border: 2px solid #fff;
               border-top-color: transparent; border-radius: 50%; animation: spin 0.6s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <h1>D365FO Security Database Update</h1>
  <p class="subtitle">Upload a ZIP file containing DMF XML exports to rebuild the security database.</p>

  {{AUTH_BAR}}

  <div class="db-info" id="dbInfo">{{DB_INFO}}</div>

  <div class="card">
    <h2>Expected ZIP contents</h2>
    <ul class="help-list">
      <li><strong>Required (DMF):</strong> <code>System Security Role.xml</code>,
          <code>System Security Sub Role V2.xml</code>,
          <code>System Security Role Duty.xml</code></li>
      <li><strong>Optional (DMF):</strong> <code>SystemSecurityUserRoleEntity.xml</code>,
          <code>SystemSecurityUserRoleOrganizationEntity.xml</code>,
          <code>User information.xml</code>,
          <code>SecurityDatabaseCustomizations.xml</code></li>
      <li><strong>Optional (AOT):</strong> Place AOT security XMLs in an <code>aot/</code>
          subdirectory (preserving the PackagesLocalDirectory structure)</li>
    </ul>
  </div>

  <div class="card">
    <form id="uploadForm">
      <div class="upload-area {{UPLOAD_DISABLED}}" id="dropZone">
        <p>Drag &amp; drop a ZIP file here, or click to browse</p>
        <div id="fileName" class="filename"></div>
      </div>
      <input type="file" id="zipFile" accept=".zip" {{INPUT_DISABLED}}>
      <div class="btn-row">
        <button type="submit" class="btn" id="submitBtn" disabled>
          Upload &amp; Rebuild Database
        </button>
      </div>
    </form>

    <div id="status" class="status"></div>
  </div>

  <script>
    const form = document.getElementById('uploadForm');
    const statusEl = document.getElementById('status');
    const submitBtn = document.getElementById('submitBtn');
    const dropZone = document.getElementById('dropZone');
    const fileInput = document.getElementById('zipFile');
    const fileNameEl = document.getElementById('fileName');
    const canUpload = !fileInput.disabled;

    if (canUpload) {
      dropZone.addEventListener('click', () => fileInput.click());
      dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
      dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
      dropZone.addEventListener('drop', e => {
        e.preventDefault();
        dropZone.classList.remove('dragover');
        if (e.dataTransfer.files.length && e.dataTransfer.files[0].name.endsWith('.zip')) {
          fileInput.files = e.dataTransfer.files;
          onFileSelected();
        }
      });
      fileInput.addEventListener('change', onFileSelected);
    }

    function onFileSelected() {
      const file = fileInput.files[0];
      if (file) {
        fileNameEl.textContent = file.name + ' (' + (file.size / (1024*1024)).toFixed(1) + ' MB)';
        submitBtn.disabled = false;
        statusEl.className = 'status';
      }
    }

    form.addEventListener('submit', async e => {
      e.preventDefault();
      if (!canUpload) return;
      const file = fileInput.files[0];
      if (!file) return;

      submitBtn.disabled = true;
      submitBtn.innerHTML = '<span class="spinner"></span> Building...';
      statusEl.className = 'status info';
      statusEl.innerHTML = '<h3>Processing</h3>Uploading ZIP and rebuilding the security database. This may take a minute...';

      try {
        const formData = new FormData();
        formData.append('zipfile', file);
        const resp = await fetch(window.location.href, { method: 'POST', body: formData });
        const result = await resp.json();

        if (resp.ok) {
          statusEl.className = 'status success';
          statusEl.innerHTML = '<h3>Database rebuilt successfully</h3>'
            + '<pre>' + JSON.stringify(result, null, 2) + '</pre>';
        } else {
          statusEl.className = 'status error';
          statusEl.innerHTML = '<h3>' + (resp.status === 403 ? 'Access denied' : 'Build failed') + '</h3>'
            + '<pre>' + JSON.stringify(result, null, 2) + '</pre>';
        }
      } catch (err) {
        statusEl.className = 'status error';
        statusEl.innerHTML = '<h3>Error</h3><p>' + err.message + '</p>';
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Upload & Rebuild Database';
      }
    });
  </script>
</body>
</html>`;

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
      let authBarHtml;
      let formAllowed = false;

      if (!isEasyAuthEnabled() && !user) {
        // Easy Auth not configured — allow access with warning (typical in dev)
        formAllowed = true;
        authBarHtml = `<div class="auth-bar signed-in">`
          + `<span style="opacity:0.7">Authentication not configured — uploads allowed without sign-in. `
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

      if (!user && easyAuth) {
        return {
          status: 401,
          jsonBody: {
            error: 'Authentication required.',
            hint: 'Sign in via Azure AD at /api/d365sec/upload.',
          },
        };
      }

      if (user) {
        const authorized = await isOwnerOrContributor(user.principalId);
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
          context.warn(`RBAC check unavailable — allowing ${user.principalName} (managed identity not configured)`);
        }
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
