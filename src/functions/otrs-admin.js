/**
 * Azure Function: OTRS Wiki Admin — human-operator HTML UI.
 *
 * A single-page HTML admin that lets a human operator drive the same
 * pipeline Power Automate drives automatically:
 *   1. Download a fresh extract from OTRS as XML (one button)
 *   2. Upload an XML document to create/update wiki pages
 *
 * Both actions are proxied server-side: the admin page is anonymous
 * but its action handlers call the extract + ingest *cores* directly.
 * The function key and OTRS credentials never leave the server.
 *
 * Routes:
 *   GET  /api/otrs-admin          → HTML page
 *   POST /api/otrs-admin/extract  → runs runExtract, returns XML as file download
 *   POST /api/otrs-admin/ingest   → multipart upload of XML, runs ingest, returns JSON
 *
 * Auth: anonymous at the route level (matches d365sec-upload). If Easy
 * Auth is enabled on the Function App, the handler reads the principal
 * headers and shows it in the status bar. No server-side enforcement
 * today — the Function App is internal/VPN-scoped by deployment policy.
 */

import { app } from '@azure/functions';
import { readOtrsConfig, OtrsRequestError, getTicket } from '../azure/otrs-client.js';
import { readState, writeState } from '../azure/otrs-storage.js';
import { runExtract, toExtractedTicket } from '../azure/otrs-extract-core.js';
import { ticketsToXml } from '../azure/otrs-xml.js';
import { loadWikiRegistry, findWiki } from '../azure/wiki-registry.js';
import { createWikiStore } from '../azure/wiki-storage.js';
import { createWikiWriter } from '../azure/wiki-writer.js';
import { ingestExtractXml } from '../azure/wiki-ingest-core.js';
import { renderExtractPdfs, loadPdfDeps } from '../azure/ticket-pdf-renderer.js';
import { createRequire } from 'node:module';

// adm-zip is CommonJS — already a dep for d365sec-upload; we reuse it here
// to bundle multi-file PDF output into a single browser download.
const require = createRequire(import.meta.url);
const AdmZip = require('adm-zip');

// Deps for the PDF renderer are heavy (mammoth/xlsx/html-to-text) —
// load once per process, not per request.
let _pdfDepsPromise = null;
function getPdfDeps() {
  if (!_pdfDepsPromise) _pdfDepsPromise = loadPdfDeps();
  return _pdfDepsPromise;
}

const DEFAULT_WIKI = 'otrs';
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB; an OtrsExtract envelope is tiny, so this is very generous

// ── HTML template ────────────────────────────────────────────────────────────
//
// Self-contained (no external CSS/JS). Status values are substituted
// server-side at render time so a freshly-loaded page already shows
// current state without a JS fetch round-trip.

const PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>OTRS Wiki Admin</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
           max-width: 960px; margin: 0 auto; padding: 32px 20px; color: #24292f; background: #f6f8fa; }
    h1 { font-size: 24px; margin-bottom: 8px; }
    .subtitle { color: #57606a; margin-bottom: 20px; }
    .status { display: flex; gap: 18px; flex-wrap: wrap; font-size: 14px; color: #57606a;
              background: #fff; border: 1px solid #d0d7de; border-radius: 6px; padding: 12px 16px; margin-bottom: 16px; }
    .status .item { display: flex; gap: 6px; }
    .status .label { font-weight: 600; color: #24292f; }
    .card { background: #fff; border: 1px solid #d0d7de; border-radius: 6px; padding: 20px; margin-bottom: 16px; }
    .card h2 { font-size: 16px; margin-bottom: 6px; }
    .card .hint { color: #57606a; font-size: 13px; margin-bottom: 14px; }
    .row { display: flex; gap: 14px; align-items: center; flex-wrap: wrap; margin-bottom: 12px; }
    label { font-size: 14px; color: #24292f; }
    label.choice { display: inline-flex; gap: 6px; align-items: center; }
    input[type="number"], select { padding: 6px 10px; border: 1px solid #d0d7de; border-radius: 4px; font-size: 14px; font-family: inherit; }
    .btn { display: inline-flex; align-items: center; gap: 8px; background: #2da44e; color: #fff; border: none;
           padding: 9px 18px; border-radius: 6px; font-size: 14px; font-weight: 600; cursor: pointer; }
    .btn:hover { background: #218838; }
    .btn:disabled { background: #94d3a2; cursor: not-allowed; }
    .btn-blue { background: #0969da; }
    .btn-blue:hover { background: #0550ae; }
    .drop { border: 2px dashed #d0d7de; border-radius: 6px; padding: 32px 20px; text-align: center;
            cursor: pointer; transition: all 0.15s; }
    .drop:hover, .drop.dragover { border-color: #0969da; background: #f0f6ff; }
    .drop .file { font-weight: 600; color: #0969da; margin-top: 8px; min-height: 18px; }
    input[type="file"] { display: none; }
    .result { margin-top: 14px; padding: 14px; border-radius: 6px; display: none; font-size: 14px; }
    .result.info    { display: block; background: #ddf4ff; border: 1px solid #54aeff; color: #0550ae; }
    .result.success { display: block; background: #dafbe1; border: 1px solid #4ac26b; color: #116329; }
    .result.error   { display: block; background: #ffebe9; border: 1px solid #ff8182; color: #82071e; }
    .result details { margin-top: 12px; }
    .result summary { cursor: pointer; font-weight: 600; font-size: 13px; color: inherit;
                      user-select: none; padding: 4px 0; }
    .result summary:hover { text-decoration: underline; }
    .kvpair { display: grid; grid-template-columns: 160px 1fr; gap: 4px 14px; font-size: 12px;
              margin-top: 10px; font-family: ui-monospace, Menlo, Consolas, monospace; }
    .kvpair .k { color: #57606a; }
    .kvpair .v { color: #24292f; word-break: break-all; }
    .copy-btn { font-size: 12px; padding: 4px 10px; margin-top: 8px; background: #f6f8fa;
                border: 1px solid #d0d7de; border-radius: 4px; cursor: pointer; color: #24292f; }
    .copy-btn:hover { background: #eaeef2; }
    .copy-btn.copied { background: #dafbe1; border-color: #4ac26b; color: #116329; }
    pre { background: #f6f8fa; padding: 12px; border-radius: 4px; overflow-x: auto;
          font-size: 12px; line-height: 1.5; margin-top: 8px; max-height: 320px;
          color: #24292f; white-space: pre-wrap; word-break: break-all; }
    .spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid #fff;
               border-top-color: transparent; border-radius: 50%; animation: spin 0.6s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    a { color: #0969da; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .footer { font-size: 12px; color: #8b949e; margin-top: 24px; text-align: center; }
  </style>
</head>
<body>
  <h1>OTRS Wiki Admin</h1>
  <p class="subtitle">Manual operator UI for the OTRS → Wiki pipeline. Server-side proxies, no keys in the browser.</p>

  <div class="status">
    <span class="item"><span class="label">Wiki:</span> {{WIKI_NAME}} ({{WIKI_TITLE}})</span>
    <span class="item"><span class="label">Container:</span> {{WIKI_CONTAINER}}</span>
    <span class="item"><span class="label">Pages:</span> {{PAGE_COUNT}}</span>
    <span class="item"><span class="label">Index updated:</span> {{INDEX_UPDATED}}</span>
    <span class="item"><span class="label">Last extracted:</span> {{LAST_EXTRACTED}}</span>
    <span class="item"><span class="label">Known tickets:</span> {{KNOWN_TICKETS}}</span>
    <span class="item"><span class="label">Signed in as:</span> {{USER}}</span>
  </div>

  <div class="card">
    <h2>Step 1a — Export a single ticket (with full content)</h2>
    <p class="hint">Calls TicketGet directly for one ticket ID and returns the complete content — every article, every attachment as base64 (inline images, Word docs, PDFs), dynamic fields, and full OTRS metadata. Use this to validate the XML schema on one real ticket before running a batch.</p>
    <form id="singleForm">
      <div class="row">
        <label>Ticket ID <input type="text" name="ticketId" id="ticketIdInput" placeholder="e.g. 1717381" pattern="[0-9]+" required></label>
        <label class="choice"><input type="checkbox" name="attachments" checked> include attachments (base64)</label>
        <label class="choice"><input type="checkbox" name="dynamicFields" checked> include dynamic fields</label>
        <button type="submit" class="btn btn-blue" id="singleBtn">Download single-ticket XML</button>
      </div>
    </form>
    <div id="singleResult" class="result" data-id="singleResult"></div>
  </div>

  <div class="card">
    <h2>Step 1 — Download extract from OTRS</h2>
    <p class="hint">Pulls resolved tickets from OTRS and returns the OtrsExtract XML as a file download. Choose the mode carefully: <code>full</code> re-pulls everything, <code>incremental</code> pulls only tickets not previously marked as extracted, <code>preview</code> is the same filter as incremental but does not write the state blob.</p>
    <form id="extractForm">
      <div class="row">
        <label class="choice"><input type="radio" name="mode" value="incremental" checked> incremental (default)</label>
        <label class="choice"><input type="radio" name="mode" value="full"> full</label>
        <label class="choice"><input type="radio" name="mode" value="preview"> preview (dry run)</label>
        <label>limit <input type="number" name="limit" min="1" max="500" placeholder="all"></label>
        <button type="submit" class="btn btn-blue" id="extractBtn">Download XML</button>
      </div>
    </form>
    <div id="extractResult" class="result" data-id="extractResult"></div>
  </div>

  <div class="card">
    <h2>Step 2 — Upload XML to create/update wiki pages</h2>
    <p class="hint">Pass the OtrsExtract XML you downloaded in Step 1 (or any valid OtrsExtract document). One markdown page is written per <code>&lt;Ticket&gt;</code> and the wiki's <code>index.md</code> is regenerated.</p>
    <form id="ingestForm">
      <div class="drop" id="dropZone">
        <div>Drop an XML file here, or click to browse</div>
        <div class="file" id="fileName"></div>
      </div>
      <input type="file" id="xmlFile" accept=".xml,text/xml,application/xml">
      <div class="row" style="margin-top:12px">
        <button type="submit" class="btn" id="ingestBtn" disabled>Upload &amp; Ingest</button>
      </div>
    </form>
    <div id="ingestResult" class="result" data-id="ingestResult"></div>
  </div>

  <div class="card">
    <h2>Step 3 — Convert XML to PDFs</h2>
    <p class="hint">Turns an OtrsExtract XML into one main PDF per ticket (with filled-in metadata, non-empty dynamic fields, and inline PNG/JPEG attachments) plus one sibling PDF for every non-image attachment (docx → readable text, xlsx → cell tables, pdf → passthrough, other → placeholder with filename/type/size). Raw base64 is never rendered. Multi-file responses come back as a single <code>.zip</code>; single-PDF responses stream directly.</p>
    <form id="pdfForm">
      <div class="drop" id="pdfDropZone">
        <div>Drop an XML file here, or click to browse</div>
        <div class="file" id="pdfFileName"></div>
      </div>
      <input type="file" id="pdfXmlFile" accept=".xml,text/xml,application/xml">
      <div class="row" style="margin-top:12px">
        <button type="submit" class="btn btn-blue" id="pdfBtn" disabled>Convert &amp; Download</button>
      </div>
    </form>
    <div id="pdfResult" class="result" data-id="pdfResult"></div>
  </div>

  <div class="footer">
    <a href="/api/wiki-mcp">Wiki catalog</a> ·
    <a href="/api/wiki-mcp/{{WIKI_NAME}}">{{WIKI_NAME}} MCP health</a> ·
    <a href="https://dev.azure.com/TOC365/TOC/_git/TISAITools">Source</a>
  </div>

  <script>
    const singleForm = document.getElementById('singleForm');
    const singleBtn = document.getElementById('singleBtn');
    const singleResult = document.getElementById('singleResult');
    const ticketIdInput = document.getElementById('ticketIdInput');
    const extractForm = document.getElementById('extractForm');
    const extractBtn = document.getElementById('extractBtn');
    const extractResult = document.getElementById('extractResult');
    const ingestForm = document.getElementById('ingestForm');
    const ingestBtn = document.getElementById('ingestBtn');
    const ingestResult = document.getElementById('ingestResult');
    const dropZone = document.getElementById('dropZone');
    const fileInput = document.getElementById('xmlFile');
    const fileName = document.getElementById('fileName');
    const pdfForm = document.getElementById('pdfForm');
    const pdfBtn = document.getElementById('pdfBtn');
    const pdfResult = document.getElementById('pdfResult');
    const pdfDropZone = document.getElementById('pdfDropZone');
    const pdfFileInput = document.getElementById('pdfXmlFile');
    const pdfFileName = document.getElementById('pdfFileName');

    function setResult(el, cls, html) {
      el.className = 'result ' + cls;
      el.innerHTML = html;
    }

    // Render the rich error block. "data" is the JSON returned by the
    // server-side proxy on failure — includes category/phase/details for
    // OtrsRequestError, or category=internal + stack otherwise.
    function renderError(el, action, data) {
      const headline = action === 'extract' ? 'Extract failed' : 'Ingest failed';
      const escape = s => String(s ?? '').replace(/[&<>"']/g, c =>
        ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

      let html = '<strong>' + headline + '.</strong> ' + escape(data.error || 'Unknown error');

      // Top-level tag row (category / phase / http / elapsed) for quick scan.
      const chips = [];
      const d = data.details || {};
      if (data.category) chips.push(['category', data.category]);
      if (data.phase || d.phase) chips.push(['phase', data.phase || d.phase]);
      if (d.httpStatus) chips.push(['http', d.httpStatus + ' ' + (d.httpStatusText || '')]);
      if (d.otrsErrorCode) chips.push(['otrsCode', d.otrsErrorCode]);
      if (d.elapsedMs != null) chips.push(['elapsed', d.elapsedMs + ' ms']);
      if (d.url) chips.push(['url', d.url]);
      if (d.timestamp) chips.push(['ts', d.timestamp]);
      if (chips.length > 0) {
        html += '<div class="kvpair">';
        for (const [k, v] of chips) html += '<div class="k">' + escape(k) + '</div><div class="v">' + escape(v) + '</div>';
        html += '</div>';
      }

      // Full raw payload (collapsed by default) plus copy button.
      const raw = JSON.stringify(data, null, 2);
      html += '<details><summary>Full technical details (JSON)</summary>';
      html += '<pre id="' + el.id + '_pre">' + escape(raw) + '</pre>';
      html += '<button type="button" class="copy-btn" data-target="' + el.id + '_pre">Copy JSON</button>';
      html += '</details>';

      el.className = 'result error';
      el.innerHTML = html;

      // Wire up the copy button.
      const btn = el.querySelector('.copy-btn');
      if (btn) btn.addEventListener('click', () => {
        const pre = document.getElementById(btn.dataset.target);
        navigator.clipboard.writeText(pre.textContent).then(() => {
          btn.textContent = 'Copied!'; btn.classList.add('copied');
          setTimeout(() => { btn.textContent = 'Copy JSON'; btn.classList.remove('copied'); }, 1500);
        }).catch(() => {
          btn.textContent = 'Copy failed'; setTimeout(() => { btn.textContent = 'Copy JSON'; }, 1500);
        });
      });
    }

    // ── Single-ticket export ─────────────────────────────────────────────
    singleForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const ticketId = ticketIdInput.value.trim();
      if (!ticketId) return;

      singleBtn.disabled = true;
      singleBtn.innerHTML = '<span class="spinner"></span> Fetching...';
      setResult(singleResult, 'info', 'Calling TicketGet for ticket ' + ticketId + ' — base64 content can take a moment on tickets with large attachments.');

      try {
        const fd = new FormData(singleForm);
        const body = {
          ticketId,
          attachments: fd.has('attachments'),
          dynamicFields: fd.has('dynamicFields'),
        };
        const resp = await fetch('/api/otrs-admin/extract-single', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!resp.ok) {
          const errData = await resp.json().catch(() => ({ error: 'HTTP ' + resp.status + ' (non-JSON response)' }));
          renderError(singleResult, 'extract', errData);
          return;
        }
        const blob = await resp.blob();
        const filename = (resp.headers.get('content-disposition') || '').match(/filename="?([^";]+)/)?.[1]
          || ('otrs-ticket-' + ticketId + '.xml');
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = filename; document.body.appendChild(a); a.click();
        URL.revokeObjectURL(url); a.remove();

        const articles = resp.headers.get('x-otrs-articles') ?? '?';
        const atts = resp.headers.get('x-otrs-attachments') ?? '?';
        const bytes = resp.headers.get('x-otrs-xml-bytes') ?? '?';
        setResult(singleResult, 'success',
          '<strong>Downloaded.</strong> Ticket ' + ticketId + ' — '
          + articles + ' article(s), ' + atts + ' attachment(s), '
          + bytes + ' bytes of XML. File: <code>' + filename + '</code>');
      } catch (err) {
        renderError(singleResult, 'extract', {
          error: err.message || String(err),
          category: 'browser-network',
          timestamp: new Date().toISOString(),
        });
      } finally {
        singleBtn.disabled = false;
        singleBtn.textContent = 'Download single-ticket XML';
      }
    });

    // ── Extract → XML download ───────────────────────────────────────────
    extractForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      extractBtn.disabled = true;
      extractBtn.innerHTML = '<span class="spinner"></span> Extracting...';
      setResult(extractResult, 'info', 'Calling OTRS and assembling XML — this can take up to a minute on a large batch.');

      try {
        const fd = new FormData(extractForm);
        const body = {
          mode: fd.get('mode') || 'incremental',
          limit: fd.get('limit') ? Number(fd.get('limit')) : undefined,
        };
        const resp = await fetch('/api/otrs-admin/extract', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!resp.ok) {
          // The server returns a structured JSON envelope for both OTRS-
          // upstream failures (502) and internal failures (500). Surface
          // the full payload via renderError rather than throwing a flat
          // string — operators need phase, http, elapsed, url, etc.
          const errData = await resp.json().catch(() => ({ error: 'HTTP ' + resp.status + ' (non-JSON response)' }));
          renderError(extractResult, 'extract', errData);
          return;
        }
        const blob = await resp.blob();
        const filename = (resp.headers.get('content-disposition') || '').match(/filename="?([^";]+)/)?.[1]
          || 'otrs-extract.xml';
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = filename; document.body.appendChild(a); a.click();
        URL.revokeObjectURL(url); a.remove();

        const extracted = resp.headers.get('x-otrs-extracted') ?? '?';
        const skipped = resp.headers.get('x-otrs-skipped') ?? '?';
        setResult(extractResult, 'success',
          '<strong>Downloaded.</strong> Extracted ' + extracted + ' ticket(s), skipped ' + skipped + '. Filename: <code>' + filename + '</code>');
      } catch (err) {
        // Network-level failure (browser could not reach the Function App).
        renderError(extractResult, 'extract', {
          error: err.message || String(err),
          category: 'browser-network',
          timestamp: new Date().toISOString(),
        });
      } finally {
        extractBtn.disabled = false;
        extractBtn.textContent = 'Download XML';
      }
    });

    // ── Ingest upload ────────────────────────────────────────────────────
    dropZone.addEventListener('click', () => fileInput.click());
    dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
    dropZone.addEventListener('drop', e => {
      e.preventDefault();
      dropZone.classList.remove('dragover');
      if (e.dataTransfer.files.length) {
        fileInput.files = e.dataTransfer.files;
        onFile();
      }
    });
    fileInput.addEventListener('change', onFile);

    function onFile() {
      const f = fileInput.files[0];
      if (!f) { fileName.textContent = ''; ingestBtn.disabled = true; return; }
      fileName.textContent = f.name + ' (' + (f.size / 1024).toFixed(1) + ' KB)';
      ingestBtn.disabled = false;
    }

    ingestForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = fileInput.files[0];
      if (!f) return;

      ingestBtn.disabled = true;
      ingestBtn.innerHTML = '<span class="spinner"></span> Uploading...';
      setResult(ingestResult, 'info', 'Parsing XML and writing pages...');

      try {
        const xml = await f.text();
        const resp = await fetch('/api/otrs-admin/ingest', {
          method: 'POST',
          headers: { 'Content-Type': 'application/xml' },
          body: xml,
        });
        const data = await resp.json().catch(() => ({ error: 'HTTP ' + resp.status + ' (non-JSON response)' }));
        if (!resp.ok) {
          renderError(ingestResult, 'ingest', data);
          return;
        }
        setResult(ingestResult, 'success',
          '<strong>Ingest complete.</strong> Wrote ' + data.written + ' page(s), '
          + 'failed ' + data.failed + ', skipped ' + data.total_skipped + '.'
          + '<pre>' + escapeHtml(JSON.stringify(data, null, 2)) + '</pre>');
        setTimeout(() => window.location.reload(), 2500);
      } catch (err) {
        renderError(ingestResult, 'ingest', {
          error: err.message || String(err),
          category: 'browser-network',
          timestamp: new Date().toISOString(),
        });
      } finally {
        ingestBtn.disabled = false;
        ingestBtn.textContent = 'Upload & Ingest';
      }
    });

    // ── Step 3 — Convert XML to PDFs ─────────────────────────────────────
    pdfDropZone.addEventListener('click', () => pdfFileInput.click());
    pdfDropZone.addEventListener('dragover', e => { e.preventDefault(); pdfDropZone.classList.add('dragover'); });
    pdfDropZone.addEventListener('dragleave', () => pdfDropZone.classList.remove('dragover'));
    pdfDropZone.addEventListener('drop', e => {
      e.preventDefault();
      pdfDropZone.classList.remove('dragover');
      if (e.dataTransfer.files.length) {
        pdfFileInput.files = e.dataTransfer.files;
        onPdfFile();
      }
    });
    pdfFileInput.addEventListener('change', onPdfFile);

    function onPdfFile() {
      const f = pdfFileInput.files[0];
      if (!f) { pdfFileName.textContent = ''; pdfBtn.disabled = true; return; }
      pdfFileName.textContent = f.name + ' (' + (f.size / 1024).toFixed(1) + ' KB)';
      pdfBtn.disabled = false;
    }

    pdfForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = pdfFileInput.files[0];
      if (!f) return;

      pdfBtn.disabled = true;
      pdfBtn.innerHTML = '<span class="spinner"></span> Rendering PDFs...';
      setResult(pdfResult, 'info', 'Parsing XML, rendering PDFs, decoding attachments — large tickets with attachments can take up to a minute.');

      try {
        const xml = await f.text();
        const resp = await fetch('/api/otrs-admin/convert-to-pdf', {
          method: 'POST',
          headers: { 'Content-Type': 'application/xml' },
          body: xml,
        });
        if (!resp.ok) {
          const errData = await resp.json().catch(() => ({ error: 'HTTP ' + resp.status + ' (non-JSON response)' }));
          renderError(pdfResult, 'convert-to-pdf', errData);
          return;
        }
        const tickets  = resp.headers.get('x-pdf-tickets')  || '?';
        const files    = resp.headers.get('x-pdf-files')    || '?';
        const warnings = resp.headers.get('x-pdf-warnings') || '0';
        const zipBytes = resp.headers.get('x-pdf-zipbytes');

        const blob = await resp.blob();
        const filename = (resp.headers.get('content-disposition') || '').match(/filename="?([^";]+)/)?.[1]
          || (Number(files) === 1 ? 'otrs-ticket.pdf' : 'otrs-pdfs.zip');
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = filename; document.body.appendChild(a); a.click();
        URL.revokeObjectURL(url); a.remove();

        let summary = '<strong>Downloaded.</strong> '
          + tickets + ' ticket(s), ' + files + ' PDF file(s)';
        if (zipBytes) summary += ' in a ' + (Number(zipBytes) / 1024).toFixed(1) + ' KB ZIP';
        summary += '. File: <code>' + filename + '</code>';
        if (Number(warnings) > 0) {
          summary += '<br/><strong style="color:#82071e">' + warnings + ' attachment(s) could not be rendered</strong> — check the zip manifest.';
        }
        setResult(pdfResult, 'success', summary);
      } catch (err) {
        renderError(pdfResult, 'convert-to-pdf', {
          error: err.message || String(err),
          category: 'browser-network',
          timestamp: new Date().toISOString(),
        });
      } finally {
        pdfBtn.disabled = false;
        pdfBtn.textContent = 'Convert & Download';
      }
    });

    function escapeHtml(s) {
      return String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
    }
  </script>
</body>
</html>`;

// ── Handlers ─────────────────────────────────────────────────────────────────

app.http('otrs-admin-page', {
  methods: ['GET'],
  route: 'otrs-admin',
  authLevel: 'anonymous',
  handler: async (request, context) => {
    try {
      const wiki = resolveWikiOrFail(context);
      if ('errorResponse' in wiki) return wiki.errorResponse;

      const state = await safeReadState(context);
      const store = createWikiStore(wiki.wiki);
      let pageCount = 0;
      let indexUpdated = '(not yet written)';
      try {
        const [idx, pages] = await Promise.all([store.getIndex(), store.listPages()]);
        pageCount = pages.length;
        if (idx?.lastModified) indexUpdated = idx.lastModified;
      } catch (err) {
        context.log(`otrs-admin: wiki read probe failed — ${err.message}`);
      }

      const user = authPrincipal(request) || '(anonymous)';
      const html = PAGE_HTML
        .replaceAll('{{WIKI_NAME}}', wiki.wiki.name)
        .replaceAll('{{WIKI_TITLE}}', wiki.wiki.title)
        .replaceAll('{{WIKI_CONTAINER}}', wiki.wiki.container)
        .replaceAll('{{PAGE_COUNT}}', String(pageCount))
        .replaceAll('{{INDEX_UPDATED}}', escapeHtml(indexUpdated))
        .replaceAll('{{LAST_EXTRACTED}}', escapeHtml(state?.lastExtractedAt || '(never)'))
        .replaceAll('{{KNOWN_TICKETS}}', String(state?.processedTicketIds?.length ?? 0))
        .replaceAll('{{USER}}', escapeHtml(user));

      return { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: html };
    } catch (err) {
      context.error('otrs-admin page error:', err);
      return { status: 500, body: `<pre>Admin page error: ${escapeHtml(err.message)}</pre>`, headers: { 'Content-Type': 'text/html' } };
    }
  },
});

app.http('otrs-admin-extract', {
  methods: ['POST'],
  route: 'otrs-admin/extract',
  authLevel: 'anonymous',
  handler: async (request, context) => {
    try {
      let body = {};
      try { body = await request.json(); } catch { /* empty body is ok */ }
      const mode = ['incremental', 'full', 'preview'].includes(body.mode) ? body.mode : 'incremental';
      const limit = Number.isInteger(body.limit) && body.limit > 0 ? body.limit : null;

      let cfg;
      try {
        cfg = readOtrsConfig();
      } catch (err) {
        return { status: 500, jsonBody: { error: err.message, hint: 'Set OTRS_* app settings on the Function App.' } };
      }

      const state = await readState();
      const { candidateIds, extracted, skipped } = await runExtract({
        mode, limit, cfg, state,
        log: (m) => context.log(`otrs-admin-extract: ${m}`),
      });

      if (mode !== 'preview' && extracted.length > 0) {
        const newIds = extracted.map(t => t.ticketId);
        const merged = Array.from(new Set([...state.processedTicketIds, ...newIds]));
        try {
          await writeState({
            ...state,
            lastExtractedAt: new Date().toISOString(),
            processedTicketIds: merged,
          });
        } catch (err) {
          context.error('otrs-admin-extract: state write failed —', err.message);
        }
      }

      const xml = ticketsToXml(extracted, { mode, skipped });
      const date = new Date().toISOString().slice(0, 19).replace(/:/g, '').replace('T', '-');
      const filename = `otrs-extract-${mode}-${date}.xml`;

      return {
        status: 200,
        headers: {
          'Content-Type': 'application/xml; charset=utf-8',
          'Content-Disposition': `attachment; filename="${filename}"`,
          'X-OTRS-Extracted':  String(extracted.length),
          'X-OTRS-Skipped':    String(skipped.length),
          'X-OTRS-Candidates': String(candidateIds.length),
        },
        body: xml,
      };
    } catch (err) {
      context.error('otrs-admin-extract error:', err);
      return structuredErrorResponse(err, 'extract');
    }
  },
});

app.http('otrs-admin-extract-single', {
  methods: ['POST'],
  route: 'otrs-admin/extract-single',
  authLevel: 'anonymous',
  handler: async (request, context) => {
    try {
      let body = {};
      try { body = await request.json(); } catch { /* empty body handled below */ }
      const ticketId = String(body.ticketId || '').trim();
      if (!/^\d+$/.test(ticketId)) {
        return { status: 400, jsonBody: { error: 'ticketId is required and must be numeric.' } };
      }
      const attachments = body.attachments !== false;
      const dynamicFields = body.dynamicFields !== false;

      let cfg;
      try {
        cfg = readOtrsConfig();
      } catch (err) {
        return { status: 500, jsonBody: { error: err.message, hint: 'Set OTRS_* app settings on the Function App.' } };
      }

      // Single-ticket path: skip TicketSearch, go straight to TicketGet
      // with full-content flags. No state-blob update — this is an ad-hoc
      // operator action, not a scheduled pipeline step.
      const raw = await getTicket(ticketId, { cfg, attachments, dynamicFields });
      const extracted = toExtractedTicket(ticketId, raw);
      const xml = ticketsToXml([extracted], { mode: 'single' });

      const articleCount = extracted.articles?.length || 0;
      const attachmentCount = (extracted.articles || [])
        .reduce((n, a) => n + (a.attachments?.length || 0), 0);

      const date = new Date().toISOString().slice(0, 19).replace(/:/g, '').replace('T', '-');
      const filename = `otrs-ticket-${ticketId}-${date}.xml`;

      return {
        status: 200,
        headers: {
          'Content-Type': 'application/xml; charset=utf-8',
          'Content-Disposition': `attachment; filename="${filename}"`,
          'X-OTRS-TicketID':    ticketId,
          'X-OTRS-Articles':    String(articleCount),
          'X-OTRS-Attachments': String(attachmentCount),
          'X-OTRS-XML-Bytes':   String(Buffer.byteLength(xml, 'utf8')),
        },
        body: xml,
      };
    } catch (err) {
      context.error('otrs-admin-extract-single error:', err);
      return structuredErrorResponse(err, 'extract-single');
    }
  },
});

app.http('otrs-admin-ingest', {
  methods: ['POST'],
  route: 'otrs-admin/ingest',
  authLevel: 'anonymous',
  handler: async (request, context) => {
    try {
      const xml = await request.text();
      if (!xml || !xml.trim()) {
        return { status: 400, jsonBody: { error: 'Empty body — expected OtrsExtract XML.' } };
      }
      if (Buffer.byteLength(xml, 'utf8') > MAX_UPLOAD_BYTES) {
        return {
          status: 413,
          jsonBody: { error: `XML exceeds ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB limit.` },
        };
      }

      const wiki = resolveWikiOrFail(context);
      if ('errorResponse' in wiki) return wiki.errorResponse;

      const writer = createWikiWriter(wiki.wiki);
      const summary = await ingestExtractXml({
        xml, wiki: wiki.wiki, writer,
        log: (m) => context.log(`otrs-admin-ingest[${wiki.wiki.name}]: ${m}`),
      });

      return {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'X-Wiki-Name': wiki.wiki.name,
          'X-Wiki-Written': String(summary.written),
          'X-Wiki-Failed': String(summary.failed),
        },
        jsonBody: summary,
      };
    } catch (err) {
      context.error('otrs-admin-ingest error:', err);
      return structuredErrorResponse(err, 'ingest', {
        hint: 'Is the XML a valid OtrsExtract envelope?',
      });
    }
  },
});

app.http('otrs-admin-convert-to-pdf', {
  methods: ['POST'],
  route: 'otrs-admin/convert-to-pdf',
  authLevel: 'anonymous',
  handler: async (request, context) => {
    try {
      const xml = await request.text();
      if (!xml || !xml.trim()) {
        return { status: 400, jsonBody: { error: 'Empty body — expected OtrsExtract XML.' } };
      }
      if (Buffer.byteLength(xml, 'utf8') > MAX_UPLOAD_BYTES) {
        return {
          status: 413,
          jsonBody: { error: `XML exceeds ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB limit.` },
        };
      }

      const deps = await getPdfDeps();
      const { tickets, files, warnings } = await renderExtractPdfs({ xml, deps });

      if (tickets === 0) {
        return {
          status: 400,
          jsonBody: { error: 'No <Ticket> elements found in the XML — nothing to render.' },
        };
      }

      // Single ticket + no attachment siblings → return the PDF directly
      // so the browser can preview it in-line instead of forcing a ZIP
      // download. Anything with multiple files gets zipped.
      if (files.length === 1) {
        const only = files[0];
        return {
          status: 200,
          headers: {
            'Content-Type': 'application/pdf',
            'Content-Disposition': `attachment; filename="${only.filename}"`,
            'X-PDF-Tickets':  String(tickets),
            'X-PDF-Files':    '1',
            'X-PDF-Warnings': String(warnings.length),
          },
          body: only.buffer,
        };
      }

      // Multi-file response: bundle everything into a single ZIP. Using
      // adm-zip in-memory keeps the whole operation inside the 230-second
      // Azure HTTP timeout and avoids spilling to /tmp.
      const zip = new AdmZip();
      for (const f of files) {
        zip.addFile(f.filename, f.buffer);
      }
      // Include a machine-readable manifest so consumers who receive the
      // ZIP (e.g. an automated pipeline) don't have to list the entries.
      const manifest = {
        generatedAt: new Date().toISOString(),
        tickets,
        fileCount: files.length,
        files: files.map(f => ({ filename: f.filename, bytes: f.buffer.length })),
        warnings,
      };
      zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));

      const zipBuffer = zip.toBuffer();
      const date = new Date().toISOString().slice(0, 19).replace(/:/g, '').replace('T', '-');
      const zipName = `otrs-pdfs-${date}.zip`;

      context.log(`otrs-admin-convert-to-pdf: ${tickets} ticket(s), ${files.length} file(s), `
        + `${warnings.length} warning(s), zip=${zipBuffer.length} bytes`);

      return {
        status: 200,
        headers: {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="${zipName}"`,
          'X-PDF-Tickets':  String(tickets),
          'X-PDF-Files':    String(files.length),
          'X-PDF-Warnings': String(warnings.length),
          'X-PDF-ZipBytes': String(zipBuffer.length),
        },
        body: zipBuffer,
      };
    } catch (err) {
      context.error('otrs-admin-convert-to-pdf error:', err);
      return structuredErrorResponse(err, 'convert-to-pdf', {
        hint: 'Is the XML a valid OtrsExtract envelope? Oversized attachments may also cause renderer timeouts.',
      });
    }
  },
});

/**
 * Serialize an error — Otrs-specific or generic — into an admin-friendly
 * JSON response. The browser JS rendering the error banner expects:
 *   { error, category, phase?, details?: <OtrsRequestError.toJSON>, stack?, hint? }
 * Responses intentionally use HTTP 502 for upstream OTRS failures (so
 * the browser can distinguish "we failed to reach OTRS" from "we bugged
 * out ourselves") and HTTP 500 for internal errors.
 */
function structuredErrorResponse(err, action, extra = {}) {
  const envelope = {
    error: err.message || 'Unknown error',
    action,
    timestamp: new Date().toISOString(),
    ...extra,
  };
  if (err instanceof OtrsRequestError || err?.name === 'OtrsRequestError') {
    envelope.category = err.category;
    envelope.phase = err.phase;
    envelope.details = typeof err.toJSON === 'function' ? err.toJSON() : null;
    return { status: 502, jsonBody: envelope };
  }
  envelope.category = 'internal';
  envelope.stack = err?.stack || null;
  return { status: 500, jsonBody: envelope };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function resolveWikiOrFail(context) {
  try {
    const registry = loadWikiRegistry();
    const wiki = findWiki(registry, DEFAULT_WIKI);
    if (!wiki) {
      return {
        errorResponse: {
          status: 500,
          jsonBody: {
            error: `Default wiki "${DEFAULT_WIKI}" is not configured.`,
            available: registry.map(w => w.name),
          },
        },
      };
    }
    return { wiki };
  } catch (err) {
    context.error('otrs-admin wiki resolve error:', err);
    return {
      errorResponse: {
        status: 500,
        jsonBody: { error: 'Wiki registry failed to load.', hint: err.message },
      },
    };
  }
}

async function safeReadState(context) {
  try { return await readState(); }
  catch (err) {
    context.log(`otrs-admin: state read probe failed — ${err.message}`);
    return null;
  }
}

function authPrincipal(request) {
  const name = request.headers.get('x-ms-client-principal-name');
  return name || null;
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
