/**
 * Trace contract v1 — logical-entity hypothesis from prose (TDD §5.3, R11).
 *
 * `matchEntities(text, vocabulary)` → vocabulary ids named in `text`: whole-word,
 * case-insensitive match on `entity_id`, `name` and `aliases[]`, longest phrase
 * first, deduped, in text order, ≤ 20. Pure; the vocabulary is injected.
 * Dependency-free (copied into the plugin hook).
 */
const MAX = 20;

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Build the phrase → entity_id table once per vocabulary object. */
const cache = new WeakMap();
function phrases(vocabulary) {
  if (cache.has(vocabulary)) return cache.get(vocabulary);
  const list = [];
  for (const e of vocabulary?.entities ?? []) {
    const terms = new Set([e.entity_id, e.entity_id.replace(/_/g, ' '), e.name, ...(e.aliases ?? [])]);
    for (const t of terms) {
      const phrase = String(t ?? '').trim().toLowerCase();
      if (phrase) list.push({ phrase, id: e.entity_id, re: new RegExp(`(?<![a-z0-9_])${escapeRe(phrase)}(?:s|es)?(?![a-z0-9_])`, 'gi') });
    }
  }
  list.sort((a, b) => b.phrase.length - a.phrase.length);
  cache.set(vocabulary, list);
  return list;
}

export function matchEntities(text, vocabulary) {
  const s = String(text ?? '');
  if (!s || !vocabulary) return [];
  const hits = [];
  let work = s.toLowerCase();
  for (const p of phrases(vocabulary)) {
    p.re.lastIndex = 0;
    let m;
    while ((m = p.re.exec(work)) !== null) {
      hits.push({ index: m.index, id: p.id });
      // consume the matched span so a shorter phrase inside it cannot re-match
      work = work.slice(0, m.index) + ' '.repeat(m[0].length) + work.slice(m.index + m[0].length);
    }
  }
  hits.sort((a, b) => a.index - b.index);
  const out = [];
  for (const h of hits) if (!out.includes(h.id)) out.push(h.id);
  return out.slice(0, MAX);
}

/** Vocabulary ids from a `Entities: a, b, c` line Claude declared; unknown ids are dropped. */
export function parseDeclaredEntities(line, vocabulary) {
  const known = new Set((vocabulary?.entities ?? []).map((e) => e.entity_id));
  return String(line ?? '')
    .split(/[,;\s]+/)
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t && t !== 'none' && known.has(t))
    .filter((t, i, a) => a.indexOf(t) === i)
    .slice(0, MAX);
}
