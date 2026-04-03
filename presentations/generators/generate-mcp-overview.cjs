/**
 * D365 F&O MCP Services Presentation Generator
 *
 * Generates a professional PowerPoint by injecting slides directly into
 * the Trelleborg corporate template, preserving slide masters, themes,
 * geometric shapes, logos, and brand identity.
 */
const AdmZip = require('adm-zip');
const path = require('path');

const TEMPLATE = path.resolve(__dirname, '..', 'templates', 'trelleborg template.pptx');
const OUTPUT   = path.resolve(__dirname, '..', 'D365FO_MCP_Services_Presentation.pptx');

// EMU helpers (1 inch = 914400 EMU)
const IN = v => Math.round(v * 914400);
const PT = v => Math.round(v * 12700); // font size in hundredths of a point

// Trelleborg brand colors from theme
const C = {
  black:    '000000', white:   'FFFFFF',
  dk:       '333333', lt:      'CCCCCC',
  gray:     '666666', teal:    '6DC1C9',
  gold:     'AD9B68', brown:   'B77133',
  slate:    '647772', brick:   '813341',
  bar:      '191919', goldDk:  '998242',
  bgPanel:  'F5F5F5', tealLt:  'E0F3F5',
  greenOk:  '2E7D32', redNo:   'C62828',
  greenBg:  'E8F5E9', redBg:   'FFEBEE',
};

// ──────────────────────────────────────────────────────────────────
// XML building helpers
// ──────────────────────────────────────────────────────────────────

let nextId = 100;
function id() { return nextId++; }

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Create a text run */
function run(text, opts = {}) {
  const sz = opts.sz || 1100;
  const color = opts.color || C.dk;
  const bold = opts.bold ? ' b="1"' : '';
  const italic = opts.italic ? ' i="1"' : '';
  const font = opts.font || 'Arial';
  const spc = opts.spc ? ` spc="${opts.spc}"` : '';
  return `<a:r><a:rPr lang="en-US" sz="${sz}"${bold}${italic}${spc} dirty="0"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:latin typeface="${esc(font)}"/><a:cs typeface="${esc(font)}"/></a:rPr><a:t>${esc(text)}</a:t></a:r>`;
}

/** Create a paragraph with optional runs */
function para(runs, opts = {}) {
  const algn = opts.algn ? ` algn="${opts.algn}"` : '';
  const spcBef = opts.spcBef ? `<a:spcBef><a:spcPts val="${opts.spcBef}"/></a:spcBef>` : '';
  const spcAft = opts.spcAft ? `<a:spcAft><a:spcPts val="${opts.spcAft}"/></a:spcAft>` : '';
  const lnSpc = opts.lnSpc ? `<a:lnSpc><a:spcPct val="${opts.lnSpc}"/></a:lnSpc>` : '';
  const bullet = opts.bullet ? '<a:buChar char="\u2022"/>' : (opts.noBullet ? '<a:buNone/>' : '');
  const indent = opts.indent ? ` indent="${opts.indent}" marL="${opts.marL || 0}"` : '';
  return `<a:p><a:pPr${algn}${indent}>${spcBef}${spcAft}${lnSpc}${bullet}</a:pPr>${typeof runs === 'string' ? runs : runs.join('')}<a:endParaRPr lang="en-US" dirty="0"/></a:p>`;
}

/** Create a text box shape */
function textBox(x, y, w, h, paragraphs, opts = {}) {
  const anchor = opts.anchor || 't';
  const wrap = opts.wrap !== false ? 'square' : 'none';
  const lnXml = opts.line ? `<a:ln w="${opts.lineW || 12700}"><a:solidFill><a:srgbClr val="${opts.line}"/></a:solidFill></a:ln>` : '<a:ln><a:noFill/></a:ln>';
  const fillXml = opts.fill ? `<a:solidFill><a:srgbClr val="${opts.fill}"/></a:solidFill>` : '<a:noFill/>';
  const rr = opts.rounding ? `<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val ${opts.rounding}"/></a:avLst></a:prstGeom>` : '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>';
  const margins = `lIns="${opts.lIns || 91440}" tIns="${opts.tIns || 45720}" rIns="${opts.rIns || 91440}" bIns="${opts.bIns || 45720}"`;

  return `<p:sp><p:nvSpPr><p:cNvPr id="${id()}" name="TextBox ${nextId}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${IN(x)}" y="${IN(y)}"/><a:ext cx="${IN(w)}" cy="${IN(h)}"/></a:xfrm>${rr}${fillXml}${lnXml}</p:spPr><p:txBody><a:bodyPr wrap="${wrap}" anchor="${anchor}" ${margins}/><a:lstStyle/>${paragraphs.join('')}</p:txBody></p:sp>`;
}

/** Create a line shape */
function lineShape(x, y, w, color, width) {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id()}" name="Line ${nextId}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${IN(x)}" y="${IN(y)}"/><a:ext cx="${IN(w)}" cy="0"/></a:xfrm><a:prstGeom prst="line"><a:avLst/></a:prstGeom><a:ln w="${width || 12700}"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></a:ln></p:spPr></p:sp>`;
}

/** Create a filled rectangle */
function rect(x, y, w, h, fill, opts = {}) {
  const lineXml = opts.line ? `<a:ln w="${opts.lineW || 12700}"><a:solidFill><a:srgbClr val="${opts.line}"/></a:solidFill></a:ln>` : '<a:ln><a:noFill/></a:ln>';
  const rr = opts.rounding ? `<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val ${opts.rounding}"/></a:avLst></a:prstGeom>` : '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>';
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id()}" name="Rect ${nextId}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${IN(x)}" y="${IN(y)}"/><a:ext cx="${IN(w)}" cy="${IN(h)}"/></a:xfrm>${rr}<a:solidFill><a:srgbClr val="${fill}"/></a:solidFill>${lineXml}</p:spPr></p:sp>`;
}

/** Placeholder shape referencing layout placeholder */
function placeholder(type, idx, paragraphs, opts = {}) {
  const phAttr = type === 'title' ? 'type="title"' : (type === 'body' ? `idx="${idx}"` : `type="${type}" sz="quarter" idx="${idx}"`);
  const spPr = opts.xfrm ? `<p:spPr><a:xfrm><a:off x="${IN(opts.x)}" y="${IN(opts.y)}"/><a:ext cx="${IN(opts.w)}" cy="${IN(opts.h)}"/></a:xfrm></p:spPr>` : '<p:spPr/>';
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id()}" name="PH ${nextId}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph ${phAttr}/></p:nvPr></p:nvSpPr>${spPr}<p:txBody><a:bodyPr/><a:lstStyle/>${paragraphs.join('')}</p:txBody></p:sp>`;
}

// ──────────────────────────────────────────────────────────────────
// Slide XML wrapper
// ──────────────────────────────────────────────────────────────────

function slideXml(shapes) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${shapes.join('')}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}

function slideRels(layoutNum) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout${layoutNum}.xml"/></Relationships>`;
}

// ──────────────────────────────────────────────────────────────────
// Reusable slide building blocks
// ──────────────────────────────────────────────────────────────────

/** Standard content slide using Layout 13 (Title + content) */
function contentSlide(title, shapes) {
  return {
    layout: 13,
    xml: slideXml([
      placeholder('title', 0, [
        para(run(title, { sz: 1800, bold: true, color: C.black }))
      ]),
      ...shapes
    ])
  };
}

