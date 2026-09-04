# Technical Design: Trace Capture and Persistence (LLM → trace, MCP → trace)

**Project**: tis-d-mcpd365fo — shared with every future ERP bridge (Infor M3 first)
**Owner**: Trelleborg IT Services (TIS)
**Version**: 1.2 (Draft for review checkpoint — supersedes 1.1: traces record HOW to reproduce an investigation, not its results; `step` phase; hook-based auto-capture in Claude Code)
**Date**: 2026-09-04
**Author**: Fable 5.1
**Status**: Design — **STOP after this document; no implementation, no `az` command, until a human approves §12**
**Companion**: `docs/ERP-Trace-Module-TDD.md` v1.3 covers objectives, the analysis hand-off and the DQ chain. This document is the **write path only**.

---

## 1. Scope

**In scope — from the moment something is worth recording until it is durably stored:**
1. **MCP → trace (Stream 1).** Every tool call on an instrumented MCP server produces one **call record** — the tool, its arguments, how the call ended and which object names it touched — never the response. Automatic; the model never sees or calls it.
2. **LLM → trace (Stream 2).** An investigation is recorded in four phases — `open`, `step`, `annotate`, `close` — lifted from the transcript by hooks in Claude Code, or written through exactly one write-only tool on claude.ai.
3. **Correlation at write time.** An `investigation_id` minted by `open` is stamped on every Stream-1 record produced while the investigation is open.
4. **Privacy enforcement** at a single choke point before anything leaves the process.
5. **Transport** — a non-blocking writer with pluggable sinks — and **persistence** in Cosmos DB behind an ingest Function App.
6. **Reproducibility (R0, decided 2026-09-04 — see the companion §1.0).** `open` carries a `request` (`key` reused across ERPs, `interpreted` = the interpretation line Claude writes before its first tool call, `approach` = its announced plan); `step` carries each strategy line; Stream 1 records **every call with its arguments and never its response** — results are verbose, add nothing the snapshot does not hold, and are reproduced by replaying the call against `mcp.snapshot_date`; Stream 2 records the process and lifecycle Claude reconstructed and the conclusion. Two dossiers with the same `request.key` on two ERPs are compared by replaying their calls.

**Out of scope — explicitly:** reading traces back (by the model or by any MCP tool), classification of mappings (known / candidate / unknown), DQ-rule derivation, writes into the semantic layer, dashboards, exports, retention analytics. The only consumer named in this document is "the analysis project", and only to state that the persisted shape is what it will read.

### 1.1 Constraints inherited from the codebase
- Azure MCP entry points build a **stateless `McpServer` per request**; only stdio has a process lifetime → correlation must be carried by the records, not by a session (§4).
- `withRegistrationPolicy` in `tool-sets.js` is the one place every `registerTool` passes through (profile, title, freshness) → the Stream-1 wrapper and the correlation parameter are installed there, never per tool (§8).
- `effectiveProfile()` falls back to `full` only when a profile leaves **zero** tools → the trace tool must not count (§8).
- The static scan in `test/response-format.test.js` accepts only `READ_ONLY_(DB|LIVE)_ANNOTATIONS` in `TOOL_FILES`; a write-annotation constant already exists in `semantic-tools.js` → add `WRITE_TRACE_ANNOTATIONS`, widen the scan deliberately.
- Deploy is a root-zip (`Deploy-FunctionApp.ps1`) → no npm workspaces (symlinks); a second Function App for ingest.
- Privacy denylist and `MCP_ERP_SYSTEM` / `MCP_ERP_VERSION` / `MCP_INSTALLATION_ID` already exist in `semantic-store.js` → reuse the env names; copy (not import) the regexes and parity-test them.
- Global rule: no consumer/vendor data, no person identity, ever, in a trace.

---

## 2. The two streams

| | **Stream 1 — `mcp`** | **Stream 2 — `claude`** |
|---|---|---|
| Trigger | every tool call, after the handler resolves | the model calls `trace_investigation` |
| Producer | `withTrace()` on the registration path | the tool handler |
| Content | tool name, **replayable args**, result kind/bytes/rows/has_more, `touched` names — **never the response** | phase, **request** (key, interpreted line, approach), **step** (strategy line), per-entity role + counterpart, expectations, **process**, **lifecycle**, conclusion (final answer) + differences |
| Visible to the model | no — no tool, no read path | one write-only tool |
| Correlation | `investigation_id` stamped from the parameter or the process default | `investigation_id` required on `annotate`/`close`, minted by `open` |

Both streams share one envelope (§5.1) and one persistence shape (§7).

### 2.1 What a complete investigation writes (sequence)
```
① open   { request: { key, interpreted, approach? } }            → claude record (hook: from Claude's first line; tool: explicit); stdio default set
② step   { n: 1, intent: "Now querying the KB for the vendor data entity and its backing table." }   → claude record
③ d365_get_entity_sources { entity_name, limit, functional_context } → tool runs unchanged; 1 mcp CALL RECORD (args, result kind/bytes, touched) — no response
④ … more steps and calls …                                          → 1 claude record per strategy line, 1 mcp record per call
⑤ annotate { entities[], expectations[], process[], lifecycle[] }   → claude record (Claude's structural reading)
⑥ close    { conclusion { summary (the final answer), outcome, differences? } }  → claude record; stdio default cleared
⑦ — later, on another ERP — ① with the SAME request.key, ②…⑥ against that ERP's MCP   → a second dossier, joinable on request.key
```
Every record passes `sanitize()` → `TraceWriter` → sink → ingest → Cosmos. Nothing in this sequence reads anything back. Order within a dossier is `ts`, then `id` (ULIDs are time-ordered), so the sequence is replayable across stateless Azure requests.

