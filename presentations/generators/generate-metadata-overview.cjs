/**
 * D365 F&O MCP Services — Metadata Overview (very high level)
 *
 * Why metadata · what is implemented in D365 KB, D365 XRef and Labels · how
 * the plugin skills shape response quality · what decides the token bill ·
 * how the services are implemented and kept fresh.
 *
 * Same template, palette and helpers as generate-technical-deep-dive.cjs so
 * both decks read as one series. Facts are the measured ones from CLAUDE.md
 * (dates quoted where a number was measured on a specific day).
 *
 *   node presentations/generators/generate-metadata-overview.cjs
 */
const AdmZip = require('adm-zip');
const path = require('path');

const TEMPLATE = path.resolve(__dirname, '..', 'templates', 'trelleborg template.pptx');
const OUTPUT   = path.resolve(__dirname, '..', 'D365FO_MCP_Metadata_Overview.pptx');

const IN = v => Math.round(v * 914400);

const C = {
  black:    '000000', white:   'FFFFFF',
  dk:       '333333', lt:      'CCCCCC',
  gray:     '666666', teal:    '6DC1C9',
  gold:     'AD9B68', brown:   'B77133',
  slate:    '647772', brick:   '813341',
  bgPanel:  'F5F5F5', tealLt:  'E0F3F5',
  greenOk:  '2E7D32', redNo:   'C62828',
  greenBg:  'E8F5E9', redBg:   'FFEBEE',
  codeBg:   '2D2D2D', goldLt:  'F3EEE1', brickLt: 'F2E6E8', slateLt: 'E9ECEB',
};

// ── XML helpers (identical to the deep-dive generator) ──────────────
let nextId = 100;
function id() { return nextId++; }
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function run(text, opts = {}) {
  const sz = opts.sz || 1100, color = opts.color || C.dk, font = opts.font || 'Arial';
  const bold = opts.bold ? ' b="1"' : '', italic = opts.italic ? ' i="1"' : '';
  return `<a:r><a:rPr lang="en-US" sz="${sz}"${bold}${italic} dirty="0"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:latin typeface="${esc(font)}"/><a:cs typeface="${esc(font)}"/></a:rPr><a:t>${esc(text)}</a:t></a:r>`;
}
function para(runs, opts = {}) {
  const algn = opts.algn ? ` algn="${opts.algn}"` : '';
  const spcBef = opts.spcBef ? `<a:spcBef><a:spcPts val="${opts.spcBef}"/></a:spcBef>` : '';
  const spcAft = opts.spcAft ? `<a:spcAft><a:spcPts val="${opts.spcAft}"/></a:spcAft>` : '';
  const lnSpc = opts.lnSpc ? `<a:lnSpc><a:spcPct val="${opts.lnSpc}"/></a:lnSpc>` : '';
  const bullet = opts.bullet ? '<a:buChar char="•"/>' : (opts.noBullet ? '<a:buNone/>' : '');
  const indent = opts.indent ? ` indent="${opts.indent}" marL="${opts.marL || 0}"` : '';
  return `<a:p><a:pPr${algn}${indent}>${spcBef}${spcAft}${lnSpc}${bullet}</a:pPr>${typeof runs === 'string' ? runs : runs.join('')}<a:endParaRPr lang="en-US" dirty="0"/></a:p>`;
}
function textBox(x, y, w, h, paragraphs, opts = {}) {
  const anchor = opts.anchor || 't', wrap = opts.wrap !== false ? 'square' : 'none';
  const lnXml = opts.line ? `<a:ln w="${opts.lineW || 12700}"><a:solidFill><a:srgbClr val="${opts.line}"/></a:solidFill></a:ln>` : '<a:ln><a:noFill/></a:ln>';
  const fillXml = opts.fill ? `<a:solidFill><a:srgbClr val="${opts.fill}"/></a:solidFill>` : '<a:noFill/>';
  const rr = opts.rounding ? `<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val ${opts.rounding}"/></a:avLst></a:prstGeom>` : '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>';
  const margins = `lIns="${opts.lIns || 91440}" tIns="${opts.tIns || 45720}" rIns="${opts.rIns || 91440}" bIns="${opts.bIns || 45720}"`;
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id()}" name="TextBox ${nextId}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${IN(x)}" y="${IN(y)}"/><a:ext cx="${IN(w)}" cy="${IN(h)}"/></a:xfrm>${rr}${fillXml}${lnXml}</p:spPr><p:txBody><a:bodyPr wrap="${wrap}" anchor="${anchor}" ${margins}/><a:lstStyle/>${paragraphs.join('')}</p:txBody></p:sp>`;
}
function lineShape(x, y, w, color, width) {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id()}" name="Line ${nextId}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${IN(x)}" y="${IN(y)}"/><a:ext cx="${IN(w)}" cy="0"/></a:xfrm><a:prstGeom prst="line"><a:avLst/></a:prstGeom><a:ln w="${width || 12700}"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></a:ln></p:spPr></p:sp>`;
}
function rect(x, y, w, h, fill, opts = {}) {
  const lineXml = opts.line ? `<a:ln w="${opts.lineW || 12700}"><a:solidFill><a:srgbClr val="${opts.line}"/></a:solidFill></a:ln>` : '<a:ln><a:noFill/></a:ln>';
  const rr = opts.rounding ? `<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val ${opts.rounding}"/></a:avLst></a:prstGeom>` : '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>';
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id()}" name="Rect ${nextId}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${IN(x)}" y="${IN(y)}"/><a:ext cx="${IN(w)}" cy="${IN(h)}"/></a:xfrm>${rr}<a:solidFill><a:srgbClr val="${fill}"/></a:solidFill>${lineXml}</p:spPr></p:sp>`;
}
function placeholder(type, idx, paragraphs) {
  const phAttr = type === 'title' ? 'type="title"' : `idx="${idx}"`;
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id()}" name="PH ${nextId}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph ${phAttr}/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${paragraphs.join('')}</p:txBody></p:sp>`;
}
function slideXml(shapes) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${shapes.join('')}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}
function slideRels(layoutNum) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout${layoutNum}.xml"/></Relationships>`;
}
function contentSlide(title, shapes) {
  return { layout: 13, xml: slideXml([placeholder('title', 0, [para(run(title, { sz: 1800, bold: true, color: C.black }))]), ...shapes]) };
}

