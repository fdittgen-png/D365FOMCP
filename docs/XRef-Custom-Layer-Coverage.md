# XRef custom-layer coverage & data caveats

Three known limitations surfaced during analysis against the live MCP services.
Two are **data/build** facts (not code defects); one is an **inherent** version
caveat. This page is the canonical reference the tools link to when a custom-
prefix search returns zero rows.

---

## 1. The XRef snapshot does not contain the ISV/custom overlayer

### Symptom
Searches for custom-prefixed objects (e.g. `TBG_*` Trelleborg customisations, the
`TOC_*` ISV entities) return **0 rows** from every XRef tool — `xref_search_names`,
`xref_find_extensions`, `xref_find_references`, etc. A 0-row result is then
ambiguous: it cannot distinguish *"the object does not exist"* from *"the object
exists but is absent from this snapshot."*

### Root cause
The XRef SQLite is extracted by [`build/build-xref-db.js`](../build/build-xref-db.js)
from a SQL Server cross-reference database (`XREF_DATABASE`, default
`XRef_tis-d365fo-dev-021002263202` on `(LocalDB)\MSSQLLocalDB`). The build ingests
**whatever that source DB contains** — it applies **no layer/provider filter**
(see the `names` / `providers` / `refs` inserts). The dev box that produced the
source DB had only the standard layer cross-referenced; the ISV/custom overlayer
(`TBG_*`, `TOC_*`, …) was never compiled into it. Therefore those rows are simply
not present, and **no tool change can make absent rows appear.**

This is why statements about the custom layer must instead rest on: the KB entries
for those objects, the harness behaviour, and the *confirmed absence of extensions
on the standard classes* — never on a literal XRef hit.

### Mitigation in code (discoverability)
`xref_search_names` and `xref_find_extensions` now append a disclosure note to an
**empty** result when the searched name matches a known custom prefix, via
`customLayerNote()` in [`src/azure/shared.js`](../src/azure/shared.js). The note
tells the caller the snapshot may not include the custom layer, so a 0-row result
is not over-interpreted. Standard (non-custom) empty searches are untouched.

Prefixes default to `TBG_, TBG, TOC_, TOC` and are overridable per environment:

```bash
# comma-separated, case-insensitive prefix match on the start of the search term
XREF_CUSTOM_PREFIXES=TBG_,TOC_,ACME_
```

### Real fix (rebuild with the custom layer)
The only way to make custom-layer searches return real rows is to rebuild the
snapshot from a **source XRef DB that actually cross-references the custom layer**:

1. On a build/dev box where the ISV + customisation models are compiled, ensure
   the D365FO cross-reference DB has been (re)generated for that layer. The custom
   models must be present in `PackagesLocalDirectory` and cross-referenced — a
   standard-only build will reproduce this same gap.
2. Point the build at that DB and rebuild:
   ```bash
   # .env: XREF_SERVER, XREF_DATABASE → the layer-complete source DB
   npm run build:xref          # node --max-old-space-size=8192 build/build-xref-db.js
   ```
3. Sanity-check coverage **before** uploading — a layer-complete DB returns rows here:
   ```bash
   npm run start:xref          # then call xref_search_names { pattern: "TBG_" }
   # or directly:  SELECT COUNT(*) FROM names WHERE path LIKE '%/TBG_%';
   ```
4. Upload the rebuilt `d365fo_xref.sqlite` (~3.3 GB) to prod via the deploy flow.
   The XRef build has **no upload integrity check** — verify size/health after
   upload (see the deploy notes; a botched 0-byte upload caused a past outage).

Until that rebuild happens, the disclosure note is the correct behaviour and the
custom-prefix gap stands as a documented limitation.

---

## 2. Form navigation labels vary by version (inherent)

Form navigation paths returned/cited in analysis are verified against official
Microsoft Learn (URLs cited inline) and against field bindings. **Exact in-form
FastTab / group / tab labels can differ slightly between D365FO releases** —
Microsoft renames UI captions across versions while the underlying form, data
source, and field bindings stay stable.

This is not a defect in any tool (there is no "form label" tool to fix) and not
something the snapshot can pin down, because the label depends on the *target
environment's* version. When citing a navigation path:

- Treat the **form name + data source + field binding** as authoritative.
- Treat the **FastTab/group caption** as indicative — confirm against the target
  environment's version if an exact label match matters.

---

## 3. Line-level offsets for KB method source (fixed)

Where XRef returns a reference it carries a real `refs.line`, so citations can be
`:line`. The KB `methods.source_code` column (see
[`build/build-kb.js`](../build/build-kb.js)) stores each method body as a
standalone blob with **no file-absolute offsets**, so historically KB method
source could only be cited by method name, not by line.

**Fixed:** `d365_get_method_source` and `d365_get_class_methods` (with
`include_source`) now render the X++ body with **body-relative line numbers**
(line 1 = first line of the method source) via `numberSourceLines()` in
`shared.js`, and `d365_get_method_source` returns a `line_count` in its typed
payload. Citations like *"`Class.method` line 12"* are now precise and
reproducible. Note the offsets are relative to the method body, not the source
file (the file offset is not stored in the KB).
