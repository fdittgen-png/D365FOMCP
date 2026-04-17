/**
 * Tests for src/azure/ticket-pdf-renderer.js.
 *
 * We don't try to re-parse PDF bytes — that's brittle and pdfkit is
 * covered by its own test suite upstream. What we DO verify:
 *   - file naming matches scripts/lib helpers (main + siblings)
 *   - correct file count for an XML with mixed image / non-image attachments
 *   - PDF attachments pass through byte-for-byte (no re-render)
 *   - warnings are emitted (not thrown) when an attachment fails to render
 *   - every returned buffer begins with the %PDF- magic so consumers
 *     can trust them as valid PDFs without parsing
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ticketsToXml } from '../src/azure/otrs-xml.js';
import { renderExtractPdfs, loadPdfDeps } from '../src/azure/ticket-pdf-renderer.js';

// Small base64 fixtures — proves passthrough / binary handling without
// fetching real office documents.
const FAKE_PDF_HEADER = Buffer.from('%PDF-1.4\n%fake\n%%EOF').toString('base64');
const PNG_HEADER_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function fixtureTicket({ ticketId = '1001', attachments = [] } = {}) {
  return {
    ticketId,
    ticketNumber: `TN-${ticketId}`,
    title: `Ticket ${ticketId}`,
    service: 'TIS - Digital Solutions Support::ERP::D365',
    queue: '', type: '', priority: '3 normal',
    state: 'closed successful',
    owner: 'agent@trelleborg.com',
    customerUserId: 'user@trelleborg.com',
    age: '42',
    createdAt: '2026-04-10 10:00:00',
    closedAt: '2026-04-15 14:00:00',
    description: 'Customer reports that login fails on new laptop.',
    resolution: 'Re-imaged the device, login works again.',
    dynamicFields: [
      { name: 'ModuleD365',         value: 'Finance' },
      { name: 'AITicketSummary',    value: '' },       // filtered out
      { name: 'Severity',           value: 'Low' },
    ],
    articles: [
      {
        id: '1', number: '1', senderType: 'customer', from: 'user@trelleborg.com',
        subject: 'Login fails', contentType: 'text/plain; charset=utf-8',
        createdAt: '2026-04-10 10:00:00',
        body: 'I cannot log in after receiving the new laptop.',
        attachments,
      },
      {
        id: '2', number: '2', senderType: 'agent', from: 'agent@trelleborg.com',
        subject: 'Re: Login fails', contentType: 'text/plain; charset=utf-8',
        createdAt: '2026-04-15 14:00:00',
        body: 'Re-imaged the device with the IT Services image. Confirmed login works.',
        attachments: [],
      },
    ],
  };
}

const attPng = {
  id: '1', filename: 'screen.png', contentType: 'image/png',
  disposition: 'inline', filesizeBytes: 68,
  content: PNG_HEADER_BASE64,
};
const attPdf = {
  id: '2', filename: 'report.pdf', contentType: 'application/pdf',
  disposition: 'attachment', filesizeBytes: 22,
  content: FAKE_PDF_HEADER,
};
const attUnknown = {
  id: '3', filename: 'mystery.bin', contentType: 'application/octet-stream',
  disposition: 'attachment', filesizeBytes: 8,
  content: Buffer.from('\x00\x01\x02\x03\x04\x05\x06\x07').toString('base64'),
};
const attText = {
  id: '4', filename: 'notes.txt', contentType: 'text/plain',
  disposition: 'attachment', filesizeBytes: 15,
  content: Buffer.from('Hello, world!\n').toString('base64'),
};

// Fixture ticket uses ticketNumber=TN-1001 and title="Ticket 1001", so
// files land as "TN-1001-Ticket 1001.pdf" / "…-att-NN-<name>.pdf".
const MAIN_1001 = 'TN-1001-Ticket 1001.pdf';

describe('renderExtractPdfs — file assembly', () => {
  it('emits exactly one main PDF per ticket when no non-image attachments are present', async () => {
    const xml = ticketsToXml([fixtureTicket({ attachments: [attPng] })], { mode: 'single' });
    const deps = await loadPdfDeps();

    const { tickets, files, warnings } = await renderExtractPdfs({ xml, deps });

    assert.equal(tickets, 1);
    assert.equal(files.length, 1);
    assert.equal(files[0].filename, MAIN_1001);
    assert.equal(files[0].contentType, 'application/pdf');
    assert.equal(warnings.length, 0);
  });

  it('emits one sibling PDF per non-image attachment with the documented naming scheme', async () => {
    const xml = ticketsToXml(
      [fixtureTicket({ attachments: [attPng, attPdf, attUnknown, attText] })],
      { mode: 'single' },
    );
    const deps = await loadPdfDeps();

    const { files, warnings } = await renderExtractPdfs({ xml, deps });
    const names = files.map(f => f.filename);

    // Main PDF + 3 siblings (PNG is embedded, not siblinged).
    assert.equal(files.length, 4);
    assert.deepEqual(names[0], MAIN_1001);

    // Sibling index reflects position across ALL attachments in the
    // ticket (image included) — so PDF = 02, unknown = 03, txt = 04.
    assert.ok(names.includes('TN-1001-Ticket 1001-att-02-report.pdf'));
    assert.ok(names.includes('TN-1001-Ticket 1001-att-03-mystery.pdf'));
    assert.ok(names.includes('TN-1001-Ticket 1001-att-04-notes.pdf'));
    assert.equal(warnings.length, 0);
  });

  it('handles multiple tickets independently', async () => {
    const xml = ticketsToXml(
      [fixtureTicket({ ticketId: 'AAA', attachments: [attPdf] }),
       fixtureTicket({ ticketId: 'BBB', attachments: [] })],
      { mode: 'full' },
    );
    const deps = await loadPdfDeps();

    const { tickets, files } = await renderExtractPdfs({ xml, deps });
    assert.equal(tickets, 2);
    // 2 main PDFs + 1 sibling for ticket AAA. ticketNumber on the
    // fixture is derived from ticketId → "TN-AAA", title "Ticket AAA".
    assert.equal(files.length, 3);
    assert.ok(files.some(f => f.filename === 'TN-AAA-Ticket AAA.pdf'));
    assert.ok(files.some(f => f.filename === 'TN-BBB-Ticket BBB.pdf'));
    assert.ok(files.some(f => /^TN-AAA-Ticket AAA-att-01-report\.pdf$/.test(f.filename)));
  });
});

describe('renderExtractPdfs — attachment passthrough', () => {
  it('passes application/pdf attachments through unchanged byte-for-byte', async () => {
    const xml = ticketsToXml([fixtureTicket({ attachments: [attPdf] })], { mode: 'single' });
    const deps = await loadPdfDeps();

    const { files } = await renderExtractPdfs({ xml, deps });
    const sibling = files.find(f => f.filename.includes('-att-01-report'));
    assert.ok(sibling, 'sibling PDF should exist');
    assert.equal(sibling.buffer.toString('utf8'), Buffer.from(FAKE_PDF_HEADER, 'base64').toString('utf8'));
  });

  it('every emitted main/sibling buffer starts with the %PDF- magic bytes', async () => {
    const xml = ticketsToXml([fixtureTicket({ attachments: [attPdf, attText, attUnknown] })], { mode: 'single' });
    const deps = await loadPdfDeps();

    const { files } = await renderExtractPdfs({ xml, deps });
    for (const f of files) {
      const magic = f.buffer.subarray(0, 4).toString('utf8');
      assert.equal(magic, '%PDF', `${f.filename} does not start with %PDF-`);
    }
  });
});

describe('renderExtractPdfs — input validation', () => {
  it('requires deps to be passed in', async () => {
    const xml = ticketsToXml([fixtureTicket()], { mode: 'single' });
    await assert.rejects(
      () => renderExtractPdfs({ xml }),
      /requires \{ deps \}/,
    );
  });

  it('returns tickets=0 and empty files when the envelope has no <Ticket>', async () => {
    const xml = ticketsToXml([], { mode: 'full' });
    const deps = await loadPdfDeps();
    const { tickets, files, warnings } = await renderExtractPdfs({ xml, deps });
    assert.equal(tickets, 0);
    assert.equal(files.length, 0);
    assert.equal(warnings.length, 0);
  });
});

describe('renderExtractPdfs — warnings are non-fatal', () => {
  it('collects attachment failures into `warnings` without aborting the batch', async () => {
    // Construct a ticket whose single attachment decodes to zero bytes
    // AFTER base64 decoding — the docx code path throws on that because
    // mammoth cannot open it. We expect a warning entry plus the main
    // PDF for the ticket to land successfully.
    const brokenDocx = {
      id: '9', filename: 'broken.docx',
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      disposition: 'attachment', filesizeBytes: 4,
      content: Buffer.from('XXXX').toString('base64'),
    };
    const xml = ticketsToXml([fixtureTicket({ attachments: [brokenDocx] })], { mode: 'single' });
    const deps = await loadPdfDeps();

    const { tickets, files, warnings } = await renderExtractPdfs({ xml, deps });

    assert.equal(tickets, 1);
    assert.ok(files.some(f => f.filename === MAIN_1001), 'main PDF should still be produced');
    assert.ok(warnings.length >= 1, 'docx-with-garbage should surface as a warning');
    assert.equal(warnings[0].filename, 'broken.docx');
    assert.match(warnings[0].reason, /.+/);
  });
});
