# ERP Trace — Message Sink (Ingest) Implementation Concept

**Date:** 2026-09-08 · **Status:** decision 1 CONFIRMED and **phase 1 IMPLEMENTED 2026-09-08** (ClaudeTrace v0.2.0, commits 8789187…; MCP branch `feat/trace-ingest-sink`); code deploy pending an active PIM role · **Scope:** WI-11 (ingest service),
WI-12 (its infrastructure), WI-13 (local push) of `ERP-Trace-Capture-TDD.md`; the client side (WI-01…WI-10, WI-15)
shipped with PR #134 and is verified end to end on 2026-09-08 (§1). **Repos:** the sink lives in
`C:\working\ClaudeTrace` (Function App `tis-d-claudetrace-func`); the contract it validates against lives here
(`src/trace/contract/`). Part B of this document is the **expectations register** — every expectation placed on the
tracing/logging extension by the two TDDs and the 2026-09-04/-07 decisions, with its verified status, so that the
expectations survive the documents that raised them.

---

## Part A — Implementation concept for the message sink

### 1. Where we stand (verified 2026-09-08, fresh session, one `xref_check_exists` probe)

| Path | Producer | Sink today | Verified |
|---|---|---|---|
| Stream 2 (`open`/`step`/`close`) + Stream 1 from the hook | `plugin/d365fo-mcp/hooks/trace-capture.mjs` | `~/.claude/mcp-trace/hook.ndjson` **and** `POST /trace/ingest` (function key) | records written; ingest answered without error (only ≥ 300 is logged; last 404s predate the 2026-09-07 14:43 UTC deploy) |
| Stream 1 from the stdio servers | `withTrace` (`src/trace/client/with-trace.js`) | `~/.claude/mcp-trace/<service>.ndjson` **only** | first `xref.ndjson` record today, carrying the hook's `investigation_id` via the `current` marker |
| Stream 1 from the Azure MCP apps | `withTrace` | **none** (`MCP_TRACE` unset on Azure) | — |
| `/trace/ingest` | ClaudeTrace `src/functions/trace.js` | **stub**: shape check, per-stream count in the Function log, `202` | health 200 |

So the sink receives batches but **keeps nothing**. The file sinks on this machine are the only durable copy of every
trace produced so far (11 hook records + 1 server record as of this morning), and the stdio servers' records never leave
the machine. That is the gap this concept closes.

### 2. What the sink must do (from the TDD, restated as acceptance)

1. **Accept** a JSON array of ≤ 100 contract-v1 records (both streams), ≤ 1 MB, from an authenticated producer.
2. **Re-validate** every record on the server: contract schema (AJV) **and** the privacy denylist (`sanitize()`), because the
   client is untrusted by design — a producer without the plugin's sanitizer (a future M3 bridge, a hand-written push)
   must not be able to land party data.
3. **Persist** valid records **idempotently** (a retried batch must not duplicate) with the four ingest fields
   `month`, `_ingested_at`, `_ingest_version`, `source_app_id`.
4. **Dead-letter** invalid records as `{ id, ts, reason, field, source_app_id, sha256(record) }` — **never** the record body.
5. **Answer** with counts: all accepted → `200`, mixed → `207`, nothing parseable → `400`, too large → `413` before parsing.
6. **Serve the R0 read shapes** only at the storage level (no read API in this project): a *dossier* = all records with one
   `investigation_id` ordered by `ts, id`; a *comparison set* = all `open` records sharing `request.key`.
7. **Never block a producer**: the producer's writer already treats 5xx/429 as retry-once and 4xx as drop; the sink must
   answer within the producer's 3 s timeout.
8. **Cost a rounding error**: 2–10 k records/day × 0.5–2 KB.

### 3. Architecture — landing zone + key/value index in the storage account the Function already owns

```
producers ──POST /trace/ingest──▶ ingest core ──┬─▶ Blob   trace-landing/<erp>/<yyyy-mm>/<yyyy-mm-dd>.ndjson   one append per batch — the archive, scan source
  hook (per developer)                          ├─▶ Table  tracerecords  PK = investigation_id (or session:<key>), RK = <ts>|<id>, full record   → dossier
  stdio servers via Push-LocalTraces.ps1        ├─▶ Table  tracerequests PK = request.key, RK = <erp>|<investigation_id>, the `open` record     → comparison set
  Azure MCP apps (later, TRACE_SINK=http, MI)   └─▶ Blob   trace-deadletter/<erp>/<yyyy-mm-dd>.ndjson  (id, reason, field, hash — no body)
```

