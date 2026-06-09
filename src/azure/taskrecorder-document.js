/**
 * D365FO Task Recorder — enriched document builder
 *
 * Orchestrates the whole "recording → formatted document" pipeline:
 *   1. parse the .axtr technical bundle (Recording.xml + BPM security)
 *   2. parse the optional .docx (Word) export for step text + screenshots
 *   3. align Word steps ↔ recorded actions by document order (as the reference
 *      Map-TaskRecording.ps1 does) and attach each screenshot to its step
 *   4. match each action's form/menu-item to its BPM security block
 *   5. enrich each distinct form with KB technical data (form / classes &
 *      methods / OData endpoints) and each distinct BPM role with the Security
 *      DB role-based access chain + assigned users
 *   6. render a single self-contained HTML document and wrap it as MHTML with
 *      the screenshots embedded inline
 *
 * Returns `{ mhtml, summaryMarkdown, structured }`. The MHTML is the deliverable
 * document; `structured` is the bounded typed payload the MCP tool returns as
 * structuredContent; `summaryMarkdown` is the human/LLM-facing text channel.
 *
 * KB/Sec enrichment is optional: pass `kbDb`/`secDb` handles (or null) — when a
 * DB is absent the relevant section renders a "not available" note.
 */

import { parseTaskRecordingData } from './taskrecorder-parser.js';
import { parseDocxScreenshots } from './docx-screenshots.js';
import { enrichFormFromKb, enrichRoleFromSec } from './taskrecorder-enrich.js';
import { buildMhtml } from './mhtml.js';
import { buildTaskRecorderXml } from './taskrecorder-xml.js';

const MAX_FORMS_ENRICH = 10;
const MAX_ROLES_ENRICH = 60;

// ── small helpers ────────────────────────────────────────────────────────────

function recVal(node, key) {
  if (!node) return null;
  const v = node[key];
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'object' && !Array.isArray(v)) {
    if (v['@_nil'] === 'true') return null;
    if (v['#text'] !== undefined) return String(v['#text']);
    return null;
  }
  return String(v);
}

function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function ciKey(s) { return (s || '').toLowerCase(); }

function trimDot(s) { return (s || '').trim().replace(/\.+$/, ''); }

function extFromMime(mime) {
  const map = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif',
    'image/bmp': 'bmp', 'image/tiff': 'tiff', 'image/emf': 'emf',
    'image/wmf': 'wmf', 'image/svg+xml': 'svg',
  };
  return map[mime] || 'bin';
}

