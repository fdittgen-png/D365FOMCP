/**
 * Wiki registry — loads and validates the multi-wiki config.
 *
 * One Function App hosts many wiki MCPs, each with its own blob container
 * holding markdown pages. The registry decides which wikis exist and is
 * loaded once at module import time. Two sources, in priority order:
 *
 *   1. `process.env.WIKI_CONFIG_JSON` — inline JSON, for Azure (so adding a
 *      wiki is an app-settings change, not a redeploy, if you want it to be).
 *   2. `config/wikis.json` — shipped with the code; overrides #1 is ignored.
 *
 * Each entry:
 *   {
 *     name:         "otrs",              slug used in route + MCP server name
 *     title:        "OTRS Resolved Cases",
 *     description:  "…",                 shown to the LLM as the MCP server description
 *     container:    "wiki",              blob container holding the markdown
 *     indexBlob:    "index.md",          optional (default 'index.md')
 *     pagesPrefix:  "tickets/"           optional (default ''): only list blobs under this prefix
 *   }
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Default path to the committed registry (relative to the repo root). */
function defaultRegistryPath() {
  // wiki-registry.js lives at src/azure/wiki-registry.js, so the repo root
  // is two directories up. Use import.meta.url so this works from both the
  // Azure Functions runtime and the local stdio servers.
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', '..', 'config', 'wikis.json');
}

/**
 * Load the registry. Throws if neither source is available or if any entry
 * fails validation — a misconfigured registry at startup is better than a
 * mysterious 404 at request time.
 *
 * @param {object} [opts]
 * @param {string} [opts.configPath] - override for tests
 * @param {object} [opts.env=process.env]
 * @returns {Array<WikiConfig>}
 */
export function loadWikiRegistry({ configPath, env = process.env } = {}) {
  const raw = rawLoad({ configPath, env });
  if (!Array.isArray(raw)) {
    throw new Error('Wiki registry must be a JSON array.');
  }
  return raw.map((entry, i) => validateEntry(entry, i));
}

/**
 * Find a wiki by name. Returns null when not found — caller decides whether
 * to 404 or to raise a clearer error.
 *
 * @param {Array<WikiConfig>} registry
 * @param {string} name
 * @returns {WikiConfig|null}
 */
export function findWiki(registry, name) {
  if (!name) return null;
  return registry.find(w => w.name === name) || null;
}

/** Internal — pick the source and return the unvalidated array. */
function rawLoad({ configPath, env }) {
  if (env.WIKI_CONFIG_JSON && env.WIKI_CONFIG_JSON.trim()) {
    try {
      return JSON.parse(env.WIKI_CONFIG_JSON);
    } catch (err) {
      throw new Error(`WIKI_CONFIG_JSON is not valid JSON: ${err.message}`);
    }
  }
  const path = configPath || defaultRegistryPath();
  if (!existsSync(path)) {
    // Return an empty registry rather than crashing — a fresh deployment
    // may not have a wiki configured yet. The Function route returns 404
    // for any name in that case.
    return [];
  }
  const text = readFileSync(path, 'utf-8');
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${err.message}`);
  }
}

/** Internal — validate and normalize one entry. */
function validateEntry(entry, i) {
  if (!entry || typeof entry !== 'object') {
    throw new Error(`Wiki entry #${i} is not an object.`);
  }
  const { name, title, description, container } = entry;

  if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
    throw new Error(
      `Wiki entry #${i} has invalid name "${name}". ` +
      `Must be 1–63 lowercase alphanumeric or hyphen, starting with alphanumeric.`,
    );
  }
  if (typeof title !== 'string' || title.trim().length === 0) {
    throw new Error(`Wiki "${name}" missing required field "title".`);
  }
  if (typeof description !== 'string' || description.trim().length === 0) {
    throw new Error(`Wiki "${name}" missing required field "description".`);
  }
  if (typeof container !== 'string' || container.trim().length === 0) {
    throw new Error(`Wiki "${name}" missing required field "container".`);
  }

  return {
    name,
    title: title.trim(),
    description: description.trim(),
    container: container.trim(),
    indexBlob: typeof entry.indexBlob === 'string' && entry.indexBlob.trim() ? entry.indexBlob.trim() : 'index.md',
    pagesPrefix: typeof entry.pagesPrefix === 'string' ? entry.pagesPrefix : '',
  };
}

/**
 * @typedef {object} WikiConfig
 * @property {string} name
 * @property {string} title
 * @property {string} description
 * @property {string} container
 * @property {string} indexBlob
 * @property {string} pagesPrefix
 */