// ── composition helpers for this deck ───────────────────────────────
const LEFT = 0.59, WIDTH = 12.15;
function subtitle(text) {
  return textBox(LEFT, 1.28, WIDTH, 0.42, [para(run(text, { sz: 900, italic: true, color: C.gray }), { lnSpc: 105000 })]);
}
/** Header bar + body panel with bullet lines. `lines` = strings or [bold, rest]. */
function panel(x, y, w, h, color, title, lines, opts = {}) {
  const sz = opts.sz || 800, headH = 0.36, lightFill = opts.fill || C.white;
  const body = lines.map(l => {
    const runs = Array.isArray(l) ? [run(l[0], { sz, bold: true, color }), run(l[1], { sz, color: C.dk })] : [run(l, { sz, color: C.dk })];
    return para(runs, { bullet: true, indent: -114300, marL: 114300, spcBef: 300, lnSpc: 112000 });
  });
  return [
    rect(x, y, w, headH, color, { rounding: 4000 }),
    textBox(x, y, w, headH, [para(run(title, { sz: 950, bold: true, color: C.white }))], { anchor: 'ctr' }),
    rect(x, y + headH, w, h - headH, lightFill, { line: color, lineW: 6350 }),
    textBox(x + 0.05, y + headH + 0.04, w - 0.1, h - headH - 0.08, body),
  ];
}
/** A single headline number with a caption underneath. */
function figure(x, y, w, value, caption, color) {
  return [
    textBox(x, y, w, 0.42, [para(run(value, { sz: 1800, bold: true, color }), { algn: 'ctr' })], { anchor: 'ctr' }),
    textBox(x, y + 0.42, w, 0.58, [para(run(caption, { sz: 750, color: C.gray }), { algn: 'ctr', lnSpc: 108000 })]),
  ];
}
/** Numbered step row (agenda / summary style). */
function numberedRows(items, y0, step, opts = {}) {
  return items.flatMap((item, i) => {
    const y = y0 + i * step;
    return [
      textBox(LEFT, y, 0.7, 0.40, [para(run(String(i + 1).padStart(2, '0'), { sz: 1600, bold: true, color: C.teal }), { algn: 'r' })]),
      textBox(1.45, y, 11.2, 0.24, [para(run(item[0], { sz: 1100, bold: true, color: C.black }))]),
      textBox(1.45, y + 0.24, 11.2, opts.descH || 0.22, [para(run(item[1], { sz: 800, color: C.gray }))]),
      ...(i < items.length - 1 ? [lineShape(LEFT, y + step - 0.07, 11.8, C.lt, 6350)] : []),
    ];
  });
}
function chevron(x, y, w, h, fill, title, sub, textColor = C.white) {
  return [
    `<p:sp><p:nvSpPr><p:cNvPr id="${id()}" name="Chevron ${nextId}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${IN(x)}" y="${IN(y)}"/><a:ext cx="${IN(w)}" cy="${IN(h)}"/></a:xfrm><a:prstGeom prst="homePlate"><a:avLst><a:gd name="adj" fmla="val 30000"/></a:avLst></a:prstGeom><a:solidFill><a:srgbClr val="${fill}"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr></p:sp>`,
    textBox(x + 0.05, y, w - 0.25, h, [
      para(run(title, { sz: 850, bold: true, color: textColor }), { algn: 'ctr' }),
      ...(sub ? [para(run(sub, { sz: 700, color: textColor }), { algn: 'ctr' })] : []),
    ], { anchor: 'ctr', lIns: 45720, rIns: 45720 }),
  ];
}