/** Two-column comparison (WITHOUT/WITH) */
function comparisonSlide(title, leftTitle, leftContent, rightTitle, rightContent) {
  const boxY = 1.45;
  const boxH = 5.0;
  const leftX = 0.59;
  const rightX = 6.72;
  const boxW = 5.60;
  const padX = 0.15;
  const innerW = boxW - 2 * padX;

  return contentSlide(title, [
    // LEFT panel
    rect(leftX, boxY, boxW, boxH, C.redBg, { line: C.redNo, lineW: 15875, rounding: 5000 }),
    textBox(leftX + padX, boxY + 0.08, innerW, 0.35, [
      para([
        run('\u2716  ', { sz: 1200, bold: true, color: C.redNo }),
        run(leftTitle, { sz: 1200, bold: true, color: C.redNo })
      ])
    ]),
    textBox(leftX + padX, boxY + 0.45, innerW, boxH - 0.55, leftContent),

    // RIGHT panel
    rect(rightX, boxY, boxW, boxH, C.greenBg, { line: C.greenOk, lineW: 15875, rounding: 5000 }),
    textBox(rightX + padX, boxY + 0.08, innerW, 0.35, [
      para([
        run('\u2714  ', { sz: 1200, bold: true, color: C.greenOk }),
        run(rightTitle, { sz: 1200, bold: true, color: C.greenOk })
      ])
    ]),
    textBox(rightX + padX, boxY + 0.45, innerW, boxH - 0.55, rightContent),
  ]);
}

// ──────────────────────────────────────────────────────────────────
// Build all slides
// ──────────────────────────────────────────────────────────────────

const slides = [];

// ── SLIDE 1: Title (Layout 2) ────────────────────────────────────
slides.push({
  layout: 2,
  xml: slideXml([
    placeholder('title', 0, [
      para(run('D365 F&O \u2013 MCP Services', { sz: 3100, color: C.white }))
    ]),
    placeholder('body', 13, [
      para(run('AI-Powered Metadata Intelligence', { sz: 1800, bold: true, color: C.white }))
    ]),
    placeholder('body', 14, [
      para(run('Model Context Protocol for Dynamics 365 Finance & Operations', { sz: 1400, color: C.white }))
    ]),
  ])
});

// ── SLIDE 2: Agenda (Layout 13) ─────────────────────────────────
slides.push(contentSlide('Agenda', [
  // Agenda items as clean text blocks
  ...([
    ['01', 'What is MCP?', 'Model Context Protocol fundamentals for AI assistants'],
    ['02', 'Why MCP for D365 F&O?', 'The hallucination problem and how MCP solves it'],
    ['03', 'Our two MCP services', 'Knowledge Base (KB) and Cross-Reference (XRef)'],
    ['04', 'Data updates & deployment', 'Build pipeline, scripts, Microsoft updates, ISV extensions'],
    ['05', 'Before & After examples', 'Support tickets, SQL queries, OData, BI reporting, impact analysis'],
    ['06', 'Future MCP services', 'Additional value opportunities beyond KB and XRef'],
  ].flatMap((item, i) => {
    const y = 1.45 + i * 0.80;
    return [
      textBox(0.59, y, 0.7, 0.45, [
        para(run(item[0], { sz: 1800, bold: true, color: C.teal }), { algn: 'r' })
      ]),
      textBox(1.45, y, 9, 0.28, [
        para(run(item[1], { sz: 1300, bold: true, color: C.black }))
      ]),
      textBox(1.45, y + 0.28, 9, 0.25, [
        para(run(item[2], { sz: 950, color: C.gray }))
      ]),
      ...(i < 5 ? [lineShape(0.59, y + 0.72, 11.8, C.lt, 6350)] : []),
    ];
  }))
]));

// ── SLIDE 3: What is MCP? (Layout 13) ───────────────────────────
slides.push(contentSlide('What is MCP?', [
  // Definition box
  rect(0.59, 1.40, 5.80, 1.30, C.tealLt, { rounding: 5000 }),
  textBox(0.75, 1.48, 5.48, 1.14, [
    para(run('Model Context Protocol (MCP)', { sz: 1200, bold: true, color: C.dk }), { spcAft: 200 }),
    para(run('An open standard by Anthropic that lets AI assistants connect to external data sources and tools via a unified protocol \u2014 like a USB-C port for AI.', { sz: 1000, color: C.dk }), { lnSpc: 120000 }),
  ]),

  // Three concept cards
  ...(['Tools', 'Resources', 'Transport'].flatMap((title, i) => {
    const x = 0.59 + i * 2.0;
    return [
      rect(x, 3.05, 1.85, 0.40, C.teal),
      textBox(x, 3.05, 1.85, 0.40, [
        para(run(title, { sz: 1050, bold: true, color: C.white }), { algn: 'ctr' })
      ], { anchor: 'ctr' }),
      rect(x, 3.45, 1.85, 1.55, C.white, { line: C.teal, lineW: 9525 }),
      textBox(x + 0.10, 3.55, 1.65, 1.35, [
        para(run(
          i === 0 ? 'Functions the AI can call to query data, validate names, read source code' :
          i === 1 ? 'Structured data the AI can access: schemas, metadata, documentation' :
          'Communication layer: stdio for local dev, HTTP/SSE for Azure cloud',
          { sz: 900, color: C.dk }
        ), { lnSpc: 125000 })
      ]),
    ];
  })),

  // Right side: flow diagram
  textBox(7.0, 1.40, 5.5, 0.40, [
    para(run('How MCP works', { sz: 1400, bold: true, color: C.black }))
  ]),
  ...([
    ['AI Assistant (Copilot, Claude, Cursor, ...)', C.gray],
    ['MCP Client (built into the AI tool)', C.slate],
    ['MCP Server (our D365 KB & XRef services)', C.teal],
    ['D365 F&O Metadata (SQLite databases)', C.gold],
  ].flatMap((item, i) => {
    const y = 2.0 + i * 1.05;
    return [
      rect(7.2, y, 5.2, 0.65, item[1], { rounding: 5000 }),
      textBox(7.2, y, 5.2, 0.65, [
        para(run(item[0], { sz: 950, color: C.white }), { algn: 'ctr' })
      ], { anchor: 'ctr' }),
      ...(i < 3 ? [
        textBox(9.55, y + 0.62, 0.5, 0.35, [
          para(run('\u25BC', { sz: 1200, color: C.teal }), { algn: 'ctr' })
        ])
      ] : []),
    ];
  })),
]));

// ── SLIDE 4: Why MCP for D365 F&O? (Layout 14 - 2 columns) ─────
slides.push({
  layout: 14,
  xml: slideXml([
    placeholder('title', 0, [
      para(run('Why MCP for D365 F&O?', { sz: 1800, bold: true, color: C.black }))
    ]),
    // Left column header
    placeholder('body', 28, [
      para(run('The Problem', { sz: 1200, bold: true, color: C.brick }))
    ]),
    // Left column content
    placeholder('body', 29, [
      ...([
        'AI LLMs have no knowledge of D365 F&O metadata \u2014 they hallucinate table names, field names, and join conditions',
        'D365 F&O has 17,000+ tables, 63,000+ classes, 820,000+ methods \u2014 impossible for LLMs to memorize',
        'Without metadata, every AI-generated SQL query, OData filter, or X++ code snippet is unreliable',
        'Support teams waste time verifying AI outputs against actual D365 schema',
      ].map(p => para([
        run('\u2716 ', { sz: 1000, bold: true, color: C.brick }),
        run(p, { sz: 900, color: C.dk })
      ], { spcAft: 300, lnSpc: 115000 })))
    ]),
    // Right column header
    placeholder('body', 34, [
      para(run('The MCP Solution', { sz: 1200, bold: true, color: C.teal }))
    ]),
    // Right column content
    placeholder('body', 35, [
      ...([
        'Real-time lookup of actual table schemas, fields, data types, and relations',
        'Validated join conditions with hallucination warnings for known LLM mistakes',
        'Full X++ source code for classes and methods \u2014 AI reads the real implementation',
        'Code dependency graph: who calls what, who extends what, full impact analysis',
      ].map(p => para([
        run('\u2714 ', { sz: 1000, bold: true, color: C.teal }),
        run(p, { sz: 900, color: C.dk })
      ], { spcAft: 300, lnSpc: 115000 })))
    ]),

    // Stats bar at bottom
    ...([
      ['17,000+', 'Tables'],
      ['63,000+', 'Classes'],
      ['820,000+', 'Methods'],
      ['369,000+', 'Labels'],
      ['26.6M', 'Cross-refs'],
      ['33', 'MCP Tools'],
    ].flatMap((s, i) => {
      const x = 0.59 + i * 2.05;
      return [
        rect(x, 5.55, 1.88, 1.0, i % 2 === 0 ? C.tealLt : C.white, { line: C.teal, lineW: 9525, rounding: 5000 }),
        textBox(x, 5.55, 1.88, 0.60, [
          para(run(s[0], { sz: 1600, bold: true, color: C.teal }), { algn: 'ctr' })
        ], { anchor: 'b' }),
        textBox(x, 6.15, 1.88, 0.35, [
          para(run(s[1], { sz: 900, color: C.gray }), { algn: 'ctr' })
        ]),
      ];
    })),
  ])
});

