/**
 * D365FO Task Recorder — XML contract serializer
 *
 * Serializes the full enriched recording model to a namespaced XML document
 * (`<TaskRecordingDocument>`) intended for machine consumption: a service can
 * parse it and validate it against `schemas/task-recording-document.xsd`, which
 * is the canonical contract.
 *
 * This is a SEMANTIC serialization of the model — distinct from the MHTML, which
 * is the human-readable rendering. The element order here MUST match the
 * xs:sequence in the XSD; keep the two in lock-step.
 *
 * PRIVACY: <User> carries id + name + enabled only — never an email address.
 */

export const TASKREC_XML_NAMESPACE = 'urn:trelleborg:d365fo:taskrecording:1.0';
export const TASKREC_XSD_FILENAME = 'task-recording-document.xsd';
export const TASKREC_XML_SCHEMA_VERSION = '1.0';

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
function escAttr(s) {
  return esc(s).replace(/"/g, '&quot;');
}

/** Build an opening tag with attributes. Null/undefined attrs are omitted. */
function open(name, attrs, selfClose) {
  let out = `<${name}`;
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === '') continue;
      out += ` ${k}="${escAttr(v)}"`;
    }
  }
  out += selfClose ? '/>' : '>';
  return out;
}

function boolAttr(v) {
  return v === true ? 'true' : v === false ? 'false' : null;
}

/** One BPM <Grant> element (shared by step-level and consolidated security). */
function grantXml(s, indent) {
  return indent + open('Grant', {
    accessLevel: s.accessLevel || null,
    role: s.role || null,
    roleName: s.roleName || null,
    duty: s.duty || null,
    dutyName: s.dutyName || null,
    privilege: s.privilege || null,
    privilegeName: s.privName || null,
  }, true);
}

/**
 * @param {object} model — the full document model assembled by the builder:
 *   { recording, forms, steps, bpmObjects, roleTuples, enrichedForms,
 *     kbAvailable, enrichedRoles, secAvailable, notes, fileName, generatedAt,
 *     actionCount, screenshotCount }
 * @returns {string} XML text
 */