const slides = [];

// ═══════════════════════════════════════════════════════════════════
// 1 · Title
// ═══════════════════════════════════════════════════════════════════
slides.push({
  layout: 2,
  xml: slideXml([
    placeholder('title', 0, [para(run('D365 F&O MCP Services', { sz: 3100, color: C.white }))]),
    placeholder('body', 13, [para(run('Metadata as ground truth for AI-assisted D365 work', { sz: 1800, bold: true, color: C.white }))]),
    placeholder('body', 14, [para(run('Why metadata · what KB, XRef and Labels hold · skills and response quality · token awareness · how it is built and kept fresh', { sz: 1300, color: C.white }))]),
  ]),
});

// ═══════════════════════════════════════════════════════════════════
// 2 · Agenda
// ═══════════════════════════════════════════════════════════════════
slides.push(contentSlide('Agenda', numberedRows([
  ['Why metadata', 'An AI assistant that can look up the real object model stops guessing table, field and label names'],
  ['What is implemented', 'D365 KB (the object model), D365 XRef (who uses what), Labels (every text in every language) — plus Security and Task Recorder'],
  ['Skills and response quality', 'The plugin skills encode the working method: which tool first, what to verify before asserting, what to say when coverage ends'],
  ['Token awareness', 'The tool list is paid on every request; response shape, channels and guardrails decide the rest — all of it measured'],
  ['How the services are implemented', 'AOT metadata → SQLite snapshots → one shared tool code base → local stdio or Azure Functions with Entra sign-in'],
  ['How they are kept fresh', 'Per-compile deltas within minutes, a weekly full rebuild for correctness, the snapshot date on every answer'],
], 1.30, 0.78, { descH: 0.40 })));

// ═══════════════════════════════════════════════════════════════════
// 3 · Why metadata
// ═══════════════════════════════════════════════════════════════════
slides.push(contentSlide('Why metadata', [
  subtitle('A language model knows D365 F&O in general. Our system knows it in particular: the application object tree (AOT) as built on our own environment is the reference the answers are checked against.'),

  textBox(LEFT, 1.72, 5.9, 0.30, [para(run('Without ground truth', { sz: 950, bold: true, color: C.brick }))]),
  rect(LEFT, 2.05, 5.9, 2.15, C.redBg, { rounding: 4000 }),
  textBox(LEFT + 0.1, 2.10, 5.7, 2.05, [
    ['Plausible but wrong names. ', 'A table or field that sounds right (or existed in AX 2012) and does not exist here.'],
    ['Enum values and relations invented. ', 'Answers about joins, status values or lifecycle states cannot be trusted without a developer re-checking each one.'],
    ['Security answers nobody can verify. ', '"Which role grants this?" needs the role → duty → privilege → entry-point chain, not a guess.'],
    ['Every answer costs a second person. ', 'The developer who checks the AI’s answer does the work the AI was meant to save.'],
  ].map(l => para([run(l[0], { sz: 850, bold: true, color: C.brick }), run(l[1], { sz: 850, color: C.dk })], { bullet: true, indent: -114300, marL: 114300, spcBef: 400, lnSpc: 112000 }))),

  textBox(6.84, 1.72, 5.9, 0.30, [para(run('With the AOT as ground truth', { sz: 950, bold: true, color: C.greenOk }))]),
  rect(6.84, 2.05, 5.9, 2.15, C.greenBg, { rounding: 4000 }),
  textBox(6.94, 2.10, 5.7, 2.05, [
    ['Verified before asserted. ', 'Object names, fields, enum values, labels and permissions are looked up in a snapshot of this environment.'],
    ['The answer states its limits. ', 'Snapshot date on every response; explicit lines for what the response does not cover (fields cut, ISV not scanned, partial build).'],
    ['Reproducible. ', 'The same question against the same snapshot yields the same facts — the basis for tracing and for comparing ERPs.'],
    ['Custom and vendor code included. ', 'Our own models, the sealed ISV models and the UI custom fields are all covered, each with its provenance.'],
  ].map(l => para([run(l[0], { sz: 850, bold: true, color: C.greenOk }), run(l[1], { sz: 850, color: C.dk })], { bullet: true, indent: -114300, marL: 114300, spcBef: 400, lnSpc: 112000 }))),

  textBox(LEFT, 4.45, WIDTH, 0.30, [para(run('Three principles every service follows', { sz: 950, bold: true, color: C.teal }))]),
  ...[
    ['Snapshot, not live', 'The services read a build of the metadata, never the running system. Fast, cheap, safe — and dated. The one exception (UI custom fields) is marked as live.', C.teal],
    ['Verify before you assert', 'A name is checked with a batch existence call before it appears in an answer; X++ changes go through a preflight (exists, signature, extension points, name collisions).', C.gold],
    ['Say what you do not know', 'A zero-row result is data, a missing object is "not found" with suggestions, and every list says whether it was cut and how to continue.', C.brick],
  ].flatMap((p, i) => {
    const x = LEFT + i * 4.1;
    return [
      rect(x, 4.80, 3.95, 1.35, C.white, { line: p[2], lineW: 9525, rounding: 4000 }),
      textBox(x + 0.08, 4.84, 3.8, 0.3, [para(run(p[0], { sz: 900, bold: true, color: p[2] }))]),
      textBox(x + 0.08, 5.12, 3.8, 1.0, [para(run(p[1], { sz: 780, color: C.dk }), { lnSpc: 112000 })]),
    ];
  }),
]));

