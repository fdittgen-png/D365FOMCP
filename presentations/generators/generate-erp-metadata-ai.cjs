/**
 * ERP Metadata for AI — the big picture
 *
 * Four chapters, deliberately shallow in the first and only a little deeper after:
 *   1 · Why — what ERP metadata is, why it is the ground truth, what an LLM and a
 *       token are, what they cost, what MCP is and how a model talks to one.
 *   2 · How — the global architecture, the Azure services / languages / databases
 *       and why those, Azure-hosted versus locally installed, how data stays fresh.
 *   3 · Traces — what is captured, what for, and how the MCP built on the traces
 *       improves token efficiency and response quality.
 *   4 · Beyond D365 F&O — the same pattern on another ERP or a plain database, and
 *       the functional vocabulary that correlates them.
 *
 * Same template, palette and helpers as generate-metadata-overview.cjs so the
 * decks read as one series. Every number is a measured one from CLAUDE.md or from
 * the concept documents; nothing here is estimated silently.
 *
 *   node presentations/generators/generate-erp-metadata-ai.cjs
 */
const AdmZip = require('adm-zip');
const fs = require('fs');
const path = require('path');

const TEMPLATE = path.resolve(__dirname, '..', 'templates', 'trelleborg template.pptx');
const OUTPUT   = path.resolve(__dirname, '..', 'ERP_Metadata_for_AI.pptx');
const DOCS_COPY = path.resolve(__dirname, '..', '..', 'docs', 'ERP_Metadata_for_AI.pptx');

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

// ── XML helpers (identical to the other generators in this series) ──
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
function vLine(x, y, h, color, width) {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id()}" name="VLine ${nextId}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${IN(x)}" y="${IN(y)}"/><a:ext cx="0" cy="${IN(h)}"/></a:xfrm><a:prstGeom prst="line"><a:avLst/></a:prstGeom><a:ln w="${width || 12700}"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></a:ln></p:spPr></p:sp>`;
}
function rect(x, y, w, h, fill, opts = {}) {
  const lineXml = opts.line ? `<a:ln w="${opts.lineW || 12700}"><a:solidFill><a:srgbClr val="${opts.line}"/></a:solidFill></a:ln>` : '<a:ln><a:noFill/></a:ln>';
  const rr = opts.rounding ? `<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val ${opts.rounding}"/></a:avLst></a:prstGeom>` : '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>';
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id()}" name="Rect ${nextId}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${IN(x)}" y="${IN(y)}"/><a:ext cx="${IN(w)}" cy="${IN(h)}"/></a:xfrm>${rr}<a:solidFill><a:srgbClr val="${fill}"/></a:solidFill>${lineXml}</p:spPr></p:sp>`;
}
function arrow(x, y, w, color) {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id()}" name="Arrow ${nextId}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${IN(x)}" y="${IN(y)}"/><a:ext cx="${IN(w)}" cy="0"/></a:xfrm><a:prstGeom prst="line"><a:avLst/></a:prstGeom><a:ln w="15875"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:tailEnd type="triangle" w="med" len="med"/></a:ln></p:spPr></p:sp>`;
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

// ── composition helpers ─────────────────────────────────────────────
const LEFT = 0.59, WIDTH = 12.15;
function subtitle(text) {
  return textBox(LEFT, 1.28, WIDTH, 0.46, [para(run(text, { sz: 900, italic: true, color: C.gray }), { lnSpc: 105000 })]);
}
function bullets(lines, color, sz = 830) {
  return lines.map(l => {
    const runs = Array.isArray(l) ? [run(l[0], { sz, bold: true, color }), run(l[1], { sz, color: C.dk })] : [run(l, { sz, color: C.dk })];
    return para(runs, { bullet: true, indent: -114300, marL: 114300, spcBef: 350, lnSpc: 112000 });
  });
}
/** Header bar + body panel with bullet lines. `lines` = strings or [bold, rest]. */
function panel(x, y, w, h, color, title, lines, opts = {}) {
  const sz = opts.sz || 800, headH = 0.36, lightFill = opts.fill || C.white;
  return [
    rect(x, y, w, headH, color, { rounding: 4000 }),
    textBox(x, y, w, headH, [para(run(title, { sz: 950, bold: true, color: C.white }))], { anchor: 'ctr' }),
    rect(x, y + headH, w, h - headH, lightFill, { line: color, lineW: 6350 }),
    textBox(x + 0.05, y + headH + 0.04, w - 0.1, h - headH - 0.08, bullets(lines, color, sz)),
  ];
}
/** A single headline number with a caption underneath. */
function figure(x, y, w, value, caption, color) {
  return [
    textBox(x, y, w, 0.44, [para(run(value, { sz: 1800, bold: true, color }), { algn: 'ctr' })], { anchor: 'ctr' }),
    textBox(x, y + 0.44, w, 0.62, [para(run(caption, { sz: 750, color: C.gray }), { algn: 'ctr', lnSpc: 108000 })]),
  ];
}
/** Numbered step rows (agenda / summary style). */
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
/** A box in a flow diagram. */
function node(x, y, w, h, fill, line, title, sub, opts = {}) {
  return [
    rect(x, y, w, h, fill, { line, lineW: opts.lineW || 9525, rounding: 4000 }),
    textBox(x + 0.05, y + 0.04, w - 0.1, h - 0.08, [
      para(run(title, { sz: opts.sz || 850, bold: true, color: opts.titleColor || line }), { algn: 'ctr' }),
      ...(sub ? [para(run(sub, { sz: opts.subSz || 720, color: C.gray }), { algn: 'ctr', lnSpc: 106000, spcBef: 200 })] : []),
    ], { anchor: 'ctr' }),
  ];
}
/** Chapter divider. */
function chapter(n, title, blurb) {
  return {
    layout: 13,
    xml: slideXml([
      placeholder('title', 0, [para(run(title, { sz: 1800, bold: true, color: C.black }))]),
      rect(LEFT, 2.10, 1.55, 1.55, C.teal, { rounding: 8000 }),
      textBox(LEFT, 2.10, 1.55, 1.55, [para(run(String(n).padStart(2, '0'), { sz: 4000, bold: true, color: C.white }), { algn: 'ctr' })], { anchor: 'ctr' }),
      textBox(2.55, 2.35, 9.9, 1.2, [para(run(blurb, { sz: 1250, color: C.dk }), { lnSpc: 118000 })]),
      lineShape(LEFT, 4.00, 11.9, C.teal, 19050),
    ]),
  };
}

