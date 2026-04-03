/**
 * D365 F&O MCP Services — Technical Deep Dive Presentation Generator
 *
 * Generates a technical presentation covering architecture, implementation,
 * Azure Functions, named pipes, SQLite, PowerShell, security, database
 * build scripts, and cost estimation.
 *
 * No business cases — purely technical content.
 */
const AdmZip = require('adm-zip');
const path = require('path');

const TEMPLATE = path.resolve(__dirname, '..', 'templates', 'trelleborg template.pptx');
const OUTPUT   = path.resolve(__dirname, '..', 'D365FO_MCP_Technical_Deep_Dive.pptx');

// EMU helpers (1 inch = 914400 EMU)
const IN = v => Math.round(v * 914400);
const PT = v => Math.round(v * 12700);

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
  code:     '1E1E1E', codeBg:  '2D2D2D',
  blue:     '1565C0', blueLt:  'E3F2FD',
};

// ──────────────────────────────────────────────────────────────────
// XML building helpers
// ──────────────────────────────────────────────────────────────────

let nextId = 100;
function id() { return nextId++; }

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function run(text, opts = {}) {
  const sz = opts.sz || 1100;
  const color = opts.color || C.dk;
  const bold = opts.bold ? ' b="1"' : '';
  const italic = opts.italic ? ' i="1"' : '';
  const font = opts.font || 'Arial';
  const spc = opts.spc ? ` spc="${opts.spc}"` : '';
  return `<a:r><a:rPr lang="en-US" sz="${sz}"${bold}${italic}${spc} dirty="0"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:latin typeface="${esc(font)}"/><a:cs typeface="${esc(font)}"/></a:rPr><a:t>${esc(text)}</a:t></a:r>`;
}

function para(runs, opts = {}) {
  const algn = opts.algn ? ` algn="${opts.algn}"` : '';
  const spcBef = opts.spcBef ? `<a:spcBef><a:spcPts val="${opts.spcBef}"/></a:spcBef>` : '';
  const spcAft = opts.spcAft ? `<a:spcAft><a:spcPts val="${opts.spcAft}"/></a:spcAft>` : '';
  const lnSpc = opts.lnSpc ? `<a:lnSpc><a:spcPct val="${opts.lnSpc}"/></a:lnSpc>` : '';
  const bullet = opts.bullet ? '<a:buChar char="\u2022"/>' : (opts.noBullet ? '<a:buNone/>' : '');
  const indent = opts.indent ? ` indent="${opts.indent}" marL="${opts.marL || 0}"` : '';
  return `<a:p><a:pPr${algn}${indent}>${spcBef}${spcAft}${lnSpc}${bullet}</a:pPr>${typeof runs === 'string' ? runs : runs.join('')}<a:endParaRPr lang="en-US" dirty="0"/></a:p>`;
}

