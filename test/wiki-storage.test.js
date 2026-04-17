/**
 * Direct unit tests for src/azure/wiki-storage.js.
 *
 * Covers the parts that wiki-tools.test.js exercises only indirectly:
 *   - parseFrontmatter: every supported scalar/array shape plus graceful
 *     handling of malformed input
 *   - parseMarkdown: documents with / without / malformed frontmatter
 *   - slug <-> blob name round-trips across pagesPrefix variations
 *   - createWikiStore() against a fake BlobServiceClient — getIndex,
 *     getPage (including 404 mapped to null), listPages, loadAllPages,
 *     freshnessBanner (with and without index)
 *   - TTL cache: second call of the same blob returns cached bytes
 *     without round-tripping the fake client
 *
 * These are pure/mocked tests. No network, no env. Each suite uses
 * beforeEach to isolate the cache and client so tests are order-independent.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

import {
  parseFrontmatter,
  parseMarkdown,
  slugToBlobName,
  blobNameToSlug,
  createWikiStore,
  _resetCache,
} from '../src/azure/wiki-storage.js';

// ── Fake blob client ─────────────────────────────────────────────────────────

/**
 * Minimal fake of `@azure/storage-blob`. Exposes a `downloadCount` counter
 * so the cache test can assert the second call didn't re-fetch.
 */
function makeClient(blobs) {
  const state = { downloadCount: 0, listCount: 0 };
  const svc = {
    state,
    getContainerClient(container) {
      return {
        getBlobClient(blobName) {
          return {
            async download() {
              state.downloadCount++;
              const key = `${container}/${blobName}`;
              const b = blobs[key];
              if (!b) {
                const err = new Error('BlobNotFound');
                err.code = 'BlobNotFound';
                err.statusCode = 404;
                throw err;
              }
              const buf = Buffer.from(b.content, 'utf8');
              return {
                readableStreamBody: Readable.from(buf),
                lastModified: b.lastModified ? new Date(b.lastModified) : new Date('2026-01-01T00:00:00.000Z'),
                contentLength: buf.length,
              };
            },
          };
        },
        listBlobsFlat({ prefix = '' } = {}) {
          state.listCount++;
          return (async function* () {
            for (const [key, val] of Object.entries(blobs)) {
              const sep = key.indexOf('/');
              if (sep < 0 || key.slice(0, sep) !== container) continue;
              const name = key.slice(sep + 1);
              if (prefix && !name.startsWith(prefix)) continue;
              yield {
                name,
                properties: {
                  lastModified: val.lastModified ? new Date(val.lastModified) : new Date('2026-01-01T00:00:00.000Z'),
                  contentLength: Buffer.byteLength(val.content || '', 'utf8'),
                },
              };
            }
          })();
        },
      };
    },
  };
  return svc;
}

const WIKI = {
  name: 'demo',
  title: 'Demo Wiki',
  description: 'fixture',
  container: 'demo-wiki',
  indexBlob: 'index.md',
  pagesPrefix: 'pages/',
};

beforeEach(() => _resetCache());

// ── parseFrontmatter ─────────────────────────────────────────────────────────

describe('parseFrontmatter — scalars', () => {
  it('returns an empty object for empty input', () => {
    assert.deepEqual(parseFrontmatter(''), {});
    assert.deepEqual(parseFrontmatter(null), {});
    assert.deepEqual(parseFrontmatter(undefined), {});
  });

  it('parses bare string, integer, float, boolean, null', () => {
    const fm = parseFrontmatter([
      'title: Hello World',
      'count: 42',
      'ratio: 3.14',
      'enabled: true',
      'disabled: false',
      'empty: null',
      'tilde: ~',
    ].join('\n'));
    assert.equal(fm.title, 'Hello World');
    assert.equal(fm.count, 42);
    assert.equal(fm.ratio, 3.14);
    assert.equal(fm.enabled, true);
    assert.equal(fm.disabled, false);
    assert.equal(fm.empty, null);
    assert.equal(fm.tilde, null);
  });

  it('strips matched single and double quotes from strings', () => {
    const fm = parseFrontmatter([
      'a: "quoted value"',
      `b: 'single quoted'`,
    ].join('\n'));
    assert.equal(fm.a, 'quoted value');
    assert.equal(fm.b, 'single quoted');
  });

  it('leaves mismatched quotes alone', () => {
    const fm = parseFrontmatter('odd: "unterminated');
    assert.equal(fm.odd, '"unterminated');
  });

  it('treats missing value as null', () => {
    const fm = parseFrontmatter('bare:');
    assert.ok('bare' in fm);
    assert.equal(fm.bare, null);
  });
});

