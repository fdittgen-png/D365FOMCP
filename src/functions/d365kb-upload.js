/**
 * Azure Function: D365FO Knowledge Base Database Upload & Swap
 *
 * The KB database (~1 GB) is built locally from the Microsoft
 * PackagesLocalDirectory plus customization model roots (see build/build-kb.js
 * and KB_PACKAGES_PATHS). It is far too large to rebuild on Azure, so this
 * endpoint accepts a PRE-BUILT KB SQLite file, validates it, and atomically
 * swaps it in — letting an operator refresh the KB (e.g. after re-running the
 * build with new customizations) without a full Function App redeploy.
 *
 * Because the file is large, uploads always go through Azure Blob Storage via
 * a SAS URL (the same async pattern as the Sec upload), never a direct POST.
 *
 * Authentication: Easy Auth (Azure AD). Authorization: Owner/Contributor on the
 * resource group, reusing the Sec upload's fail-closed decision logic.
 *
 * Routes:
 *   GET  /api/d365kb/upload          — upload form (www/kb-upload.html)
 *   GET  /api/d365kb/upload/sas      — issue a SAS upload URL + job id
 *   POST /api/d365kb/upload/apply    — download blob, validate, swap, reload
 *   GET  /api/d365kb/upload/status   — poll job progress
 */