---

## 3. Architecture

```
 Claude ──▶ ERP MCP server (kb · xref · sec · taskrecorder · M3 bridge)
              ├─ Stream 1: withTrace() wraps every handler → call record (tool, args, result kind/size, touched names) — never the response
              └─ Stream 2: open · step · annotate · close
                   ├─ Claude Code: HOOKS lift open/step/close from the transcript (UserPromptSubmit / PreToolUse / PostToolUse / Stop) — no model call
                   └─ claude.ai:   trace_investigation (the only tool that crosses)
                          │
                 sanitize() — the ONLY producer of a SanitizedTraceRecord
                          │
                 TraceWriter — bounded ring, batched, never awaited on the response path
                          │  sinks: file (stdio) · queue (Azure default) · http (M3 / push) · memory · null (tests)
                          ▼
     trace-ingest Function App — queue trigger + HTTP — schema + privacy re-check, fail-closed auth
                          ├─ valid   → Cosmos `traces`
                          └─ invalid → Cosmos `deadletter` (id, reason, hash — never the payload)
```
**Coupling.** The wire contract is a JSON Schema; any emitter producing conforming JSON participates. `src/trace/` imports nothing from `src/azure/`; the reverse only via `src/trace/index.js` (static scan). The ingest app takes a hash-checked **copy** of the contract.
**Placement.** `src/trace/contract/` (schema, fixtures, zod, privacy, sanitize, ids, conformance) · `src/trace/client/` (writer, sinks, wrap, tool, session, identity) · `src/trace/index.js` · `services/trace-ingest/` · `infra/modules/{cosmos,traceFunctionApp}.bicep`. Plain folders, no workspaces; extraction to its own repo is a `git mv` once the M3 bridge repo exists.

---

## 4. Correlation — written at trace time

| Carrier | Where | Strength |
|---|---|---|
| **`investigation_id` parameter**, injected into every data tool's `inputSchema` by `withRegistrationPolicy`, read and **stripped** by `withTrace` before the handler runs | all servers | strong, explicit |
| **Process default**: set by `open`, cleared by `close`, expires after `TRACE_INVESTIGATION_TTL` (8 h); a new `open` replaces it | stdio (one Claude Code session = one process) | strong, implicit |
| `session_key`: `hour` mode default (`sha256(salt \| yyyy-mm-ddThh)`); `principal-hash` opt-in (`sha256(salt \| oid \| day)`, Key-Vault salt) | records without an investigation id | weak — fallback only |

`open` returns `next: 'pass investigation_id on data tools; annotate; close'`. `annotate`/`close` with an id this process did not mint are accepted (Azure cannot know). A parameter value failing the identifier grammar is dropped; the tool still runs.

---

## 5. Contract v1 (`trace-record.v1.schema.json`)

### 5.1 Envelope
| Key | Rule |
|---|---|
| `id` | `^(mcp\|claude)_[0-9A-HJKMNP-TV-Z]{26}$` (stream + ULID) |
| `contract_version` | `^1\.\d+\.\d+$` |
| `stream` | `mcp` \| `claude` |
| `ts` | ISO-8601 UTC |
| `erp` | `{ system, version?, build?, installation_id }` — from `MCP_ERP_SYSTEM` / `MCP_ERP_VERSION` / `MCP_INSTALLATION_ID` + identity adapter |
| `mcp` | `{ service, version, snapshot_date? }` — `packageVersion()`, `readBuildDate()` |
| `investigation_id` | identifier; optional on `mcp`, **required** on `claude` |
| `session_key` | 32 hex |
| `seq` | int ≥ 0 per process |
| `source` | `server` \| `hook` — which capture path wrote the record (§3) |

`additionalProperties: false` at every level. **Identifier grammar** `^[A-Za-z][A-Za-z0-9_.:/%*-]{0,127}$` — starts with a letter, so no RecId or account number can pass as one.

### 5.2 Stream `mcp` — the call record
```
tool:     { name, args }                    // args: EVERY argument the call was issued with, each under a policy (§6):
                                            //   identifier | number | boolean | identifier[]≤50 | term | sql_shape | payload_ref
result:   { kind: data|empty|not-found|error, bytes: int, rows?: int, has_more?: boolean, coverage?: string[] }
touched?: [ { kind: table|field|edt|enum|class|method|data_entity|form|menu_item|role|duty|privilege|model|recording|other,
              name, owner? } ]              // ≤ 200 — object NAMES the response was about, for indexing; nothing about them
functional_context?: identifier
```
**The response is not stored.** `result` says how the call ended and how big the answer was (`bytes` of `structuredContent`, `rows` when the payload has one obvious list, `has_more` from pagination) — enough to know whether a replay must page further. `touched[]` lists names so that "which dossiers looked at VendTable" is one indexed query. **`args` are the replay**: every parameter under a policy (§6); a parameter with no policy is dropped and counted (`args_partial`). `payload_ref` = `{ sha256, bytes, steps, forms: identifier[]≤50, menu_items: identifier[]≤50 }` for the two Task Recorder tools, whose input a replay cannot regenerate. `rows`/`bytes` are the only numbers; `args` values are never objects except `payload_ref`.

