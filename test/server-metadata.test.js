/**
 * Server identity metadata — what connector directories render for each MCP.
 * Guards: every service has title/description/icons/websiteUrl/instructions,
 * the machine `name`s are unchanged (clients key on them), the icon assets
 * exist, and the PRM document carries a matching resource_name.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  SERVICES, serverInfo, serverOptions, healthInfo, iconPng, iconDataUri,
  wikiService, resourceNameForPath, requestBaseUrl, AUTHOR, CONTACT_EMAIL, WEBSITE_URL,
} from '../src/azure/server-metadata.js';
import { oauthProxyConfig, protectedResourceMetadata } from '../src/azure/oauth-proxy-core.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE = 'https://tis-d-mcpd365fo-func.azurewebsites.net';

describe('server-metadata: service identities', () => {
  it('machine names are stable (clients key sessions/permissions on them)', () => {
    assert.deepEqual(
      Object.fromEntries(Object.entries(SERVICES).map(([k, v]) => [k, v.name])),
      { kb: 'd365fo-kb', xref: 'd365fo-xref', sec: 'd365fo-sec', taskrecorder: 'd365fo-taskrecorder' },
    );
  });

  for (const key of Object.keys(SERVICES)) {
    it(`${key}: serverInfo carries title, description, version, websiteUrl, icons, attribution`, () => {
      const info = serverInfo(key, { baseUrl: BASE });
      assert.equal(info.name, SERVICES[key].name);
      assert.ok(info.title.startsWith('D365 F&O '), 'title has the D365 F&O prefix');
      assert.ok(info.description.length > 200, 'description is a real card body, not a one-liner');
      assert.ok(info.description.includes(AUTHOR), 'author attribution present');
      assert.ok(info.description.includes(CONTACT_EMAIL), 'contact present');
      assert.match(info.version, /^\d+\.\d+\.\d+$/);
      assert.equal(info.websiteUrl, WEBSITE_URL);
      assert.equal(info.icons.length, 3, 'data URI + 128 + 512 https icons');
      assert.ok(info.icons[0].src.startsWith('data:image/png;base64,'));
      assert.equal(info.icons[1].src, `${BASE}/api/icon.png`);
      assert.equal(info.icons[2].src, `${BASE}/api/icon-512.png`);
      assert.ok(info.icons.every(i => i.mimeType === 'image/png' && Array.isArray(i.sizes)));
    });

    it(`${key}: instructions are present and token-frugal (< 600 chars)`, () => {
      const { instructions } = serverOptions(key);
      assert.ok(instructions.length > 80 && instructions.length < 600, `len=${instructions.length}`);
    });
  }

  it('stdio (no baseUrl) still ships the embedded icon only', () => {
    const info = serverInfo('kb');
    assert.equal(info.icons.length, 1);
    assert.ok(info.icons[0].src.startsWith('data:image/png;base64,'));
  });

  it('unknown service key throws', () => {
    assert.throws(() => serverInfo('nope'), /Unknown MCP service/);
    assert.throws(() => serverOptions('nope'), /Unknown MCP service/);
  });

  it('wikiService adapts a registry entry to the same shape', () => {
    const svc = wikiService({ name: 'otrs', title: 'OTRS Resolved Cases', description: 'Resolved D365 support cases.' });
    const info = serverInfo(svc, { baseUrl: BASE });
    assert.equal(info.name, 'wiki-otrs');
    assert.equal(info.title, 'OTRS Resolved Cases');
    assert.ok(info.description.startsWith('Resolved D365 support cases.'));
    assert.ok(serverOptions(svc).instructions.includes('wiki_search'));
  });

  it('healthInfo exposes author + contact + icon URL', () => {
    const h = healthInfo('sec', { baseUrl: BASE });
    assert.equal(h.author, AUTHOR);
    assert.equal(h.contact, CONTACT_EMAIL);
    assert.equal(h.icon, `${BASE}/api/icon.png`);
    assert.equal(h.status, 'ok');
  });
});

describe('server-metadata: icon assets', () => {
  it('128 and 512 px PNGs exist and carry the PNG signature', () => {
    for (const size of [128, 512]) {
      const buf = iconPng(size);
      assert.ok(buf && buf.length > 1000, `icon ${size} present`);
      assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    }
    assert.ok(iconDataUri().length < 12000, 'embedded icon stays small enough for initialize');
  });

  it('assets/ is shipped (not gitignored)', () => {
    const files = readdirSync(join(__dirname, '..', 'assets'));
    assert.ok(files.includes('mcp-icon-128.png') && files.includes('mcp-icon-512.png'));
    const gi = readFileSync(join(__dirname, '..', '.gitignore'), 'utf8');
    assert.ok(!/^assets\/?$/m.test(gi), 'assets/ must not be gitignored');
  });
});

describe('server-metadata: request origin + PRM resource_name', () => {
  it('requestBaseUrl honours x-forwarded-host/proto', () => {
    const req = { url: 'http://127.0.0.1:7071/api/d365kb', headers: new Map([['x-forwarded-host', 'tis-d-mcpd365fo-func.azurewebsites.net'], ['x-forwarded-proto', 'https']]) };
    assert.equal(requestBaseUrl(req), BASE);
    assert.equal(requestBaseUrl({ url: 'http://localhost:7071/api/d365kb', headers: new Map() }), 'http://localhost:7071');
  });

  it('resourceNameForPath maps every MCP route to its title', () => {
    assert.equal(resourceNameForPath('api/d365kb'), SERVICES.kb.title);
    assert.equal(resourceNameForPath('/api/d365sec/'), SERVICES.sec.title);
    assert.equal(resourceNameForPath('api/wiki-mcp/otrs'), 'D365 F&O Wiki — otrs');
    assert.equal(resourceNameForPath(''), 'Trelleborg D365 F&O MCP Services');
  });

  it('protected-resource metadata carries resource_name + resource_documentation', () => {
    const doc = protectedResourceMetadata(BASE, 'api/d365xref', oauthProxyConfig({}));
    assert.equal(doc.resource_name, SERVICES.xref.title);
    assert.equal(doc.resource_documentation, WEBSITE_URL);
  });
});

describe('server-metadata: every MCP server file uses the shared identity', () => {
  const files = [
    'src/functions/d365kb.js', 'src/functions/d365xref.js', 'src/functions/d365sec.js',
    'src/functions/d365taskrecorder.js', 'src/functions/wiki-mcp.js',
    'src/local/mcp-server-kb.js', 'src/local/mcp-server-xref.js', 'src/local/mcp-server-sec.js',
    'src/local/mcp-server-taskrecorder.js', 'src/local/mcp-server-wiki.js',
  ];
  for (const f of files) {
    it(f, () => {
      const src = readFileSync(join(__dirname, '..', f), 'utf8');
      assert.ok(/new McpServer\(serverInfo\(/.test(src), 'constructs McpServer from serverInfo()');
      assert.ok(!/new McpServer\(\{/.test(src), 'no inline identity literal');
    });
  }
  it('index.js registers the icon function', () => {
    const src = readFileSync(join(__dirname, '..', 'src/functions/index.js'), 'utf8');
    assert.ok(src.includes("import './d365icon.js';"));
  });
  it('icon function serves api/icon.png, api/icon-512.png and the root favicon fallback', () => {
    const src = readFileSync(join(__dirname, '..', 'src/functions/d365icon.js'), 'utf8');
    assert.ok(src.includes("route: 'api/icon.png'"));
    assert.ok(src.includes("route: 'api/icon-512.png'"));
    // Deliberately root-level (no api/ prefix): hosts probe /favicon.ico on the origin.
    assert.ok(src.includes("'favicon.ico'") && src.includes("'favicon.png'"));
    for (const script of ['scripts/Enable-McpAuth.ps1', 'scripts/Update-McpAuthExcludedPaths.ps1']) {
      const ps = readFileSync(join(__dirname, '..', script), 'utf8');
      for (const p of ['/api/icon.png', '/api/icon-512.png', '/favicon.ico', '/favicon.png']) {
        assert.ok(ps.includes(`'${p}'`), `${script} excludes ${p} from Easy Auth`);
      }
    }
  });
});
