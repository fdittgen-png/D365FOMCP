/**
 * Label-file discovery and parsing — the ONE parser for `*.label.txt`, shared by
 * the KB builder (`build-kb.js`, text only) and the Labels builder
 * (`build-labels.js`, text + description). Labels service concept:
 * docs/Labels-Service-Concept-2026-09-08.md.
 *
 * File format as measured on disk (2026-09-08, 60k files, 76 languages):
 *
 *   ﻿@SYS1=Time transactions                  ← UTF-8 BOM on the first line, CRLF
 *    ;Form caption                             ← description of the PRECEDING label
 *   VendVendorMasterIntegrationMaintain=Maintain vendor master data using data services
 *    ;Duty
 *
 * The description is a single line starting with ` ;` (one space) or `\t;`. It is
 * the developer's comment about where the label is meant to be used, written once
 * in English and copied verbatim into every language file (verified: en-US vs de
 * differ only by untranslated labels). It is therefore stored once per label id.
 *
 * No I/O in the parser; discovery is the only function that touches the disk.
 */
import { readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

const BOM = '﻿';

/** `@SYS154828` | `@Prefix:Key` (canonical) — also `SYS154828` / `Prefix:Key` (input). */
const NUMERIC_ID = /^@?[A-Za-z][A-Za-z0-9_]*\d+$/;
const NAMED_ID = /^@?[A-Za-z][A-Za-z0-9_]*:[A-Za-z0-9_]+$/;
/** A key as written in a label file: `@SYS1`, `SYS1`, `VendMaintain`, `Foo_Bar2`. */
const FILE_KEY = /^@?[A-Za-z_][A-Za-z0-9_]*$/;

function isDescriptionLine(line) {
  return line.startsWith(' ;') || line.startsWith('\t;');
}

/**
 * Parse one label file. Never throws on content.
 * @param {string} text
 * @returns {{ labels: Array<{key: string, text: string, description: string|null}>,
 *             stats: {labels: number, descriptions: number, orphan_descriptions: number, duplicate_keys: number} }}
 */
export function parseLabelFile(text) {
  const byKey = new Map();
  const stats = { labels: 0, descriptions: 0, orphan_descriptions: 0, duplicate_keys: 0 };
  if (typeof text !== 'string') return { labels: [], stats };
  const src = text.startsWith(BOM) ? text.slice(1) : text;
  let current = null;
  for (const rawLine of src.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (!line) continue;
    if (isDescriptionLine(line)) {
      const desc = line.slice(2).trim();
      if (!current) { stats.orphan_descriptions++; continue; }
      if (desc) { current.description = desc; stats.descriptions++; }
      continue;
    }
    const eq = line.indexOf('=');
    if (eq < 1) { current = null; continue; }
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1);
    if (!key || !value || !FILE_KEY.test(key)) { current = null; continue; }
    if (byKey.has(key)) {
      stats.duplicate_keys++;
      const prev = byKey.get(key);
      if (prev.description) stats.descriptions--;
      byKey.delete(key);
    } else {
      stats.labels++;
    }
    current = { key, text: value, description: null };
    byKey.set(key, current);
  }
  return { labels: [...byKey.values()], stats };
}

/** KB contract kept: `[key, value]` pairs, comments skipped (build-kb.js). */
export function* labelLines(content) {
  for (const l of parseLabelFile(content).labels) yield [l.key, l.text];
}

/**
 * Canonical id as the KB `labels` table and the XRef `/Labels/` names use it:
 * a numeric key keeps its written form (`@SYS154828`), a named key is qualified
 * by the file prefix (`@AccountsPayable:VendMaintain`).
 */
export function canonicalLabelId(key, prefix) {
  const k = String(key ?? '').trim();
  if (!k) return null;
  if (k.startsWith('@')) return k;
  if (k.includes(':')) return `@${k}`;
  return prefix ? `@${prefix}:${k}` : `@${k}`;
}

/** Tolerant input normaliser for tool parameters. `null` when it is not a label id. */
export function normalizeLabelIdInput(s) {
  if (s === null || s === undefined) return null;
  const t = String(s).trim();
  if (!t) return null;
  if (!NUMERIC_ID.test(t) && !NAMED_ID.test(t)) return null;
  return t.startsWith('@') ? t : `@${t}`;
}

/**
 * Canonical BCP-47 casing for a language folder name: on disk the same language
 * appears as `en-US` (335 files), `en-us` (480) and `en-Us` (2) — three folders,
 * one language. `Intl.getCanonicalLocales` gives `en-US`, `zh-Hans`, `nb-NO`;
 * an unparseable name is returned as written.
 */
export function canonicalLanguage(name) {
  const s = String(name ?? '').trim();
  if (!s) return s;
  try { return Intl.getCanonicalLocales(s)[0] ?? s; } catch { return s; }
}

/** `SYS.en-us.label.txt` → `{ prefix: 'SYS', language: 'en-us' }`, else null. */
export function splitLabelFileName(fileName) {
  const m = /^([^.]+)\.([^.]+)\.label\.txt$/i.exec(String(fileName ?? ''));
  return m ? { prefix: m[1], language: m[2] } : null;
}

function isDirEntry(dir, entry) {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try { return statSync(join(dir, entry.name)).isDirectory(); } catch { return false; }
}

const SKIP_DIRS = new Set(['bin', 'node_modules', 'XppMetadata', 'Descriptor', '.git']);

/**
 * Every `.label.txt` under `root`: `<Package>/<Model>/AxLabelFile/LabelResources/<lang>/<Prefix>.<lang>.label.txt`.
 * `language` is the folder name as found on disk, `module` the model folder
 * (matches `model_versions.model_name`), `package` the top-level folder.
 * Resolves directory junctions (the KB delta scopes builds through them).
 * @param {string} root
 * @param {(m:string)=>void} [warn]  Warning sink for unreadable sub-directories.
 * @returns {Array<{path: string, language: string, prefix: string, module: string, package: string}>}
 */
export function findLabelFiles(root, warn = () => {}) {
  const out = [];
  const walk = (dir, depth, underResources, ctx) => {
    if (depth > 8) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch (e) { if (depth > 0) warn(e.message); return; }
    for (const entry of entries) {
      const p = join(dir, entry.name);
      if (!isDirEntry(dir, entry)) {
        if (underResources && entry.name.toLowerCase().endsWith('.label.txt')) {
          const split = splitLabelFileName(entry.name);
          out.push({
            path: p,
            language: canonicalLanguage(basename(dir)),
            prefix: split ? split.prefix : entry.name.split('.')[0],
            module: ctx.module,
            package: ctx.package,
          });
        }
        continue;
      }
      if (SKIP_DIRS.has(entry.name)) continue;
      if (underResources) { walk(p, depth + 1, true, ctx); continue; }
      if (entry.name === 'LabelResources') { walk(p, depth + 1, true, ctx); continue; }
      if (entry.name === 'AxLabelFile') { walk(p, depth + 1, false, ctx); continue; }
      if (depth === 0) walk(p, depth + 1, false, { package: entry.name, module: entry.name });
      else if (depth === 1) walk(p, depth + 1, false, { package: ctx.package, module: entry.name });
      else if (depth < 3) walk(p, depth + 1, false, ctx);
    }
  };
  walk(root, 0, false, { package: null, module: null });
  return out;
}