// ── SLIDE 5: KB Service (Layout 13) ─────────────────────────────
slides.push(contentSlide('MCP Service 1: Knowledge Base (KB)', [
  textBox(0.59, 1.32, 12.15, 0.30, [
    para(run('Structured D365 F&O metadata \u2014 tables, classes, enums, entities, security objects, labels, and X++ source code', { sz: 950, italic: true, color: C.gray }))
  ]),
  ...([
    { title: 'Schema & Lookup', color: C.teal, tools: [
      ['d365_lookup_table', 'Full table metadata (fields, indexes, relations)'],
      ['d365_check_field_exists', 'Validate field names with fuzzy suggestions'],
      ['d365_get_enum', 'Enum values with numeric IDs'],
      ['d365_get_join_keys', 'Join conditions with hallucination warnings'],
    ]},
    { title: 'Code & Search', color: C.gold, tools: [
      ['d365_get_class_methods', 'Method signatures + full X++ source'],
      ['d365_get_method_source', 'Complete X++ source code'],
      ['d365_search', 'Full-text search across all D365 objects'],
      ['d365_get_entity_sources', 'Data entity field mappings & OData names'],
    ]},
    { title: 'Safety & Reference', color: C.slate, tools: [
      ['d365_hallucination_check', 'Known LLM mistakes and corrections'],
      ['d365_sql_template', 'Pre-validated SQL query templates'],
      ['d365_field_renames', 'AX2012-to-D365 field name mappings'],
      ['d365_resolve_label', 'Label IDs (@SYS...) to display text'],
    ]},
  ].flatMap((cat, ci) => {
    const x = 0.59 + ci * 4.05;
    return [
      rect(x, 1.72, 3.88, 0.38, cat.color),
      textBox(x, 1.72, 3.88, 0.38, [
        para(run(cat.title, { sz: 1050, bold: true, color: C.white }), { algn: 'ctr' })
      ], { anchor: 'ctr' }),
      ...cat.tools.flatMap((tool, ti) => {
        const ty = 2.20 + ti * 0.73;
        return [
          textBox(x + 0.10, ty, 3.68, 0.68, [
            para(run(tool[0], { sz: 800, bold: true, color: C.dk, font: 'Consolas' }), { spcAft: 50 }),
            para(run(tool[1], { sz: 800, color: C.gray })),
          ]),
        ];
      }),
    ];
  })),
  // DB info bar
  rect(0.59, 5.30, 12.15, 0.55, C.tealLt, { rounding: 5000 }),
  textBox(0.75, 5.32, 11.83, 0.50, [
    para([
      run('Database: ', { sz: 850, bold: true, color: C.teal }),
      run('d365fo_kb.sqlite (1,063 MB)  \u2502  Built from D365 F&O XML metadata  \u2502  SQLite with better-sqlite3  \u2502  200 MB cache + 3 GB mmap I/O', { sz: 850, color: C.dk }),
    ])
  ], { anchor: 'ctr' }),
]));

// ── SLIDE 6: XRef Service (Layout 13) ───────────────────────────
slides.push(contentSlide('MCP Service 2: Cross-Reference (XRef)', [
  textBox(0.59, 1.32, 12.15, 0.30, [
    para(run('Code dependency graph \u2014 who calls, reads, extends, implements what \u2014 with line-level precision across 5.8M objects', { sz: 950, italic: true, color: C.gray }))
  ]),
  ...([
    { title: 'Reference Analysis', color: C.teal, tools: [
      ['xref_find_references', 'Who references this object? (incoming)'],
      ['xref_find_usages', 'What does this object use? (outgoing)'],
      ['xref_find_method_callers', 'All callers of a method + line numbers'],
      ['xref_method_references', 'Outgoing references from a method'],
    ]},
    { title: 'Hierarchy & Structure', color: C.brown, tools: [
      ['xref_class_hierarchy', 'Full inheritance tree (recursive)'],
      ['xref_interface_implementors', 'Classes implementing an interface'],
      ['xref_find_extensions', 'Chain of Command & table/form extensions'],
      ['xref_find_event_handlers', 'Event handlers and delegates'],
    ]},
    { title: 'Impact & Modules', color: C.brick, tools: [
      ['xref_impact_analysis', 'Change impact (direct + indirect)'],
      ['xref_cross_module_deps', 'Cross-module dependency analysis'],
      ['xref_find_field_usages', 'Code locations reading/writing a field'],
      ['xref_object_summary', 'Compact overview with reference counts'],
    ]},
  ].flatMap((cat, ci) => {
    const x = 0.59 + ci * 4.05;
    return [
      rect(x, 1.72, 3.88, 0.38, cat.color),
      textBox(x, 1.72, 3.88, 0.38, [
        para(run(cat.title, { sz: 1050, bold: true, color: C.white }), { algn: 'ctr' })
      ], { anchor: 'ctr' }),
      ...cat.tools.flatMap((tool, ti) => {
        const ty = 2.20 + ti * 0.73;
        return [
          textBox(x + 0.10, ty, 3.68, 0.68, [
            para(run(tool[0], { sz: 800, bold: true, color: C.dk, font: 'Consolas' }), { spcAft: 50 }),
            para(run(tool[1], { sz: 800, color: C.gray })),
          ]),
        ];
      }),
    ];
  })),
  rect(0.59, 5.30, 12.15, 0.55, C.tealLt, { rounding: 5000 }),
  textBox(0.75, 5.32, 11.83, 0.50, [
    para([
      run('Database: ', { sz: 850, bold: true, color: C.teal }),
      run('d365fo_xref.sqlite (3,300 MB)  \u2502  Built from VS LocalDB cross-reference data  \u2502  5.8M AOT paths  \u2502  26.6M references with kind, line & column', { sz: 850, color: C.dk }),
    ])
  ], { anchor: 'ctr' }),
]));

