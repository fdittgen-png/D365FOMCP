/**
 * Extract unique duty-privilege pairs from a DMF ZIP by streaming
 * "System Security Duty.xml" directly from the zip via stdin.
 *
 * Uses a Set of compact keys (not full objects) to minimize memory.
 * Writes a small DMF-format XML the builder can consume.
 *
 * Usage: powershell stream-pipe | node build/extract-duty-privs-from-zip.js <outputPath>
 */

import { writeFileSync } from 'fs';

const outputPath = process.argv[2];
if (!outputPath) { console.error('Usage: ... | node extract-duty-privs-from-zip.js <outputPath>'); process.exit(1); }

// Use Set of compact "dutyId|privId" keys — much less memory than Map of objects
const keys = new Set();
// Store metadata separately — only first occurrence
const dutyNames = new Map(); // dutyId → name (deduplicated)
const privNames = new Map(); // privId → name (deduplicated)

let buffer = '';
let count = 0;
const OPEN = '<SYSTEMSECURITYDUTYENTITY>';
const CLOSE = '</SYSTEMSECURITYDUTYENTITY>';

function extractField(xml, tag) {
  const open = `<${tag}>`;
  const s = xml.indexOf(open);
  if (s === -1) return '';
  const vs = s + open.length;
  const e = xml.indexOf(`</${tag}>`, vs);
  return e === -1 ? '' : xml.substring(vs, e);
}

process.stdin.setEncoding('utf-8');

process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let pos = 0;
  while (true) {
    const start = buffer.indexOf(OPEN, pos);
    if (start === -1) break;
    const end = buffer.indexOf(CLOSE, start);
    if (end === -1) { buffer = buffer.substring(start); return; }

    const inner = buffer.substring(start + OPEN.length, end);
    const dutyId = extractField(inner, 'SECURITYDUTYIDENTIFIER');
    const privId = extractField(inner, 'SECURITYPRIVILEGEIDENTIFIER');
    if (dutyId && privId) {
      const key = dutyId + '|' + privId;
      if (!keys.has(key)) {
        keys.add(key);
        if (!dutyNames.has(dutyId)) dutyNames.set(dutyId, extractField(inner, 'SECURITYDUTYNAME'));
        if (!privNames.has(privId)) privNames.set(privId, extractField(inner, 'SECURITYPRIVILEGENAME'));
      }
    }
    count++;
    pos = end + CLOSE.length;
  }
  if (pos > 0) buffer = buffer.substring(pos);

  if (count % 1000000 === 0) process.stderr.write(`  ${(count/1e6).toFixed(0)}M entities, ${keys.size} unique pairs, ${dutyNames.size} duties, ${privNames.size} privileges\n`);
});

process.stdin.on('end', () => {
  process.stderr.write(`  Done: ${count.toLocaleString()} entities → ${keys.size.toLocaleString()} unique duty-privilege pairs\n`);
  process.stderr.write(`  Unique duties: ${dutyNames.size}, unique privileges: ${privNames.size}\n`);

  // Write as small DMF-format XML
  const parts = ['<?xml version="1.0" encoding="utf-8"?><Document>'];
  for (const key of keys) {
    const [dutyId, privId] = key.split('|');
    parts.push(`<SYSTEMSECURITYDUTYENTITY>`
      + `<SECURITYDUTYIDENTIFIER>${dutyId}</SECURITYDUTYIDENTIFIER>`
      + `<SECURITYDUTYNAME>${dutyNames.get(dutyId) || ''}</SECURITYDUTYNAME>`
      + `<SECURITYPRIVILEGE>0</SECURITYPRIVILEGE>`
      + `<SECURITYPRIVILEGEIDENTIFIER>${privId}</SECURITYPRIVILEGEIDENTIFIER>`
      + `<SECURITYPRIVILEGENAME>${privNames.get(privId) || ''}</SECURITYPRIVILEGENAME>`
      + `<SECURITYROLEIDENTIFIER>DEDUP</SECURITYROLEIDENTIFIER>`
      + `<SECURITYROLENAME>Deduplicated</SECURITYROLENAME>`
      + `</SYSTEMSECURITYDUTYENTITY>`);
  }
  parts.push('</Document>');

  const xml = parts.join('');
  writeFileSync(outputPath, xml, 'utf-8');
  process.stderr.write(`  Written: ${outputPath} (${(Buffer.byteLength(xml) / (1024 * 1024)).toFixed(1)} MB)\n`);
});