**Decision 2026-09-08 (revising the TDD's Cosmos choice): no Cosmos in this project.** The 2026-09-04 scope decision
removed the reason Cosmos was chosen. Cosmos was the *query store* for an analysis that is now a separate project; what
this project must guarantee is that every record is **kept, complete, and addressable by the two R0 shapes** — a
dossier by `investigation_id`, a comparison set by `request.key`. Both are exact-key lookups, which Table Storage
serves natively, and the archive is a scan, which NDJSON in blob serves natively (7 GB a year at the TDD's upper bound
loads into DuckDB or SQLite in seconds when the analysis project wants it). Everything lives in the storage account the
Function already has, reached through the `AzureWebJobsStorage` connection it already holds — **no new resource, no new
role assignment, no Conditional-Access step-up, no new secret**; the SDK creates the containers and tables on first use.
Cosmos is not rejected on cost — it is rejected as a second system nobody queries yet. If a query need appears that a
scan cannot serve, the landing zone is re-ingested into whatever store fits then (the core is idempotent by `id`).

**Cost at the TDD's upper bound (10 k records/day, 2 KB, West Europe list prices, order of magnitude):**

| Store | Operations | Per month | New resource / role |
|---|---|---|---|
| Table Storage (`tracerecords`, `tracerequests`; entity-group batches per partition) | ≈ 300 k transactions | ≈ €0.01 + storage €0.05/GB | none |
| Blob landing + dead-letter (one append per batch) | ≈ 30–60 k writes | ≈ €0.2–0.3 + storage €0.02/GB | none |
| Cosmos serverless (TDD) | ≈ 3 M RU | ≈ €0.8 + storage €0.25/GB | account + SQL role assignment (step-up) + indexing policy |

At realistic volume today (tens of records a day) all three are cents; the difference that matters is the third column.

**Alternatives considered.**
- *Cosmos only (TDD as written):* the first durable byte waits on the RBAC deploy; a projection nobody reads yet.
- *Blob only, dossier by naming (`trace-dossiers/<erp>/<inv>.ndjson`, request key as a marker prefix):* works and needs
  no table, but blob appends cost 100× a table transaction and listing a prefix is slower than a partition query. Table
  is the cheaper index.
- *Log Analytics / App Insights custom events:* KQL for free, but €2.5/GB ingestion and a 90-day retention horizon that
  conflicts with "no TTL"; export for a downstream project is awkward.
- *SQLite in blob:* the project's native format, but no concurrent writer from a Function — the analysis project can
  build one from the landing zone.

### 4. Ingest core (`ClaudeTrace/src/ingest/`) — pure module, transport-agnostic

```
ingestBatch(records, ctx) → { accepted: n, dead_lettered: [{ id, reason, field }], stored_ids: [...] }
```

Per record, in order (stop at the first failure, the failure is the dead-letter `reason`):

| Step | Check | `reason` |
|---|---|---|
| 1 | `contract_version` major = 1 | `version` |
| 2 | `id` matches `ID_RE` (`mcp_`/`claude_` + 26-char ULID) — it is the row key suffix and the idempotency key | `id` |
| 3 | AJV against `trace-record.v1.schema.json` (the copy under `src/contract/`, hash-pinned, §6) | `schema` (+ `field` = instance path) |
| 4 | `sanitize(record)` — the same producer function; `s.ok === false` → | `privacy` (+ `field`) — the record is *not* masked-and-kept: a producer that ships an unsanitized record has a defect, and silently fixing it hides the defect |
| 5 | Enrich: `month` (from `ts`, `yyyy-mm`), `_ingested_at`, `_ingest_version` (package version), `source_app_id` (§5) | — |
| 6 | Landing: one `AppendBlock` per batch with all valid lines to `trace-landing/<erp.system>/<month>/<yyyy-mm-dd>.ndjson` (append blob; a block is atomic, so lines never interleave with another instance's block) | `store` (5xx to the caller, nothing claimed) |
| 7 | Table `tracerecords`: `InsertOrReplace` entities grouped per partition (`investigation_id`, else `session:<session_key>`), RK `<ts>\|<id>`, the record JSON in one property (≤ 8 KB, far under the 64 KB property limit); on `phase = open` also `tracerequests` (PK `request.key`, RK `<erp>\|<investigation_id>`) | `store` |

Dead letters go to `trace-deadletter/<erp.system>/<yyyy-mm-dd>.ndjson` (blob lifecycle rule: delete after 30 d). If step 7
fails after step 6 succeeded, the response is `500` for the whole batch (the TDD: "nothing claimed accepted"); the
producer retries once, the landing block is duplicated (identical lines — every reader dedupes by `id`) and
`InsertOrReplace` is idempotent, so the retry is safe. Order of 6 before 7 is deliberate: the archive is written first.
Records without `investigation_id` (connector calls, phase 3) partition by `session_key` — the TDD's weak link, kept as is.

**Duplicates by design are kept.** The stdio path produces two call records for one call (hook + server, different ids,
`source: hook` / `source: server`); TDD §13.11 keeps both — each path covers a client the other does not — and the
analysis dedupes by `(investigation_id, tool.name, sha256(args), ts ± 5 s)`. The sink does not merge them.

### 5. Transport, auth, producers

| Producer | Auth today | Concept | `source_app_id` |
|---|---|---|---|
| Hook on a developer machine | function key from `~/.claude/claude-trace.config.json`, `x-functions-key` | **Keep** for phase 1. The hook is dependency-free and must exit in 3 s; an `az` token costs 1–2 s per hook run and the developer has no app identity. Issue **one named host key per person** (`az functionapp keys set --key-name hook-<initials>`), so revocation is per person | `hook:<erp.installation_id>` — Functions does not expose *which* key matched, so the key name cannot be recorded; the installation id is the per-machine tag |
| stdio servers (`<service>.ndjson`) | none — file only | **`local-deploy/Push-LocalTraces.ps1`** (WI-13): batches of 100, `x-functions-key` from the same config file, renames the file to `.sent` on 200/207, leaves it on 4xx and prints the dead-letter hashes. Scheduled by the same MSBuild-independent path as `Refresh-McpData.ps1` (Task Scheduler, daily) or run by hand. Alternative kept open: `TRACE_SINK=http` + `TRACE_INGEST_URL`/`_KEY` in the stdio env (`~/.claude.json`) — the writer already supports it; decide after the push script has run for two weeks and shows whether same-day latency matters | `push:<installation_id>` |
| Azure MCP apps (`tis-d-mcpd365fo-func`) | — (trace off) | Phase 3: `MCP_TRACE=on`, `TRACE_SINK=http`, bearer from the app's managed identity for the ClaudeTrace app registration; ingest verifies the token (Easy Auth or `jose` in code) and requires `appid ∈ TRACE_ALLOWED_APP_IDS`. This is the TDD's fail-closed path: **503 when no principal and `REQUIRE_AUTH` unset**. Not before the connector trace has a consumer | `app:<appid>` |

Function-key auth and bearer auth coexist: `authLevel: 'function'` on the route stays; the bearer check is an
additional gate applied when an `Authorization` header is present. The two retired v0.1 routes (`/trace/request`,
`/trace/result`) are **deleted** in phase 1 — the cutover is confirmed.

**Response contract change the producers must learn:** `207` on a mixed batch. The hook logs every status ≥ 300 as an
error line and the writer treats < 400 as success; the hook gets a one-line change (`207` → log the dead-letter
count, not "HTTP 207"). `202` disappears: the sink no longer accepts what it has not stored.

### 6. Contract copy — the same discipline as the hook library

The ingest must validate against **the** contract, not a fork of it. The MCP repo already solves this for the hook:
`npm run gen:trace-hook` copies the contract modules into `plugin/d365fo-mcp/hooks/lib/` and
`test/trace-generated.test.js` fails on drift. The sink gets the twin: **`npm run gen:trace-ingest`** in the MCP repo
writes `identifiers.js`, `privacy.js`, `arg-policies.js`, `vocabulary-match.js`, `sanitize.js`, `record.js`,
`validate.js`, `trace-record.v1.schema.json` plus a `CONTRACT.sha256` manifest into
`<TRACE_INGEST_REPO>/src/contract/` (path from `.env`, default `..\ClaudeTrace`). On the ClaudeTrace side a test
recomputes the manifest and fails with *"contract drift — run `npm run gen:trace-ingest` in the MCP repo"* (the TDD's
WI-11 KO case). No npm package, no submodule: two repos, one generator, one hash.

### 7. Infrastructure (ClaudeTrace `infra/main.bicep`, operator-executed)

| Resource | Setting | Note |
|---|---|---|
| Storage account (exists, `AzureWebJobsStorage`) | containers `trace-landing`, `trace-deadletter`; tables `traces`, `requests` — created by the SDK on first use, declared in Bicep as well so a fresh environment matches | no new role: the Function reaches its own account through the connection it already holds. When the operator next runs an infra deploy anyway, switch to `Storage Blob/Table Data Contributor` on the MI and drop the connection string from the trace settings — an improvement, not a prerequisite |
| Blob lifecycle rule | `trace-deadletter/`: delete after 30 d. `trace-landing/`: none (the TDD's "no TTL, revisit at 10 GB") | |
| Immutability policy on `trace-landing` | **not now.** Time-based immutability with append allowed is one Bicep property, but it blocks the re-ingestion clean-up (a duplicated block cannot be removed) and this tenant's governance has not asked for a WORM archive. Revisit if the traces become audit evidence | |
| App settings | `TRACE_STORAGE` (connection setting name, default `AzureWebJobsStorage`), `TRACE_LANDING_CONTAINER`, `TRACE_DEADLETTER_CONTAINER`, `TRACE_TABLE`, `TRACE_REQUESTS_TABLE`, `TRACE_ALLOWED_APP_IDS` (empty until phase 3), `REQUIRE_AUTH` (unset until phase 3 = function key only) | static Bicep test as in the MCP repo: no `listKeys(` **beyond the one the Function runtime already needs**, no `AccountKey=` literal, no Cosmos key material |
| Cost alert | €5/month on the resource group scope | replaces the TDD's €10 |

**Phase 1 is deployable with `Deploy.ps1 -SkipInfra` today.** Nothing in it is an ARM write, so the Conditional-Access
step-up never enters. Expected cost at the upper bound ≈ €0.3/month plus a few cents of storage; the Function shares
the MCP plan.

### 8. Observability

- App Insights **custom metrics** per batch: `trace.ingest.accepted`, `trace.ingest.deadlettered` (dimension `reason`),
  `trace.ingest.batch_size`, `trace.ingest.duration_ms`. One log line per batch as today (counts and ids, never text).
- **Alert:** dead-letter rate > 10 % over 1 h, or zero accepted records for 7 days while the hook config says `enabled`
  (the silent-outage case: a rotated key, a deleted route — the 2026-09-07 404s went unnoticed for five hours).
- `GET /health` stays anonymous and cheap. No stats endpoint: the operator's "is the sink alive and full" check is
  `Get-TraceStats.ps1` in the ClaudeTrace repo — a partition count on `traces` and the landing blob sizes per day via
  `az storage`, read-side, no code in the Function. A read endpoint would be the first step of the read API this project excludes.

### 9. Testing (node `--test`, no Azure needed)

Fakes: `fetch`, an in-memory table client (`upsertEntity`, `listEntities`, throws on demand), an in-memory append-blob client.
The WI-11 OK/KO list becomes the test file, item for item:

- OK: valid batch → 200, every record in landing + `traces` (and `open` records in `requests`) with the four ingest fields; duplicate id → one table entity,
  two landing lines; mixed batch → 207 with counts; queue/http share the core; health anonymous.
- KO: no array → 400; > 100 → 400; `Content-Length` > 1 MB → 413 before `text()` is read (the `checkUploadSize()` pattern
  of `feedback_upload_size_precheck`); version 2.x → dead-letter `version`; schema-valid but denylist hit → dead-letter
  `privacy` carrying **only** the six keys; table client throwing → 500, no `accepted` count; contract hash drift → the named
  message; Bicep static scan → no key material; **no record body in any log line** (assert on the fake logger).
- Contract parity: the MCP repo's `test/trace-contract.test.js` corpus (valid and invalid records) is copied by the
  generator, so both repos reject the same records.

### 10. Phases, order, effort

| Phase | Content | Deploy | Effort |
|---|---|---|---|
| **1 — durable, addressable sink** | ingest core (§4): landing + dead-letter blobs, `traces` + `requests` tables, AJV + `sanitize()`, 200/207/400/413/500; delete the v0.1 routes and hook files; `gen:trace-ingest` + drift test; metrics + the two alerts; hook `207` handling; `Push-LocalTraces.ps1` (backfills the 12 records already on this machine); `Get-TraceStats.ps1`; README/runbook; TDD §7.3/§7.4 amended to point here | `Deploy.ps1 -SkipInfra` — no ARM write, no step-up; the agent can run it | ~1 day |
| **2 — hygiene** | `Reingest-Landing.ps1` (landing → core, idempotent — the tool that makes any later store change free); Bicep declares containers/tables + lifecycle rule + €5 alert; MI data roles replacing the connection string for the trace settings | operator-run infra deploy (role assignment = step-up), bundled with the next infra change anyway | ~½ day |
| **3 — server-to-server** | bearer/MI auth, `TRACE_ALLOWED_APP_IDS`, 503 fail-closed, `MCP_TRACE=on` + `TRACE_SINK=http` on `tis-d-mcpd365fo-func`; measure the connector's `session_key`-only correlation before deciding on the `investigation_id` parameter injection (TDD §11.3) | MCP app settings + ClaudeTrace code | ~½ day + measurement |

Phase 1 alone changes the situation from "the sink keeps nothing" to "every trace is archived, addressable by dossier
and by request key, and every rejected record is accounted for". Phase 2 is housekeeping that rides on the next
operator deploy. Phase 3 is the first phase that touches the production MCP apps and stays gated on a consumer for
connector traces.

### 11. Decisions

Taken 2026-09-08 (Florian: "do what makes sense and does not harm the project"; the storage question answered in §3):

1. **Store = blob landing zone + two Table Storage indexes in the existing account; Cosmos deferred indefinitely** (§3).
   Deviates from TDD §7.4 — the TDD is amended in phase 1, not silently.
2. **Function key stays for the hook** (phases 1–2), one named host key per person; MI bearer only for server-to-server
   (phase 3). Nothing here needs a decision from the operator: the key already exists and works, per-person keys are an
   `az functionapp keys set` each, the bearer path is code. What the operator owns is phase 3's Entra side — an app
   registration or role that lets the MCP app's identity obtain a token for the ClaudeTrace app — and every ARM write
   the step-up gates. Rotation: on a person leaving the pilot, delete that person's key.
3. **A server-side privacy hit is dead-lettered, never masked and kept** (§4 step 4). Everything maskable — digit runs
   in prose — is already masked inside `sanitize()` on the client *and* on the server (same function), so a record the
   server still rejects carries something unmaskable: an e-mail, a VAT-like token, a party name pattern, a person key. A
   producer that ships one has a defect; the hash + reason + field in the dead letter is what finds the defect, and the
   dead-letter-rate alert (§8) is what raises it. Losing that record is the correct outcome.
4. **`Push-LocalTraces.ps1` first**; `TRACE_SINK=http` on the stdio servers is re-evaluated after two weeks of pushes.
5. **Delete `/trace/request` and `/trace/result`** in phase 1, together with `hooks/trace-*.cjs` in the ClaudeTrace repo
   and the copies under `~/.claude/hooks/`. Found on 2026-09-08: the two v0.1 registrations were **still present** in
   `~/.claude/settings.json` (the 2026-09-07 note said removed) and posting the raw prompt to the stub; removed the same
   morning (backup `settings.json.bak-20260908`). Deleting the routes without that step would have been harmless (the
   v0.1 hooks swallow 404) but pointless.
6. **No immutability policy, no stats endpoint** (§7, §8).

Still needing Florian: (a) confirm decision 1, the one that overrides a TDD decision; (b) say when to start phase 1;
(c) the phase-3 Entra setup, when phase 3 comes.

---

## Part B — Expectations register for the tracing/logging extension

Every expectation the two TDDs (`ERP-Trace-Module-TDD.md` v1.3, `ERP-Trace-Capture-TDD.md` v1.2), the decisions of
2026-09-04 and 2026-09-07, and the implementation note of 2026-09-07 placed on the extension. Status as verified on
2026-09-08. **Met** = shipped and observed; **partly** = shipped with a stated limitation; **open** = not built;
**deviated** = built differently, on purpose, with the reason.

### B1. Governing scope and requirement

| # | Expectation | Source | Status | Evidence / note |
|---|---|---|---|---|
| E01 | The project captures traces about an ERP's logical + physical data structure and the processes Claude analysed from user input; exploitation is a separate project; no read path for an LLM | Module §1.0, decision 2026-09-04 | **met** | no read tool exists; `d365://sql-templates`-style resources deliberately not exposed for traces |
| E02 | R0 reproducibility: the same request re-run on another ERP yields a comparable dossier | Module §1.0 | **partly** | mechanism shipped (E03–E06); no second ERP has produced a dossier yet, so comparability is unproven |
| E03 | R0.1 `request.key` (stable, ERP-neutral), `request.interpreted`, `request.approach` on `open`; dossiers join on `key` across `erp.system` | Module §1.0, §5.3 | **partly** | present on every `open`; `key` is derived from the interpretation text, so two runs match only when the lines match (Module §13.8, mitigation = similarity on `interpreted`, tool path passes a key) |
| E04 | R0.2 the dossier records *how*, not *what*: no tool results, no observations, no chunking | decision 2026-09-04 (second) | **met** | call record = `tool`, `args`, `result{kind,bytes,rows,has_more,duration_ms}`, `touched[]`; verified record 569 B |
| E05 | R0.3 replayable call sequence: every argument under a policy (identifier/number/boolean/term/sql_shape/payload_ref/redacted); `mcp.snapshot_date` on every server record | Module §1.0, §6, WI-06 | **met** | `arg-policies.json` for 67 tools / 303 parameters; server record carries `snapshot_date: 2026-09-01` |
| E06 | R0.4 one vocabulary for every ERP: phases, policies, `touched[].kind`, `functional_entity` ids ERP-neutral; D365FO is the pivot with `aliases[]`, `data_entities[]`, `primary_tables[]`, `key_fields[]` | Module §1.0, decision 2026-09-07 | **met** | vocabulary v2.0.0, 60 ids, names verified against KB/XRef; `resource` has an empty logical layer (a finding, not a gap) |
| E07 | Five information classes recoverable at analysis time: physical structure, logical structure, entities, lifecycle, process | Module §1.0 | **partly** | classes 1–2 by replay (needs the snapshot, Module §13.6); class 3 via `touched[]` + `annotate`; classes 4–5 need `annotate`/`process[]`/`lifecycle[]`, which have **no hook emitter** (E22) |

### B2. Contract and privacy

| # | Expectation | Source | Status | Evidence / note |
|---|---|---|---|---|
| E08 | One contract `trace-record.v1.schema.json`, two streams, envelope with `id` (ULID), `contract_version`, `erp`, `mcp`, `session_key`, `seq`, `source`; Zod mirror; `sanitize()` is the only producer of a record any writer accepts | Capture §5, WI-01 | **met** | `SANITIZED` brand symbol; static scan `test/trace-contract.test.js` |
| E09 | Never the tool response; never the user's raw prompt | Capture §1, §6 | **deviated (approved)** | response: never. Prompt: fallback chain `declared` → `interpretation` → `user_prompt` (masked, withheld on party data) — Florian allowed the raw-prompt fallback on 2026-09-07; `allow_prompt_fallback` defaults `true` |
| E10 | Privacy denylist: person-like keys, forbidden sample/value keys, party data in prose, URL query strings; digit runs ≥ 7 in prose **masked**, not rejected (Module §13.7, decided) | Capture §6 | **met** | `privacy.js` regexes copied from `semantic-store.js`, parity-tested; `maskDigitRuns` |
| E11 | Server re-validates (schema + denylist) and dead-letters with only `{id, ts, reason, field, source_app_id, sha256}` | Capture §7.3 | **open** | this concept, Part A §4 |
| E12 | Contract copies in other packages are generated and hash-checked, never hand-edited | Capture WI-11 KO, impl note §5 | **partly** | hook `lib/` generated + `test/trace-generated.test.js`; ingest copy not yet (Part A §6) |
| E13 | Versioning: minor additive; major = new schema file | Capture §5.4 | **met** | `CONTRACT_VERSION = '1.0.0'` |

### B3. Correlation

| # | Expectation | Source | Status | Evidence / note |
|---|---|---|---|---|
| E14 | Investigation id minted at `open`, carried on every record of the dossier | Module §7 | **met** | `inv-<prompt_id>` from the hook; server record carries the same id (top-level `investigation_id`; Stream 2 uses `investigation.id`) |
| E15 | `investigation_id` **input parameter** injected centrally into every data tool's schema and stripped by `withTrace` (the strong link on Azure) | Module §7, WI-07 | **open, deliberate** | not shipped; TDD §11.3 requires measuring the `tools/list` growth first (≈ 100 B × 67); stdio uses the `current` marker instead (E16) |
| E16 | Process/machine default: hook writes `current` at PreToolUse, cleared at Stop, 8 h TTL | Module §7, impl note §4 | **met** | verified today: `current.ts` 54 ms after the stash, server read it |
| E17 | `session_key` = `hour` mode (`sha256(salt \| yyyy-mm-ddThh)`), `principal-hash` a governance opt-in only | Module §7, §13.1 | **met** | hook and server salts differ, so the keys differ per path (`9d6b…` vs `805b…`) — by design; correlation is the investigation id |
| E18 | `close`/`annotate` with an id this process did not mint are accepted | Module §7 | **met (by construction)** | the sink has no registry to reject against; Part A keeps it so |

### B4. Capture paths

| # | Expectation | Source | Status | Evidence / note |
|---|---|---|---|---|
| E19 | Hook capture is the primary Claude Code path: UserPromptSubmit / PreToolUse / PostToolUse / PostToolUseFailure / Stop; transcript-derived; dependency-free; exits 0 always; dedupe survives double registration | Capture §3, §8, WI-15 | **met** | `trace-capture.mjs`, `hooks.json` in plugin 1.4.x; state per session under a dir lock |
| E20 | Claude compiles the request: `Request:` / `Entities:` lines after a ~90-token protocol note → `open.request.source = declared` | decision 2026-09-07 | **partly** | works only when the lines are the **first assistant text of the turn**; written after a tool call they are ignored and the opening paragraph becomes `interpretation` (observed 2026-09-08). Fix: scan the whole turn for the lines, or reword the protocol note |
| E21 | `expected_entities` required at `open` (may be `[]`) + `entities_from: prompt \| functional_context \| vocabulary_match \| none` | Module R11 | **met** | today's probe: `[]` / `none` |
| E22 | `step` = strategy line verbatim; `annotate` = entities/expectations/process/lifecycle/counterpart; `close.conclusion.summary` ≤ 6000 verbatim | Module §5.3 | **partly** | `open`/`step`/`close` emitted; **`annotate` has no emitter** — contract only |
| E23 | `trace_investigation` tool as the claude.ai fallback (four phases) | Capture WI-08 | **open** | not built; connector sessions produce Stream 1 only once E27 is on |
| E24 | Server-side `withTrace` on the registration path, innermost, `MCP_TRACE=on`; result returned by reference; `structuredContent` byte-identical; p95 ≤ 2 ms | Capture §7.1, WI-07 | **met** | golden test unchanged; default `on` for the three stdio servers |
| E25 | Task Recorder and Sec calls traced | Capture matchers | **deviated (approved)** | KB + XRef only for now (Florian, 2026-09-07); `payload_ref` policy exists for Task Recorder when it is turned on |
| E26 | Duplicate call records (hook + server on stdio) are kept and deduped at analysis time | Module §13.11 | **met** | both observed today for one call |

### B5. Transport and persistence

| # | Expectation | Source | Status | Evidence / note |
|---|---|---|---|---|
| E27 | Sinks: `file` (stdio), `queue` (Azure MCP apps), `http` (bridge/push), `memory`/`null`; writer bounded ring 500, batch ≤ 100, 3 s timeout, retry once on 5xx/429, never on 4xx, never awaited | Capture §7.1–7.2, WI-04/05 | **partly** | `file`, `http`, `memory`, `null` shipped; **`queue` not built** (and no longer needed: the http sink with MI bearer covers the Azure apps in Part A phase 3 — propose to drop `queue`) |
| E28 | Azure MCP apps trace to the sink | Capture §7.2 | **open, deliberate** | `MCP_TRACE` unset on `tis-d-mcpd365fo-func` until a consumer exists (Part A phase 3) |
| E29 | Ingest Function App validates, upserts (into the store of E31) with `month`/`_ingested_at`/`_ingest_version`/`source_app_id`, dead-letters, 200/207/400/413, Easy Auth + `appid` allow-list, **503 fail-closed** | Capture §7.3, WI-11 | **open** | stub returns 202 and stores nothing — **this concept** |
| E30 | App named `tis-d-mcptrace-func`, routes self-prefixed `api/` | Capture §7.3 | **deviated** | app is `tis-d-claudetrace-func` (created 2026-09-04 before the TDD name), `routePrefix ''` with routes `trace/ingest`, `health` — no `api/`. Hook config `ingest_route: /trace/ingest`. Keep; update the TDD |
| E31 | Cosmos serverless, `disableLocalAuth`, hierarchical PK `/erp/system`,`/month`, no TTL on `traces`, 30 d on `deadletter`, §7.4 indexing, RBAC only, €10 alert | Capture §7.4, WI-12 | **deviated (2026-09-08)** | replaced by blob landing + Table Storage indexes in the existing account (Part A §3, decision 1); what survives: no TTL on the archive, 30 d on dead letters, no key material beyond the runtime's own connection, a cost alert (€5) |
| E32 | `Push-LocalTraces.ps1` uploads the stdio file sinks | Capture §7.2, WI-13 | **open** | Part A §5, phase 1; until then `~/.claude/mcp-trace/*.ndjson` is the only copy of server-side records |
| E33 | Loss on scale-in counted, not hidden | Module §8 | **met (client)** | writer `stats.failed`; no server-side counter until E29 |

### B6. Cost and footprint

| # | Expectation | Source | Status | Evidence / note |
|---|---|---|---|---|
| E34 | `MCP_TRACE=off` → no wrapper, no tool, no injected parameter, `tools/list` byte-identical | Capture §7.1 | **met** | budget test unchanged (155,766 B baseline holds) |
| E35 | `tools/list` growth from tracing ≤ +5 % per server, else inject on `CORE_TOOLS` only | Module §13.3 | **met trivially** | +0 today because E15/E23 are not shipped; the check is encoded for when they are |
| E36 | Call record ≈ 0.5–2 KB regardless of response size | Module §8 | **met** | 569 B server record, ~1.1 KB hook records |
| E37 | Protocol note ≈ 90 tokens per prompt | decision 2026-09-07 | **met** | two identical notes are printed per prompt while both the settings.json entries and the plugin `hooks.json` are registered — the overlap costs ~90 tokens per prompt until the plugin update lands and the five settings entries are removed |
| E38 | Whole sink ≪ €1/day | Capture §7.4 | **expected** | Part A §3/§7 estimate ≈ €0.3/month at the upper bound + shared plan |

### B7. Distribution and operations

| # | Expectation | Source | Status | Evidence / note |
|---|---|---|---|---|
| E39 | Plugin is the distribution unit; a user without it traces nothing locally | Module §13.9 | **met** | plugin 1.4.1 ships `hooks.json`; installed cache on this machine still 1.0.0 → the repo-path entries in `~/.claude/settings.json` bridge it |
| E40 | Off switch: `enabled: false` in `~/.claude/claude-trace.config.json` | impl note §6 | **met** | |
| E41 | Config keys `transport`, `ingest_route`, `instruct`, `allow_prompt_fallback`, `erp` in the config file | impl note §6 | **deviated (harmless)** | the file on disk holds only `url`/`key`/`timeoutMs`/`enabled`; the hook's defaults supply the rest (`both` when `url` is set). Either add them explicitly or correct the note |
| E42 | Deploy verified by ping + the host's function count, never by 401s; `src/trace` in both staging lists | lesson 2026-09-07 | **met** | `test/deploy-staging.test.js`; PRs #135/#136 |
| E43 | ClaudeTrace repo under version control with a remote | — | **partly** | 3 local commits, **no remote** |
| E44 | One conformance kit for the next emitter (M3 bridge) | Capture WI-14 | **open** | Part A §9's shared corpus is its seed |
| E45 | v0.1 hooks (`trace-request.cjs`, `trace-result.cjs` — raw prompt and result text to the stub) retired at the 2026-09-07 cutover | impl note §6 | **met (fixed 2026-09-08)** | the two `settings.json` registrations were still in place on 2026-09-08 morning and were removed then; the files and routes go in phase 1 |

### B8. Reading the register

- 45 expectations: 24 met · 8 partly · 7 open · 5 deviated · 1 expected (cost, E38). Four deviations are approved or
  harmless; the fifth (E31, no Cosmos) is Part A decision 1 and awaits Florian's confirmation.
- The **open** items cluster in one place: everything server-side of `POST /trace/ingest` (E11, E29, E32) plus the
  three deliberately deferred correlation/coverage items (E15, E23, E28). Part A is the plan for the first cluster; the
  second waits for a connector-trace consumer.
- The two **partly** items that are defects rather than limits: E20 (declared request lines only in the first text of a
  turn) and E22 (no `annotate` emitter). Both are hook changes in the MCP repo, independent of the sink.