/** Render an array of objects as an HTML table for the given columns. */
function htmlTable(rows, columns) {
  if (!rows || !rows.length) return '<p class="muted">None.</p>';
  const head = columns.map(c => `<th>${escapeHtml(c.label)}</th>`).join('');
  const body = rows.map(r => {
    const tds = columns.map(c => {
      const v = typeof c.get === 'function' ? c.get(r) : r[c.key];
      return `<td>${escapeHtml(v == null ? '' : v)}</td>`;
    }).join('');
    return `<tr>${tds}</tr>`;
  }).join('');
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

const DOC_CSS = `
  body { font-family: Segoe UI, Arial, sans-serif; color: #1b1b1b; max-width: 1100px; margin: 1.5rem auto; padding: 0 1.25rem; line-height: 1.45; }
  h1 { border-bottom: 3px solid #0078d4; padding-bottom: .3rem; }
  h2 { margin-top: 2rem; border-bottom: 1px solid #ddd; padding-bottom: .2rem; color: #0b3a5b; }
  h3 { margin-top: 1.5rem; color: #11567f; }
  table { border-collapse: collapse; width: 100%; margin: .6rem 0; font-size: .92rem; }
  th, td { border: 1px solid #ccc; padding: .35rem .55rem; text-align: left; vertical-align: top; }
  th { background: #f0f6fb; }
  code, .mono { font-family: Consolas, monospace; background: #f5f5f5; padding: 0 .25rem; border-radius: 3px; }
  .muted { color: #777; font-style: italic; }
  .step { border: 1px solid #e3e3e3; border-radius: 6px; padding: .25rem 1rem 1rem; margin: 1rem 0; background: #fbfdff; }
  .shot { margin: .6rem 0; }
  .shot img { max-width: 100%; border: 1px solid #bbb; border-radius: 4px; }
  .note { background: #fff8e1; border-left: 4px solid #f0ad4e; padding: .5rem .75rem; margin: .6rem 0; }
  .pill { display: inline-block; background: #eef; border: 1px solid #ccd; border-radius: 10px; padding: 0 .5rem; font-size: .82rem; }
  .meta-list { list-style: none; padding-left: 0; }
  .meta-list li { margin: .15rem 0; }
`;

// ── action helpers ────────────────────────────────────────────────────────────

/** Effective step description, mirroring the Markdown parser's precedence. */
function actionDescription(a, localizedSteps) {
  if (a.customDescription) return a.customDescription;
  if (a.globalId && localizedSteps[a.globalId]) return localizedSteps[a.globalId];
  return a.description || '';
}

function actionTarget(a, formIdToName) {
  const formName = a.formId ? formIdToName[a.formId] : null;
  if (a.commandName) return `Command: ${a.commandName}${formName ? ` (form ${formName})` : ''}`;
  if (a.menuItemName) return `Menu item: ${a.menuItemName}${a.menuItemType ? ` [${a.menuItemType}]` : ''}`;
  if (a.controlName) return `Control: ${a.controlName}`;
  if (formName) return `Form: ${formName}`;
  return a.nodeType || null;
}

/** The AOT object this action touches (used to match a BPM security block). */
function actionObject(a, formIdToName) {
  if (a.formId && formIdToName[a.formId]) return formIdToName[a.formId];
  if (a.menuItemName) return a.menuItemName;
  return null;
}

// ── main ──────────────────────────────────────────────────────────────────────

/**
 * @param {Buffer} axtrBuf
 * @param {Buffer|null} docxBuf
 * @param {object} [opts]
 * @param {object|null} [opts.kbDb]
 * @param {object|null} [opts.secDb]
 * @param {boolean} [opts.includeUsers=true]
 * @param {string|null} [opts.company=null]
 * @param {number} [opts.maxUsers=50]
 * @param {string} [opts.fileName='recording.axtr']
 * @param {string} [opts.generatedAt] - ISO timestamp for the footer (injectable for tests)
 * @returns {{ mhtml: string, summaryMarkdown: string, structured: object }}
 */
export function buildTaskRecorderDocument(axtrBuf, docxBuf, opts = {}) {
  const {
    kbDb = null, secDb = null, includeUsers = true, company = null,
    maxUsers = 50, fileName = 'recording.axtr',
  } = opts;
  const generatedAt = opts.generatedAt || new Date().toISOString();

  const { rec, forms, formIdToName, allNodes, language, localizedSteps, bpm } =
    parseTaskRecordingData(axtrBuf);

  const recording = {
    name: recVal(rec, 'Name') || '(unnamed)',
    description: recVal(rec, 'Description'),
    canonical_id: recVal(rec, 'CanonicalId'),
    version: recVal(rec, 'Version'),
    language: language || null,
  };

  // ── docx ─────────────────────────────────────────────────────────────────
  let docx = { title: null, steps: [], imageCount: 0 };
  let docxError = null;
  if (docxBuf) {
    try { docx = parseDocxScreenshots(docxBuf); }
    catch (e) { docxError = e.message; }
  }

  // ── actions (non-scope nodes, in sequence order) ──────────────────────────
  const actions = allNodes.filter(n => n.nodeType !== 'Scope').sort((a, b) => a.sequence - b.sequence);
  const scopes = allNodes.filter(n => n.nodeType === 'Scope');

  const breakdown = {};
  for (const a of actions) breakdown[a.nodeType] = (breakdown[a.nodeType] || 0) + 1;

  // navigation flow (public form scopes, consecutive-dedup)
  const flow = [];
  for (const s of scopes.filter(s => s.isForm === 'true' && s.scopeType === 'Public').sort((a, b) => a.sequence - b.sequence)) {
    if (!flow.length || flow[flow.length - 1] !== s.scopeName) flow.push(s.scopeName);
  }

  // ── BPM security by object ─────────────────────────────────────────────────
  const bpmByObject = new Map();
  for (const ps of bpm.processSteps) {
    if (ps.aotName) bpmByObject.set(ciKey(ps.aotName), ps);
  }

  // ── align steps ↔ actions, attach screenshots ──────────────────────────────
  const resources = [];   // MHTML embedded parts
  const max = Math.max(actions.length, docx.steps.length);
  const steps = [];
  for (let i = 0; i < max; i++) {
    const a = i < actions.length ? actions[i] : null;
    const ds = i < docx.steps.length ? docx.steps[i] : null;
    const desc = a ? actionDescription(a, localizedSteps) : (ds ? ds.text : '');
    const obj = a ? actionObject(a, formIdToName) : null;
    const ps = obj ? bpmByObject.get(ciKey(obj)) : null;

    // screenshots from the Word step
    const shots = [];
    if (ds && ds.images.length) {
      let n = 1;
      for (const img of ds.images) {
        const loc = `images/step${String(i + 1).padStart(2, '0')}_${n}.${extFromMime(img.mime)}`;
        resources.push({ contentLocation: loc, mime: img.mime, bytes: img.bytes });
        shots.push({ name: img.name, mime: img.mime, content_location: loc });
        n++;
      }
    }

    const textsAgree = !(a && ds) ? true
      : trimDot(ds.text).toLowerCase() === trimDot(desc).toLowerCase();

    steps.push({
      step: i + 1,
      docx_text: ds ? ds.text : null,
      description: desc || null,
      sequence: a ? a.sequence : null,
      action_type: a ? a.nodeType : null,
      target: a ? actionTarget(a, formIdToName) : null,
      global_id: a ? (a.globalId || null) : null,
      control_label: a ? (a.controlLabel || null) : null,
      control_name: a ? (a.controlName || null) : null,
      control_type: a ? (a.controlType || null) : null,
      command_name: a ? (a.commandName || null) : null,
      menu_item_name: a ? (a.menuItemName || null) : null,
      object_name: obj || null,
      texts_agree: textsAgree,
      screenshots: shots,
      security: ps ? ps.security : [],
    });
  }

  // ── consolidated BPM security ──────────────────────────────────────────────
  const bpmObjects = bpm.processSteps.map(ps => ({
    aot_name: ps.aotName || null,
    type: ps.type || null,
    label: ps.label || null,
    security: ps.security || [],
  }));
  const roleTuples = [];
  const seenTuple = new Set();
  for (const ps of bpm.processSteps) {
    for (const s of ps.security || []) {
      const k = `${s.roleName}|${s.dutyName}|${s.privName}`;
      if (seenTuple.has(k)) continue;
      seenTuple.add(k);
      roleTuples.push(s);
    }
  }

  // ── KB enrichment: distinct forms touched ──────────────────────────────────
  const formNames = [];
  const seenForm = new Set();
  for (const name of [...forms.map(f => f.formName), ...bpm.processSteps.map(ps => ps.aotName)]) {
    if (!name) continue;
    const k = ciKey(name);
    if (seenForm.has(k)) continue;
    seenForm.add(k);
    formNames.push(name);
  }
  const enrichedForms = formNames.slice(0, MAX_FORMS_ENRICH).map(n => enrichFormFromKb(kbDb, n));
  const kbAvailable = enrichedForms.some(f => f.available);

  // ── Sec enrichment: distinct BPM roles ──────────────────────────────────────
  const roleNames = [];
  const seenRole = new Set();
  for (const s of roleTuples) {
    const name = s.roleName || s.role;
    if (!name) continue;
    const k = ciKey(name);
    if (seenRole.has(k)) continue;
    seenRole.add(k);
    roleNames.push(name);
  }
  const enrichedRoles = roleNames.slice(0, MAX_ROLES_ENRICH)
    .map(n => enrichRoleFromSec(secDb, n, { includeUsers, company, maxUsers }));
  const secAvailable = enrichedRoles.some(r => r.available);

  // ── notes ───────────────────────────────────────────────────────────────────
  const notes = [];
  if (docxBuf && docxError) notes.push(`Word document could not be parsed: ${docxError}`);
  if (docxBuf && !docxError && docx.imageCount === 0) notes.push('No screenshots are embedded in the Word document (text-only export).');
  if (!docxBuf) notes.push('No Word (.docx) document supplied — screenshots and step text come from the .axtr only.');
  const axtrHasShots = actions.some(a => a.screenshotUri);
  if (!axtrHasShots && docx.imageCount === 0) notes.push('The recording captured no screenshots (Recording.xml ScreenshotUri values are empty).');
  if (docxBuf && !docxError && actions.length !== docx.steps.length) {
    notes.push(`Step-count mismatch: recording has ${actions.length} action(s), Word has ${docx.steps.length} step(s) — alignment is by document order.`);
  }

  // ── render HTML + MHTML ─────────────────────────────────────────────────────
  const html = renderHtml({
    recording, forms, breakdown, flow, steps, bpmObjects, roleTuples,
    enrichedForms, kbAvailable, enrichedRoles, secAvailable, notes,
    fileName, generatedAt, actionCount: actions.length, screenshotCount: docx.imageCount,
  });
  const mhtml = buildMhtml({ title: `Task Recording — ${recording.name}`, html, resources });

  // ── XML contract serialization (validates against schemas/task-recording-document.xsd) ──
  const xml = buildTaskRecorderXml({
    recording, forms, steps, bpmObjects, roleTuples,
    enrichedForms, kbAvailable, enrichedRoles, secAvailable, notes,
    fileName, generatedAt, actionCount: actions.length, screenshotCount: docx.imageCount,
  });

  // ── bounded structured payload ──────────────────────────────────────────────
  const structured = {
    recording: {
      name: recording.name,
      description: recording.description,
      canonical_id: recording.canonical_id,
      version: recording.version,
      language: recording.language,
      action_count: actions.length,
    },
    step_count: steps.length,
    screenshot_count: docx.imageCount,
    screenshots_present: docx.imageCount > 0,
    steps: steps.map(s => ({
      step: s.step,
      docx_text: s.docx_text,
      description: s.description,
      action_type: s.action_type,
      target: s.target,
      global_id: s.global_id,
      object_name: s.object_name,
      screenshot_count: s.screenshots.length,
      has_security: s.security.length > 0,
      texts_agree: s.texts_agree,
    })),
    forms_enriched: enrichedForms.map(f => ({
      form_name: f.form_name,
      kb_available: f.available,
      kb_found: f.found,
      class_count: f.classes.length,
      endpoint_count: f.endpoints.length,
    })),
    roles_enriched: enrichedRoles.map(r => ({
      queried: r.queried,
      role_name: r.role_name,
      found: r.found,
      sub_role_count: r.sub_roles.length,
      duty_count: r.duties.length,
      privilege_count: r.privileges.length,
      user_count: r.user_count,
    })),
    bpm_role_count: roleTuples.length,
    kb_available: kbAvailable,
    sec_available: secAvailable,
    output_path: null,
    byte_size: Buffer.byteLength(mhtml, 'utf8'),
    document_mhtml: null,
    xml_output_path: null,
    document_xml: null,
    notes,
  };

  const summaryMarkdown = renderSummaryMarkdown(structured, recording);

  return { mhtml, xml, summaryMarkdown, structured };
}

// ── HTML renderer ──────────────────────────────────────────────────────────────

function renderSecurityTable(security) {
  if (!security || !security.length) return '';
  const rows = security.map(s => ({
    access: s.accessLevel || '',
    privilege: s.privilege || s.privName || '',
    duty: s.duty || s.dutyName || '',
    role: s.role || s.roleName || '',
  }));
  return htmlTable(rows, [
    { label: 'Access', key: 'access' },
    { label: 'Privilege', key: 'privilege' },
    { label: 'Duty', key: 'duty' },
    { label: 'Role', key: 'role' },
  ]);
}

function renderHtml(m) {
  const H = [];
  const p = (s) => H.push(s);

  p('<!DOCTYPE html>');
  p('<html><head><meta charset="utf-8">');
  p(`<title>Task Recording — ${escapeHtml(m.recording.name)}</title>`);
  p(`<style>${DOC_CSS}</style></head><body>`);

  p(`<h1>Task Recording: ${escapeHtml(m.recording.name)}</h1>`);

  // notes / warnings
  for (const n of m.notes) p(`<div class="note">${escapeHtml(n)}</div>`);

  // ── Overview ────────────────────────────────────────────────────────────
  p('<h2>1. Overview</h2>');
  const ov = [
    ['Recording name', m.recording.name],
    ['Description', m.recording.description || '(none)'],
    ['Canonical ID', m.recording.canonical_id || ''],
    ['Version', m.recording.version || ''],
    ['Language', m.recording.language || ''],
    ['Total user actions', String(m.actionCount)],
    ['Screenshots embedded', String(m.screenshotCount)],
  ];
  p('<table><tbody>' + ov.map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`).join('') + '</tbody></table>');

  const bd = Object.entries(m.breakdown).map(([k, v]) => `${escapeHtml(k)}: ${v}`).join(' &middot; ');
  if (bd) p(`<p><strong>Action breakdown:</strong> ${bd}</p>`);
  if (m.flow.length > 1) p(`<p><strong>Navigation flow:</strong> ${m.flow.map(f => `<span class="pill">${escapeHtml(f)}</span>`).join(' → ')}</p>`);

  // forms visited
  if (m.forms.length) {
    p('<h3>Forms visited</h3>');
    p(htmlTable(m.forms, [
      { label: 'Form (AOT)', key: 'formName' },
      { label: 'Menu item label', get: f => f.menuLabel || '' },
      { label: 'Menu item', get: f => f.menuName || '' },
      { label: 'Type', get: f => f.menuType || '' },
    ]));
  }

  // ── Recorded process ──────────────────────────────────────────────────────
  p('<h2>2. Recorded process</h2>');
  if (!m.steps.length) {
    p('<p class="muted">No steps recorded.</p>');
  } else {
    for (const s of m.steps) {
      p('<div class="step">');
      p(`<h3>Step ${s.step}: ${escapeHtml(s.description || s.docx_text || '(no description)')}</h3>`);
      const meta = [];
      if (s.action_type) meta.push(`<li><strong>Action type:</strong> ${escapeHtml(s.action_type)}</li>`);
      if (s.target) meta.push(`<li><strong>Target:</strong> ${escapeHtml(s.target)}</li>`);
      if (s.control_label || s.control_name) meta.push(`<li><strong>Control:</strong> ${escapeHtml(s.control_label || '')} <span class="mono">${escapeHtml(s.control_name || '')}</span>${s.control_type ? ` (${escapeHtml(s.control_type)})` : ''}</li>`);
      if (s.object_name) meta.push(`<li><strong>Object:</strong> <span class="mono">${escapeHtml(s.object_name)}</span></li>`);
      if (s.global_id) meta.push(`<li><strong>GlobalId:</strong> <span class="mono">${escapeHtml(s.global_id)}</span></li>`);
      if (s.docx_text && !s.texts_agree) meta.push(`<li class="muted">Word text differs: "${escapeHtml(s.docx_text)}"</li>`);
      if (meta.length) p(`<ul class="meta-list">${meta.join('')}</ul>`);

      for (const shot of s.screenshots) {
        p(`<div class="shot"><img src="${escapeHtml(shot.content_location)}" alt="Screenshot for step ${s.step}"></div>`);
      }

      if (s.security.length) {
        p('<p><strong>Security for this object (Task Recorder BPM):</strong></p>');
        p(renderSecurityTable(s.security));
      }
      p('</div>');
    }
  }

  // ── BPM security ───────────────────────────────────────────────────────────
  p('<h2>3. Security (Task Recorder BPM package)</h2>');
  if (!m.roleTuples.length) {
    p('<p class="muted">The BPM package contains no security information.</p>');
  } else {
    p(`<p>The recording's BPM package lists the following role-based access to the objects it touched (${m.roleTuples.length} distinct role/duty/privilege grants):</p>`);
    p(renderSecurityTable(m.roleTuples));
  }

  // ── Technical (KB) ───────────────────────────────────────────────────────────
  p('<h2>4. Technical details (D365FO Knowledge Base)</h2>');
  if (!m.kbAvailable) {
    p('<div class="note">KB database not available — set <span class="mono">KB_DB_PATH</span> to include the used form, executed classes/methods, and OData endpoints.</div>');
  } else {
    for (const f of m.enrichedForms) {
      if (!f.available) continue;
      p(`<h3>Form: <span class="mono">${escapeHtml(f.form_name)}</span></h3>`);
      if (!f.found) {
        p(`<p class="muted">Not found in the KB snapshot.</p>`);
        continue;
      }
      const fm = [];
      if (f.label) fm.push(`<li><strong>Label:</strong> ${escapeHtml(f.label)}</li>`);
      if (f.module_id) fm.push(`<li><strong>Module / package:</strong> ${escapeHtml(f.module_id)}</li>`);
      if (f.root_tables.length) fm.push(`<li><strong>Data source tables:</strong> ${f.root_tables.map(t => `<span class="mono">${escapeHtml(t)}</span>`).join(', ')}</li>`);
      if (fm.length) p(`<ul class="meta-list">${fm.join('')}</ul>`);

      if (f.classes.length) {
        p('<p><strong>Executed / related classes and methods:</strong></p>');
        for (const c of f.classes) {
          const methods = c.methods.map(mm => `<span class="mono">${escapeHtml(mm.method_name)}</span>`).join(', ');
          p(`<p><span class="mono">${escapeHtml(c.class_name)}</span>${c.edge_type ? ` <span class="pill">${escapeHtml(c.edge_type)}</span>` : ''}${methods ? `<br>${methods}${c.methods_truncated ? ' …' : ''}` : ''}</p>`);
        }
      } else {
        p('<p class="muted">No related classes found in the KB.</p>');
      }

      if (f.endpoints.length) {
        p('<p><strong>OData / data-entity endpoints:</strong></p>');
        p(htmlTable(f.endpoints, [
          { label: 'Entity', key: 'entity_name' },
          { label: 'Public name', get: e => e.public_name || '' },
          { label: 'Collection', get: e => e.public_collection || '' },
          { label: 'Public', get: e => (e.is_public == null ? '' : String(e.is_public)) },
          { label: 'Primary table', get: e => e.primary_table || '' },
        ]));
      }
    }
  }

  // ── Role-based security (Sec DB) ─────────────────────────────────────────────
  p('<h2>5. Role-based security (Security configuration)</h2>');
  if (!m.secAvailable) {
    p('<div class="note">Security database not available — set <span class="mono">SEC_DB_PATH</span> to include roles, sub-roles, duties, privileges, and assigned users.</div>');
  } else {
    p('<p class="muted">User lists show user ID and name only — email addresses are intentionally omitted.</p>');
    for (const r of m.enrichedRoles) {
      if (!r.available) continue;
      p(`<h3>Role: ${escapeHtml(r.role_name || r.queried)}</h3>`);
      if (!r.found) {
        p(`<p class="muted">Role <span class="mono">${escapeHtml(r.queried)}</span> not found in the security snapshot.</p>`);
        continue;
      }
      const rm = [];
      if (r.role_id && r.role_id !== r.role_name) rm.push(`<li><strong>Identifier:</strong> <span class="mono">${escapeHtml(r.role_id)}</span></li>`);
      if (r.license_type) rm.push(`<li><strong>License:</strong> ${escapeHtml(r.license_type)}</li>`);
      if (r.permission_type) rm.push(`<li><strong>Permission:</strong> ${escapeHtml(r.permission_type)}</li>`);
      const usersFacet = r.users_included ? `<strong>Assigned users:</strong> ${r.user_count}` : `<strong>Assigned users:</strong> not requested`;
      rm.push(`<li><strong>Sub-roles:</strong> ${r.sub_roles.length} &middot; <strong>Duties:</strong> ${r.duties.length}${r.duties_truncated ? '+' : ''} &middot; <strong>Privileges:</strong> ${r.privileges.length}${r.privileges_truncated ? '+' : ''} &middot; ${usersFacet}</li>`);
      p(`<ul class="meta-list">${rm.join('')}</ul>`);

      if (r.sub_roles.length) {
        p('<p><strong>Sub-roles:</strong> ' + r.sub_roles.map(s => escapeHtml(s.role_name)).join(', ') + '</p>');
      }
      if (r.duties.length) {
        p('<p><strong>Duties:</strong></p>');
        p(htmlTable(r.duties, [
          { label: 'Duty', key: 'duty_id' },
          { label: 'Name', get: d => d.duty_name || '' },
          { label: 'Permission', get: d => d.permission_type || '' },
        ]));
      }
      if (r.privileges.length) {
        p(`<p><strong>Privileges (${r.privileges.length}${r.privileges_truncated ? '+' : ''}):</strong> ` + r.privileges.map(pr => `<span class="mono">${escapeHtml(pr)}</span>`).join(', ') + '</p>');
      }
      if (r.users.length) {
        p(`<p><strong>Assigned users (${r.user_count}${r.users_truncated ? `, showing ${r.users.length}` : ''}):</strong></p>`);
        p(htmlTable(r.users, [
          { label: 'User ID', key: 'user_id' },
          { label: 'Name', get: u => u.person_name || '' },
          { label: 'Enabled', get: u => (u.enabled == null ? '' : String(u.enabled)) },
        ]));
      } else if (!r.users_included) {
        p('<p class="muted">Assigned users were not requested (include_users=false).</p>');
      } else if (r.user_count === 0) {
        p('<p class="muted">No users assigned.</p>');
      }
    }
  }

  p(`<hr><p class="muted">Generated from <span class="mono">${escapeHtml(m.fileName)}</span> on ${escapeHtml(m.generatedAt)} by the D365FO Task Recorder MCP service.</p>`);
  p('</body></html>');
  return H.join('\n');
}

// ── Markdown summary (text channel) ──────────────────────────────────────────

function renderSummaryMarkdown(s, recording) {
  const L = [];
  L.push(`## Task Recording document: ${recording.name}`);
  L.push('');
  L.push('A self-contained MHTML web-archive was generated. Summary:');
  L.push('');
  L.push('| Property | Value |');
  L.push('| --- | --- |');
  L.push(`| Recording | ${recording.name} |`);
  L.push(`| Steps | ${s.step_count} |`);
  L.push(`| Screenshots embedded | ${s.screenshot_count} |`);
  L.push(`| BPM role grants | ${s.bpm_role_count} |`);
  L.push(`| KB technical enrichment | ${s.kb_available ? 'included' : 'unavailable'} |`);
  L.push(`| Role/user enrichment | ${s.sec_available ? 'included' : 'unavailable'} |`);
  L.push(`| Document size | ${(s.byte_size / 1024).toFixed(1)} KB |`);
  if (s.output_path) L.push(`| Written to | ${s.output_path} |`);
  L.push('');

  if (s.steps.length) {
    L.push('### Step → action mapping');
    L.push('');
    L.push('| # | Step | Action | Target | Shots | Security |');
    L.push('| --- | --- | --- | --- | --- | --- |');
    for (const st of s.steps) {
      const text = (st.description || st.docx_text || '').replace(/\|/g, '\\|');
      L.push(`| ${st.step} | ${text} | ${st.action_type || ''} | ${(st.target || '').replace(/\|/g, '\\|')} | ${st.screenshot_count} | ${st.has_security ? 'yes' : '—'} |`);
    }
    L.push('');
  }

  if (s.notes.length) {
    L.push('### Notes');
    for (const n of s.notes) L.push(`- ${n}`);
    L.push('');
  }
  return L.join('\n');
}
