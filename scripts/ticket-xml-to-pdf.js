/**
 * CLI wrapper: render an OTRS-extract XML file as PDFs on disk.
 *
 * Delegates the actual rendering to `src/azure/ticket-pdf-renderer.js`,
 * which is the same code path the admin endpoint
 * (`POST /api/otrs-admin/convert-to-pdf`) uses. That way the on-disk
 * output and the browser-downloaded ZIP are byte-identical.
 *
 * Usage:
 *   node scripts/ticket-xml-to-pdf.js <xml-file> [output-dir]
 *   npm run ticket-to-pdf -- <xml-file> [output-dir]
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderExtractPdfs, loadPdfDeps } from '../src/azure/ticket-pdf-renderer.js';

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error('Usage: node scripts/ticket-xml-to-pdf.js <xml-file> [output-dir]');
    process.exit(2);
  }
  const xmlPath = path.resolve(args[0]);
  const outDir  = path.resolve(args[1] || path.join(process.cwd(), 'output'));

  if (!existsSync(xmlPath)) {
    console.error(`XML file not found: ${xmlPath}`);
    process.exit(1);
  }
  mkdirSync(outDir, { recursive: true });

  const xml = readFileSync(xmlPath, 'utf8');
  const deps = await loadPdfDeps();

  const { tickets, files, warnings } = await renderExtractPdfs({ xml, deps });
  if (tickets === 0) {
    console.error('No <Ticket> elements in the XML — nothing to render.');
    process.exit(1);
  }
  console.log(`Rendering ${tickets} ticket(s) → ${outDir}`);

  for (const { filename, buffer } of files) {
    const outPath = path.join(outDir, filename);
    writeFileSync(outPath, buffer);
    console.log(`  → ${outPath} (${buffer.length} bytes)`);
  }

  for (const w of warnings) {
    console.warn(`  [!] ticket ${w.ticketId} attachment "${w.filename}": ${w.reason}`);
  }

  console.log('\nDone.');
}

// Only run when executed as a script (not when imported by tests).
const thisFile = fileURLToPath(import.meta.url);
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === thisFile;
if (invokedDirectly) {
  main().catch(err => {
    console.error('\nFailed:', err.message);
    if (process.env.DEBUG) console.error(err.stack);
    process.exit(1);
  });
}
