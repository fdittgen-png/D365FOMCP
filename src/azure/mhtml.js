/**
 * Minimal MHTML (MIME HTML / "Web Archive, single file") writer — RFC 2557.
 *
 * Produces a single self-contained `multipart/related` document: one text/html
 * part plus one part per embedded resource (screenshots). The HTML references
 * each resource by the same `Content-Location` value used on its MIME part, so
 * browsers and Word resolve `<img src="...">` against the bundled bytes with no
 * external requests.
 *
 * Pure string building — no dependencies. Both the HTML and the binary parts
 * are base64-encoded (valid per RFC 2045) which sidesteps quoted-printable
 * escaping edge cases entirely.
 */

const CRLF = '\r\n';

/** Wrap a base64 string to 76-char lines (RFC 2045). */
function wrap76(b64) {
  return b64.replace(/.{1,76}/g, '$&' + CRLF).trimEnd();
}

/**
 * Build an MHTML document.
 *
 * @param {object} args
 * @param {string} args.title    - document subject line
 * @param {string} args.html     - full HTML document text (UTF-8)
 * @param {Array<{ contentLocation: string, mime: string, bytes: Buffer }>} [args.resources]
 *   embedded resources; `contentLocation` must match the value used in the HTML
 *   `src`/`href` attributes.
 * @param {string} [args.date]   - RFC-822-ish date string for the Date header
 * @returns {string} MHTML text (suitable to write as a `.mhtml` file)
 */
export function buildMhtml({ title, html, resources = [], date }) {
  const boundary = '----=_NextPart_D365TaskRecorder';
  // Absolute http(s) base. MHTML readers (Edge/Chrome/Word) match a subresource
  // by the EXACT url used in the HTML against the part's Content-Location, so the
  // HTML page and its image parts must share one absolute base — relative
  // locations resolve inconsistently and render as broken images.
  const htmlLocation = 'https://taskrecording.local/document.html';

  const lines = [];
  lines.push('From: <Saved by D365FO Task Recorder MCP>');
  lines.push(`Subject: ${(title || 'Task Recording').replace(/[\r\n]+/g, ' ')}`);
  if (date) lines.push(`Date: ${date}`);
  lines.push('MIME-Version: 1.0');
  lines.push(`Content-Type: multipart/related;`);
  lines.push(`\ttype="text/html";`);
  lines.push(`\tboundary="${boundary}"`);
  lines.push('');

  // ── HTML part ────────────────────────────────────────────────────────────
  lines.push(`--${boundary}`);
  lines.push('Content-Type: text/html; charset="utf-8"');
  lines.push('Content-Transfer-Encoding: base64');
  lines.push(`Content-Location: ${htmlLocation}`);
  lines.push('');
  lines.push(wrap76(Buffer.from(html, 'utf8').toString('base64')));
  lines.push('');

  // ── Resource parts (screenshots) ─────────────────────────────────────────
  for (const res of resources) {
    if (!res || !res.bytes) continue;
    lines.push(`--${boundary}`);
    lines.push(`Content-Type: ${res.mime || 'application/octet-stream'}`);
    lines.push('Content-Transfer-Encoding: base64');
    lines.push(`Content-Location: ${res.contentLocation}`);
    lines.push('');
    lines.push(wrap76(Buffer.from(res.bytes).toString('base64')));
    lines.push('');
  }

  lines.push(`--${boundary}--`);
  lines.push('');
  return lines.join(CRLF);
}
