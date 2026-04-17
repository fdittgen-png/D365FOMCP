/**
 * Tests for src/azure/wiki-registry.js.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { loadWikiRegistry, findWiki } from '../src/azure/wiki-registry.js';

function writeTempConfig(json) {
  const dir = mkdtempSync(join(tmpdir(), 'wiki-reg-'));
  const path = join(dir, 'wikis.json');
  writeFileSync(path, JSON.stringify(json));
  return path;
}

describe('loadWikiRegistry — sources', () => {
  it('loads an empty array when the file does not exist', () => {
    const reg = loadWikiRegistry({ configPath: '/tmp/does-not-exist-9999.json', env: {} });
    assert.deepEqual(reg, []);
  });

  it('prefers WIKI_CONFIG_JSON env var over the file', () => {
    const path = writeTempConfig([{ name: 'from-file', title: 'A', description: 'a', container: 'c' }]);
    const reg = loadWikiRegistry({
      configPath: path,
      env: {
        WIKI_CONFIG_JSON: JSON.stringify([
          { name: 'from-env', title: 'B', description: 'b', container: 'd' },
        ]),
      },
    });
    assert.equal(reg.length, 1);
    assert.equal(reg[0].name, 'from-env');
  });

  it('parses a valid file entry with defaults', () => {
    const path = writeTempConfig([{
      name: 'otrs', title: 'OTRS', description: 'cases', container: 'wiki',
    }]);
    const reg = loadWikiRegistry({ configPath: path, env: {} });
    assert.equal(reg.length, 1);
    assert.equal(reg[0].name, 'otrs');
    assert.equal(reg[0].indexBlob, 'index.md');     // default
    assert.equal(reg[0].pagesPrefix, '');           // default
  });
});

describe('loadWikiRegistry — validation', () => {
  it('throws on invalid JSON in the env', () => {
    assert.throws(
      () => loadWikiRegistry({ env: { WIKI_CONFIG_JSON: 'not-json' } }),
      /WIKI_CONFIG_JSON is not valid JSON/,
    );
  });

  it('throws when the root value is not an array', () => {
    assert.throws(
      () => loadWikiRegistry({ env: { WIKI_CONFIG_JSON: '{"name":"x"}' } }),
      /must be a JSON array/,
    );
  });

  it('rejects invalid name slugs', () => {
    const bad = [
      'With_Underscore',
      'UPPER',
      'has space',
      '-leading-hyphen',
      '',
    ];
    for (const name of bad) {
      assert.throws(
        () => loadWikiRegistry({
          env: {
            WIKI_CONFIG_JSON: JSON.stringify([{ name, title: 't', description: 'd', container: 'c' }]),
          },
        }),
        /invalid name/,
        `expected rejection for name="${name}"`,
      );
    }
  });

  it('flags missing required fields', () => {
    assert.throws(
      () => loadWikiRegistry({
        env: { WIKI_CONFIG_JSON: JSON.stringify([{ name: 'ok' }]) },
      }),
      /missing required field "title"/,
    );
  });
});

describe('findWiki', () => {
  const reg = [
    { name: 'otrs', title: 'O', description: 'd', container: 'c', indexBlob: 'i.md', pagesPrefix: '' },
    { name: 'kb',   title: 'K', description: 'd', container: 'c', indexBlob: 'i.md', pagesPrefix: '' },
  ];

  it('finds an entry by exact name', () => {
    assert.equal(findWiki(reg, 'otrs').title, 'O');
  });

  it('returns null for unknown names', () => {
    assert.equal(findWiki(reg, 'nope'), null);
  });

  it('returns null for empty / null inputs', () => {
    assert.equal(findWiki(reg, ''), null);
    assert.equal(findWiki(reg, null), null);
  });
});