### 5.3 Stream `claude` — `phase` discriminates
```
open:      investigation { id, purpose: dashboard|report|app|migration_mapping|dq_rule|support|process_analysis|comparison|other,
                           title: prose≤200, asked_by_role: key_user|consultant_functional|consultant_technical|architect|developer|other,
                           expected_entities: identifier[]≤20, entities_from: prompt|functional_context|vocabulary_match|none }
           · request { key: identifier, interpreted: prose≤600, approach?: prose≤400, parameters?: [ { name: identifier, value: identifier } ]≤20 }   // REQUIRED
           · expected_entities: identifier[]≤20 (REQUIRED, may be []) · entities_from: prompt|functional_context|vocabulary_match|none
step:      investigation { id } · n: int≥1 · intent: prose≤400 (Claude's strategy line, verbatim) · expects?: identifier[]≤20
annotate:  investigation { id } · entities [ { erp?, kind, name, level?, functional_entity?: identifier, role: source|target|related|excluded,
                                                counterpart?: { erp: identifier, name: identifier } } ]≤50
           · note?: prose≤300 · expectations?: Expectation[]≤50 · process?: Process[]≤10 · lifecycle?: Lifecycle[]≤20
close:     investigation { id } · conclusion { summary: prose≤6000, outcome: answered|partial|abandoned, expectations?: Expectation[]≤100,
                                               process?: Process[]≤10, lifecycle?: Lifecycle[]≤20,
                                               differences?: [ { aspect: structure|entity|lifecycle|process|other, statement: prose≤300 } ]≤50 }
           · calls?: [ { tool, object? } ]≤50   (optional corroboration; stamped mcp records are authoritative)

Expectation = { entity, field?, kind: type|range|format|unit|enum|relation|mandatory|uniqueness|anti_pattern, statement: prose≤300 }
Process     = { name: identifier, functional_entity?: identifier, source: user_description|task_recording|documentation|inferred,
                steps: [ { n, action: prose≤200, actor_role?: asked_by_role-enum, entities?: identifier[]≤10,
                           transition?: { entity: identifier, field?: identifier, from?: identifier, to?: identifier } } ]≤40 }
Lifecycle   = { entity: identifier, state_field?: identifier, states: identifier[]≤30,
                transitions?: [ { from: identifier, to: identifier, trigger: prose≤150, process?: identifier } ]≤60, retention?: prose≤200 }
```
`request.key` is a stable ERP-neutral slug (`req.<domain>.<question>`) chosen on the first run and **reused verbatim** on every other ERP — it is the cross-ERP join. `request.interpreted` is the interpretation line Claude already writes before its first tool call ("I'll check X and Y, then …"), ERP-neutral, never the user's raw words (spec §1.3), fit to paste into a session on the other ERP — it exists even when the raw request was an image or a file. `request.approach` is the announced plan from that same line and may name ERP-specific objects. `expected_entities` is the **logical** entity hypothesis — vocabulary ids from `config/semantic-vocabulary.json` — written at `open` from the interpreted request so the cross-ERP join key exists before any ERP-specific name does; `entities_from` records how it was obtained (the hook lifts `functional_context` from the first stamped call, else matches the interpreted line against vocabulary aliases with `vocabulary-match.js`, else `none`). The physical entity falls out of the call records (`touched[]`, `primary_table`) and gets its role in `annotate`; `expected_entities` stays a hypothesis. `counterpart` and `differences` are Claude's observations for this request, not verdicts. `functional_entity` is an opaque identifier here (the vocabulary lives elsewhere). `asked_by_role` is an enum — no person is recorded. No confidence, status or verdict field exists in either stream. `step.intent` is Claude's strategy line before a group of calls, verbatim (*"Now querying the KB for the vendor data entity and its backing table"*); the calls up to the next `step` belong to it by `ts` order. The conclusion is stored (it is what two ERPs are compared on); tool responses are not (they are the snapshot's content and are replayed).

### 5.4 Versioning
Additive optional keys → minor; removal/rename/tightening → major (new schema file). Ingest accepts `TRACE_ACCEPT_VERSIONS` (default `>=1.0.0 <2.0.0`). Every `fixtures/valid/**` file validates forever. Zod mirror ↔ JSON Schema parity is asserted with the SDK's own AJV.

---

## 6. Privacy choke point

- **One function, one brand.** `sanitize(record, policy)` → frozen record carrying `Symbol.for('mcp.trace.sanitized')`, or `{ ok:false, reason, field }`. `TraceWriter.enqueue()` throws on an unbranded record; sinks accept only branded ones; the ingest re-runs the same checks. Static scan: the symbol is created in `sanitize.js` only.
- **Field policies** (`x-text-policy` in the schema): `identifier` (grammar; Stream 1 **drops** the value, Stream 2 **rejects** the call) · `prose` (denylist + cap; any hit rejects the record) · `enum` · `aggregate`.
- **Denylist**: e-mail, IBAN-like, VAT-like, phone-like (copied from `semantic-store.js`, parity-tested) **plus** digit runs ≥ 7, URL with query string, and the key names `sample|example|value(s)|data|record|row(s)|payload` in any serialised object.
- **Every argument has a policy or is dropped.** `trace-args.js` maps each data tool's parameters to `identifier | number | boolean | identifier[] | term | sql_shape | payload_ref | redacted`; a parameter without a policy is dropped and `coverage += 'args_partial'`. `term`: ≤ 100 chars, denylist, no digit run ≥ 5 (hit → arg dropped, `args_redacted`). `sql_shape` masks every string/numeric literal in `*_raw_sql` text with `?`. `payload_ref` (both `taskrecorder_*` tools) fingerprints the recording — `sha256`, `bytes`, `steps`, form and menu-item names — never a typed value or annotation text (KO test on a recording fixture full of denylist hits). `redacted` (person parameters of `sec_*` tools) keeps the parameter name with value `<redacted>`.
- **Responses are never read** except for `result.kind`, `bytes`, `rows`, `has_more`, `coverage` and `touched[].name` — a static scan asserts that `withTrace` and the hook never serialise `structuredContent` beyond those keys.
- **Person-level guard.** No key matching `/user|principal|upn|oid|email/i` outside `entities[].name` / `tool.name`.
- **Rejections are silent about content.** `reason` names the field, never quotes the text.