function textBox(x, y, w, h, paragraphs, opts = {}) {
  const anchor = opts.anchor || 't';
  const wrap = opts.wrap !== false ? 'square' : 'none';
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

/** Standard content slide using Layout 13 */
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

// Helper: code block (dark background monospace text)
function codeBlock(x, y, w, h, lines) {
  return textBox(x, y, w, h,
    lines.map(l => para(run(l, { sz: 700, color: C.white, font: 'Consolas' }), { lnSpc: 105000 })),
    { fill: C.codeBg, rounding: 5000, lIns: 72000, tIns: 54000, rIns: 72000, bIns: 54000 }
  );
}

// Helper: labeled arrow flow (vertical)
function flowArrow(x, y) {
  return textBox(x, y, 0.55, 0.30, [
    para(run('\u25BC', { sz: 1000, color: C.teal }), { algn: 'ctr' })
  ]);
}

// ──────────────────────────────────────────────────────────────────
// Build all slides
// ──────────────────────────────────────────────────────────────────

const slides = [];

// ═══════════════════════════════════════════════════════════════════
// SLIDE 1: Title
// ═══════════════════════════════════════════════════════════════════
slides.push({
  layout: 2,
  xml: slideXml([
    placeholder('title', 0, [
      para(run('D365 F&O MCP Services', { sz: 3100, color: C.white }))
    ]),
    placeholder('body', 13, [
      para(run('Technical Deep Dive', { sz: 1800, bold: true, color: C.white }))
    ]),
    placeholder('body', 14, [
      para(run('Architecture, Implementation, Security & Operations', { sz: 1400, color: C.white }))
    ]),
  ])
});

// ═══════════════════════════════════════════════════════════════════
// SLIDE 2: Agenda
// ═══════════════════════════════════════════════════════════════════
slides.push(contentSlide('Technical Agenda', [
  ...([
    ['01', 'System Architecture', 'End-to-end component diagram: Azure Functions, SQLite, MCP protocol, transport layers'],
    ['02', 'Azure Functions Implementation', 'Node.js 20, MCP Streamable HTTP, better-sqlite3 native bindings, EP1 elastic plan'],
    ['03', 'Named Pipes & LocalDB', 'How the XRef build connects to SQL Server LocalDB via Windows named pipes'],
    ['04', 'SQLite Database Engine', 'Database schemas, mmap I/O, 200 MB cache, read-only singleton pattern, indexing strategy'],
    ['05', 'PowerShell Automation', 'Configuration discovery, database builds, cross-platform deployment, Kudu VFS uploads'],
    ['06', 'Security Architecture', 'TLS 1.2, RBAC, managed identity, SQL injection prevention, query sandboxing'],
    ['07', 'Database Build Scripts', 'KB build (XML parsing, 10 min) and XRef build (SQL Server streaming, 22 min, 8 GB heap)'],
    ['08', 'Cost Estimation', 'EP1 pricing, storage, monitoring costs, optimization paths, TCO analysis'],
  ].flatMap((item, i) => {
    const y = 1.30 + i * 0.62;
    return [
      textBox(0.59, y, 0.7, 0.40, [
        para(run(item[0], { sz: 1600, bold: true, color: C.teal }), { algn: 'r' })
      ]),
      textBox(1.45, y, 9, 0.24, [
        para(run(item[1], { sz: 1100, bold: true, color: C.black }))
      ]),
      textBox(1.45, y + 0.24, 9, 0.22, [
        para(run(item[2], { sz: 800, color: C.gray }))
      ]),
      ...(i < 7 ? [lineShape(0.59, y + 0.55, 11.8, C.lt, 6350)] : []),
    ];
  }))
]));

// ═══════════════════════════════════════════════════════════════════
// SLIDE 3: System Architecture Overview
// ═══════════════════════════════════════════════════════════════════
slides.push(contentSlide('System Architecture Overview', [
  textBox(0.59, 1.32, 12.15, 0.28, [
    para(run('Two deployment modes share identical tool logic (kb-tools.js, xref-tools.js) \u2014 only transport and DB initialization differ', { sz: 900, italic: true, color: C.gray }))
  ]),

  // ── Left column: Build Pipeline ──
  textBox(0.59, 1.68, 3.80, 0.30, [
    para(run('Build Pipeline (Developer Machine)', { sz: 900, bold: true, color: C.brick }))
  ]),
  // Source boxes
  rect(0.59, 2.02, 3.80, 0.55, C.white, { line: C.brick, lineW: 9525, rounding: 5000 }),
  textBox(0.69, 2.04, 3.60, 0.52, [
    para(run('PackagesLocalDirectory', { sz: 750, bold: true, color: C.brick, font: 'Consolas' })),
    para(run('D365 XML metadata (17K tables, 63K classes)', { sz: 650, color: C.dk })),
  ]),
  flowArrow(1.22, 2.55),
  rect(0.59, 2.80, 3.80, 0.55, C.white, { line: C.gold, lineW: 9525, rounding: 5000 }),
  textBox(0.69, 2.82, 3.60, 0.52, [
    para(run('SQL Server LocalDB (Named Pipe)', { sz: 750, bold: true, color: C.gold, font: 'Consolas' })),
    para(run('XRef DB: 5.8M objects, 26.6M references', { sz: 650, color: C.dk })),
  ]),
  flowArrow(1.22, 3.33),
  rect(0.59, 3.58, 1.82, 0.50, C.teal, { rounding: 5000 }),
  textBox(0.59, 3.58, 1.82, 0.50, [
    para(run('build-kb.js', { sz: 750, bold: true, color: C.white, font: 'Consolas' }), { algn: 'ctr' }),
    para(run('~10 min', { sz: 650, color: C.white }), { algn: 'ctr' }),
  ], { anchor: 'ctr' }),
  rect(2.57, 3.58, 1.82, 0.50, C.gold, { rounding: 5000 }),
  textBox(2.57, 3.58, 1.82, 0.50, [
    para(run('build-xref-db.js', { sz: 750, bold: true, color: C.white, font: 'Consolas' }), { algn: 'ctr' }),
    para(run('~22 min, 8GB', { sz: 650, color: C.white }), { algn: 'ctr' }),
  ], { anchor: 'ctr' }),
  flowArrow(1.22, 4.06),
  rect(0.59, 4.30, 1.82, 0.42, C.tealLt, { rounding: 5000 }),
  textBox(0.59, 4.30, 1.82, 0.42, [
    para(run('KB: 1,063 MB', { sz: 750, bold: true, color: C.teal }), { algn: 'ctr' }),
  ], { anchor: 'ctr' }),
  rect(2.57, 4.30, 1.82, 0.42, C.tealLt, { rounding: 5000 }),
  textBox(2.57, 4.30, 1.82, 0.42, [
    para(run('XRef: 3,300 MB', { sz: 750, bold: true, color: C.gold }), { algn: 'ctr' }),
  ], { anchor: 'ctr' }),

  // ── Middle column: Local Mode ──
  textBox(4.65, 1.68, 3.50, 0.30, [
    para(run('Local Mode (stdio)', { sz: 900, bold: true, color: C.teal }))
  ]),
  ...([
    ['Claude Code / Cursor / VS Code', C.gray],
    ['MCP Client (stdio JSON-RPC)', C.slate],
    ['mcp-server-kb.js | xref.js', C.teal],
    ['better-sqlite3 (read-only)', C.brown],
    ['~/.claude/*.sqlite (local disk)', C.gold],
  ].flatMap((item, i) => {
    const y = 2.02 + i * 0.60;
    return [
      rect(4.65, y, 3.50, 0.38, item[1], { rounding: 5000 }),
      textBox(4.65, y, 3.50, 0.38, [
        para(run(item[0], { sz: 700, color: C.white }), { algn: 'ctr' })
      ], { anchor: 'ctr' }),
      ...(i < 4 ? [flowArrow(6.12, y + 0.34)] : []),
    ];
  })),

  // ── Right column: Azure Mode ──
  textBox(8.42, 1.68, 4.20, 0.30, [
    para(run('Azure Mode (Streamable HTTP)', { sz: 900, bold: true, color: C.brick }))
  ]),
  ...([
    ['Any MCP Client (ChatGPT, Gemini, ...)', C.gray],
    ['HTTPS + MCP Streamable HTTP', C.slate],
    ['Azure Function App (Node.js 20, Linux)', C.teal],
    ['better-sqlite3 (read-only, native)', C.brown],
    ['/home/data/*.sqlite (persistent)', C.gold],
  ].flatMap((item, i) => {
    const y = 2.02 + i * 0.60;
    return [
      rect(8.42, y, 4.20, 0.38, item[1], { rounding: 5000 }),
      textBox(8.42, y, 4.20, 0.38, [
        para(run(item[0], { sz: 700, color: C.white }), { algn: 'ctr' })
      ], { anchor: 'ctr' }),
      ...(i < 4 ? [flowArrow(10.24, y + 0.34)] : []),
    ];
  })),

  // ── Deployment arrow from build to Azure ──
  textBox(4.00, 4.88, 5.00, 0.30, [
    para([
      run('Deploy-FunctionApp.ps1 ', { sz: 700, bold: true, color: C.brick, font: 'Consolas' }),
      run('\u2192 Kudu VFS upload to /home/data/', { sz: 700, color: C.gray }),
    ], { algn: 'ctr' })
  ]),

  // Bottom: tech stack summary
  rect(0.59, 5.30, 12.15, 0.55, C.bgPanel, { rounding: 5000 }),
  textBox(0.75, 5.32, 11.83, 0.50, [
    para([
      run('Tech Stack: ', { sz: 800, bold: true, color: C.teal }),
      run('Node.js 20  |  better-sqlite3 (native C++)  |  @modelcontextprotocol/sdk  |  @azure/functions v4  |  fast-xml-parser  |  mssql/tedious  |  Bicep IaC  |  PowerShell 7', { sz: 750, color: C.dk }),
    ], { algn: 'ctr' })
  ], { anchor: 'ctr' }),
]));

// ═══════════════════════════════════════════════════════════════════
// SLIDE 4: Azure Functions Implementation
// ═══════════════════════════════════════════════════════════════════
slides.push(contentSlide('Azure Functions Implementation', [
  textBox(0.59, 1.32, 12.15, 0.28, [
    para(run('Azure Functions v4 on Linux EP1 (Elastic Premium) \u2014 two HTTP endpoints exposing MCP tools via Streamable HTTP transport', { sz: 900, italic: true, color: C.gray }))
  ]),

  // Left: Function entry point code
  textBox(0.59, 1.68, 5.80, 0.30, [
    para(run('Function Entry Point (d365kb.js)', { sz: 950, bold: true, color: C.teal }))
  ]),
  codeBlock(0.59, 2.00, 5.80, 2.40, [
    'import { app } from \'@azure/functions\';',
    'import { McpServer } from \'@mcp/sdk/server/mcp.js\';',
    'import { WebStandardStreamableHTTPServerTransport }',
    '  from \'@mcp/sdk/server/webStandardStreamableHttp.js\';',
    '',
    'app.http(\'d365kb\', {',
    '  methods: [\'GET\', \'POST\', \'DELETE\'],',
    '  authLevel: \'anonymous\',',
    '  handler: async (request, context) => {',
    '    const db = getKbDb();      // singleton',
    '    const server = new McpServer({ ... });',
    '    registerKbTools(server, db);',
    '    const transport = new WebStandardStreamable...',
    '    await server.connect(transport);',
    '    return transport.handleRequest(request);',
    '  }',
    '});',
  ]),

  // Right: Infrastructure details
  textBox(6.65, 1.68, 6.00, 0.30, [
    para(run('Infrastructure (Bicep IaC)', { sz: 950, bold: true, color: C.brick }))
  ]),
  // Resource table
  ...([
    ['App Service Plan', 'EP1 Elastic Premium', 'Linux, max 3 workers, 1 always-ready'],
    ['Function App', 'Node.js 20', 'httpsOnly, TLS 1.2, FTPS disabled'],
    ['Storage Account', 'Standard_LRS', 'Functions runtime storage only'],
    ['Key Vault', 'Standard, RBAC', 'Soft delete (7 days), managed identity'],
    ['App Insights', 'Log Analytics', 'Sampling enabled, 30-day retention'],
  ].flatMap((r, i) => {
    const y = 2.02 + i * 0.45;
    const bgColor = i % 2 === 0 ? C.tealLt : C.white;
    return [
      rect(6.65, y, 6.00, 0.42, bgColor, { rounding: 3000 }),
      textBox(6.75, y + 0.02, 1.80, 0.38, [
        para(run(r[0], { sz: 750, bold: true, color: C.dk }))
      ], { anchor: 'ctr' }),
      textBox(8.55, y + 0.02, 1.60, 0.38, [
        para(run(r[1], { sz: 700, color: C.teal, font: 'Consolas' }))
      ], { anchor: 'ctr' }),
      textBox(10.15, y + 0.02, 2.45, 0.38, [
        para(run(r[2], { sz: 700, color: C.gray }))
      ], { anchor: 'ctr' }),
    ];
  })),

  // HTTP Endpoints
  textBox(0.59, 4.55, 5.80, 0.30, [
    para(run('HTTP Endpoints', { sz: 950, bold: true, color: C.gold }))
  ]),
  ...([
    ['GET  /api/d365kb', 'Health check \u2192 { name, version, status }'],
    ['POST /api/d365kb', 'MCP JSON-RPC tool invocation (17 KB tools)'],
    ['GET  /api/d365xref', 'Health check \u2192 { name, version, status }'],
    ['POST /api/d365xref', 'MCP JSON-RPC tool invocation (16 XRef tools)'],
  ].flatMap((e, i) => {
    const y = 4.88 + i * 0.28;
    return [
      textBox(0.69, y, 2.20, 0.26, [
        para(run(e[0], { sz: 700, bold: true, color: C.dk, font: 'Consolas' }))
      ]),
      textBox(2.95, y, 3.44, 0.26, [
        para(run(e[1], { sz: 700, color: C.gray }))
      ]),
    ];
  })),

  // Key architectural decisions
  textBox(6.65, 4.55, 6.00, 0.30, [
    para(run('Key Design Decisions', { sz: 950, bold: true, color: C.slate }))
  ]),
  textBox(6.75, 4.88, 5.80, 1.10, [
    ...[
      'Stateless per-request MCP server (no session affinity needed)',
      'Singleton DB connections survive across invocations',
      'enableJsonResponse: true for non-streaming clients',
      'enableHttpStream: true for SSE-capable clients',
      'Linux plan = cheaper than Windows + native SQLite binaries',
    ].map(t => para([
      run('\u2022 ', { sz: 750, bold: true, color: C.slate }),
      run(t, { sz: 750, color: C.dk })
    ], { spcAft: 50, lnSpc: 115000 })),
  ]),
]));

// ═══════════════════════════════════════════════════════════════════
// SLIDE 5: Named Pipes & LocalDB
// ═══════════════════════════════════════════════════════════════════
slides.push(contentSlide('Named Pipes & SQL Server LocalDB', [
  textBox(0.59, 1.32, 12.15, 0.28, [
    para(run('The XRef build script connects to Microsoft\'s Visual Studio LocalDB instance via Windows named pipes to extract 26.6M cross-references', { sz: 900, italic: true, color: C.gray }))
  ]),

  // Left: Named pipe resolution
  textBox(0.59, 1.68, 5.80, 0.30, [
    para(run('Named Pipe Resolution Flow', { sz: 950, bold: true, color: C.teal }))
  ]),

  // Step boxes
  ...([
    ['1', 'SqlLocalDB info MSSQLLocalDB', 'Query LocalDB CLI for instance metadata', C.teal],
    ['2', 'Parse pipe: np:\\\\.\\pipe\\LOCALDB#...', 'Extract named pipe string from CLI output', C.gold],
    ['3', 'Start instance if stopped', 'SqlLocalDB start MSSQLLocalDB', C.brown],
    ['4', 'Connect: Server=np:\\\\.\\pipe\\...', 'mssql/tedious driver uses pipe directly', C.brick],
  ].flatMap((step, i) => {
    const y = 2.05 + i * 0.72;
    return [
      rect(0.59, y, 0.40, 0.40, step[3], { rounding: 50000 }),
      textBox(0.59, y, 0.40, 0.40, [
        para(run(step[0], { sz: 1000, bold: true, color: C.white }), { algn: 'ctr' })
      ], { anchor: 'ctr' }),
      textBox(1.10, y, 5.29, 0.22, [
        para(run(step[1], { sz: 800, bold: true, color: C.dk, font: 'Consolas' }))
      ]),
      textBox(1.10, y + 0.22, 5.29, 0.22, [
        para(run(step[2], { sz: 750, color: C.gray }))
      ]),
      ...(i < 3 ? [flowArrow(0.52, y + 0.42)] : []),
    ];
  })),

  // Right: Connection fallback strategy
  textBox(6.65, 1.68, 6.00, 0.30, [
    para(run('Connection Fallback Strategy', { sz: 950, bold: true, color: C.brick }))
  ]),
  codeBlock(6.65, 2.05, 6.00, 1.80, [
    '// Attempt 1: Direct named pipe',
    'pool = await sql.connect(',
    '  `Server=${pipe};Database=${db};',
    '   Trusted_Connection=yes`);',
    '',
    '// Attempt 2: Server name (if pipe fails)',
    'pool = await sql.connect({',
    '  server: "(LocalDB)\\\\MSSQLLocalDB",',
    '  options: { trustedConnection: true }',
    '});',
    '',
    '// Attempt 3: sqlcmd CLI fallback',
    'execSync(`sqlcmd -S "${instance}" -d "${db}"',
    '  -Q "${query}" -s "\\t" -W -h -1`);',
  ]),

  // What is a Named Pipe?
  textBox(6.65, 4.05, 6.00, 0.30, [
    para(run('What is a Named Pipe?', { sz: 950, bold: true, color: C.gold }))
  ]),
  rect(6.65, 4.38, 6.00, 1.50, C.tealLt, { rounding: 5000 }),
  textBox(6.75, 4.42, 5.80, 1.42, [
    para(run('A Windows inter-process communication (IPC) mechanism.', { sz: 800, bold: true, color: C.dk }), { spcAft: 150 }),
    ...[
      'Behaves like a network socket but entirely in-kernel (no TCP overhead)',
      'LocalDB generates unique pipe names: np:\\\\.\\pipe\\LOCALDB#XXXXXXXX\\tsql\\query',
      'Connection is Windows-authenticated (Trusted_Connection=yes) \u2014 no passwords',
      'Process must be on the same machine (no remote access possible)',
      'Pipe name changes each time LocalDB instance restarts',
    ].map(t => para([
      run('\u2022 ', { sz: 750, bold: true, color: C.teal }),
      run(t, { sz: 750, color: C.dk })
    ], { spcAft: 50, lnSpc: 115000 })),
  ]),

  // Bottom: Why LocalDB?
  rect(0.59, 5.20, 5.80, 0.70, C.bgPanel, { rounding: 5000 }),
  textBox(0.69, 5.22, 5.60, 0.66, [
    para(run('Why LocalDB?', { sz: 850, bold: true, color: C.slate }), { spcAft: 80 }),
    para(run('Microsoft Visual Studio stores D365 F&O cross-reference data in a LocalDB instance. This is the only source for code dependencies \u2014 who calls, extends, implements what.', { sz: 750, color: C.dk }), { lnSpc: 115000 }),
  ]),
]));

// ═══════════════════════════════════════════════════════════════════
// SLIDE 6: SQLite Database Engine
// ═══════════════════════════════════════════════════════════════════
slides.push(contentSlide('SQLite Database Engine', [
  textBox(0.59, 1.32, 12.15, 0.28, [
    para(run('SQLite is the runtime database for both MCP services \u2014 pre-built, read-only, with aggressive caching for sub-100ms query performance', { sz: 900, italic: true, color: C.gray }))
  ]),

  // Left: Database initialization code
  textBox(0.59, 1.68, 5.80, 0.30, [
    para(run('Database Initialization (shared.js)', { sz: 950, bold: true, color: C.teal }))
  ]),
  codeBlock(0.59, 2.02, 5.80, 1.60, [
    'function openDb(filePath) {',
    '  const db = new Database(filePath,',
    '    { readonly: true });',
    '',
    '  db.pragma(\'journal_mode = OFF\');',
    '  db.pragma(\'cache_size = -200000\');',
    '  //           ^^^^^^^ 200 MB page cache',
    '  db.pragma(\'mmap_size = 3221225472\');',
    '  //           ^^^^^^^^ 3 GB memory-mapped I/O',
    '  return db;',
    '}',
  ]),

  // Right: Performance characteristics
  textBox(6.65, 1.68, 6.00, 0.30, [
    para(run('Performance Tuning', { sz: 950, bold: true, color: C.gold }))
  ]),
  ...([
    ['journal_mode = OFF', 'No WAL journal \u2014 read-only DB needs no crash recovery'],
    ['cache_size = -200000', '200 MB page cache in process memory for hot pages'],
    ['mmap_size = 3 GB', 'Memory-mapped I/O \u2014 OS manages pages, bypasses read() syscalls'],
    ['Singleton pattern', 'One DB connection per process lifetime, shared across requests'],
    ['Parameterized queries', 'stmt.all(...params) \u2014 no string concatenation, prevents SQL injection'],
  ].flatMap((item, i) => {
    const y = 2.02 + i * 0.32;
    return [
      textBox(6.75, y, 2.30, 0.30, [
        para(run(item[0], { sz: 700, bold: true, color: C.teal, font: 'Consolas' }))
      ]),
      textBox(9.10, y, 3.50, 0.30, [
        para(run(item[1], { sz: 700, color: C.dk }))
      ]),
    ];
  })),

  // KB Schema
  textBox(0.59, 3.78, 5.80, 0.30, [
    para(run('Knowledge Base Schema (20+ tables, 1,063 MB)', { sz: 950, bold: true, color: C.teal }))
  ]),
  ...([
    ['tables', '~17.6K', 'Table metadata (group, cache, clustering)'],
    ['fields', '~250K', 'Field definitions (type, EDT, enum)'],
    ['classes', '~63.4K', 'Classes with extends, implements'],
    ['methods', '~820K', 'Full X++ source code + signatures'],
    ['enums', '~7.8K', 'Enum values with numeric IDs/labels'],
    ['data_entities', '~5.4K', 'OData names, field mappings'],
    ['labels', '~369K', 'Resolved @SYS labels \u2192 text'],
    ['relations', '~60K', 'FK constraints + join mappings'],
  ].flatMap((t, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = 0.59 + col * 2.95;
    const y = 4.12 + row * 0.28;
    return [
      textBox(x, y, 0.90, 0.26, [
        para(run(t[0], { sz: 650, bold: true, color: C.dk, font: 'Consolas' }))
      ]),
      textBox(x + 0.92, y, 0.60, 0.26, [
        para(run(t[1], { sz: 650, bold: true, color: C.teal }))
      ]),
      textBox(x + 1.55, y, 1.35, 0.26, [
        para(run(t[2], { sz: 600, color: C.gray }))
      ]),
    ];
  })),

  // XRef Schema
  textBox(6.65, 3.78, 6.00, 0.30, [
    para(run('Cross-Reference Schema (5 tables, 3,300 MB)', { sz: 950, bold: true, color: C.gold }))
  ]),
  ...([
    ['names', '5.8M rows', 'AOT paths (/Classes/SalesTable/Methods/find)'],
    ['refs', '26.6M rows', 'source_id \u2192 target_id + kind + line/col'],
    ['modules', '~390 rows', 'Module names (ApplicationSuite, etc.)'],
    ['kind_map', '8 rows', 'Call, Read, Implements, Extends, Delegate, ...'],
  ].flatMap((t, i) => {
    const y = 4.12 + i * 0.30;
    return [
      textBox(6.75, y, 1.20, 0.28, [
        para(run(t[0], { sz: 700, bold: true, color: C.dk, font: 'Consolas' }))
      ]),
      textBox(7.98, y, 1.20, 0.28, [
        para(run(t[1], { sz: 700, bold: true, color: C.gold }))
      ]),
      textBox(9.22, y, 3.38, 0.28, [
        para(run(t[2], { sz: 650, color: C.gray }))
      ]),
    ];
  })),

  // Indexes
  textBox(6.65, 5.35, 6.00, 0.30, [
    para(run('8 Covering Indexes on XRef', { sz: 850, bold: true, color: C.gold }))
  ]),
  textBox(6.75, 5.62, 5.80, 0.30, [
    para(run('idx_refs_source, idx_refs_target, idx_refs_kind, idx_refs_source_kind (compound), idx_refs_target_kind, idx_names_path, idx_names_module, idx_modules_module', { sz: 600, color: C.dk, font: 'Consolas' }), { lnSpc: 115000 }),
  ]),

  // Bottom: Why SQLite?
  rect(0.59, 5.35, 5.80, 0.55, C.tealLt, { rounding: 5000 }),
  textBox(0.69, 5.37, 5.60, 0.50, [
    para([
      run('Why SQLite? ', { sz: 800, bold: true, color: C.teal }),
      run('Zero network latency, no connection pooling, no licensing costs, file-based = trivial backup/deploy, better-sqlite3 is synchronous (no async overhead).', { sz: 750, color: C.dk }),
    ], { lnSpc: 115000 }),
  ], { anchor: 'ctr' }),
]));

// ═══════════════════════════════════════════════════════════════════
// SLIDE 7: PowerShell Automation
// ═══════════════════════════════════════════════════════════════════
slides.push(contentSlide('PowerShell Automation Layer', [
  textBox(0.59, 1.32, 12.15, 0.28, [
    para(run('End-to-end automation: configuration discovery \u2192 database build \u2192 cross-platform binary install \u2192 Azure deployment \u2192 health validation', { sz: 900, italic: true, color: C.gray }))
  ]),

  // 4 script cards
  ...([
    {
      title: 'Update-Databases.ps1',
      subtitle: 'Build Orchestrator',
      color: C.teal,
      items: [
        'Reads %LOCALAPPDATA%\\Microsoft\\Dynamics365\\XPPConfig\\',
        'Parses JSON + registry for active D365 configuration',
        'Extracts FrameworkDirectory, ModelStoreFolder paths',
        'Extracts CrossReferencesDbServerName & DatabaseName',
        'Stops running MCP servers to release file locks',
        'Starts LocalDB instance if needed (SqlLocalDB start)',
        'Calls build-kb.js and build-xref-db.js with correct args',
        'Supports -KbOnly, -XrefOnly, -ConfigName flags',
      ]
    },
    {
      title: 'Deploy-FunctionApp.ps1',
      subtitle: 'Full Deployment',
      color: C.brick,
      items: [
        'Uploads SQLite DBs via Kudu VFS API (HTTPS PUT)',
        'Basic auth: Kudu publishing credentials (Base64)',
        'Creates /home/data/ dir on Function App filesystem',
        'npm install --omit=dev for production dependencies',
        'Cross-installs Linux better-sqlite3 binary:',
        '  npx prebuild-install --platform linux --arch x64',
        'Zips code + node_modules, deploys via az CLI',
        'SCM_DO_BUILD_DURING_DEPLOYMENT=false (skip server build)',
      ]
    },
    {
      title: 'Deploy-Infrastructure.ps1',
      subtitle: 'Bicep IaC',
      color: C.gold,
      items: [
        'Deploys main-rg.bicep to Azure resource group',
        'Creates Function App, ASP, Storage, Key Vault, AppInsights',
        'Naming: {prefix}-{env}-{workload}-{suffix}',
        'Tags: Owner, Environment, CostCenter, ManagedBy',
      ]
    },
    {
      title: 'Set-RoleAssignments.ps1',
      subtitle: 'RBAC Setup',
      color: C.slate,
      items: [
        'Assigns Key Vault Secrets User to Function App identity',
        'Uses system-assigned managed identity (principal ID)',
        'Must be run by Owner / User Access Administrator',
        'Post-deployment step (requires existing resources)',
      ]
    },
  ].flatMap((s, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = 0.59 + col * 6.18;
    const y = 1.68 + row * 2.10;
    const itemH = row === 0 ? 1.62 : 1.15;
    return [
      rect(x, y, 6.01, 0.35, s.color),
      textBox(x, y, 6.01, 0.35, [
        para([
          run(s.title, { sz: 850, bold: true, color: C.white, font: 'Consolas' }),
          run('  \u2014 ' + s.subtitle, { sz: 800, color: C.white }),
        ], { algn: 'ctr' })
      ], { anchor: 'ctr' }),
      rect(x, y + 0.35, 6.01, itemH, C.white, { line: s.color, lineW: 6350 }),
      textBox(x + 0.12, y + 0.40, 5.77, itemH - 0.10,
        s.items.map(item => para([
          run(item.startsWith('  ') ? '    ' : '\u2022 ', { sz: 700, bold: !item.startsWith('  '), color: s.color }),
          run(item.trimStart(), { sz: 700, color: C.dk, font: item.includes('npx') || item.includes('SCM_') ? 'Consolas' : 'Arial' })
        ], { spcAft: 20, lnSpc: 108000 }))
      ),
    ];
  })),

  // Command flow bar
  rect(0.59, 5.40, 12.15, 0.45, C.bgPanel, { rounding: 5000 }),
  textBox(0.75, 5.42, 11.83, 0.40, [
    para([
      run('Typical flow: ', { sz: 750, bold: true, color: C.teal }),
      run('.\\Update-Databases.ps1', { sz: 750, color: C.dk, font: 'Consolas' }),
      run('  \u2192  ', { sz: 750, color: C.gray }),
      run('.\\Deploy-FunctionApp.ps1 -Environment d', { sz: 750, color: C.dk, font: 'Consolas' }),
      run('  \u2192  ', { sz: 750, color: C.gray }),
      run('.\\Set-RoleAssignments.ps1', { sz: 750, color: C.dk, font: 'Consolas' }),
      run('  (first deploy only)', { sz: 700, color: C.gray }),
    ])
  ], { anchor: 'ctr' }),
]));

// ═══════════════════════════════════════════════════════════════════
// SLIDE 8: Security Architecture
// ═══════════════════════════════════════════════════════════════════
slides.push(contentSlide('Security Architecture', [
  textBox(0.59, 1.32, 12.15, 0.28, [
    para(run('Defense in depth: transport security, identity management, query sandboxing, and input validation at every layer', { sz: 900, italic: true, color: C.gray }))
  ]),

  // Three security columns
  ...([
    {
      title: 'Transport & Network',
      color: C.teal,
      items: [
        ['HTTPS Only', 'httpsOnly: true on Function App \u2014 all HTTP redirected to HTTPS'],
        ['TLS 1.2 Minimum', 'minTlsVersion: \'1.2\' enforced in Bicep configuration'],
        ['FTPS Disabled', 'ftpsState: \'Disabled\' \u2014 no FTP/FTPS access to filesystem'],
        ['No Credentials in URLs', 'SQLite is local filesystem \u2014 no DB connection strings needed'],
      ]
    },
    {
      title: 'Identity & Access',
      color: C.gold,
      items: [
        ['Managed Identity', 'System-assigned identity for Azure service integration'],
        ['RBAC on Key Vault', 'Key Vault Secrets User role via az role assignment'],
        ['Kudu Auth', 'Publishing credentials (Basic auth) for deployment only'],
        ['Named Pipe Auth', 'Windows Trusted_Connection \u2014 no passwords stored anywhere'],
      ]
    },
    {
      title: 'Query Sandboxing',
      color: C.brick,
      items: [
        ['Read-Only Mode', 'Database opened with { readonly: true } \u2014 no writes possible'],
        ['Parameterized Queries', 'All user input via positional ? placeholders (no interpolation)'],
        ['Keyword Validation', 'raw_sql tools only allow SELECT, WITH, PRAGMA statements'],
        ['Row Limits', 'LIMIT clauses enforced: 500 rows (KB), 100 rows (XRef)'],
      ]
    },
  ].flatMap((col, ci) => {
    const x = 0.59 + ci * 4.12;
    return [
      rect(x, 1.68, 3.95, 0.35, col.color),
      textBox(x, 1.68, 3.95, 0.35, [
        para(run(col.title, { sz: 950, bold: true, color: C.white }), { algn: 'ctr' })
      ], { anchor: 'ctr' }),
      ...col.items.flatMap((item, i) => {
        const y = 2.12 + i * 0.82;
        return [
          textBox(x + 0.10, y, 3.75, 0.28, [
            para(run(item[0], { sz: 800, bold: true, color: col.color }))
          ]),
          textBox(x + 0.10, y + 0.28, 3.75, 0.48, [
            para(run(item[1], { sz: 700, color: C.dk }), { lnSpc: 115000 })
          ]),
        ];
      }),
    ];
  })),

  // MCP-level security note
  rect(0.59, 5.30, 12.15, 0.55, C.bgPanel, { rounding: 5000 }),
  textBox(0.75, 5.32, 11.83, 0.50, [
    para([
      run('MCP Endpoint Security: ', { sz: 800, bold: true, color: C.brick }),
      run('authLevel: \'anonymous\' \u2014 endpoints are designed for internal/VPN network access. For public exposure, add Azure AD authentication via Easy Auth, API Management gateway, or Function-level API keys.', { sz: 750, color: C.dk }),
    ], { lnSpc: 115000 }),
  ], { anchor: 'ctr' }),
]));

// ═══════════════════════════════════════════════════════════════════
// SLIDE 9: KB Build Script Deep Dive
// ═══════════════════════════════════════════════════════════════════
slides.push(contentSlide('Database Build: Knowledge Base (build-kb.js)', [
  textBox(0.59, 1.32, 12.15, 0.28, [
    para(run('Parses D365 F&O XML metadata from PackagesLocalDirectory into a 1,063 MB SQLite database in ~10 minutes', { sz: 900, italic: true, color: C.gray }))
  ]),

  // Three-phase build
  ...([
    {
      phase: 'Phase 0',
      title: 'Label Loading',
      time: '~30 sec',
      color: C.teal,
      items: [
        'Scan all en-US .label.txt files across all modules',
        'Parse 369K+ label ID mappings (@SYS12345 \u2192 text)',
        'Store in-memory Map for Phase 1 enrichment',
      ]
    },
    {
      phase: 'Phase 1',
      title: 'XML Parsing',
      time: '~8 min',
      color: C.gold,
      items: [
        'Parse 10 object types using fast-xml-parser:',
        '  AxTable, AxEnum, AxEdt, AxClass, AxDataEntityView',
        '  AxForm, AxView, Security objects, Menu items',
        'Extract full X++ source code from methods',
        'Multi-directory: Microsoft + ISV packages merged',
        'In-memory Maps for FTS enrichment (classMethodNames)',
      ]
    },
    {
      phase: 'Phase 2',
      title: 'Index & Curated Data',
      time: '~1 min',
      color: C.brick,
      items: [
        'Build kb_search table (LIKE-based full-text search)',
        'Build graph_edges table (dependency traversal)',
        'Import hallucination_traps (known LLM mistakes)',
        'Import field_renames (AX2012 \u2192 D365)',
        'Import sql_templates (pre-validated queries)',
        'Build module summary statistics',
      ]
    },
  ].flatMap((p, i) => {
    const x = 0.59 + i * 4.12;
    return [
      rect(x, 1.68, 3.95, 0.55, p.color, { rounding: 5000 }),
      textBox(x + 0.10, 1.70, 3.75, 0.30, [
        para([
          run(p.phase + ': ', { sz: 900, bold: true, color: C.white }),
          run(p.title, { sz: 900, color: C.white }),
        ])
      ]),
      textBox(x + 0.10, 1.95, 3.75, 0.22, [
        para(run(p.time, { sz: 800, italic: true, color: C.white }))
      ]),
      textBox(x + 0.10, 2.30, 3.75, 2.00,
        p.items.map(item => para([
          run(item.startsWith('  ') ? '    ' : '\u2022 ', { sz: 750, bold: !item.startsWith('  '), color: p.color }),
          run(item.trimStart(), { sz: 750, color: C.dk })
        ], { spcAft: 60, lnSpc: 115000 }))
      ),
    ];
  })),

  // Technology details
  textBox(0.59, 4.35, 5.80, 0.30, [
    para(run('Build Technology', { sz: 950, bold: true, color: C.slate }))
  ]),
  rect(0.59, 4.68, 5.80, 1.20, C.white, { line: C.slate, lineW: 9525, rounding: 5000 }),
  textBox(0.69, 4.72, 5.60, 1.12, [
    ...[
      ['Engine:', 'sql.js (WebAssembly SQLite) for in-memory construction'],
      ['Parser:', 'fast-xml-parser with array coercion for consistent structure'],
      ['Output:', 'Binary buffer written to file via writeFileSync()'],
      ['Multi-path:', 'Comma-separated directories for Microsoft + ISV metadata'],
      ['Memory:', 'Moderate \u2014 parses files sequentially, not loaded all at once'],
    ].map(item => para([
      run(item[0] + ' ', { sz: 750, bold: true, color: C.slate }),
      run(item[1], { sz: 750, color: C.dk })
    ], { spcAft: 50, lnSpc: 112000 })),
  ]),

  // Data flow code
  textBox(6.65, 4.35, 6.00, 0.30, [
    para(run('XML \u2192 SQLite Flow', { sz: 950, bold: true, color: C.teal }))
  ]),
  codeBlock(6.65, 4.68, 6.00, 1.20, [
    '// For each D365 module directory:',
    'for (const pkg of packagesPaths) {',
    '  // Scan: .../ModuleName/AxTable/*.xml',
    '  const files = glob(pkg + \'/*/AxTable/*.xml\');',
    '  for (const file of files) {',
    '    const xml = readFileSync(file);',
    '    const parsed = xmlParser.parse(xml);',
    '    db.run(\'INSERT INTO tables ...\', [',
    '      parsed.Name, parsed.TableGroup, ...]);',
    '  }',
    '}',
  ]),
]));

// ═══════════════════════════════════════════════════════════════════
// SLIDE 10: XRef Build Script Deep Dive
// ═══════════════════════════════════════════════════════════════════
slides.push(contentSlide('Database Build: Cross-Reference (build-xref-db.js)', [
  textBox(0.59, 1.32, 12.15, 0.28, [
    para(run('Streams 5.8M names + 26.6M references from SQL Server LocalDB into a 3,300 MB SQLite database in ~22 minutes (requires 8 GB heap)', { sz: 900, italic: true, color: C.gray }))
  ]),

  // Left: Build steps
  textBox(0.59, 1.68, 6.00, 0.30, [
    para(run('Build Process', { sz: 950, bold: true, color: C.gold }))
  ]),
  ...([
    ['1', 'Resolve Named Pipe', 'SqlLocalDB info \u2192 parse np:\\\\.\\pipe\\... string', C.teal],
    ['2', 'Connect to SQL Server', 'mssql/tedious driver via named pipe, trusted auth', C.slate],
    ['3', 'Stream Names (500K batches)', '5.8M AOT paths: /Classes/SalesTable/Methods/find', C.gold],
    ['4', 'Stream References (1M batches)', '26.6M refs: source_id, target_id, kind, line, col', C.brown],
    ['5', 'Bulk-insert metadata', 'Modules (~390), Providers (~50), Kind map (8 types)', C.brick],
    ['6', 'Create 8 covering indexes', 'Compound indexes for source+kind, target+kind queries', C.teal],
  ].flatMap((step, i) => {
    const y = 2.02 + i * 0.52;
    return [
      rect(0.59, y, 0.32, 0.32, step[3], { rounding: 50000 }),
      textBox(0.59, y, 0.32, 0.32, [
        para(run(step[0], { sz: 900, bold: true, color: C.white }), { algn: 'ctr' })
      ], { anchor: 'ctr' }),
      textBox(1.02, y, 2.30, 0.30, [
        para(run(step[1], { sz: 750, bold: true, color: C.dk }))
      ]),
      textBox(3.35, y, 3.24, 0.30, [
        para(run(step[2], { sz: 700, color: C.gray }))
      ]),
    ];
  })),

  // Right: Technical details
  textBox(6.85, 1.68, 5.80, 0.30, [
    para(run('Technical Implementation', { sz: 950, bold: true, color: C.brick }))
  ]),
  codeBlock(6.85, 2.02, 5.80, 1.90, [
    '// SQLite performance pragmas for bulk writes',
    'db.pragma(\'journal_mode = OFF\');',
    'db.pragma(\'synchronous = OFF\');',
    'db.pragma(\'cache_size = -200000\');  // 200 MB',
    'db.pragma(\'locking_mode = EXCLUSIVE\');',
    '',
    '// Batch insert with prepared statement',
    'const insert = db.prepare(',
    '  \'INSERT INTO refs VALUES (?,?,?,?,?)\');',
    'const tx = db.transaction((rows) => {',
    '  for (const r of rows) insert.run(...r);',
    '});',
    'tx(batchOf1MRows);  // ~5 min for 26.6M rows',
  ]),

  // Reference kinds
  textBox(6.85, 4.05, 5.80, 0.30, [
    para(run('8 Reference Kinds', { sz: 950, bold: true, color: C.gold }))
  ]),
  ...([
    ['1 = Call', '2 = Read', '3 = Implements', '4 = Extends'],
    ['6 = Delegate', '7 = Attribute', '9 = Tag', '10 = Override'],
  ].flatMap((row, ri) => {
    return row.map((kind, ki) => {
      const x = 6.85 + ki * 1.45;
      const y = 4.38 + ri * 0.30;
      return textBox(x, y, 1.40, 0.28, [
        para(run(kind, { sz: 700, bold: true, color: C.gold, font: 'Consolas' }))
      ]);
    });
  }).flat()),

  // Memory & runtime
  rect(0.59, 5.20, 5.80, 0.65, C.tealLt, { rounding: 5000 }),
  textBox(0.69, 5.22, 5.60, 0.60, [
    para(run('Runtime Requirements', { sz: 850, bold: true, color: C.teal }), { spcAft: 80 }),
    para([
      run('node --max-old-space-size=8192', { sz: 750, bold: true, color: C.dk, font: 'Consolas' }),
      run(' (8 GB heap required)', { sz: 750, color: C.gray }),
    ], { spcAft: 50 }),
    para(run('26.6M references must be held in memory during batch inserts to SQLite.', { sz: 700, color: C.dk })),
  ]),

  // XRef source note
  rect(6.85, 5.20, 5.80, 0.65, C.bgPanel, { rounding: 5000 }),
  textBox(6.95, 5.22, 5.60, 0.60, [
    para(run('Cross-Reference Data Source', { sz: 850, bold: true, color: C.brick }), { spcAft: 80 }),
    para(run('Visual Studio > Dynamics 365 > Build Cross Reference Data must be run first. Only then does LocalDB contain ISV/custom code references.', { sz: 700, color: C.dk }), { lnSpc: 115000 }),
  ]),
]));

// ═══════════════════════════════════════════════════════════════════
// SLIDE 11: Cross-Platform Deployment
// ═══════════════════════════════════════════════════════════════════
slides.push(contentSlide('Cross-Platform Deployment: Windows \u2192 Linux', [
  textBox(0.59, 1.32, 12.15, 0.28, [
    para(run('The build machine is Windows (D365 F&O dev environment), but Azure Functions runs Linux \u2014 native SQLite binaries must be cross-compiled', { sz: 900, italic: true, color: C.gray }))
  ]),

  // The problem
  textBox(0.59, 1.68, 5.80, 0.30, [
    para(run('The Challenge', { sz: 950, bold: true, color: C.brick }))
  ]),
  rect(0.59, 2.02, 5.80, 1.10, C.redBg, { line: C.redNo, lineW: 9525, rounding: 5000 }),
  textBox(0.69, 2.06, 5.60, 1.02, [
    para(run('better-sqlite3 is a native Node.js addon (C++ compiled binary).', { sz: 800, bold: true, color: C.brick }), { spcAft: 150 }),
    ...[
      'npm install on Windows produces a Windows .node binary',
      'Deploying Windows binary to Linux Function App = crash',
      'Azure Functions build (SCM) doesn\'t install native deps reliably',
      'Cannot run npm install on Linux from a Windows build machine',
    ].map(t => para([
      run('\u2716 ', { sz: 750, bold: true, color: C.redNo }),
      run(t, { sz: 750, color: C.dk })
    ], { spcAft: 50, lnSpc: 112000 })),
  ]),

  // The solution
  textBox(6.65, 1.68, 6.00, 0.30, [
    para(run('The Solution: prebuild-install', { sz: 950, bold: true, color: C.greenOk }))
  ]),
  rect(6.65, 2.02, 6.00, 1.10, C.greenBg, { line: C.greenOk, lineW: 9525, rounding: 5000 }),
  textBox(6.75, 2.06, 5.80, 1.02, [
    para(run('Download pre-compiled Linux x64 binary from GitHub releases.', { sz: 800, bold: true, color: C.greenOk }), { spcAft: 150 }),
    ...[
      'Run on Windows: npx prebuild-install --platform linux --arch x64',
      'Targets Node.js 20.20.0 (matches Azure Functions runtime)',
      'Installs to node_modules/better-sqlite3/prebuilds/',
      'SCM_DO_BUILD_DURING_DEPLOYMENT=false skips server-side build',
    ].map(t => para([
      run('\u2714 ', { sz: 750, bold: true, color: C.greenOk }),
      run(t, { sz: 750, color: C.dk })
    ], { spcAft: 50, lnSpc: 112000 })),
  ]),

  // Deployment flow
  textBox(0.59, 3.30, 12.15, 0.30, [
    para(run('Deployment Flow', { sz: 950, bold: true, color: C.teal }))
  ]),
  ...([
    ['npm install\n--omit=dev', 'Install production\ndeps (Windows)', C.slate],
    ['prebuild-install\n--platform linux', 'Download Linux\nbetter-sqlite3', C.teal],
    ['Zip code +\nnode_modules', 'Package for\ndeployment', C.gold],
    ['az functionapp\nconfig-zip', 'Upload zip to\nAzure', C.brick],
    ['Kudu VFS PUT\n/home/data/', 'Upload SQLite\ndatabases', C.brown],
    ['Health check\nGET /api/d365kb', 'Validate\nendpoints', C.greenOk],
  ].flatMap((step, i) => {
    const x = 0.59 + i * 2.05;
    return [
      rect(x, 3.65, 1.88, 0.65, step[2], { rounding: 5000 }),
      textBox(x, 3.65, 1.88, 0.65, [
        para(run(step[0], { sz: 650, bold: true, color: C.white, font: 'Consolas' }), { algn: 'ctr', lnSpc: 108000 })
      ], { anchor: 'ctr' }),
      textBox(x, 4.32, 1.88, 0.42, [
        para(run(step[1], { sz: 650, color: C.dk }), { algn: 'ctr', lnSpc: 108000 })
      ]),
      ...(i < 5 ? [
        textBox(x + 1.75, 3.82, 0.40, 0.30, [
          para(run('\u25B6', { sz: 800, color: C.teal }), { algn: 'ctr' })
        ])
      ] : []),
    ];
  })),

  // Local dev note
  rect(0.59, 5.00, 12.15, 0.85, C.bgPanel, { rounding: 5000 }),
  textBox(0.75, 5.05, 11.83, 0.75, [
    para(run('Local Development: Different SQLite Technology', { sz: 850, bold: true, color: C.slate }), { spcAft: 100 }),
    para([
      run('KB local server uses ', { sz: 750, color: C.dk }),
      run('sql.js', { sz: 750, bold: true, color: C.teal, font: 'Consolas' }),
      run(' (WebAssembly, in-memory, no native binary needed). XRef local server uses ', { sz: 750, color: C.dk }),
      run('better-sqlite3', { sz: 750, bold: true, color: C.gold, font: 'Consolas' }),
      run(' (native, file-based \u2014 3.3 GB too large for in-memory). Azure uses ', { sz: 750, color: C.dk }),
      run('better-sqlite3', { sz: 750, bold: true, color: C.brick, font: 'Consolas' }),
      run(' for both (Linux native binary, persistent filesystem).', { sz: 750, color: C.dk }),
    ], { lnSpc: 118000 }),
  ]),
]));

// ═══════════════════════════════════════════════════════════════════
// SLIDE 12: Cost Estimation
// ═══════════════════════════════════════════════════════════════════
slides.push(contentSlide('Cost Estimation & Optimization', [
  textBox(0.59, 1.32, 12.15, 0.28, [
    para(run('Monthly Azure cost breakdown for the MCP service infrastructure \u2014 current architecture eliminates database licensing entirely via SQLite', { sz: 900, italic: true, color: C.gray }))
  ]),

  // Cost table
  textBox(0.59, 1.68, 7.80, 0.30, [
    para(run('Monthly Cost Breakdown (EUR)', { sz: 950, bold: true, color: C.teal }))
  ]),

  // Table header
  rect(0.59, 2.02, 7.80, 0.35, C.teal),
  ...([
    [0.59, 2.30, 'Component'],
    [2.80, 1.40, 'SKU / Tier'],
    [4.20, 1.40, 'Purpose'],
    [5.60, 1.00, 'Est. / Month'],
    [6.62, 1.77, 'Cost Driver'],
  ].map(h => textBox(h[0], 2.02, h[1], 0.35, [
    para(run(h[2], { sz: 750, bold: true, color: C.white }), { algn: 'ctr' })
  ], { anchor: 'ctr' }))),

  // Table rows
  ...([
    ['App Service Plan', 'EP1 (Linux)', '1 always-ready instance', '~150', 'Always-on compute'],
    ['Function App', 'Included in ASP', 'HTTP endpoints + runtime', '\u2014', 'Included in plan'],
    ['Storage Account', 'Standard LRS', 'Functions runtime', '~2', 'Minimal usage'],
    ['Key Vault', 'Standard', 'RBAC, secrets ready', '~1', '<1K operations'],
    ['App Insights + Log Analytics', 'PerGB, 30d', 'Telemetry + logs', '~15', 'Ingestion volume'],
  ].flatMap((r, i) => {
    const y = 2.37 + i * 0.35;
    const bg = i % 2 === 0 ? C.tealLt : C.white;
    return [
      rect(0.59, y, 7.80, 0.35, bg),
      textBox(0.59, y, 2.20, 0.35, [para(run(r[0], { sz: 700, bold: true, color: C.dk }))], { anchor: 'ctr', lIns: 54000 }),
      textBox(2.80, y, 1.40, 0.35, [para(run(r[1], { sz: 700, color: C.dk, font: 'Consolas' }), { algn: 'ctr' })], { anchor: 'ctr' }),
      textBox(4.20, y, 1.40, 0.35, [para(run(r[2], { sz: 700, color: C.gray }), { algn: 'ctr' })], { anchor: 'ctr' }),
      textBox(5.60, y, 1.00, 0.35, [para(run(r[3], { sz: 750, bold: true, color: C.teal }), { algn: 'ctr' })], { anchor: 'ctr' }),
      textBox(6.62, y, 1.77, 0.35, [para(run(r[4], { sz: 650, color: C.gray }), { algn: 'ctr' })], { anchor: 'ctr' }),
    ];
  })),

  // Total bar
  rect(0.59, 4.12, 7.80, 0.40, C.teal, { rounding: 3000 }),
  textBox(0.59, 4.12, 4.60, 0.40, [
    para(run('Total Estimated Monthly Cost', { sz: 900, bold: true, color: C.white }), { algn: 'r' })
  ], { anchor: 'ctr' }),
  textBox(5.60, 4.12, 1.00, 0.40, [
    para(run('~168', { sz: 1100, bold: true, color: C.white }), { algn: 'ctr' })
  ], { anchor: 'ctr' }),
  textBox(6.62, 4.12, 1.77, 0.40, [
    para(run('EUR / month', { sz: 800, color: C.white }), { algn: 'ctr' })
  ], { anchor: 'ctr' }),

  // Right: Key cost insight
  textBox(8.65, 1.68, 4.00, 0.30, [
    para(run('Key Architectural Cost Win', { sz: 950, bold: true, color: C.greenOk }))
  ]),
  rect(8.65, 2.02, 4.00, 2.20, C.greenBg, { line: C.greenOk, lineW: 9525, rounding: 5000 }),
  textBox(8.75, 2.08, 3.80, 2.08, [
    para(run('No Database Licensing!', { sz: 1000, bold: true, color: C.greenOk }), { spcAft: 200, algn: 'ctr' }),
    para(run('SQLite replaces Azure SQL Database entirely. Traditional architecture would require:', { sz: 750, color: C.dk }), { spcAft: 200, lnSpc: 118000 }),
    ...[
      'Azure SQL S3: ~200 EUR/month',
      'Or Elastic Pool: ~350 EUR/month',
      'For two databases (KB + XRef)',
    ].map(t => para([
      run('\u2716 ', { sz: 750, bold: true, color: C.redNo }),
      run(t, { sz: 750, color: C.dk })
    ], { spcAft: 60 })),
    para(run(''), { spcAft: 100 }),
    para([
      run('\u2714 SQLite: ', { sz: 750, bold: true, color: C.greenOk }),
      run('0 EUR/month', { sz: 750, bold: true, color: C.greenOk }),
    ]),
  ]),

  // Bottom: optimization paths
  textBox(0.59, 4.70, 12.15, 0.30, [
    para(run('Cost Optimization Paths', { sz: 950, bold: true, color: C.gold }))
  ]),
  ...([
    {
      title: 'Consumption Plan',
      savings: '-140 EUR/mo',
      color: C.teal,
      desc: 'Replace EP1 with pay-per-execution. Trade-off: 5-10s cold starts on first request. Good for low-traffic use.',
    },
    {
      title: 'Reserved Instances',
      savings: '-30% on 1yr',
      color: C.gold,
      desc: 'Commit to 1-year Reserved Instance for EP1. Reduces compute cost by ~45 EUR/month.',
    },
    {
      title: 'Reduce Logging',
      savings: '-10 EUR/mo',
      color: C.brick,
      desc: 'Disable or sample more aggressively in App Insights. excludedTypes: "Request" already applied.',
    },
    {
      title: 'Minimum Config',
      savings: '~15 EUR/mo',
      color: C.slate,
      desc: 'Consumption Plan + minimal logging. Acceptable for dev/test environments.',
    },
  ].flatMap((opt, i) => {
    const x = 0.59 + i * 3.10;
    return [
      rect(x, 5.05, 2.93, 0.30, opt.color, { rounding: 3000 }),
      textBox(x, 5.05, 2.00, 0.30, [
        para(run(opt.title, { sz: 750, bold: true, color: C.white }))
      ], { anchor: 'ctr', lIns: 54000 }),
      textBox(x + 1.80, 5.05, 1.13, 0.30, [
        para(run(opt.savings, { sz: 750, bold: true, color: C.white }), { algn: 'r' })
      ], { anchor: 'ctr' }),
      textBox(x + 0.05, 5.38, 2.83, 0.50, [
        para(run(opt.desc, { sz: 650, color: C.dk }), { lnSpc: 112000 })
      ]),
    ];
  })),
]));

// ═══════════════════════════════════════════════════════════════════
// SLIDE 13: Cost Impact Analysis
// ═══════════════════════════════════════════════════════════════════
slides.push(contentSlide('What Impacts Your Real Costs', [
  textBox(0.59, 1.32, 12.15, 0.28, [
    para(run('Understanding the factors that influence actual running costs beyond the base infrastructure estimate', { sz: 900, italic: true, color: C.gray }))
  ]),

  // Left: Cost multipliers
  textBox(0.59, 1.68, 5.80, 0.30, [
    para(run('Factors That Increase Cost', { sz: 950, bold: true, color: C.brick }))
  ]),
  ...([
    ['Concurrent Users', 'More simultaneous MCP clients = more Function App invocations. EP1 handles ~200 req/sec before scaling to 2nd worker.', '\u2191 Low impact \u2014 EP1 is powerful'],
    ['Query Complexity', 'Recursive CTEs (xref_impact_analysis, xref_class_hierarchy) use more CPU. Heavy queries may trigger scale-out to additional workers.', '\u2191 Medium impact \u2014 max 3 workers'],
    ['Database Rebuild Frequency', 'Each rebuild requires a Windows dev machine. D365 updates (monthly/quarterly) trigger rebuilds. Dev machine time is the real cost.', '\u2191 Indirect cost \u2014 developer time'],
    ['Multi-Environment', 'Dev + Prod = 2x infrastructure. Consider Consumption Plan for dev (~15 EUR vs ~168 EUR).', '\u2191 High impact if full EP1 per env'],
    ['Logging Volume', 'High tool usage = more App Insights ingestion. 1 GB/day free, then ~2.30 EUR/GB. AI tools can be chatty.', '\u2191 Low-medium \u2014 sampling helps'],
  ].flatMap((item, i) => {
    const y = 2.05 + i * 0.65;
    return [
      textBox(0.59, y, 5.80, 0.24, [
        para([
          run(item[0], { sz: 800, bold: true, color: C.brick }),
          run('  ' + item[2], { sz: 700, italic: true, color: C.gray }),
        ])
      ]),
      textBox(0.59, y + 0.24, 5.80, 0.36, [
        para(run(item[1], { sz: 700, color: C.dk }), { lnSpc: 112000 })
      ]),
    ];
  })),

  // Right: Cost savers
  textBox(6.65, 1.68, 6.00, 0.30, [
    para(run('Factors That Keep Costs Low', { sz: 950, bold: true, color: C.greenOk }))
  ]),
  ...([
    ['SQLite = Zero DB Licensing', 'No Azure SQL, no DTU pricing, no elastic pool costs. Read-only file-based database is free to operate.'],
    ['Stateless Architecture', 'No persistent connections, no connection pooling overhead, no session state storage. Just HTTP in, JSON out.'],
    ['Pre-built Databases', 'Build once on dev machine, deploy everywhere. No runtime data processing, no ETL pipelines, no scheduled jobs.'],
    ['Singleton Connections', 'One DB connection per Function App instance. No connection churn, no pool management.'],
    ['Linux Platform', 'EP1 Linux is cheaper than Windows. No Windows licensing surcharge.'],
  ].flatMap((item, i) => {
    const y = 2.05 + i * 0.65;
    return [
      textBox(6.65, y, 6.00, 0.24, [
        para(run(item[0], { sz: 800, bold: true, color: C.greenOk }))
      ]),
      textBox(6.65, y + 0.24, 6.00, 0.36, [
        para(run(item[1], { sz: 700, color: C.dk }), { lnSpc: 112000 })
      ]),
    ];
  })),

  // Bottom: TCO comparison
  rect(0.59, 5.30, 12.15, 0.55, C.tealLt, { rounding: 5000 }),
  textBox(0.75, 5.32, 11.83, 0.50, [
    para([
      run('TCO Comparison: ', { sz: 800, bold: true, color: C.teal }),
      run('Traditional Azure SQL architecture: ~400-550 EUR/mo  |  This SQLite architecture: ~168 EUR/mo  |  Consumption Plan (dev): ~15 EUR/mo', { sz: 800, color: C.dk }),
    ], { algn: 'ctr' }),
  ], { anchor: 'ctr' }),
]));

// ═══════════════════════════════════════════════════════════════════
// SLIDE 14: Summary
// ═══════════════════════════════════════════════════════════════════
slides.push(contentSlide('Technical Summary', [
  ...([
    ['Azure Functions v4 + MCP Streamable HTTP', 'Stateless Node.js 20 functions on Linux EP1. Two endpoints exposing 33 tools via the Model Context Protocol standard.'],
    ['SQLite replaces Azure SQL entirely', 'better-sqlite3 with 200 MB cache + 3 GB mmap. Read-only singleton pattern. Zero database licensing costs.'],
    ['Named Pipes connect to LocalDB', 'XRef build resolves Windows named pipes to stream 26.6M references from Visual Studio\'s cross-reference database.'],
    ['PowerShell automates everything', 'Configuration discovery, database builds, cross-platform binary install, Kudu deployment, RBAC setup, health validation.'],
    ['Security at every layer', 'HTTPS + TLS 1.2, managed identity, RBAC, parameterized queries, keyword validation, row limits, read-only database.'],
    ['Total cost: ~168 EUR/month (prod)', '60% cheaper than Azure SQL architecture. Consumption Plan option at ~15 EUR/month for dev/test environments.'],
  ].flatMap((t, i) => {
    const y = 1.40 + i * 0.82;
    const colors = [C.teal, C.gold, C.brown, C.brick, C.slate, C.greenOk];
    return [
      rect(0.59, y + 0.03, 0.42, 0.42, colors[i], { rounding: 50000 }),
      textBox(0.59, y + 0.03, 0.42, 0.42, [
        para(run(String(i + 1), { sz: 1200, bold: true, color: C.white }), { algn: 'ctr' })
      ], { anchor: 'ctr' }),
      textBox(1.15, y, 11.5, 0.30, [
        para(run(t[0], { sz: 1100, bold: true, color: C.dk }))
      ]),
      textBox(1.15, y + 0.32, 11.5, 0.40, [
        para(run(t[1], { sz: 850, color: C.gray }), { lnSpc: 118000 })
      ]),
    ];
  }))
]));

// ═══════════════════════════════════════════════════════════════════
// SLIDE 15: End
// ═══════════════════════════════════════════════════════════════════
slides.push({
  layout: 40,
  xml: slideXml([])
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
for (let i = 4; i <= 6; i++) zip.deleteFile(`ppt/tags/tag${i}.xml`);
for (let i = 3; i <= 4; i++) zip.deleteFile(`ppt/embeddings/oleObject${i}.bin`);

// 2. Add new slides
slides.forEach((s, i) => {
  const num = i + 1;
  zip.addFile(`ppt/slides/slide${num}.xml`, Buffer.from(s.xml, 'utf-8'));
  zip.addFile(`ppt/slides/_rels/slide${num}.xml.rels`, Buffer.from(slideRels(s.layout), 'utf-8'));
});

// 3. Update presentation.xml
let presXml = zip.readAsText('ppt/presentation.xml');
const slideIdEntries = slides.map((_, i) => {
  const sldId = 300 + i;
  return `<p:sldId id="${sldId}" r:id="rId${100 + i}"/>`;
}).join('');
presXml = presXml.replace(/<p:sldIdLst>[\s\S]*?<\/p:sldIdLst>/, `<p:sldIdLst>${slideIdEntries}</p:sldIdLst>`);
zip.addFile('ppt/presentation.xml', Buffer.from(presXml, 'utf-8'));

// 4. Update presentation.xml.rels
let presRels = zip.readAsText('ppt/_rels/presentation.xml.rels');
presRels = presRels.replace(/<Relationship[^>]*Target="slides\/slide\d+\.xml"[^>]*\/>/g, '');
const newSlideRels = slides.map((_, i) => {
  const num = i + 1;
  return `<Relationship Id="rId${100 + i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${num}.xml"/>`;
}).join('');
presRels = presRels.replace('</Relationships>', newSlideRels + '</Relationships>');
zip.addFile('ppt/_rels/presentation.xml.rels', Buffer.from(presRels, 'utf-8'));

// 5. Update [Content_Types].xml
let contentTypes = zip.readAsText('[Content_Types].xml');
contentTypes = contentTypes.replace(/<Override PartName="\/ppt\/slides\/slide\d+\.xml"[^>]*\/>/g, '');
contentTypes = contentTypes.replace(/<Override PartName="\/ppt\/tags\/tag[4-6]\.xml"[^>]*\/>/g, '');
contentTypes = contentTypes.replace(/<Override PartName="\/ppt\/embeddings\/oleObject[34]\.bin"[^>]*\/>/g, '');
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