describe('parseFrontmatter — arrays', () => {
  it('parses inline string arrays', () => {
    const fm = parseFrontmatter('tags: [a, b, c]');
    assert.deepEqual(fm.tags, ['a', 'b', 'c']);
  });

  it('strips quotes from array items', () => {
    const fm = parseFrontmatter(`tags: ["a", 'b', c]`);
    assert.deepEqual(fm.tags, ['a', 'b', 'c']);
  });

  it('returns an empty array for []', () => {
    const fm = parseFrontmatter('tags: []');
    assert.deepEqual(fm.tags, []);
  });
});

describe('parseFrontmatter — resilience', () => {
  it('ignores comment lines starting with #', () => {
    const fm = parseFrontmatter([
      '# this is a comment',
      'title: Real',
      '# another comment',
    ].join('\n'));
    assert.deepEqual(fm, { title: 'Real' });
  });

  it('skips lines it cannot parse without throwing', () => {
    const fm = parseFrontmatter([
      'no colon at all here',
      'valid: works',
      '  ', // blank
      '!!! garbage !!!',
    ].join('\n'));
    assert.deepEqual(fm, { valid: 'works' });
  });

  it('supports CRLF line endings', () => {
    const fm = parseFrontmatter('a: 1\r\nb: 2\r\n');
    assert.deepEqual(fm, { a: 1, b: 2 });
  });
});

// ── parseMarkdown ────────────────────────────────────────────────────────────