---

## 7. Transport and persistence

### 7.1 TraceWriter
`enqueue` synchronous, O(1), bounded ring 500, drop-oldest, one warning per 60 s · flush via `setImmediate` (coalesced) or every 2 s (`unref`), batch ≤ 100 / ≤ 900 KB · sink timeout 3 s, one retry on network / 5xx / 429 (honours `Retry-After`), none on 4xx (`dropped_invalid`) · **never awaited on the response path**; `withTrace` returns the handler's result object unchanged · the call record is built from `args` and five result keys only (≈ 0.5–2 KB regardless of response size) · **p95 ≤ 2 ms** per call (memory sink, ×3 CI factor) · `MCP_TRACE=off` → no wrapper, no tool, no injected parameter, `tools/list` byte-identical. Loss on scale-in is counted, not hidden.

### 7.2 Sinks
| Sink | Default for | Mechanism |
|---|---|---|
| `file` | stdio servers | NDJSON, `~/.claude/mcp-trace/<service>.ndjson`; `scripts/Push-LocalTraces.ps1` uploads later |
| `queue` | Azure MCP apps | Azure Storage Queue, MI (`Storage Queue Data Message Sender`), ≤ 64 KB per message, base64 |
| `http` | M3 bridge, push script | `POST api/trace/ingest`, bearer for `TRACE_INGEST_SCOPE` |
| `memory`, `null` | tests, `MCP_TRACE=off` | |

### 7.3 Ingest Function App (`tis-d-mcptrace-func`)
`ingestBatch(records)`: validate (schema + denylist) → upsert valid into `traces` with `month`, `_ingested_at`, `_ingest_version`, `source_app_id` (an application, never a user) → dead-letter invalid as `{ id, ts, reason, field, source_app_id, sha256(record) }`. Routes self-prefix `api/` (`host.json` `routePrefix ''`). HTTP: Easy Auth, principal `appid` ∈ `TRACE_ALLOWED_APP_IDS`, **503 when unauthenticated and `REQUIRE_AUTH` unset** (fail closed, as `mcp-auth.js`), 413 on `Content-Length` > 1 MB before parsing, 400 on > 100 records, 207 on a mixed batch. Queue trigger: same core; undecodable message → dead-letter, no throw. `GET api/trace/health` anonymous (Easy Auth `excludedPaths`).

### 7.4 Cosmos DB
| Item | Decision |
|---|---|
| Account | `tis-d-mcptrace-cosmos`, **serverless**, West Europe, session consistency, `disableLocalAuth: true` |
| `traces` | hierarchical PK `/erp/system`, `/month`; id = record id; **no TTL** |
| `deadletter` | PK `/erp/system`, TTL 30 d |
| Indexing | include `/stream`, `/source`, `/ts`, `/investigation_id`, `/request/key`, `/session_key`, `/mcp/service`, `/tool/name`, `/touched/[]/name`, `/touched/[]/kind`, `/entities/[]/name`, `/entities/[]/functional_entity`, `/entities/[]/counterpart/name`, `/process/[]/name`, `/lifecycle/[]/entity`, `/functional_context`, `/phase`, `/n`; **exclude** `/conclusion/*`, `/tool/args/*`, `/note`, `/request/interpreted`, `/request/approach`, `/intent`; composite `(erp/system asc, ts desc)`, `(request/key asc, erp/system asc, ts asc)`, `(investigation_id asc, ts asc)` |
| Access | ingest MI → Cosmos Built-in Data Contributor; no keys anywhere (Bicep test) |
| Cost | ≈ 2–10 k records/day × 0.5–2 KB (call records carry no response) × ~10 RU ≪ €1/day; the 64 KB queue message is never approached; `costAlerts.bicep` at €10/month; autoscale trigger documented at sustained 1 000 RU/s |

---

## 8. Integration seams (this repo)

