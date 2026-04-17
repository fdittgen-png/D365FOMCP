/**
 * Tests for scripts/lib/ticket-pdf-helpers.js — the pure filter/dispatch
 * logic behind the XML-to-PDF script. These cover the non-rendering
 * contracts that matter most: empty-value filtering, attachment MIME
 * dispatch, filename safety, and HTML → readable text.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  isFilled,
  collectFilledMetadata,
  isEmbeddableImage,
  attachmentRenderer,
  siblingPdfName,
  safeFilename,
  toReadableText,
  sanitizeForPdfText,
  humanSize,
} from '../src/azure/ticket-pdf-helpers.js';

// ── isFilled ────────────────────────────────────────────────────────────────

describe('isFilled', () => {
  it('returns true for non-empty strings', () => {
    assert.equal(isFilled('hello'), true);
    assert.equal(isFilled(' x '), true);
  });

  it('returns false for empty / whitespace-only strings', () => {
    assert.equal(isFilled(''), false);
    assert.equal(isFilled('   '), false);
    assert.equal(isFilled('\n\t'), false);
  });

  it('returns false for non-string inputs', () => {
    assert.equal(isFilled(null), false);
    assert.equal(isFilled(undefined), false);
    assert.equal(isFilled(0), false);
    assert.equal(isFilled(42), false);
    assert.equal(isFilled(false), false);
    assert.equal(isFilled({}), false);
  });
});

// ── collectFilledMetadata ───────────────────────────────────────────────────

describe('collectFilledMetadata', () => {
  it('returns only fields with non-empty values and in a stable order', () => {
    const ticket = {
      ticketNumber: '202604082004307',
      state: 'closed successful',
      service: 'D365 Support',
      queue: '',           // filtered out
      type: '',
      priority: '3 normal',
      owner: 'agent@trelleborg',
      responsible: '',
      customerUserId: 'user@trelleborg',
      customerId: '',
      sla: '',
      age: '97',
      createdAt: '2026-04-02',
      changedAt: '',
      closedAt: '2026-04-10',
    };
    const rows = collectFilledMetadata(ticket);
    const keys = rows.map(r => r.key);
    assert.deepEqual(keys, [
      'Ticket number', 'State', 'Service', 'Priority',
      'Owner', 'Customer user', 'Age', 'Created', 'Closed',
    ]);
  });

  it('returns an empty array when the ticket has no filled fields', () => {
    const rows = collectFilledMetadata({
      ticketNumber: '', state: '', service: '', queue: '', type: '',
      priority: '', owner: '', responsible: '', customerUserId: '',
      customerId: '', sla: '', age: '', createdAt: '', changedAt: '', closedAt: '',
    });
    assert.deepEqual(rows, []);
  });

  it('handles a ticket whose attributes are missing entirely (not just empty)', () => {
    const rows = collectFilledMetadata({ ticketNumber: 'TN-1' });
    assert.deepEqual(rows, [{ key: 'Ticket number', value: 'TN-1' }]);
  });
});

// ── isEmbeddableImage ──────────────────────────────────────────────────────

describe('isEmbeddableImage', () => {
  it('accepts PNG and JPEG with or without parameters', () => {
    assert.equal(isEmbeddableImage('image/png'), true);
    assert.equal(isEmbeddableImage('image/jpeg'), true);
    assert.equal(isEmbeddableImage('image/jpg'), true);
    assert.equal(isEmbeddableImage('image/PNG; charset=binary'), true);
  });

  it('rejects image types pdfkit cannot embed', () => {
    assert.equal(isEmbeddableImage('image/gif'), false);
    assert.equal(isEmbeddableImage('image/webp'), false);
    assert.equal(isEmbeddableImage('image/svg+xml'), false);
  });

  it('rejects non-image content types', () => {
    assert.equal(isEmbeddableImage('application/pdf'), false);
    assert.equal(isEmbeddableImage('text/plain'), false);
    assert.equal(isEmbeddableImage(''), false);
    assert.equal(isEmbeddableImage(null), false);
  });
});

// ── attachmentRenderer ─────────────────────────────────────────────────────

describe('attachmentRenderer', () => {
  it('routes PDF attachments to passthrough', () => {
    assert.equal(attachmentRenderer('application/pdf'), 'passthrough');
    assert.equal(attachmentRenderer('application/pdf; charset=binary'), 'passthrough');
  });

  it('routes docx (OOXML + legacy) to docx', () => {
    assert.equal(attachmentRenderer(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ), 'docx');
    assert.equal(attachmentRenderer('application/msword'), 'docx');
  });

  it('routes xlsx to xlsx, CSV to text, legacy xls to xlsx', () => {
    assert.equal(attachmentRenderer(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ), 'xlsx');
    assert.equal(attachmentRenderer('application/vnd.ms-excel'), 'xlsx');
    assert.equal(attachmentRenderer('text/csv'), 'text');
  });

  it('routes plain text family to text', () => {
    assert.equal(attachmentRenderer('text/plain'), 'text');
    assert.equal(attachmentRenderer('text/html'), 'text');
  });

  it('routes unknown / binary formats to placeholder', () => {
    assert.equal(attachmentRenderer('application/zip'), 'placeholder');
    assert.equal(attachmentRenderer('application/octet-stream'), 'placeholder');
    assert.equal(attachmentRenderer(''), 'placeholder');
    assert.equal(attachmentRenderer(undefined), 'placeholder');
  });
});

// ── safeFilename + siblingPdfName ───────────────────────────────────────────

describe('safeFilename', () => {
  it('strips path separators and Windows-reserved characters', () => {
    // Backslashes collapse into underscores; the subsequent leading-dot
    // strip removes the remaining `..` prefix, so `..\..\etc\passwd`
    // becomes `_.._etc_passwd` — no path traversal escapes through.
    assert.equal(safeFilename('..\\..\\etc\\passwd'), '_.._etc_passwd');
    assert.equal(safeFilename('a/b/c.txt'), 'a_b_c.txt');
    assert.equal(safeFilename('with: colon and | pipe'), 'with_ colon and _ pipe');
  });

  it('replaces control chars and collapses whitespace', () => {
    assert.equal(safeFilename('line1\nline2'), 'line1_line2');
    assert.equal(safeFilename('  foo   bar  '), 'foo bar');
  });

  it('enforces a maximum length', () => {
    const long = 'a'.repeat(200);
    assert.equal(safeFilename(long, { maxLength: 50 }).length, 50);
  });

  it('falls back when the name reduces to empty', () => {
    assert.equal(safeFilename(''), 'file');
    assert.equal(safeFilename('...'), 'file');
    assert.equal(safeFilename(null), 'file');
  });
});

describe('siblingPdfName', () => {
  it('produces a sortable, deterministic sibling filename', () => {
    assert.equal(
      siblingPdfName('1717381', 1, 'screenshot.png'),
      'ticket-1717381-att-01-screenshot.pdf',
    );
    assert.equal(
      siblingPdfName('1717381', 12, 'report.docx'),
      'ticket-1717381-att-12-report.pdf',
    );
  });

  it('strips original extension and always writes .pdf', () => {
    assert.match(siblingPdfName('1', 1, 'data.xlsx'), /-data\.pdf$/);
    assert.match(siblingPdfName('1', 1, 'noext'), /-noext\.pdf$/);
  });

  it('sanitizes unsafe characters in both ticket id and filename', () => {
    const name = siblingPdfName('../1', 1, 'bad/name.docx');
    assert.doesNotMatch(name, /\.\./);
    assert.doesNotMatch(name, /\//);
    assert.doesNotMatch(name, /\\/);
  });
});

// ── toReadableText ─────────────────────────────────────────────────────────

describe('toReadableText', () => {
  it('returns plain text untouched (only normalizes CRLF)', () => {
    assert.equal(toReadableText('hello\r\nworld'), 'hello\nworld');
  });

  it('strips HTML tags via the fallback stripper when html-to-text is not provided', () => {
    const out = toReadableText('<p>First</p><p>Second</p>', {});
    assert.ok(out.includes('First'));
    assert.ok(out.includes('Second'));
    assert.doesNotMatch(out, /<p>/);
  });

  it('replaces <img src="cid:..."> with a textual placeholder before stripping', () => {
    const src = '<p>See: <img src="cid:part1.xxx@trelleborg.com" alt="screenshot"/> attached.</p>';
    const out = toReadableText(src, {});
    assert.match(out, /\[inline image cid:part1\.xxx@trelleborg\.com\]/);
    assert.doesNotMatch(out, /<img/);
  });

  it('delegates to the injected html-to-text when provided', () => {
    let wasCalled = false;
    const fakeHtmlToText = (html) => { wasCalled = true; return `[STRIPPED] ${html.length} chars`; };
    const out = toReadableText('<p>anything</p>', { htmlToText: fakeHtmlToText });
    assert.equal(wasCalled, true);
    assert.match(out, /\[STRIPPED\]/);
  });

  it('returns an empty string for empty / non-string input', () => {
    assert.equal(toReadableText(''), '');
    assert.equal(toReadableText(null), '');
    assert.equal(toReadableText(undefined), '');
  });

  it('decodes the common HTML entities in the fallback path', () => {
    const out = toReadableText('<p>Tom &amp; Jerry &lt; &gt; &quot;ok&quot;</p>', {});
    assert.ok(out.includes('Tom & Jerry'));
    assert.ok(out.includes('<'));
    assert.ok(out.includes('>'));
    assert.ok(out.includes('"ok"'));
  });
});

// ── sanitizeForPdfText ─────────────────────────────────────────────────────

describe('sanitizeForPdfText', () => {
  it('replaces TABs with four spaces (pdfkit Helvetica has no tab glyph)', () => {
    // This is the actual bug the user saw — tabs rendered as "™•6†÷…"
    assert.equal(sanitizeForPdfText('\t\t\tShort description:'), '            Short description:');
  });

  it('normalizes common smart punctuation to ASCII equivalents', () => {
    const src = '\u2018quoted\u2019 and \u201Cdouble\u201D and em\u2014dash plus ellipsis\u2026';
    assert.equal(
      sanitizeForPdfText(src),
      "'quoted' and \"double\" and em-dash plus ellipsis...",
    );
  });

  it('replaces NBSP with a regular space and strips soft-hyphens', () => {
    // NBSP → ' '  (preserved as whitespace).
    // Soft-hyphen → removed (it's a hint, not rendered content), so the
    // adjacent letters collapse: "b[SH]c" → "bc".
    assert.equal(sanitizeForPdfText('a\u00A0b\u00ADc'), 'a bc');
  });

  it('maps bullet / arrow / check / x to ASCII stand-ins', () => {
    assert.equal(sanitizeForPdfText('\u2022 item \u2192 next \u2713 done \u2717 fail'),
      '* item -> next y done x fail');
  });

  it('strips non-LF control characters but preserves line breaks', () => {
    const src = 'line1\nline2\rline3\n\u0007bell\x1Bescape';
    assert.equal(sanitizeForPdfText(src), 'line1\nline2\nline3\nbellescape');
  });

  it('preserves Latin-1 accented characters (é, ü, ö, ß, £, §)', () => {
    assert.equal(
      sanitizeForPdfText('Café Müßiggang £42 §1'),
      'Café Müßiggang £42 §1',
    );
  });

  it('falls back to "?" for characters outside Latin-1 (emoji, CJK)', () => {
    // \u{1F600} is a non-BMP emoji — becomes two `?` chars in UTF-16.
    // Single-surrogate cases fall to `?` too.
    const out = sanitizeForPdfText('hello \u2605 world \u4E2D');  // black star + CJK
    assert.equal(out, 'hello ? world ?');
  });

  it('returns an empty string for null/undefined/non-string input', () => {
    assert.equal(sanitizeForPdfText(null), '');
    assert.equal(sanitizeForPdfText(undefined), '');
    assert.equal(sanitizeForPdfText(42), '');
    assert.equal(sanitizeForPdfText({}), '');
  });

  it('regression: the 1729255 article-body snippet is now readable', () => {
    // The exact shape that produced "™•6†÷ t description:…" in the PDF.
    const raw = '\t\t\tShort description: \t\t\tVendor Approval Workflow \t\t\t\t';
    const out = sanitizeForPdfText(raw);
    assert.ok(!out.includes('\t'), 'no TABs should remain');
    assert.ok(out.includes('Short description'));
    assert.ok(out.includes('Vendor Approval Workflow'));
  });
});

// ── humanSize ──────────────────────────────────────────────────────────────

describe('humanSize', () => {
  it('renders bytes / KB / MB at the right thresholds', () => {
    assert.equal(humanSize(0), '0 B');
    assert.equal(humanSize(1023), '1023 B');
    assert.equal(humanSize(1024), '1.0 KB');
    assert.equal(humanSize(2048), '2.0 KB');
    assert.equal(humanSize(1024 * 1024), '1.0 MB');
    assert.equal(humanSize(1.5 * 1024 * 1024), '1.5 MB');
  });

  it('tolerates missing / non-numeric input', () => {
    assert.equal(humanSize(null), '0 B');
    assert.equal(humanSize(undefined), '0 B');
    assert.equal(humanSize('not a number'), '0 B');
  });
});