// ── SLIDE 7: Architecture (Layout 14 - 2 columns) ──────────────
slides.push({
  layout: 14,
  xml: slideXml([
    placeholder('title', 0, [
      para(run('Architecture Overview', { sz: 1800, bold: true, color: C.black }))
    ]),
    placeholder('body', 28, [
      para(run('Local Development (stdio)', { sz: 1100, bold: true, color: C.teal }))
    ]),
    placeholder('body', 34, [
      para(run('Azure Production (HTTP/SSE)', { sz: 1100, bold: true, color: C.teal }))
    ]),

    // Left column flow
    ...([
      ['Developer Machine', C.gray],
      ['Claude Code / Cursor / VS Code', C.slate],
      ['MCP Client (stdio transport)', C.gold],
      ['mcp-server-kb.js  |  mcp-server-xref.js', C.teal],
      ['SQLite databases (~4.4 GB on local disk)', C.brown],
    ].flatMap((item, i) => {
      const y = 1.95 + i * 0.82;
      return [
        rect(0.59, y, 5.78, 0.50, item[1], { rounding: 5000 }),
        textBox(0.59, y, 5.78, 0.50, [
          para(run(item[0], { sz: 850, color: C.white }), { algn: 'ctr' })
        ], { anchor: 'ctr' }),
        ...(i < 4 ? [textBox(3.20, y + 0.45, 0.55, 0.32, [
          para(run('\u25BC', { sz: 1000, color: C.teal }), { algn: 'ctr' })
        ])] : []),
      ];
    })),

    // Right column flow
    ...([
      ['Multiple Users / AI Assistants', C.gray],
      ['Any MCP Client (ChatGPT, Gemini, ...)', C.slate],
      ['HTTPS + Streamable HTTP transport', C.gold],
      ['Azure Function App (Node.js 20, Linux)', C.teal],
      ['SQLite on /home/data/ persistent storage', C.brown],
    ].flatMap((item, i) => {
      const y = 1.95 + i * 0.82;
      return [
        rect(6.96, y, 5.78, 0.50, item[1], { rounding: 5000 }),
        textBox(6.96, y, 5.78, 0.50, [
          para(run(item[0], { sz: 850, color: C.white }), { algn: 'ctr' })
        ], { anchor: 'ctr' }),
        ...(i < 4 ? [textBox(9.57, y + 0.45, 0.55, 0.32, [
          para(run('\u25BC', { sz: 1000, color: C.teal }), { algn: 'ctr' })
        ])] : []),
      ];
    })),

    // Key note
    rect(0.59, 6.05, 12.15, 0.45, C.tealLt, { rounding: 5000 }),
    textBox(0.75, 6.07, 11.83, 0.40, [
      para([
        run('Key: ', { sz: 850, bold: true, color: C.teal }),
        run('Shared tool logic (kb-tools.js + xref-tools.js) \u2014 only transport and DB initialization differ between deployments.', { sz: 850, color: C.dk }),
      ])
    ], { anchor: 'ctr' }),
  ])
});

// ── SLIDE 8: Data Update Pipeline (Layout 13) ──────────────────
slides.push(contentSlide('Data Update Pipeline: From D365 F&O to AI', [
  textBox(0.59, 1.32, 12.15, 0.30, [
    para(run('End-to-end flow from D365 F&O source metadata to running MCP services \u2014 fully automated via PowerShell scripts', { sz: 950, italic: true, color: C.gray }))
  ]),

  // Row 1: Source data
  textBox(0.59, 1.72, 1.20, 0.32, [
    para(run('SOURCE', { sz: 750, bold: true, color: C.white }), { algn: 'ctr' })
  ], { fill: C.gray, anchor: 'ctr' }),
  rect(1.90, 1.72, 4.80, 0.85, C.white, { line: C.teal, lineW: 9525, rounding: 5000 }),
  textBox(2.00, 1.74, 4.60, 0.40, [
    para(run('PackagesLocalDirectory (XML)', { sz: 850, bold: true, color: C.teal }))
  ]),
  textBox(2.00, 2.10, 4.60, 0.40, [
    para(run('Microsoft standard + ISV/custom models + label files (.label.txt)', { sz: 750, color: C.dk }))
  ]),
  rect(6.90, 1.72, 5.40, 0.85, C.white, { line: C.gold, lineW: 9525, rounding: 5000 }),
  textBox(7.00, 1.74, 5.20, 0.40, [
    para(run('Visual Studio LocalDB (SQL Server)', { sz: 850, bold: true, color: C.gold }))
  ]),
  textBox(7.00, 2.10, 5.20, 0.40, [
    para(run('Cross-reference data: 5.8M objects, 26.6M references with line numbers', { sz: 750, color: C.dk }))
  ]),

  // Arrow down
  textBox(6.00, 2.55, 1.2, 0.30, [
    para(run('\u25BC', { sz: 1100, color: C.teal }), { algn: 'ctr' })
  ]),

  // Row 2: Build scripts
  textBox(0.59, 2.85, 1.20, 0.32, [
    para(run('BUILD', { sz: 750, bold: true, color: C.white }), { algn: 'ctr' })
  ], { fill: C.teal, anchor: 'ctr' }),
  rect(1.90, 2.85, 4.80, 0.85, C.tealLt, { rounding: 5000 }),
  textBox(2.00, 2.87, 4.60, 0.40, [
    para([
      run('build-kb.js', { sz: 850, bold: true, color: C.teal, font: 'Consolas' }),
      run('  (~10 min)', { sz: 750, color: C.gray }),
    ])
  ]),
  textBox(2.00, 3.22, 4.60, 0.42, [
    para(run('Phase 0: Load 369K labels \u2192 Phase 1: Parse XML (10 object types, X++ source) \u2192 Phase 2: FTS index + curated data', { sz: 700, color: C.dk }), { lnSpc: 115000 })
  ]),
  rect(6.90, 2.85, 5.40, 0.85, C.tealLt, { rounding: 5000 }),
  textBox(7.00, 2.87, 5.20, 0.40, [
    para([
      run('build-xref-db.js', { sz: 850, bold: true, color: C.gold, font: 'Consolas' }),
      run('  (~22 min, 8 GB heap)', { sz: 750, color: C.gray }),
    ])
  ]),
  textBox(7.00, 3.22, 5.20, 0.42, [
    para(run('Stream Names in 500K batches + References in 1M batches from LocalDB \u2192 SQLite with 7 covering indexes', { sz: 700, color: C.dk }), { lnSpc: 115000 })
  ]),

  // Arrow down
  textBox(6.00, 3.68, 1.2, 0.30, [
    para(run('\u25BC', { sz: 1100, color: C.teal }), { algn: 'ctr' })
  ]),

  // Row 3: Output databases
  textBox(0.59, 3.98, 1.20, 0.32, [
    para(run('OUTPUT', { sz: 750, bold: true, color: C.white }), { algn: 'ctr' })
  ], { fill: C.brown, anchor: 'ctr' }),
  rect(1.90, 3.98, 4.80, 0.60, C.white, { line: C.teal, lineW: 9525, rounding: 5000 }),
  textBox(2.00, 4.00, 4.60, 0.55, [
    para([
      run('d365fo_kb.sqlite', { sz: 850, bold: true, color: C.teal, font: 'Consolas' }),
      run('  (1,063 MB)', { sz: 800, color: C.gray }),
    ]),
    para(run('18 tables: tables, fields, classes, methods, enums, entities, security, labels', { sz: 700, color: C.dk }))
  ]),
  rect(6.90, 3.98, 5.40, 0.60, C.white, { line: C.gold, lineW: 9525, rounding: 5000 }),
  textBox(7.00, 4.00, 5.20, 0.55, [
    para([
      run('d365fo_xref.sqlite', { sz: 850, bold: true, color: C.gold, font: 'Consolas' }),
      run('  (3,300 MB)', { sz: 800, color: C.gray }),
    ]),
    para(run('6 tables + 7 indexes: names, references (kind, line, col), modules, providers', { sz: 700, color: C.dk }))
  ]),

  // Arrow down
  textBox(6.00, 4.56, 1.2, 0.30, [
    para(run('\u25BC', { sz: 1100, color: C.teal }), { algn: 'ctr' })
  ]),

  // Row 4: Deployment
  textBox(0.59, 4.86, 1.20, 0.32, [
    para(run('DEPLOY', { sz: 750, bold: true, color: C.white }), { algn: 'ctr' })
  ], { fill: C.brick, anchor: 'ctr' }),
  rect(1.90, 4.86, 4.80, 0.85, C.white, { line: C.slate, lineW: 9525, rounding: 5000 }),
  textBox(2.00, 4.88, 4.60, 0.40, [
    para(run('Local: ~/.claude/', { sz: 850, bold: true, color: C.slate }))
  ]),
  textBox(2.00, 5.24, 4.60, 0.40, [
    para(run('Direct file access via stdio MCP servers. Build writes to local disk automatically.', { sz: 700, color: C.dk }), { lnSpc: 115000 })
  ]),
  rect(6.90, 4.86, 5.40, 0.85, C.white, { line: C.brick, lineW: 9525, rounding: 5000 }),
  textBox(7.00, 4.88, 5.20, 0.40, [
    para(run('Azure: /home/data/ (Kudu VFS upload)', { sz: 850, bold: true, color: C.brick }))
  ]),
  textBox(7.00, 5.24, 5.20, 0.40, [
    para(run('Deploy-Databases.ps1 uploads via Kudu API \u2192 restarts Function App \u2192 validates health checks.', { sz: 700, color: C.dk }), { lnSpc: 115000 })
  ]),
]));