| Seam | Change |
|---|---|
| `tool-sets.js` | `withRegistrationPolicy`: `withTitle` → **`withInvestigationParam`** (adds `investigation_id: investigationIdParam` to every `inputSchema` except the trace tool) → `withFreshness` (also skips `readOnlyHint:false`) → **`withTrace`** (strips, stamps, enqueues). `TITLE_PREFIXES` += `trace`. Each `TOOL_SETS[svc]` ends with `registerTraceTool`. `effectiveProfile` ignores `TRACE_TOOL_NAME` for the zero-tools rule. |
| `tool-guards.js` | `CORE_TOOLS` += `trace_investigation`. |
| `src/azure/trace-args.js` (new) | `ARG_POLICIES[tool] = { <param>: 'identifier'\|'number'\|'boolean'\|'identifier[]'\|'term'\|'sql_shape'\|'payload_ref'\|'redacted' }` for every data tool, **derived from each tool's Zod `inputSchema`** (string → identifier, number, boolean, string[] → identifier[]) with named overrides (`query`/`queries` → `term`, `sql` → `sql_shape`, `recording*` → `payload_ref`, `user*` → `redacted`); `touchedNames(tool, typed)` from the five allowed result keys; coverage test: every parameter of every tool resolves. |
| `src/trace/contract/vocabulary-match.js` (new) | `matchEntities(text, vocabulary) → identifier[]`: whole-word, case-insensitive match against vocabulary `entity_id` / `name` / optional `aliases[]` (none shipped yet), longest first, deduped, ≤ 20, text order; pure, vocabulary injected. Used by the hook (no `functional_context` seen) and by `trace_investigation.open` (no `expected_entities` passed). |
| `plugin/d365fo-mcp/hooks/hooks.json`, `hooks/trace-capture.cjs` (new) | **Hook capture** (§3): `UserPromptSubmit` → mint id → `~/.claude/mcp-trace/current` `{ investigation_id, ts, prompt_ts }`; `PreToolUse` (matcher `mcp__d365.*\|mcp__claude_ai_D365.*`) → parse `transcript_path` JSONL from `prompt_ts`, assistant `text` blocks since the previous emitted event → first becomes `open.request.interpreted` (+ `request.key` = `req.` + 60-char slug, `approach` = second sentence), later ones `step.intent`; then a call record from `tool_name`/`tool_input` via `ARG_POLICIES` (`source: hook`); `PostToolUse` fills `result.kind`/`bytes`; `Stop` → `close` with the last assistant text as `conclusion.summary`. NDJSON to `~/.claude/mcp-trace/hook.ndjson` through `sanitize()`; exit 0 always; never reads the user prompt into a record. |
| `src/azure/trace-identity.js` (new) | `erp.version` = `ApplicationSuite`, `erp.build` = `ApplicationPlatform` from `model_versions`; `mcp.version` = `packageVersion()`; `snapshot_date` = `readBuildDate(db)`; cached per db handle. |
| Entry points | `MCP_TRACE ??= 'on'`; stdio `TRACE_SINK ??= 'file'`; Azure `TRACE_SINK ??= 'queue'`. Writer = lazy process singleton (dry runs create no files). |
| Tests | `response-format`: `TOOL_FILES` += `../trace/client/tool.js`, regex accepts `WRITE_TRACE_ANNOTATIONS`. `tool-schema-budget`: +1 tool, +1 param per tool, ceilings re-baselined **after measuring**. `freshness`, `tool-guards`, `plugin`, `response-size-golden` extended. |
| `.env.example`, runbook | `MCP_TRACE`, `TRACE_SINK`, `TRACE_FILE_DIR`, `TRACE_QUEUE_URL`, `TRACE_INGEST_URL`, `TRACE_INGEST_SCOPE`, `TRACE_SESSION_KEY_MODE`, `TRACE_INVESTIGATION_TTL`. |
| Plugin skill | **Claude Code (hooks installed):** tracing is automatic — interpretation line, each strategy line before a group of calls, each call, final answer; tool responses are not recorded; write one strategy line before each group of calls; state the request ERP-neutrally in the first line; `annotate` is the one call Claude still makes itself (source/excluded, expectations, process, lifecycle). **claude.ai / no hooks:** `open` (`request.key`, `interpreted`, `approach`, `expected_entities` — always, `[]` when none) → `step` before each group of calls → `annotate` → `close` with the final answer as `summary`; pass `investigation_id` on data tools; never paste data values or the user's raw text. |

---

## 9. Work items — OK and KO tests

Conventions: `node --test`, `given/when/then` names, fakes injected (no network, no Cosmos), `test/integration/harness.js` for round trips. Done = OK **and** KO green, `npm test` + `npm run typecheck` green.

### WI-01 Contract, schema v1, Zod mirror, isolation scan
- OK: every `fixtures/valid/*.json` (both streams × 4 services, all four phases, one `m3`, **the vendor dossier of 2026-09-04** — `open` with the real interpretation line, two `step`s, six `mcp` call records as `source: server` and the same six as `source: hook`, `annotate`, `close` with the ≈ 5 000-char conclusion — and **one comparison pair** on the same `request.key`) validates in AJV and Zod; grammar accepts `CustTable`, `SalesTable.SalesId`, `/Tables/CustTable`, `%Invent%`, `req.inventory.projected_stock_by_zone`.
- KO: missing `erp.installation_id`; `claude` without `investigation_id`; `open` without `request.key`/`request.interpreted`; `request.key` `12345`; `request.interpreted` 601 chars; `step` without `intent` or with `n: 0`; unknown `phase`; `open` carrying `conclusion`; `close` without `summary`; `contract_version 2.0.0`; extra key at each level; identifier `12345678`; `summary` 6 001 chars; 51 entities on annotate; an `mcp` record carrying `observations` or a `result` key beyond the five allowed; an object arg on a non-`payload_ref` policy; `touched` of 201; 41 `Process.steps`; 31 `Lifecycle.states`; `source` `client` — same rejection path from both validators.
- KO (scan): `src/trace/**` importing `../../azure/`; `src/azure/**` importing `../trace/` other than `index.js`; > 1 `registerTool(` under `src/trace/`.

### WI-02 Privacy sanitizer
- OK: identifier args pass; clean prose passes; output frozen + branded; a fixture schema with a swapped `x-text-policy` flips the outcome.
- KO: e-mail / IBAN / VAT / phone / `1234567` / `https://x?y=1` in prose → `{ ok:false, field }`, no brand, reason quotes nothing; non-allow-listed arg → absent; `John Smith` arg → absent; object `value` → rejected; key `sample` → rejected; unbranded → `enqueue` throws; fake `Symbol('mcp.trace.sanitized')` → rejected.
- Parity with `test/semantic-store.test.js` fixtures; person-level key scan on all valid fixtures.

