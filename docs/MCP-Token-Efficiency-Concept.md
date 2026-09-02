# MCP Services — Token Efficiency and Best-Practice Improvement Concept

_Status: proposal · 2026-09-02 · measured on the local KB (1.28 GB), XRef (3.70 GB) and Sec (181 MB) snapshots; token figures are bytes ÷ 4 unless a source is named._

## 0. What this document is

An evidence-based assessment of the four MCP services (KB, XRef, Sec, Task Recorder — 58 tools, SDK `@modelcontextprotocol/sdk` 1.27.0) against two questions: **what does a call actually cost the consuming model, and where does the design depart from MCP best practice?** — followed by a concept that turns the findings into workstreams with expected savings, risk and order.

Every number here was measured this week or is cited from an earlier measured document (`Claude_Code_Token_Optimization.md`, `Export-D365Products_Run3_MCP_Cost_Measurement.md`, `KB-Response-Optimisation.md`). Nothing is estimated from first principles. Where a lever is unmeasured it is marked so.

## 1. Cost model (from the earlier runs — not re-derived)

- Cost ≈ turns × context × $0.50/MTok (cache read) + output × $25/MTok. **Context is a running meter**: every token a tool returns is paid again on every later turn. At 200k context a turn costs ~$0.10 before doing work.
- 1,000 tokens of tool output ≈ $0.025 over a 30-turn tail.
- **Run 4 finding (load-bearing for §4.2):** the claude.ai connector bills `structuredContent` and ignores `content[0].text`; payloads were byte-identical across `format:markdown` / `toon`. For the primary client the text channel is wire, not context.
- The tool list is re-sent to the model on **every** request; no `limit`, filter or format touches it.

## 2. Findings — fixed cost (`tools/list`)

### 2.1 The budget test measures three of six registrations

`test/tool-schema-budget.test.js:27-29` registers `registerKbTools` / `registerXrefTools` / `registerSecTools` only. The live KB server (`src/local/mcp-server-kb.js:43-45`, same in `src/functions/d365kb.js`) also registers `isv-kb-tools` (3) and `custom-fields-tools` (1); XRef adds `isv-xref-tools` (1); Task Recorder is a fourth service. The "114,932 B live" figure in CLAUDE.md equals the test's three-service sum exactly — it was never an independent live measurement.

| Server as actually registered | Tools | Wire B | ~tk | description | inputSchema | outputSchema |
|---|---:|---:|---:|---:|---:|---:|
| KB (kb + isv-kb + custom-fields) | 21 | 70,056 | 17,514 | 7,348 | 19,158 | 40,223 |
| XRef (xref + isv-xref) | 17 | 37,290 | 9,323 | 3,599 | 14,125 | 16,854 |
| Sec | 18 | 37,412 | 9,353 | 3,896 | 9,856 | 20,841 |
| Task Recorder | 2 | 13,355 | 3,339 | 2,510 | 2,993 | 7,522 |
| **Total** | **58** | **158,113** | **~39,500** | 17,353 (11%) | 46,132 (29%) | 85,440 (54%) |

