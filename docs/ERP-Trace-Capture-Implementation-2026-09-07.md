# ERP Trace Capture — what shipped on 2026-09-07 and where it deviates from the TDD

Companion to `ERP-Trace-Capture-TDD.md` (v1.2) and `ERP-Trace-Module-TDD.md` (v1.3). This note
records the implementation decisions taken on 2026-09-07 so the TDD checkpoint (§12) can be
ticked against what exists rather than what was planned. Scope of the day: **everything on the
capture side** — the functional-entity pivot vocabulary, the contract package, the Claude Code
hook, the server-side call record, tests, cutover. The ingest Function stays a stub
(`C:\working\ClaudeTrace`, now under git, one new route `POST /trace/ingest`).

## 1. Functional entities — D365FO is the pivot (decision 2026-09-07)

`config/semantic-vocabulary.json` **v2.0.0**: the 60 entity ids, names, processes, descriptions and
relations of v1 are unchanged; every entity now carries

| Key | Content |
|---|---|
| `aliases[]` | business synonyms used by source ERPs and key users (`vendor` ← supplier, creditor, payee, seller). Ambiguous words that would hijack another entity were removed (order, entity, location, account, position, job, open item, work order, frame/scheduling agreement, business unit, order/item line) |
| `d365fo.module` | AOT module of the primary table |
| `d365fo.data_entities[]` | the **logical** layer — AxDataEntityView names, canonical first (`VendVendorV2Entity`) |
| `d365fo.primary_tables[]` | the **physical** layer — AOT tables (`VendTable`) |
| `d365fo.key_fields[]` | natural key `Table.Field` (`VendTable.AccountNum`) |

plus a top-level `pivot` block naming the three levels. Every name was verified against the XRef
(snapshot 2026-09-01) and KB (2026-08-14) — 104 data entities, 106 tables, 113 key fields; the ~70
candidate names that do not exist on this box were left out (`Functional-Entity-Vocabulary-v2-Notes.md`).
**One entity has an empty logical layer: `resource`** (no `WrkCtrResource*Entity` exists) — the case
the cross-ERP design must handle for every source ERP is already present in the pivot itself.

How the three levels reach a trace: the hook writes the functional level into `open.expected_entities`
(vocabulary ids), the call records name the logical level (`touched[].kind = data_entity`) and the
physical level (`touched[].kind = table`) from the arguments; `annotate` can carry `entities[].level`
and `counterpart` for a source-ERP object. The mapping table itself is the downstream project's.

## 2. "Request as resumed by Claude" — Claude compiles it (decision 2026-09-07)

Florian: *if the raw prompt is the best Claude can do, do that; if Claude can do better, do better.*
Implemented as three tiers, recorded in `open.request.source`:

1. **`declared`** — the UserPromptSubmit hook prints the trace protocol as context (≈ 90 tokens):
   begin the reply with `Request: <ERP-neutral restatement>` and `Entities: <business terms or none>`,
   then one strategy line before each group of MCP calls. The hook parses those lines; the `Entities:`
   line is resolved through the vocabulary aliases (`supplier` → `vendor`). This is the intended path.
2. **`interpretation`** — no protocol lines: the first assistant paragraph before the first MCP call.
3. **`user_prompt`** — Claude wrote nothing before calling: the user's prompt, digit runs masked, and
   **withheld entirely** when it carries party/person data (`allow_prompt_fallback`, default true).

`request.key` is the 60-character slug of the interpreted line, cut on a word boundary.
`expected_entities` come from the `Entities:` line (`declared`), else the first call's
`functional_context`, else a vocabulary match on the interpreted line, else `[]` (`none`).

## 3. Hook capture — deviations from TDD §8 / WI-15, all deliberate

