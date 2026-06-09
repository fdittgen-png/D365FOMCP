/**
 * Tests for the Task Recorder enriched-document feature:
 *   - docx-screenshots.js       (Word step + screenshot extraction)
 *   - taskrecorder-enrich.js     (KB + Security enrichment, incl. no-email guarantee)
 *   - mhtml.js                   (MHTML web-archive writer)
 *   - taskrecorder-document.js   (end-to-end document builder)
 *   - taskrecorder-tools.js      (taskrecorder_to_document MCP tool + SDK output contract)
 *
 * Run: npm test
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { z } from 'zod';

import { parseDocxScreenshots } from '../src/azure/docx-screenshots.js';
import { enrichFormFromKb, enrichRoleFromSec } from '../src/azure/taskrecorder-enrich.js';
import { buildMhtml } from '../src/azure/mhtml.js';
import { buildTaskRecorderDocument } from '../src/azure/taskrecorder-document.js';
import { registerTaskRecorderTools } from '../src/azure/taskrecorder-tools.js';
import { taskrecorderDocumentOutput, taskrecorderMarkdownOutput } from '../src/azure/output-schemas.js';

const require = createRequire(import.meta.url);
const AdmZip = require('adm-zip');
const Database = require('better-sqlite3');

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLE_AXTR = join(__dirname, 'fixtures', 'taskrec-sample.axtr');

// A 1x1 transparent PNG.
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64');

// ── Synthetic .docx (2 steps; a screenshot embedded on step 1) ────────────────

function buildDocx2Steps() {
  const documentXml = `<?xml version="1.0" encoding="utf-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
            xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>My recording title</w:t></w:r></w:p>
    <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>
      <w:r><w:t>Close the page.</w:t></w:r>
      <w:r><w:drawing><a:blip r:embed="rId5"/></w:drawing></w:r>
    </w:p>
    <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>
      <w:r><w:t>Go to Default dashboard.</w:t></w:r>
    </w:p>
  </w:body>
</w:document>`;
  const relsXml = `<?xml version="1.0" encoding="utf-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>
</Relationships>`;
  const zip = new AdmZip();
  zip.addFile('word/document.xml', Buffer.from(documentXml, 'utf8'));
  zip.addFile('word/_rels/document.xml.rels', Buffer.from(relsXml, 'utf8'));
  zip.addFile('word/media/image1.png', PNG_1PX);
  return zip.toBuffer();
}

// ── In-memory KB + Sec databases ──────────────────────────────────────────────

function buildKbDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE forms (form_name TEXT PRIMARY KEY, module_id TEXT, label TEXT, data_sources_json TEXT);
    CREATE TABLE labels (label_id TEXT PRIMARY KEY, text TEXT);
    CREATE TABLE graph_edges (source_node TEXT, source_type TEXT, target_node TEXT, target_type TEXT, edge_type TEXT);
    CREATE TABLE methods (owner_type TEXT, owner_name TEXT, method_name TEXT, signature TEXT);
    CREATE TABLE data_entities (entity_name TEXT PRIMARY KEY, module_id TEXT, label TEXT, public_name TEXT, public_collection TEXT, is_public INTEGER, primary_table TEXT);
  `);
  db.prepare(`INSERT INTO forms VALUES (?,?,?,?)`).run('SysAADClientTable', 'ApplicationPlatform', '@SYS123', '["SysAADClientTable"]');
  db.prepare(`INSERT INTO labels VALUES (?,?)`).run('@SYS123', 'Microsoft Entra ID applications');
  db.prepare(`INSERT INTO graph_edges VALUES (?,?,?,?,?)`).run('SysAADClientTable', 'form', 'SysAADClientTableInteraction', 'class', 'references');
  db.prepare(`INSERT INTO methods VALUES (?,?,?,?)`).run('class', 'SysAADClientTableInteraction', 'initialize', 'public void initialize()');
  db.prepare(`INSERT INTO data_entities VALUES (?,?,?,?,?,?,?)`).run('SysAADClientTableEntity', 'ApplicationPlatform', '@SYS123', 'SysAADClientTable', 'SysAADClientTables', 1, 'SysAADClientTable');
  return db;
}

function buildSecDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE roles (role_id TEXT PRIMARY KEY, role_name TEXT, label TEXT, license_type TEXT, permission_type TEXT);
    CREATE TABLE role_subroles (parent_role_id TEXT, child_role_id TEXT, is_transitive INTEGER);
    CREATE TABLE duties (duty_id TEXT PRIMARY KEY, duty_name TEXT);
    CREATE TABLE role_duties (role_id TEXT, duty_id TEXT, permission_type TEXT);
    CREATE TABLE duty_privileges (duty_id TEXT, privilege_name TEXT);
    CREATE TABLE privileges (privilege_name TEXT PRIMARY KEY);
    CREATE TABLE role_direct_privileges (role_id TEXT, privilege_name TEXT);
    CREATE TABLE users (user_id TEXT PRIMARY KEY, person_name TEXT, enabled INTEGER, email TEXT);
    CREATE TABLE user_roles (user_id TEXT, role_id TEXT);
    CREATE TABLE user_role_companies (user_id TEXT, role_id TEXT, company_id TEXT);
  `);
  db.prepare(`INSERT INTO roles VALUES (?,?,?,?,?)`).run('SysServerITManager', 'Information technology manager', null, 'Enterprise', 'Grant');
  db.prepare(`INSERT INTO roles VALUES (?,?,?,?,?)`).run('SUBROLE1', 'Sub role one', null, 'Universal', 'Grant');
  db.prepare(`INSERT INTO role_subroles VALUES (?,?,?)`).run('SysServerITManager', 'SUBROLE1', 0);
  db.prepare(`INSERT INTO duties VALUES (?,?)`).run('DUTY1', 'Maintain system settings');
  db.prepare(`INSERT INTO role_duties VALUES (?,?,?)`).run('SysServerITManager', 'DUTY1', 'Grant');
  db.prepare(`INSERT INTO duty_privileges VALUES (?,?)`).run('DUTY1', 'PRIV1');
  db.prepare(`INSERT INTO privileges VALUES (?)`).run('PRIV1');
  // email column is intentionally populated with a sentinel that must NEVER surface.
  db.prepare(`INSERT INTO users VALUES (?,?,?,?)`).run('u1', 'Alice Admin', 1, 'do-not-leak@example.invalid');
  db.prepare(`INSERT INTO user_roles VALUES (?,?)`).run('u1', 'SysServerITManager');
  return db;
}

// ── Mock MCP server (mirrors sec-tools.test.js) ───────────────────────────────

function createMockServer() {
  const handlers = {};
  return {
    registerTool: (name, config, handler) => {
      handlers[name] = { outputSchema: config.outputSchema, annotations: config.annotations, handler };
    },
    handlers,
  };
}

function assertSdkOutputContract(tool, result) {
  if (!tool.outputSchema) return;
  if (result.isError) return;
  assert.notEqual(result.structuredContent, undefined,
    'outputSchema declared but no structuredContent — SDK would reject with -32602.');
  const parsed = z.object(tool.outputSchema).safeParse(result.structuredContent);
  assert.ok(parsed.success, 'structuredContent violates outputSchema: ' +
    (parsed.success ? '' : JSON.stringify(parsed.error.issues)));
}

// ──────────────────────────────────────────────────────────────────────────────

describe('docx-screenshots', () => {
  it('extracts ordered steps and an embedded screenshot', () => {
    const r = parseDocxScreenshots(buildDocx2Steps());
    assert.equal(r.title, 'My recording title');
    assert.equal(r.steps.length, 2);
    assert.equal(r.steps[0].text, 'Close the page.');
    assert.equal(r.steps[0].images.length, 1);
    assert.equal(r.steps[0].images[0].mime, 'image/png');
    assert.equal(r.steps[1].images.length, 0);
    assert.equal(r.imageCount, 1);
  });

  it('returns a text-only export with no images (real sample fixture-shaped docx)', () => {
    // A doc with steps but no media folder -> zero images, no throw.
    const zip = new AdmZip();
    zip.addFile('word/document.xml',
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
      `<w:p><w:pPr><w:pStyle w:val="ListParagraph"/></w:pPr><w:r><w:t>Only step.</w:t></w:r></w:p></w:body></w:document>`);
    const r = parseDocxScreenshots(zip.toBuffer());
    assert.equal(r.imageCount, 0);
    assert.equal(r.steps.length, 1);
    assert.equal(r.steps[0].text, 'Only step.');
  });

  it('throws on a buffer with no document.xml', () => {
    const zip = new AdmZip();
    zip.addFile('not-a-doc.txt', Buffer.from('x'));
    assert.throws(() => parseDocxScreenshots(zip.toBuffer()), /document\.xml not found/);
  });
});

describe('taskrecorder-enrich (graceful degradation)', () => {
  it('reports unavailable when the KB db is null', () => {
    const r = enrichFormFromKb(null, 'SysAADClientTable');
    assert.equal(r.available, false);
    assert.equal(r.found, false);
    assert.match(r.notes[0], /KB database not available/);
  });

  it('reports unavailable when the Sec db is null', () => {
    const r = enrichRoleFromSec(null, 'SysServerITManager');
    assert.equal(r.available, false);
    assert.match(r.notes[0], /Security database not available/);
  });
});

describe('enrichFormFromKb', () => {
  let kb;
  before(() => { kb = buildKbDb(); });
  after(() => kb.close());

  it('resolves form metadata, classes/methods, and endpoints', () => {
    const r = enrichFormFromKb(kb, 'sysaadclienttable');   // case-insensitive
    assert.equal(r.available, true);
    assert.equal(r.found, true);
    assert.equal(r.label, 'Microsoft Entra ID applications');   // @SYS123 resolved
    assert.deepEqual(r.root_tables, ['SysAADClientTable']);
    assert.equal(r.classes.length, 1);
    assert.equal(r.classes[0].class_name, 'SysAADClientTableInteraction');
    assert.equal(r.classes[0].methods[0].method_name, 'initialize');
    assert.equal(r.endpoints.length, 1);
    assert.equal(r.endpoints[0].entity_name, 'SysAADClientTableEntity');
  });

  it('marks an unknown form as not found but available', () => {
    const r = enrichFormFromKb(kb, 'NoSuchForm');
    assert.equal(r.available, true);
    assert.equal(r.found, false);
  });
});

describe('enrichRoleFromSec', () => {
  let sec;
  before(() => { sec = buildSecDb(); });
  after(() => sec.close());

  it('resolves the role chain and assigned users', () => {
    const r = enrichRoleFromSec(sec, 'SysServerITManager', { includeUsers: true });
    assert.equal(r.found, true);
    assert.equal(r.role_name, 'Information technology manager');
    assert.equal(r.sub_roles.length, 1);
    assert.equal(r.duties.length, 1);
    assert.deepEqual(r.privileges, ['PRIV1']);
    assert.equal(r.user_count, 1);
    assert.equal(r.users[0].user_id, 'u1');
    assert.equal(r.users[0].person_name, 'Alice Admin');
  });

  it('NEVER surfaces an email address (privacy)', () => {
    const r = enrichRoleFromSec(sec, 'SysServerITManager', { includeUsers: true });
    const json = JSON.stringify(r);
    assert.ok(!/@/.test(json), 'enrichment output contains an "@" — possible email leak');
    assert.ok(!json.includes('do-not-leak'), 'sentinel email value leaked into output');
    // The user object exposes only id/name/enabled.
    assert.deepEqual(Object.keys(r.users[0]).sort(), ['enabled', 'person_name', 'user_id']);
  });

  it('marks an unknown role as not found', () => {
    const r = enrichRoleFromSec(sec, 'NoSuchRole');
    assert.equal(r.found, false);
  });

  it('does not query users when include_users is false', () => {
    const r = enrichRoleFromSec(sec, 'SysServerITManager', { includeUsers: false });
    assert.equal(r.found, true);
    assert.equal(r.users_included, false);
    assert.equal(r.users.length, 0);
    assert.equal(r.user_count, 0);
    assert.equal(r.duties.length, 1);   // role chain still resolved
  });
});

describe('buildMhtml', () => {
  it('emits a multipart/related archive with an embedded image part', () => {
    const m = buildMhtml({
      title: 'T',
      html: '<html><body><img src="images/a.png"></body></html>',
      resources: [{ contentLocation: 'images/a.png', mime: 'image/png', bytes: PNG_1PX }],
    });
    assert.match(m, /Content-Type: multipart\/related/);
    assert.match(m, /Content-Location: images\/a\.png/);
    assert.match(m, /Content-Type: image\/png/);
    assert.ok(m.includes(PNG_1PX.toString('base64').slice(0, 20)));
  });
});

describe('buildTaskRecorderDocument (end-to-end)', () => {
  let kb, sec, axtr, docx, out;
  before(() => {
    kb = buildKbDb();
    sec = buildSecDb();
    axtr = readFileSync(SAMPLE_AXTR);
    docx = buildDocx2Steps();
    out = buildTaskRecorderDocument(axtr, docx, {
      kbDb: kb, secDb: sec, includeUsers: true, maxUsers: 10,
      fileName: 'taskrec-sample.axtr', generatedAt: '2026-06-09T12:00:00Z',
    });
  });
  after(() => { kb.close(); sec.close(); });

  it('maps the two recorded actions to the two Word steps', () => {
    assert.equal(out.structured.step_count, 2);
    assert.equal(out.structured.steps[0].description, 'Close the page.');
    assert.equal(out.structured.steps[0].object_name, 'SysAADClientTable');
    assert.equal(out.structured.steps[0].has_security, true);
    assert.equal(out.structured.steps[1].description, 'Go to Default dashboard.');
    assert.equal(out.structured.steps[1].has_security, false);
  });

  it('embeds the step-1 screenshot in the MHTML', () => {
    assert.equal(out.structured.screenshot_count, 1);
    assert.equal(out.structured.screenshots_present, true);
    assert.equal(out.structured.steps[0].screenshot_count, 1);
    assert.match(out.mhtml, /Content-Type: image\/png/);
    assert.match(out.mhtml, /Content-Location: images\/step01_1\.png/);
  });

  it('includes KB technical enrichment for the used form', () => {
    assert.equal(out.structured.kb_available, true);
    const f = out.structured.forms_enriched.find(x => x.form_name === 'SysAADClientTable');
    assert.ok(f);
    assert.equal(f.kb_found, true);
    assert.equal(f.class_count, 1);
    assert.equal(f.endpoint_count, 1);
  });

  it('includes role-based security with users (and one matched BPM role)', () => {
    assert.equal(out.structured.sec_available, true);
    const matched = out.structured.roles_enriched.find(r => r.queried === 'SysServerITManager');
    assert.ok(matched);
    assert.equal(matched.found, true);
    assert.equal(matched.user_count, 1);
  });

  it('validates against its output schema', () => {
    const parsed = taskrecorderDocumentOutput.safeParse(out.structured);
    assert.ok(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues));
  });

  it('never leaks an email address into the generated document', () => {
    assert.ok(!out.mhtml.includes('do-not-leak'), 'sentinel email leaked into the MHTML document');
    // The decoded HTML must list the user without an email.
    assert.ok(out.mhtml.includes('Alice Admin') === false || !out.mhtml.includes('@example.invalid'));
  });
});

describe('taskrecorder MCP tools', () => {
  let server;
  before(() => {
    server = createMockServer();
    registerTaskRecorderTools(server);
  });

  it('registers both tools', () => {
    assert.ok(server.handlers['taskrecorder_to_markdown']);
    assert.ok(server.handlers['taskrecorder_to_document']);
  });

  it('taskrecorder_to_markdown returns schema-valid structuredContent', async () => {
    const tool = server.handlers['taskrecorder_to_markdown'];
    const result = await tool.handler({ file_content: readFileSync(SAMPLE_AXTR).toString('base64'), file_name: 'taskrec-sample.axtr' });
    assert.notEqual(result.isError, true);
    assertSdkOutputContract(tool, result);
    const parsed = taskrecorderMarkdownOutput.safeParse(result.structuredContent);
    assert.ok(parsed.success);
    assert.match(result.structuredContent.markdown, /Task Recording/);
  });

  it('taskrecorder_to_markdown errors on missing input', async () => {
    const tool = server.handlers['taskrecorder_to_markdown'];
    const result = await tool.handler({});
    assert.equal(result.isError, true);
  });

  it('taskrecorder_to_document writes an MHTML file and returns a schema-valid summary', async () => {
    const tool = server.handlers['taskrecorder_to_document'];
    const outPath = join(tmpdir(), `taskrec-test-${process.pid}.mhtml`);
    try {
      const result = await tool.handler({
        file_content: readFileSync(SAMPLE_AXTR).toString('base64'),
        docx_content: buildDocx2Steps().toString('base64'),
        output_path: outPath,
        return_inline: true,
      });
      assert.notEqual(result.isError, true);
      assertSdkOutputContract(tool, result);
      assert.equal(result.structuredContent.output_path, outPath);
      assert.ok(existsSync(outPath), 'the .mhtml file was not written');
      const written = readFileSync(outPath, 'utf8');
      assert.match(written, /multipart\/related/);
      assert.equal(result.structuredContent.document_mhtml, written);
      // KB/Sec singletons point at non-existent default paths in tests -> enrichment unavailable, but the tool still succeeds.
      assert.equal(result.structuredContent.step_count, 2);
    } finally {
      if (existsSync(outPath)) rmSync(outPath);
    }
  });

  it('taskrecorder_to_document rejects a relative output_path', async () => {
    const tool = server.handlers['taskrecorder_to_document'];
    const result = await tool.handler({
      file_content: readFileSync(SAMPLE_AXTR).toString('base64'),
      output_path: 'relative/path.mhtml',
    });
    assert.equal(result.isError, true);
  });

  it('taskrecorder_to_document errors when no .axtr is supplied', async () => {
    const tool = server.handlers['taskrecorder_to_document'];
    const result = await tool.handler({});
    assert.equal(result.isError, true);
  });
});