import { app } from '@azure/functions';
import { createRequire } from 'module';
import { readFileSync, mkdtempSync, rmSync, existsSync, copyFileSync, renameSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { getKbDb, reloadKbDb, query } from '../azure/shared.js';
import { ensureContainer, generateUploadSasUrl, downloadBlobToFile, deleteBlob } from '../azure/blob-helper.js';
import { createJob, getJob, updateJob } from '../azure/build-jobs.js';
import { getAuthUser, isEasyAuthEnabled } from '../azure/admin-auth.js';
import { decideUploadAuthorization } from './d365sec-upload.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const AdmZip = require('adm-zip');

const __dirname = dirname(fileURLToPath(import.meta.url));
const wwwDir = join(__dirname, '..', '..', 'www');

const OWNER_ROLE_ID = '8e3af657-a8ff-443c-a75c-2fe8c4bcb635';
const CONTRIBUTOR_ROLE_ID = 'b24988ac-6180-42a0-ab88-20f7382dd24c';

// ── HTML (loaded at startup, mirrors d365admin-pages pattern) ────────────────

function loadHtml(name) {
  try {
    return readFileSync(join(wwwDir, name), 'utf8');
  } catch {
    return `<!doctype html><meta charset="utf-8"><title>Not bundled</title>`
      + `<body style="font-family:system-ui;padding:32px;color:#82071e">`
      + `<h1>Page unavailable</h1><p><code>${name}</code> is not present in this deployment.</p></body>`;
  }
}
const KB_UPLOAD_HTML = loadHtml('kb-upload.html');

// ── Auth (ARM RBAC; pure decision reused from the Sec upload) ────────────────

async function getArmToken() {
  const endpoint = process.env.IDENTITY_ENDPOINT;
  const header = process.env.IDENTITY_HEADER;
  if (!endpoint || !header) return null;
  const url = `${endpoint}?resource=https://management.azure.com&api-version=2019-08-01`;
  const resp = await fetch(url, { headers: { 'X-IDENTITY-HEADER': header } });
  if (!resp.ok) return null;
  return (await resp.json()).access_token;
}

/** True/false if the principal has Owner/Contributor on the RG, or null when
 *  the RBAC check cannot run (no managed identity / missing Reader). */
async function isOwnerOrContributor(principalId) {
  const armToken = await getArmToken();
  if (!armToken) return null;

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

// ── KB DB helpers ────────────────────────────────────────────────────────────

function kbDbPath() {
  return process.env.KB_DB_PATH || '/home/data/d365fo_kb.sqlite';
}

/** Read current KB metadata for the form's "currently loaded" panel. */
function readKbInfo(db) {
  const out = {};
  try {
    const rows = query(db, "SELECT key, value FROM kb_metadata WHERE key IN ('build_date','d365fo_version','has_customizations','custom_packages_paths','schema_version')");
    for (const r of rows) out[r.key] = r.value;
    const t = query(db, 'SELECT COUNT(*) AS n FROM tables');
    out.tables = t.length ? t[0].n : null;
  } catch { /* DB not loaded yet */ }
  return out;
}

/**
 * Validate that a freshly-downloaded file is a usable KB database. Opens it
 * read-only and checks for the metadata + a non-empty core table. Returns a
 * summary object on success; throws on any structural problem so the caller
 * never swaps in a broken file.
 */
function validateKbDatabase(filePath) {
  if (!existsSync(filePath)) throw new Error('Uploaded file not found after download.');
  const size = statSync(filePath).size;
  if (size < 1024 * 1024) throw new Error(`File too small to be a KB database (${size} bytes).`);

  let probe;
  try {
    probe = new Database(filePath, { readonly: true, fileMustExist: true });
  } catch (e) {
    throw new Error(`Not a readable SQLite database: ${e.message}`);
  }
  try {
    // better-sqlite3 opens lazily, so a non-SQLite / corrupt file only fails on
    // the first query. Catch structural-probe failures and surface a clean
    // message; let our own validation errors (build_date / zero tables) pass
    // through unchanged.
    let buildDate, tableCount, meta;
    try {
      buildDate = probe.prepare("SELECT value FROM kb_metadata WHERE key = 'build_date'").get();
      tableCount = probe.prepare('SELECT COUNT(*) AS n FROM tables').get().n;
      meta = {};
      for (const r of probe.prepare("SELECT key, value FROM kb_metadata").all()) meta[r.key] = r.value;
    } catch (e) {
      throw new Error(`Not a valid KB database (missing expected schema): ${e.message}`);
    }

    if (!buildDate || !buildDate.value) {
      throw new Error('Missing kb_metadata.build_date — not a KB database built by build-kb.js.');
    }
    if (!tableCount) throw new Error('KB database has zero tables — refusing to swap in an empty build.');

    return {
      sizeMB: Number((size / (1024 * 1024)).toFixed(1)),
      tables: tableCount,
      buildDate: meta.build_date,
      d365foVersion: meta.d365fo_version || null,
      hasCustomizations: meta.has_customizations === '1',
      customPackagesPaths: meta.custom_packages_paths || '',
    };
  } finally {
    try { probe.close(); } catch (e) { console.warn('cleanup-warn (kb-upload validate):', e?.message); }
  }
}

/** Atomically replace the live KB DB file with `newPath` (same-dir rename). */
function swapKbDatabase(newPath, context) {
  const dbPath = kbDbPath();
  reloadKbDb(); // release the read-only singleton handle before touching the file
  const inplaceTemp = join(dirname(dbPath), 'd365fo_kb.sqlite.new');
  copyFileSync(newPath, inplaceTemp);
  if (existsSync(dbPath)) rmSync(dbPath, { force: true });
  try {
    renameSync(inplaceTemp, dbPath);
  } catch {
    // CIFS rename quirk fallback: copy then drop the temp.
    copyFileSync(inplaceTemp, dbPath);
    rmSync(inplaceTemp, { force: true });
  }
  reloadKbDb(); // next getKbDb() opens the freshly-swapped file
  context.log(`KB database swapped in at ${dbPath}`);
}

/** Run the download → validate → swap pipeline in the background. */
async function runSwapAsync(jobId, context) {
  const job = getJob(jobId);
  if (!job) return;

  const tmpDir = mkdtempSync(join(tmpdir(), 'kb-swap-'));
  const dlPath = join(tmpDir, 'kb-upload.sqlite');
  try {
    if (job.sourceUrl) {
      updateJob(jobId, { status: 'downloading', progress: 'Downloading KB database from source URL...' });
      const resp = await fetch(job.sourceUrl);
      if (!resp.ok) throw new Error(`Download failed: ${resp.status} ${resp.statusText}`);
      const { createWriteStream } = await import('fs');
      const ws = createWriteStream(dlPath);
      for await (const chunk of resp.body) ws.write(chunk);
      await new Promise((res, rej) => { ws.end(); ws.on('finish', res); ws.on('error', rej); });
    } else if (job.blobName) {
      updateJob(jobId, { status: 'downloading', progress: 'Downloading KB database from blob storage...' });
      await downloadBlobToFile(job.blobName, dlPath);
    } else {
      throw new Error('Job has no blobName or sourceUrl.');
    }

    updateJob(jobId, { status: 'building', progress: 'Validating KB database...' });
    const summary = validateKbDatabase(dlPath);

    updateJob(jobId, { status: 'building', progress: 'Swapping in the new KB database...' });
    swapKbDatabase(dlPath, context);

    updateJob(jobId, {
      status: 'completed',
      progress: 'Done',
      result: { message: 'KB database swapped and reloaded.', ...summary },
    });
  } catch (err) {
    context.error(`KB swap job ${jobId} failed:`, err);
    updateJob(jobId, { status: 'failed', error: err.message });
  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { console.warn('cleanup-warn (kb-upload):', e?.message); }
    if (job.blobName) deleteBlob(job.blobName).catch(() => {});
  }
}

/**
 * Custom-delta rebuild: build a customizations-only KB from an uploaded ZIP of
 * customization metadata (e.g. C:\Workspace\DEV\Metadata) and ADDITIVELY merge
 * it into the live KB. The Microsoft base is never re-shipped — only the custom
 * delta. Far smaller than a full KB upload, suitable for frequent refreshes.
 */
async function runRebuildAsync(jobId, context) {
  const job = getJob(jobId);
  if (!job) return;

  const tmpDir = mkdtempSync(join(tmpdir(), 'kb-rebuild-'));
  const zipPath = join(tmpDir, 'custom.zip');
  const extractDir = join(tmpDir, 'extracted');
  const customDbPath = join(tmpDir, 'custom-kb.sqlite');
  try {
    if (job.sourceUrl) {
      updateJob(jobId, { status: 'downloading', progress: 'Downloading customizations ZIP from URL...' });
      const resp = await fetch(job.sourceUrl);
      if (!resp.ok) throw new Error(`Download failed: ${resp.status} ${resp.statusText}`);
      const { createWriteStream } = await import('fs');
      const ws = createWriteStream(zipPath);
      for await (const chunk of resp.body) ws.write(chunk);
      await new Promise((res, rej) => { ws.end(); ws.on('finish', res); ws.on('error', rej); });
    } else if (job.blobName) {
      updateJob(jobId, { status: 'downloading', progress: 'Downloading customizations ZIP from blob storage...' });
      await downloadBlobToFile(job.blobName, zipPath);
    } else {
      throw new Error('Job has no blobName or sourceUrl.');
    }

    updateJob(jobId, { status: 'extracting', progress: 'Extracting customization metadata...' });
    new AdmZip(zipPath).extractAllTo(extractDir, true);

    updateJob(jobId, { status: 'building', progress: 'Building customizations-only KB...' });
    const { buildKnowledgeBase } = await import('../../build/build-kb.js');
    const build = await buildKnowledgeBase({ packagesPaths: extractDir, outputPath: customDbPath });

    updateJob(jobId, { status: 'building', progress: 'Merging customizations into the live KB...' });
    const { mergeCustomKb } = await import('../../build/merge-kb-custom.js');
    reloadKbDb(); // release the read-only singleton before the in-place merge
    const summary = mergeCustomKb(kbDbPath(), customDbPath, (m) => context.log(m));
    reloadKbDb();

    updateJob(jobId, {
      status: 'completed',
      progress: 'Done',
      result: {
        message: 'Customizations merged into the live KB.',
        added: summary.added,
        customizedTables: summary.customizedTables,
        customObjectsBuilt: { tables: build.stats.tables, tableExtensions: build.stats.tableExtensions, enumExtensions: build.stats.enumExtensions },
      },
    });
  } catch (err) {
    context.error(`KB rebuild job ${jobId} failed:`, err);
    updateJob(jobId, { status: 'failed', error: err.message });
  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { console.warn('cleanup-warn (kb-rebuild):', e?.message); }
    if (job.blobName) deleteBlob(job.blobName).catch(() => {});
  }
}

// ── GET /api/d365kb/upload — now a tab on the unified back-office page ────────
// Redirect for back-compat; the SAS/apply/rebuild/status POST endpoints below
// are unchanged and are what the unified page (and PowerAutomate) call.

app.http('d365kb-upload', {
  methods: ['GET'],
  route: 'api/d365kb/upload',
  authLevel: 'anonymous',
  handler: async () => ({ status: 302, headers: { Location: '/api/backoffice#kb' } }),
});

// ── GET /api/d365kb/upload/sas ───────────────────────────────────────────────

app.http('d365kb-upload-sas', {
  methods: ['GET'],
  route: 'api/d365kb/upload/sas',
  authLevel: 'anonymous',
  handler: async (request, context) => {
    // Reuse the fail-closed decision: only proceed when authorized.
    const user = getAuthUser(request);
    const easyAuth = isEasyAuthEnabled();
    const authorized = (easyAuth && user) ? await isOwnerOrContributor(user.principalId) : null;
    const denial = decideUploadAuthorization({ user, easyAuth, authorized });
    if (denial) return denial;

    try {
      const filename = new URL(request.url).searchParams.get('filename') || 'd365fo_kb.sqlite';
      const job = createJob();
      const blobName = `${job.id}/${filename}`;
      updateJob(job.id, { blobName });

      await ensureContainer();
      const uploadUrl = generateUploadSasUrl(blobName, 120); // 2h for a large file

      return { status: 200, jsonBody: { job_id: job.id, upload_url: uploadUrl, blob_name: blobName, expires_in: 7200 } };
    } catch (err) {
      context.error('KB SAS generation error:', err);
      return { status: 500, jsonBody: { error: err.message } };
    }
  },
});

// ── POST /api/d365kb/upload/apply ────────────────────────────────────────────

app.http('d365kb-upload-apply', {
  methods: ['POST'],
  route: 'api/d365kb/upload/apply',
  authLevel: 'anonymous',
  handler: async (request, context) => {
    const user = getAuthUser(request);
    const easyAuth = isEasyAuthEnabled();
    const authorized = (easyAuth && user) ? await isOwnerOrContributor(user.principalId) : null;
    const denial = decideUploadAuthorization({ user, easyAuth, authorized });
    if (denial) return denial;

    try {
      const body = await request.json();
      let job;
      if (body.job_id) {
        job = getJob(body.job_id);
        if (!job) return { status: 404, jsonBody: { error: `Job ${body.job_id} not found.` } };
        if (job.status !== 'pending') return { status: 409, jsonBody: { error: `Job already ${job.status}.` } };
      } else if (body.source_url) {
        job = createJob({ sourceUrl: body.source_url });
      } else {
        return { status: 400, jsonBody: { error: 'Provide job_id (from /sas) or source_url.' } };
      }

      setImmediate(() => runSwapAsync(job.id, context));

      return {
        status: 202,
        jsonBody: {
          job_id: job.id,
          status: 'accepted',
          status_url: `/api/d365kb/upload/status?job_id=${job.id}`,
          message: 'KB database swap started. Poll the status_url for progress.',
        },
      };
    } catch (err) {
      context.error('KB apply error:', err);
      const status = err.message.includes('already in progress') ? 409 : 500;
      return { status, jsonBody: { error: err.message } };
    }
  },
});

// ── POST /api/d365kb/upload/rebuild ──────────────────────────────────────────
// Custom-delta rebuild: upload a ZIP of customization metadata, build it, and
// additively merge into the live KB (Microsoft base preserved).

app.http('d365kb-upload-rebuild', {
  methods: ['POST'],
  route: 'api/d365kb/upload/rebuild',
  authLevel: 'anonymous',
  handler: async (request, context) => {
    const user = getAuthUser(request);
    const easyAuth = isEasyAuthEnabled();
    const authorized = (easyAuth && user) ? await isOwnerOrContributor(user.principalId) : null;
    const denial = decideUploadAuthorization({ user, easyAuth, authorized });
    if (denial) return denial;

    try {
      const body = await request.json();
      let job;
      if (body.job_id) {
        job = getJob(body.job_id);
        if (!job) return { status: 404, jsonBody: { error: `Job ${body.job_id} not found.` } };
        if (job.status !== 'pending') return { status: 409, jsonBody: { error: `Job already ${job.status}.` } };
      } else if (body.source_url) {
        job = createJob({ sourceUrl: body.source_url });
      } else {
        return { status: 400, jsonBody: { error: 'Provide job_id (from /sas) or source_url.' } };
      }

      setImmediate(() => runRebuildAsync(job.id, context));

      return {
        status: 202,
        jsonBody: {
          job_id: job.id,
          status: 'accepted',
          status_url: `/api/d365kb/upload/status?job_id=${job.id}`,
          message: 'Custom-delta rebuild started. Poll the status_url for progress.',
        },
      };
    } catch (err) {
      context.error('KB rebuild trigger error:', err);
      const status = err.message.includes('already in progress') ? 409 : 500;
      return { status, jsonBody: { error: err.message } };
    }
  },
});

// ── GET /api/d365kb/upload/status ────────────────────────────────────────────

app.http('d365kb-upload-status', {
  methods: ['GET'],
  route: 'api/d365kb/upload/status',
  authLevel: 'anonymous',
  handler: async (request) => {
    const jobId = new URL(request.url).searchParams.get('job_id');
    if (!jobId) return { status: 400, jsonBody: { error: 'Missing job_id query parameter.' } };
    const job = getJob(jobId);
    if (!job) return { status: 404, jsonBody: { error: `Job ${jobId} not found.` } };

    const response = {
      job_id: job.id, status: job.status, progress: job.progress,
      created_at: job.createdAt, updated_at: job.updatedAt,
    };
    if (job.status === 'completed') response.result = job.result;
    if (job.status === 'failed') response.error = job.error;
    return { status: 200, jsonBody: response };
  },
});

// Exported for unit tests.
export { validateKbDatabase, readKbInfo };