const slides = [];

// ═══════════════════════════════════════════════════════════════════
// 1 · Title
// ═══════════════════════════════════════════════════════════════════
slides.push({
  layout: 2,
  xml: slideXml([
    placeholder('title', 0, [para(run('ERP Metadata for AI', { sz: 3100, color: C.white }))]),
    placeholder('body', 13, [para(run('Teaching a language model the shape of our systems — without ever showing it our data', { sz: 1700, bold: true, color: C.white }))]),
    placeholder('body', 14, [para(run('Why metadata · the architecture · what the traces add · and why the same pattern fits any ERP or database', { sz: 1300, color: C.white }))]),
  ]),
});

// ═══════════════════════════════════════════════════════════════════
// 2 · Agenda
// ═══════════════════════════════════════════════════════════════════
slides.push(contentSlide('Agenda', numberedRows([
  ['Why — metadata, language models and MCP', 'What ERP metadata is, why it decides answer quality, what a token costs, and how a model reaches a tool'],
  ['How — the architecture', 'From the application object tree to an answer: the Azure services, the languages, the databases, and why each was chosen'],
  ['Hosted and local', 'The same code as a cloud service for everyone and as a local server for developers — and how both stay current'],
  ['Traces — the system learning from itself', 'Every investigation is recorded, and a service built on those records makes the next one cheaper and better'],
  ['Beyond D365 F&O', 'The same pattern on another ERP or a plain database, and the vocabulary that lets a model see what they have in common'],
], 1.55, 0.92, { descH: 0.44 })));

// ═══════════════════════════════════════════════════════════════════
// 3 · Chapter 1
// ═══════════════════════════════════════════════════════════════════
slides.push(chapter(1, 'Why: metadata, language models and MCP',
  'The starting point is a distinction most discussions about AI in ERP skip: the difference between the data a system holds and the description of how that system is built. Everything here rests on the second one.'));

// ═══════════════════════════════════════════════════════════════════
// 4 · Data versus metadata
// ═══════════════════════════════════════════════════════════════════
slides.push(contentSlide('Data versus metadata', [
  subtitle('An ERP holds business records. It also holds a complete description of itself — the tables, fields, types, relations, labels, permissions and code that make those records possible. That description is the metadata, and it is what we work with.'),

  ...panel(LEFT, 1.85, 5.9, 2.45, C.brick, 'Business data — never used here', [
    ['Customer and vendor records. ', 'Names, addresses, bank details, contacts.'],
    ['Transactions. ', 'Orders, invoices, payments, journals — every posted value.'],
    ['Personal data. ', 'Anything identifying a real person or company.'],
    ['Why it stays out. ', 'It is confidential, it changes every minute, and it answers none of the questions an assistant is asked about how the system works.'],
  ], { sz: 830 }),

  ...panel(6.84, 1.85, 5.9, 2.45, C.teal, 'Metadata — the whole working surface', [
    ['Structure. ', 'Tables, fields, data types, keys, indexes, relations between them.'],
    ['Meaning. ', 'Labels and developer descriptions in every shipped language.'],
    ['Behaviour. ', 'Classes, methods, extension points, events — how the system reacts.'],
    ['Rules and access. ', 'Roles, duties, privileges, configuration keys, data entities.'],
  ], { sz: 830 }),

  rect(LEFT, 4.48, WIDTH, 1.62, C.tealLt, { rounding: 4000 }),
  textBox(LEFT + 0.15, 4.54, WIDTH - 0.3, 1.5, [
    para(run('The consequence that makes this possible at all', { sz: 950, bold: true, color: C.slate })),
    para(run('Metadata is not confidential in the way business data is, it is stable for weeks rather than seconds, and it is small enough to index completely. That is why an assistant can be given the entire description of the system and still never be shown a single customer record. Nothing that identifies a customer, a vendor or a person ever leaves the company through this path.', { sz: 880, color: C.dk }), { lnSpc: 118000, spcBef: 300 }),
  ]),
]));

