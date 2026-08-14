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
import { ticketPdfBaseName } from '../azure/ticket-pdf-helpers.js';
import { splitExtractPerTicket } from '../azure/otrs-xml-split.js';
import { parseExtractXml } from '../azure/otrs-xml-parse.js';
import { ticketToRagText } from '../azure/ticket-to-rag-text.js';
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
        <label class="choice"><input type="checkbox" name="perTicket" id="extractPerTicket"> one XML per ticket (ZIP)</label>
        <button type="submit" class="btn btn-blue" id="extractBtn">Download</button>
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
    <h2>Step 4 — Send tickets to the RAG service</h2>
    <p class="hint">Pushes the ticket content into the RAG store as external documents tagged <code>source_type=otrs</code>, <code>reliability=low</code> (so the RAG's quality-aware retrieval knows to treat these as useful-but-unreliable). The ticket's full text (metadata + problem + resolution + every article body) is chunked and embedded server-side; re-uploading the same ticket upserts in place via <code>otrs://&lt;ticketId&gt;</code>. Accepts the same input shapes as Step 3.</p>
    <form id="ragForm">
      <div class="drop" id="ragDropZone">
        <div>Drop one or more XML files (or a ZIP), or click to browse</div>
        <div class="file" id="ragFileName"></div>
      </div>
      <input type="file" id="ragXmlFile" accept=".xml,.zip,text/xml,application/xml,application/zip" multiple>
      <div class="row" style="margin-top:12px">
        <button type="submit" class="btn" id="ragBtn" disabled>Upload to RAG</button>
      </div>
    </form>
    <div id="ragResult" class="result" data-id="ragResult"></div>
  </div>

  <div class="card">
    <h2>Step 3 — Convert XML(s) to PDFs</h2>
    <p class="hint">Drop one or many XML files (or a single <code>.zip</code> of XMLs from Step 1) and get a ZIP of PDFs back. Each ticket produces one main PDF named <code>&lt;ticketnumber&gt;-&lt;title&gt;.pdf</code> with filled-in metadata, non-empty dynamic fields, and inline PNG/JPEG attachments. Every non-image attachment becomes a sibling PDF (docx → readable text, xlsx → cell tables, pdf → passthrough, other → placeholder). Raw base64 is never rendered. Single-PDF responses stream directly for in-browser preview.</p>
    <form id="pdfForm">
      <div class="drop" id="pdfDropZone">
        <div>Drop one or more XML files (or a ZIP), or click to browse</div>
        <div class="file" id="pdfFileName"></div>
      </div>
      <input type="file" id="pdfXmlFile" accept=".xml,.zip,text/xml,application/xml,application/zip" multiple>
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
    const ragForm = document.getElementById('ragForm');
    const ragBtn = document.getElementById('ragBtn');
    const ragResult = document.getElementById('ragResult');
    const ragDropZone = document.getElementById('ragDropZone');
    const ragFileInput = document.getElementById('ragXmlFile');
    const ragFileName = document.getElementById('ragFileName');

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
        const perTicket = fd.get('perTicket') === 'on';
        const body = {
          mode: fd.get('mode') || 'incremental',
          limit: fd.get('limit') ? Number(fd.get('limit')) : undefined,
          perTicket,
        };
        const resp = await fetch('/api/otrs-admin/extract', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!resp.ok) {
          const errData = await resp.json().catch(() => ({ error: 'HTTP ' + resp.status + ' (non-JSON response)' }));
          renderError(extractResult, 'extract', errData);
          return;
        }
        const blob = await resp.blob();
        const filename = (resp.headers.get('content-disposition') || '').match(/filename="?([^";]+)/)?.[1]
          || (perTicket ? 'otrs-extract.zip' : 'otrs-extract.xml');
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = filename; document.body.appendChild(a); a.click();
        URL.revokeObjectURL(url); a.remove();

        const extracted = resp.headers.get('x-otrs-extracted') ?? '?';
        const skipped = resp.headers.get('x-otrs-skipped') ?? '?';
        const files = resp.headers.get('x-otrs-files');
        let summary = '<strong>Downloaded.</strong> Extracted ' + extracted + ' ticket(s), skipped ' + skipped + '.';
        if (files) summary += ' Bundled ' + files + ' XML file(s).';
        summary += ' File: <code>' + filename + '</code>';
        setResult(extractResult, 'success', summary);
      } catch (err) {
        renderError(extractResult, 'extract', {
          error: err.message || String(err),
          category: 'browser-network',
          timestamp: new Date().toISOString(),
        });
      } finally {
        extractBtn.disabled = false;
        extractBtn.textContent = 'Download';
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
      const list = pdfFileInput.files;
      if (!list || list.length === 0) { pdfFileName.textContent = ''; pdfBtn.disabled = true; return; }
      if (list.length === 1) {
        const f = list[0];
        pdfFileName.textContent = f.name + ' (' + (f.size / 1024).toFixed(1) + ' KB)';
      } else {
        let total = 0;
        for (const f of list) total += f.size;
        pdfFileName.textContent = list.length + ' files, ' + (total / 1024).toFixed(1) + ' KB total';
      }
      pdfBtn.disabled = false;
    }

    pdfForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const list = pdfFileInput.files;
      if (!list || list.length === 0) return;

      pdfBtn.disabled = true;
      pdfBtn.innerHTML = '<span class="spinner"></span> Rendering PDFs...';
      setResult(pdfResult, 'info',
        'Parsing ' + list.length + ' file(s), rendering PDFs, decoding attachments — this can take up to a minute.');

      try {
        // Dispatch by file count + type to the three accepted body shapes:
        //   1 file, .zip  → application/zip
        //   1 file, .xml  → application/xml
        //   N files       → multipart/form-data
        const isZip = list.length === 1 && /\.zip$/i.test(list[0].name);
        let init;
        if (list.length === 1 && !isZip) {
          const xml = await list[0].text();
          init = { method: 'POST', headers: { 'Content-Type': 'application/xml' }, body: xml };
        } else if (isZip) {
          init = { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: list[0] };
        } else {
          const form = new FormData();
          for (let i = 0; i < list.length; i++) form.append('xml', list[i], list[i].name);
          init = { method: 'POST', body: form };  // browser sets multipart header
        }

        const resp = await fetch('/api/otrs-admin/convert-to-pdf', init);
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

    // ── Step 4 — Upload to RAG ───────────────────────────────────────────
    ragDropZone.addEventListener('click', () => ragFileInput.click());
    ragDropZone.addEventListener('dragover', e => { e.preventDefault(); ragDropZone.classList.add('dragover'); });
    ragDropZone.addEventListener('dragleave', () => ragDropZone.classList.remove('dragover'));
    ragDropZone.addEventListener('drop', e => {
      e.preventDefault();
      ragDropZone.classList.remove('dragover');
      if (e.dataTransfer.files.length) {
        ragFileInput.files = e.dataTransfer.files;
        onRagFile();
      }
    });
    ragFileInput.addEventListener('change', onRagFile);

    function onRagFile() {
      const list = ragFileInput.files;
      if (!list || list.length === 0) { ragFileName.textContent = ''; ragBtn.disabled = true; return; }
      if (list.length === 1) {
        const f = list[0];
        ragFileName.textContent = f.name + ' (' + (f.size / 1024).toFixed(1) + ' KB)';
      } else {
        let total = 0;
        for (const f of list) total += f.size;
        ragFileName.textContent = list.length + ' files, ' + (total / 1024).toFixed(1) + ' KB total';
      }
      ragBtn.disabled = false;
    }

    ragForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const list = ragFileInput.files;
      if (!list || list.length === 0) return;

      ragBtn.disabled = true;
      ragBtn.innerHTML = '<span class="spinner"></span> Uploading...';
      setResult(ragResult, 'info', 'Parsing XML(s), chunking text, generating embeddings, inserting into RAG — this can take 30-60 seconds for a large batch.');

      try {
        const isZip = list.length === 1 && /\.zip$/i.test(list[0].name);
        let init;
        if (list.length === 1 && !isZip) {
          const xml = await list[0].text();
          init = { method: 'POST', headers: { 'Content-Type': 'application/xml' }, body: xml };
        } else if (isZip) {
          init = { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: list[0] };
        } else {
          const form = new FormData();
          for (let i = 0; i < list.length; i++) form.append('xml', list[i], list[i].name);
          init = { method: 'POST', body: form };
        }

        const resp = await fetch('/api/otrs-admin/upload-to-rag', init);
        const data = await resp.json().catch(() => ({ error: 'HTTP ' + resp.status + ' (non-JSON response)' }));
        if (!resp.ok) {
          renderError(ragResult, 'upload-to-rag', data);
          return;
        }

        let summary = '<strong>Uploaded.</strong> '
          + data.uploaded + '/' + data.total + ' ticket(s) indexed into RAG'
          + (data.ragEndpoint ? ' at <code>' + data.ragEndpoint + '</code>' : '');
        if (data.failed > 0) {
          summary += '<br/><strong style="color:#82071e">' + data.failed + ' ticket(s) failed.</strong> See details below.';
        }
        summary += '<details style="margin-top:10px;"><summary style="cursor:pointer;font-weight:600;">Full JSON result</summary>'
          + '<pre>' + escapeHtml(JSON.stringify(data, null, 2)) + '</pre></details>';
        setResult(ragResult, data.failed > 0 ? 'error' : 'success', summary);
      } catch (err) {
        renderError(ragResult, 'upload-to-rag', {
          error: err.message || String(err),
          category: 'browser-network',
          timestamp: new Date().toISOString(),
        });
      } finally {
        ragBtn.disabled = false;
        ragBtn.textContent = 'Upload to RAG';
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
  route: 'api/otrs-admin',
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
  route: 'api/otrs-admin/extract',
  authLevel: 'anonymous',
  handler: async (request, context) => {
    try {
      let body = {};
      try { body = await request.json(); } catch { /* empty body is ok */ }
      const mode = ['incremental', 'full', 'preview'].includes(body.mode) ? body.mode : 'incremental';
      const limit = Number.isInteger(body.limit) && body.limit > 0 ? body.limit : null;
      const perTicket = body.perTicket === true || new URL(request.url).searchParams.get('perTicket') === 'true';

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

      // Per-ticket mode: split into individual <OtrsExtract count="1"> docs
      // and return a ZIP so Power Automate can iterate naturally.
      if (perTicket) {
        const parts = splitExtractPerTicket(xml);
        const zip = new AdmZip();
        for (const p of parts) zip.addFile(p.filename, p.buffer);
        const manifest = {
          generatedAt: new Date().toISOString(),
          mode, extracted: extracted.length, skipped: skipped.length,
          files: parts.map(p => ({
            filename: p.filename,
            ticketId: p.ticketId, ticketNumber: p.ticketNumber, title: p.title,
          })),
        };
        zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
        const zipBuffer = zip.toBuffer();
        return {
          status: 200,
          headers: {
            'Content-Type': 'application/zip',
            'Content-Disposition': `attachment; filename="otrs-extract-${mode}-${date}.zip"`,
            'X-OTRS-Extracted':  String(extracted.length),
            'X-OTRS-Skipped':    String(skipped.length),
            'X-OTRS-Candidates': String(candidateIds.length),
            'X-OTRS-Files':      String(parts.length),
          },
          body: zipBuffer,
        };
      }

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
  route: 'api/otrs-admin/extract-single',
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

      // Filename follows the operator-facing <ticketNumber>-<title> rule so
      // PowerAutomate can drop it straight onto SharePoint / a share without
      // renaming. Falls back through number → title → id → 'unknown'.
      const filename = `${ticketPdfBaseName(extracted)}.xml`;

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
  route: 'api/otrs-admin/ingest',
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
  route: 'api/otrs-admin/convert-to-pdf',
  authLevel: 'anonymous',
  handler: async (request, context) => {
    try {
      // Inputs accepted:
      //   - Content-Type: application/xml  → one OtrsExtract envelope
      //   - Content-Type: application/zip  → many XMLs inside a ZIP
      //   - Content-Type: multipart/form-data → one or more XML files
      //     uploaded through the HTML form
      // Output is always a ZIP of `<ticketNumber>-<title>.pdf` per ticket
      // (plus any non-image attachment siblings plus manifest.json), except
      // when exactly one PDF is produced — then the PDF streams directly so
      // the browser can preview it in-line.
      const xmlDocs = await collectXmlInputs(request);
      if (xmlDocs.length === 0) {
        return { status: 400, jsonBody: { error: 'No XML documents found in the request.' } };
      }
      const combinedBytes = xmlDocs.reduce((n, x) => n + Buffer.byteLength(x, 'utf8'), 0);
      if (combinedBytes > MAX_UPLOAD_BYTES) {
        return {
          status: 413,
          jsonBody: { error: `Combined XML size exceeds ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB limit.` },
        };
      }

      const deps = await getPdfDeps();
      const allFiles = [];
      const allWarnings = [];
      let totalTickets = 0;

      for (const xml of xmlDocs) {
        const { tickets, files, warnings } = await renderExtractPdfs({ xml, deps });
        totalTickets += tickets;
        allFiles.push(...files);
        allWarnings.push(...warnings);
      }

      if (totalTickets === 0) {
        return {
          status: 400,
          jsonBody: { error: 'No <Ticket> elements found in any of the XMLs — nothing to render.' },
        };
      }

      // Single-PDF shortcut — unchanged behavior from before: preview-
      // friendly direct application/pdf response with a descriptive
      // filename (Phase 1a renamed it to <ticketNumber>-<title>.pdf).
      if (allFiles.length === 1) {
        const only = allFiles[0];
        return {
          status: 200,
          headers: {
            'Content-Type': 'application/pdf',
            'Content-Disposition': `attachment; filename="${only.filename}"`,
            'X-PDF-Tickets':  String(totalTickets),
            'X-PDF-Files':    '1',
            'X-PDF-Warnings': String(allWarnings.length),
          },
          body: only.buffer,
        };
      }

      const zip = new AdmZip();
      for (const f of allFiles) zip.addFile(f.filename, f.buffer);
      const manifest = {
        generatedAt: new Date().toISOString(),
        tickets: totalTickets,
        inputDocuments: xmlDocs.length,
        fileCount: allFiles.length,
        files: allFiles.map(f => ({ filename: f.filename, bytes: f.buffer.length })),
        warnings: allWarnings,
      };
      zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
      const zipBuffer = zip.toBuffer();

      const date = new Date().toISOString().slice(0, 19).replace(/:/g, '').replace('T', '-');
      const zipName = `otrs-pdfs-${date}.zip`;

      context.log(`otrs-admin-convert-to-pdf: ${xmlDocs.length} XML(s), ${totalTickets} ticket(s), `
        + `${allFiles.length} file(s), ${allWarnings.length} warning(s), zip=${zipBuffer.length} bytes`);

      return {
        status: 200,
        headers: {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="${zipName}"`,
          'X-PDF-Tickets':  String(totalTickets),
          'X-PDF-Files':    String(allFiles.length),
          'X-PDF-Warnings': String(allWarnings.length),
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
 * Normalize the three accepted input shapes into an array of XML strings
 * so the handler above can iterate uniformly. Unrecognized content
 * types surface as an empty array → the handler returns 400.
 */
async function collectXmlInputs(request) {
  const contentType = (request.headers.get('content-type') || '').toLowerCase();

  // multipart/form-data: multiple <input type="file" name="xml"> fields
  if (contentType.includes('multipart/form-data')) {
    const form = await request.formData();
    const out = [];
    for (const [, value] of form.entries()) {
      if (typeof value === 'object' && value && typeof value.text === 'function') {
        const text = await value.text();
        if (text && text.trim()) out.push(text);
      }
    }
    return out;
  }

  // application/zip: ZIP of XMLs (PA's natural one-file upload path)
  if (contentType.includes('application/zip') || contentType.includes('application/x-zip-compressed')) {
    const buf = Buffer.from(await request.arrayBuffer());
    const zip = new AdmZip(buf);
    const out = [];
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory) continue;
      if (!/\.xml$/i.test(entry.entryName)) continue;
      out.push(entry.getData().toString('utf8'));
    }
    return out;
  }

  // application/xml (also text/xml): single envelope
  const text = await request.text();
  if (!text || !text.trim()) return [];
  return [text];
}

/**
 * POST /api/otrs-admin/upload-to-rag — Ingest OTRS tickets into the RAG
 * service as external documents. Accepts the same input shapes as
 * /convert-to-pdf (XML / ZIP / multipart). For each ticket:
 *   1. Parse the envelope
 *   2. Build a plain-text representation via ticketToRagText
 *   3. POST to the RAG service's /api/d365rag/admin/ingest-external
 *      with metadata tagging the document as OTRS-origin, reliability=low
 *
 * Response: JSON summary { total, uploaded, failed, results, errors }.
 * One ticket failing does not abort the batch — errors are collected.
 */
app.http('otrs-admin-upload-to-rag', {
  methods: ['POST'],
  route: 'api/otrs-admin/upload-to-rag',
  authLevel: 'anonymous',
  handler: async (request, context) => {
    try {
      const ragBase = (process.env.RAG_SERVICE_URL || 'https://tis-d-ragsvc-func.azurewebsites.net').replace(/\/$/, '');
      const ragKey  = process.env.RAG_SERVICE_FUNCTION_KEY || null;

      const xmlDocs = await collectXmlInputs(request);
      if (xmlDocs.length === 0) {
        return { status: 400, jsonBody: { error: 'No XML documents found in the request.' } };
      }

      // Flatten all XMLs into a single list of parsed tickets so duplicate
      // detection is global (two XMLs containing the same ticket collapse
      // via RAG's upsert-by-file_path behavior).
      const tickets = [];
      for (const xml of xmlDocs) {
        try {
          const parsed = parseExtractXml(xml);
          for (const t of parsed.tickets) tickets.push(t);
        } catch (err) {
          context.error(`upload-to-rag: could not parse one of the XMLs — ${err.message}`);
        }
      }
      if (tickets.length === 0) {
        return { status: 400, jsonBody: { error: 'No <Ticket> elements found in any of the XMLs.' } };
      }

      const uploaded = [];
      const errors = [];
      for (const ticket of tickets) {
        try {
          const text = ticketToRagText(ticket);
          if (!text.trim()) {
            errors.push({ ticketId: ticket.ticketId, reason: 'text representation was empty' });
            continue;
          }

          const pdfBase = ticketPdfBaseName(ticket);
          const ingestBody = {
            text,
            metadata: {
              // file_path must be globally unique per doc in RAG — use the
              // OTRS internal TicketID so re-ingests of the same ticket
              // UPSERT instead of duplicating.
              file_path:   `otrs://${ticket.ticketId}`,
              file_name:   `${pdfBase}.pdf`,
              title:       ticket.title || pdfBase,
              category:    'otrs-ticket',
              subcategory: ticket.service || null,
              format:      'text',
              source_type: 'otrs',
              reliability: 'low',
              ticketId:       ticket.ticketId,
              ticketNumber:   ticket.ticketNumber,
              closedAt:       ticket.closedAt,
              service:        ticket.service,
              queue:          ticket.queue,
              customerUserId: ticket.customerUserId,
              originUrl:      null,
            },
          };

          const url = `${ragBase}/api/d365rag/admin/ingest-external`
            + (ragKey ? `?code=${encodeURIComponent(ragKey)}` : '');
          const resp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(ingestBody),
          });

          if (!resp.ok) {
            let detail = '';
            try { detail = (await resp.json()).error || (await resp.text()).slice(0, 400); }
            catch { /* best-effort */ }
            errors.push({
              ticketId: ticket.ticketId, ticketNumber: ticket.ticketNumber,
              status: resp.status, reason: `RAG returned HTTP ${resp.status}${detail ? ': ' + detail : ''}`,
            });
            continue;
          }
          const data = await resp.json();
          uploaded.push({
            ticketId: ticket.ticketId,
            ticketNumber: ticket.ticketNumber,
            title: ticket.title,
            doc_id: data.doc_id,
            chunk_count: data.chunk_count,
            embeddings_generated: data.embeddings_generated,
          });
        } catch (err) {
          errors.push({
            ticketId: ticket.ticketId, ticketNumber: ticket.ticketNumber,
            reason: err?.message || String(err),
          });
        }
      }

      context.log(`upload-to-rag: total=${tickets.length} uploaded=${uploaded.length} failed=${errors.length} → ${ragBase}`);

      return {
        status: 200,
        jsonBody: {
          total: tickets.length,
          uploaded: uploaded.length,
          failed: errors.length,
          ragEndpoint: ragBase,
          results: uploaded,
          errors,
        },
      };
    } catch (err) {
      context.error('upload-to-rag error:', err);
      return structuredErrorResponse(err, 'upload-to-rag', {
        hint: 'Check RAG_SERVICE_URL on the Function App and confirm the RAG service is reachable.',
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
