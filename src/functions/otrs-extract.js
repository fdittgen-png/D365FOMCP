/**
 * Azure Function: OTRS Extractor
 *
 * Called by Power Automate on a schedule. Pulls newly-resolved D365
 * support tickets from OTRS, validates that each has both a description
 * and a resolution, and returns the batch as XML for the downstream
 * wiki-ingestor Function.
 *
 * Route:         POST /api/otrs/extract
 * Auth:          function key (set `x-functions-key` header, or ?code= query string)
 * Request body:  { mode?: 'incremental' | 'full' | 'preview', limit?: number }
 *                - 'incremental' (default): return only tickets not previously extracted
 *                - 'full':  ignore state, return every ticket that passes validation
 *                - 'preview': same filter as 'incremental' but DO NOT update state
 *                             (lets Power Automate dry-run without losing the marker)
 *                - limit: optional cap on how many tickets to TicketGet this run
 * Response:      application/xml; charset=utf-8 — see otrs-xml.js for the envelope.
 *                Response headers also echo counts so a Power Automate branch can
 *                skip the ingest step when nothing new arrived:
 *                  X-OTRS-Extracted:  validated tickets in the <Ticket> nodes
 *                  X-OTRS-Skipped:    tickets that failed validation or fetch
 *                  X-OTRS-Candidates: total tickets considered this run
 *
 * State:         blob `otrs-extract-state.json` in container `otrs-state`.
 *                Stores the list of ticket IDs successfully extracted so
 *                'incremental' runs don't re-pull the same tickets.
 *
 * The orchestration itself lives in `src/azure/otrs-extract-core.js` so it
 * can be unit-tested without the Azure Functions host.
 */

import { app } from '@azure/functions';
import { createRequire } from 'node:module';
import { readOtrsConfig } from '../azure/otrs-client.js';
import { readState, writeState } from '../azure/otrs-storage.js';
import { ticketsToXml } from '../azure/otrs-xml.js';
import { runExtract } from '../azure/otrs-extract-core.js';
import { splitExtractPerTicket } from '../azure/otrs-xml-split.js';

const require = createRequire(import.meta.url);
const AdmZip = require('adm-zip');

const VALID_MODES = new Set(['incremental', 'full', 'preview']);

app.http('otrs-extract', {
  methods: ['POST'],
  route: 'api/otrs/extract',
  // Function-key auth — Power Automate's HTTP action supports this out of
  // the box. Simpler than Easy Auth + RBAC for a pipeline endpoint that
  // isn't user-facing.
  authLevel: 'function',
  handler: async (request, context) => {
    try {
      // ── Parse body ────────────────────────────────────────────────────────
      let body = {};
      try {
        const raw = await request.text();
        if (raw && raw.trim()) body = JSON.parse(raw);
      } catch (err) {
        return { status: 400, jsonBody: { error: 'Request body must be JSON or empty.', hint: err.message } };
      }

      const mode = VALID_MODES.has(body.mode) ? body.mode : 'incremental';
      const limit = Number.isInteger(body.limit) && body.limit > 0 ? body.limit : null;
      // `perTicket=true` returns a ZIP of individual per-ticket XMLs
      // (each a valid OtrsExtract with count=1). Power Automate's HTTP
      // action natively iterates files inside a ZIP, so this removes
      // the need for a custom XML-split step in the flow.
      const urlSearch = new URL(request.url).searchParams;
      const perTicket = body.perTicket === true || urlSearch.get('perTicket') === 'true';

      // ── Config + state ────────────────────────────────────────────────────
      let cfg;
      try {
        cfg = readOtrsConfig();
      } catch (err) {
        return {
          status: 500,
          jsonBody: {
            error: err.message,
            hint: 'Set OTRS_USERNAME / OTRS_PASSWORD / OTRS_SEARCH_URL / OTRS_GET_URL / OTRS_SERVICE_ID '
                + 'on the Function App (az functionapp config appsettings set …).',
          },
        };
      }

      const state = await readState();
      context.log(`otrs-extract: mode=${mode} limit=${limit ?? '∞'} known=${state.processedTicketIds.length}`);

      // ── Orchestrate ───────────────────────────────────────────────────────
      const { candidateIds, extracted, skipped } = await runExtract({
        mode, limit, cfg, state, log: (m) => context.log(`otrs-extract: ${m}`),
      });
      context.log(`otrs-extract: extracted=${extracted.length} skipped=${skipped.length}`);

      // ── Persist state ─────────────────────────────────────────────────────
      // Only successful extractions are recorded, so a ticket whose
      // resolution gets improved later in OTRS will be retried on the
      // next run. Preview mode skips state writes entirely.
      if (mode !== 'preview' && extracted.length > 0) {
        const newIds = extracted.map(t => t.ticketId);
        const merged = Array.from(new Set([...state.processedTicketIds, ...newIds]));
        try {
          await writeState({
            ...state,
            lastExtractedAt: new Date().toISOString(),
            processedTicketIds: merged,
          });
        } catch (err) {
          // State write failure is not fatal to the response — the caller
          // already has valid XML. Log loudly so operators see it in
          // App Insights.
          context.error('otrs-extract: state blob write failed —', err.message);
        }
      }

      // ── Serialize and respond ─────────────────────────────────────────────
      const xml = ticketsToXml(extracted, { mode, skipped });

      if (perTicket) {
        const parts = splitExtractPerTicket(xml);
        const zip = new AdmZip();
        for (const p of parts) zip.addFile(p.filename, p.buffer);
        zip.addFile('manifest.json', Buffer.from(JSON.stringify({
          generatedAt: new Date().toISOString(),
          mode,
          extracted: extracted.length,
          skipped: skipped.length,
          files: parts.map(p => ({
            filename: p.filename,
            ticketId: p.ticketId,
            ticketNumber: p.ticketNumber,
            title: p.title,
          })),
        }, null, 2), 'utf8'));

        return {
          status: 200,
          headers: {
            'Content-Type': 'application/zip',
            'X-OTRS-Extracted':  String(extracted.length),
            'X-OTRS-Skipped':    String(skipped.length),
            'X-OTRS-Candidates': String(candidateIds.length),
            'X-OTRS-Files':      String(parts.length),
          },
          body: zip.toBuffer(),
        };
      }

      return {
        status: 200,
        headers: {
          'Content-Type': 'application/xml; charset=utf-8',
          'X-OTRS-Extracted':  String(extracted.length),
          'X-OTRS-Skipped':    String(skipped.length),
          'X-OTRS-Candidates': String(candidateIds.length),
        },
        body: xml,
      };
    } catch (err) {
      context.error('otrs-extract error:', err);
      return {
        status: 500,
        jsonBody: {
          error: err.message,
          hint: 'Check OTRS app settings and OTRS service availability.',
        },
      };
    }
  },
});