// ═══════════════════════════════════════════════════════════════════
// 5 · Why metadata decides answer quality
// ═══════════════════════════════════════════════════════════════════
slides.push(contentSlide('Why metadata decides the quality of an answer', [
  subtitle('A language model has read a great deal about ERP systems in general. It has never seen ours. The gap between the two is where wrong answers come from — and metadata is exactly what closes it.'),

  textBox(LEFT, 1.80, 5.9, 0.30, [para(run('Asked without the metadata', { sz: 950, bold: true, color: C.brick }))]),
  rect(LEFT, 2.12, 5.9, 2.25, C.redBg, { rounding: 4000 }),
  textBox(LEFT + 0.1, 2.17, 5.7, 2.15, bullets([
    ['It answers from the general case. ', 'A field name that is right for a standard installation, or right for the previous product generation.'],
    ['It cannot see our changes. ', 'Our own extensions, the vendor add-ons and the fields created in the user interface are invisible to it.'],
    ['It sounds equally certain either way. ', 'Nothing in the answer distinguishes a verified fact from a plausible invention.'],
    ['Someone has to check every line. ', 'Which is the work the assistant was supposed to save.'],
  ], C.brick)),

  textBox(6.84, 1.80, 5.9, 0.30, [para(run('Asked with the metadata', { sz: 950, bold: true, color: C.greenOk }))]),
  rect(6.84, 2.12, 5.9, 2.25, C.greenBg, { rounding: 4000 }),
  textBox(6.94, 2.17, 5.7, 2.15, bullets([
    ['It looks the answer up. ', 'Names, types, relations, labels and permissions come from a snapshot of our own environment.'],
    ['It sees everything we built. ', 'Standard, vendor and custom layers, each marked with where it came from.'],
    ['It states its limits. ', 'Every answer carries the date of the snapshot and a line saying what it does not cover.'],
    ['It is reproducible. ', 'The same question against the same snapshot gives the same facts — which is what makes it auditable.'],
  ], C.greenOk)),

  rect(LEFT, 4.55, WIDTH, 1.05, C.bgPanel, { rounding: 4000 }),
  textBox(LEFT + 0.15, 4.60, WIDTH - 0.3, 0.95, [
    para([
      run('The rule the whole system is built on: ', { sz: 900, bold: true, color: C.teal }),
      run('verify before you assert. A name is checked before it appears in an answer, a change is checked against the real extension points before it is proposed, and a result that covers only part of the ground says so. An assistant that admits a gap is worth more than one that fills it convincingly.', { sz: 900, color: C.dk }),
    ], { lnSpc: 118000 }),
  ]),
]));

// ═══════════════════════════════════════════════════════════════════
// 6 · What a language model is, and what a token costs
// ═══════════════════════════════════════════════════════════════════
slides.push(contentSlide('What a language model is, and what a token costs', [
  subtitle('Three ideas are enough to follow the rest of this deck: what the model actually does, what a token is, and why the cost of a conversation grows with every turn.'),

  ...panel(LEFT, 1.80, 3.95, 2.35, C.slate, 'The model', [
    'A language model predicts the next piece of text, one small piece at a time, from everything it has been given so far.',
    'It has no memory between conversations and no connection to any system of ours.',
    'Everything it knows about a task must be inside the conversation — which is why what we put there matters so much.',
  ], { sz: 830 }),

  ...panel(4.69, 1.80, 3.95, 2.35, C.gold, 'The token', [
    'Text is cut into tokens: roughly four characters, or three quarters of an average word.',
    'A short question is tens of tokens. A full table description can be thousands.',
    'Everything counts: the question, the answer, the documents, and the description of every tool the model may call.',
  ], { sz: 830 }),

  ...panel(8.79, 1.80, 3.95, 2.35, C.brown, 'The bill', [
    'Tokens sent in are cheap, tokens written out are the expensive ones — around fifty times a cached read in our own measurements.',
    'A conversation carries its whole history forward, so every token added is paid again on every later turn.',
    'Measured here: a single turn costs roughly ten cents before doing any work once the conversation is large.',
  ], { sz: 830 }),

  rect(LEFT, 4.35, WIDTH, 1.25, C.goldLt, { rounding: 4000 }),
  textBox(LEFT + 0.15, 4.40, WIDTH - 0.3, 1.15, [
    para(run('Why this shapes the engineering, not just the invoice', { sz: 950, bold: true, color: C.brown })),
    para(run('If an answer needs one precise lookup instead of five exploratory ones, and if that lookup returns three hundred tokens instead of twelve thousand, the same question costs a fraction and the model has less irrelevant material to be distracted by. Cheaper and better are the same lever here, not a trade-off. That is why every tool in this system is measured, and why the measurements are kept in the repository next to the code.', { sz: 880, color: C.dk }), { lnSpc: 118000, spcBef: 300 }),
  ]),
]));

