/**
 * Azure Function: OTRS → Wiki Ingestor
 *
 * Called by Power Automate once the OTRS Extractor has returned an XML
 * batch of validated resolved tickets. Parses the envelope, writes one
 * markdown page per ticket into the target wiki's blob container, and
 * rewrites the wiki's index.md catalog. The same orchestration
 * (`wiki-ingest-core.js`) is used by the human-facing admin UI in
 * `otrs-admin.js` — keeps behavior identical across both entry points.
 *
 * Route:        POST /api/otrs/ingest
 * Auth:         function key (set `x-functions-key` header, or ?code= query string)
 * Content-Type: application/xml (or text/xml)
 * Request body: the OtrsExtract envelope produced by /api/otrs/extract
 * Query param:  ?wiki=<name>  (optional — defaults to "otrs")
 * Response:     application/json — see IngestSummary in wiki-ingest-core.js
 */

import { app } from '@azure/functions';
import { loadWikiRegistry, findWiki } from '../azure/wiki-registry.js';
import { createWikiWriter } from '../azure/wiki-writer.js';
import { ingestExtractXml } from '../azure/wiki-ingest-core.js';

const DEFAULT_WIKI = 'otrs';

app.http('otrs-ingest', {
  methods: ['POST'],
  route: 'otrs/ingest',
  authLevel: 'function',
  handler: async (request, context) => {
    try {
      const url = new URL(request.url);
      const wikiName = (url.searchParams.get('wiki') || DEFAULT_WIKI).trim();

      // ── Resolve target wiki ──────────────────────────────────────────────
      let wiki;
      try {
        const registry = loadWikiRegistry();
        wiki = findWiki(registry, wikiName);
        if (!wiki) {
          return {
            status: 404,
            jsonBody: {
              error: `Wiki "${wikiName}" is not configured.`,
              available: registry.map(w => w.name),
            },
          };
        }
      } catch (err) {
        context.error('otrs-ingest registry error:', err);
        return { status: 500, jsonBody: { error: 'Wiki registry failed to load.', hint: err.message } };
      }

      // ── Read XML body ────────────────────────────────────────────────────
      const contentType = (request.headers.get('content-type') || '').toLowerCase();
      if (!contentType.includes('xml') && !contentType.includes('text/plain')) {
        return {
          status: 415,
          jsonBody: {
            error: 'Unsupported Content-Type.',
            hint: 'Send the OtrsExtract envelope with Content-Type: application/xml.',
          },
        };
      }

      const xml = await request.text();
      if (!xml || !xml.trim()) {
        return { status: 400, jsonBody: { error: 'Empty request body. Expected an OtrsExtract XML document.' } };
      }

      // ── Ingest ───────────────────────────────────────────────────────────
      const writer = createWikiWriter(wiki);
      const summary = await ingestExtractXml({
        xml, wiki, writer,
        log: (m) => context.log(`otrs-ingest[${wiki.name}]: ${m}`),
      });

      context.log(
        `otrs-ingest[${wiki.name}]: wrote=${summary.written} failed=${summary.failed} skipped=${summary.total_skipped}`,
      );

      return {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'X-Wiki-Name': wiki.name,
          'X-Wiki-Written': String(summary.written),
          'X-Wiki-Failed': String(summary.failed),
        },
        jsonBody: summary,
      };
    } catch (err) {
      context.error('otrs-ingest error:', err);
      return {
        status: 500,
        jsonBody: {
          error: err.message,
          hint: 'Check XML is a valid OtrsExtract envelope and the wiki container is reachable.',
        },
      };
    }
  },
});