// ═══════════════════════════════════════════════════════════════════
// 4 · What is implemented — the five services
// ═══════════════════════════════════════════════════════════════════
slides.push(contentSlide('What is implemented: five services, 75 tools', [
  subtitle('Three services carry the metadata this deck is about (KB, XRef, Labels); Security and Task Recorder complete the platform. All read a local snapshot except one live tool.'),

  ...panel(LEFT, 1.72, 3.95, 2.55, C.teal, 'D365 KB — the object model · 32 tools', [
    ['Objects: ', 'tables, fields, EDTs, enums, data entities, classes and methods, forms and their control trees, queries, reports, menus, security policies'],
    ['Source: ', 'the AOT XML of every model on the build box (Microsoft, ISV, custom) → ~1 GB SQLite'],
    ['Plus: ', 'sealed-ISV metadata (elements, extension points, method signatures), the effective schema of a table, a curated X++ rulebook'],
    ['One live tool: ', 'UI custom fields, read from the environment’s OData metadata'],
  ]),
  ...panel(4.69, 1.72, 3.95, 2.55, C.gold, 'D365 XRef — who uses what · 18 tools', [
    ['Graph: ', 'references to and from any object, method callers, field usages, extensions and event handlers, class hierarchies, module dependencies'],
    ['Source: ', 'the compiler cross-reference database of the dev box → 6.2 M names, 28 M references, 3.3 GB'],
    ['Includes: ', 'our compiled custom models (iExtension, HISOL) and 199 k references from sealed ISV models that the compiler never saw'],
    ['Use: ', 'impact analysis before a change; "does this exist" in batches of 50'],
  ]),
  ...panel(8.79, 1.72, 3.95, 2.55, C.brick, 'Labels — every text, every language · 4 tools', [
    ['Content: ', '390 k label ids × 75 languages = 26 M rows, each id paired with its developer description (what the text is for)'],
    ['Lookup: ', 'id → all languages; text → ids (full-text search, any language)'],
    ['Where used: ', 'which objects carry a label, and which labels one object carries — answered from the XRef snapshot'],
    ['Why: ', 'UI strings in tickets map back to the form, field or menu item they belong to'],
  ]),

  ...panel(LEFT, 4.45, 6.0, 1.75, C.slate, 'D365 Security · 19 tools', [
    ['Chain: ', 'role → sub-role → duty → privilege → entry point, Deny wins; "can user X do Y", "who reaches Y", role comparison, licence assessment'],
    ['Source: ', 'AOT security objects plus a DMF export of the live role assignments'],
  ], { sz: 780 }),
  ...panel(6.74, 4.45, 6.0, 1.75, C.slate, 'Task Recorder · 2 tools', [
    ['Input: ', 'a task recording (.axtr) from the client, optionally with screenshots'],
    ['Output: ', 'a step list, or a full document enriched from KB and Security — what each step touched and who may perform it'],
  ], { sz: 780 }),
]));