// ═══════════════════════════════════════════════════════════════════
// 7 · What MCP is
// ═══════════════════════════════════════════════════════════════════
slides.push(contentSlide('What MCP is, and how a model uses one', [
  subtitle('The Model Context Protocol is an open standard for connecting an assistant to a source of information or an action. It replaces one integration per assistant and per system with one server that any compliant client can use.'),

  ...node(LEFT, 1.85, 2.55, 1.15, C.white, C.slate, 'The person', 'asks a question in plain language'),
  arrow(3.20, 2.42, 0.55, C.gray),
  ...node(3.82, 1.85, 2.55, 1.15, C.tealLt, C.teal, 'The assistant', 'decides which tool answers it'),
  arrow(6.44, 2.42, 0.55, C.gray),
  ...node(7.06, 1.85, 2.55, 1.15, C.white, C.gold, 'The MCP server', 'offers a list of named tools'),
  arrow(9.68, 2.42, 0.55, C.gray),
  ...node(10.30, 1.85, 2.44, 1.15, C.slateLt, C.slate, 'The metadata', 'a dated snapshot, read only'),

  textBox(LEFT, 3.15, WIDTH, 0.30, [para(run('What happens on a single question', { sz: 950, bold: true, color: C.teal }))]),
  rect(LEFT, 3.46, WIDTH, 1.05, C.white, { line: C.lt, lineW: 6350, rounding: 4000 }),
  textBox(LEFT + 0.12, 3.50, WIDTH - 0.24, 0.97, bullets([
    ['The server announces what it can do. ', 'Each tool has a name, a description and a precise shape for its inputs and outputs. The assistant reads that list at the start of every request.'],
    ['The assistant chooses and calls. ', 'It sends a structured call — not a sentence — and receives a structured answer it can rely on rather than parse.'],
    ['Nothing is executed on its own. ', 'Our tools only read. They cannot change the ERP, and the assistant cannot reach anything the server does not expose.'],
  ], C.teal, 820)),

  rect(LEFT, 4.66, WIDTH, 1.35, C.tealLt, { rounding: 4000 }),
  textBox(LEFT + 0.15, 4.71, WIDTH - 0.3, 1.25, [
    para(run('The part that is easy to underestimate', { sz: 900, bold: true, color: C.slate })),
    para(run('That list of tools is sent to the model on every single request, before any work happens. Ours describes seventy-seven tools across five services and weighs about forty-nine thousand tokens — roughly one euro over a working session, paid whether the tools are used or not. It is the only cost no filter can reduce afterwards, so the tool descriptions are written, measured and trimmed as carefully as the code. A reduced profile for clients that need fewer tools cuts it by fifty-nine per cent.', { sz: 870, color: C.dk }), { lnSpc: 116000, spcBef: 300 }),
  ]),
]));

// ═══════════════════════════════════════════════════════════════════
// 8 · Chapter 2
// ═══════════════════════════════════════════════════════════════════
slides.push(chapter(2, 'How it is built',
  'One pipeline turns the description of the ERP into something a model can query in milliseconds, one code base serves it two ways, and a small set of Azure services carries it — each chosen for a reason worth stating.'));

// ═══════════════════════════════════════════════════════════════════
// 9 · The global concept
// ═══════════════════════════════════════════════════════════════════
slides.push(contentSlide('The global concept: from the system to an answer', [
  subtitle('Four stages. The first two run on a schedule and produce a file; the last two run in a second and produce an answer. Nothing in the chain ever touches the live business database.'),

  ...node(LEFT, 1.82, 2.85, 1.30, C.white, C.slate, 'The ERP describes itself', 'the application object tree, the compiler cross-references, the security export'),
  arrow(3.52, 2.45, 0.5, C.gray),
  ...node(4.09, 1.82, 2.85, 1.30, C.goldLt, C.gold, 'A build reads it', 'parsers walk every model and write the facts into compact databases'),
  arrow(7.11, 2.45, 0.5, C.gray),
  ...node(7.68, 1.82, 2.85, 1.30, C.tealLt, C.teal, 'Services answer questions', 'seventy-seven read-only tools over those databases'),
  arrow(10.70, 2.45, 0.5, C.gray),
  ...node(11.27, 1.82, 1.47, 1.30, C.white, C.brown, 'The assistant', 'checks, then answers', { sz: 800 }),

  textBox(LEFT, 3.28, WIDTH, 0.30, [para(run('What the five services hold', { sz: 950, bold: true, color: C.dk }))]),
  ...[
    ['Knowledge base', 'The object model: tables, fields, types, relations, indexes, classes, methods, forms, data entities — and now the trace insight tools', C.teal],
    ['Cross-references', 'Who calls, extends, reads or writes what. Twenty-eight million references — the blast radius of any change', C.gold],
    ['Security', 'Roles, duties, privileges and entry points, with deny taking precedence — who can actually reach an object', C.brick],
    ['Labels', 'Every text the user sees, in seventy-five languages, each with the developer description that says what it is for', C.slate],
    ['Task recorder', 'A recorded click-path turned into a readable document, enriched with the objects behind each step', C.brown],
  ].flatMap((s, i) => {
    const x = LEFT + i * 2.44;
    return [
      rect(x, 3.60, 2.30, 1.60, C.white, { line: s[2], lineW: 9525, rounding: 4000 }),
      textBox(x + 0.06, 3.64, 2.18, 0.34, [para(run(s[0], { sz: 830, bold: true, color: s[2] }), { algn: 'ctr' })]),
      textBox(x + 0.06, 3.96, 2.18, 1.20, [para(run(s[1], { sz: 720, color: C.dk }), { lnSpc: 110000 })]),
    ];
  }),

  rect(LEFT, 5.36, WIDTH, 0.78, C.bgPanel, { rounding: 4000 }),
  textBox(LEFT + 0.15, 5.40, WIDTH - 0.3, 0.7, [
    para([
      run('Why a snapshot and not a live connection: ', { sz: 880, bold: true, color: C.teal }),
      run('reading the metadata out of the running system would be slow, would need production access, and would give a different answer every time. A dated file is fast, carries no access risk, and makes an answer reproducible — which is what allows an investigation to be replayed later, or against another system.', { sz: 880, color: C.dk }),
    ], { lnSpc: 116000 }),
  ]),
]));

