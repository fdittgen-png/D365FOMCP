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
import { mkdtempSync, rmSync, readdirSync, existsSync, createWriteStream, copyFileSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import { buildSecurityDatabase } from '../azure/sec-builder.js';
import { getSecDb, reloadSecDb, query } from '../azure/shared.js';
import { ensureContainer, generateUploadSasUrl, downloadBlobToFile, deleteBlob, getStorageAccountName } from '../azure/blob-helper.js';
import { createJob, getJob, updateJob } from '../azure/build-jobs.js';

const require = createRequire(import.meta.url);
const AdmZip = require('adm-zip');
const Database = require('better-sqlite3');

// ── Constants ───────────────────────────────────────────────────────────────

const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;      // 200 MB  (form file upload)
const MAX_URL_DOWNLOAD_BYTES = 4 * 1024 * 1024 * 1024; // 4 GB (URL download)

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

/**
 * Whether authentication is required (issue #28). Defaults to true and
 * fails closed: only the literal string "false" (case-insensitive) disables
 * it — every other value (typos, "0", "no", "") is treated as true.
 */
export function isAuthRequired() {
  const v = (process.env.REQUIRE_AUTH ?? '').trim().toLowerCase();
  return v !== 'false';
}

/**
 * Pure authorization decision for the upload endpoint (issues #27 + #28).
 * Returns `null` when the request may proceed, or an HTTP response object
 * `{ status, jsonBody }` describing the rejection. Fail-closed: an
 * unavailable RBAC check (`authorized === null`) is a 503, never a
 * warn-and-proceed; and with Easy Auth disabled the request is refused
 * unless REQUIRE_AUTH is explicitly set to "false" (local-dev opt-out).
 *
 * @param {object} args
 * @param {{principalId:string, principalName:string}|null} args.user  Easy Auth identity, or null.
 * @param {boolean} args.easyAuth  Whether Easy Auth is enabled on the Function App.
 * @param {boolean|null} args.authorized  RBAC result: true/false, or null when the check could not run.
 * @param {boolean} [args.requireAuth]  Override for isAuthRequired() (defaults to it).
 */
export function decideUploadAuthorization({ user, easyAuth, authorized, requireAuth }) {
  const mustAuth = requireAuth === undefined ? isAuthRequired() : requireAuth;

  // Easy Auth not enabled: header identities are not trustworthy, so refuse
  // unless the operator explicitly opted out for local development.
  if (!easyAuth) {
    if (mustAuth) {
      return {
        status: 503,
        jsonBody: {
          error: 'Easy Auth is not enabled on this Function App, so the uploader cannot be authenticated.',
          hint: 'Enable Easy Auth (Authentication blade), or set REQUIRE_AUTH=false to allow unauthenticated local-dev uploads.',
        },
      };
    }
    return null; // local-dev opt-out
  }

  // Easy Auth enabled.
  if (!user) {
    return {
      status: 401,
      jsonBody: {
        error: 'Authentication required.',
        hint: 'Sign in via Azure AD at /api/d365sec/upload.',
      },
    };
  }
  if (authorized === null || authorized === undefined) {
    return {
      status: 503,
      jsonBody: {
        error: 'Authorization check unavailable — the managed-identity RBAC lookup could not run. Please retry.',
        hint: 'Ensure the Function App has a system-assigned managed identity with RBAC read on the resource group.',
      },
    };
  }
  if (authorized === false) {
    return {
      status: 403,
      jsonBody: {
        error: `Access denied for ${user.principalName}.`,
        hint: 'Owner or Contributor role on the resource group is required.',
      },
    };
  }
  return null; // authorized === true
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
    .divider { text-align: center; margin: 20px 0; position: relative; color: #8b949e; font-size: 14px; }
    .divider::before, .divider::after { content: ''; position: absolute; top: 50%;
      width: calc(50% - 150px); height: 1px; background: #d0d7de; }
    .divider::before { left: 0; }
    .divider::after { right: 0; }
    .divider span { background: #fff; padding: 0 12px; position: relative; }

    .url-group { margin-bottom: 8px; }
    .url-input { width: 100%; padding: 10px 14px; border: 1px solid #d0d7de; border-radius: 6px;
                 font-size: 14px; font-family: inherit; transition: border-color 0.15s; }
    .url-input:focus { outline: none; border-color: #0969da; box-shadow: 0 0 0 3px rgba(9,105,218,0.15); }
    .url-input:disabled { background: #f6f8fa; opacity: 0.6; }
    .url-hint { font-size: 12px; color: #8b949e; margin-top: 6px; }

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
      <li><strong>Optional (DMF &mdash; Duty&rarr;Privilege):</strong> <code>System Security Duty.xml</code>
          &mdash; can be very large (1&ndash;2 GB). Use the URL option below for large files.</li>
      <li><strong>Optional (AOT):</strong> Place AOT security XMLs in an <code>aot/</code>
          subdirectory (preserving the PackagesLocalDirectory structure)</li>
    </ul>
  </div>

  <div class="card">
    <form id="uploadForm">
      <div class="upload-area {{UPLOAD_DISABLED}}" id="dropZone">
        <p>Drag &amp; drop a ZIP file here, or click to browse</p>
        <p style="font-size:13px;color:#8b949e">(supports large files &mdash; streamed directly to server)</p>
        <div id="fileName" class="filename"></div>
      </div>
      <input type="file" id="zipFile" accept=".zip" {{INPUT_DISABLED}}>

      <div class="divider"><span>or download ZIP from URL (supports large files)</span></div>

      <div class="url-group">
        <input type="url" id="zipUrl" name="zip_url" class="url-input"
               placeholder="https://...blob.core.windows.net/exports/dmf-export.zip"
               {{INPUT_DISABLED}}>
        <p class="url-hint">Paste a direct-download URL to a DMF export ZIP (SharePoint, Azure Blob, D365 export URL).
           Used by PowerAutomate &mdash; the server downloads and processes the file.</p>
      </div>

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
    const zipUrlInput = document.getElementById('zipUrl');
    const canUpload = !fileInput.disabled;

    function updateSubmitState() {
      const hasFile = fileInput.files && fileInput.files.length > 0;
      const hasUrl = zipUrlInput.value.trim().length > 0;
      submitBtn.disabled = !(hasFile || hasUrl);
    }

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
      zipUrlInput.addEventListener('input', updateSubmitState);
    }

    function onFileSelected() {
      const file = fileInput.files[0];
      if (file) {
        fileNameEl.textContent = file.name + ' (' + (file.size / (1024*1024)).toFixed(1) + ' MB)';
        statusEl.className = 'status';
      }
      updateSubmitState();
    }

    function showStatus(cls, html) { statusEl.className = 'status ' + cls; statusEl.innerHTML = html; }

    // Async blob upload for large files: SAS → PUT blob → trigger build → poll status
    async function asyncBlobUpload(file) {
      showStatus('info', '<h3>Step 1/4: Requesting upload URL...</h3>');
      const sasResp = await fetch(window.location.pathname + '/sas?filename=' + encodeURIComponent(file.name));
      const sas = await sasResp.json();
      if (!sasResp.ok) throw new Error(sas.error || 'Failed to get upload URL');

      showStatus('info', '<h3>Step 2/4: Uploading to Azure Storage...</h3>'
        + '<p>' + (file.size / (1024*1024)).toFixed(0) + ' MB &mdash; this may take several minutes. Do not close this page.</p>');
      const putResp = await fetch(sas.upload_url, {
        method: 'PUT', headers: { 'x-ms-blob-type': 'BlockBlob', 'Content-Type': 'application/zip' }, body: file,
      });
      if (!putResp.ok) throw new Error('Blob upload failed: HTTP ' + putResp.status);

      showStatus('info', '<h3>Step 3/4: Building security database...</h3>');
      const buildResp = await fetch(window.location.pathname + '/build', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job_id: sas.job_id }),
      });
      const buildData = await buildResp.json();
      if (!buildResp.ok) throw new Error(buildData.error || 'Build trigger failed');

      // Poll for completion
      for (let i = 0; i < 120; i++) {
        await new Promise(r => setTimeout(r, 5000));
        const pollResp = await fetch(window.location.pathname + '/status?job_id=' + sas.job_id);
        const poll = await pollResp.json();
        if (poll.status === 'completed') return poll;
        if (poll.status === 'failed') throw new Error(poll.error || 'Build failed');
        showStatus('info', '<h3>Step 3/4: Building security database...</h3><p>' + (poll.progress || poll.status) + '</p>');
      }
      throw new Error('Build timed out after 10 minutes');
    }

    form.addEventListener('submit', async e => {
      e.preventDefault();
      if (!canUpload) return;
      const file = fileInput.files[0];
      const zipUrl = zipUrlInput.value.trim();
      if (!file && !zipUrl) return;

      submitBtn.disabled = true;
      submitBtn.innerHTML = '<span class="spinner"></span> Building...';

      try {
        let result;

        if (file && file.size > 150 * 1024 * 1024) {
          // Large file: async blob upload (bypasses 230s Azure timeout)
          const poll = await asyncBlobUpload(file);
          showStatus('success', '<h3>Step 4/4: Database rebuilt successfully</h3>'
            + '<pre>' + JSON.stringify(poll.result, null, 2) + '</pre>');
          return;
        }

        showStatus('info', '<h3>Processing</h3>'
          + (file ? 'Uploading and rebuilding...' : 'Downloading from URL and rebuilding...'));

        let resp;
        if (file) {
          resp = await fetch(window.location.href, {
            method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: file,
          });
        } else if (zipUrl) {
          resp = await fetch(window.location.href, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ zip_url: zipUrl }),
          });
        }

        const text = await resp.text();
        try { result = JSON.parse(text); } catch {
          throw new Error('HTTP ' + resp.status + ': ' + text.substring(0, 200));
        }
        if (resp.ok) {
          showStatus('success', '<h3>Database rebuilt successfully</h3>'
            + '<pre>' + JSON.stringify(result, null, 2) + '</pre>');
        } else {
          showStatus('error', '<h3>Build failed</h3><pre>' + JSON.stringify(result, null, 2) + '</pre>');
        }
      } catch (err) {
        showStatus('error', '<h3>Error</h3><p>' + err.message + '</p>');
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
  'system security duty.xml',       // duty→privilege mapping (can be multi-GB)
  'systemsecurityduty.xml',
  'system security privilege.xml',   // role→privilege mapping
  'systemsecurityprivilege.xml',
  'system security permissions.xml', // effective permissions
  'systemsecuritypermissions.xml',
  'systemsecurityuserroleentity.xml',
  'security user role association.xml',
  'userroleassociation.xml',
  'systemsecurityuserroleorganizationentity.xml',
  'system security user role organization.xml',
  'user information.xml',
  'userinformation.xml',
  'systemusers.xml',
  'securitydatabasecustomizations.xml',
  'security privilege metadata customizations entity.xml',
];

function detectDmfDir(extractedDir) {
  const dmfSub = join(extractedDir, 'dmf');
  if (existsSync(dmfSub)) return dmfSub;
  try {
    const files = readdirSync(extractedDir).map(f => f.toLowerCase());
    if (DMF_FILES.some(name => files.includes(name))) return extractedDir;
  } catch (e) { console.warn('cleanup-warn (d365sec-upload):', e?.message); }
  return null;
}

function detectAotDir(extractedDir) {
  // Preferred: explicit aot/ subdirectory
  const aotSub = join(extractedDir, 'aot');
  if (existsSync(aotSub)) return aotSub;
  // Fallback: AxSecurity* directories directly at the root (flat AOT zip)
  if (existsSync(join(extractedDir, 'AxSecurityRole')) ||
      existsSync(join(extractedDir, 'AxSecurityDuty')) ||
      existsSync(join(extractedDir, 'AxSecurityPrivilege'))) {
    return extractedDir;
  }
  return null;
}

/**
 * Download a file from a URL to a local path using streaming (no memory buffering).
 * Validates Content-Length against MAX_URL_DOWNLOAD_BYTES.
 */
async function downloadToFile(url, filePath, context) {
  context.log(`Downloading from URL: ${url}`);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Download failed: ${resp.status} ${resp.statusText}`);

  const contentLength = parseInt(resp.headers.get('content-length') || '0', 10);
  if (contentLength > MAX_URL_DOWNLOAD_BYTES) {
    throw new Error(`Remote file too large (${(contentLength / (1024 * 1024 * 1024)).toFixed(1)} GB). Maximum: ${MAX_URL_DOWNLOAD_BYTES / (1024 * 1024 * 1024)} GB.`);
  }

  const ws = createWriteStream(filePath);
  let downloaded = 0;
  for await (const chunk of resp.body) {
    downloaded += chunk.length;
    if (downloaded > MAX_URL_DOWNLOAD_BYTES) {
      ws.destroy();
      throw new Error('Download exceeded size limit.');
    }
    ws.write(chunk);
  }
  await new Promise((resolve, reject) => { ws.end(); ws.on('finish', resolve); ws.on('error', reject); });
  context.log(`Downloaded ${(downloaded / (1024 * 1024)).toFixed(1)} MB to ${filePath}`);
}

/**
 * Max uncompressed entry size to extract (500 MB).
 * The "System Security Duty" DMF entity produces a 27+ GB XML file
 * (denormalized effective privileges). It is skipped because:
 *   - It would exceed /tmp disk space on Azure (~8 GB)
 *   - The direct duty→privilege mappings come from AOT, not this entity
 *   - Effective permissions are computed at query time by the MCP tools
 */
const MAX_ENTRY_SIZE = 500 * 1024 * 1024;

/**
 * Extract a ZIP file to a directory, skipping oversized entries.
 * Prefers system `unzip` for speed, falls back to AdmZip.
 */
function extractZipSafe(zipPath, destDir, context) {
  // First check for oversized entries and build exclude list
  let excludes = [];
  try {
    const zip = new AdmZip(zipPath);
    for (const entry of zip.getEntries()) {
      if (entry.header.size > MAX_ENTRY_SIZE) {
        excludes.push(entry.entryName);
        context.log(`Skipping oversized entry: ${entry.entryName} (${(entry.header.size / (1024 * 1024 * 1024)).toFixed(1)} GB)`);
      }
    }
  } catch { /* if we can't list, try extracting anyway */ }

  try {
    const excludeArgs = excludes.map(e => `-x "${e}"`).join(' ');
    execSync(`unzip -o -q "${zipPath}" ${excludeArgs} -d "${destDir}"`, {
      stdio: 'pipe',
      timeout: 600000,
    });
    context.log('Extracted ZIP using system unzip' + (excludes.length ? ` (skipped ${excludes.length} oversized entries)` : ''));
  } catch {
    context.log('System unzip not available, falling back to AdmZip');
    const zip = new AdmZip(zipPath);
    const excludeSet = new Set(excludes.map(e => e.toLowerCase()));
    for (const entry of zip.getEntries()) {
      if (excludeSet.has(entry.entryName.toLowerCase())) continue;
      if (entry.header.size > MAX_ENTRY_SIZE) continue;
      zip.extractEntryTo(entry, destDir, true, true);
    }
  }
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

    // ── GET: the upload form is now a tab on the unified back-office page.
    // Redirect for back-compat; the POST endpoints below are unchanged.
    if (request.method === 'GET') {
      return { status: 302, headers: { Location: '/api/backoffice#sec' } };
    }

    // ── POST: process ZIP upload ─────────────────────────────────────────────
    try {
      // Auth check (issues #27 + #28 — fail closed via decideUploadAuthorization).
      const user = getAuthUser(request);
      const easyAuth = isEasyAuthEnabled();
      // Only run the (async) RBAC lookup when there's an authenticated identity
      // to check; otherwise authorized stays null and the decision function
      // handles the unauthenticated / no-Easy-Auth cases.
      const authorized = (easyAuth && user) ? await isOwnerOrContributor(user.principalId) : null;
      const denial = decideUploadAuthorization({ user, easyAuth, authorized });
      if (denial) return denial;

      const uploaderName = user?.principalName || 'anonymous (REQUIRE_AUTH=false)';
      context.log(`Upload authorized for ${uploaderName}`);

      // ── Detect upload mode from Content-Type ────────────────────────────────
      const contentType = (request.headers.get('content-type') || '').toLowerCase();
      const tmpDir = mkdtempSync(join(tmpdir(), 'sec-build-'));

      try {
        let zipUrl = null;

        if (contentType.includes('application/json')) {
          // ── Mode: JSON with zip_url (PowerAutomate / API) ─────────────────
          const body = await request.json();
          zipUrl = body.zip_url;
          if (!zipUrl) {
            return { status: 400, jsonBody: { error: 'Missing zip_url in request body.', hint: 'POST JSON: { "zip_url": "https://..." }' } };
          }
          context.log(`Mode: JSON zip_url`);

        } else if (contentType.includes('application/zip') || contentType.includes('application/octet-stream')) {
          // ── Mode: Raw ZIP body (browser streaming upload / programmatic) ──
          zipUrl = request.headers.get('x-zip-url') || null;
          const zipPath = join(tmpDir, 'upload.zip');
          const ws = createWriteStream(zipPath);
          let bytes = 0;
          for await (const chunk of request.body) {
            bytes += chunk.length;
            if (bytes > MAX_URL_DOWNLOAD_BYTES) { ws.destroy(); throw new Error('Upload exceeds size limit.'); }
            ws.write(chunk);
          }
          await new Promise((resolve, reject) => { ws.end(); ws.on('finish', resolve); ws.on('error', reject); });
          context.log(`Mode: raw body, ${(bytes / (1024 * 1024)).toFixed(1)} MB` + (zipUrl ? ' + URL' : ''));
          extractZipSafe(zipPath, tmpDir, context);

        } else {
          // ── Mode: Multipart form (HTML form upload) ───────────────────────
          const formData = await request.formData();
          const file = formData.get('zipfile');
          zipUrl = formData.get('zip_url') || null;
          if (typeof zipUrl === 'string') zipUrl = zipUrl.trim() || null;

          if (!file && !zipUrl) {
            return { status: 400, jsonBody: { error: 'No ZIP file or URL provided.' } };
          }

          if (file && file.size > 0) {
            if (file.size > MAX_UPLOAD_BYTES) {
              return {
                status: 413,
                jsonBody: {
                  error: `File too large (${(file.size / (1024 * 1024)).toFixed(1)} MB). Maximum: ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB.`,
                  hint: 'For large files, use the URL option instead of uploading directly.',
                },
              };
            }
            context.log(`Mode: form upload, ${file.name} (${file.size} bytes)` + (zipUrl ? ` + URL` : ''));
            const buffer = Buffer.from(await file.arrayBuffer());
            const zip = new AdmZip(buffer);
            zip.extractAllTo(tmpDir, true);
          } else {
            context.log(`Mode: form with URL only`);
          }
        }

        // ── Download from URL if provided ───────────────────────────────────
        if (zipUrl) {
          const urlZipPath = join(tmpDir, 'url-download.zip');
          await downloadToFile(zipUrl, urlZipPath, context);
          extractZipSafe(urlZipPath, tmpDir, context);
          // Clean up the downloaded zip to save disk space
          try { rmSync(urlZipPath, { force: true }); } catch (e) { console.warn('cleanup-warn (d365sec-upload):', e?.message); }
        }

        // ── Detect content and build ────────────────────────────────────────
        const dmfDir = detectDmfDir(tmpDir);
        const aotDir = detectAotDir(tmpDir);

        if (!dmfDir && !aotDir) {
          return {
            status: 400,
            jsonBody: {
              error: 'No recognized XML files found.',
              hint: 'The ZIP must contain DMF XML exports (e.g. System Security Role.xml) '
                  + 'in the root or a dmf/ subdirectory.',
            },
          };
        }

        context.log(`DMF dir: ${dmfDir || '(skip)'}, AOT dir: ${aotDir || '(skip)'}`);

        const dbPath = process.env.SEC_DB_PATH || '/home/data/d365fo_sec.sqlite';
        const logs = [];
        const log = (msg) => { logs.push(msg); context.log(msg); };

        // Decide build mode (same logic as runBuildAsync)
        let mode = 'full';
        if (existsSync(dbPath)) {
          try {
            const existing = new Database(dbPath, { readonly: true, fileMustExist: true });
            const hasAot = existing.prepare('SELECT COUNT(*) as n FROM privilege_entry_points').get().n > 0;
            const hasDmfRoles = existing.prepare('SELECT COUNT(*) as n FROM roles').get().n > 0;
            existing.close();
            if (dmfDir && !aotDir && hasAot) mode = 'merge-dmf';
            else if (aotDir && !dmfDir && hasDmfRoles) mode = 'merge-aot';
          } catch (e) { console.warn('cleanup-warn (d365sec-upload):', e?.message); }
        }

        const newBuildPath = join(tmpDir, 'new-build.sqlite');
        const result = buildSecurityDatabase({
          packagesPathArg: aotDir || 'skip',
          dmfInputDir: dmfDir || 'skip',
          outputPath: newBuildPath,
          log,
        });

        let finalCounts = result.counts;
        let modeLabel = 'full rebuild';

        const ctx = { log };

        if (mode === 'merge-dmf') {
          reloadSecDb();
          finalCounts = mergeBuildsInPlace(dbPath, newBuildPath, ctx);
          modeLabel = 'merged (DMF into existing AOT)';
        } else if (mode === 'merge-aot') {
          reloadSecDb();
          finalCounts = mergeAotUpdateInPlace(dbPath, newBuildPath, ctx);
          modeLabel = 'merged (AOT into existing DMF)';
        } else {
          // sync-inplace-temp: hoist the temp path above the rename try so the
          // matching cleanup runs regardless of which step fails (P6-03).
          let inplaceTemp = null;
          reloadSecDb();
          inplaceTemp = join(dirname(dbPath), 'd365fo_sec.sqlite.new');
          copyFileSync(newBuildPath, inplaceTemp);
          rmSync(dbPath, { force: true });
          try { renameSync(inplaceTemp, dbPath); }
          catch {
            if (existsSync(inplaceTemp)) {
              copyFileSync(inplaceTemp, dbPath);
              rmSync(inplaceTemp, { force: true });
            }
          }
        }

        reloadSecDb();

        return {
          status: 200,
          jsonBody: {
            success: true,
            message: 'Security database rebuilt and reloaded.',
            mode: modeLabel,
            uploadedBy: uploaderName,
            buildDate: new Date().toISOString(),
            counts: finalCounts,
            elapsed: `${result.elapsed}s`,
          },
        };
      } finally {
        try { rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { console.warn('cleanup-warn (d365sec-upload):', e?.message); }
      }
    } catch (err) {
      context.error('d365sec-upload error:', err);
      return { status: 500, jsonBody: { error: err.message } };
    }
  },
});

// ── Async Build Pattern ─────────────────────────────────────────────────────
// For large files and PowerAutomate:
//   1. GET  /sas    → SAS upload URL + job ID
//   2. Client uploads ZIP to blob (no timeout)
//   3. POST /build  → triggers background build (returns 202 immediately)
//   4. GET  /status → poll for completion

/**
 * Compute and persist the per-table counts metadata after a build/merge.
 * Returns the counts object.
 */
function updateBuildMetadata(db, buildMode) {
  const counts = {
    roles: db.prepare('SELECT COUNT(*) as n FROM main.roles').get().n,
    duties: db.prepare('SELECT COUNT(*) as n FROM main.duties').get().n,
    users: db.prepare('SELECT COUNT(*) as n FROM main.users').get().n,
    privileges: db.prepare('SELECT COUNT(*) as n FROM main.privileges').get().n,
    entryPoints: db.prepare('SELECT COUNT(*) as n FROM main.privilege_entry_points').get().n,
    dutyPrivileges: db.prepare('SELECT COUNT(*) as n FROM main.duty_privileges').get().n,
    userRoles: db.prepare('SELECT COUNT(*) as n FROM main.user_roles').get().n,
    roleDuties: db.prepare('SELECT COUNT(*) as n FROM main.role_duties').get().n,
    subRoles: db.prepare('SELECT COUNT(*) as n FROM main.role_subroles').get().n,
    companies: db.prepare('SELECT COUNT(DISTINCT company_id) as n FROM main.user_role_companies').get().n,
  };
  const upsertMeta = db.prepare("INSERT OR REPLACE INTO main.sec_metadata VALUES (?, ?)");
  upsertMeta.run('build_date', new Date().toISOString());
  upsertMeta.run('build_mode', buildMode);
  for (const [k, v] of Object.entries(counts)) upsertMeta.run(k, String(v));
  return counts;
}

/**
 * Merge DMF data from a freshly-built DMF-only database INTO the existing
 * production database in-place using SQLite ATTACH + transaction.
 *
 * No file copying, no renames — works around Azure CIFS rename quirks.
 * Replaces DMF-sourced tables, preserves AOT-sourced tables (privileges,
 * privilege_entry_points, duty_privileges, role_direct_*).
 *
 * The caller MUST ensure the singleton is closed before this runs.
 */
function mergeBuildsInPlace(dbPath, newBuildPath, context) {
  context.log(`Merging DMF data from ${newBuildPath} INTO ${dbPath} (in-place)`);

  const db = new Database(dbPath);
  db.pragma('journal_mode = DELETE'); // safest on CIFS
  db.pragma('synchronous = NORMAL');

  db.exec(`ATTACH DATABASE '${newBuildPath.replace(/'/g, "''")}' AS new_db`);

  try {
    db.exec('BEGIN IMMEDIATE');

    const dmfTables = ['roles', 'role_subroles', 'role_duties', 'users', 'user_roles', 'user_role_companies'];
    for (const t of dmfTables) {
      const before = db.prepare(`SELECT COUNT(*) as n FROM main.${t}`).get().n;
      db.exec(`DELETE FROM main.${t}`);
      db.exec(`INSERT INTO main.${t} SELECT * FROM new_db.${t}`);
      const after = db.prepare(`SELECT COUNT(*) as n FROM main.${t}`).get().n;
      context.log(`  ${t}: ${before} → ${after}`);
    }

    // Add new custom duties from DMF (don't touch existing AOT duties)
    const dutyBefore = db.prepare('SELECT COUNT(*) as n FROM main.duties').get().n;
    db.exec('INSERT OR IGNORE INTO main.duties SELECT * FROM new_db.duties');
    const dutyAfter = db.prepare('SELECT COUNT(*) as n FROM main.duties').get().n;
    context.log(`  duties: ${dutyBefore} → ${dutyAfter} (added ${dutyAfter - dutyBefore} from DMF)`);

    // Refresh search index for DMF object types
    db.exec("DELETE FROM main.sec_search WHERE object_type IN ('role', 'user')");
    db.exec(`
      INSERT INTO main.sec_search (object_type, object_name, module_id, content)
      SELECT 'role', role_name, module_id, role_name || ' ' || COALESCE(label, '') || ' ' || COALESCE(description, '') || ' ' || COALESCE(module_id, '')
      FROM main.roles
    `);
    db.exec(`
      INSERT INTO main.sec_search (object_type, object_name, module_id, content)
      SELECT 'user', user_id, NULL, user_id || ' ' || COALESCE(person_name, '') || ' ' || COALESCE(email, '') || ' ' || COALESCE(default_company, '')
      FROM main.users
    `);

    const counts = updateBuildMetadata(db, 'merged-dmf-into-aot');

    db.exec('COMMIT');
    db.exec('DETACH DATABASE new_db');
    db.close();
    return counts;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (e) { console.warn('cleanup-warn (d365sec-upload):', e?.message); }
    try { db.exec('DETACH DATABASE new_db'); } catch (e) { console.warn('cleanup-warn (d365sec-upload):', e?.message); }
    db.close();
    throw err;
  }
}

/**
 * Merge AOT data from a freshly-built AOT-only database INTO the existing
 * production database in-place. Preserves DMF runtime tables and the bulky
 * 34M effective duty_privileges view.
 *
 * Used by Flow B (AOT update) — typically after a D365 code deploy.
 */
function mergeAotUpdateInPlace(dbPath, newBuildPath, context) {
  context.log(`Merging AOT data from ${newBuildPath} INTO ${dbPath} (in-place)`);

  const db = new Database(dbPath);
  db.pragma('journal_mode = DELETE');
  db.pragma('synchronous = NORMAL');

  db.exec(`ATTACH DATABASE '${newBuildPath.replace(/'/g, "''")}' AS new_db`);

  try {
    db.exec('BEGIN IMMEDIATE');

    // REPLACE: AOT-sourced tables
    const replaceTables = ['privileges', 'privilege_entry_points', 'role_direct_privileges', 'role_direct_entity_permissions'];
    for (const t of replaceTables) {
      const before = db.prepare(`SELECT COUNT(*) as n FROM main.${t}`).get().n;
      db.exec(`DELETE FROM main.${t}`);
      db.exec(`INSERT INTO main.${t} SELECT * FROM new_db.${t}`);
      const after = db.prepare(`SELECT COUNT(*) as n FROM main.${t}`).get().n;
      context.log(`  ${t}: ${before} → ${after}`);
    }

    // ADD-ONLY: new AOT duties (preserve custom DMF duties)
    const dutyBefore = db.prepare('SELECT COUNT(*) as n FROM main.duties').get().n;
    db.exec('INSERT OR IGNORE INTO main.duties SELECT * FROM new_db.duties');
    const dutyAfter = db.prepare('SELECT COUNT(*) as n FROM main.duties').get().n;
    context.log(`  duties: ${dutyBefore} → ${dutyAfter} (added ${dutyAfter - dutyBefore} from AOT)`);

    // ADD-ONLY: AOT direct duty-privilege pairs (preserves the 34M effective view)
    const dpBefore = db.prepare('SELECT COUNT(*) as n FROM main.duty_privileges').get().n;
    db.exec('INSERT OR IGNORE INTO main.duty_privileges SELECT * FROM new_db.duty_privileges');
    const dpAfter = db.prepare('SELECT COUNT(*) as n FROM main.duty_privileges').get().n;
    context.log(`  duty_privileges: ${dpBefore} → ${dpAfter} (added ${dpAfter - dpBefore} from AOT)`);

    // Refresh search index for refreshed object types
    db.exec("DELETE FROM main.sec_search WHERE object_type IN ('duty', 'privilege')");
    db.exec(`
      INSERT INTO main.sec_search (object_type, object_name, module_id, content)
      SELECT 'duty', duty_id, module_id, duty_id || ' ' || COALESCE(duty_name, '') || ' ' || COALESCE(description, '') || ' ' || COALESCE(module_id, '')
      FROM main.duties
    `);
    db.exec(`
      INSERT INTO main.sec_search (object_type, object_name, module_id, content)
      SELECT 'privilege', privilege_name, module_id, privilege_name || ' ' || COALESCE(label, '') || ' ' || COALESCE(module_id, '')
      FROM main.privileges
    `);

    const counts = updateBuildMetadata(db, 'merged-aot-into-dmf');

    db.exec('COMMIT');
    db.exec('DETACH DATABASE new_db');
    db.close();
    return counts;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (e) { console.warn('cleanup-warn (d365sec-upload):', e?.message); }
    try { db.exec('DETACH DATABASE new_db'); } catch (e) { console.warn('cleanup-warn (d365sec-upload):', e?.message); }
    db.close();
    throw err;
  }
}

/**
 * Run the security database build in the background.
 * Called from /build endpoint — runs after the HTTP response is sent.
 */
async function runBuildAsync(jobId, context) {
  const job = getJob(jobId);
  if (!job) return;

  const tmpDir = mkdtempSync(join(tmpdir(), 'sec-build-'));
  try {
    // Download from source
    if (job.sourceUrl) {
      updateJob(jobId, { status: 'downloading', progress: 'Downloading ZIP from source URL...' });
      const zipPath = join(tmpDir, 'download.zip');
      await downloadToFile(job.sourceUrl, zipPath, { log: (msg) => context.log(msg) });
      extractZipSafe(zipPath, tmpDir, { log: (msg) => context.log(msg) });
      try { rmSync(zipPath, { force: true }); } catch (e) { console.warn('cleanup-warn (d365sec-upload):', e?.message); }
    } else if (job.blobName) {
      updateJob(jobId, { status: 'downloading', progress: 'Downloading ZIP from blob storage...' });
      const zipPath = join(tmpDir, 'upload.zip');
      await downloadBlobToFile(job.blobName, zipPath);
      updateJob(jobId, { status: 'extracting', progress: 'Extracting ZIP...' });
      extractZipSafe(zipPath, tmpDir, { log: (msg) => context.log(msg) });
      try { rmSync(zipPath, { force: true }); } catch (e) { console.warn('cleanup-warn (d365sec-upload):', e?.message); }
    }

    const dmfDir = detectDmfDir(tmpDir);
    const aotDir = detectAotDir(tmpDir);
    if (!dmfDir && !aotDir) {
      throw new Error('No recognized DMF XML or AOT files found in the ZIP.');
    }

    updateJob(jobId, { status: 'building', progress: 'Building security database...' });

    const dbPath = process.env.SEC_DB_PATH || '/home/data/d365fo_sec.sqlite';

    // Decide build mode based on what's in the upload:
    //   has DMF + AOT: full rebuild (no merge)
    //   has DMF only:  merge DMF into existing AOT (Flow A)
    //   has AOT only:  merge AOT into existing DMF (Flow B)
    let mode = 'full';
    if (existsSync(dbPath)) {
      try {
        const existing = new Database(dbPath, { readonly: true, fileMustExist: true });
        const hasAot = existing.prepare('SELECT COUNT(*) as n FROM privilege_entry_points').get().n > 0;
        const hasDmfRoles = existing.prepare('SELECT COUNT(*) as n FROM roles').get().n > 0;
        existing.close();
        if (dmfDir && !aotDir && hasAot) mode = 'merge-dmf';
        else if (aotDir && !dmfDir && hasDmfRoles) mode = 'merge-aot';
      } catch { /* DB unreadable, full rebuild */ }
    }

    context.log(`Build mode: ${mode}`);

    // Always build to temp (never directly overwrite dbPath)
    const newBuildPath = join(tmpDir, 'new-build.sqlite');
    const result = buildSecurityDatabase({
      packagesPathArg: aotDir || 'skip',
      dmfInputDir: dmfDir || 'skip',
      outputPath: newBuildPath,
      log: (msg) => {
        context.log(msg);
        updateJob(jobId, { progress: msg });
      },
    });

    let finalCounts = result.counts;
    let modeLabel = 'full rebuild';

    if (mode === 'merge-dmf') {
      updateJob(jobId, { progress: 'Merging DMF data into existing database (preserving AOT)...' });
      reloadSecDb(); // Close singleton before in-place modification
      finalCounts = mergeBuildsInPlace(dbPath, newBuildPath, context);
      modeLabel = 'merged (DMF into existing AOT)';
    } else if (mode === 'merge-aot') {
      updateJob(jobId, { progress: 'Merging AOT data into existing database (preserving DMF)...' });
      reloadSecDb();
      finalCounts = mergeAotUpdateInPlace(dbPath, newBuildPath, context);
      modeLabel = 'merged (AOT into existing DMF)';
    } else {
      // Full rebuild: replace dbPath with new build via same-directory rename.
      // async-inplace-temp: hoist the temp path above the rename try so the
      // matching cleanup runs regardless of which step fails (P6-03).
      let inplaceTemp = null;
      reloadSecDb();
      inplaceTemp = join(dirname(dbPath), 'd365fo_sec.sqlite.new');
      copyFileSync(newBuildPath, inplaceTemp);
      rmSync(dbPath, { force: true });
      try { renameSync(inplaceTemp, dbPath); }
      catch {
        if (existsSync(inplaceTemp)) {
          copyFileSync(inplaceTemp, dbPath);
          rmSync(inplaceTemp, { force: true });
        } else if (!existsSync(dbPath)) {
          throw new Error('Full rebuild lost the new database file');
        }
      }
    }

    reloadSecDb();

    updateJob(jobId, {
      status: 'completed',
      progress: 'Done',
      result: {
        mode: modeLabel,
        counts: finalCounts,
        elapsed: `${result.elapsed}s`,
      },
    });
  } catch (err) {
    context.error(`Build job ${jobId} failed:`, err);
    updateJob(jobId, { status: 'failed', error: err.message });
  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { console.warn('cleanup-warn (d365sec-upload):', e?.message); }
    if (job.blobName) deleteBlob(job.blobName).catch(() => {});
  }
}

// ── GET /api/d365sec/upload/sas ─────────────────────────────────────────────

app.http('d365sec-upload-sas', {
  methods: ['GET'],
  route: 'd365sec/upload/sas',
  authLevel: 'anonymous',
  handler: async (request, context) => {
    try {
      const filename = new URL(request.url).searchParams.get('filename') || 'export.zip';
      const job = createJob();
      const blobName = `${job.id}/${filename}`;
      updateJob(job.id, { blobName });

      await ensureContainer();
      const uploadUrl = generateUploadSasUrl(blobName, 60);

      return {
        status: 200,
        jsonBody: {
          job_id: job.id,
          upload_url: uploadUrl,
          blob_name: blobName,
          expires_in: 3600,
        },
      };
    } catch (err) {
      context.error('SAS generation error:', err);
      return { status: 500, jsonBody: { error: err.message } };
    }
  },
});

// ── POST /api/d365sec/upload/build ──────────────────────────────────────────

app.http('d365sec-upload-build', {
  methods: ['POST'],
  route: 'd365sec/upload/build',
  authLevel: 'anonymous',
  handler: async (request, context) => {
    try {
      const body = await request.json();

      let job;
      if (body.job_id) {
        // Resume a job that was created via /sas
        job = getJob(body.job_id);
        if (!job) return { status: 404, jsonBody: { error: `Job ${body.job_id} not found.` } };
        if (job.status !== 'pending') return { status: 409, jsonBody: { error: `Job already ${job.status}.` } };
      } else if (body.source_url) {
        // PowerAutomate shortcut: create job + start build from URL
        job = createJob({ sourceUrl: body.source_url });
      } else {
        return {
          status: 400,
          jsonBody: {
            error: 'Provide job_id (from /sas) or source_url (direct download URL).',
            examples: [
              { job_id: 'abc123' },
              { source_url: 'https://d365-export-url/package.zip' },
            ],
          },
        };
      }

      // Start build in background — return 202 immediately
      setImmediate(() => runBuildAsync(job.id, context));

      return {
        status: 202,
        jsonBody: {
          job_id: job.id,
          status: 'accepted',
          status_url: `/api/d365sec/upload/status?job_id=${job.id}`,
          message: 'Build started. Poll the status_url for progress.',
        },
      };
    } catch (err) {
      context.error('Build trigger error:', err);
      const status = err.message.includes('already in progress') ? 409 : 500;
      return { status, jsonBody: { error: err.message } };
    }
  },
});

// ── GET /api/d365sec/upload/status ──────────────────────────────────────────

app.http('d365sec-upload-status', {
  methods: ['GET'],
  route: 'd365sec/upload/status',
  authLevel: 'anonymous',
  handler: async (request) => {
    const jobId = new URL(request.url).searchParams.get('job_id');
    if (!jobId) return { status: 400, jsonBody: { error: 'Missing job_id query parameter.' } };

    const job = getJob(jobId);
    if (!job) return { status: 404, jsonBody: { error: `Job ${jobId} not found.` } };

    const response = {
      job_id: job.id,
      status: job.status,
      progress: job.progress,
      created_at: job.createdAt,
      updated_at: job.updatedAt,
    };

    if (job.status === 'completed') response.result = job.result;
    if (job.status === 'failed') response.error = job.error;

    return { status: 200, jsonBody: response };
  },
});