### WI-03 Ids, session key, investigation registry
- OK: `ulid()` 26 chars, monotonic per ms; `sessionKey` modes per §4 (clock/salt injected); `registry.open/current/close`, second `open` replaces, TTL clears (fake clock).
- KO: unknown mode → `hour` + one warning; `principal-hash` without salt → refuses, falls back, logged once; salt never in a record or log; `close(otherId)` → unchanged, `false`; `current()` after TTL → `null`.

### WI-04 TraceWriter, memory/file/null sinks
- OK: `enqueue` returns with a never-resolving sink; 120 records → batches ≤ 100; NDJSON lines re-validate; `stats()`; `disabled` → no-op, no timers.
- KO: 501 at cap 500 → oldest dropped, one warn/60 s; sync + async sink throws swallowed and counted; sink > 3 s → timeout, one retry; empty `flush()` no-op; unwritable dir → `null` fallback after one warning; `beforeExit` flush once, ≤ 1 s.

### WI-05 Queue and HTTP sinks (fakes: `fetch`, `getToken`, `QueueClient`)
- OK: http POSTs `{records}` with bearer, one request per batch; queue splits at 64 KB, base64; 429 + `Retry-After: 1` → one retry after 1 s.
- KO: 401/403 → no retry, `dropped_invalid`, status-only warn; network error → one retry then drop; token failure → drop, no throw; record > 64 KB dropped alone; no record body ever logged.

### WI-06 Argument policies and touched names (R0.3)
- OK (replay): for every data tool of all four services, re-issuing a recorded call record's `args` as `tool_input` on the golden fixture yields a `structuredContent` byte-identical to the original call (**the replay assertion**). Asserted exceptions: `*_raw_sql` replays with `?` placeholders and fails `invalid-input`; `taskrecorder_*` replays only with the recording of the recorded `sha256`; `sec_*` with a `<redacted>` user replays as `not-found`.
- OK (policies): `ARG_POLICIES` derived from the Zod input schemas covers every parameter of every tool; `d365_search.queries[]` → `term`; `d365_raw_sql.sql` → `sql_shape` (`WHERE AccountNum = 'V-000123' AND RecId > 5637144576` → `WHERE AccountNum = ? AND RecId > ?`); `taskrecorder_to_markdown.recording` → `payload_ref` (`sha256`, `bytes`, `steps`, forms, menu items); `sec_lookup_user.user_id` → `redacted`; `investigation_id` stripped, never an arg.
- OK (touched): `d365_get_entity_sources` → entity + source tables; `d365_lookup_table` → table + relation targets; `xref_find_references` → referenced objects; `sec_lookup_role` → role/duty/privilege names; ≤ 200, names only.
- OK (size): every call record on the golden fixture ≤ 4 KB; `result` has no key beyond `kind`, `bytes`, `rows`, `has_more`, `coverage` (static scan of `withTrace` and the hook for `structuredContent` access).
- KO: a parameter with no policy → dropped, `coverage` carries `args_partial`; a `term` `"customer 1234567"` → dropped, `args_redacted`; a task-recording fixture full of e-mails, IBANs and 9-digit runs → none of them anywhere in the serialised record; an object arg under any policy but `payload_ref` → rejected by `sanitize`; a 12 MB tool response → record size unchanged; policy resolution throwing → tool name + `result.kind` only, result untouched.

### WI-07 `withTrace` + central `investigation_id` injection/strip
- OK: `MCP_TRACE=on` + memory sink: `d365_lookup_table` result byte-identical to baseline; one `mcp` record with tool/kind/service/`functional_context`/`seq`; with `investigation_id: inv_abc` the record carries it and **the handler receives args without it** (spy); stdio with open registry and no param → stamped from the default; `tools/list` shows the param on every data tool and **not** on the trace tool.
- OK: `emptyResult` → `empty`; `notFoundResult` → `not-found` with the requested identifier; `errorResult` → `error`, no entities; loop-guard note → **no record**; 200 calls, p95 delta ≤ 5 ms × CI factor.
- KO: `MCP_TRACE=off` → handler identity unchanged, no param, `tools/list` byte-identical to the captured baseline; `enqueue` throwing → result unaffected, logged once; handler rejection propagates, nothing enqueued; `investigation_id: 'bad id!'` → dropped, handler runs; a tool file containing `investigation_id` literally → scan fails.