| TDD said | Shipped | Why |
|---|---|---|
| `~/.claude/mcp-trace/current` minted at UserPromptSubmit | investigation id = `inv-<prompt_id>`; `current` is still written at PreToolUse **for the server** | the probe showed `prompt_id` on all four events — one turn is one investigation, no id file needed; the same id lets a double-registered hook (settings.json + plugin) dedupe through a shared state file |
| `PostToolUse` fills `result` on the record emitted at `PreToolUse` | the call is **stashed** at PreToolUse (launch ts + `launch_seq`) and the record is **emitted once, complete, at PostToolUse/PostToolUseFailure**; `Stop` flushes stashed calls as `result.kind: unfinished` | NDJSON and HTTP batches are append-only; parallel calls finish out of order (probe: two PreToolUse before the first PostToolUse) — `ts` = launch time, `launch_seq` = launch order |
| hook never writes stdout | stdout **only on UserPromptSubmit**, the protocol instruction | that is how Claude is made to compile the request (§2) |
| user prompt never recorded | never, except tier 3 of §2, masked and denylist-checked | Florian's decision |
| `entities_from: prompt\|functional_context\|vocabulary_match\|none` | + `declared` | the protocol line is a new, better source |
| `result.kind` from `_meta.kind` | `_meta.kind` when the response is JSON; otherwise a text heuristic (`not found`, `no rows`, `## Error`); `PostToolUseFailure` → `error` | Claude Code hands the hook a string, not the MCP result object |
| identifier grammar `^[A-Za-z]…` | `^[%*]?[A-Za-z]…` | `fields_like: '%Vend%'` is a replayable search argument; a digit start is still impossible |
| session key `hour` mode | `sha256(installation_id \| session_id)` on the hook, `hour` mode on the server | the Claude Code session id is random, not person-derived; it groups one session's dossiers |
| policies `identifier \| number \| boolean \| identifier[] \| term \| sql_shape \| payload_ref \| redacted` | + `name_list` — an array of `{ name, type? }` batch targets (`xref_check_exists.objects`) is kept as `type:Name` identifiers and feeds `touched[]` with the right kind | the first live record of the day showed `args: {}` for exactly that call — a batch preflight with no replayable targets is not a replay |

Records: `~/.claude/mcp-trace/hook.ndjson` (authoritative) and `POST <url>/trace/ingest` in the same
call; `~/.claude/claude-trace.log` gets one line per dropped record (`reason (field)`, never text)
and per failed POST. State: `~/.claude/mcp-trace/state/<session_id>.json` under a directory lock.

## 4. Server-side call record (WI-07) — shipped without the injected parameter

`withTrace` wraps every handler on the registration path (`tool-sets.js`, innermost) when
`MCP_TRACE=on`; the three local stdio servers default it on with the file sink
(`~/.claude/mcp-trace/<service>.ndjson`), Azure stays off until `MCP_TRACE`/`TRACE_SINK=http`/
`TRACE_INGEST_URL` are set. The result object is returned by reference; the record reads five keys.
Correlation on stdio comes from `current` (written by the hook before the call reaches the server,
8 h TTL). **Not shipped: the `investigation_id` input parameter injected into every tool schema.**
TDD §11.3 asks to measure the `tools/list` growth first (≈ 100 B × 67 tools); on stdio the hook covers
correlation, and on the connector a `session_key` groups the hour. Open item, not forgotten.

## 5. Files

`src/trace/contract/` — `identifiers.js`, `privacy.js` (regexes copied from `semantic-store.js`,
parity-tested), `arg-policies.js`, `vocabulary-match.js`, `sanitize.js` (the only producer of the
brand), `record.js`, `trace-record.v1.schema.json`, `validate.js` (AJV, server/test side) ·
`src/trace/client/` — `zod-arg-types.js`, `identity.js`, `writer.js`, `with-trace.js` · `src/trace/index.js`
· `plugin/d365fo-mcp/hooks/trace-capture.mjs` + `hooks.json` + `lib/` (**generated**: contract copies,
`arg-policies.json` for 67 tools / 303 parameters, `vocabulary.json` — `npm run gen:trace-hook`) ·
`build/gen-trace-hook.js` · tests `test/trace-*.test.js` (45) · plugin 1.4.0.

## 6. Cutover state (this machine)

`~/.claude/settings.json`: the two v0.1 entries (`trace-request.cjs`, `trace-result.cjs`) removed; five
`trace-capture.mjs` entries added pointing at the repo path (until the plugin update is installed —
then remove them, the plugin's `hooks.json` takes over and the shared state dedupes the overlap).
`C:\working\MCP\.claude\settings.local.json`: the probe hooks removed. `claude-trace.config.json`:
`transport: both`, `ingest_route`, `instruct`, `allow_prompt_fallback`, `erp` added; url/key kept.
The Function must be redeployed (`Deploy.ps1 -SkipInfra`, operator) for `/trace/ingest` to answer;
until then every batch logs `HTTP 404` and the file sink holds the data.