**Real fixed cost is ~39.5k tk per request — 38% above the documented 28.7k.** A budget that measures the wrong thing is worse than none (the same lesson as PR #102, which found the first version counted a third of the cost). Fixing the test is the first action of this concept.

### 2.2 `outputSchema` is large because of structure, not text

Across the 51 KB/XRef/Sec output schemas (58,099 B):

| Component | B | Share |
|---|---:|---:|
| `"type": …` keys | 20,565 | 35% |
| `"required": […]` arrays | 11,063 | 19% |
| `anyOf: [{type}, {type: "null"}]` nullable wrappers — 296 `.nullable()` + 56 `.nullish()` | 7,774 | 13% |
| `"additionalProperties": false` | 4,425 | 8% |
| `"$schema": "https://json-schema.org/draft/2020-12/schema"` — one per tool | 2,958 | 5% |
| `description` strings | **1,052** | **1.8%** |

CLAUDE.md lists "shortening `.describe()` text inside `output-schemas.js`" as an untried lever. It is now measured: **~850 B (~210 tk) across three services. It is not a lever.** The prose that does cost is on the *input* side — 20,647 B of parameter descriptions (13% of the grand total), more than all tool descriptions combined.

What does shrink structure:

- **Zod 4 emits `anyOf` for nullable, not `type: ["string","null"]`.** Measured on one string field: `.nullable()` 203 B · `.nullish()` 186 B · `.optional()` 158 B. `optional` drops both the `anyOf` and the `required` entry (−45 B/field). 352 nullable/nullish fields → **up to ~15 KB** if the ones that are omitted at runtime become `.optional()`. This also aligns the schema with rule #14 (omit dead keys) — today the schema says `null` and the runtime omits, which is a contract lie.
- **Duplicated nested row shapes.** `d365_lookup_table` (53 properties, depth 11) and `d365_check_field_exists` (depth 17) inline the same row object into both the single and the batch branch. Reuse via `$defs`/`$ref` would remove the duplicate — *unverified*: it depends on whether the SDK's schema serialisation can be given Zod 4's `reused: "ref"` option or a pre-built JSON Schema (spike, §5 W1).
- **`$schema` URL per tool**: 2,958 B. Whether it reaches the wire depends on the SDK's serialiser — verify on the live `tools/list`, then strip if present.

### 2.3 Top schema and description offenders

| Tool | Wire B | outputSchema | Why |
|---|---:|---:|---|
| `taskrecorder_to_document` | 11,402 | 7,152 | depth 9, 57 props, 3.4 KB of output `.describe()` — the one place output prose matters |
| `d365_isv_lookup` | 10,760 | 7,394 | 60 props, per-element-type sub-objects |
| `d365_isv_extension_points` | 7,985 | 6,176 | depth 13 |
| `d365_lookup_table` | 5,817 | 4,157 | single + batch row duplication |
| `d365_custom_fields` | 4,380 | 2,166 | 851 B description |

12 tool descriptions exceed 400 chars: `taskrecorder_to_document` 1,755 · `d365_raw_sql` 1,229 · `sec_raw_sql` 1,089 · `d365_custom_fields` 851 · `taskrecorder_to_markdown` 755 · `d365_isv_lookup` 632 · `d365_get_method_source` 597 · `d365_get_class_methods` 570 · `sec_effective_permissions` 570 · `d365_get_entity_sources` 527 · `d365_list_modules` 426 · `sec_object_access` 411. `d365_raw_sql` (`kb-tools.js:1808`) still carries the "Returns both a typed JSON payload…" boilerplate that was removed from 43 other tools, plus a full schema listing that is catalogue data, not description.

### 2.4 The `core` profile works but is process-wide

`MCP_TOOL_PROFILE=core` (`tool-guards.js:172-183`) registers 23 tools for 65,052 B (−43% vs the three-service list). It is selected by process env only (`activeProfile()`, `:185`), so on Azure it applies to every client or none.

## 3. Findings — variable cost (responses)

### 3.1 Dual payload, measured per call

| Call (default args unless noted) | text B | JSON B | text/JSON | both ~tk |
|---|---:|---:|---:|---:|
| `d365_lookup_table CustTable` | 27,089 | 63,101 | 0.43 | **22,548** |
| … `fields_like '%Group%'` | 10,052 | 21,368 | 0.47 | 7,855 |
| `d365_search "payment"` (20) | 3,327 | 4,403 | 0.76 | 1,933 |
| `d365_get_class_methods SalesFormLetter` (100) | 12,569 | 18,151 | 0.69 | 7,680 |
| … `include_source` | 93,554 | 101,244 | 0.92 | **48,700** |
| `d365_get_entity_sources CustCustomerV3Entity` (500) | 19,961 | 39,761 | 0.50 | 14,931 |
| `d365_list_modules` (173 rows) | 14,367 | 37,072 | 0.39 | **12,860** |
| … `origin:'custom'` | 457 | 843 | 0.54 | 325 |
| `xref_find_references CustTable` (100) | 10,882 | 15,033 | 0.72 | 6,479 |
| `sec_stats` | 24,886 | 44,371 | 0.56 | **17,314** |
| `sec_lookup_role "Accounts payable clerk"` | 150,147 | **458,011** | 0.33 | **152,040** |

Three things are consistent across every row:

1. `structuredContent` is the **larger** channel every time. The dual send costs 1.3–1.6× the JSON alone on flat tables and ~2× on nested payloads.
2. Given Run 4, for the claude.ai connector the text channel is 30–45% of every payload spent on a channel the client discards. Whether that holds for Claude Code / other clients is not measured — it must be, before §4.2 is built.
3. The adaptive `format:'auto'` choice is correct (never larger than the pinned loser) — but it optimises the channel that is not billed.

### 3.2 Unbounded arrays — the outliers

- **`sec_lookup_role`: 458 KB / ~152k tk for one role.** `direct_entity_permissions[2434]` is 420 KB of it (`sec-tools.js:144-145`, no LIMIT, no parameter), each row carrying six mostly-null grant columns. One call is 75% of a 200k context. `KB-Response-Optimisation.md` §7 already lists summary-by-default for `sec_lookup_role` / `sec_role_hierarchy` / `sec_compare_roles` as open.
- **`sec_stats`: 44 KB.** `model_versions[180]` = 37 KB (`sec-tools.js:1520`) inside a *stats* call.
- **`d365_lookup_table`: 63 KB default.** `fields` is uncapped; only `incoming_relations` has a hard cap of 20 (`kb-tools.js:211`). `fields_like` and `custom_only` cut it to 21–29 KB, and are already the documented practice.
- **`d365_list_modules`: 37 KB default**, 214 B/row × 173 (10 keys incl. counts, version, publisher). `origin:'custom'` → 843 B (−98%).
- **27 of 58 tools have no `limit` at all.** Most are single-object lookups where that is right; the ones with confirmed unbounded arrays are `sec_lookup_role`, `sec_stats`, `d365_lookup_table`.

### 3.3 Truncation is signalled, never resumable

No tool accepts `offset`, `cursor` or `page`; none returns `has_more` / `next_offset`. `truncated: boolean` appears in ~30 schemas and `total_count` only on `xref_find_extensions` (`xref-tools.js:1220`). `truncationNote` tells the agent "pass a higher `limit`" — which re-pays the head of the list to reach the tail. MCP best practice is `limit` + cursor + `has_more`.

### 3.4 Open items from earlier runs, still open

- Per-field provenance (`source_module`, `is_extension`) on all 284 fields of an entity costs +3,714 tk; emitting it only on extension rows would save ~27% (Run 3 §7.5 #4).
- `include_counts:false` **nulls** keys instead of omitting them → +5.6%, a net loss (Run 3 §7.3).

## 4. Findings — protocol and best practice

| Area | State | Evidence |
|---|---|---|
| Transport | Stateless JSON (`enableJsonResponse: true`, no `sessionIdGenerator`), new `McpServer` per request. Correct for Azure Functions. Transport does **not** affect the tools/list cost — that is the model prompt, not the wire. | `d365kb.js:49-53`, `d365xref.js:48`, `d365sec.js:52` |
| Annotations | Complete, frozen (`READ_ONLY_DB_ANNOTATIONS`, `READ_ONLY_LIVE_ANNOTATIONS`) | `shared.js:440-459` |
| Error model | `notFoundResult`/`errorResult` carry no `structuredContent` (SDK-validation rationale); hints are actionable ("Did you mean", "Provide `enum_name` or `enum_names`") | `shared.js:589-619`, `kb-tools.js:627` |
| **Resources / prompts** | **None registered.** Zero `registerResource`/`registerPrompt` in `src/`. Stable, snapshot-scoped catalogues are paid per call instead of once. | grep |
| `title` / `_meta` on tools | Unused; supported by SDK 1.27 | `mcp.d.ts:150-157` |
| Server `instructions` | 339/255/252/224 chars — compact; KB's repeats the format rule already on `formatTextParam` | `server-metadata.js:83-125` |
| `format` contract | **All three `*_raw_sql` tools bypass `formatTextParam`** with `z.enum(['markdown','toon']).default('toon')` — pins TOON, defeats the adaptive default, violates rule #5 | `kb-tools.js:1811`, `xref-tools.js:825`, `sec-tools.js:1592` |
| Freshness | `freshnessBanner(db, service)` does not exist (issue #86); `server-metadata.js:82` still claims "every response states its snapshot date". KB/XRef expose `build_date` only via raw SQL. | issue #86 |
| Naming | Prefixes `d365_`/`xref_`/`sec_` consistent; verbs mixed (`lookup`/`get`/`find`/`check`) — acceptable, not worth a rename | — |
| Evals | One `evals.json` with 3 prompts for the tooling skill; no per-tool correctness or token-budget evals | `skills/…/evals.json` |
| Type safety | Plain JS, 45/62 files JSDoc-annotated, nothing checks them → issue #103 (checkJs, not a TS migration) | #103 |

## 5. Improvement concept

Seven workstreams. **Tuning** = no contract change, byte-identical for callers that don't opt in. **Architecture** = a change in what a caller receives by default or how it pages.

### W0 — Measure the right thing first (tuning, S)

1. Extend `test/tool-schema-budget.test.js` to register **every** tool set each server actually registers (KB: kb + isv-kb + custom-fields; XRef: xref + isv-xref; add Task Recorder) and print the four-server total. Re-baseline the ceilings at 70,056 / 37,290 / 37,412 / 13,355 B.
2. Add a **response-size golden test**: the ten calls in §3.1 against the fixture DB, asserting `JSON.stringify(structuredContent).length` and `content[0].text.length` within ±10% of a recorded baseline. This is the regression gate every later workstream reports against.
3. Verify two wire facts on the **live** `tools/list`: is `$schema` present per tool; does the serialiser inline or `$ref` repeated shapes.
4. Correct CLAUDE.md: the 114,932 B / 28,733 tk figure and the "shorten `.describe()`" lever.

**Why first:** every saving below is quoted against a baseline that is currently wrong by 38%.

### W1 — Tool-list diet (tuning, M) — target −20–25% of 158 KB before any profile

| Lever | Expected | Certainty |
|---|---:|---|
| `.nullable()` → `.optional()` where the runtime omits the key (aligns schema with rule #14) | up to −15 KB | measured per field (−45 B), count 352 |
| `$defs`/`$ref` for the duplicated single/batch row shapes (`d365_lookup_table`, `d365_check_field_exists`, `d365_get_enum`, `xref_object_summary`) | −3–5 KB | **spike** — depends on SDK serialiser options |
| Strip `$schema` per tool if on the wire | −3 KB | verify (W0.3) |
| Cut the 12 descriptions > 400 chars to ≤ 300; move `d365_raw_sql`/`sec_raw_sql` schema listings to a resource (W4) or to `d365_sql_template`; delete the leftover boilerplate on `d365_raw_sql` | −4–5 KB | measured lengths |
| Trim input-parameter `.describe()` prose (20.6 KB) — shared params already done; do the per-tool ones | −5–8 KB | measured total; per-param unmeasured |
| **Do not** trim output `.describe()` text (KB/XRef/Sec) | −0.2 KB | measured — dead end |

Task Recorder's 3.4 KB of output prose is the one exception where describe-trimming pays.

### W2 — Per-client tool profile (tuning, S)

Make `MCP_TOOL_PROFILE` selectable per request, not per process: an HTTP header (`X-MCP-Tool-Profile: core`) or query parameter on the Streamable HTTP endpoints, with the env var as the default. The stateless transport already builds a fresh `McpServer` per request, so this is a one-line lookup in `installToolGuards`. The claude.ai connector URL can then carry `?profile=core` while Claude Code keeps the full list. Measured saving: −43% of the three-service list; the `CORE_TOOLS` list is hand-picked — tune it from the W0 golden test's real call frequencies.

> **Shipped 2026-09-02 (#106).** `src/azure/request-context.js` resolves `profile` per request (query `?profile=` > header `X-MCP-Tool-Profile` > env `MCP_TOOL_PROFILE` > `full`; unknown → fall through) into an `AsyncLocalStorage` store; the four HTTP entry points wrap server construction + `handleRequest` in `runWithRequestContext`, stdio servers resolve once from env. The filter moved from `installToolGuards` to `registerServiceTools` (tool-sets.js) so it reaches every set. Measured off the transport: 58 → 23 tools, 155,789 → 77,539 B (**−50.2%**); KB −54.7%, XRef −60.1%, Sec −50.1%. A profile that would empty a server (Task Recorder has no `CORE_TOOLS` member) falls back to `full` — the SDK answers `tools/list` with `-32601` on an empty server.

### W3 — Bounded and summarised responses (tuning, M)

Ordered by measured payload:

1. **`sec_lookup_role`** — summary by default: counts + first N of `duties`, `direct_privileges`, `direct_entity_permissions` (N=50), `include_entity_permissions` opt-in for the full list, `truncationNote('cap')`. From 458 KB to an expected < 20 KB. Same treatment for `sec_role_hierarchy`, `sec_compare_roles` (open since `KB-Response-Optimisation.md` §7).
2. **`sec_stats`** — replace `model_versions[180]` with `model_count` + `origin` breakdown; `include_model_versions` opt-in. −37 KB.
3. **`d365_lookup_table`** — `field_limit` (default 200, `truncationNote('cap')`) so a 300-field table cannot silently ship 60 KB; keep `fields_like`/`custom_only` as the documented sharp tools.
4. **Provenance only on extension rows** in `d365_get_entity_sources` / `d365_lookup_table` — every row of a response carries the same keys (rule #14), the *set* of keys is chosen per response: `custom_only` → emit; otherwise omit; `include_provenance` → everywhere. Measured −27% on a 284-field entity.
5. **`include_counts:false` omits keys** instead of nulling them (Run 3 §7.3, +5.6% today).
6. Audit the remaining 24 no-`limit` tools: single-object lookups stay; anything returning an array gets a cap.

### W4 — Text channel policy (architecture, M) — the open decision in rule #5

Today: every response ships TOON/Markdown **and** JSON; measured 1.3–2× the JSON alone; the primary client bills the JSON only.

Options:

| | A. Server-wide switch | B. Client-negotiated | C. Status quo |
|---|---|---|---|
| Mechanism | `MCP_TEXT_CHANNEL=summary` → text = H2 + one summary line + "see structuredContent" | Read `clientInfo.name` from `initialize`; connector clients get summary, others full | — |
| Saving for connector | −30–45% per payload (measured share) | same | 0 |
| Risk | Clients without structured-output support lose the readable channel | Needs the client-name → policy table maintained; must be verified per client | none |
| Reversible | env var | env var + table | — |

**Recommendation: B, gated on a measurement.** Before building it, run the Run-4 method against Claude Code (stdio) and the claude.ai connector once more to confirm which channel each bills. If both bill JSON only, A is sufficient and simpler. `structuredContent` stays the typed payload regardless; `structuredResult` remains the single choke point.

> **Mechanism shipped 2026-09-02 (#108), default unchanged.** `structuredResult` reads `getRequestContext().textChannel`: `full` is byte-identical to before; `summary` emits the H2 line + `_Payload in structuredContent (N keys, M bytes)._` (≤ 300 B). Both A and B are available without further code: A = `MCP_TEXT_CHANNEL=summary` (or `?text=summary` / `X-MCP-Text-Channel` per request); B = `CLIENT_TEXT_CHANNEL_POLICY` in request-context.js (stdio `clientInfo.name` → channel), shipped **empty**. What remains is the decision path's step 1 — the per-client billing measurement — recorded on #108 before either switch is thrown.

### W5 — Pagination and resources (architecture, L)

1. **Cursor pagination** on the list-shaped tools — `xref_find_references`, `xref_find_usages`, `d365_search`, `d365_get_class_methods`, `d365_get_entity_sources`, `sec_search`, `sec_find_roles_by_*`: add `cursor` (opaque base64 offset — stateless-compatible), return `has_more` + `next_cursor` + `total_count`. Keep `limit` semantics unchanged so existing callers are byte-identical until they pass `cursor`. Replaces "raise the limit and re-pay the head".
2. **Resources for stable, snapshot-scoped catalogues** — candidates: module list (`d365_list_modules` 37 KB), SQL templates, hallucination traps, the raw_sql schema listing, snapshot metadata (`build_date`, `schema_version`, `model_count`) — the natural home for the freshness signal of #86. **Unmeasured, and gated on a spike:** confirm the claude.ai connector and Claude Code actually surface MCP resources before moving anything out of tool responses. If they do not, the same content becomes a `d365_snapshot_info` tool with a tiny schema.
3. `title` on every tool (human display name; a few bytes each) and a `snapshot` resource make the server self-describing without paying for it per call.

### W6 — Contract hygiene and quality gates (tuning, S–M)

- Fix the three `*_raw_sql` tools to use `formatTextParam` and pass `format` straight through (rule #5).
- Implement `freshnessBanner(db, service)` or the `snapshot_date` typed key — issue #86 — and correct `server-metadata.js:82`.
- **checkJs + JSDoc** — issue #103: `shared.js` and `output-schemas.js` first, so every tool's `typed` object is checked against its declared `outputSchema` via `z.infer`. This is the cheapest way to make the typed-first rule a compile-time fact instead of a test-time one.
- Eval suite: 10 read-only, verifiable questions per service (mcp-builder format) + the W0 golden sizes, run in CI. Measures discipline, not tool choice.

### W7 — Functional-entity traces: record what "Sales" is, technically (architecture, L) — issue #111

**The gap.** When a user works with Claude on a functional topic — *Sales* — Claude reaches for `SalesTable`, `SalesLine`, `SalesFormLetter`, `CustInvoiceJour`, the `SalesStatus` enum, the `Sales clerk` role. The conclusion the two of them reach — *these objects are what Sales is, technically, in this installation* — is real knowledge, and today it evaporates when the conversation ends. The next conversation re-derives it, paying the same tokens, and reaches a slightly different answer.

**The idea.** Record that association as a trace, ERP-neutral. The physical structure differs per system — D365FO companies, M3, AX2012, AX2009, Sage — but the functional entities (Customer, Sales Order, Item, Invoice, Payment, Ledger Journal) describe every ERP the same way, and the need for KB/XRef/Sec-style MCP services is identical across them. If each ERP's MCP services emit the **same trace shape**, the traces become the join key between systems:

```
sales_order @ D365FO  = { SalesTable (header), SalesLine (line), SalesFormLetter (posting), CustInvoiceJour (invoice) }
sales_order @ M3      = { OOHEAD (header), OOLINE (line), … }
```

That is the M3 → D365 migration mapping problem (Clermont-Ferrand) made incremental, reusable and grounded in what people actually concluded rather than in a one-off spreadsheet.

**Design in one screen** (full design in #111):

| Element | Decision |
|---|---|
| Vocabulary | Small, versioned, ERP-neutral entity list (≤ 60: Customer, Vendor, Item, Sales Order, Purchase Order, Sales/Vendor Invoice, Payment, Ledger Journal, Inventory Transaction, BOM, Production Order, Project, Fixed Asset, Employee…) grouped by process (Order-to-Cash, Procure-to-Pay, Record-to-Report, Plan-to-Produce). Mappings reference vocabulary **ids**, never free text — that is what makes two ERPs comparable by construction. |
| Store | `d365fo_semantic.sqlite`, **physically separate** from the KB/XRef/Sec snapshots (those stay read-only and are rebuilt weekly; traces must survive rebuilds). `sem_vocabulary`, `sem_mappings(erp_system, erp_version, installation_id, snapshot_date, entity_id, object_type, object_name, model, role, confidence, source, session_hash, created_at)`, `sem_entity_relations`. `role` ∈ header/line/master/setup/transaction/reference/posting/ui; `source` ∈ user_confirmed/assistant_inferred/context_hint/seed. |
| Capture, explicit | `d365_map_entity(entity_id, objects[{type,name,role}], confirmed_by_user)` — **the platform's first and only write tool**; `readOnlyHint:false`, `destructiveHint:false`, `idempotentHint:true` (upsert). `confirmed_by_user:true` only after the user agreed in conversation. |
| Capture, implicit | Optional `functional_context` (vocabulary id) on the top read tools — Claude passes the entity it is working on; the server records `source:'context_hint'` at low confidence. ~40 B per tool on the input schema, counted by W0's budget. |
| Read | `d365_entity_map(entity_id \| object_name)` — forward ("what is Sales here") and reverse ("SalesTable → sales_order, role header, confirmed 3×"). `notFoundResult` suggestions gain "objects mapped to <entity>". |
| Export | `sem_export` — one ERP-neutral JSON per installation. **The cross-ERP matcher lives outside the MCP services**; the services only produce comparable traces. |
| Governance | Conflicts are legitimate (one object, two entities, two roles) and kept. `confidence` = f(source, confirmations, recency). Vocabulary changes are PRs owned by the architecture role. |
| Privacy | Metadata only: entity ids, object names, model names, roles, salted `session_hash`. **No business records, no party names, no user identity, no conversation text.** Enforced in the DDL (the only free-text column is `note`, capped and privacy-scanned). |

**Why it belongs in this concept.** It is a token lever too: a confirmed map turns the recurring "what belongs to Sales" discovery (several `d365_search` + `xref_object_summary` + `d365_lookup_table` calls, 5–20k tk) into one `d365_entity_map` call, and it gives #85 (`d365_effective_schema`) a functional entry point. But its main value is strategic: the same KB/XRef/Sec service pattern, pointed at another ERP, produces traces that line up with these.

**Where it does not go.** Not into the KB snapshot (rebuilt, read-only). Not as inference over raw call logs (needs the question text — privacy). Not as a matcher inside the services.

#### W7b — Data-quality rule traces: the MCP knows the rules, something else runs them

**The gap.** Knowing that `SalesTable`/`SalesLine` *are* Sales is half the map. The other half is knowing what *correct* looks like for that data — and today that knowledge is spread across EDT definitions, relations, unique indexes, enum lists, DMF entity mandatory-field lists and the heads of the people who cleanse. A migration (M3 → D365) or a cleansing programme rediscovers it every time.

**The idea.** Attach **declarative data-quality rules** to the same functional entities and technical objects the W7 traces already carry. The MCP stores and serves the rules; **it never executes them**. A build-time generator turns the rules into row-level indicator SQL for the target platform (T-SQL for AxDB/BYOD, M3's dialect for the snapshot marts), and those scripts run where the data lives — matching the Clermont-Ferrand decisions exactly (*Claude is the builder*; *telemetry prioritises, profiling diagnoses*; row data never enters the AI channel).

**Dimensions** (each rule declares exactly one):

| Dimension | Row-level question | Typical spec | Seedable from the KB? |
|---|---|---|---|
| `format` | Does the value match the expected shape? | `{type:"pattern", regex}` · `{type:"length", max}` · `{type:"edt", edt:"CustAccount"}` | **Yes** — EDT string length, extended type |
| `completeness` | Is a required value missing/blank/placeholder? | `{type:"not_null"}` · `{type:"not_in", values:["", "N/A", "."]}` | **Yes** — mandatory fields, DMF entity mandatory list |
| `domain` | Is the value in the allowed set / range? | `{type:"enum", enum:"SalesStatus"}` · `{type:"range", min, max}` | **Yes** — enums, EDT ranges |
| `uniqueness` / `redundancy` | Is this row a duplicate on the business key? | `{type:"unique", fields:[…]}` | **Yes** — unique indexes, alternate keys |
| `closeness` | Is this row a *near*-duplicate (spelling variants, transposed digits)? | `{type:"similarity", fields:["Name","Street"], algorithm:"jaro_winkler", threshold:0.92, blocking:["PostalCode"]}` | No — user/analyst rule; the dialect adapter supplies the function or degrades to `SOUNDEX`/`DIFFERENCE` with a note |
| `referential_integrity` | Does the foreign key resolve? (orphans, missing relations) | `{type:"fk", to:"CustTable.AccountNum", nullable:false}` | **Yes** — `relations` + `d365_get_join_keys` |
| `consistency` | Do fields agree with each other? | `{type:"cross_field", expr:"InvoiceDate >= OrderDate"}` — small neutral expression grammar, per-dialect override allowed | Partly — from posting rules and `d365_hallucination_check` traps |
| `timeliness` | Is the row stale for its state? | `{type:"age", field:"ModifiedDateTime", max_days:365, when:"Status='Open'"}` | No — business rule |
| `target_readiness` | Would this row pass the *target* entity's staging validation? | `{type:"target", entity:"CustCustomerV3Entity", checks:["mandatory","enum_map","uom_map","key_unique"]}` | **Yes** — DMF entity schema (`d365_get_entity_sources`) — this is `dq_target_readiness` from the M3 concept, expressed as rules |

**Store** — same `d365fo_semantic.sqlite`, three more tables:

- `sem_dq_rules(rule_id, entity_id, erp_system, object_name, field_name, dimension, spec JSON, severity, source, confidence, version, session_hash, created_at)` — `source` ∈ kb_derived | user_confirmed | assistant_inferred | seed. `spec` is declarative and dialect-free; the only per-dialect content lives in the generator's adapters.
- `sem_dq_rule_links(rule_id, entity_id, role)` — the same rule id reused across systems is what makes DQ scores comparable per functional entity (`sales_order` completeness on D365FO vs on M3).
- `sem_dq_dialect_overrides(rule_id, dialect, sql_fragment)` — escape hatch for `closeness`/`consistency` rules that cannot be expressed neutrally; kept out of `spec` so the neutral rule stays portable.

**Capture** — the same two paths as W7: `d365_map_dq_rule(entity_id | object_name, field_name?, dimension, spec, severity, confirmed_by_user)` (write, upsert on (installation, object, field, dimension, spec-hash)); and a **KB-derived seed pass** (`build/seed-dq-rules.js`) that emits `format`/`completeness`/`domain`/`uniqueness`/`referential_integrity`/`target_readiness` rules straight from `fields`, `relations`, `enums`, `indexes` and the DMF entity metadata with `source:'kb_derived'` — hundreds of correct rules on day one, no conversation needed. User-concluded rules refine, override or disable seeded ones (`enabled:false` is a rule version, never a delete).

**Serve** — `d365_dq_rules(entity_id | object_name, dimension?, min_severity?, format)` returns the applicable rule set; `sem_export` includes it. That response is the **input to generation**, not a result.

**Generate — outside the MCP.** `build/gen-dq-sql.js <dialect> <export.json>` renders one `SELECT` per rule with a fixed output contract: `dq_indicator(row_key, object_name, rule_id, dimension, severity, detail)`. Every generated script has the same shape regardless of ERP, so one DQ dashboard/readiness report reads all of them. `closeness` rules render to the dialect's similarity function or degrade with a `-- degraded:` comment; `target_readiness` renders as the staging-validation simulation. Generated scripts are versioned artefacts, re-run on every snapshot **with no AI in the loop**.

**What comes back into the MCP: nothing row-level.** Optionally, *aggregates only* (`rule_id, run_date, rows_checked, rows_flagged`) may be re-ingested as `sem_dq_runs` to weight `confidence` and to feed the relevance heat map — never a `row_key`, never a value.

**Why this belongs here.** It closes the loop the M3 concept opened: the W7 entity map says *which* objects matter, the rule traces say *what correct means* for them, the generated indicators say *how far the data is from it* — per functional entity, per system, comparable. The KB seed pass means the D365FO side starts near-complete; the M3 side gets its rules through the same tool from the same vocabulary, and `target_readiness` is literally the D365 rule set applied to M3 rows before they ever reach DMF.

**Where it does not go.** No rule execution in any MCP service. No row data, no sample values in `spec` or `note`. No "the MCP found N duplicates" — the MCP knows the rule; the script found them.

## 6. Roadmap

| Phase | Workstreams | Effort | Expected effect |
|---|---|---|---|
| 1 — Baseline | W0, W6 raw_sql fix | S | Correct numbers; regression gate; rule #5 restored |
| 2 — Quick wins | W3.1–W3.3, W1 (nullable→optional, descriptions, `$schema`), W2 | M | `sec_lookup_role` −95%; tools/list −20–25% + optional −43% profile; `sec_stats` −37 KB |
| 3 — Payload shape | W3.4–W3.6, W4 (after the client measurement) | M | −27% on provenance-bearing responses; −30–45% per payload for JSON-only clients |
| 4 — Protocol | W5 pagination, W5 resources (after the resource spike), W6 #86, #103 ratchet, evals | L | Resumable lists; stable catalogues paid once; self-describing snapshot |
| ∥ — Semantic layer | W7 vocabulary v1 → store → `d365_map_entity`/`d365_entity_map` → `functional_context` → `sem_export` | L | Functional↔technical map accumulates from real sessions; ERP-neutral traces for M3/AX matching |

Phases 1–2 are pure tuning and can ship behind the existing tests within a sprint. Phase 3 changes a default and needs the client measurement first. Phase 4 changes the contract and is filed as ADRs. W7 is independent of the token work and can start alongside phase 2; its vocabulary v1 is the only prerequisite.

## 7. What not to do

- **Do not shorten output-schema `.describe()` text** for KB/XRef/Sec — 1.8% of the schema bytes, measured. Delete that lever from CLAUDE.md.
- **Do not drop `outputSchema` wholesale.** It is the typed contract validating clients rely on and it is what makes `structuredContent` trustworthy; shrink its *structure* (W1).
- **Do not change transport** to chase the tools/list cost. The list is a prompt cost, not a wire cost; stateless JSON is already the right choice for Azure Functions.
- **Do not migrate to TypeScript** — #103 records why checkJs delivers the error-catching part on the current files with no build step.
- **Do not batch `d365_lookup_table`** (CLAUDE.md batching rule) — bound it (W3.3) instead.
- **Do not store conversation text or infer W7 traces from raw call logs** — metadata only; the explicit tool and the vocabulary-id hint are the two capture paths.

## 8. Decisions needed

1. **W4 — text channel:** approve running the client measurement, and pick A or B on its result.
2. **W3.1 — `sec_lookup_role` default:** confirm summary-by-default (N=50) is acceptable to the Sec-tool consumers before the default changes.
3. **W5 — resources:** approve the connector/Claude-Code resource-support spike before any catalogue moves.
4. **W7 — semantic layer:** approve the first write path in the platform (`d365_map_entity`) and name the owner of the ERP-neutral vocabulary.

## 9. Related

- Workstream issues (filed 2026-09-02): W0 #104 · W1 #105 · W2 #106 · W3 #107 · W4 #108 (ADR) · W5 #109 (ADR) · W6 #110 · W7 #111 (ADR) · umbrella #112.
- Folded under them: #83 (batch params, remaining tools → W3), #84 (Labels v2 — separate track), #85 (`d365_effective_schema` → W3, functional entry point via W7), #86 (freshness — base banner missing → W6/W5), #103 (checkJs → W6).
- Prior measurements: `docs/KB-Response-Optimisation.md`, `docs/Claude-Code-Efficiency-Guide.md`, `C:\working\Divers\Support_Issues\Claude_Code_Token_Optimization.md`, `…\Export-D365Products_Run3_MCP_Cost_Measurement.md`.
- Enforcement today: `test/tool-schema-budget.test.js`, `test/response-format.test.js`, `test/batch-tools.test.js`, `src/azure/tool-guards.js`.