// ═══════════════════════════════════════════════════════════════════
// 10 · Technology choices
// ═══════════════════════════════════════════════════════════════════
slides.push(contentSlide('The technology, and why each piece', [
  subtitle('Deliberately few moving parts. Every choice below was made to keep the running cost near zero and the failure modes few.'),

  ...panel(LEFT, 1.78, 3.95, 2.55, C.teal, 'Storage — SQLite files', [
    ['One file per service. ', 'The object model, the cross-references, the security model, the labels, the traces.'],
    ['Read-only at run time. ', 'A query answers in milliseconds with no server to operate, no licence and no backup plan.'],
    ['Small enough to ship. ', 'The file is simply uploaded to the service after each build.'],
  ], { sz: 800 }),

  ...panel(4.69, 1.78, 3.95, 2.55, C.gold, 'Compute — Azure Functions', [
    ['Pay for what runs. ', 'The service costs nothing while nobody asks a question.'],
    ['One application, five endpoints. ', 'Each service is one address on the same host.'],
    ['JavaScript on Node. ', 'The same language as the protocol libraries, so one code base serves both ways of running it.'],
  ], { sz: 800 }),

  ...panel(8.79, 1.78, 3.95, 2.55, C.brick, 'Access — Entra ID', [
    ['Company sign-in. ', 'The same identity people already use; access is granted and revoked centrally.'],
    ['No keys to distribute. ', 'The assistant obtains a token; nothing long-lived is stored on a laptop.'],
    ['Read-only by design. ', 'No tool can change the ERP, so the worst case is a wrong answer, never a wrong posting.'],
  ], { sz: 800 }),

  textBox(LEFT, 4.50, WIDTH, 0.30, [para(run('And the rest, briefly', { sz: 950, bold: true, color: C.dk }))]),
  rect(LEFT, 4.82, WIDTH, 1.25, C.white, { line: C.lt, lineW: 6350, rounding: 4000 }),
  textBox(LEFT + 0.12, 4.86, WIDTH - 0.24, 1.17, bullets([
    ['Infrastructure as code. ', 'The cloud resources are declared in a template and deployed by script, so the environment can be rebuilt from the repository rather than remembered.'],
    ['Trace storage. ', 'The recorded investigations land as plain text files in blob storage, with two small tables as the index — no database server, no new component to run.'],
    ['Testing. ', 'Around two thousand automated tests, including ones that measure the size of every response and fail when a change makes the system more expensive without saying so.'],
  ], C.dk, 810)),
]));

// ═══════════════════════════════════════════════════════════════════
// 11 · Hosted versus local
// ═══════════════════════════════════════════════════════════════════
slides.push(contentSlide('Two ways to run it, one code base', [
  subtitle('The same tools are compiled into two shapes: a cloud service anyone in the company can connect to, and a local server that runs on a developer machine. They behave identically; what differs is who reaches them and how current they are.'),

  ...panel(LEFT, 1.85, 5.9, 2.55, C.teal, 'Hosted in Azure — for everyone', [
    ['Reached from the assistant in the browser. ', 'A connector, company sign-in, nothing to install.'],
    ['One shared snapshot. ', 'Everybody sees the same facts, dated and published on a weekly rhythm.'],
    ['The right choice for support, functional and business users. ', 'They need the released state of the system, not what someone is compiling right now.'],
    ['Also carries the live exception. ', 'The fields created in the user interface exist in no build and are read directly from a configured environment.'],
  ], { sz: 820 }),

  ...panel(6.84, 1.85, 5.9, 2.55, C.gold, 'Local — for developers', [
    ['Runs beside the development environment. ', 'Started by the assistant itself; no network hop, no sign-in.'],
    ['Sees uncommitted work. ', 'What was compiled minutes ago is already answerable — the reason a developer wants the local one.'],
    ['Refreshes itself after a build. ', 'Compiling a project triggers an update of just that model, in seconds to a couple of minutes.'],
    ['Same tools, same answers, same limits. ', 'Only the freshness of the underlying file differs.'],
  ], { sz: 820 }),

  rect(LEFT, 4.58, WIDTH, 1.45, C.bgPanel, { rounding: 4000 }),
  textBox(LEFT + 0.15, 4.63, WIDTH - 0.3, 1.35, [
    para(run('How the two stay current', { sz: 950, bold: true, color: C.teal })),
    para(run('A successful compile triggers a small update of the local files: one model out of two hundred is a rounding error of the database, which is why it takes minutes instead of an hour. That keeps the developer current but never removes anything, so a full rebuild runs once a week and is published to the cloud service — that pass is what makes the snapshot correct rather than merely fresh. Every answer carries its own snapshot date, so nobody has to guess which of the two they are looking at.', { sz: 870, color: C.dk }), { lnSpc: 118000, spcBef: 300 }),
  ]),
]));

// ═══════════════════════════════════════════════════════════════════
// 12 · Chapter 3
// ═══════════════════════════════════════════════════════════════════
slides.push(chapter(3, 'Traces: the system learning from itself',
  'Every investigation the assistant runs is recorded — not the answers, the path. Those recordings turn into two things: a report that measures how well the system is being used, and a service that makes the next investigation cheaper and better.'));

