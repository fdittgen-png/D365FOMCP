/**
 * plugin.test.js — static checks for the `d365fo-mcp` Claude Code plugin
 * under plugin/d365fo-mcp/.
 *
 *  - manifests parse and carry the required fields
 *  - every command has frontmatter with a description
 *  - every skill dir has SKILL.md whose `name` equals the directory name
 *  - no personal paths / names / e-mail addresses leak into the package
 *    (the single approved operator contact address is allowed)
 *  - no .mcp.json: transport is the claude.ai connectors (same URL in a plugin hides them)
 *  - generated tool references match the current tool registrations
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate } from '../build/gen-plugin-tool-refs.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_ROOT = join(ROOT, 'plugin');
const PLUGIN = join(PLUGIN_ROOT, 'd365fo-mcp');
const REFS = join(PLUGIN, 'skills', 'd365fo-mcp-tooling', 'references');

const APPROVED_EMAIL = 'florian.dittgen@trelleborg.com';
const APPROVED_REPO_ORG = 'fdittgen-png'; // GitHub org of the public homepage URL
const EXPECTED_SERVERS = ['d365kb', 'd365xref', 'd365sec', 'd365taskrecorder'];

function walk(dir, acc = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

function frontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!m) return null;
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([a-zA-Z_-]+):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].trim();
  }
  return out;
}

describe('plugin manifests', () => {
  it('plugin.json has the required fields', () => {
    const m = JSON.parse(readFileSync(join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8'));
    assert.equal(m.name, 'd365fo-mcp');
    assert.match(m.version, /^\d+\.\d+\.\d+$/);
    assert.ok(m.description && m.description.length > 40);
    assert.ok(m.author && m.author.name);
    assert.equal(m.author.email, APPROVED_EMAIL);
    assert.match(m.homepage, /^https:\/\/github\.com\//);
  });

  it('marketplace.json lists the plugin with a relative source', () => {
    const m = JSON.parse(readFileSync(join(PLUGIN_ROOT, '.claude-plugin', 'marketplace.json'), 'utf8'));
    assert.ok(m.name);
    assert.ok(m.owner && m.owner.name);
    const entry = m.plugins.find((p) => p.name === 'd365fo-mcp');
    assert.ok(entry, 'd365fo-mcp entry missing');
    assert.equal(entry.source, './d365fo-mcp');
  });

  // 2026-09-03: `/plugin marketplace add fdittgen-png/D365FOMCP` clones the repo and reads
  // `<repo>/.claude-plugin/marketplace.json` — it does NOT look under plugin/. The root copy
  // is what a GitHub install sees; the plugin/ copy serves the local `directory` marketplace
  // (C:\working\MCP\plugin). Both must describe the same plugin.
  it('a root .claude-plugin/marketplace.json exists for GitHub installs and matches the plugin/ copy', () => {
    const rootPath = join(ROOT, '.claude-plugin', 'marketplace.json');
    assert.ok(existsSync(rootPath), 'repo-root .claude-plugin/marketplace.json missing — GitHub `/plugin marketplace add` fails without it');
    const root = JSON.parse(readFileSync(rootPath, 'utf8'));
    const local = JSON.parse(readFileSync(join(PLUGIN_ROOT, '.claude-plugin', 'marketplace.json'), 'utf8'));
    assert.equal(root.name, local.name, 'marketplace name differs between root and plugin/ copies');
    const rootEntry = root.plugins.find((p) => p.name === 'd365fo-mcp');
    const localEntry = local.plugins.find((p) => p.name === 'd365fo-mcp');
    assert.ok(rootEntry, 'd365fo-mcp entry missing in root marketplace.json');
    assert.equal(rootEntry.source, './plugin/d365fo-mcp');
    assert.equal(rootEntry.description, localEntry.description);
    assert.equal(rootEntry.category, localEntry.category);
    assert.ok(existsSync(join(ROOT, rootEntry.source, '.claude-plugin', 'plugin.json')), 'root source does not resolve to the plugin');
  });

  it('ships NO .mcp.json — servers come from claude.ai connectors; a plugin server with the same URL hides the connector', () => {
    assert.ok(!existsSync(join(PLUGIN, '.mcp.json')), 'plugin/d365fo-mcp/.mcp.json must not exist (2026-08-25 "hidden — same URL as your server" incident)');
  });
});

describe('plugin commands', () => {
  const dir = join(PLUGIN, 'commands');
  const files = readdirSync(dir).filter((f) => f.endsWith('.md'));

  it('has the expected command set', () => {
    assert.ok(files.length >= 19, `expected ≥19 commands, found ${files.length}`);
    for (const must of ['d365-table.md', 'd365-security.md', 'support-scope.md', 'd365-wiki.md']) {
      assert.ok(files.includes(must), `${must} missing`);
    }
  });

  for (const f of files) {
    it(`${f} has frontmatter with description and argument-hint`, () => {
      const fm = frontmatter(readFileSync(join(dir, f), 'utf8'));
      assert.ok(fm, 'no frontmatter');
      assert.ok(fm.description && fm.description.length > 30, 'description missing/short');
      assert.ok(fm['argument-hint'], 'argument-hint missing');
    });
  }

  it('no command points at a ~/.claude/skills path or a non-existent /scoping command', () => {
    for (const f of files) {
      const t = readFileSync(join(dir, f), 'utf8');
      assert.doesNotMatch(t, /\.claude[\\/]skills/, `${f} references a local skills path`);
      assert.doesNotMatch(t, /(?<!\/)\/scoping\b/, `${f} references /scoping`);
    }
  });
});

describe('plugin skills', () => {
  const dir = join(PLUGIN, 'skills');
  const skillDirs = readdirSync(dir).filter((d) => statSync(join(dir, d)).isDirectory());

  it('includes the tooling skill', () => {
    assert.ok(skillDirs.includes('d365fo-mcp-tooling'));
  });

  for (const d of skillDirs) {
    it(`${d}/SKILL.md exists with matching name and a description`, () => {
      const p = join(dir, d, 'SKILL.md');
      assert.ok(existsSync(p), 'SKILL.md missing');
      const fm = frontmatter(readFileSync(p, 'utf8'));
      assert.ok(fm, 'no frontmatter');
      assert.equal(fm.name, d, 'frontmatter name must equal directory name');
      assert.ok(fm.description && fm.description.length > 40, 'description missing/short');
    });

    it(`${d}/SKILL.md reference pointers resolve to files`, () => {
      const p = join(dir, d, 'SKILL.md');
      const t = readFileSync(p, 'utf8');
      for (const m of t.matchAll(/`references\/([a-z0-9._-]+\.md)`/g)) {
        assert.ok(existsSync(join(dir, d, 'references', m[1])), `${d}: references/${m[1]} missing`);
      }
    });
  }

  it('SKILL.md files stay small (progressive disclosure)', () => {
    for (const d of skillDirs) {
      const lines = readFileSync(join(dir, d, 'SKILL.md'), 'utf8').split('\n').length;
      assert.ok(lines <= 650, `${d}/SKILL.md is ${lines} lines — split into references/`);
    }
  });
});

describe('plugin privacy scrub', () => {
  const files = walk(PLUGIN_ROOT);
  const emailRe = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

  it('contains no personal names or absolute local paths', () => {
    const bad = [];
    for (const f of files) {
      const t = readFileSync(f, 'utf8');
      for (const re of [/florian/i, /dittgen(?!@trelleborg\.com)/i, /C:\\Users/i, /C:\\working/i, /\/c\/Users/i]) {
        // the approved contact e-mail and the GitHub org contain the operator's name — strip them before matching
        const scrubbed = t.split(APPROVED_EMAIL).join('').split(APPROVED_REPO_ORG).join('');
        if (re.test(scrubbed)) bad.push(`${relative(PLUGIN_ROOT, f)} matches ${re}`);
      }
    }
    assert.deepEqual(bad, []);
  });

  it('contains no e-mail address other than the approved operator contact', () => {
    const bad = [];
    for (const f of files) {
      const t = readFileSync(f, 'utf8');
      for (const m of t.match(emailRe) ?? []) {
        if (m !== APPROVED_EMAIL) bad.push(`${relative(PLUGIN_ROOT, f)}: ${m}`);
      }
    }
    assert.deepEqual(bad, []);
  });
});

describe('generated tool references', () => {
  it('match the current tool registrations (run `npm run gen:plugin-refs` if this fails)', () => {
    for (const { file, content } of generate()) {
      const p = join(REFS, file);
      assert.ok(existsSync(p), `${file} missing — run npm run gen:plugin-refs`);
      const onDisk = readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
      assert.equal(onDisk, content.replace(/\r\n/g, '\n'), `${file} is stale — run npm run gen:plugin-refs`);
    }
  });

  it('cover every service the tooling skill points at', () => {
    const skill = readFileSync(join(PLUGIN, 'skills', 'd365fo-mcp-tooling', 'SKILL.md'), 'utf8');
    for (const ref of ['kb-tools.md', 'xref-tools.md', 'sec-tools.md', 'taskrecorder-tools.md', 'wiki-tools.md', 'kb-raw-sql-schema.md', 'response-format.md']) {
      assert.ok(skill.includes(`references/${ref}`), `SKILL.md does not mention references/${ref}`);
      assert.ok(existsSync(join(REFS, ref)), `${ref} missing`);
    }
  });
});