describe('parseMarkdown', () => {
  it('returns empty frontmatter for markdown without a fence', () => {
    const r = parseMarkdown('# Just a heading\n\nBody.');
    assert.deepEqual(r.frontmatter, {});
    assert.equal(r.body, '# Just a heading\n\nBody.');
  });

  it('splits fenced frontmatter from the body', () => {
    const src = '---\ntitle: Foo\n---\n\n# H\n';
    const r = parseMarkdown(src);
    assert.equal(r.frontmatter.title, 'Foo');
    assert.match(r.body, /^\s*# H/);
  });

  it('returns empty frontmatter when the closing fence is missing', () => {
    const src = '---\ntitle: unterminated\n\n# Body never closes';
    const r = parseMarkdown(src);
    assert.deepEqual(r.frontmatter, {});
    // Body includes the opener text — we refuse to guess.
    assert.ok(r.body.startsWith('---'));
  });

  it('tolerates CRLF line endings in the fence', () => {
    const src = '---\r\ntitle: Foo\r\n---\r\n\r\n# Body\r\n';
    const r = parseMarkdown(src);
    assert.equal(r.frontmatter.title, 'Foo');
    assert.match(r.body, /# Body/);
  });
});

// ── slug <-> blob name ───────────────────────────────────────────────────────

describe('slugToBlobName / blobNameToSlug', () => {
  it('round-trips with a pages prefix', () => {
    const wiki = { pagesPrefix: 'pages/' };
    const slug = 'alpha/beta-001';
    const blobName = slugToBlobName(wiki, slug);
    assert.equal(blobName, 'pages/alpha/beta-001.md');
    assert.equal(blobNameToSlug(wiki, blobName), slug);
  });

  it('round-trips at container root when prefix is empty', () => {
    const wiki = { pagesPrefix: '' };
    assert.equal(slugToBlobName(wiki, 'foo'), 'foo.md');
    assert.equal(blobNameToSlug(wiki, 'foo.md'), 'foo');
  });

  it('strips a .md suffix the caller included', () => {
    const wiki = { pagesPrefix: 'p/' };
    assert.equal(slugToBlobName(wiki, 'bar.md'), 'p/bar.md');
  });

  it('normalizes backslashes from Windows-pasted slugs', () => {
    const wiki = { pagesPrefix: 'p/' };
    assert.equal(slugToBlobName(wiki, 'sub\\nested\\leaf'), 'p/sub/nested/leaf.md');
  });

  it('refuses to escape outside pagesPrefix by stripping leading slashes', () => {
    const wiki = { pagesPrefix: 'p/' };
    assert.equal(slugToBlobName(wiki, '/etc/passwd'), 'p/etc/passwd.md');
  });
});

// ── createWikiStore ──────────────────────────────────────────────────────────

describe('createWikiStore — getIndex', () => {
  it('returns content and lastModified when present', async () => {
    const serviceClient = makeClient({
      'demo-wiki/index.md': { content: '# hi', lastModified: '2026-04-10T10:00:00Z' },
    });
    const store = createWikiStore(WIKI, { serviceClient });
    const idx = await store.getIndex();
    assert.equal(idx.content, '# hi');
    assert.equal(idx.lastModified, '2026-04-10T10:00:00.000Z');
  });

  it('returns null when the index blob does not exist', async () => {
    const serviceClient = makeClient({}); // nothing in the container
    const store = createWikiStore(WIKI, { serviceClient });
    assert.equal(await store.getIndex(), null);
  });
});

describe('createWikiStore — getPage', () => {
  const blobs = {
    'demo-wiki/pages/hello.md': {
      content: '---\ntitle: Hello\ntags: [greeting, demo]\n---\n\n# Hello\n\nBody text.',
      lastModified: '2026-04-09T12:00:00Z',
    },
  };

  it('returns slug, title, parsed frontmatter, and the split body', async () => {
    const store = createWikiStore(WIKI, { serviceClient: makeClient(blobs) });
    const page = await store.getPage('hello');
    assert.equal(page.slug, 'hello');
    assert.equal(page.blobName, 'pages/hello.md');
    assert.equal(page.title, 'Hello');
    assert.deepEqual(page.frontmatter.tags, ['greeting', 'demo']);
    assert.match(page.body, /^\s*# Hello/);
    assert.ok(page.content.startsWith('---'));
    assert.equal(page.lastModified, '2026-04-09T12:00:00.000Z');
  });

  it('derives title from body H1 when frontmatter has none', async () => {
    const store = createWikiStore(WIKI, {
      serviceClient: makeClient({
        'demo-wiki/pages/noTitle.md': { content: '# Derived Title\n\nBody.' },
      }),
    });
    const p = await store.getPage('noTitle');
    assert.equal(p.title, 'Derived Title');
  });

  it('falls back to the slug when nothing supplies a title', async () => {
    const store = createWikiStore(WIKI, {
      serviceClient: makeClient({
        'demo-wiki/pages/bareSlug.md': { content: 'Body without a heading.' },
      }),
    });
    const p = await store.getPage('bareSlug');
    assert.equal(p.title, 'bareSlug');
  });

  it('returns null for a missing page rather than throwing', async () => {
    const store = createWikiStore(WIKI, { serviceClient: makeClient({}) });
    assert.equal(await store.getPage('nope'), null);
  });
});

describe('createWikiStore — listPages / loadAllPages', () => {
  const blobs = {
    'demo-wiki/index.md':        { content: '# idx' },
    'demo-wiki/pages/a.md':      { content: '---\ntitle: A\n---\nA body.' },
    'demo-wiki/pages/b.md':      { content: 'Plain B body without frontmatter.' },
    'demo-wiki/pages/notes.txt': { content: 'skipped — wrong extension' },
    'demo-wiki/other/c.md':      { content: 'skipped — wrong prefix' },
  };

  it('lists only .md blobs under pagesPrefix, excluding the index and non-md files', async () => {
    const store = createWikiStore(WIKI, { serviceClient: makeClient(blobs) });
    const pages = await store.listPages();
    const slugs = pages.map(p => p.slug).sort();
    assert.deepEqual(slugs, ['a', 'b']);
  });

  it('sorts output by slug', async () => {
    const unsorted = {
      'demo-wiki/pages/zeta.md':  { content: 'z' },
      'demo-wiki/pages/alpha.md': { content: 'a' },
      'demo-wiki/pages/middle.md': { content: 'm' },
    };
    const store = createWikiStore(WIKI, { serviceClient: makeClient(unsorted) });
    const pages = await store.listPages();
    assert.deepEqual(pages.map(p => p.slug), ['alpha', 'middle', 'zeta']);
  });

  it('loadAllPages returns the parsed content of every listed page', async () => {
    const store = createWikiStore(WIKI, { serviceClient: makeClient(blobs) });
    const all = await store.loadAllPages();
    assert.equal(all.length, 2);
    const withFm = all.find(p => p.slug === 'a');
    assert.equal(withFm.frontmatter.title, 'A');
  });

  it('honors the limit option on listPages', async () => {
    const many = {};
    for (let i = 0; i < 5; i++) many[`demo-wiki/pages/p${i}.md`] = { content: `p${i}` };
    const store = createWikiStore(WIKI, { serviceClient: makeClient(many) });
    const pages = await store.listPages({ limit: 2 });
    assert.equal(pages.length, 2);
  });
});

describe('createWikiStore — freshnessBanner', () => {
  it('formats the index lastModified into the standard banner', async () => {
    const svc = makeClient({
      'demo-wiki/index.md': { content: '# idx', lastModified: '2026-04-10T10:00:00Z' },
    });
    const store = createWikiStore(WIKI, { serviceClient: svc });
    assert.equal(await store.freshnessBanner(), '_wiki:demo snapshot: 2026-04-10T10:00:00.000Z_\n\n');
  });

  it('returns empty string when the index is missing', async () => {
    const store = createWikiStore(WIKI, { serviceClient: makeClient({}) });
    assert.equal(await store.freshnessBanner(), '');
  });
});

describe('createWikiStore — cache', () => {
  it('serves a second fetch of the same blob from cache', async () => {
    const blobs = { 'demo-wiki/index.md': { content: '# idx' } };
    const svc = makeClient(blobs);
    const store = createWikiStore(WIKI, { serviceClient: svc });

    await store.getIndex();                   // first — downloads
    await store.getIndex();                   // second — should hit cache
    assert.equal(svc.state.downloadCount, 1);
  });

  it('does not conflate different blob names', async () => {
    const blobs = {
      'demo-wiki/index.md':     { content: 'idx' },
      'demo-wiki/pages/one.md': { content: 'one' },
    };
    const svc = makeClient(blobs);
    const store = createWikiStore(WIKI, { serviceClient: svc });

    await store.getIndex();
    await store.getPage('one');
    assert.equal(svc.state.downloadCount, 2);
  });

  it('also caches the negative result (blob not found)', async () => {
    const svc = makeClient({});
    const store = createWikiStore(WIKI, { serviceClient: svc });

    assert.equal(await store.getIndex(), null);
    assert.equal(await store.getIndex(), null);
    assert.equal(svc.state.downloadCount, 1);
  });

  it('_resetCache clears entries so a fresh fetch happens next', async () => {
    const blobs = { 'demo-wiki/index.md': { content: 'idx' } };
    const svc = makeClient(blobs);
    const store = createWikiStore(WIKI, { serviceClient: svc });

    await store.getIndex();
    _resetCache();
    await store.getIndex();
    assert.equal(svc.state.downloadCount, 2);
  });
});
