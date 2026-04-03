/**
 * D365FO Task Recorder (.axtr) parser
 *
 * Parses a Task Recorder file (ZIP archive containing Recording.xml,
 * recording_resource.xml, and BPMPackage.ax7bpm) and produces a
 * structured Markdown document suitable for LLM consumption.
 *
 * Handles all node types: Scope, CommandUserAction, PropertyUserAction,
 * InfoUserAction, ValidationUserAction, TaskUserAction, MenuItemUserAction,
 * AnnotationUserAction.
 */

import { XMLParser } from 'fast-xml-parser';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const AdmZip = require('adm-zip');

// ── XML parser ──────────────────────────────────────────────────────────────

const ARRAY_TAGS = new Set([
  'Node', 'Annotation', 'KeyValueOfstringFormContextyaScvdpM',
  'CommandArgument', 'step_description',
  'Task', 'Step', 'Security', 'DataSource', 'Connection', 'anyType',
  'Labels',
]);

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  attributeNamePrefix: '@_',
  isArray: (name) => ARRAY_TAGS.has(name),
  trimValues: true,
});

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Safely extract a text value from a parsed XML node. Handles i:nil. */
function val(node, key) {
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

function asArray(v) {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

// ── Recursive tree walker ───────────────────────────────────────────────────

function walkTree(node, depth = 0, parentScopeName = '') {
  const results = [];
  const rawType = node['@_type'] || 'Scope';
  const nodeType = rawType === 'InputUserAction' ? 'PropertyUserAction' : rawType;

  const entry = {
    nodeType,
    sequence: Number(val(node, 'Sequence')) || 0,
    id: val(node, 'Id'),
    description: val(node, 'Description'),
    customDescription: val(node, 'CustomDescription'),
    screenshotUri: val(node, 'ScreenshotUri'),
    depth,
    parentScopeName,
  };

  switch (nodeType) {
    case 'Scope':
      entry.scopeName = val(node, 'Name');
      entry.scopeType = val(node, 'ScopeType');
      entry.isForm = val(node, 'IsForm');
      entry.isStepGroup = val(node, 'IsStepGroup');
      break;

    case 'CommandUserAction':
      entry.formId = val(node, 'FormId');
      entry.controlLabel = val(node, 'ControlLabel');
      entry.controlLabelId = val(node, 'ControlLabelId');
      entry.controlName = val(node, 'ControlName');
      entry.controlType = val(node, 'ControlType');
      entry.commandName = val(node, 'CommandName');
      entry.returnType = val(node, 'ReturnType');
      entry.returnValue = val(node, 'ReturnValue');
      entry.listContext = val(node, 'ListContext');
      entry.rowIndex = val(node, 'RowIndex');
      entry.taskId = val(node, 'TaskId');
      entry.globalId = val(node, 'GlobalId');
      entry.systemGenerated = val(node, 'SystemGenerated');
      entry.labelId = val(node, 'LabelId');
      entry.arguments = [];
      if (node.Arguments?.CommandArgument) {
        for (const a of asArray(node.Arguments.CommandArgument)) {
          entry.arguments.push({ value: val(a, 'Value'), isReference: val(a, 'IsReference') });
        }
      }
      break;

    case 'PropertyUserAction':
      entry.formId = val(node, 'FormId');
      entry.controlLabel = val(node, 'ControlLabel');
      entry.controlLabelId = val(node, 'ControlLabelId');
      entry.controlName = val(node, 'ControlName');
      entry.controlType = val(node, 'ControlType');
      entry.propertyName = val(node, 'PropertyName');
      entry.value = val(node, 'Value');
      entry.valueLabel = val(node, 'ValueLabel');
      entry.userActionType = val(node, 'UserActionType');
      entry.isReference = val(node, 'IsReference');
      entry.globalId = val(node, 'GlobalId');
      entry.systemGenerated = val(node, 'SystemGenerated');
      entry.labelId = val(node, 'LabelId');
      break;

    case 'InfoUserAction':
      entry.formId = val(node, 'FormId');
      entry.controlLabel = val(node, 'ControlLabel');
      entry.controlLabelId = val(node, 'ControlLabelId');
      entry.controlName = val(node, 'ControlName');
      entry.controlType = val(node, 'ControlType');
      entry.text = val(node, 'Text');
      entry.notes = val(node, 'Notes');
      entry.globalId = val(node, 'GlobalId');
      entry.systemGenerated = val(node, 'SystemGenerated');
      entry.labelId = val(node, 'LabelId');
      break;

    case 'ValidationUserAction':
      entry.validationName = val(node, 'Name');
      entry.comment = val(node, 'Comment');
      entry.globalId = val(node, 'GlobalId');
      entry.systemGenerated = val(node, 'SystemGenerated');
      break;

    case 'TaskUserAction':
      entry.taskName = val(node, 'Name');
      entry.taskComment = val(node, 'Comment');
      entry.taskActionType = val(node, 'UserActionType');
      entry.globalId = val(node, 'GlobalId');
      entry.systemGenerated = val(node, 'SystemGenerated');
      break;

    case 'MenuItemUserAction':
      entry.menuItemName = val(node, 'MenuItemName');
      entry.menuItemType = val(node, 'MenuItemType');
      entry.globalId = val(node, 'GlobalId');
      entry.systemGenerated = val(node, 'SystemGenerated');
      break;

    case 'AnnotationUserAction':
      entry.globalId = val(node, 'GlobalId');
      entry.systemGenerated = val(node, 'SystemGenerated');
      break;
  }

  results.push(entry);

  const childScope = nodeType === 'Scope' ? (val(node, 'Name') || parentScopeName) : parentScopeName;
  if (node.Children) {
    for (const child of asArray(node.Children.Node)) {
      if (child && typeof child === 'object') {
        results.push(...walkTree(child, depth + 1, childScope));
      }
    }
  }

  return results;
}

// ── BPM package parser ──────────────────────────────────────────────────────

function parseBpmPackage(bpmBuffer) {
  const processSteps = [];

  try {
    const bpmZip = new AdmZip(bpmBuffer);
    for (const entry of bpmZip.getEntries()) {
      if (!entry.entryName.endsWith('ProcessStep.xml')) continue;

      const xml = bpmZip.readAsText(entry, 'utf8');
      const doc = xmlParser.parse(xml);
      for (const task of asArray(doc?.Activities?.Task)) {
        const dataSources = [];
        if (task.FormDataSource) {
          for (const ds of asArray(task.FormDataSource.DataSource)) {
            const n = typeof ds === 'string' ? ds : (ds?.['#text'] || val(ds, '') || '');
            if (n) dataSources.push(n);
          }
        }
        const security = [];
        if (task.Permissions) {
          for (const s of asArray(task.Permissions.Security)) {
            security.push({
              role: s['@_RoleDisplayName'] || s['@_RoleName'] || '',
              roleName: s['@_RoleName'] || '',
              duty: s['@_DutyDisplayName'] || s['@_DutyName'] || '',
              dutyName: s['@_DutyName'] || '',
              privilege: s['@_PrivilegeDisplayName'] || s['@_PrivilegeName'] || '',
              privName: s['@_PrivilegeName'] || '',
              accessLevel: s['@_AccessLevel'] || '',
            });
          }
        }
        let label = null, help = null;
        if (task.Labels) {
          const firstLabels = asArray(task.Labels)[0];
          const innerLabel = firstLabels?.Label;
          if (innerLabel) {
            const first = Array.isArray(innerLabel) ? innerLabel[0] : innerLabel;
            label = first?.['@_Label'] || null;
            help = first?.['@_help'] || null;
          }
        }
        processSteps.push({
          id: task['@_Id'], aotName: task['@_AOTName'], type: task['@_Type'],
          label, help,
          dataSources, security,
        });
      }
    }
  } catch { /* BPM data is supplementary — parse failures are non-fatal (e.g. corrupt nested ZIP) */ }

  return { processSteps };
}

// ── Markdown generator ──────────────────────────────────────────────────────

function generateMarkdown(rec, forms, formIdToName, allNodes, language, localizedSteps, bpm, fileName) {
  const scopes  = allNodes.filter(n => n.nodeType === 'Scope');
  const actions = allNodes.filter(n => n.nodeType !== 'Scope').sort((a, b) => a.sequence - b.sequence);

  const commands    = actions.filter(n => n.nodeType === 'CommandUserAction');
  const properties  = actions.filter(n => n.nodeType === 'PropertyUserAction');
  const infos       = actions.filter(n => n.nodeType === 'InfoUserAction');
  const validations = actions.filter(n => n.nodeType === 'ValidationUserAction');
  const tasks       = actions.filter(n => n.nodeType === 'TaskUserAction');
  const menuItems   = actions.filter(n => n.nodeType === 'MenuItemUserAction');
  const annotations = actions.filter(n => n.nodeType === 'AnnotationUserAction');

  const recordingName = val(rec, 'Name') || '(unnamed)';
  const recordingDesc = val(rec, 'Description');
  const canonicalId   = val(rec, 'CanonicalId');
  const version       = val(rec, 'Version');

  const L = [];
  const ln = (t = '') => L.push(t);

  // ── Header ──────────────────────────────────────────────────────────────
  ln(`# Task Recording: ${recordingName}`);
  ln();

  // ── Overview ────────────────────────────────────────────────────────────
  ln('## Overview');
  ln();
  ln('| Property | Value |');
  ln('| --- | --- |');
  ln(`| **Recording Name** | ${recordingName} |`);
  ln(`| **Description** | ${recordingDesc || '*(none)*'} |`);
  ln(`| **Canonical ID** | \`${canonicalId}\` |`);
  ln(`| **Version** | ${version} |`);
  if (language) ln(`| **Language** | ${language} |`);
  ln(`| **Total User Actions** | ${actions.length} |`);

  const counts = [];
  if (commands.length)    counts.push(`${commands.length} command`);
  if (properties.length)  counts.push(`${properties.length} data entry`);
  if (infos.length)       counts.push(`${infos.length} info`);
  if (validations.length) counts.push(`${validations.length} validation`);
  if (tasks.length)       counts.push(`${tasks.length} subtask marker`);
  if (menuItems.length)   counts.push(`${menuItems.length} navigation`);
  if (annotations.length) counts.push(`${annotations.length} annotation`);
  if (counts.length) ln(`| **Breakdown** | ${counts.join(', ')} |`);
  ln();

  // ── Forms Visited ───────────────────────────────────────────────────────
  ln('## Forms Visited');
  ln();
  if (forms.length === 0) {
    ln('*(no form contexts recorded)*');
  } else {
    ln('| # | Form (AOT) | Menu Item Label | Menu Item Name | Type |');
    ln('| --- | --- | --- | --- | --- |');
    forms.forEach((f, i) => {
      ln(`| ${i + 1} | \`${f.formName}\` | ${f.menuLabel || '-'} | ${f.menuName ? `\`${f.menuName}\`` : '-'} | ${f.menuType || '-'} |`);
    });
  }
  ln();

  // ── Recorded Steps ──────────────────────────────────────────────────────
  ln('## Recorded Steps');
  ln();
  if (actions.length === 0) {
    ln('*(no user actions recorded)*');
  } else {
    let stepNum = 1;
    for (const a of actions) {
      const sysTag   = a.systemGenerated === 'true' ? ' `[system-generated]`' : '';
      const formName = a.formId ? formIdToName[a.formId] : null;

      let desc = a.description;
      if (a.customDescription) desc = a.customDescription;
      else if (a.globalId && localizedSteps[a.globalId]) desc = localizedSteps[a.globalId];

      ln(`### Step ${stepNum}${sysTag}`);
      ln();

      switch (a.nodeType) {
        case 'CommandUserAction':
          ln(`> **${desc}**`);
          ln();
          ln(`- **Action:** Command (${a.commandName})`);
          ln(`- **Control:** ${a.controlLabel} \`[${a.controlName}]\` (${a.controlType})`);
          if (formName) ln(`- **Form:** **${formName}**`);
          if (a.listContext) ln(`- **List/Grid Context:** ${a.listContext}`);
          if (a.rowIndex) ln(`- **Row Index:** ${a.rowIndex}`);
          if (a.returnType === 'FormContext' && a.returnValue) ln(`- **Opens Form:** ${a.returnValue}`);
          if (a.arguments?.length) {
            ln('- **Arguments:**');
            for (const arg of a.arguments) {
              ln(`  - \`${arg.value}\`${arg.isReference === 'true' ? ' *(reference)*' : ''}`);
            }
          }
          break;

        case 'PropertyUserAction': {
          ln(`> **${desc}**`);
          ln();
          const vDisp = a.valueLabel ? `${a.valueLabel} (\`${a.value}\`)` : `\`${a.value}\``;
          ln('- **Action:** Set value');
          ln(`- **Control:** ${a.controlLabel} \`[${a.controlName}]\` (${a.controlType})`);
          ln(`- **Property:** ${a.propertyName}`);
          ln(`- **Value:** ${vDisp}${a.isReference === 'true' ? ' *(from copied reference)*' : ''}`);
          if (formName) ln(`- **Form:** **${formName}**`);
          break;
        }

        case 'InfoUserAction':
          ln(`> **Info:** ${a.text || desc}`);
          ln();
          ln('- **Action:** Informational note');
          if (a.notes) ln(`- **Notes:** ${a.notes}`);
          if (a.controlLabel) ln(`- **Control:** ${a.controlLabel} \`[${a.controlName}]\``);
          if (formName) ln(`- **Form:** **${formName}**`);
          break;

        case 'ValidationUserAction':
          ln(`> **Validate:** ${desc}`);
          ln();
          ln('- **Action:** Validation assertion');
          if (a.validationName) ln(`- **Validation:** ${a.validationName}`);
          if (a.comment) ln(`- **Comment:** ${a.comment}`);
          break;

        case 'TaskUserAction': {
          const dir = (a.taskActionType === 'Begin' || a.taskActionType === '0') ? 'BEGIN' : 'END';
          ln(`> **Subtask ${dir}: ${a.taskName}**`);
          ln();
          ln(`- **Action:** Subtask marker (${dir})`);
          if (a.taskComment) ln(`- **Comment:** ${a.taskComment}`);
          break;
        }

        case 'MenuItemUserAction':
          ln(`> **Navigate:** ${desc}`);
          ln();
          ln('- **Action:** Open menu item');
          ln(`- **Menu Item:** \`${a.menuItemName}\` (${a.menuItemType})`);
          break;

        case 'AnnotationUserAction':
          ln(`> **${desc}**`);
          ln();
          ln('- **Action:** Annotation edit');
          break;

        default:
          ln(`> **${desc}**`);
          ln();
          ln(`- **Action:** ${a.nodeType}`);
      }

      if (a.screenshotUri) ln(`- **Screenshot:** ${a.screenshotUri}`);
      ln();
      stepNum++;
    }
  }

  // ── Subtask Summary ─────────────────────────────────────────────────────
  if (tasks.length) {
    ln('## Subtasks');
    ln();
    for (const t of tasks.filter(t => t.taskActionType === 'Begin' || t.taskActionType === '0')) {
      ln(`- **${t.taskName}**${t.taskComment ? ` - ${t.taskComment}` : ''}`);
    }
    ln();
  }

  // ── Validation Summary ──────────────────────────────────────────────────
  if (validations.length) {
    ln('## Validations');
    ln();
    for (const v of validations) {
      ln(`- **${v.validationName || v.description}**${v.comment ? ` - ${v.comment}` : ''}`);
    }
    ln();
  }

  // ── Data Entry Summary ──────────────────────────────────────────────────
  if (properties.length) {
    ln('## Data Entry Summary');
    ln();
    ln('| Control | Field (AOT) | Value Entered | Type |');
    ln('| --- | --- | --- | --- |');
    for (const p of properties) {
      const vt = p.valueLabel ? `${p.valueLabel} (${p.value})` : (p.value || '');
      let at = p.userActionType;
      if (at === '0' || at === 'Input') at = 'Input';
      else if (at === '1' || at === 'Output') at = 'Output';
      else if (at === '2' || at === 'Validation') at = 'Validation';
      ln(`| ${p.controlLabel} | \`${p.controlName}\` | \`${vt}\` | ${at} |`);
    }
    ln();
  }

  // ── BPM: Data Sources ──────────────────────────────────────────────────
  const stepsWithDs = bpm.processSteps.filter(ps => ps.dataSources.length > 0);
  if (stepsWithDs.length) {
    ln('## Data Sources (from BPM Package)');
    ln();
    ln('| Form (AOT) | Tables |');
    ln('| --- | --- |');
    for (const ps of stepsWithDs) {
      ln(`| \`${ps.aotName}\` | ${ps.dataSources.map(d => `\`${d}\``).join(', ')} |`);
    }
    ln();
  }

  // ── BPM: Security Roles ────────────────────────────────────────────────
  const allSec = bpm.processSteps.flatMap(ps => ps.security);
  if (allSec.length) {
    ln('## Security Roles (from BPM Package)');
    ln();
    ln('| Role | Duty | Privilege | Access Level |');
    ln('| --- | --- | --- | --- |');
    const seen = new Set();
    for (const s of allSec) {
      const key = `${s.roleName}|${s.dutyName}|${s.privName}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const role = s.role ? `${s.role} (\`${s.roleName}\`)` : `\`${s.roleName}\``;
      const duty = s.duty ? `${s.duty} (\`${s.dutyName}\`)` : `\`${s.dutyName}\``;
      const priv = s.privilege ? `${s.privilege} (\`${s.privName}\`)` : `\`${s.privName}\``;
      ln(`| ${role} | ${duty} | ${priv} | ${s.accessLevel} |`);
    }
    ln();
  }

  // ── Navigation Flow ────────────────────────────────────────────────────
  const formScopes = scopes
    .filter(s => s.isForm === 'true' && s.scopeType === 'Public')
    .sort((a, b) => a.sequence - b.sequence);
  const flowNames = [];
  for (const fs of formScopes) {
    if (!flowNames.length || flowNames[flowNames.length - 1] !== fs.scopeName) {
      flowNames.push(fs.scopeName);
    }
  }
  if (flowNames.length > 1) {
    ln('## Navigation Flow');
    ln();
    ln(flowNames.map(n => `**${n}**`).join(' -> '));
    ln();
  }

  // ── Scope Tree ─────────────────────────────────────────────────────────
  ln('## Scope Tree');
  ln();
  ln('```');
  for (const n of allNodes) {
    const pad = '  '.repeat(n.depth);
    switch (n.nodeType) {
      case 'Scope': {
        const tags = [
          n.isForm === 'true' ? ' [Form]' : '',
          n.isStepGroup === 'true' ? ' [StepGroup]' : '',
          n.scopeType && n.scopeType !== 'Public' ? ` (${n.scopeType})` : '',
        ].join('');
        ln(`${pad}[${n.scopeName}]${tags}`);
        break;
      }
      case 'CommandUserAction':
        ln(`${pad}> ${n.commandName} on ${n.controlLabel} [${n.controlName}]`);
        break;
      case 'PropertyUserAction':
        ln(`${pad}> Set ${n.controlLabel} = ${n.valueLabel || n.value}`);
        break;
      case 'InfoUserAction':
        ln(`${pad}> Info: ${n.text || n.description}`);
        break;
      case 'ValidationUserAction':
        ln(`${pad}> Validate: ${n.validationName}`);
        break;
      case 'TaskUserAction': {
        const d = (n.taskActionType === 'Begin' || n.taskActionType === '0') ? 'BEGIN' : 'END';
        ln(`${pad}> Subtask ${d}: ${n.taskName}`);
        break;
      }
      case 'MenuItemUserAction':
        ln(`${pad}> Navigate: ${n.menuItemName}`);
        break;
      default:
        ln(`${pad}> ${n.nodeType}: ${n.description}`);
    }
  }
  ln('```');
  ln();

  // ── Footer ─────────────────────────────────────────────────────────────
  ln('---');
  ln(`*Generated from \`${fileName}\` on ${new Date().toISOString().slice(0, 16).replace('T', ' ')}*`);

  return L.join('\n');
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Parse a D365FO Task Recorder (.axtr) file and return a Markdown document.
 *
 * @param {Buffer} buffer  - Raw .axtr file contents
 * @param {string} [fileName='recording.axtr'] - Original filename (used in footer)
 * @returns {string} Markdown text
 */
export function parseTaskRecording(buffer, fileName = 'recording.axtr') {
  const zip = new AdmZip(buffer);
  const entryMap = {};
  for (const entry of zip.getEntries()) {
    entryMap[entry.entryName] = entry;
  }

  if (!entryMap['Recording.xml']) {
    throw new Error('Recording.xml not found inside the archive. This is not a valid .axtr file.');
  }

  // ── Recording.xml ─────────────────────────────────────────────────────
  const recXml = zip.readAsText(entryMap['Recording.xml'], 'utf8');
  const rec = xmlParser.parse(recXml).Recording;

  // ── recording_resource.xml (optional) ─────────────────────────────────
  let language = null;
  const localizedSteps = {};
  if (entryMap['recording_resource.xml']) {
    try {
      const resXml = zip.readAsText(entryMap['recording_resource.xml'], 'utf8');
      const res = xmlParser.parse(resXml);
      language = res.xsd?.['@_lang'] || null;
      for (const step of asArray(res.xsd?.step_description)) {
        const locId = step?.['@__locId'];
        if (locId) {
          const m = locId.match(/^(.+)\/StepDescription$/);
          if (m) localizedSteps[m[1]] = step['#text'] || '';
        }
      }
    } catch { /* recording_resource.xml is optional — localized strings are a nice-to-have */ }
  }

  // ── BPMPackage.ax7bpm (optional, nested ZIP) ─────────────────────────
  let bpm = { processSteps: [] };
  if (entryMap['BPMPackage.ax7bpm']) {
    bpm = parseBpmPackage(entryMap['BPMPackage.ax7bpm'].getData());
  }

  // ── Form contexts ─────────────────────────────────────────────────────
  const forms = [];
  const formIdToName = {};
  if (rec.FormContexts) {
    for (const kv of asArray(rec.FormContexts.KeyValueOfstringFormContextyaScvdpM)) {
      const v = kv?.Value;
      if (!v) continue;
      const formId   = val(v, 'FormID');
      const formName = val(v, 'FormName');
      let menuLabel = null, menuName = null, menuType = null;

      if (v.Annotations) {
        for (const ann of asArray(v.Annotations.Annotation)) {
          menuLabel = val(ann, 'MenuItemLabel') || menuLabel;
          menuName  = val(ann, 'MenuItemName')  || menuName;
          menuType  = val(ann, 'MenuItemType')  || menuType;
        }
      }

      if (formId) formIdToName[formId] = formName;
      forms.push({ formId, formName, menuLabel, menuName, menuType });
    }
  }

  // ── Walk the node tree ────────────────────────────────────────────────
  if (!rec.RootScope) {
    throw new Error('RootScope not found in Recording.xml. The file may be corrupt or not a valid task recording.');
  }
  const allNodes = walkTree(rec.RootScope);

  // ── Generate Markdown ─────────────────────────────────────────────────
  return generateMarkdown(rec, forms, formIdToName, allNodes, language, localizedSteps, bpm, fileName);
}