// ═══════════════════════════════════════════════════════════════════
// 5 · KB and XRef: how a question becomes verified facts
// ═══════════════════════════════════════════════════════════════════
slides.push(contentSlide('D365 KB and D365 XRef: from a question to verified facts', [
  subtitle('Tool names follow one grammar across all services, so the assistant (and the reader of a trace) knows what a call returns before it is made.'),

  textBox(LEFT, 1.72, 5.9, 0.30, [para(run('The tool grammar', { sz: 950, bold: true, color: C.teal }))]),
  ...[
    ['lookup_*', 'one object in full (table with fields, indexes, relations; form with its control tree)'],
    ['get_*', 'one aspect of an object (enum values, join keys, class methods, one method’s source)'],
    ['find_* / list_*', 'a list, always with a limit and a cursor to continue'],
    ['check_* / preflight', 'boolean answers in batches — does it exist, what does the method take, who already extends it'],
    ['search / resolve_*', 'ranked text search across objects and label texts; id → text'],
    ['isv_* / effective_schema', 'what a sealed vendor model declares; the base table merged with every extension'],
  ].flatMap((r, i) => {
    const y = 2.05 + i * 0.42;
    return [
      rect(LEFT, y, 1.9, 0.36, i % 2 ? C.white : C.tealLt, { rounding: 3000 }),
      textBox(LEFT, y, 1.9, 0.36, [para(run(r[0], { sz: 800, bold: true, color: C.teal, font: 'Consolas' }))], { anchor: 'ctr' }),
      textBox(2.55, y, 3.95, 0.36, [para(run(r[1], { sz: 780, color: C.dk }))], { anchor: 'ctr' }),
    ];
  }),

  textBox(6.84, 1.72, 5.9, 0.30, [para(run('What every answer carries', { sz: 950, bold: true, color: C.gold }))]),
  rect(6.84, 2.05, 5.9, 2.5, C.bgPanel, { rounding: 4000 }),
  textBox(6.94, 2.10, 5.7, 2.4, [
    ['A heading and the snapshot date. ', '"KB snapshot: 2026-09-01" on the line after the title — the reader knows how old the facts are.'],
    ['Coverage lines. ', 'What the response does NOT cover: fields cut by a limit, ISV models not scanned, a partial build after a delta.'],
    ['Typed data and a text view. ', 'The same payload as JSON for the client and as a compact table for a human; the smaller text encoding is chosen per response.'],
    ['Labels resolved. ', 'No raw @SYS12345 ids leak; label text is resolved in the requested language.'],
    ['Not-found with suggestions. ', 'A miss returns near-miss names instead of an empty page, so the next call is the right one.'],
  ].map(l => para([run(l[0], { sz: 820, bold: true, color: C.gold }), run(l[1], { sz: 820, color: C.dk })], { bullet: true, indent: -114300, marL: 114300, spcBef: 350, lnSpc: 112000 }))),

  textBox(LEFT, 4.80, WIDTH, 0.30, [para(run('A typical investigation, in calls', { sz: 950, bold: true, color: C.brick }))]),
  ...chevron(LEFT, 5.15, 2.45, 0.62, C.teal, 'xref_check_exists', 'the names in the question are real'),
  ...chevron(3.05, 5.15, 2.45, 0.62, C.teal, 'd365_lookup_table', 'fields, relations, extensions'),
  ...chevron(5.51, 5.15, 2.45, 0.62, C.gold, 'xref_find_references', 'who reads and writes it'),
  ...chevron(7.97, 5.15, 2.45, 0.62, C.brick, 'labels_where_used', 'the UI text points to the form'),
  ...chevron(10.43, 5.15, 2.31, 0.62, C.slate, 'sec_object_access', 'who may reach it'),
]));