// ── SLIDE 9: PowerShell Scripts (Layout 13) ─────────────────────
slides.push(contentSlide('Automation: PowerShell Scripts', [
  textBox(0.59, 1.32, 12.15, 0.30, [
    para(run('Complete automation from configuration discovery to database build, deployment, and validation', { sz: 950, italic: true, color: C.gray }))
  ]),
  ...([
    {
      title: 'Update-Databases.ps1',
      subtitle: 'Smart orchestrator (recommended)',
      color: C.teal,
      items: [
        'Reads D365 F&O XPP configurations automatically',
        'Detects active config from Windows registry',
        'Extracts PackagesLocalDirectory + LocalDB paths',
        'Stops running MCP servers (releases file locks)',
        'Starts LocalDB if needed, validates all paths',
        'Calls build scripts with correct memory flags',
      ]
    },
    {
      title: 'Deploy-Databases.ps1',
      subtitle: 'Azure upload + restart',
      color: C.brick,
      items: [
        'Uploads SQLite files via Kudu VFS API (HTTPS PUT)',
        'Restarts Function App to release file locks',
        'Waits for cold start, validates health endpoints',
        'Supports -KbOnly, -XrefOnly, -SkipRestart flags',
      ]
    },
    {
      title: 'Deploy-FunctionApp.ps1',
      subtitle: 'Full code + data deployment',
      color: C.gold,
      items: [
        'Uploads databases + application code',
        'Runs npm install --omit=dev for production',
        'Cross-installs Linux better-sqlite3 binary',
        'Deploys via az functionapp config-zip',
      ]
    },
    {
      title: 'Get-D365Configurations.ps1',
      subtitle: 'Configuration inspector',
      color: C.slate,
      items: [
        'Exports all XPP configs as structured XML',
        'Reads JSON configs, folder configs, registry',
        'Shows versions, paths, active configuration',
        'Useful for auditing multi-environment setups',
      ]
    },
  ].flatMap((s, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = 0.59 + col * 6.18;
    const y = 1.72 + row * 2.15;
    return [
      rect(x, y, 6.01, 0.38, s.color),
      textBox(x, y, 6.01, 0.38, [
        para([
          run(s.title, { sz: 950, bold: true, color: C.white, font: 'Consolas' }),
          run('  \u2014 ' + s.subtitle, { sz: 850, color: C.white }),
        ], { algn: 'ctr' })
      ], { anchor: 'ctr' }),
      rect(x, y + 0.38, 6.01, 1.60, C.white, { line: s.color, lineW: 6350 }),
      textBox(x + 0.15, y + 0.45, 5.71, 1.45,
        s.items.map(item => para([
          run('\u2022 ', { sz: 800, bold: true, color: s.color }),
          run(item, { sz: 800, color: C.dk })
        ], { spcAft: 50 }))
      ),
    ];
  })),

  // Command examples bar
  rect(0.59, 5.35, 12.15, 0.50, C.bgPanel, { rounding: 5000 }),
  textBox(0.75, 5.37, 11.83, 0.46, [
    para([
      run('Quick start: ', { sz: 800, bold: true, color: C.teal }),
      run('.\\Update-Databases.ps1', { sz: 800, color: C.dk, font: 'Consolas' }),
      run('  \u2192  ', { sz: 800, color: C.gray }),
      run('.\\Deploy-Databases.ps1 -Environment d', { sz: 800, color: C.dk, font: 'Consolas' }),
      run('  \u2192  AI tools have fresh data', { sz: 800, color: C.gray }),
    ])
  ], { anchor: 'ctr' }),
]));

// ── SLIDE 10: Microsoft Updates & ISV Extensions (Layout 14) ────
slides.push({
  layout: 14,
  xml: slideXml([
    placeholder('title', 0, [
      para(run('Keeping Data Current: Updates & Extensions', { sz: 1800, bold: true, color: C.black }))
    ]),
    placeholder('body', 28, [
      para(run('Microsoft D365 F&O Updates', { sz: 1100, bold: true, color: C.teal }))
    ]),
    placeholder('body', 29, [
      para(run('When a new D365 F&O version is installed:', { sz: 900, bold: true, color: C.dk }), { spcAft: 200 }),
      ...[
        ['1.', 'New PackagesLocalDirectory is created with updated XML metadata (new tables, fields, classes, methods)'],
        ['2.', 'New LocalDB cross-reference database is populated by Visual Studio with updated code references'],
        ['3.', 'D365 XPP configuration is updated automatically, pointing to the new version paths'],
        ['4.', 'Run Update-Databases.ps1 \u2014 it auto-detects the new config and rebuilds both databases from the new source'],
        ['5.', 'Run Deploy-Databases.ps1 to push updated databases to Azure for all users'],
      ].map(item => para([
        run(item[0] + ' ', { sz: 850, bold: true, color: C.teal }),
        run(item[1], { sz: 800, color: C.dk }),
      ], { spcAft: 150, lnSpc: 115000 })),
      para(run(''), { spcAft: 100 }),
      para([
        run('Result: ', { sz: 850, bold: true, color: C.teal }),
        run('All new Microsoft tables, fields, classes, enums, labels, and code dependencies are immediately available to every AI assistant.', { sz: 800, color: C.dk }),
      ], { lnSpc: 115000 }),
    ]),
    placeholder('body', 34, [
      para(run('ISV & Custom Extensions', { sz: 1100, bold: true, color: C.gold }))
    ]),
    placeholder('body', 35, [
      para(run('When ISV or custom models change:', { sz: 900, bold: true, color: C.dk }), { spcAft: 200 }),
      ...[
        ['KB:', 'build-kb.js scans both Microsoft PackagesLocalDirectory and ISV ModelStoreFolder together. All custom tables, classes, entities, and labels are included in a single unified database.'],
        ['XRef:', 'ISV code references require running "Dynamics 365 \u2192 Build Cross Reference Data" in Visual Studio first. This populates LocalDB with ISV references. Then rebuild with Update-Databases.ps1.'],
        ['Deploy:', 'Same deployment process \u2014 Deploy-Databases.ps1 uploads the unified databases containing both Microsoft standard and ISV/custom metadata.'],
      ].map(item => para([
        run(item[0] + ' ', { sz: 850, bold: true, color: C.gold }),
        run(item[1], { sz: 800, color: C.dk }),
      ], { spcAft: 200, lnSpc: 115000 })),
      para(run(''), { spcAft: 100 }),
      para([
        run('Key: ', { sz: 850, bold: true, color: C.gold }),
        run('ISV and custom models are first-class citizens \u2014 AI assistants see the complete D365 environment, not just Microsoft standard.', { sz: 800, color: C.dk }),
      ], { lnSpc: 115000 }),
    ]),
  ])
});