// ═══════════════════════════════════════════════════════════════════
// 13 · What is captured
// ═══════════════════════════════════════════════════════════════════
slides.push(contentSlide('What is recorded, and what deliberately is not', [
  subtitle('Two streams are written in parallel. One is what the assistant was trying to do; the other is what the services were asked. Neither contains a single business value.'),

  ...panel(LEFT, 1.80, 5.9, 2.30, C.teal, 'The assistant’s side', [
    ['The question as it understood it. ', 'Restated in neutral terms, with a stable key so the same question can be recognised on another system.'],
    ['The plan. ', 'One line before each group of calls, saying what it is about to find out and why.'],
    ['The conclusion. ', 'What it answered, and whether it considers the question answered, partly answered or abandoned.'],
  ], { sz: 830 }),

  ...panel(6.84, 1.80, 5.9, 2.30, C.gold, 'The services’ side', [
    ['One record per call. ', 'Which tool, with which arguments, how long it took, how big the answer was and which objects it touched.'],
    ['Never the answer itself. ', 'The response is not stored — it is reproduced by replaying the call against the dated snapshot.'],
    ['Filtered at the source. ', 'Free text and anything resembling personal data are masked before a record is written; the check runs again at the receiving end.'],
  ], { sz: 830 }),

  rect(LEFT, 4.28, WIDTH, 1.75, C.tealLt, { rounding: 4000 }),
  textBox(LEFT + 0.15, 4.33, WIDTH - 0.3, 1.65, [
    para(run('Why the answers are not kept — and why that is an advantage', { sz: 950, bold: true, color: C.slate })),
    para(run('Storing responses would make the recordings large, would put metadata into a second place where it can go stale, and would be the one part of the design with a real confidentiality question. Storing the path instead keeps each record tiny and permanently valid: because the snapshot is dated and read-only, replaying the same calls reproduces the same answers exactly. A recorded investigation therefore stays replayable after the metadata is rebuilt — and can be replayed against a different ERP altogether, which is the foundation of the last chapter.', { sz: 880, color: C.dk }), { lnSpc: 118000, spcBef: 300 }),
  ]),
]));

// ═══════════════════════════════════════════════════════════════════
// 14 · What the traces are for
// ═══════════════════════════════════════════════════════════════════
slides.push(contentSlide('What the traces are for', [
  subtitle('Four purposes, from the immediate to the strategic. The first two are already running; the third is what the current work delivers; the fourth is why the module exists at all.'),

  ...[
    ['Seeing what actually happened', 'A readable report of every investigation: the question, the plan, each call, the conclusion. Twenty minutes of an assistant’s work becomes one page a person can review.', C.teal],
    ['Measuring the system honestly', 'How many calls a question really takes, how much payload came back, how often a call returned nothing. Improvements stop being a matter of impression.', C.gold],
    ['Making the next investigation better', 'A service reads the recordings and hands the assistant what a previous run of the same question did — the shortest path that worked, and the mistakes it made.', C.brick],
    ['Building the bridge between systems', 'A question asked on two different ERPs, under the same key, produces two recordings that can be compared object by object. That comparison is the raw material of a migration mapping.', C.slate],
  ].flatMap((p, i) => {
    const y = 1.82 + i * 1.10;
    return [
      rect(LEFT, y, 0.62, 0.92, p[2], { rounding: 6000 }),
      textBox(LEFT, y, 0.62, 0.92, [para(run(String(i + 1), { sz: 1700, bold: true, color: C.white }), { algn: 'ctr' })], { anchor: 'ctr' }),
      rect(1.38, y, 11.36, 0.92, C.white, { line: p[2], lineW: 6350, rounding: 4000 }),
      textBox(1.50, y + 0.05, 11.1, 0.32, [para(run(p[0], { sz: 950, bold: true, color: p[2] }))]),
      textBox(1.50, y + 0.36, 11.1, 0.55, [para(run(p[1], { sz: 840, color: C.dk }), { lnSpc: 112000 })]),
    ];
  }),
]));

// ═══════════════════════════════════════════════════════════════════
// 15 · The MCP built on the traces
// ═══════════════════════════════════════════════════════════════════
slides.push(contentSlide('The service built on the traces', [
  subtitle('The recordings are compiled into their own small snapshot, and two tools read it. Everything they answer comes from the recordings; the object model is only used to attach meaning to what the recordings name.'),

  ...node(LEFT, 1.80, 2.65, 1.05, C.white, C.slate, 'Recordings', 'both streams, every service'),
  arrow(3.32, 2.30, 0.45, C.gray),
  ...node(3.84, 1.80, 2.65, 1.05, C.goldLt, C.gold, 'A small build', 'pairs, classifies, resolves entities'),
  arrow(6.56, 2.30, 0.45, C.gray),
  ...node(7.08, 1.80, 2.65, 1.05, C.tealLt, C.teal, 'Two tools', 'on the existing knowledge service'),
  arrow(9.80, 2.30, 0.45, C.gray),
  ...node(10.32, 1.80, 2.42, 1.05, C.white, C.brown, 'The assistant', 'starts informed'),

  textBox(LEFT, 3.05, 5.9, 0.30, [para(run('“Has this been investigated before?”', { sz: 950, bold: true, color: C.teal }))]),
  rect(LEFT, 3.37, 5.9, 1.45, C.white, { line: C.teal, lineW: 6350, rounding: 4000 }),
  textBox(LEFT + 0.1, 3.41, 5.7, 1.37, bullets([
    'Returns the calls of the cheapest previous run that reached an answer, with their arguments — a path that is known to work.',
    'Shows what that run still wasted, so the same dead end is not repeated.',
    'Costs about a hundred and fifty tokens when there is nothing to find.',
  ], C.teal, 820)),

  textBox(6.84, 3.05, 5.9, 0.30, [para(run('“What is this business entity here?”', { sz: 950, bold: true, color: C.gold }))]),
  rect(6.84, 3.37, 5.9, 1.45, C.white, { line: C.gold, lineW: 6350, rounding: 4000 }),
  textBox(6.94, 3.41, 5.7, 1.37, bullets([
    'One call gives the tables and data entities behind a business term, its key fields, and what each field means.',
    'Each field carries how often real investigations have touched it — and which ones nobody has ever looked at.',
    'Replaces a chain of three or four exploratory calls.',
  ], C.gold, 820)),

  rect(LEFT, 5.00, WIDTH, 1.05, C.tealLt, { rounding: 4000 }),
  textBox(LEFT + 0.15, 5.04, WIDTH - 0.3, 0.97, [
    para([
      run('Both levers at once: ', { sz: 880, bold: true, color: C.slate }),
      run('fewer calls and less payload for the same question is the token saving; starting from a path that already worked, with the meaning of each field attached, is the quality gain. They are the same mechanism seen from two sides — and because the tools are themselves recorded, their effect is measured rather than claimed.', { sz: 880, color: C.dk }),
    ], { lnSpc: 116000 }),
  ]),
]));