// ═══════════════════════════════════════════════════════════════════
// 6 · Skills and response quality
// ═══════════════════════════════════════════════════════════════════
slides.push(contentSlide('Skills: the method that turns tools into good answers', [
  subtitle('The tools provide facts. The Claude Code plugin (20 commands, 8 skills) provides the working method — the same discipline a senior developer applies, written down once and loaded per task.'),

  ...panel(LEFT, 1.72, 3.95, 3.0, C.teal, 'Which tool first', [
    ['Known object → ', 'lookup it; unknown → search, then lookup'],
    ['Before asserting a field ', 'check_field_exists; before X++ preflight'],
    ['Security: ', 'check_exists for names, then the effective-permission chain, then a trace to verify'],
    ['Labels: ', 'lookup for an id, search for a UI string, where-used before changing one'],
    ['Counts before lists: ', 'object_summary before find_references with a big limit'],
  ], { sz: 800 }),
  ...panel(4.69, 1.72, 3.95, 3.0, C.gold, 'What a skill adds to the answer', [
    ['Verification steps ', 'the tool cannot enforce: walk the role → duty → privilege chain, confirm the mapping before stating it'],
    ['Functional context ', 'passed with the call, so a miss can be recovered from vocabulary (vendor → VendTable)'],
    ['Reading coverage lines ', 'and acting on them: continue a cursor, widen a filter, name the gap in the answer'],
    ['Document shapes ', 'for a scoping note, a functional analysis, a code review — maturity-tagged facts'],
  ], { sz: 800 }),
  ...panel(8.79, 1.72, 3.95, 3.0, C.brick, 'What we measured', [
    ['Evals measure discipline, ', 'not tool choice: does the answer name objects that exist, does it say what it did not check'],
    ['The first external user ', 'reported about 70 % fewer tokens per task with the skills (anecdotal, one colleague)'],
    ['Skill text has a price: ', 'a 23 KB skill costs more than the data it fetches — recipes stay small, references load on demand'],
    ['Tracing ', 'records the request, the strategy lines and every call, so quality is reviewable afterwards'],
  ], { sz: 800 }),

  rect(LEFT, 4.95, WIDTH, 1.25, C.bgPanel, { rounding: 4000 }),
  textBox(LEFT + 0.12, 5.0, WIDTH - 0.24, 1.15, [
    para(run('Why this matters more than the tools', { sz: 950, bold: true, color: C.dk })),
    para(run('Two sessions with the same 75 tools produce very different answers. The one that checks names before using them, reads the snapshot date, passes the functional context and stops at the coverage line gives a verifiable answer at a third of the cost. The skills make that the default path rather than the exception.', { sz: 850, color: C.dk }), { spcBef: 300, lnSpc: 115000 }),
  ]),
]));

// ═══════════════════════════════════════════════════════════════════
// 7 · Token awareness
// ═══════════════════════════════════════════════════════════════════
slides.push(contentSlide('Token awareness: what decides the bill', [
  subtitle('Every number below was measured off the wire (2026-08/09). Context is a running meter: everything in it is paid again on every later turn — about $0.10 per turn at 200 k tokens before any work is done.'),

  ...figure(LEFT, 1.75, 2.9, '~39 k tokens', 'the tool list of 63 tools, re-sent on every request; 56 % of it is output schema', C.brick),
  ...figure(3.65, 1.75, 2.9, '−54 %', 'with the "core" profile: 25 hand-picked tools instead of 63, chosen per request', C.teal),
  ...figure(6.7, 1.75, 2.9, '1.3–2×', 'every response ships twice (text + JSON); Claude Code reads only the JSON, so the text is switched off for it', C.gold),
  ...figure(9.75, 1.75, 2.9, '8× smaller', 'an entity summary at 1.1 KB instead of the 8.3 KB field list — the default is the small shape', C.slate),

  ...panel(LEFT, 2.85, 5.95, 3.35, C.brick, 'Fixed cost: the tool list', [
    ['Cannot be filtered away: ', 'name, description, annotations and both schemas of every tool travel with each request'],
    ['Levers that worked: ', 'shorter descriptions, nullable → optional keys, no "$schema" on the wire, one shared parameter text (−15 %)'],
    ['Levers that did not: ', '$ref schemas break the client validator; pre-built JSON schema is ignored by the SDK'],
    ['Guarded: ', 'a budget test captures the real tools/list message and fails on any silent growth'],
  ], { sz: 800 }),
  ...panel(6.79, 2.85, 5.95, 3.35, C.teal, 'Variable cost: the responses', [
    ['Shape first: ', 'limit, fields_like, custom_only, sections, summary — two tools were 82 % of a task’s bill before shaping'],
    ['Encoding per response: ', 'TOON or Markdown, whichever is smaller for that payload; adaptive beat both'],
    ['Pagination and batching: ', 'a cursor continues a list without re-paying its head; a batch hoists what its entries repeat'],
    ['Guardrails: ', 'three identical calls in a row return a note instead of a 12 k-token dump; one staleness note per process'],
    ['Dead keys omitted, ', 'but never ragged rows: a missing key on some rows costs +107 % in the text channel'],
  ], { sz: 800 }),
]));