// ── SLIDE 11: Before/After Support Tickets ───────────────────────
slides.push(comparisonSlide(
  'Before & After: Support Tickets',
  'WITHOUT MCP',
  [
    para(run('User asks: "Which table stores purchase order headers?"', { sz: 900, italic: true, color: C.dk }), { spcAft: 300 }),
    para(run('AI responds:', { sz: 900, bold: true, color: C.gray }), { spcAft: 100 }),
    para(run('"The purchase order headers are stored in the PurchOrderHeader table with fields like PurchOrderId, VendorAccount, OrderDate..."', { sz: 900, color: C.brick, font: 'Consolas' }), { lnSpc: 120000, spcAft: 300 }),
    para([
      run('\u26A0 WRONG! ', { sz: 900, bold: true, color: C.brick }),
      run('The actual table is ', { sz: 900, color: C.brick }),
      run('PurchTable', { sz: 900, bold: true, color: C.brick }),
      run('. Field VendorAccount is actually ', { sz: 900, color: C.brick }),
      run('OrderAccount', { sz: 900, bold: true, color: C.brick }),
      run('. The AI hallucinated plausible-sounding but incorrect names.', { sz: 900, color: C.brick }),
    ], { lnSpc: 120000, spcAft: 300 }),
    para(run('Consequence: Developer writes code against non-existent table \u2192 compile error \u2192 time wasted researching the correct schema manually.', { sz: 850, color: C.gray }), { lnSpc: 120000 }),
  ],
  'WITH MCP',
  [
    para(run('Same question \u2014 AI automatically calls d365_search + d365_lookup_table', { sz: 900, italic: true, color: C.dk }), { spcAft: 300 }),
    para(run('AI responds (after MCP lookup):', { sz: 900, bold: true, color: C.gray }), { spcAft: 100 }),
    para(run('"Purchase order headers are in PurchTable. Key fields: PurchId (PK), OrderAccount (vendor), PurchStatus (enum), InvoiceAccount, DeliveryDate, CurrencyCode..."', { sz: 900, color: C.greenOk, font: 'Consolas' }), { lnSpc: 120000, spcAft: 300 }),
    para([
      run('\u2714 CORRECT! ', { sz: 900, bold: true, color: C.greenOk }),
      run('MCP verified the actual table name, returned real field names with data types, and flagged that ', { sz: 900, color: C.greenOk }),
      run('OrderAccount', { sz: 900, bold: true, color: C.greenOk }),
      run(' (not VendorAccount) is the correct vendor field.', { sz: 900, color: C.greenOk }),
    ], { lnSpc: 120000, spcAft: 300 }),
    para(run('Result: Developer gets accurate schema info instantly \u2192 correct code first time \u2192 no back-and-forth with documentation.', { sz: 850, color: C.gray }), { lnSpc: 120000 }),
  ]
));

// ── SLIDE 9: Before/After SQL ───────────────────────────────────
slides.push(comparisonSlide(
  'Before & After: SQL Queries',
  'WITHOUT MCP',
  [
    para(run('"Give me SQL to find open sales orders with customer details"', { sz: 900, italic: true, color: C.dk }), { spcAft: 300 }),
    para(run('SELECT s.SalesOrderId, s.CustomerAccount,\n       c.CustomerName, s.OrderStatus\nFROM   SalesOrderHeader s\nJOIN   CustomerMaster c\n  ON   s.CustomerAccount = c.AccountNum\nWHERE  s.OrderStatus = \'Open\'', { sz: 800, color: C.brick, font: 'Consolas' }), { lnSpc: 110000, spcAft: 300 }),
    para(run('\u26A0 Every name is wrong:', { sz: 900, bold: true, color: C.brick }), { spcAft: 100 }),
    ...[
      'SalesOrderHeader \u2192 SalesTable',
      'SalesOrderId \u2192 SalesId',
      'CustomerMaster \u2192 CustTable',
      'CustomerName \u2192 name() method',
      'OrderStatus \u2192 SalesStatus',
      '\'Open\' \u2192 enum value 1 (Backorder)',
    ].map(t => para(run('\u2022 ' + t, { sz: 800, color: C.dk }), { spcAft: 0 })),
  ],
  'WITH MCP',
  [
    para(run('AI calls d365_lookup_table, d365_get_join_keys, d365_get_enum first', { sz: 900, italic: true, color: C.dk }), { spcAft: 300 }),
    para(run('SELECT st.SalesId, st.CustAccount,\n       ct.Name AS CustomerName,\n       st.SalesStatus\nFROM   SalesTable st\nJOIN   CustTable ct\n  ON   st.CustAccount = ct.AccountNum\nWHERE  st.SalesStatus = 1  -- Backorder', { sz: 800, color: C.greenOk, font: 'Consolas' }), { lnSpc: 110000, spcAft: 300 }),
    para(run('\u2714 Every name is validated:', { sz: 900, bold: true, color: C.greenOk }), { spcAft: 100 }),
    ...[
      'MCP verified SalesTable schema and field names',
      'd365_get_join_keys confirmed CustAccount \u2192 AccountNum',
      'd365_get_enum returned SalesStatus values',
      'd365_hallucination_check flagged common mistakes',
    ].map(t => para(run('\u2022 ' + t, { sz: 800, color: C.dk }), { spcAft: 0 })),
  ]
));

// ── SLIDE 10: Before/After OData ────────────────────────────────
slides.push(comparisonSlide(
  'Before & After: OData Queries',
  'WITHOUT MCP',
  [
    para(run('"Build an OData query for vendor invoices with payment status"', { sz: 900, italic: true, color: C.dk }), { spcAft: 300 }),
    para(run('GET /data/VendorInvoices?\n  $filter=PaymentStatus eq \'Pending\'\n  &$select=InvoiceNumber,VendorName,\n    Amount,DueDate,PaymentStatus', { sz: 800, color: C.brick, font: 'Consolas' }), { lnSpc: 110000, spcAft: 300 }),
    para(run('\u26A0 Problems:', { sz: 900, bold: true, color: C.brick }), { spcAft: 100 }),
    ...[
      'Entity name VendorInvoices doesn\'t exist',
      'OData field names differ from table fields',
      'PaymentStatus is not a valid filter field',
      'No way for AI to discover available entities',
      'Result: 404 errors, trial-and-error debugging',
    ].map(t => para(run('\u2022 ' + t, { sz: 800, color: C.dk }), { spcAft: 0 })),
  ],
  'WITH MCP',
  [
    para(run('AI calls d365_search + d365_get_entity_sources first', { sz: 900, italic: true, color: C.dk }), { spcAft: 300 }),
    para(run('GET /data/VendInvoiceJour?\n  $filter=Approved eq\n    Microsoft.Dynamics.DataEntities.\n    NoYes\'Yes\'\n  &$select=InvoiceId,InvoiceAccount,\n    InvoiceAmount,DueDate', { sz: 800, color: C.greenOk, font: 'Consolas' }), { lnSpc: 110000, spcAft: 300 }),
    para(run('\u2714 MCP provided:', { sz: 900, bold: true, color: C.greenOk }), { spcAft: 100 }),
    ...[
      'Exact entity name and OData property names',
      'Data entity field mappings (table \u2192 OData)',
      'Available filter fields and data types',
      'Working query on first attempt',
    ].map(t => para(run('\u2022 ' + t, { sz: 800, color: C.dk }), { spcAft: 0 })),
  ]
));

// ── SLIDE 11: Before/After BI ───────────────────────────────────
slides.push(comparisonSlide(
  'Before & After: BI Reporting',
  'WITHOUT MCP',
  [
    para(run('"Help me build a Power BI report for inventory by warehouse"', { sz: 900, italic: true, color: C.dk }), { spcAft: 300 }),
    para(run('AI suggests:', { sz: 900, bold: true, color: C.gray }), { spcAft: 100 }),
    ...[
      'InventoryOnHand (not a real table)',
      'ProductMaster (wrong \u2014 it\'s EcoResProduct)',
      'WarehouseTable (wrong \u2014 it\'s InventLocation)',
      'Joining on \'ProductId\' (doesn\'t exist)',
    ].map(t => para(run('\u2022 ' + t, { sz: 850, color: C.brick }), { spcAft: 50 })),
    para(run('Consequences:', { sz: 900, bold: true, color: C.brick }), { spcBef: 200, spcAft: 100 }),
    ...[
      'Hours wasted finding correct tables',
      'Wrong joins \u2192 wrong aggregations',
      'Business decisions based on wrong data',
    ].map(t => para(run('\u2022 ' + t, { sz: 800, color: C.dk }), { spcAft: 0 })),
  ],
  'WITH MCP',
  [
    para(run('AI calls d365_search, d365_lookup_table, d365_get_join_keys', { sz: 900, italic: true, color: C.dk }), { spcAft: 300 }),
    para(run('Verified data model:', { sz: 900, bold: true, color: C.gray }), { spcAft: 100 }),
    ...[
      'InventSum \u2014 on-hand inventory by dimension',
      'InventDim \u2014 warehouse + site + config dims',
      'InventTable \u2014 product master (ItemId)',
      'InventItemGroup \u2014 product grouping',
      'Validated joins: InventDimId, ItemId, ItemGroupId',
    ].map(t => para(run('\u2022 ' + t, { sz: 850, color: C.greenOk }), { spcAft: 50 })),
    para(run('Benefits:', { sz: 900, bold: true, color: C.greenOk }), { spcBef: 200, spcAft: 100 }),
    ...[
      'Correct table/field names from the start',
      'Report built correctly on first iteration',
    ].map(t => para(run('\u2022 ' + t, { sz: 800, color: C.dk }), { spcAft: 0 })),
  ]
));