// ═══════════════════════════════════════════════════════════════════
// 16 · What it measures
// ═══════════════════════════════════════════════════════════════════
slides.push(contentSlide('What it measures — and the first reading', [
  subtitle('The same recordings feed a report for people. These are the numbers from the first eighteen recorded investigations: a baseline, not an achievement.'),

  ...figure(LEFT, 1.75, 2.30, '6.5', 'calls for a question that reached an answer, in the middle case', C.teal),
  ...figure(3.05, 1.75, 2.30, '29%', 'of calls returned nothing useful, failed, or repeated another', C.brick),
  ...figure(5.51, 1.75, 2.30, '28%', 'of calls sat under a stated plan — the target is above ninety', C.brown),
  ...figure(7.97, 1.75, 2.30, '20%', 'of the entities the assistant expected were the ones it actually touched', C.gold),
  ...figure(10.43, 1.75, 2.30, '252 KB', 'the entire recordings snapshot — it builds in seconds', C.slate),

  textBox(LEFT, 2.95, WIDTH, 0.30, [para(run('How to read these honestly', { sz: 950, bold: true, color: C.dk }))]),
  rect(LEFT, 3.27, WIDTH, 1.35, C.white, { line: C.lt, lineW: 6350, rounding: 4000 }),
  textBox(LEFT + 0.12, 3.31, WIDTH - 0.24, 1.27, bullets([
    ['Two of these figures are measurement faults, not behaviour. ', 'The way the plan and the expected entities are picked out of a conversation misses them in common cases. That is being fixed before either number is used to judge anything.'],
    ['Waste is read per tool, never globally. ', 'A tool whose job is to check whether something exists is supposed to come back empty often; a tool that returns a full table description is not.'],
    ['What a trace cannot tell us. ', 'Whether an answer was correct. These figures measure the process — the discipline, the cost, the coverage. Correctness needs a separate test set, and the deck does not pretend otherwise.'],
  ], C.dk, 820)),

  rect(LEFT, 4.78, WIDTH, 1.25, C.bgPanel, { rounding: 4000 }),
  textBox(LEFT + 0.15, 4.82, WIDTH - 0.3, 1.17, [
    para(run('Why a baseline is worth more than a good number', { sz: 900, bold: true, color: C.teal })),
    para(run('Until now, every improvement to how the assistant works — a rewritten instruction, a reshaped response, a new tool — was judged by impression. With these figures recorded per week, per question and per tool, the next change either moves them or it does not. That is the whole point of measuring the system with the system.', { sz: 870, color: C.dk }), { lnSpc: 116000, spcBef: 300 }),
  ]),
]));

// ═══════════════════════════════════════════════════════════════════
// 17 · Chapter 4
// ═══════════════════════════════════════════════════════════════════
slides.push(chapter(4, 'Beyond D365 F&O',
  'Nothing in the design is specific to one product. Any system that can describe itself — another ERP, a data warehouse, a plain database — fits the same pattern, and once two of them are described the model can be shown what they have in common.'));

// ═══════════════════════════════════════════════════════════════════
// 18 · The same pattern elsewhere
// ═══════════════════════════════════════════════════════════════════
slides.push(contentSlide('The same pattern on any system', [
  subtitle('Everything after the first stage is generic. Only the reader that extracts the description has to be written once per system — and it is the smallest part.'),

  ...[
    ['What must be written per system', 'A reader that walks the source system’s own description — its catalogue, its exported definitions, its data dictionary — and writes it into the same compact format. Days of work, not months.', C.gold],
    ['What is reused unchanged', 'The storage format, the tool contract, the hosting, the sign-in, the freshness rules, the response discipline, the recordings and the report. This is the large part, and it is already built and tested.', C.teal],
    ['What each new system gains immediately', 'The same guarantees: verified names, stated limits, a dated snapshot, reproducible answers — and the same measured cost control, from day one rather than after a year of tuning.', C.greenOk],
  ].flatMap((p, i) => {
    const y = 1.82 + i * 1.14;
    return [
      rect(LEFT, y, 11.9, 0.98, C.white, { line: p[2], lineW: 9525, rounding: 4000 }),
      textBox(LEFT + 0.14, y + 0.05, 11.6, 0.32, [para(run(p[0], { sz: 950, bold: true, color: p[2] }))]),
      textBox(LEFT + 0.14, y + 0.36, 11.6, 0.58, [para(run(p[1], { sz: 850, color: C.dk }), { lnSpc: 112000 })]),
    ];
  }),

  textBox(LEFT, 5.28, WIDTH, 0.30, [para(run('Candidates, in the order they make sense', { sz: 950, bold: true, color: C.dk }))]),
  ...[
    ['A second ERP', 'the legacy system a site still runs on', C.brick],
    ['A data warehouse', 'the reporting model everyone already queries', C.slate],
    ['An integration layer', 'the messages and mappings between systems', C.brown],
    ['Internal documentation', 'decisions and runbooks, as a described source rather than loose files', C.gold],
  ].flatMap((s, i) => {
    const x = LEFT + i * 3.04;
    return [
      rect(x, 5.60, 2.90, 0.52, C.bgPanel, { rounding: 5000 }),
      textBox(x + 0.06, 5.62, 2.78, 0.48, [
        para(run(s[0], { sz: 800, bold: true, color: s[2] }), { algn: 'ctr' }),
        para(run(s[1], { sz: 690, color: C.gray }), { algn: 'ctr', lnSpc: 100000 }),
      ]),
    ];
  }),
]));