// ═══════════════════════════════════════════════════════════════════
// 8 · How the services are implemented
// ═══════════════════════════════════════════════════════════════════
slides.push(contentSlide('How the services are implemented', [
  subtitle('One code base for the tools; two ways to reach it. Node.js 20, SQLite read-only, MCP protocol; response contract enforced by static-scan tests in a suite of 1,800+ tests.'),

  textBox(LEFT, 1.72, WIDTH, 0.30, [para(run('From metadata to an answer', { sz: 950, bold: true, color: C.teal }))]),
  ...chevron(LEFT, 2.05, 2.5, 0.85, C.brick, 'Sources on the dev box', 'AOT XML · compiler XRef DB · label files · sealed ISV stores'),
  ...chevron(3.1, 2.05, 2.5, 0.85, C.gold, 'Builders', 'build:kb · build:xref · build:labels · isv-scan'),
  ...chevron(5.61, 2.05, 2.5, 0.85, C.teal, 'SQLite snapshots', 'KB 1 GB · XRef 3.3 GB · Labels 5 GB · Sec 60 MB'),
  ...chevron(8.12, 2.05, 2.5, 0.85, C.slate, 'Shared tool code', '75 tools, one implementation for local and Azure'),
  ...chevron(10.63, 2.05, 2.11, 0.85, C.dk, 'Client', 'Claude Code · claude.ai connectors'),

  ...panel(LEFT, 3.15, 5.95, 3.05, C.teal, 'Local: stdio servers on the developer machine', [
    ['Started by Claude Code ', 'from ~/.claude.json; read the snapshots on disk, no network'],
    ['Same tool code ', 'as Azure — only transport and database opening differ'],
    ['Tracing on by default: ', 'every call is recorded as a replayable record (tool + arguments, never the response)'],
    ['Refreshed by the compile hook ', 'within minutes of a successful build (next slide)'],
  ], { sz: 800 }),
  ...panel(6.79, 3.15, 5.95, 3.05, C.gold, 'Azure: Functions app with Entra sign-in', [
    ['Five HTTP endpoints ', '(MCP Streamable HTTP) on one Function App, snapshots uploaded next to the code'],
    ['Sign-in with the company account: ', 'Easy Auth plus an in-repo OAuth proxy that fixes the two Entra incompatibilities MCP clients hit'],
    ['Served to claude.ai as connectors, ', 'so the same tools work in chat without a local setup'],
    ['Self-healing indexes and freshness banner ', 'so a code deploy alone brings an older snapshot up to date'],
  ], { sz: 800 }),
]));

// ═══════════════════════════════════════════════════════════════════
// 9 · How they are kept fresh
// ═══════════════════════════════════════════════════════════════════
slides.push(contentSlide('How the snapshots are kept fresh', [
  subtitle('Full rebuilds take 10–60 minutes and were never viable per compile. One custom model is 0.9 % of the names and 0.3 % of the references — so a delta is, and the weekly full rebuild keeps the deltas honest.'),

  ...[
    ['Every successful compile', 'minutes', C.teal, [
      'An MSBuild hook in the projects folder fires after Build or Rebuild succeeds',
      'Refresh-McpData.ps1 runs detached: XRef delta 1 m 43 s, KB delta 11 s, ~15 s when nothing changed',
      'Ids stay stable, orphan check inside the transaction — a stale graph is recoverable, a corrupt one is not',
    ]],
    ['Every week', 'correctness', C.gold, [
      'Full KB + XRef (+ Labels, ISV) rebuild, then Deploy.ps1 uploads the snapshots to Azure',
      'Not optional: deltas are additive and never delete, so a removed object lingers until the rebuild',
      'Sealed ISV models change on a vendor upgrade, not on a compile — they refresh here',
    ]],
    ['Every answer', 'transparency', C.brick, [
      'Snapshot date on the line after the heading; a staleness note once per process after 45 days',
      'Coverage line "partial build" after a delta until the next full rebuild',
      'The one live tool (UI custom fields) is marked live and never enters the snapshot',
    ]],
  ].flatMap((col, i) => {
    const x = LEFT + i * 4.1;
    return [
      rect(x, 1.75, 3.95, 0.62, col[2], { rounding: 4000 }),
      textBox(x, 1.75, 3.95, 0.62, [
        para(run(col[0], { sz: 1000, bold: true, color: C.white }), { algn: 'ctr' }),
        para(run(col[1], { sz: 750, color: C.white }), { algn: 'ctr' }),
      ], { anchor: 'ctr' }),
      rect(x, 2.37, 3.95, 2.35, C.white, { line: col[2], lineW: 6350 }),
      textBox(x + 0.05, 2.42, 3.85, 2.25, col[3].map(t => para(run(t, { sz: 800, color: C.dk }), { bullet: true, indent: -114300, marL: 114300, spcBef: 350, lnSpc: 112000 }))),
    ];
  }),

  textBox(LEFT, 4.95, WIDTH, 0.30, [para(run('Why deltas and a weekly rebuild, not one or the other', { sz: 950, bold: true, color: C.dk }))]),
  rect(LEFT, 5.25, WIDTH, 0.95, C.bgPanel, { rounding: 4000 }),
  textBox(LEFT + 0.12, 5.28, WIDTH - 0.24, 0.9, [
    para(run('The delta keeps the snapshot current: what a developer compiled this morning is answerable this morning. The rebuild keeps it correct: it is the only step that removes what no longer exists and picks up vendor upgrades. Together they give the assistant facts that are both fresh and complete, at a cost of minutes per compile and one scheduled job per week.', { sz: 850, color: C.dk }), { lnSpc: 115000 }),
  ]),
]));