// ── SLIDE 12: Before/After Impact Analysis ──────────────────────
slides.push(comparisonSlide(
  'Before & After: Code Change Impact Analysis',
  'WITHOUT MCP',
  [
    para(run('"I need to modify PurchTable.confirmPurchOrder. What will be affected?"', { sz: 900, italic: true, color: C.dk }), { spcAft: 300 }),
    para(run('AI guesses:', { sz: 900, bold: true, color: C.gray }), { spcAft: 100 }),
    ...[
      '"Probably called from PurchFormLetter" (maybe)',
      '"Check for event handlers" (can\'t tell which)',
      '"There might be extensions" (can\'t verify)',
      '"Other modules may depend on it" (unclear which)',
    ].map(t => para(run('\u2022 ' + t, { sz: 850, color: C.brick }), { spcAft: 50 })),
    para(run('Developer must:', { sz: 900, bold: true, color: C.brick }), { spcBef: 200, spcAft: 100 }),
    ...[
      'Manually search Visual Studio for references',
      'Check each module one by one',
      'Risk: untested downstream breakage in production',
    ].map(t => para(run('\u2022 ' + t, { sz: 800, color: C.dk }), { spcAft: 0 })),
  ],
  'WITH MCP (XRef Service)',
  [
    para(run('AI calls xref_impact_analysis + xref_find_extensions + xref_find_event_handlers', { sz: 900, italic: true, color: C.dk }), { spcAft: 300 }),
    para(run('Complete impact report:', { sz: 900, bold: true, color: C.gray }), { spcAft: 100 }),
    ...[
      '12 direct callers (with file + line numbers)',
      '3 Chain of Command extensions (ISV modules)',
      '2 event handlers (pre/post)',
      '47 indirect dependents across 5 modules',
      'Cross-module dependency map',
    ].map(t => para(run('\u2022 ' + t, { sz: 850, color: C.greenOk }), { spcAft: 50 })),
    para(run('Developer gets:', { sz: 900, bold: true, color: C.greenOk }), { spcBef: 200, spcAft: 100 }),
    ...[
      'Full blast radius before making any change',
      'ISV extensions that need compatibility checks',
      'Confidence to make changes safely',
    ].map(t => para(run('\u2022 ' + t, { sz: 800, color: C.dk }), { spcAft: 0 })),
  ]
));

// ── SLIDE 13: Who Benefits (Layout 13) ──────────────────────────
slides.push(contentSlide('Who Benefits from MCP?', [
  ...([
    { title: 'D365 Developers', color: C.teal, items: ['Accurate X++ code generation', 'Verified table schemas', 'Impact analysis before changes', 'Faster debugging with real source'] },
    { title: 'Functional Consultants', color: C.gold, items: ['Quick schema lookups', 'Entity/field mapping for integrations', 'Enum value references', 'Label resolution for UI text'] },
    { title: 'Support Teams', color: C.brown, items: ['Instant table/field verification', 'Pre-validated SQL templates', 'Faster ticket resolution', 'No more guessing at field names'] },
    { title: 'BI / Data Teams', color: C.slate, items: ['Correct D365 data models', 'Verified join conditions', 'Entity-to-table field mappings', 'Reliable Power BI reports'] },
    { title: 'Integration Devs', color: C.brick, items: ['Accurate OData entity names', 'Data entity field mapping', 'API endpoint discovery', 'Correct filter/query syntax'] },
    { title: 'Project Managers', color: C.gray, items: ['Change impact assessment', 'Cross-module visibility', 'Risk evaluation for mods', 'Faster delivery cycles'] },
  ].flatMap((p, i) => {
    const col = i % 3;
    const row = Math.floor(i / 3);
    const x = 0.59 + col * 4.05;
    const y = 1.40 + row * 2.50;
    return [
      rect(x, y, 3.88, 0.40, p.color),
      textBox(x, y, 3.88, 0.40, [
        para(run(p.title, { sz: 1000, bold: true, color: C.white }), { algn: 'ctr' })
      ], { anchor: 'ctr' }),
      rect(x, y + 0.40, 3.88, 1.85, C.white, { line: p.color, lineW: 9525 }),
      textBox(x + 0.15, y + 0.50, 3.58, 1.65,
        p.items.map(item => para([
          run('\u2022 ', { sz: 850, bold: true, color: p.color }),
          run(item, { sz: 850, color: C.dk })
        ], { spcAft: 100 }))
      ),
    ];
  }))
]));

// ── SLIDE 14: Future MCP Services (Layout 13) ───────────────────
slides.push(contentSlide('Future MCP Services: Additional Value Opportunities', [
  textBox(0.59, 1.32, 12.15, 0.30, [
    para(run('Potential MCP services that would extend AI capabilities for D365 F&O and beyond', { sz: 950, italic: true, color: C.gray }))
  ]),
  ...([
    { title: 'D365 Security Model', desc: 'Expose roles, duties, privileges, and permission mappings. Answer: "Which role grants access to PurchTable?"', impact: 'Security audits, compliance reporting', color: C.brick },
    { title: 'Configuration & Parameters', desc: 'Surface module parameters, number sequences, config keys. Validate features before suggesting code.', impact: 'Environment-aware AI assistance', color: C.teal },
    { title: 'Azure DevOps / ALM Integration', desc: 'Connect work items, pipelines, deployment history. Link code changes to requirements.', impact: 'End-to-end traceability, release notes', color: C.gold },
    { title: 'Data Dictionary & ERD', desc: 'Generate ER diagrams, data flow maps, field-level lineage for complex integrations.', impact: 'Faster onboarding, integration specs', color: C.brown },
    { title: 'Power Platform / Dataverse', desc: 'Expose Dataverse schemas, Power Automate flows, Power Apps connections.', impact: 'Unified cross-platform AI assistance', color: C.slate },
    { title: 'Performance & Telemetry', desc: 'Surface App Insights traces, slow queries, batch job data. Proactive optimization suggestions.', impact: 'Performance tuning, root-cause analysis', color: C.gray },
  ].flatMap((s, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = 0.59 + col * 6.18;
    const y = 1.72 + row * 1.40;
    return [
      // Accent bar left
      rect(x, y, 0.06, 1.20, s.color),
      rect(x + 0.06, y, 5.95, 1.20, C.white, { line: C.lt, lineW: 6350 }),
      textBox(x + 0.18, y + 0.05, 5.72, 0.28, [
        para(run(s.title, { sz: 950, bold: true, color: s.color }))
      ]),
      textBox(x + 0.18, y + 0.32, 5.72, 0.48, [
        para(run(s.desc, { sz: 800, color: C.dk }), { lnSpc: 120000 })
      ]),
      textBox(x + 0.18, y + 0.82, 5.72, 0.30, [
        para([
          run('Impact: ', { sz: 750, bold: true, color: s.color }),
          run(s.impact, { sz: 750, color: C.gray }),
        ])
      ]),
    ];
  }))
]));

