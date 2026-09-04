# Technical Design: Cross-ERP Trace Module

**Project**: tis-d-mcpd365fo (D365FO MCP platform) — shared with every future ERP bridge (Infor M3 first)
**Owner**: Trelleborg IT Services (TIS)
**Version**: 1.3 (Draft for review checkpoint — supersedes 1.2: traces record HOW to reproduce an investigation, not its results; `step` phase; hook-based auto-capture in Claude Code)
**Date**: 2026-09-04
**Author**: Fable 5.1, from `docs/ERP-Trace-Module-Concept-and-Fable-Spec.md`, the 1.0 review and the 2026-09-04 scope decision
**Status**: Design — **STOP after this document; no implementation, no `az` command, until a human approves §14**

---

## 0. What the review changed

| # | Spec / v1.0 assumption | Finding | Consequence |
|---|---|---|---|
| R1 | No functional↔technical mapping knowledge exists yet | The **semantic layer** exists (ADR W7/W7b, #111): 60-entity ERP-neutral vocabulary, `sem_mappings` with confidence, `sem_dq_rules`, `sem_export/1`, `gen-dq-sql.js`, `recordContextHint()`, `privacyViolation()` | Trace = **raw evidence**; semantic layer = **curated result**. Shared: vocabulary ids + privacy denylist (§2.2). |
| R2 | A write tool needs new annotation plumbing | `WRITE_METADATA_ANNOTATIONS` exists; the static scan accepts only `READ_ONLY_(DB\|LIVE)` in `TOOL_FILES` | New `WRITE_TRACE_ANNOTATIONS` (`openWorldHint: true`); scan widened deliberately (WI-10). |
| R3 | A transport session id exists for correlation | Azure entry points build a **stateless `McpServer` per request**; only stdio has a process lifetime | **v1.1: correlation is written, not inferred** — the investigation is opened first and its id is stamped on every MCP record (§7). |
| R4 | "Same hosting as the MCP services" | Root-zip deploy to one EP1 app; `routePrefix ''`; Key Vault via MI; Easy Auth + `roles`, fail-closed 503 | Second Function App for ingest, same patterns; npm workspaces avoided (symlinks break zip deploy, §4). |
| R5 | Task Recorder falls back to `full` under `core` | `effectiveProfile()` returns `full` only when **zero** tools remain | A core trace tool would leave Task Recorder with one tool; `effectiveProfile` ignores it (WI-10). |
| R6 | v1.0: Claude logs once, at the end, recalling its calls | Recollection is lossy and the link is reconstructed at analysis time | **Lifecycle**: `open` → stamped MCP traces + `annotate` → `close`. The dossier exists before the conclusion lands (§3, §7). |
| R7 | v1.1: an investigation is identified only by its `investigation_id` | **Scope decision 2026-09-04**: the same request must be re-run on another ERP and the two dossiers compared. An id per run cannot join runs. | **`request.key`** — a stable, ERP-neutral key chosen on the first run and reused on every other ERP; **`request.interpreted`** — Claude's ERP-neutral restatement, good enough to paste into a session on the other ERP (§1.0, §5.3, §7). |
| R8 | v1.1: Stream 1 records a structural *sample* (≤ 200 entities, ≤ 500 facts, 9 fact kinds, 25 tools with extractors) | A dossier that needs the MCP re-queried to be compared is not self-sufficient; comparison needs every field with its type, length, format, key, relation and cardinality | Facts widened to the five information classes (§1.0), caps raised and **chunked** (`call_id` + `part`), every tool gets an extractor; `STRUCTURAL_ONLY` shrinks to raw SQL and person-scoped security tools (§5.2, §6, WI-06). |
| R9 | v1.1: process knowledge is out of the contract; Task Recorder is `STRUCTURAL_ONLY` | Data lifecycle is driven by the process; the migration needs both | `process[]` and `lifecycle[]` on `annotate`/`close`; a structural Task Recorder extractor (forms, menu items, step count — never a captured value) (§5.2, §5.3). |
| R10 | v1.2: Stream 1 stores every structural fact a response carried (complete, chunked) | **Decision 2026-09-04 (2nd):** tool results are verbose, add nothing that the snapshot does not already hold, and are reproduced exactly by re-running the call. What a comparison needs is the *path*: the interpreted request, the strategy, the sequence of calls with their arguments, and the conclusion. | Stream 1 = **call record** (tool + replayable args + result kind/size + touched names). No `observations`, no chunking. Stream 2 gains **`step`** (Claude's strategy line before a group of calls). **R8 is superseded.** In Claude Code the whole dossier is captured by **hooks** from the transcript, with no model discipline; the tool is the claude.ai fallback (§3, §10, WI-16). |

---

## 1. Objectives (Ziele) and how each is achieved

### 1.0 Scope decision (2026-09-04) and the governing requirement

**Scope.** This project takes valuable traces about an ERP system's **logical and physical data structure** and about the **processes Claude analysed from the user's input**. The flow is: User → Claude (logs the initial request and its conclusion) → MCP (logs every information request — the tool and the arguments it was issued with — never the response). A completely different process later exploits those logs; it is **not part of this project** and nothing here is designed for it beyond the persisted shape.

**R0 — Reproducibility governs every other choice.** A trace must allow the *same request* to be run against another ERP system and produce a dossier that is **comparable** with the first one. Two dossiers are comparable when Claude, reading only the traces, can state how the two ERPs differ and how their structures might map for a data migration. Consequences, each binding on the contract:

| # | Consequence | Where |
|---|---|---|
| R0.1 | A **request** is the unit of comparison. `open` carries `request.key` (stable, ERP-neutral, reused on every ERP), `request.interpreted` (the interpretation line Claude writes before its first tool call — ERP-neutral, replayable, present even when the raw request was an image) and `request.approach` (the announced plan, ERP-specific allowed). Dossiers join on `request.key` across `erp.system`. | §5.3, §7 |
| R0.2 | The dossier records **how**, not **what**. Tool results are not stored: they are verbose, they add nothing the snapshot does not hold, and replaying the recorded call against the same snapshot date reproduces them exactly. A dossier = interpreted request → approach → steps → calls (with arguments) → annotations → conclusion. | §5.2, §5.3 |
| R0.3 | The call sequence is **replayable**: `tool.args` carry every argument needed to re-issue the call (identifiers, numbers, booleans, denylisted search terms, literal-masked SQL); order is `ts` then `id` (ULIDs are time-ordered); `mcp.snapshot_date` on every record makes drift between investigation and replay visible. | §5.2, §6, WI-06 |
| R0.4 | Both ERPs are described in the **same vocabulary**: phases, argument policies, `touched[].kind`, `functional_entity` ids and enum values are ERP-neutral; the ERP-specific part is only the tool name, the argument values and the object names. | §5.2, §5.3 |

**The five information classes a comparison needs** (clean data needs the structure, the structure needs the entity, the entity's lifecycle is driven by the process) and **where each comes from at analysis time**:

| Class | Content | Obtained by |
|---|---|---|
| **Physical structure** | field names, physical types, length/precision, format, defaults, mandatory, keys, indexes, relations with cardinality and delete action, company scope | **Replaying** the recorded calls (`d365_lookup_table`, `d365_effective_schema`, `d365_get_join_keys`, the M3 equivalents) against the snapshot named in `mcp.snapshot_date` |
| **Logical structure** | logical types (EDT), labels, documentation, enum values, table group, customisation origin | Replaying `d365_get_entity_sources`, `d365_get_enum`, `d365_resolve_label`, … |
| **Entities** | logical entity (vocabulary `functional_entity`), physical realisation (AOT table / data entity; other ERPs: their objects), role for this request, Claude's counterpart hypothesis | Stream 1 call records (`touched[]` names, the *what was looked at*); Stream 2 `annotate.entities[]` (`role`, `functional_entity`, `counterpart`) |
| **Data lifecycle** | state field, states, transitions and triggers, retention | Stream 2 `lifecycle[]` (Claude's reading, from the user's input and the replayed structure) |
| **Process** | the steps Claude reconstructed from the user's description, the entities each touches, the transition each causes | Stream 2 `process[]`; the Task Recorder call record (names + hash of the recording — the one input a replay cannot regenerate, §6) |

**The dossier itself is the path, in Claude's words** (this is what the screenshots of a real session show and what the trace must hold verbatim):

| Dossier element | Example from a real session (2026-09-04) | Record |
|---|---|---|
| Interpreted request | *"I'll load the D365FO MCP tooling skill first, then query the knowledge base for the vendor table and data entity structure."* | `open.request.interpreted` (+ `approach`) |
| Strategy line before a group of calls | *"Now querying the KB for the vendor data entity and its backing table."* | `step.intent` |
| Each information request | `d365_get_entity_sources(entity_name: "VendVendorV2Entity", limit: 60, functional_context: "vendor")` | Stream 1 call record — the arguments, **not** the response |
| Claude's structural reading | *MITBAL is the source for inventory_balance; PALFAC must be present for every stocked item* | `annotate` (`entities`, `expectations`, `process`, `lifecycle`) |
| Conclusion | *"The vendor entity is a composite: VendVendorV2Entity, 301 fields from 20 data sources, primary table VendTable, party identity from the Global Address Book …"* | `close.conclusion.summary` |

**What this project deliberately excludes** (unchanged, now also by decision): classification of mappings, DQ-rule derivation, any read path for an LLM, any downstream analysis. Objectives O1–O4 below describe *why the traces are valuable*; the mechanism serves R0 first.

The module has one mechanism — two trace streams bracketed by an investigation lifecycle — serving four objectives. Each objective names what is produced, who consumes it, and which part of this design delivers it.

### O1 — Migration knowledge: source → functional entity → D365FO technical entity
**Produced:** for every legacy table/field a key user or consultant ever looked at, evidence of what it is (structure, from Stream 1), what business concept it serves (Claude's `annotate`, tied to a vocabulary `entity_id`), and how that concept is realised in D365FO (the same vocabulary id is already mapped to AOT entities in the semantic layer — `sales_order` → `SalesTable`/`SalesLine`).
**Consumed by:** the analysis project (separate), which classifies each source object as **known / candidate / unknown** across the corpus and proposes the mapping a DMF or Connectivity Studio project executes. The trace never carries that classification (§2.2 Principle 2).
**Delivered by:** Stream 1 stamped with `investigation_id` (§5.2, §7), `annotate` with `role: source|target|related|excluded` (§5.3), the shared `entity_id` vocabulary (§2.2), Cosmos indexed on `investigation_id` and entity names (§9).

### O2 — Data-quality reports for the legacy ERP, generated not hand-written
**Produced:** `expectations` — per entity/field, what *correct* looks like (`type`, `range`, `format`, `unit`, `enum`, `relation`, `mandatory`, `uniqueness`) and what **not** to expect (`anti_pattern`) — captured while the person who knows the data is in the conversation.
**Chain to a report (what exists, what this module adds, what is separate):**

| Step | Owner | State |
|---|---|---|
| 1. Expectation captured in an `annotate`/`close` trace | **this module** | new |
| 2. Analysis reads expectations, drafts declarative DQ rules | analysis project | separate |
| 3. Rule stored: `sem_dq_rules` via `d365_map_dq_rule` (or an M3 bridge writing the same rows) | semantic layer (W7) | exists |
| 4. `export-semantic.js` → `gen-dq-sql.js --dialect tsql|sqlite` renders SQL | semantic layer | exists |
| 5. Script runs **where the data lives** (M3 snapshot / D365 BYOD), no AI in the loop | operator / scheduled job | exists (pattern) |
| 6. Aggregates (`rows_checked`, `rows_flagged`) return to `sem_dq_runs`; dashboards render them | semantic layer + deterministic dashboards | exists |

The module's contribution is step 1 — and the rule of the M3 project stays: **the MCP knows the rule; the generated script finds the rows.** Nothing here says "the trace found N duplicates".
**Delivered by:** `expectations[]` in §5.3, indexed `/entities/[]/name`, the conformance kit so an M3 bridge emits the same shape (WI-15).

### O3 — Key users get better tools now (the win-win, §1.1)
**Produced:** dashboards, reports and small performance apps for the legacy ERP, built by Claude at build time and refreshed deterministically (M3 decision #1). Each build is an investigation; each investigation leaves a dossier the next one starts from.
**Delivered by:** the lifecycle tool being cheap to use (three calls per investigation), the stdio implicit stamping (no parameter discipline needed locally, §7), the plugin skill guidance (WI-14).

### O4 — D365FO consultants understand the legacy system without starting cold
**Produced:** the accumulated dossiers — goal, what was looked at, what was concluded, what was excluded — per legacy ERP, per site.
**Delivered by:** `open.title`/`purpose`, `annotate.role: excluded` (the "looks relevant, is not" knowledge that is otherwise never written down), `close.outcome`.

### 1.1 The win-win for functional key users

| The key user gives | The key user gets | The organisation gets |
|---|---|---|
| The **goal** of each investigation, in one sentence (`open`) | A dashboard/report built against the right tables faster — Claude starts from prior dossiers on the same entities | The goal ↔ entities link: which business questions touch which legacy tables (relevance heat map — M3 Level A, now with content) |
| A judgement when the MCP returns a table: **source / related / excluded** (`annotate`) | Fewer wrong turns on the next report — excluded tables stay excluded | The functional mapping of the legacy ERP, from the people who know it, at zero extra meeting time |
| What *correct* looks like for the fields they rely on (`expectations`) | **DQ findings on their own data, on their own KPIs** (missing pallet factors, broken UoMs, stale dates), fixed before they break a report | Target-readiness rules for the migration, derived from real usage instead of a profiling project |
| A conclusion (`close`) | The conclusion is reusable — the next consultant reads it instead of asking again | Institutional memory of the legacy ERP that survives staff changes |

What the key user does **not** give: any business record, any person's identity, any free text about a customer or supplier — the choke point (§6) rejects it, and the role enum replaces names.

### 1.2 Worked example — the Clermont-Ferrand rétention pilot, run twice
1. `open` on the M3 bridge — purpose `dashboard`, request key `req.inventory.projected_stock_by_zone`, request interpreted "Projected stock per storage zone against zone capacity, in handling units, from on-hand plus open supply minus planned consumption; the zone is a site-specific attribute of the location", role `key_user`, expected entities `inventory_balance`, `purchase_order`, `production_order`, `storage_zone` (vocabulary ids illustrative).
2. `step` — *"Looking up the balance, location, planned-order and item tables on the M3 bridge."* Claude calls `m3_lookup_table MITBAL`, `MITLOC`, `MPLINE`, `MITMAS` — each call is traced automatically with the investigation id, its **arguments**, the result kind and the object names it touched. The responses are not stored: re-issuing the four calls against the same snapshot date returns them.
3. `annotate` — `MITBAL` role `source` for `inventory_balance`, level `physical`, counterpart hypothesis `d365fo:InventSum`; `MITMAS.PALFAC` (illustrative) expectation `mandatory` "pallet conversion factor present for every stocked item", `anti_pattern` "0 is used as *unknown*, not as a real factor"; the site's "rétention" flag lives in a customization field → role `source`, functional entity `storage_zone`. `lifecycle` for `inventory_balance`: states `planned → on_hand → reserved → picked → issued`, trigger per transition as the key user described them. `process` "receive to rétention": 4 steps, each naming the entities it touches and the transition it causes.
4. `close` — conclusion: projection = on-hand + open PO − planned consumption, in pallets; outcome `answered`; expectations, process and lifecycle carried over.
5. **Replay on D365FO**: `open` with the **same** `request.key` and the same text; Claude calls `d365_lookup_table InventSum`, `InventDim`, `WHSInventReserve`, `PurchLine`, `ProdBOM`; `annotate` records `InventSum` role `source` for `inventory_balance`, `WMSLocation`/`InventLocation` for `storage_zone`, the D365 lifecycle from `InventTrans.StatusIssue`/`StatusReceipt` enum values; `close`.
6. Later, outside this module: a process joins the two dossiers on `request.key`, **replays** both call sequences against their snapshots to obtain the structures, compares the five classes side by side with the two conclusions, and proposes the mapping and the cleansing rules.

---

## 2. Scope and positioning

### 2.1 In scope
Contract (JSON Schema v1 + Zod mirror + fixtures + conformance kit) · Node client (sanitizer, writer, sinks, the `trace_investigation` tool, the Stream-1 wrapper, central parameter injection) · D365FO adoption on all four servers · ingest Function App (queue + HTTP → Cosmos) · Bicep (not executed) · docs, `.env.example`, local push script, M3 adoption guide.

### 2.2 Principles, and the line to the semantic layer
1. **Evidence, not conclusions.** Trace records are append-only observations; curated mappings and rules live in the semantic layer (`d365fo_semantic.sqlite`, per installation). Shared: `entity_id` vocabulary (opaque string here, validated there), privacy denylist (parity-tested). Nothing else.
2. **Classification is post-hoc.** No confidence, status or verdict in a trace. `annotate.role` is Claude's assertion *for this goal*, not a corpus-level class.
3. **One write-only LLM boundary.** Exactly one tool, `trace_investigation`; no read/query/list/delete on traces, ever. Enforced by static scan.
4. **Privacy is a choke point**, not a filter (§6).
5. **Never on the hot path** (§8).
6. **Loose coupling is the contract** — a JSON Schema, not a library (§4).
7. **D365FO AOT is the reference technical-entity model.** Other ERPs are mapped toward it; their own technical entities are ERP-specific and never assumed to resemble AOT.
8. **Reproducible, not self-contained (R0).** A dossier carries the path — interpreted request, strategy, calls with arguments, annotations, conclusion — never the tool results. Two dossiers with the same `request.key` are compared by replaying their calls against their snapshots. Results are the snapshot's job; the trace's job is to say what was asked of it and what was made of the answer.

| | Trace module | Semantic layer (exists) |
|---|---|---|
| Nature | Append-only observations + Claude's investigation phases | Curated mappings with confidence, DQ rules |
| Store | Cosmos DB, central, all ERPs | SQLite per installation, `sem_export/1` |
| Written by | every tool call; `trace_investigation` | `d365_map_entity`, `d365_map_dq_rule`, `recordContextHint`, seeds |
| Read by | analysis project only | KB tools, `gen-dq-sql.js` |

---

## 3. Architecture

```
 Claude ── open ── request { key, interpreted, approach } ─────────────────────▶ returns investigation_id
   │                                                                              (stdio: becomes the process default)
   ├── step ── "Now querying the KB for the vendor data entity and its backing table."     Stream 2
   ├── d365_get_entity_sources { entity_name, limit, functional_context } [investigation_id] ─┐ Stream 1: withTrace()
   ├── d365_lookup_table { table_name } …                                                   ├─ records tool + args +
   ├── step ── "Checking the customisation surface of VendTable."                           │  result kind/size/touched
   ├── xref_find_extensions { … }                                                            ┘  — never the response
   ├── annotate ── role per entity, expectations, process, lifecycle                       Stream 2
   └── close ── conclusion, outcome, differences                                            Stream 2
   │
   │  In Claude Code every Stream-2 line above is lifted from the transcript by HOOKS (UserPromptSubmit /
   │  PreToolUse / Stop) — the model calls nothing. On claude.ai the same lines come from trace_investigation.
                                   │
                          sanitize() — the ONLY producer of a SanitizedTraceRecord
                                   │
                          TraceWriter — bounded ring, batched, never awaited
                                   │ sink: file (stdio) · queue (Azure) · http (M3 / push) · memory/null (tests)
                                   ▼
             trace-ingest Function App — queue trigger + HTTP — schema + privacy re-check
                                   ├─ valid   → Cosmos `traces`      (indexed: investigation_id, entities, tools)
                                   └─ invalid → Cosmos `deadletter`  (id, reason, hash — no payload)
```

**Loose coupling.** The wire contract is the schema; a Python M3 bridge participates with the schema and an endpoint. Nothing under `src/trace/` imports from `src/azure/`; the reverse only via `src/trace/index.js` (static-scan). The ingest app gets a hash-checked **copy** of the contract (§4).
**LLM boundary.** One tool. The writer, sinks and ingest are never registered; the scan asserts one `registerTool(` under `src/trace/` and exactly one `trace_*` name in every `tools/list`.
**Two capture paths, one contract.** (a) **Hook capture** (Claude Code, primary): the d365fo-mcp plugin ships `hooks/hooks.json` + `hooks/trace-capture.cjs`. `UserPromptSubmit` mints an `investigation_id` and writes it to `~/.claude/mcp-trace/current` (the local stdio servers read that file per call, so Stream 1 is stamped without any parameter); `PreToolUse` on `mcp__d365*`/`mcp__claude_ai_D365*` reads the transcript (`transcript_path`) and emits the **assistant text since the previous event** as `open` (first time — that text is the interpretation line) or `step`, plus a Stream-1 call record from `tool_name`/`tool_input` (the only Stream-1 source when the call went to a claude.ai connector); `Stop` emits `close` with the final assistant message as `conclusion.summary`. The user's prompt is read for nothing but its timestamp — the trace holds Claude's words only (§1.3). (b) **Tool capture** (claude.ai, fallback): `trace_investigation` with the same phases, driven by the skill text. Both paths write the same schema through the same `sanitize()`; a dossier never says which path produced it except via `mcp.service = 'hook'`.
**Local.** Stdio defaults to `TRACE_SINK=file` (`~/.claude/mcp-trace/<service>.ndjson`); `scripts/Push-LocalTraces.ps1` uploads. Tests use `memory`/`null`.

---

## 4. Placement (proposal)

`src/trace/contract/` (schema, fixtures, zod, privacy, sanitize, ids, conformance — **zero** imports from `../..`) · `src/trace/client/` (writer, sinks, wrap, tool, session, identity adapters) · `src/trace/index.js` (the one entry point) · `services/trace-ingest/` (own `package.json`/`host.json`; `contract/` is a build-time copy, hash-asserted) · `infra/modules/{cosmos,traceFunctionApp}.bicep`.

Why in-repo, plain folders: one consumer today; a second repo means a second CI/deploy before anything uses it. Why no npm workspaces: they are symlinks, and `Deploy-FunctionApp.ps1` zips the repo root — broken links on Kudu. Why a copy for the ingest app: the contract is data; `npm run build:trace-ingest` copies it and a test fails on hash drift. The M3 bridge takes an `npm pack` tarball of `src/trace/contract` (GitHub release asset) or the raw schema. **Extraction trigger:** the M3 bridge repo, or a third consumer → `git mv` to a `mcp-trace` repo; the isolation scan makes it a rename. `services/` and `infra/` join the root-zip exclusion.

---

## 5. Contract v1 (`trace-record.v1.schema.json`)

### 5.1 Envelope (both streams)
| Key | Rule | Source |
|---|---|---|
| `id` | `^(mcp\|claude)_[0-9A-HJKMNP-TV-Z]{26}$` | `ids.js` |
| `contract_version` | `^1\.\d+\.\d+$` | constant |
| `stream` | `mcp` \| `claude` | |
| `ts` | ISO-8601 UTC | |
| `erp` | `{ system, version?, build?, installation_id }` — reuses `MCP_ERP_SYSTEM` / `MCP_ERP_VERSION` / `MCP_INSTALLATION_ID` (semantic layer) | identity adapter |
| `mcp` | `{ service, version, snapshot_date? }` | `packageVersion()`, `readBuildDate()` |
| **`investigation_id`** | identifier, **optional on `mcp`** (absent = not inside an investigation), **required on `claude`** | param → process default → absent |
| `session_key` | 32 hex | §7 fallback |
| `seq` | int ≥ 0 per process | |
| `source` | `server` \| `hook` — which capture path wrote the record (§3) | constant per emitter |

`additionalProperties: false` everywhere. **Identifier grammar** `^[A-Za-z][A-Za-z0-9_.:/%*-]{0,127}$` — starts with a letter, so a RecId or account number can never pass as one. **Order within a dossier** = `ts`, then `id` (ULIDs are time-ordered and monotonic within a process) — this is what makes the call sequence replayable across stateless Azure requests without a per-investigation counter.

### 5.2 Stream `mcp` — the call record (automatic)
```
tool:     { name, args }                    // args: EVERY argument the call was issued with, each under a policy (§6):
                                            //   identifier | number | boolean | identifier[]≤50 | term | sql_shape | payload_ref
result:   { kind: data|empty|not-found|error, bytes: int, rows?: int, has_more?: boolean, coverage?: [..] }
touched?: [ { kind: table|field|edt|enum|class|method|data_entity|form|menu_item|role|duty|privilege|model|recording|other,
              name, owner? } ]              // ≤ 200 — the object NAMES the response was about, for indexing; nothing about them
functional_context?: identifier
```
- **The response is not stored.** `result` says only how the call ended and how big the answer was (`bytes` of `structuredContent`, `rows` when the payload has one obvious list, `has_more` from the pagination meta) — enough to know whether a replay must page further. `touched[]` lists names so that "which dossiers looked at VendTable" is one indexed query; it carries no type, no field, no fact.
- **`args` are the replay.** For every data tool the policy table in `trace-args.js` names each parameter and its policy; a parameter with no policy is **dropped and counted** (`coverage += 'args_partial'`), so an unreplayable record is visible, never silent. `term` is a search string (≤ 100 chars, denylisted, no digit run ≥ 5). `sql_shape` is the `*_raw_sql` text with every string and numeric literal replaced by `?` — the query's structure is kept, its literals are not. `payload_ref` is for the two Task Recorder tools, whose argument is the recording itself: `{ sha256, bytes, forms: identifier[]≤50, menu_items: identifier[]≤50, steps: int }` — the one input a replay cannot regenerate from a snapshot, recorded as a fingerprint plus structural names, never a captured value.
- `rows`/`bytes` are the only numbers. `args` values are never objects except `payload_ref`.

### 5.3 Stream `claude` — the lifecycle (`phase` discriminates)
```
phase: open
  investigation: { id, purpose: dashboard|report|app|migration_mapping|dq_rule|support|process_analysis|comparison|other,
                   title: prose≤200, asked_by_role: key_user|consultant_functional|consultant_technical|architect|developer|other,
                   expected_entities?: identifier[]≤20 }                 // vocabulary ids, opaque here
  request:       { key: identifier, interpreted: prose≤600, approach?: prose≤400, parameters?: [ { name: identifier, value: identifier } ]≤20 }
phase: step
  investigation: { id }
  n:             int ≥ 1                                                 // position in the dossier
  intent:        prose≤400                                               // Claude's strategy line, verbatim: "Now querying the KB for …"
  expects?:      identifier[]≤20                                         // objects/entities Claude says it is going after
phase: annotate
  investigation: { id }
  entities:      [ { erp?, kind, name, level?: logical|physical, functional_entity?: identifier,
                     role: source|target|related|excluded, counterpart?: { erp: identifier, name: identifier } } ]   // ≤ 50
  note?:         prose≤300
  expectations?: [ Expectation ]                                          // ≤ 50
  process?:      [ Process ]                                              // ≤ 10
  lifecycle?:    [ Lifecycle ]                                            // ≤ 20
phase: close
  investigation: { id }
  conclusion:    { summary: prose≤6000, outcome: answered|partial|abandoned,       // the final answer, verbatim (6 000 covers the vendor example)
                   expectations?: [ Expectation ]≤100, process?: [ Process ]≤10, lifecycle?: [ Lifecycle ]≤20,
                   differences?: [ { aspect: structure|entity|lifecycle|process|other, statement: prose≤300 } ]≤50 }
  calls?:        [ { tool, object? } ]                                    // ≤ 50, optional — stamped Stream-1 records are authoritative

Expectation = { entity, field?, kind: type|range|format|unit|enum|relation|mandatory|uniqueness|anti_pattern, statement: prose≤300 }
Process     = { name: identifier, functional_entity?: identifier, source: user_description|task_recording|documentation|inferred,
                steps: [ { n, action: prose≤200, actor_role?: asked_by_role-enum, entities?: identifier[]≤10,
                           transition?: { entity: identifier, field?: identifier, from?: identifier, to?: identifier } } ]≤40 }
Lifecycle   = { entity: identifier, state_field?: identifier, states: identifier[]≤30,
                transitions?: [ { from: identifier, to: identifier, trigger: prose≤150, process?: identifier } ]≤60,
                retention?: prose≤200 }
```
- **`request` is the reproducibility contract (R0.1).** `key` is chosen by Claude on the first run as a stable ERP-neutral slug (`req.<domain>.<question>`, grammar-checked) and **reused verbatim** on every other ERP; the tool description and the plugin skill say so. `interpreted` is **the interpretation Claude already produces before its first tool call** — the "I'll check X and Y, then give you the assessment" line — not a paraphrase written for the trace. That line is the replayable form of the request for three reasons: it exists even when the raw request is not text (a screenshot, an attached file, a pointer to a ticket); it is Claude's words, so spec §1.3 stands (no free text a user typed); and pasting it into a session on another ERP reproduces the investigation. It must be ERP-neutral — the *question*, not the objects. `approach` is the second half of that same line, the announced plan (*which* things Claude will look at, in which order); it MAY name ERP-specific objects, because how the same question is answered on each ERP is exactly what the comparison wants to see. `parameters` bind the ERP-specific identifiers the interpretation abstracts over (site, company, the field that carries the zone). All three are denylisted like every prose field; the tool description tells Claude to reuse its own opening line rather than compose a new text.
- **`step` is the strategy, in Claude's words.** Each is the narration line Claude writes before a group of calls (*"Now querying the KB for the vendor data entity and its backing table"*). The calls that follow it, up to the next `step`, belong to it — by `ts` order, no explicit link needed. Under hook capture the line is lifted from the transcript verbatim; under tool capture the skill asks Claude to pass its own line. A dossier with `open` and `close` but no `step` is valid (a one-call investigation).
- **Conclusion is stored, results are not.** The conclusion is Claude's reading and is what two ERPs are compared on; a tool response is the snapshot's content and is replayed instead. The cap is generous because the conclusion of a structural investigation is long by nature (the vendor example is ≈ 5 000 characters); the denylist still applies to every character of it.
- `counterpart` is Claude's *hypothesis for this request* about the same entity in another ERP — an observation like `role`, not a verdict (principle 2). `differences` on `close` is the same thing at dossier level, written when the request was already run elsewhere and the model can see both. Neither carries a confidence.
- `process.source` states where the process knowledge came from; `task_recording` means a Task Recorder call in this investigation produced the structural evidence (`form_sequence`), and the steps are Claude's reading of it.
- `asked_by_role` is an enum — a person is never recorded. Prose that trips the denylist rejects the whole call with `errorResult('invalid-input', …)` naming the field, never quoting the text.

### 5.4 Versioning
Additive optional keys → minor; removal/rename/tightening → major with a new schema file. Records carry their version; ingest accepts `TRACE_ACCEPT_VERSIONS` (default `>=1.0.0 <2.0.0`). Every `fixtures/valid/**` file must validate forever. Zod mirror ↔ JSON Schema parity is tested with the SDK's own AJV.

---

## 6. Privacy choke point

- **One function, one brand.** `sanitize(record, policy)` returns a frozen record carrying `Symbol.for('mcp.trace.sanitized')` or `{ ok:false, reason, field }`. `TraceWriter.enqueue()` throws on an unbranded record; every sink accepts only branded ones; the ingest re-runs the same checks. Static scan: the symbol is created in `sanitize.js` only.
- **Field policies** declared in the schema as `x-text-policy`: `identifier` (grammar; Stream 1 **drops**, Stream 2 **rejects**) · `prose` (denylist + cap; any hit rejects the record) · `term` (search terms in `tool.args` only: ≤ 100 chars, denylist, no digit run ≥ 5; a hit **drops** the arg and marks `result.coverage += 'args_redacted'`) · `enum` · `aggregate`.
- **Denylist** = the semantic layer's four regexes (e-mail, IBAN, VAT, phone — copied, parity-tested) **plus** digit runs ≥ 7, URL with query string, key names `sample|example|value(s)|data|record|row(s)|payload` in any serialised object.
- **Every argument has a policy or is dropped.** `trace-args.js` maps each data tool's parameters to `identifier | number | boolean | identifier[] | term | sql_shape | payload_ref`; a parameter without a policy is dropped and `coverage += 'args_partial'`. `sql_shape` masks every literal in `*_raw_sql` text (`WHERE AccountNum = 'V-000123'` → `WHERE AccountNum = ?`), so the query structure is replayable in shape and never carries a value. `payload_ref` (both `taskrecorder_*` tools) fingerprints the recording — `sha256`, `bytes`, `steps`, form and menu-item names — and never reads a typed value or annotation text (asserted by a KO test on a recording fixture full of denylist hits). `sec_*` tools with a user parameter record the parameter **name** with value `<redacted>`: the call shape is kept, the person is not.
- **Responses are never read** except for `result.kind`, `bytes`, `rows`, `has_more`, `coverage` and `touched[].name` — a static scan asserts that `withTrace` and the hook never serialise `structuredContent` beyond those keys.
- **Person-level guard.** No key matching `/user|principal|upn|oid|email/i` outside `entities[].name`/`tool.name`.
- **Dead-letter is payload-free**: `{ id, ts, reason, field, source_app_id, sha256(record) }`.

---

## 7. Correlation — written at trace time

| Carrier | Where | Strength |
|---|---|---|
| **`investigation_id` parameter**, injected centrally into every data tool's `inputSchema` by `withRegistrationPolicy` (same seam as `withTitle`), read and **stripped** by `withTrace` before the handler runs | all servers | strong — explicit |
| **Process default** set by `open`, cleared by `close`, expires after `TRACE_INVESTIGATION_TTL` (8 h); a new `open` replaces it | stdio (one Claude Code session = one process) | strong — implicit, no discipline needed |
| `session_key` — `hour` mode default (`sha256(salt \| yyyy-mm-ddThh)`), `principal-hash` opt-in (`sha256(salt \| oid \| day)`, Key-Vault salt; governance decision §13) | records with no investigation id | weak — the fallback, no longer the mechanism |
| `close.calls[]` | optional | corroboration only |
| **`request.key`** (Stream 2 `open`) | all servers | the **cross-ERP, cross-run join**: every dossier of the same request on any ERP shares it; it is the only key the comparison needs (R0.1) |

Rules: the tool result of `open` says *"pass `investigation_id` on data tools and on annotate/close; reuse this `request.key` when you run the same request on another ERP"*; on Azure that parameter is the only strong link. `close`/`annotate` with an id this process did not mint are **accepted** (Azure cannot know; the analysis sees an open-less dossier). A dossier = all records sharing an `investigation_id`; a **comparison set** = all dossiers sharing a `request.key`.

---

## 8. Non-blocking writer

`enqueue` synchronous, O(1), bounded ring 500, drop-oldest, one warning per 60 s · flush via `setImmediate` (coalesced) or every 2 s (`unref`), batch ≤ 100 / ≤ 900 KB · sink timeout 3 s, one retry on network/5xx/429 (honours `Retry-After`), none on 4xx (`dropped_invalid`) · **never awaited on the response path**; `withTrace` returns the handler's result object unchanged (golden: `structuredContent` byte-identical) · the call record is built from `args` and five result keys only, so a record is ≈ 0.5–2 KB regardless of the response size · budget **p95 ≤ 2 ms** per call (memory sink, ×3 CI factor) · `MCP_TRACE=off` → no wrapper, no tool, no injected parameter, `tools/list` byte-identical. On EP1 the scheduled flush completes after the response; loss on scale-in is counted, not hidden — traces are evidence, not a ledger.

---

## 9. Cosmos DB

| Item | Decision |
|---|---|
| Account | `tis-d-mcptrace-cosmos`, **serverless**, West Europe, session consistency, `disableLocalAuth: true` (RBAC only). ≈ 2–10 k records/day × 0.5–2 KB (call records carry no response) × ~10 RU ≪ €1/day; the queue sink's 64 KB message limit is never approached; autoscale trigger documented at sustained 1 000 RU/s |
| `traces` | hierarchical PK `/erp/system`, `/month` (from `ts`); id = record id; **no TTL** (revisit at 10 GB) |
| `deadletter` | PK `/erp/system`, TTL 30 d |
| Indexing | include `/stream`, `/source`, `/ts`, `/investigation_id`, `/request/key`, `/session_key`, `/mcp/service`, `/tool/name`, `/touched/[]/name`, `/touched/[]/kind`, `/entities/[]/name`, `/entities/[]/functional_entity`, `/entities/[]/counterpart/name`, `/process/[]/name`, `/lifecycle/[]/entity`, `/functional_context`, `/phase`, `/n`; **exclude** `/conclusion/*`, `/tool/args/*`, `/note`, `/request/interpreted`, `/request/approach`, `/intent`; composite `(erp/system asc, ts desc)`, `(request/key asc, erp/system asc, ts asc)`, `(investigation_id asc, ts asc)` |
| Access | ingest MI → Cosmos Built-in Data Contributor; main app MI → Storage Queue Data Message Sender; no keys anywhere (Bicep test) |
| Cost | `costAlerts.bicep`, €10/month |

Item = record + `_ingested_at`, `_ingest_version`, `month`, `source_app_id` (an application, never a user).

---

## 10. Integration seams (this repo)

| Seam | Change |
|---|---|
| `tool-sets.js` | `withRegistrationPolicy`: `withTitle` → `withInvestigationParam` (injects `investigation_id: investigationIdParam` into `inputSchema` of every tool except the trace tool) → `withFreshness` (also skips `readOnlyHint:false`) → `withTrace` (strips the param, stamps, enqueues). `TITLE_PREFIXES` += `trace`. Every `TOOL_SETS[svc]` ends with `registerTraceTool`. `effectiveProfile` ignores `TRACE_TOOL_NAME` for the zero-tools rule. |
| `tool-guards.js` | `CORE_TOOLS` += `trace_investigation`. |
| `src/azure/trace-args.js` (new) | `ARG_POLICIES[tool] = { <param>: 'identifier'\|'number'\|'boolean'\|'identifier[]'\|'term'\|'sql_shape'\|'payload_ref'\|'redacted' }` for every data tool of all four services, **derived from each tool's Zod `inputSchema` by default** (string → identifier, number, boolean, string[] → identifier[]) and overridden by name for the exceptions (`query`/`queries` → `term`, `sql` → `sql_shape`, `recording*` → `payload_ref`, `user*` → `redacted`). `touchedNames(tool, typed)` returns the object names from the five allowed result keys. A coverage test asserts every parameter of every tool resolves to a policy. |
| `plugin/d365fo-mcp/hooks/hooks.json`, `hooks/trace-capture.cjs` (new) | **Hook capture** (§3): `UserPromptSubmit` → mint id, write `~/.claude/mcp-trace/current` `{ investigation_id, ts, prompt_ts }`; `PreToolUse` (matcher `mcp__d365.*\|mcp__claude_ai_D365.*`) → parse `transcript_path` JSONL from `prompt_ts`, take assistant `text` blocks since the previous emitted event → first one becomes `open.request.interpreted` (with `request.key` = `req.` + slug of that line, 60 chars; `approach` = its second sentence when present), later ones become `step.intent`; then a Stream-1 call record from `tool_name`/`tool_input` via the same `ARG_POLICIES` (`source: hook`, `result` omitted — the hook runs before the call; `PostToolUse` fills `result.kind`/`bytes` from `tool_response` when available); `Stop` → `close` with the last assistant text as `conclusion.summary`, `outcome: answered` (`abandoned` on `SubagentStop`/interrupt). Writes NDJSON to `~/.claude/mcp-trace/hook.ndjson` through the same `sanitize()`; exits 0 always, never blocks a tool. The user prompt text is never read into a record. |
| `src/azure/trace-identity.js` (new) | `erp.version` = `ApplicationSuite`, `erp.build` = `ApplicationPlatform` from `model_versions`; `mcp.version` = `packageVersion()`; `snapshot_date` = `readBuildDate(db)`. |
| Entry points | `MCP_TRACE ??= 'on'`; stdio `TRACE_SINK ??= 'file'`; Azure `TRACE_SINK ??= 'queue'`. Writer is a lazy process singleton (dry runs must not create files). |
| Tests | `response-format`: `TOOL_FILES` += `../trace/client/tool.js`, annotation regex accepts `WRITE_TRACE_ANNOTATIONS`. `tool-schema-budget`: +1 tool and +1 param per tool, ceilings re-baselined **after measuring**. `freshness`, `tool-guards`, `plugin`, `response-size-golden` extended. |
| Plugin skill `d365fo-mcp-tooling` | Two paragraphs. **Claude Code (hooks installed):** "Tracing is automatic. Your interpretation line, each strategy line before a group of calls, each call and your final answer are recorded; tool responses are not. Write one strategy line before each group of calls; state the request ERP-neutrally in your first line. `annotate` remains the one tool you call yourself, when a table is identified as source/excluded, a field's correct shape is stated, or the user describes a process or lifecycle." **claude.ai / no hooks:** "`open` before the first lookup with `request.key` (`req.<domain>.<question>`, reuse it on another ERP), `request.interpreted` = your interpretation line, `approach`; `step` with your strategy line before each group of calls; `annotate` as above; `close` with your final answer as `summary` and `differences` when you have seen the other ERP's dossier. Pass `investigation_id` on data tools. Never paste data values or the user's raw text." |
| `CLAUDE.md` | Trace module bullet + rule #17 (write-tool annotations, LLM boundary, injected parameter never in tool files). |
| `.env.example`, `Deployment-Runbook.md` | `MCP_TRACE`, `TRACE_SINK`, `TRACE_FILE_DIR`, `TRACE_QUEUE_URL`, `TRACE_INGEST_URL`, `TRACE_INGEST_SCOPE`, `TRACE_SESSION_KEY_MODE`, `TRACE_INVESTIGATION_TTL`. |

---

## 11. Work items — each with OK and KO tests

Conventions: `node --test`, `given/when/then` names, fakes injected (no network, no Cosmos), `test/integration/harness.js` for MCP round trips. Done = OK **and** KO green, `npm test` + `npm run typecheck` green, §10 docs cell updated.

### WI-01 Contract skeleton, schema v1, Zod mirror, isolation scan
- OK: every `fixtures/valid/*.json` (both streams × 4 services, all four phases, one `m3` example, **the vendor dossier of 2026-09-04** — `open` with the real interpretation line, two `step`s, six `mcp` call records with `source: server`, the same six with `source: hook`, `annotate`, `close` with the ≈ 5 000-char conclusion — and **one comparison pair**: the same `request.key` on `d365fo` and `m3`, `annotate` with `process` + `lifecycle` + `counterpart`, `close` with `differences`) validates in AJV **and** parses in Zod; identifier grammar accepts `CustTable`, `SalesTable.SalesId`, `/Tables/CustTable`, `%Invent%`, `req.inventory.projected_stock_by_zone`.
- KO: missing `erp.installation_id`; `claude` record without `investigation_id`; `open` without `request.key` or `request.interpreted`; `request.key` `12345`; `request.interpreted` of 601 chars; `step` without `intent` or with `n: 0`; unknown `phase`; `phase:open` carrying `conclusion`; `phase:close` without `conclusion.summary`; `contract_version 2.0.0`; extra key at each level; identifier `12345678`; `summary` of 6 001 chars; `entities` of 51 on annotate; an `mcp` record carrying `observations` or any key under `result` other than the five allowed; `tool.args` with an object value on a non-`payload_ref` policy; `touched` of 201; `Process.steps` of 41; `Lifecycle.states` of 31; `source` `client` — rejected by both validators with the same path.
- KO (scan): `src/trace/**` importing `../../azure/`; `src/azure/**` importing `../trace/` other than `index.js`; more than one `registerTool(` under `src/trace/`.

### WI-02 Privacy sanitizer
- OK: identifier args pass; clean prose passes; result is frozen and branded; `x-text-policy` from the schema drives the outcome (a fixture schema with a swapped policy flips it).
- KO: e-mail / IBAN / VAT / phone / `1234567` / `https://x?y=1` in prose → `{ ok:false, field }`, no brand, reason never quotes the text; arg not in `args_allow` → absent; `John Smith` as an arg → absent (no marker); object-valued `observations[].value` → rejected; key `sample` anywhere → rejected; unbranded record → `enqueue` throws; a fake `Symbol('mcp.trace.sanitized')` → rejected.
- Parity: every string that trips `privacyViolation()` in `test/semantic-store.test.js` is rejected. Person-level scan on all valid fixtures.

### WI-03 Ids, session key, investigation registry
- OK: `ulid()` 26 Crockford chars, monotonic in a ms; `sessionKey` modes `process`/`hour`/`principal-hash` behave as §7 (clock and salt injected); `registry.open(id)` sets the process default, `current()` returns it, `close(id)` clears it, a second `open` replaces it, TTL expiry (fake clock) clears it.
- KO: unknown mode → `hour` + one warning; `principal-hash` without salt → refuses, falls back, logged once; salt never appears in a record or log; `close(otherId)` when a different id is current → registry unchanged, returns `false`; `current()` after TTL → `null`.

### WI-04 TraceWriter, memory/file/null sinks
- OK: `enqueue` returns synchronously even with a never-resolving sink; 120 records → batches ≤ 100; NDJSON lines re-validate; `stats()` counts; `disabled` → no-op, no timers.
- KO: 501 at capacity 500 → oldest dropped, one warn/60 s; sync and async sink throws swallowed and counted; sink > 3 s → timeout, one retry, counted; empty `flush()` no-op; unwritable dir → `null` fallback after one warning; `beforeExit` flush once, ≤ 1 s.

### WI-05 Queue and HTTP sinks (fakes for `fetch`, `getToken`, `QueueClient`)
- OK: http POSTs `{records}` with bearer for `TRACE_INGEST_SCOPE`, one request per batch; queue splits at 64 KB, base64 body; 429 + `Retry-After: 1` → one retry after 1 s.
- KO: 401/403 → no retry, `dropped_invalid`, status-only warn; network error → one retry then drop; token failure → drop, never throws; record > 64 KB dropped alone; no record body ever logged (spy on `console.*`).

### WI-06 Argument policies and touched names (R0.3)
- OK (replay): for every data tool of all four services, calling the tool on the golden fixture with the arguments of a recorded call record — `args` fed straight back as `tool_input` — yields a `structuredContent` byte-identical to the original call (**the replay assertion**, the R0.2/R0.3 test). Exceptions asserted individually: `*_raw_sql` replays with `?` placeholders and is expected to fail with `invalid-input`; `taskrecorder_*` replays only when the recording with the recorded `sha256` is supplied; `sec_*` with a `<redacted>` user replays as `not-found`.
- OK (policies): `ARG_POLICIES` derived from the Zod input schemas covers every parameter of every tool (`serviceToolNames()` × `inputSchema` keys); `d365_search.queries[]` → `term`; `d365_raw_sql.sql` → `sql_shape` (`WHERE AccountNum = 'V-000123' AND RecId > 5637144576` → `WHERE AccountNum = ? AND RecId > ?`); `taskrecorder_to_markdown.recording` → `payload_ref` with `sha256`, `bytes`, `steps`, forms and menu items; `sec_lookup_user.user_id` → `redacted`; `investigation_id` is stripped, never recorded as an arg.
- OK (touched): `d365_get_entity_sources` → the entity + its source tables as names; `d365_lookup_table` → the table + its relation targets; `xref_find_references` → the referenced objects; `sec_lookup_role` → role/duty/privilege names; `d365_search` → hit names; ≤ 200, names only, no other key.
- OK (size): every call record on the golden fixture ≤ 4 KB; `result` has no key beyond `kind`, `bytes`, `rows`, `has_more`, `coverage` (static scan of `withTrace` and the hook for `structuredContent` access).
- KO: a parameter with no policy → dropped, `coverage` carries `args_partial`, the rest of the record intact; a `term` `"customer 1234567"` → dropped, `args_redacted`; a task-recording fixture whose typed values are e-mails, IBANs and 9-digit runs → none of them anywhere in the serialised record; an `args` object value under any policy but `payload_ref` → record rejected by `sanitize`; a tool response of 12 MB → record unchanged in size (no response bytes are read); policy resolution throwing → tool name + `result.kind` only, result untouched.

### WI-07 `withTrace` + central `investigation_id` injection/strip
- OK: `MCP_TRACE=on` + memory sink: `d365_lookup_table` result byte-identical to baseline; one `mcp` record with `tool.name`, `result.kind`, `mcp.service`, `functional_context`, `seq`. With `investigation_id: inv_abc` in args → the record carries it **and the handler receives args without it** (spy). Without the param on stdio with an open registry → stamped from the process default. `tools/list` shows `investigation_id` on every data tool and **not** on `trace_investigation`.
- OK: `emptyResult` → `empty`; `notFoundResult` → `not-found` with the requested identifier; `errorResult` → `error`, no entities; a loop-guard note (no `structuredContent`, no `_meta`) → **no record**.
- OK: 200 wrapped calls, p95 delta ≤ 5 ms × CI factor.
- KO: `MCP_TRACE=off` → handler identity unchanged, no injected param, `tools/list` byte-identical to the captured baseline; `enqueue` throwing → result unaffected, logged once; handler rejection propagates unchanged, nothing enqueued; `investigation_id: 'bad id!'` → dropped (grammar), handler still runs; a tool file containing `investigation_id` literally → static scan fails.

### WI-08 `trace_investigation` (Stream 2, four phases — the claude.ai path)
- OK (`step`): `step` with `intent` and `n` → `## Step recorded`, `{ n, queued: true }`; `n` auto-assigned as `last + 1` when omitted on stdio (registry counts), required on Azure; a `step` for an unknown id → accepted (Azure cannot know).
- OK: registered once per server, `title 'Investigation'`, `WRITE_TRACE_ANNOTATIONS` (`readOnlyHint:false, destructiveHint:false, idempotentHint:false, openWorldHint:true`), `outputSchema`, description ≤ 300 chars and naming the `request.key` reuse rule. `open` → `## Investigation opened`, `{ investigation_id, request_key, next: 'pass investigation_id on data tools; annotate; close; reuse request_key on another ERP' }`, registry default set on stdio; `annotate` → `{ entities_recorded, expectations_recorded, processes_recorded, lifecycles_recorded }`; `close` → `{ trace_id, outcome, expectations_recorded, differences_recorded }`, registry cleared. Every enqueued record validates; `erp`/`mcp` from the identity adapter; unknown `functional_entity` ids pass through (the semantic layer owns the vocabulary); the same `request.key` opened twice (two ERPs, two installations) → two investigations, no error, no dedup.
- KO: `open` with `conclusion` → invalid-input; `open` without `request` → `errorResult('invalid-input', 'request.key and request.interpreted are required — the key must be reusable on another ERP')`; `annotate`/`close` without `investigation.id` → invalid-input; e-mail in `summary` or in `request.interpreted` or in a `Process.steps[].action` → `errorResult('invalid-input', '<field> contains a value that looks like personal or party data — describe the structure, not the record')`, nothing enqueued; 51 entities / 101 expectations / 11 processes / 21 lifecycles → Zod **and** handler-level cap (rule #13); unknown `purpose`/`role`/`outcome`/`Process.source`/`differences[].aspect` → rejection; writer disabled → `errorResult('internal', 'Tracing is not enabled on this server')`; async sink failure → tool still answers `queued: true` (never claims persistence); `close` for an id another process minted → accepted, `note: 'open not seen by this server'` in the result.
- KO (boundary): every server's `tools/list` has exactly one `trace_*` tool; no tool name/description on traces contains read/query/list/delete semantics.

### WI-09 D365FO identity adapter
- OK: fixture `model_versions` → `erp.system 'd365fo'`, `version` = ApplicationSuite, `build` = ApplicationPlatform, `snapshot_date` = `build_date`, `mcp.version` = package version, `MCP_INSTALLATION_ID` honoured (default `local`); cached per db handle.
- KO: pre-provenance DB → nulls, never throws; no db (Task Recorder) → `snapshot_date` omitted (rule #14).

### WI-10 Registration policy, profile, budget, static scans
- OK: `effectiveProfile('taskrecorder', null, 'core') === 'full'`; `effectiveProfile('kb', db, 'core') === 'core'` with the trace tool present; budget prints per-server bytes **with** the tool and the injected param; new ceilings ≤ 2 % above measurement, commit message quotes the bytes; `deriveToolTitle('trace_investigation') === 'Investigation'`; `withFreshness` skips `readOnlyHint:false`; semantic tools unchanged.
- KO: a second `trace_*` tool → boundary scan fails; inline write annotations (not the constant) → PM-03 fails; over ceiling → fails; `MCP_TRACE=off` `tools/list` ≠ baseline → fails; injected param present on the trace tool → fails; per-server growth from the param > 5 % → fails with "inject on CORE_TOOLS only" (the §13.3 policy, encoded).

### WI-11 Ingest service (core + HTTP + queue; fake Cosmos)
- OK: `ingestBatch` upserts valid records with `month`, `_ingested_at`, `_ingest_version`, `source_app_id`; idempotent on duplicate id; mixed batch → valid stored, invalid dead-lettered, HTTP 207 with counts; route `api/trace/ingest` with principal `appid` ∈ `TRACE_ALLOWED_APP_IDS` → 200/207; `GET api/trace/health` anonymous (listed in Easy Auth `excludedPaths`); queue message → same core; undecodable message → dead-letter `undecodable`, no throw.
- KO: no principal, `REQUIRE_AUTH` unset → **503**; principal without/with non-allow-listed `appid` → 403; body > 1 MB → 413 before parsing; > 100 records → 400; version out of range → dead-letter `version`; schema-valid but denylist hit → dead-letter `privacy` with **only** the §6 keys; Cosmos throwing → 500 (HTTP) / rethrow (queue), nothing claimed accepted; contract copy hash drift → test fails "run npm run build:trace-ingest".

### WI-12 Infrastructure as code (not executed by Fable)
- OK: Bicep declares serverless capability, `disableLocalAuth: true`, `mcptrace`, `traces` with hierarchical PK `['/erp/system','/month']` and no `defaultTtl`, `deadletter` `defaultTtl: 2592000`, the §9 indexing, `sqlRoleAssignments` for the ingest MI, queue sender role for the main MI, app settings, €10 cost alert; `deployTrace` defaults `false`; `az bicep build` passes (run by the reviewer).
- KO: static test fails on `listKeys(`, `primaryMasterKey`, `AccountKey=`, a Cosmos connection string, `deployTrace = true`, or a `defaultTtl` on `traces`.

### WI-13 Local tooling
- OK: `Push-LocalTraces.ps1` batches NDJSON by 100, POSTs with `az account get-access-token --scope`, renames to `.sent` on 2xx/207; `ndjson.js` streams lazily.
- KO: corrupt line skipped and counted; 4xx leaves the file and prints dead-letter hashes; no token → non-zero exit with the `az login` hint.

### WI-14 Docs, plugin, CLAUDE.md
- OK: `test/plugin.test.js` green with regenerated refs; CLAUDE.md rule #17; `docs/Trace-Module.md` has the env table, the §6 rules and the §1.2 worked example; the skill paragraphs name all four phases and the hook path.
- KO: plugin refs with old tool counts → fails.

### WI-15 Conformance kit for the next ERP bridge
- OK: a fake M3 emitter producing `valid/m3-*.json` (all four phases + `mcp` call records, **including the M3 half of the comparison pair** under the shared `request.key`) passes `runConformance({ emit })`; the kit reports which invalid fixtures an emitter wrongly accepts, and a **replayability check**: every `mcp` record's `args` resolve to a policy and carry no dropped parameter (`args_partial` absent) — an emitter whose calls cannot be re-issued is reported "not replayable", not invalid.
- KO: an emitter leaking a `value` key, an `observations` key or a digit run in prose fails with the schema path; the kit has no I/O (scan: no `fs`/`fetch`).

### WI-16 Hook capture for Claude Code (the primary Stream-2 path, §3/§10)
- OK: on a fixture transcript of the vendor investigation (2026-09-04): `UserPromptSubmit` writes `current` with a fresh id; the first `PreToolUse` (`mcp__d365kb__d365_get_entity_sources`) emits `open` with `request.interpreted` = *"I'll load the D365FO MCP tooling skill first, then query the knowledge base for the vendor table and data entity structure."*, `request.key` `req.i_ll_load_the_d365fo_mcp_tooling_skill_first_then_query_the_kn…` (60 chars, grammar-valid), then `step 1` = *"Now querying the KB for the vendor data entity and its backing table."*, then the call record with `args { entity_name: 'VendVendorV2Entity', limit: 60, functional_context: 'vendor' }`, `source: hook`; a second `PreToolUse` with no new assistant text emits **only** a call record (no empty step); `PostToolUse` fills `result.kind`/`bytes` on the matching record; `Stop` emits `close` with the final message as `summary` (≈ 5 000 chars, passes the denylist) and clears `current`. Every emitted record validates against the contract; the hook exits 0 in ≤ 50 ms on a 2 MB transcript; a `Skill(...)` tool call is ignored (not an MCP call).
- OK (stdio stamping): a local stdio server reads `current` per call and stamps `investigation_id` on its own Stream-1 record; the analysis sees the same call twice (`source: server` and `source: hook`) with the same `investigation_id` — the conformance kit's dedupe key is `(investigation_id, tool.name, sha256(args), ts within 5 s)`.
- KO: the user prompt text never appears in any record (fixture prompt contains an e-mail and a 9-digit number; string scan of `hook.ndjson`); a missing or unreadable transcript → no record, exit 0, one stderr line; a `Stop` with no open investigation → nothing written; the hook never writes to stdout (Claude Code treats hook stdout as feedback); a denylist hit in an assistant line → that record dropped with a counted reason, the rest of the dossier intact; `PreToolUse` on a non-D365 MCP tool → no record.

---

## 12. Implementation order
WI-01 → 02 → 03 → 04 → 06 → 07 → 16 → 08 → 09 → 10 → 05 → 11 → 13 → 14 → 15 → 12 (Bicep last, reviewed, **run by the operator**). One commit per WI; `npm test` + `npm run typecheck` green at each; the budget re-baseline commit quotes measured bytes.

---

## 13. Risks and open decisions
1. **`principal-hash` session mode** is governance (pseudonymous per-day grouping). Default `hour`; enabling it for the French site needs the CSE/CNIL note the M3 project carries. Recommend: keep `hour` — with v1.1 the investigation id carries correlation, so the pressure to enable it is gone.
2. **Best-effort loss on scale-in** vs awaiting the queue send (+20–50 ms p50). Recommend accept; the counter makes it visible.
3. **`tools/list` growth**: +1 tool (≈ 4 KB/server) **and** the injected parameter (≈ 100 B × 65 tools ≈ 6.5 KB, ≈ +4 %). Policy: measure; if any server exceeds +5 %, inject on `CORE_TOOLS` only (WI-10 encodes the check).
4. **Parameter discipline on Azure**: the strong link needs Claude to pass `investigation_id`; the skill teaches it and `open` says so in its result. Locally the process default removes the need. If usage shows the param is skipped, the fallback is what v1.0 had.
5. **Cosmos serverless** limits (5 000 RU/s burst, 1 TB) are far above need; the autoscale trigger is documented, not built.
6. **Replay depends on the snapshot still existing.** A call replayed against a later snapshot may return a different structure; `mcp.snapshot_date` on every record makes that visible, but the weekly Azure rebuild means the exact snapshot of an old dossier is gone. Accept: structure drifts slowly and the drift is itself information; if it matters, the analysis project keeps the weekly snapshots it replays against (its decision, not this module's).
7. **Digit-run ≥ 7** also redacts long legitimate identifiers inside prose (identifier fields unaffected). With the conclusion now stored at up to 6 000 characters this rule will fire on RecIds quoted in prose (`RecId > 5637144576`) and drop the record; the hook should mask digit runs in prose (`5637144576` → `#`) rather than reject, so a conclusion is never lost to a RecId. Decide at the checkpoint: mask (recommended) or reject.
8. **`request.key` under hook capture** is derived from the interpretation line, not chosen by Claude, so two runs of the same request produce two keys unless the lines are identical. Mitigation: the analysis matches on `request.interpreted` similarity as well; the tool path lets Claude pass a key explicitly. If cross-ERP joining proves weak, add a `d365://requests` resource listing known keys (keys only, never traces).
9. **Hook reliance.** Claude Code hooks are per-user configuration shipped with the plugin; a user without the plugin traces nothing locally (the Azure server still records Stream 1 for connector calls). Accept; the plugin is the distribution unit already.
10. **Task Recorder in a trace** is process evidence from real user recordings — the channel a colleague's review called "the hardest part". `payload_ref` is deliberately conservative (fingerprint + names); if names alone prove too thin for process comparison, widening it is a privacy decision for the checkpoint, not a code tweak.
11. **Duplicate call records** (server + hook on stdio) are cheap and dedupable; they are kept because each path covers a client the other does not.

---

## 14. Checkpoint — confirm before implementation
- [x] **Scope and R0 (§1.0)** — decided 2026-09-04: traces of logical/physical structure and of the processes Claude analysed from user input; reproducible and comparable across ERPs; downstream exploitation is a separate project.
- [ ] `request` contract (§5.3): `key` reuse rule, `interpreted` = the interpretation line Claude writes before its first tool call (ERP-neutral, never the user's raw words), `approach` = the announced plan, `parameters`.
- [x] **Results are not traced, the path is (R0.2, decided 2026-09-04 second decision):** Stream 1 = call record (`tool`, replayable `args`, `result` kind/bytes/rows/has_more, `touched` names); no `observations`, no chunking (§5.2).
- [ ] `step` phase = Claude's strategy line verbatim; conclusion cap 6 000 (§5.3).
- [ ] **Hook capture as the primary Claude Code path** (§3, §10, WI-16): UserPromptSubmit / PreToolUse / PostToolUse / Stop, transcript-derived, user prompt never recorded; tool path stays for claude.ai.
- [ ] Argument policies incl. `sql_shape` (literal masking), `payload_ref` (Task Recorder fingerprint), `redacted` (person params) (§6, WI-06).
- [ ] Digit-run rule in long prose: mask or reject (§13.7).
- [ ] `process[]` / `lifecycle[]` / `counterpart` / `differences` on Stream 2 (§5.3) — observations, no confidence.
- [ ] Objectives and the DQ-report chain (§1): step 1 is this module; 3–6 are the semantic layer; 2 is the analysis project.
- [ ] Lifecycle (§5.3, §7): one tool, four phases, central parameter injection, stdio process default shared with the hook via `~/.claude/mcp-trace/current`, 8 h TTL.
- [ ] Placement (§4).
- [ ] Contract enums (§5.3): `purpose` incl. `comparison`, `asked_by_role`, `role` incl. `excluded`, `outcome`, `Expectation.kind`, `Process.source`, `differences[].aspect`.
- [ ] Privacy defaults (§6): policy-or-drop on args, `term` policy, responses never read beyond five keys, digit-run rule.
- [ ] Session key default `hour` (§13.1); best-effort semantics (§13.2); budget policy (§13.3).
- [ ] Cosmos design (§9) incl. the `request/key` and `investigation_id` composite indexes.
- [ ] Order (§12); `az` stays human-gated.