// ═══════════════════════════════════════════════════════════════════
// 10 · Summary
// ═══════════════════════════════════════════════════════════════════
slides.push(contentSlide('Summary', numberedRows([
  ['Metadata is the ground truth', 'The AOT of our own environment, as a dated snapshot, is what every answer is checked against — no invented names, limits stated'],
  ['Three services carry it', 'KB: the object model (32 tools) · XRef: who uses what (18) · Labels: every text in 75 languages with its description (4); Security and Task Recorder complete the set'],
  ['Skills carry the method', 'Which tool first, what to verify, how to read coverage — the discipline that makes the difference between two sessions with the same tools'],
  ['Tokens are measured, not guessed', 'The tool list is the fixed cost (core profile −54 %); response shape, encoding, pagination and guardrails are the variable one'],
  ['One code base, two transports', 'Local stdio servers for developers, an Azure Functions app with Entra sign-in for claude.ai connectors'],
  ['Fresh within minutes, correct every week', 'Compile hook deltas plus a weekly full rebuild and publish; the snapshot date travels with every response'],
], 1.30, 0.80, { descH: 0.42 })));

// ═══════════════════════════════════════════════════════════════════
// 11 · End
// ═══════════════════════════════════════════════════════════════════
slides.push({ layout: 40, xml: slideXml([]) });

// ══════════════════════════════════════════════════════════════════
// Assemble the PPTX (same procedure as the deep-dive generator)
// ══════════════════════════════════════════════════════════════════
const zip = new AdmZip(TEMPLATE);
for (let i = 1; i <= 4; i++) { zip.deleteFile(`ppt/slides/slide${i}.xml`); zip.deleteFile(`ppt/slides/_rels/slide${i}.xml.rels`); }
for (let i = 4; i <= 6; i++) zip.deleteFile(`ppt/tags/tag${i}.xml`);
for (let i = 3; i <= 4; i++) zip.deleteFile(`ppt/embeddings/oleObject${i}.bin`);

slides.forEach((s, i) => {
  zip.addFile(`ppt/slides/slide${i + 1}.xml`, Buffer.from(s.xml, 'utf-8'));
  zip.addFile(`ppt/slides/_rels/slide${i + 1}.xml.rels`, Buffer.from(slideRels(s.layout), 'utf-8'));
});

let presXml = zip.readAsText('ppt/presentation.xml');
presXml = presXml.replace(/<p:sldIdLst>[\s\S]*?<\/p:sldIdLst>/, `<p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${300 + i}" r:id="rId${100 + i}"/>`).join('')}</p:sldIdLst>`);
zip.addFile('ppt/presentation.xml', Buffer.from(presXml, 'utf-8'));

let presRels = zip.readAsText('ppt/_rels/presentation.xml.rels');
presRels = presRels.replace(/<Relationship[^>]*Target="slides\/slide\d+\.xml"[^>]*\/>/g, '');
presRels = presRels.replace('</Relationships>', slides.map((_, i) => `<Relationship Id="rId${100 + i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`).join('') + '</Relationships>');
zip.addFile('ppt/_rels/presentation.xml.rels', Buffer.from(presRels, 'utf-8'));

let contentTypes = zip.readAsText('[Content_Types].xml');
contentTypes = contentTypes.replace(/<Override PartName="\/ppt\/slides\/slide\d+\.xml"[^>]*\/>/g, '');
contentTypes = contentTypes.replace(/<Override PartName="\/ppt\/tags\/tag[4-6]\.xml"[^>]*\/>/g, '');
contentTypes = contentTypes.replace(/<Override PartName="\/ppt\/embeddings\/oleObject[34]\.bin"[^>]*\/>/g, '');
contentTypes = contentTypes.replace('</Types>', slides.map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('') + '</Types>');
zip.addFile('[Content_Types].xml', Buffer.from(contentTypes, 'utf-8'));

zip.writeZip(OUTPUT);
console.log(`Presentation saved to: ${OUTPUT}`);
console.log(`  ${slides.length} slides generated using Trelleborg template layouts`);