// ── SLIDE 15: How to Get Started (Layout 14 - 2 columns) ───────
slides.push({
  layout: 14,
  xml: slideXml([
    placeholder('title', 0, [
      para(run('How to Get Started', { sz: 1800, bold: true, color: C.black }))
    ]),
    placeholder('body', 28, [
      para(run('Azure (Remote) \u2014 for all users', { sz: 1100, bold: true, color: C.teal }))
    ]),
    placeholder('body', 29, [
      para(run('{\n  "mcpServers": {\n    "d365kb": {\n      "type": "url",\n      "url": "https://tis-p-mcpd365fo-\n        func.azurewebsites.net\n        /api/d365kb"\n    },\n    "d365xref": {\n      "type": "url",\n      "url": "https://tis-p-mcpd365fo-\n        func.azurewebsites.net\n        /api/d365xref"\n    }\n  }\n}', { sz: 800, color: C.dk, font: 'Consolas' }), { lnSpc: 105000 }),
    ]),
    placeholder('body', 34, [
      para(run('Local (stdio) \u2014 for developers', { sz: 1100, bold: true, color: C.gold }))
    ]),
    placeholder('body', 35, [
      para(run('{\n  "mcpServers": {\n    "d365kb": {\n      "type": "stdio",\n      "command": "node",\n      "args": ["...src/local/\n        mcp-server-kb.js"]\n    },\n    "d365xref": {\n      "type": "stdio",\n      "command": "node",\n      "args": ["...src/local/\n        mcp-server-xref.js"]\n    }\n  }\n}', { sz: 800, color: C.dk, font: 'Consolas' }), { lnSpc: 105000 }),
    ]),

    // Client badges
    textBox(0.59, 5.50, 3, 0.30, [
      para(run('Supported AI clients:', { sz: 1000, bold: true, color: C.dk }))
    ]),
    ...([
      ['Claude Code', C.teal], ['Claude Desktop', C.teal],
      ['GitHub Copilot', C.gray], ['Cursor', C.slate],
      ['ChatGPT', C.dk], ['Gemini', C.gold],
    ].flatMap((cl, i) => {
      const x = 0.59 + i * 2.05;
      return [
        rect(x, 5.90, 1.90, 0.48, cl[1], { rounding: 8000 }),
        textBox(x, 5.90, 1.90, 0.48, [
          para(run(cl[0], { sz: 850, color: C.white }), { algn: 'ctr' })
        ], { anchor: 'ctr' }),
      ];
    })),
  ])
});

// ── SLIDE 16: Summary (Layout 13) ───────────────────────────────
slides.push(contentSlide('Summary & Key Takeaways', [
  ...([
    ['MCP eliminates AI hallucinations for D365 F&O', 'Real-time access to actual metadata means every table name, field name, join condition, and enum value is verified.'],
    ['Two complementary services cover schema + code', 'Knowledge Base provides structured metadata. Cross-Reference provides the dependency graph with impact analysis.'],
    ['33 specialized tools for every D365 task', 'From simple field lookups to full impact analysis \u2014 purpose-built tools AI assistants call automatically.'],
    ['Works with any MCP-compatible AI assistant', 'Claude, Copilot, Cursor, ChatGPT, Gemini \u2014 one investment, universal access. Local or Azure deployment.'],
    ['Measurable productivity gains across all roles', 'Developers, consultants, support, BI, integration developers, and project managers all benefit.'],
  ].flatMap((t, i) => {
    const y = 1.40 + i * 0.92;
    return [
      rect(0.59, y + 0.03, 0.42, 0.42, C.teal, { rounding: 50000 }),
      textBox(0.59, y + 0.03, 0.42, 0.42, [
        para(run(String(i + 1), { sz: 1200, bold: true, color: C.white }), { algn: 'ctr' })
      ], { anchor: 'ctr' }),
      textBox(1.15, y, 11.5, 0.32, [
        para(run(t[0], { sz: 1200, bold: true, color: C.dk }))
      ]),
      textBox(1.15, y + 0.35, 11.5, 0.45, [
        para(run(t[1], { sz: 900, color: C.gray }), { lnSpc: 120000 })
      ]),
    ];
  }))
]));

// ── SLIDE 17: End (Layout 40) ───────────────────────────────────
slides.push({
  layout: 40,
  xml: slideXml([]) // End layout is self-contained
});


// ══════════════════════════════════════════════════════════════════
// Assemble the PPTX
// ══════════════════════════════════════════════════════════════════

const zip = new AdmZip(TEMPLATE);

// 1. Remove existing slides + their rels + tags
for (let i = 1; i <= 4; i++) {
  zip.deleteFile(`ppt/slides/slide${i}.xml`);
  zip.deleteFile(`ppt/slides/_rels/slide${i}.xml.rels`);
}
// Only remove tags/embeddings that belong to the OLD slides (not slide masters!)
// Tags 1-3 belong to presentation + slide masters; tags 4-6 belong to old slides
for (let i = 4; i <= 6; i++) zip.deleteFile(`ppt/tags/tag${i}.xml`);
// OleObjects 1-2 belong to slide masters; 3-4 belong to old slides
for (let i = 3; i <= 4; i++) zip.deleteFile(`ppt/embeddings/oleObject${i}.bin`);

// 2. Add new slides
slides.forEach((s, i) => {
  const num = i + 1;
  zip.addFile(`ppt/slides/slide${num}.xml`, Buffer.from(s.xml, 'utf-8'));
  zip.addFile(`ppt/slides/_rels/slide${num}.xml.rels`, Buffer.from(slideRels(s.layout), 'utf-8'));
});

// 3. Update presentation.xml — replace slide ID list
let presXml = zip.readAsText('ppt/presentation.xml');
const slideIdEntries = slides.map((_, i) => {
  const sldId = 300 + i;
  return `<p:sldId id="${sldId}" r:id="rId${100 + i}"/>`;
}).join('');
presXml = presXml.replace(/<p:sldIdLst>[\s\S]*?<\/p:sldIdLst>/, `<p:sldIdLst>${slideIdEntries}</p:sldIdLst>`);
zip.addFile('ppt/presentation.xml', Buffer.from(presXml, 'utf-8'));

// 4. Update presentation.xml.rels — replace slide relationships
let presRels = zip.readAsText('ppt/_rels/presentation.xml.rels');
// Remove old slide relationships (rId6-9)
presRels = presRels.replace(/<Relationship[^>]*Target="slides\/slide\d+\.xml"[^>]*\/>/g, '');
// Add new slide relationships
const newSlideRels = slides.map((_, i) => {
  const num = i + 1;
  return `<Relationship Id="rId${100 + i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${num}.xml"/>`;
}).join('');
presRels = presRels.replace('</Relationships>', newSlideRels + '</Relationships>');
zip.addFile('ppt/_rels/presentation.xml.rels', Buffer.from(presRels, 'utf-8'));

// 5. Update [Content_Types].xml — replace slide entries
let contentTypes = zip.readAsText('[Content_Types].xml');
// Remove old slide overrides only
contentTypes = contentTypes.replace(/<Override PartName="\/ppt\/slides\/slide\d+\.xml"[^>]*\/>/g, '');
// Only remove overrides for tags/ole that we deleted (4-6 and 3-4)
contentTypes = contentTypes.replace(/<Override PartName="\/ppt\/tags\/tag[4-6]\.xml"[^>]*\/>/g, '');
contentTypes = contentTypes.replace(/<Override PartName="\/ppt\/embeddings\/oleObject[34]\.bin"[^>]*\/>/g, '');
// Add new slide overrides
const newSlideTypes = slides.map((_, i) => {
  const num = i + 1;
  return `<Override PartName="/ppt/slides/slide${num}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`;
}).join('');
contentTypes = contentTypes.replace('</Types>', newSlideTypes + '</Types>');
zip.addFile('[Content_Types].xml', Buffer.from(contentTypes, 'utf-8'));

// 6. Write output
zip.writeZip(OUTPUT);
console.log(`Presentation saved to: ${OUTPUT}`);
console.log(`  ${slides.length} slides generated using Trelleborg template layouts`);
