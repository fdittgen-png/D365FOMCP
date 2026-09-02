# Typecheck baseline (issue #103, PR 1)

`npm run typecheck` runs `tsc -p jsconfig.json` — TypeScript's checker over the existing
JavaScript (`checkJs` + JSDoc). No emit, no `.ts` files, nothing deployed changes.
Advisory only: it is **not** part of `npm test` until the count reaches zero.

## Baseline — 2026-09-02

| | |
|---|---:|
| TypeScript (pinned, dev-only) | 5.9.3 |
| Files checked | `src/**/*.js` + `build/**/*.js` — 84 (46 `src/azure`, 16 `src/functions`, 5 `src/local`, 1 `src/constants.js`, 16 `build`) |
| **Errors** | **215** |
| Files with errors | 30 |
| `src/azure/shared.js` | 1 |
| `src/azure/output-schemas.js` | 0 |

Config: `strict: false`, `skipLibCheck: true`, `maxNodeModuleJsDepth: 0`. Without the
last option tsc also checks untyped dependency JS (`fontkit`, `pdfkit`, `html-to-text`,
`adm-zip`, `sql.js`) and reports 421 extra errors that are not ours.

`strict: false` already implies `noImplicitAny: false`, so the alternate configuration
the issue mentions is the same configuration; no second number to report.

### Per file (top 15)

| Errors | File |
|---:|---|
| 58 | `src/azure/sec-builder.js` |
| 41 | `build/merge-kb-custom.js` |
| 28 | `src/functions/d365sec-upload.js` |
| 20 | `src/functions/d365kb-upload.js` |
| 16 | `build/update-xref-module.js` |
| 5 | `src/functions/otrs-admin.js` |
| 5 | `build/xref-source.js` |
| 4 | `src/functions/d365taskrecorder.js` |
| 4 | `build/gen-plugin-tool-refs.js` |
| 4 | `src/azure/wiki-tools.js` |
| 3 | `build/update-kb-model.js` |
| 3 | `build/inject-duty-privs.js` |
| 2 | `build/pe-metadata.js` |
| 2 | `src/azure/wiki-storage.js` |
| 2 | `src/azure/build-jobs.js` |

### Per error code (top 5)

| Count | Code | Example |
|---:|---|---|
| 175 | TS2339 | `build/add-kb-fts.js(47)`: Property 'n' does not exist on type 'unknown' — `db.prepare(...).get()` returns `unknown` in `@types/better-sqlite3`; fix with `/** @type {{ n: number }} */` or a typed `prepare<…>()` |
| 16 | TS2345 | `build/gen-plugin-tool-refs.js(130)`: the test mock server object is not assignable to parameter type `McpServer` |
| 7 | TS2322 | `build/pe-metadata.js(266)`: Type '{}' is not assignable to type '{ [x: string]: { offset: number; size: number } }' |
| 5 | TS2554 | `build/xref-source.js(32)`: Expected 0 arguments, but got 1 |
| 4 | TS2551 | `build/update-xref-module.js(205)`: Property 'names' does not exist on type '{ fingerprint; module_id; name_count; checksum; name }'. Did you mean 'name'? |

The single `shared.js` error is real and is the first ratchet target:
`src/azure/shared.js(482)` TS2322 — `structuredResult` declares `format` as
`'markdown' | 'toon'` but the adaptive default passes `'auto'` (rule #5). The JSDoc
is behind the code.

## Why TypeScript 5.9.3 and not 7.x

TypeScript 7.0.2 (the native compiler) is on `latest`. It was tried first: 421 errors on
the same tree, of which 227 are TS2339 `Property 'X' does not exist on type 'object'`
from JSDoc `@param {object}` annotations that 5.x treats as `any`. Those are low-signal
against a 215-line baseline and would double the ratchet for no code defect. 5.9.3 also
matches the TypeScript VS Code bundles, so the IDE and `npm run typecheck` agree.
Moving to 6/7 is a deliberate step with its own baseline, not a side effect.

## Deployment

Unaffected. `local-deploy/Deploy.ps1` stages an explicit list (`host.json`,
`package.json`, `package-lock.json`, `src/`, `build/`, `www/`, `config/`, `assets/`) —
`jsconfig.json` and `docs/` are never copied — and runs `npm install --omit=dev`, so
`typescript` and `@types/*` never enter the zip. `scripts/Deploy-FunctionApp.ps1` does
the same.

## Ratchet order (from #103)

`shared.js` → `output-schemas.js` (`z.infer` typedefs) → `isv-schema.js`,
`model-descriptors.js`, `tool-guards.js` → `*-tools.js` → `build/`. Re-run
`npm run typecheck` and update the table above in each PR.