// ═══════════════════════════════════════════════════════════════════
// 19 · The vocabulary as pivot
// ═══════════════════════════════════════════════════════════════════
slides.push(contentSlide('Seeing what two systems have in common', [
  subtitle('Two ERPs never share a table name. They do share the business: both have a customer, a purchase order, a stock movement. A small shared list of business concepts is what lets the model connect the two.'),

  ...node(LEFT, 1.80, 3.30, 1.60, C.white, C.brick, 'The legacy system', 'its own tables, its own names, described by its own reader', { sz: 880 }),
  ...node(4.92, 1.80, 3.50, 1.60, C.tealLt, C.teal, 'The business concept', '“customer” — one shared identifier, with the names people actually use for it', { sz: 900 }),
  ...node(9.44, 1.80, 3.30, 1.60, C.white, C.gold, 'D365 F&O', 'its tables, data entities and key fields, from the existing snapshot', { sz: 880 }),
  arrow(3.98, 2.58, 0.85, C.gray),
  arrow(8.52, 2.58, 0.85, C.gray),

  textBox(LEFT, 3.58, WIDTH, 0.30, [para(run('What that one link makes possible', { sz: 950, bold: true, color: C.teal }))]),
  rect(LEFT, 3.90, WIDTH, 1.55, C.white, { line: C.teal, lineW: 6350, rounding: 4000 }),
  textBox(LEFT + 0.12, 3.94, WIDTH - 0.24, 1.47, bullets([
    ['The same question, asked twice. ', '“How is a customer identified here?” runs against both systems under one key, and the two recordings can be laid side by side — automatically, because the calls are replayable.'],
    ['A mapping built from evidence. ', 'Instead of a workshop guessing which legacy field corresponds to which target field, the pairs come from investigations that actually looked, with the reasoning attached.'],
    ['Effort aimed where it matters. ', 'The recordings show which fields people really use. A field nobody has looked at in a hundred investigations is not where the cleansing budget goes first.'],
    ['Rules that travel. ', 'A data quality rule expressed against the business concept rather than a table name applies to the next system without rewriting.'],
  ], C.teal, 820)),

  rect(LEFT, 5.60, WIDTH, 0.52, C.tealLt, { rounding: 4000 }),
  textBox(LEFT + 0.15, 5.62, WIDTH - 0.3, 0.48, [
    para([
      run('Status: ', { sz: 850, bold: true, color: C.slate }),
      run('the shared list exists today with sixty business concepts, each already linked to its D365 tables and key fields. It is in use, resolving what the assistant touches. The second system is what is missing, not the mechanism.', { sz: 850, color: C.dk }),
    ], { lnSpc: 112000 }),
  ]),
]));

// ═══════════════════════════════════════════════════════════════════
// 20 · Summary
// ═══════════════════════════════════════════════════════════════════
slides.push(contentSlide('In short', numberedRows([
  ['Metadata, never data', 'The assistant is given the complete description of how our systems are built, and none of what they contain. That is what makes it both useful and safe'],
  ['Ground truth beats fluency', 'Names, types, relations, texts and permissions are looked up in a dated snapshot of our own environment, and every answer states what it does not cover'],
  ['Cost is engineering, not accounting', 'Fewer and smaller calls make answers cheaper and better at the same time; every figure in this deck was measured and is re-measured by the test suite'],
  ['One code base, two ways to run it', 'A cloud service with company sign-in for everyone, a local server for developers who need what they compiled minutes ago'],
  ['The system now measures itself', 'Every investigation is recorded, a service reads those recordings back, and the next question starts from the shortest path that already worked'],
  ['The pattern is portable', 'A new source system needs one reader; everything else is reused — and with a shared list of business concepts, the model can see what two systems have in common'],
], 1.40, 0.78, { descH: 0.40 })));

// ═══════════════════════════════════════════════════════════════════
// 21 · End
// ═══════════════════════════════════════════════════════════════════
slides.push({ layout: 40, xml: slideXml([]) });

// ══════════════════════════════════════════════════════════════════
// Assemble the PPTX (same procedure as the other generators)
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
fs.copyFileSync(OUTPUT, DOCS_COPY);
console.log(`Presentation saved to: ${OUTPUT}`);
console.log(`                  and: ${DOCS_COPY}`);
console.log(`  ${slides.length} slides generated using Trelleborg template layouts`);