### WI-08 `trace_investigation` (four phases — the claude.ai path)
- OK (`step`): `step` with `intent` and `n` → `## Step recorded`, `{ n, queued: true }`; `n` auto-assigned as `last + 1` when omitted on stdio, required on Azure; a `step` for an unknown id → accepted.
- OK: registered once per server, `title 'Investigation'`, `WRITE_TRACE_ANNOTATIONS` (`readOnlyHint:false, destructiveHint:false, idempotentHint:false, openWorldHint:true`), `outputSchema`, description ≤ 300 chars naming the `request.key` reuse rule; `open` → `## Investigation opened`, `{ investigation_id, request_key, next }`, registry set on stdio; `annotate` → `{ entities_recorded, expectations_recorded, processes_recorded, lifecycles_recorded }`; `close` → `{ trace_id, outcome, expectations_recorded, differences_recorded }`, registry cleared; every record validates; `erp`/`mcp` from the identity adapter; unknown `functional_entity` ids pass through; the same `request.key` opened twice → two investigations, no dedup, no error.
- KO: `open` with `conclusion` → invalid-input; `open` without `request` → `errorResult('invalid-input', 'request.key and request.interpreted are required — the key must be reusable on another ERP')`; `annotate`/`close` without `investigation.id` → invalid-input; e-mail in `summary`, `request.interpreted` or a `Process.steps[].action` → `errorResult('invalid-input', '<field> contains a value that looks like personal or party data — describe the structure, not the record')`, nothing enqueued; 51 entities / 101 expectations / 11 processes / 21 lifecycles → Zod **and** handler cap (rule #13); unknown enum values (incl. `Process.source`, `differences[].aspect`) → rejection; writer disabled → `errorResult('internal', 'Tracing is not enabled on this server')`; async sink failure → `queued: true`, never "persisted"; `close` for a foreign id → accepted with `note: 'open not seen by this server'`.
- KO (boundary): every `tools/list` has exactly one `trace_*` tool; no tool on traces carries read/query/list/delete semantics.

### WI-09 D365FO identity adapter
- OK: fixture `model_versions` → `d365fo`, ApplicationSuite version, ApplicationPlatform build, `build_date`, package version, `MCP_INSTALLATION_ID` (default `local`); cached per handle.
- KO: pre-provenance DB → nulls, no throw; no db → `snapshot_date` omitted.

### WI-10 Registration policy, profile, budget, static scans
- OK: `effectiveProfile('taskrecorder', null, 'core') === 'full'`; `effectiveProfile('kb', db, 'core') === 'core'` with the trace tool; budget prints per-server bytes with tool + param, ceilings ≤ 2 % above measurement; `deriveToolTitle('trace_investigation') === 'Investigation'`; `withFreshness` skips `readOnlyHint:false`; semantic tools unchanged.
- KO: second `trace_*` tool → boundary scan fails; inline write annotations → PM-03 fails; over ceiling → fails; `MCP_TRACE=off` list ≠ baseline → fails; param on the trace tool → fails; per-server growth from the param > 5 % → fails with "inject on CORE_TOOLS only".

### WI-11 Ingest service (core + HTTP + queue; fake Cosmos)
- OK: valid records upserted with `month`, `_ingested_at`, `_ingest_version`, `source_app_id`; duplicate id idempotent; mixed batch → 207 with counts; allow-listed `appid` → 200/207; `GET api/trace/health` anonymous; queue message → same core; undecodable → dead-letter `undecodable`, no throw.
- KO: no principal + `REQUIRE_AUTH` unset → **503**; missing/non-allow-listed `appid` → 403; > 1 MB → 413 before parsing; > 100 records → 400; version out of range → dead-letter `version`; schema-valid but denylist hit → dead-letter `privacy` with **only** the §7.3 keys; Cosmos throwing → 500 (HTTP) / rethrow (queue), nothing claimed accepted; contract copy hash drift → "run npm run build:trace-ingest".

### WI-12 Infrastructure as code (not executed by Fable)
- OK: serverless capability, `disableLocalAuth: true`, `mcptrace`, `traces` hierarchical PK and no `defaultTtl`, `deadletter` `defaultTtl: 2592000`, §7.4 indexing, `sqlRoleAssignments` for the ingest MI, queue sender role for the main MI, app settings, €10 alert; `deployTrace` defaults `false`; `az bicep build` passes (reviewer runs it).
- KO: static test fails on `listKeys(`, `primaryMasterKey`, `AccountKey=`, a connection string, `deployTrace = true`, or `defaultTtl` on `traces`.

### WI-13 Local tooling and docs
- OK: `Push-LocalTraces.ps1` batches NDJSON by 100, POSTs with `az account get-access-token --scope`, renames to `.sent` on 2xx/207; `ndjson.js` streams lazily; `.env.example` and runbook updated; plugin refs regenerated (`test/plugin.test.js` green); CLAUDE.md rule #17.
- KO: corrupt NDJSON line skipped and counted; 4xx leaves the file and prints dead-letter hashes; no token → non-zero exit with the `az login` hint; plugin refs with stale tool counts → fails.

### WI-14 Conformance kit for the next emitter
- OK: a fake M3 emitter producing `valid/m3-*.json` (all four phases + `mcp` call records, incl. the M3 half of the comparison pair under the shared `request.key`) passes `runConformance({ emit })`; the kit reports which invalid fixtures an emitter wrongly accepts and a **replayability check**: every `mcp` record's `args` resolve to a policy with no dropped parameter (`args_partial` absent) — an emitter whose calls cannot be re-issued is reported "not replayable", not invalid.
- KO: an emitter leaking a `value` key, an `observations` key or a digit run in prose fails with the schema path; the kit has no I/O (scan: no `fs`/`fetch`).

### WI-15 Hook capture for Claude Code (the primary Stream-2 path, §3/§8)
- OK: on a fixture transcript of the vendor investigation (2026-09-04): `UserPromptSubmit` writes `~/.claude/mcp-trace/current` with a fresh id; the first `PreToolUse` (`mcp__d365kb__d365_get_entity_sources`) emits `open` with `request.interpreted` = *"I'll load the D365FO MCP tooling skill first, then query the knowledge base for the vendor table and data entity structure."* and a grammar-valid 60-char `request.key`, then `step 1` = *"Now querying the KB for the vendor data entity and its backing table."*, then the call record `args { entity_name: 'VendVendorV2Entity', limit: 60, functional_context: 'vendor' }`, `source: hook`; a second `PreToolUse` with no new assistant text emits only a call record; `PostToolUse` fills `result.kind`/`bytes` on the matching record; `Stop` emits `close` with the final message as `summary` (≈ 5 000 chars, passes the denylist) and clears `current`. Every record validates; the hook exits 0 in ≤ 50 ms on a 2 MB transcript; a `Skill(...)` call is ignored.
- OK (entities at open): first stamped call with `functional_context: 'vendor'` → `open.expected_entities: ['vendor']`, `entities_from: 'functional_context'`; no `functional_context` but the interpreted line names the vendor → `['vendor']`, `'vocabulary_match'`; nothing matches → `[]`, `'none'`; `matchEntities('customer and vendor postal address')` → `['customer','vendor','address']`, alias `supplier` → `vendor`, no substring hits.
- OK (stdio stamping): a local stdio server reads `current` per call and stamps `investigation_id` on its own Stream-1 record.
- KO: the user prompt text never appears in any record (fixture prompt contains an e-mail and a 9-digit number; string scan of `hook.ndjson`); missing/unreadable transcript → no record, exit 0, one stderr line; `Stop` with no open investigation → nothing written; the hook never writes to stdout; a denylist hit in an assistant line → that record dropped with a counted reason, the rest intact; `PreToolUse` on a non-D365 MCP tool → no record.

---

## 10. Implementation order
WI-01 → 02 → 03 → 04 → 06 → 07 → 15 → 08 → 09 → 10 → 05 → 11 → 13 → 14 → 12 (Bicep last, reviewed, **run by the operator**). One commit per WI; green at each; the budget re-baseline commit quotes measured bytes.

---

## 11. Open decisions
1. **Session-key mode**: keep `hour` (not person-derived); the investigation id carries correlation, so `principal-hash` is a governance opt-in, not a need.
2. **Loss on scale-in**: accept best-effort (counted) vs. await the queue send (+20–50 ms p50). Recommend accept.
3. **`tools/list` growth**: +1 tool (≈ 4 KB/server) + injected parameter (≈ 100 B × 65 ≈ 6.5 KB, ≈ +4 %). Measure; if any server exceeds +5 %, inject on `CORE_TOOLS` only (encoded in WI-10).
4. **Parameter discipline on Azure**: the strong link needs the model to pass `investigation_id`; locally the process default removes the need.
5. **Digit-run ≥ 7** also redacts long legitimate identifiers inside prose (identifier fields unaffected).
6. **Replay depends on the snapshot still existing.** `mcp.snapshot_date` makes drift visible; keeping the snapshots to replay against is the analysis project's decision.
7. **Digit-run ≥ 7 in long prose** (conclusions up to 6 000 chars will quote RecIds): mask (`5637144576` → `#`, recommended) or reject the record — decide at the checkpoint.
8. **`request.key` under hook capture** is derived from the interpretation line, so two runs match only when the lines match; the analysis also matches on `request.interpreted`; the tool path lets Claude pass a key. Fallback if joining proves weak: a `d365://requests` resource listing known keys (keys only, never traces).
9. **Hook reliance**: a Claude Code user without the plugin traces nothing locally (Azure still records Stream 1 for connector calls). Accept; the plugin is the distribution unit.
10. **Task Recorder `payload_ref`** stays fingerprint + names; widening it is a checkpoint privacy decision, not a code tweak.
11. **Duplicate call records** (server + hook on stdio) are kept — each path covers a client the other does not — and deduped by `(investigation_id, tool.name, sha256(args), ts ± 5 s)`.

---

## 12. Checkpoint — confirm before implementation
- [x] Scope and R0 (§1 point 6) — decided 2026-09-04.
- [ ] `request` on `open` (§5.3): key reuse, `interpreted` = Claude's interpretation line, `approach`, parameters.
- [x] **Results are not traced, the path is** (decided 2026-09-04, second decision): Stream 1 = call record (`tool`, replayable `args`, `result` kind/bytes/rows/has_more, `touched` names); no `observations`, no chunking (§5.2).
- [ ] `step` phase = Claude's strategy line verbatim; conclusion cap 6 000 (§5.3).
- [ ] Logical entity at `open`: `expected_entities` required + `entities_from`; hook derivation `functional_context` → `vocabulary_match` → `none` (§5.3, §8, WI-15).
- [ ] `process[]` / `lifecycle[]` / `counterpart` / `differences` (§5.3).
- [ ] **Hook capture as the primary Claude Code path** (§3, §8, WI-15): UserPromptSubmit / PreToolUse / PostToolUse / Stop, transcript-derived, user prompt never recorded; the tool stays for claude.ai.
- [ ] Argument policies for every parameter of every tool, derived from the Zod input schemas (§6, WI-06).
- [ ] Scope boundary (§1): write path only; no read tool, no classification, no downstream processing in this design.
- [ ] Lifecycle and correlation (§2, §4): one tool, four phases, central parameter injection, stdio default (file `current` shared with the hook), 8 h TTL.
- [ ] Contract enums (§5.3): `purpose`, `asked_by_role`, `role` incl. `excluded`, `outcome`, `Expectation.kind`.
- [ ] Privacy defaults (§6): policy-or-drop on args, `term`/`sql_shape`/`payload_ref`/`redacted` policies, responses never read beyond five keys, digit-run rule (mask vs reject, §11.7).
- [ ] Transport semantics (§7.1) and Cosmos design (§7.4).
- [ ] Placement (§3); order (§10); `az` stays human-gated.