export function buildTaskRecorderXml(model) {
  const L = [];
  const p = (s) => L.push(s);
  const I = '  ';

  p('<?xml version="1.0" encoding="utf-8"?>');
  p(`<TaskRecordingDocument xmlns="${TASKREC_XML_NAMESPACE}"`);
  p(`    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"`);
  p(`    xsi:schemaLocation="${TASKREC_XML_NAMESPACE} ${TASKREC_XSD_FILENAME}"`);
  p(`    schemaVersion="${TASKREC_XML_SCHEMA_VERSION}"`
    + (model.generatedAt ? ` generatedAt="${escAttr(model.generatedAt)}"` : '')
    + (model.fileName ? ` sourceFile="${escAttr(model.fileName)}"` : '')
    + '>');

  // ── Recording ────────────────────────────────────────────────────────────
  const r = model.recording;
  p(I + open('Recording', {
    name: r.name,
    canonicalId: r.canonical_id,
    version: r.version,
    language: r.language,
    actionCount: model.actionCount,
    screenshotCount: model.screenshotCount,
  }));
  if (r.description) p(I + I + `<Description>${esc(r.description)}</Description>`);
  p(I + '</Recording>');

  // ── FormsVisited ───────────────────────────────────────────────────────────
  p(I + '<FormsVisited>');
  for (const f of model.forms) {
    p(I + I + open('Form', {
      name: f.formName,
      menuLabel: f.menuLabel,
      menuName: f.menuName,
      menuType: f.menuType,
    }, true));
  }
  p(I + '</FormsVisited>');

  // ── Steps ──────────────────────────────────────────────────────────────────
  p(I + '<Steps>');
  for (const s of model.steps) {
    p(I + I + open('Step', {
      number: s.step,
      sequence: s.sequence,
      actionType: s.action_type,
      objectName: s.object_name,
      globalId: s.global_id,
      textsAgree: boolAttr(s.texts_agree),
    }));
    if (s.description) p(I + I + I + `<Description>${esc(s.description)}</Description>`);
    if (s.docx_text) p(I + I + I + `<DocxText>${esc(s.docx_text)}</DocxText>`);
    if (s.target) p(I + I + I + `<Target>${esc(s.target)}</Target>`);
    if (s.control_label || s.control_name || s.control_type) {
      p(I + I + I + open('Control', { label: s.control_label, name: s.control_name, type: s.control_type }, true));
    }
    p(I + I + I + '<Screenshots>');
    for (const shot of s.screenshots) {
      p(I + I + I + I + open('Screenshot', { name: shot.name, mime: shot.mime, contentLocation: shot.content_location }, true));
    }
    p(I + I + I + '</Screenshots>');
    p(I + I + I + '<Security>');
    for (const sec of s.security) p(grantXml(sec, I + I + I + I));
    p(I + I + I + '</Security>');
    p(I + I + '</Step>');
  }
  p(I + '</Steps>');

  // ── BpmSecurity ──────────────────────────────────────────────────────────
  p(I + '<BpmSecurity>');
  p(I + I + '<Objects>');
  for (const o of model.bpmObjects) {
    p(I + I + I + open('Object', { aotName: o.aot_name, type: o.type, label: o.label }));
    for (const sec of o.security) p(grantXml(sec, I + I + I + I));
    p(I + I + I + '</Object>');
  }
  p(I + I + '</Objects>');
  p(I + I + '<Grants>');
  for (const sec of model.roleTuples) p(grantXml(sec, I + I + I));
  p(I + I + '</Grants>');
  p(I + '</BpmSecurity>');

  // ── Technical (KB) ─────────────────────────────────────────────────────────
  p(I + open('Technical', { available: boolAttr(model.kbAvailable) }));
  for (const f of model.enrichedForms) {
    p(I + I + open('Form', { name: f.form_name, found: boolAttr(f.found), label: f.label, module: f.module_id }));
    p(I + I + I + '<RootTables>');
    for (const t of f.root_tables) p(I + I + I + I + open('Table', { name: t }, true));
    p(I + I + I + '</RootTables>');
    p(I + I + I + '<Classes>');
    for (const c of f.classes) {
      p(I + I + I + I + open('Class', { name: c.class_name, edgeType: c.edge_type, methodsTruncated: boolAttr(c.methods_truncated) }));
      for (const m of c.methods) p(I + I + I + I + I + open('Method', { name: m.method_name, signature: m.signature }, true));
      p(I + I + I + I + '</Class>');
    }
    p(I + I + I + '</Classes>');
    p(I + I + I + '<Endpoints>');
    for (const e of f.endpoints) {
      p(I + I + I + I + open('Endpoint', {
        entityName: e.entity_name,
        publicName: e.public_name,
        publicCollection: e.public_collection,
        isPublic: e.is_public == null ? null : String(e.is_public),
        primaryTable: e.primary_table,
      }, true));
    }
    p(I + I + I + '</Endpoints>');
    p(I + I + I + '<Notes>');
    for (const n of f.notes) p(I + I + I + I + `<Note>${esc(n)}</Note>`);
    p(I + I + I + '</Notes>');
    p(I + I + '</Form>');
  }
  p(I + '</Technical>');

  // ── RoleBasedSecurity (Sec) ──────────────────────────────────────────────
  p(I + open('RoleBasedSecurity', { available: boolAttr(model.secAvailable) }));
  for (const role of model.enrichedRoles) {
    p(I + I + open('Role', {
      queried: role.queried,
      found: boolAttr(role.found),
      roleId: role.role_id,
      roleName: role.role_name,
      label: role.label,
      licenseType: role.license_type,
      permissionType: role.permission_type,
      usersIncluded: boolAttr(role.users_included),
      userCount: role.user_count,
      dutiesTruncated: boolAttr(role.duties_truncated),
      privilegesTruncated: boolAttr(role.privileges_truncated),
      usersTruncated: boolAttr(role.users_truncated),
    }));
    p(I + I + I + '<SubRoles>');
    for (const sr of role.sub_roles) {
      p(I + I + I + I + open('SubRole', { name: sr.role_name, transitive: sr.is_transitive == null ? null : String(sr.is_transitive) }, true));
    }
    p(I + I + I + '</SubRoles>');
    p(I + I + I + '<Duties>');
    for (const d of role.duties) {
      p(I + I + I + I + open('Duty', { id: d.duty_id, name: d.duty_name, permissionType: d.permission_type }, true));
    }
    p(I + I + I + '</Duties>');
    p(I + I + I + '<Privileges>');
    for (const pr of role.privileges) p(I + I + I + I + open('Privilege', { name: pr }, true));
    p(I + I + I + '</Privileges>');
    p(I + I + I + '<Users>');
    for (const u of role.users) {
      // PRIVACY: id + name + enabled only — never email.
      p(I + I + I + I + open('User', { id: u.user_id, name: u.person_name, enabled: u.enabled == null ? null : String(u.enabled) }, true));
    }
    p(I + I + I + '</Users>');
    p(I + I + I + '<Notes>');
    for (const n of role.notes) p(I + I + I + I + `<Note>${esc(n)}</Note>`);
    p(I + I + I + '</Notes>');
    p(I + I + '</Role>');
  }
  p(I + '</RoleBasedSecurity>');

  // ── document-level Notes ─────────────────────────────────────────────────
  p(I + '<Notes>');
  for (const n of model.notes) p(I + I + `<Note>${esc(n)}</Note>`);
  p(I + '</Notes>');

  p('</TaskRecordingDocument>');
  return L.join('\n');
}
